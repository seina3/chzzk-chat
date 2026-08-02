import Database from "@tauri-apps/plugin-sql";
import type { ChatMessage } from "./chzzk/types";

let db: Database | null = null;
// 메시지 저장 순서를 보장하기 위한 직렬화 체인
let writeChain: Promise<unknown> = Promise.resolve();

export interface StoredMessage {
  id: number;
  channel_id: string;
  user_id_hash: string;
  nickname: string;
  content: string;
  emojis: string | null;
  msg_type: string;
  pay_amount: number | null;
  msg_time: number;
  blind: string | null;
}

/** 한 유저가 썼던 닉네임과 사용 기간 */
export interface NicknameUse {
  nickname: string;
  cnt: number;
  first_seen: number;
  last_seen: number;
}

export interface UserStats {
  count: number;
  firstSeen: number | null;
  lastSeen: number | null;
  nicknames: NicknameUse[];
  /** 이 유저의 후원 총액과 횟수 */
  donationTotal: number;
  donationCount: number;
}

/** dbPath를 주면 그 파일을, 없으면 앱 기본 위치의 chzzk.db를 연다 */
export async function initDb(dbPath?: string): Promise<void> {
  db = await Database.load(dbPath ? `sqlite:${dbPath}` : "sqlite:chzzk.db");
  await db.execute(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL,
      user_id_hash TEXT NOT NULL,
      nickname TEXT NOT NULL,
      content TEXT NOT NULL,
      emojis TEXT,
      msg_type TEXT NOT NULL DEFAULT 'chat',
      pay_amount INTEGER,
      msg_time INTEGER NOT NULL
    )
  `);
  // 채널 이름을 따로 보관한다 — 목록에서 채널을 지워도 지난 기록에
  // 채널 ID 대신 이름이 계속 보이도록
  await db.execute(`
    CREATE TABLE IF NOT EXISTS channels (
      channel_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      image_url TEXT,
      updated_at INTEGER NOT NULL
    )
  `);
  await db.execute(
    `CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id_hash, msg_time DESC)`,
  );
  await db.execute(
    `CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, msg_time DESC)`,
  );
  await db.execute(
    `CREATE INDEX IF NOT EXISTS idx_messages_donation
     ON messages(msg_type, msg_time DESC)`,
  );
  // 기존 DB에 blind 컬럼 추가 (이미 있으면 오류가 나므로 무시)
  await db
    .execute(`ALTER TABLE messages ADD COLUMN blind TEXT`)
    .catch(() => undefined);

  // 중복 판정 기준에서 content를 뺀다.
  // 같은 메시지가 나중에 가려진 내용으로 다시 내려와도 별도 행으로 쌓이지 않고,
  // 먼저 저장된 원문이 그대로 유지된다.
  await db
    .execute(
      `DELETE FROM messages WHERE rowid NOT IN (
         SELECT MIN(rowid) FROM messages
         GROUP BY channel_id, user_id_hash, msg_time
       )`,
    )
    .catch(() => undefined);
  await db
    .execute(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_key
       ON messages(channel_id, user_id_hash, msg_time)`,
    )
    .catch(() => undefined);
  await db.execute(`DROP INDEX IF EXISTS idx_messages_dedup`).catch(() => undefined);
}

function requireDb(): Database {
  if (!db) throw new Error("DB가 초기화되지 않았습니다.");
  return db;
}

/**
 * 모든 수신 메시지를 저장. 중복 수신은 UNIQUE 인덱스로 무시되므로
 * 처음 받은 원문이 그대로 남는다 (나중에 가려진 버전이 와도 덮어쓰지 않음).
 */
