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
  /** 1이면 채널이 금액을 숨겨 액수를 알 수 없는 후원 */
  amount_hidden: number | null;
  /** 치지직 권한 코드 (streamer / …manager / common_user) */
  role_code: string | null;
  /** 구독 뱃지 이미지와 개월 수 — 다시 불러와도 뱃지가 남도록 */
  sub_badge: string | null;
  sub_month: number | null;
  /** 제재 안내일 때 어떤 처분인지 (삭제 / 임시 제한 / 영구 제한) */
  mod_action: string | null;
  /** 제재 안내의 대상 닉네임 */
  target_nick: string | null;
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
  /** 그중 금액이 숨겨져 액수를 알 수 없는 후원 횟수 */
  donationHidden: number;
  /** 클린봇·운영자에게 가려진 메시지 수 */
  blindedCount: number;
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
  // 내가 붙여 둔 표시 — 메모와 강조 색
  await db.execute(`
    CREATE TABLE IF NOT EXISTS user_marks (
      user_id_hash TEXT PRIMARY KEY,
      nickname TEXT,
      note TEXT,
      highlight TEXT,
      updated_at INTEGER NOT NULL
    )
  `);
  // 차단 — channel_id가 빈 문자열이면 모든 채널에서 숨긴다
  await db.execute(`
    CREATE TABLE IF NOT EXISTS user_blocks (
      user_id_hash TEXT NOT NULL,
      channel_id TEXT NOT NULL DEFAULT '',
      nickname TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id_hash, channel_id)
    )
  `);
  // 채널별 통나무 파워 — 값이 바뀔 때마다 한 줄씩 남겨 늘어난 흐름을 본다
  await db.execute(`
    CREATE TABLE IF NOT EXISTS log_power (
      channel_id TEXT NOT NULL,
      value INTEGER NOT NULL,
      checked_at INTEGER NOT NULL,
      PRIMARY KEY (channel_id, checked_at)
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
  // 금액 숨김 후원 표시 (기존 DB에는 없으므로 마찬가지로 무시)
  await db
    .execute(`ALTER TABLE messages ADD COLUMN amount_hidden INTEGER`)
    .catch(() => undefined);
  // 스트리머·매니저 채팅을 나중에 다시 열어도 강조할 수 있도록 권한을 남긴다
  await db
    .execute(`ALTER TABLE messages ADD COLUMN role_code TEXT`)
    .catch(() => undefined);
  // 구독 뱃지도 남겨 두어야 다시 불러왔을 때 사라지지 않는다
  for (const col of [
    "sub_badge TEXT",
    "sub_month INTEGER",
    "mod_action TEXT",
    "target_nick TEXT",
  ]) {
    await db
      .execute(`ALTER TABLE messages ADD COLUMN ${col}`)
      .catch(() => undefined);
  }

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
 * 유저의 표시 이름을 고르는 서브쿼리 (바깥 쿼리가 messages를 m으로 별칭해야 한다).
 * 닉네임이 비어 있는 안내 메시지 행은 건너뛰고 가장 최근에 실제로 쓰인 이름을 쓴다 —
 * 익명의 후원자처럼 이름이 사라져 보이던 문제를 막는다.
 */
const LATEST_NICKNAME = `(SELECT nickname FROM messages m2
             WHERE m2.user_id_hash = m.user_id_hash AND m2.nickname != ''
             ORDER BY m2.msg_time DESC LIMIT 1)`;

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
         (channel_id, user_id_hash, nickname, content, emojis, msg_type, pay_amount, msg_time,
          blind, amount_hidden, role_code, sub_badge, sub_month, mod_action, target_nick)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
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
          m.amountHidden ? 1 : null,
          m.roleCode || null,
          m.subscriptionBadgeUrl,
          m.subscriptionMonth,
          m.modAction ?? null,
          m.targetNickname ?? null,
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
    /** 이 채널에서 보낸 것만 조회 */
    channelId?: string;
  } = {},
): Promise<StoredMessage[]> {
  const limit = opts.limit ?? 100;
  const params: unknown[] = [userIdHash];
  let where = "user_id_hash = $1";
  if (opts.donationsOnly) {
    where += " AND msg_type = 'donation'";
  }
  if (opts.channelId) {
    params.push(opts.channelId);
    where += ` AND channel_id = $${params.length}`;
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
            ${LATEST_NICKNAME} AS nickname,
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
  /** 채널이 금액을 숨겨 액수를 알 수 없는 후원 건수 */
  hidden: number;
}

export interface DonationByUser {
  user_id_hash: string;
  nickname: string;
  total: number;
  cnt: number;
  hidden_cnt: number;
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
    { total: number | null; cnt: number; donors: number; hidden: number }[]
  >(
    `SELECT COALESCE(SUM(pay_amount), 0) AS total,
            COUNT(*) AS cnt,
            COUNT(DISTINCT user_id_hash) AS donors,
            SUM(CASE WHEN amount_hidden = 1 THEN 1 ELSE 0 END) AS hidden
     FROM messages WHERE ${where}`,
    params,
  );
  const r = rows[0];
  return {
    total: r?.total ?? 0,
    count: r?.cnt ?? 0,
    donors: r?.donors ?? 0,
    hidden: r?.hidden ?? 0,
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
            ${LATEST_NICKNAME} AS nickname,
            COALESCE(SUM(pay_amount), 0) AS total,
            COUNT(*) AS cnt,
            SUM(CASE WHEN amount_hidden = 1 THEN 1 ELSE 0 END) AS hidden_cnt,
            MAX(msg_time) AS last_time
     FROM messages m WHERE ${where}
     GROUP BY user_id_hash
     ORDER BY total DESC, cnt DESC
     LIMIT $${params.length}`,
    params,
  );
}