export function saveMessage(m: ChatMessage): void {
  writeChain = writeChain
    .then(async () => {
      const db = requireDb();
      await db.execute(
        `INSERT OR IGNORE INTO messages
         (channel_id, user_id_hash, nickname, content, emojis, msg_type, pay_amount, msg_time, blind)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          m.channelId,
          m.userIdHash,
          m.nickname,
          m.content,
          Object.keys(m.emojis).length > 0 ? JSON.stringify(m.emojis) : null,
          m.type,
          m.payAmount,
          m.time,
          m.blind ?? null,
        ],
      );
      // 이미 저장된 메시지가 가려진 상태로 다시 온 경우: 내용은 그대로 두고
      // 가려짐 표시만 갱신한다
      if (m.blind) {
        await db.execute(
          `UPDATE messages SET blind = $1
           WHERE channel_id = $2 AND user_id_hash = $3 AND msg_time = $4
             AND blind IS NULL`,
          [m.blind, m.channelId, m.userIdHash, m.time],
        );
      }
    })
    .catch((e) => console.error("메시지 저장 실패:", e));
}

/** 채널의 최근 메시지 (오래된 것부터). 화면 전환 시 대화 복원용 */
export async function getRecentMessages(
  channelId: string,
  limit = 200,
): Promise<StoredMessage[]> {
  const rows = await requireDb().select<StoredMessage[]>(
    `SELECT * FROM messages WHERE channel_id = $1
     ORDER BY msg_time DESC LIMIT $2`,
    [channelId, limit],
  );
  return rows.reverse();
}

export async function getUserMessages(
  userIdHash: string,
  opts: {
    before?: number;
    search?: string;
    limit?: number;
    /** 후원 메시지만 조회 */
    donationsOnly?: boolean;
  } = {},
): Promise<StoredMessage[]> {
  const limit = opts.limit ?? 100;
  const params: unknown[] = [userIdHash];
  let where = "user_id_hash = $1";
  if (opts.donationsOnly) {
    where += " AND msg_type = 'donation'";
  }
  if (opts.before !== undefined) {
    params.push(opts.before);
    where += ` AND msg_time < $${params.length}`;
  }
  if (opts.search) {
    params.push(`%${opts.search}%`);
    where += ` AND content LIKE $${params.length}`;
  }
  params.push(limit);
  return requireDb().select<StoredMessage[]>(
    `SELECT * FROM messages WHERE ${where} ORDER BY msg_time DESC LIMIT $${params.length}`,
    params,
  );
}

export interface UserSearchRow {
  user_id_hash: string;
  nickname: string;
  cnt: number;
  last_seen: number;
}

/** 닉네임(과거 닉네임 포함) 또는 유저 ID 해시로 유저 검색. 최근 활동순 */
export async function searchUsers(
  query: string,
  limit = 100,
): Promise<UserSearchRow[]> {
  return requireDb().select<UserSearchRow[]>(
    `SELECT m.user_id_hash,
            (SELECT nickname FROM messages
             WHERE user_id_hash = m.user_id_hash
             ORDER BY msg_time DESC LIMIT 1) AS nickname,
            COUNT(*) AS cnt,
            MAX(m.msg_time) AS last_seen
     FROM messages m
     WHERE m.user_id_hash IN
           (SELECT user_id_hash FROM messages
            WHERE nickname LIKE $1 OR user_id_hash LIKE $1)
       AND m.user_id_hash != 'anonymous'
     GROUP BY m.user_id_hash
     ORDER BY last_seen DESC
     LIMIT $2`,
    [`%${query}%`, limit],
  );
}

/** 전체 저장 메시지에서 내용으로 검색. 최신순 페이지네이션 */
export async function searchMessages(
  query: string,
  opts: { before?: number; limit?: number } = {},
): Promise<StoredMessage[]> {
  const limit = opts.limit ?? 100;
  const params: unknown[] = [`%${query}%`];
  let where = "content LIKE $1";
  if (opts.before !== undefined) {
    params.push(opts.before);
    where += ` AND msg_time < $${params.length}`;
  }
  params.push(limit);
  return requireDb().select<StoredMessage[]>(
    `SELECT * FROM messages WHERE ${where}
     ORDER BY msg_time DESC LIMIT $${params.length}`,
    params,
  );
}

// ---------- 후원 집계 ----------

export interface DonationFilter {
  /** 이 시각(ms) 이후만 집계. 0이면 전체 기간 */
  since: number;
  /** 특정 채널만 집계. 없으면 전체 채널 */
  channelId?: string;
}

export interface DonationSummary {
  total: number;
  count: number;
  donors: number;
}

export interface DonationByUser {
  user_id_hash: string;
  nickname: string;
  total: number;
  cnt: number;
  last_time: number;
}

/** 후원 조회 공통 WHERE 절 (파라미터 배열을 함께 채운다) */
function donationWhere(f: DonationFilter, params: unknown[]): string {
  let where = "msg_type = 'donation'";
  if (f.since > 0) {
    params.push(f.since);
    where += ` AND msg_time >= $${params.length}`;
  }
  if (f.channelId) {
    params.push(f.channelId);
    where += ` AND channel_id = $${params.length}`;
  }
  return where;
}

export async function getDonationSummary(
  f: DonationFilter,
): Promise<DonationSummary> {
  const params: unknown[] = [];
  const where = donationWhere(f, params);
  const rows = await requireDb().select<
    { total: number | null; cnt: number; donors: number }[]
  >(
    `SELECT COALESCE(SUM(pay_amount), 0) AS total,
            COUNT(*) AS cnt,
            COUNT(DISTINCT user_id_hash) AS donors
     FROM messages WHERE ${where}`,
    params,
  );
  const r = rows[0];
  return {
    total: r?.total ?? 0,
    count: r?.cnt ?? 0,
    donors: r?.donors ?? 0,
  };
}

/** 유저별 후원 합계. 금액 많은 순 */
export async function getDonationsByUser(
  f: DonationFilter,
  limit = 200,
): Promise<DonationByUser[]> {
  const params: unknown[] = [];
  const where = donationWhere(f, params);
  params.push(limit);
  return requireDb().select<DonationByUser[]>(
    `SELECT user_id_hash,
            (SELECT nickname FROM messages m2
             WHERE m2.user_id_hash = m.user_id_hash
             ORDER BY m2.msg_time DESC LIMIT 1) AS nickname,
            COALESCE(SUM(pay_amount), 0) AS total,
            COUNT(*) AS cnt,
            MAX(msg_time) AS last_time
     FROM messages m WHERE ${where}
     GROUP BY user_id_hash
     ORDER BY total DESC
     LIMIT $${params.length}`,
    params,
  );
}

export interface DonationByChannel {
  channel_id: string;
  total: number;
  cnt: number;
  donors: number;
  last_time: number;
}

/** 채널별 후원 합계. 금액 많은 순 */
export async function getDonationsByChannel(
  f: DonationFilter,
  limit = 100,
): Promise<DonationByChannel[]> {
  const params: unknown[] = [];
  const where = donationWhere(f, params);
  params.push(limit);
  return requireDb().select<DonationByChannel[]>(
    `SELECT channel_id,
            COALESCE(SUM(pay_amount), 0) AS total,
            COUNT(*) AS cnt,
            COUNT(DISTINCT user_id_hash) AS donors,
            MAX(msg_time) AS last_time
     FROM messages WHERE ${where}
     GROUP BY channel_id
     ORDER BY total DESC
     LIMIT $${params.length}`,
    params,
  );
}

/** 후원 상세 내역. 최신순 페이지네이션 */
export async function getDonationList(
  f: DonationFilter,
  opts: { before?: number; limit?: number } = {},
): Promise<StoredMessage[]> {
  const limit = opts.limit ?? 100;
  const params: unknown[] = [];
  let where = donationWhere(f, params);
  if (opts.before !== undefined) {
    params.push(opts.before);
    where += ` AND msg_time < $${params.length}`;
  }
  params.push(limit);
  return requireDb().select<StoredMessage[]>(
    `SELECT * FROM messages WHERE ${where}
     ORDER BY msg_time DESC LIMIT $${params.length}`,
    params,
  );
}

// ---------- 채널 이름 보관 ----------

/** 채널 이름을 기억해 둔다 (목록에서 지운 뒤에도 기록에 이름이 보이도록) */
export function rememberChannel(
  channelId: string,
  name: string,
  imageUrl?: string | null,
): void {
  if (!name) return;
  writeChain = writeChain
    .then(() =>
      requireDb().execute(
        `INSERT INTO channels (channel_id, name, image_url, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT(channel_id) DO UPDATE SET
           name = excluded.name,
           image_url = COALESCE(excluded.image_url, channels.image_url),
           updated_at = excluded.updated_at`,
        [channelId, name, imageUrl ?? null, Date.now()],
      ),
    )
    .catch((e) => console.error("채널 이름 저장 실패:", e));
}

export async function getKnownChannelNames(): Promise<Map<string, string>> {
  const rows = await requireDb().select<
    { channel_id: string; name: string }[]
  >(`SELECT channel_id, name FROM channels`);
  return new Map(rows.map((r) => [r.channel_id, r.name]));
}

// ---------- 채팅 순위 ----------

export interface ChatterRank {
  user_id_hash: string;
  nickname: string;
  cnt: number;
  last_time: number;
}

/** 유저별 채팅 수 순위. 기간·채널로 거를 수 있다 */
export async function getChattersByCount(
  f: DonationFilter,
  limit = 200,
): Promise<ChatterRank[]> {
  const params: unknown[] = [];
  let where = "user_id_hash != 'anonymous'";
  if (f.since > 0) {
    params.push(f.since);
    where += ` AND msg_time >= $${params.length}`;
  }
  if (f.channelId) {
    params.push(f.channelId);
    where += ` AND channel_id = $${params.length}`;
  }
  params.push(limit);
  return requireDb().select<ChatterRank[]>(
    `SELECT user_id_hash,
            (SELECT nickname FROM messages m2
             WHERE m2.user_id_hash = m.user_id_hash
             ORDER BY m2.msg_time DESC LIMIT 1) AS nickname,
            COUNT(*) AS cnt,
            MAX(msg_time) AS last_time
     FROM messages m WHERE ${where}
     GROUP BY user_id_hash
     ORDER BY cnt DESC
     LIMIT $${params.length}`,
    params,
  );
}

export interface ChatSummary {
  total: number;
  chatters: number;
}

export async function getChatSummary(f: DonationFilter): Promise<ChatSummary> {
  const params: unknown[] = [];
  let where = "1=1";
  if (f.since > 0) {
    params.push(f.since);
    where += ` AND msg_time >= $${params.length}`;
  }
  if (f.channelId) {
    params.push(f.channelId);
    where += ` AND channel_id = $${params.length}`;
  }
  const rows = await requireDb().select<{ total: number; chatters: number }[]>(
    `SELECT COUNT(*) AS total,
            COUNT(DISTINCT user_id_hash) AS chatters
     FROM messages WHERE ${where}`,
    params,
  );
  return { total: rows[0]?.total ?? 0, chatters: rows[0]?.chatters ?? 0 };
}

/** 기록이 남아 있는 모든 채널 ID (목록에서 지운 채널도 포함) */
export async function getChannelsWithData(): Promise<string[]> {
  const rows = await requireDb().select<{ channel_id: string }[]>(
    `SELECT channel_id, MAX(msg_time) AS last_time
     FROM messages GROUP BY channel_id ORDER BY last_time DESC`,
  );
  return rows.map((r) => r.channel_id);
}

/** 한 유저(또는 익명)의 채널별 분포 */
export interface UserChannelBreakdown {
  channel_id: string;
  cnt: number;
  total: number;
}

export async function getUserChannelBreakdown(
  userIdHash: string,
  donationsOnly: boolean,
): Promise<UserChannelBreakdown[]> {
  const where = donationsOnly
    ? "user_id_hash = $1 AND msg_type = 'donation'"
    : "user_id_hash = $1";
  return requireDb().select<UserChannelBreakdown[]>(
    `SELECT channel_id,
            COUNT(*) AS cnt,
            COALESCE(SUM(pay_amount), 0) AS total
     FROM messages WHERE ${where}
     GROUP BY channel_id
     ORDER BY ${donationsOnly ? "total" : "cnt"} DESC`,
    [userIdHash],
  );
}

// ---------- 추이 (그래프용) ----------

export interface TimeBucket {
  bucket: number;
  cnt: number;
  total: number;
}

/**
 * 기간을 일정 간격으로 나눠 채팅 수와 후원 금액을 집계한다.
 * bucketMs 단위로 묶으며, donationsOnly면 후원만 센다.
 */
export async function getTimeSeries(
  f: DonationFilter,
  bucketMs: number,
  donationsOnly: boolean,
): Promise<TimeBucket[]> {
  const params: unknown[] = [bucketMs];
  let where = donationsOnly ? "msg_type = 'donation'" : "1=1";
  if (f.since > 0) {
    params.push(f.since);
    where += ` AND msg_time >= $${params.length}`;
  }
  if (f.channelId) {
    params.push(f.channelId);
    where += ` AND channel_id = $${params.length}`;
  }
  // 나눗셈 결과가 실수가 되면 JS 쪽 버킷 번호와 어긋나므로 정수로 맞춘다
  return requireDb().select<TimeBucket[]>(
    `SELECT CAST(msg_time / $1 AS INTEGER) AS bucket,
            COUNT(*) AS cnt,
            COALESCE(SUM(pay_amount), 0) AS total
     FROM messages WHERE ${where}
     GROUP BY bucket ORDER BY bucket`,
    params,
  );
}

/**
 * 이미 저장된 메시지를 가려진 것으로 표시한다.
 * (수신 후에 운영자가 삭제·블라인드한 경우 — 기록에도 남겨 취소선으로 보이게)
 */
export function markMessageBlinded(
  channelId: string,
  userIdHash: string,
  msgTime: number,
  blind = "moderator",
): void {
  writeChain = writeChain
    .then(() =>
      requireDb().execute(
        `UPDATE messages SET blind = $1
         WHERE channel_id = $2 AND user_id_hash = $3 AND msg_time = $4`,
        [blind, channelId, userIdHash, msgTime],
      ),
    )
    .catch((e) => console.error("블라인드 표시 실패:", e));
}

export async function getUserStats(userIdHash: string): Promise<UserStats> {
  const d = requireDb();
  const rows = await d.select<
    {
      cnt: number;
      first_seen: number | null;
      last_seen: number | null;
      donation_total: number | null;
      donation_count: number;
    }[]
  >(
    `SELECT COUNT(*) AS cnt,
            MIN(msg_time) AS first_seen,
            MAX(msg_time) AS last_seen,
            COALESCE(SUM(CASE WHEN msg_type = 'donation' THEN pay_amount END), 0)
              AS donation_total,
            SUM(CASE WHEN msg_type = 'donation' THEN 1 ELSE 0 END) AS donation_count
     FROM messages WHERE user_id_hash = $1`,
    [userIdHash],
  );
  const nickRows = await d.select<NicknameUse[]>(
    `SELECT nickname,
            COUNT(*) AS cnt,
            MIN(msg_time) AS first_seen,
            MAX(msg_time) AS last_seen
     FROM messages WHERE user_id_hash = $1
     GROUP BY nickname ORDER BY last_seen DESC LIMIT 50`,
    [userIdHash],
  );
  const r = rows[0];
  return {
    count: r?.cnt ?? 0,
    firstSeen: r?.first_seen ?? null,
    lastSeen: r?.last_seen ?? null,
    nicknames: nickRows,
    donationTotal: r?.donation_total ?? 0,
    donationCount: r?.donation_count ?? 0,
  };
}