export interface DonationByChannel {
  channel_id: string;
  total: number;
  cnt: number;
  donors: number;
  hidden_cnt: number;
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
            SUM(CASE WHEN amount_hidden = 1 THEN 1 ELSE 0 END) AS hidden_cnt,
            MAX(msg_time) AS last_time
     FROM messages WHERE ${where}
     GROUP BY channel_id
     ORDER BY total DESC, cnt DESC
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
            ${LATEST_NICKNAME} AS nickname,
            COUNT(*) AS cnt,
            MAX(msg_time) AS last_time
     FROM messages m WHERE ${where}
     GROUP BY user_id_hash
     ORDER BY cnt DESC
     LIMIT $${params.length}`,
    params,
  );
}

export interface ChannelChatRank {
  channel_id: string;
  cnt: number;
  chatters: number;
  last_time: number;
}

/** 채널별 채팅 수 순위 (기간으로 거를 수 있다) */
export async function getChatsByChannel(
  f: DonationFilter,
  limit = 100,
): Promise<ChannelChatRank[]> {
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
  params.push(limit);
  return requireDb().select<ChannelChatRank[]>(
    `SELECT channel_id,
            COUNT(*) AS cnt,
            COUNT(DISTINCT user_id_hash) AS chatters,
            MAX(msg_time) AS last_time
     FROM messages WHERE ${where}
     GROUP BY channel_id
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

// ---------- 구독 · 구독권 선물 ----------

/**
 * 구독 알림 중 "선물"로 볼 것.
 *
 * 치지직이 보내 주는 안내 문구를 그대로 저장해 두었다가 여기서 가른다.
 * 선물 여부만 따로 오는 값이 없어 문구로 판단할 수밖에 없다.
 */
const GIFT_MATCH = `content LIKE '%선물%'`;

function subWhere(f: DonationFilter, params: unknown[]): string {
  let where = "msg_type = 'subscription'";
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

export interface SubSummary {
  /** 구독 알림 전체 건수 */
  count: number;
  /** 그중 선물로 보이는 건수 */
  gifts: number;
  /** 알림에 이름이 오른 사람 수 */
  users: number;
}

export async function getSubSummary(f: DonationFilter): Promise<SubSummary> {
  const params: unknown[] = [];
  const where = subWhere(f, params);
  const rows = await requireDb().select<
    { cnt: number; gifts: number; users: number }[]
  >(
    `SELECT COUNT(*) AS cnt,
            SUM(CASE WHEN ${GIFT_MATCH} THEN 1 ELSE 0 END) AS gifts,
            COUNT(DISTINCT user_id_hash) AS users
     FROM messages WHERE ${where}`,
    params,
  );
  const r = rows[0];
  return { count: r?.cnt ?? 0, gifts: r?.gifts ?? 0, users: r?.users ?? 0 };
}

export interface SubByUser {
  user_id_hash: string;
  nickname: string;
  cnt: number;
  gift_cnt: number;
  last_time: number;
}

/** 유저별 구독·선물 건수. 선물이 많은 순 */
export async function getSubsByUser(
  f: DonationFilter,
  limit = 200,
): Promise<SubByUser[]> {
  const params: unknown[] = [];
  const where = subWhere(f, params);
  params.push(limit);
  return requireDb().select<SubByUser[]>(
    `SELECT user_id_hash,
            ${LATEST_NICKNAME} AS nickname,
            COUNT(*) AS cnt,
            SUM(CASE WHEN ${GIFT_MATCH} THEN 1 ELSE 0 END) AS gift_cnt,
            MAX(msg_time) AS last_time
     FROM messages m WHERE ${where}
     GROUP BY user_id_hash
     ORDER BY gift_cnt DESC, cnt DESC
     LIMIT $${params.length}`,
    params,
  );
}

export interface SubByChannel {
  channel_id: string;
  cnt: number;
  gift_cnt: number;
  users: number;
  last_time: number;
}

/** 채널별 구독·선물 건수 */
export async function getSubsByChannel(
  f: DonationFilter,
  limit = 100,
): Promise<SubByChannel[]> {
  const params: unknown[] = [];
  const where = subWhere(f, params);
  params.push(limit);
  return requireDb().select<SubByChannel[]>(
    `SELECT channel_id,
            COUNT(*) AS cnt,
            SUM(CASE WHEN ${GIFT_MATCH} THEN 1 ELSE 0 END) AS gift_cnt,
            COUNT(DISTINCT user_id_hash) AS users,
            MAX(msg_time) AS last_time
     FROM messages WHERE ${where}
     GROUP BY channel_id
     ORDER BY cnt DESC
     LIMIT $${params.length}`,
    params,
  );
}

/** 기록이 남아 있는 모든 채널 ID (목록에서 지운 채널도 포함) */
export async function getChannelsWithData(): Promise<string[]> {
  const rows = await requireDb().select<{ channel_id: string }[]>(
    `SELECT channel_id, MAX(msg_time) AS last_time
     FROM messages GROUP BY channel_id ORDER BY last_time DESC`,
  );
  return rows.map((r) => r.channel_id);
}

// ---------- 유저 표시 (메모 · 강조 · 차단) ----------

export interface UserMark {
  user_id_hash: string;
  nickname: string | null;
  note: string | null;
  highlight: string | null;
  updated_at: number;
}

export interface UserBlock {
  user_id_hash: string;
  /** 빈 문자열이면 모든 채널에서 차단 */
  channel_id: string;
  nickname: string | null;
  created_at: number;
}

export async function getUserMarks(): Promise<UserMark[]> {
  return requireDb().select<UserMark[]>(
    `SELECT * FROM user_marks
     WHERE (note IS NOT NULL AND note != '') OR (highlight IS NOT NULL AND highlight != '')
     ORDER BY updated_at DESC`,
  );
}

/** 메모나 강조 색을 저장한다. 둘 다 비면 행을 지운다 */
export async function saveUserMark(
  userIdHash: string,
  nickname: string,
  note: string,
  highlight: string,
): Promise<void> {
  const d = requireDb();
  if (!note && !highlight) {
    await d.execute(`DELETE FROM user_marks WHERE user_id_hash = $1`, [
      userIdHash,
    ]);
    return;
  }
  await d.execute(
    `INSERT INTO user_marks (user_id_hash, nickname, note, highlight, updated_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT(user_id_hash) DO UPDATE SET
       nickname = excluded.nickname,
       note = excluded.note,
       highlight = excluded.highlight,
       updated_at = excluded.updated_at`,
    [userIdHash, nickname || null, note || null, highlight || null, Date.now()],
  );
}

export async function getUserBlocks(): Promise<UserBlock[]> {
  return requireDb().select<UserBlock[]>(
    `SELECT * FROM user_blocks ORDER BY created_at DESC`,
  );
}

export async function addUserBlock(
  userIdHash: string,
  channelId: string,
  nickname: string,
): Promise<void> {
  await requireDb().execute(
    `INSERT OR REPLACE INTO user_blocks (user_id_hash, channel_id, nickname, created_at)
     VALUES ($1, $2, $3, $4)`,
    [userIdHash, channelId, nickname || null, Date.now()],
  );
}

export async function removeUserBlock(
  userIdHash: string,
  channelId: string,
): Promise<void> {
  await requireDb().execute(
    `DELETE FROM user_blocks WHERE user_id_hash = $1 AND channel_id = $2`,
    [userIdHash, channelId],
  );
}

// ---------- 통나무 파워 ----------

export interface LogPowerPoint {
  value: number;
  checked_at: number;
}

/** 가장 최근에 확인한 값 */
export async function getLatestLogPower(
  channelId: string,
): Promise<LogPowerPoint | null> {
  const rows = await requireDb().select<LogPowerPoint[]>(
    `SELECT value, checked_at FROM log_power
     WHERE channel_id = $1 ORDER BY checked_at DESC LIMIT 1`,
    [channelId],
  );
  return rows[0] ?? null;
}

/** 값이 달라졌을 때만 한 줄 남긴다 */
export async function recordLogPower(
  channelId: string,
  value: number,
): Promise<number | null> {
  const last = await getLatestLogPower(channelId);
  if (last && last.value === value) return null;
  await requireDb().execute(
    `INSERT OR REPLACE INTO log_power (channel_id, value, checked_at)
     VALUES ($1, $2, $3)`,
    [channelId, value, Date.now()],
  );
  return last ? value - last.value : null;
}

/** 늘어난 흐름 (오래된 것부터) */
export async function getLogPowerHistory(
  channelId: string,
  limit = 500,
): Promise<LogPowerPoint[]> {
  const rows = await requireDb().select<LogPowerPoint[]>(
    `SELECT value, checked_at FROM log_power
     WHERE channel_id = $1 ORDER BY checked_at DESC LIMIT $2`,
    [channelId, limit],
  );
  return rows.reverse();
}

// ---------- 제재 기록 (통나무 채팅 로그) ----------

/**
 * 한 유저가 받은 제재 기록.
 *
 * 두 가지를 모은다:
 *  - 그 유저가 쓴 메시지 중 운영자에게 가려진 것 (원문이 남아 있어 사유를 안다)
 *  - "OOO님을 임시 제한 처리했습니다" 같은 안내 중 대상이 그 유저인 것
 *
 * 클린봇 자동 가림은 운영자 제재가 아니므로 넣지 않는다. 익명(anonymous)은
 * 여러 사람이 섞여 있어 제재 기록을 물을 수 없으므로 아무것도 돌려주지 않는다.
 */
export async function getUserModLog(
  userIdHash: string,
  nickname: string,
  channelId?: string,
  limit = 100,
): Promise<StoredMessage[]> {
  if (userIdHash === "anonymous") return [];
  const params: unknown[] = [userIdHash];
  let where = "(user_id_hash = $1 AND blind IN ('moderator', 'hidden'))";
  if (nickname) {
    params.push(nickname);
    where = `(${where} OR target_nick = $${params.length})`;
  }
  if (channelId) {
    params.push(channelId);
    where += ` AND channel_id = $${params.length}`;
  }
  params.push(limit);
  return requireDb().select<StoredMessage[]>(
    `SELECT * FROM messages WHERE ${where}
     ORDER BY msg_time DESC LIMIT $${params.length}`,
    params,
  );
}

// ---------- 스트리머 채팅 모아보기 ----------

/** 스트리머가 직접 친 채팅만 모아 본다. 최신순 페이지네이션 */
export async function getStreamerMessages(
  opts: { channelId?: string; search?: string; before?: number; limit?: number } = {},
): Promise<StoredMessage[]> {
  const limit = opts.limit ?? 100;
  const params: unknown[] = [];
  let where = "role_code = 'streamer'";
  if (opts.channelId) {
    params.push(opts.channelId);
    where += ` AND channel_id = $${params.length}`;
  }
  if (opts.search) {
    params.push(`%${opts.search}%`);
    where += ` AND content LIKE $${params.length}`;
  }
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

/** 채널별 마지막 채팅 시각 — 방송 기록이 없을 때의 "최신순" 대용 */
export async function getChannelLastActivity(): Promise<Map<string, number>> {
  const rows = await requireDb().select<
    { channel_id: string; last_time: number }[]
  >(`SELECT channel_id, MAX(msg_time) AS last_time FROM messages GROUP BY channel_id`);
  return new Map(rows.map((r) => [r.channel_id, r.last_time]));
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

/** 그래프·집계에서 볼 종류 */
export type SeriesKind = "donation" | "subscription" | "all";

/**
 * 기간을 일정 간격으로 나눠 건수와 후원 금액을 집계한다.
 * bucketMs 단위로 묶으며, kind가 all이면 채팅 전체를 센다.
 */
export async function getTimeSeries(
  f: DonationFilter,
  bucketMs: number,
  kind: SeriesKind,
): Promise<TimeBucket[]> {
  const params: unknown[] = [bucketMs];
  let where = kind === "all" ? "1=1" : `msg_type = '${kind}'`;
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

/** channelId를 주면 그 채널에서의 기록만 집계한다 */
export async function getUserStats(
  userIdHash: string,
  channelId?: string,
): Promise<UserStats> {
  const d = requireDb();
  const params: unknown[] = [userIdHash];
  let where = "user_id_hash = $1";
  if (channelId) {
    params.push(channelId);
    where += ` AND channel_id = $${params.length}`;
  }
  const rows = await d.select<
    {
      cnt: number;
      first_seen: number | null;
      last_seen: number | null;
      donation_total: number | null;
      donation_count: number;
      donation_hidden: number;
      blinded: number;
    }[]
  >(
    `SELECT COUNT(*) AS cnt,
            MIN(msg_time) AS first_seen,
            MAX(msg_time) AS last_seen,
            COALESCE(SUM(CASE WHEN msg_type = 'donation' THEN pay_amount END), 0)
              AS donation_total,
            SUM(CASE WHEN msg_type = 'donation' THEN 1 ELSE 0 END) AS donation_count,
            SUM(CASE WHEN amount_hidden = 1 THEN 1 ELSE 0 END) AS donation_hidden,
            SUM(CASE WHEN blind IN ('moderator', 'hidden') THEN 1 ELSE 0 END) AS blinded
     FROM messages WHERE ${where}`,
    params,
  );
  const nickRows = await d.select<NicknameUse[]>(
    `SELECT nickname,
            COUNT(*) AS cnt,
            MIN(msg_time) AS first_seen,
            MAX(msg_time) AS last_seen
     FROM messages WHERE ${where} AND nickname != ''
     GROUP BY nickname ORDER BY last_seen DESC LIMIT 50`,
    params,
  );
  const r = rows[0];
  return {
    count: r?.cnt ?? 0,
    firstSeen: r?.first_seen ?? null,
    lastSeen: r?.last_seen ?? null,
    nicknames: nickRows,
    donationTotal: r?.donation_total ?? 0,
    donationCount: r?.donation_count ?? 0,
    donationHidden: r?.donation_hidden ?? 0,
    blindedCount: r?.blinded ?? 0,
  };
}
