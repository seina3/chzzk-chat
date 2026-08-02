import { invoke } from "@tauri-apps/api/core";
import { channelName } from "./channel-names";
import type { ChatMessage, LiveInfo } from "./chzzk/types";
import { getSettings, type LogFormat } from "./settings";

/**
 * 채팅 파일 로그.
 *
 * 방송 한 회차가 파일 하나가 된다. 방송이 시작되면 그 시각으로 이름 붙인 파일을
 * 새로 만들고 맨 앞에 방송 정보(시작 시각·제목·카테고리)를 적는다.
 * 방송 중 제목이나 카테고리가 바뀌면 바뀐 시각과 함께 이어서 남기고,
 * 방송이 꺼졌다 켜지면 다음 회차는 새 파일에 쌓인다.
 *
 * 형식은 txt(읽기 좋음)와 csv(통계·공유용) 중에 고를 수 있다.
 */

/** 지금 기록 중인 방송 회차 */
interface Session {
  /** 회차 구분 키 — 방송 시작 시각 문자열 */
  key: string;
  /** 파일 이름 (확장자 포함) */
  file: string;
  /** 파일을 새로 만들 때 한 번 쓸 머리말 */
  header: string;
  title: string;
  category: string;
}

const sessions = new Map<string, Session>();
/** 파일 append 순서를 보장하기 위한 직렬화 체인 */
let chain: Promise<unknown> = Promise.resolve();

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function dateOf(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function timeOf(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function stamp(ms: number): string {
  const d = new Date(ms);
  return `${dateOf(d)} ${timeOf(d)}`;
}

/** "YYYY-MM-DD HH:mm:ss" (치지직 openDate) → ms. 못 읽으면 null */
function parseOpenDate(s: string | null): number | null {
  if (!s) return null;
  const t = new Date(s.replace(" ", "T")).getTime();
  return Number.isFinite(t) ? t : null;
}

function ext(format: LogFormat): string {
  return format === "csv" ? "csv" : "txt";
}

const CSV_COLUMNS = "시각,채널,종류,닉네임,유저ID,금액,가려짐,내용";

function csvCell(v: string | number | null | undefined): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvRow(cells: (string | number | null)[]): string {
  return cells.map(csvCell).join(",");
}

/** 이모티콘 자리표시자는 그대로 두면 읽기 어려워 :이름: 형태로 줄인다 */
function plainContent(content: string): string {
  return content.replace(/\{:([a-zA-Z0-9_-]+):\}/g, ":$1:");
}

function blindLabel(blind: string | null | undefined): string {
  if (!blind) return "";
  if (blind === "cleanbot") return "클린봇";
  if (blind === "moderator") return "블라인드";
  return "숨김";
}

// ---------- 방송 회차 관리 ----------

/** 방송 정보가 갱신될 때마다 호출 — 회차가 바뀌면 새 파일을 연다 */
export function noteLive(channelId: string, live: LiveInfo | null): void {
  if (!getSettings().logTxt) return;
  const cur = sessions.get(channelId);

  if (!live || live.status !== "OPEN") {
    if (cur) {
      writeEvent(channelId, cur, Date.now(), "방송 종료", "");
      sessions.delete(channelId);
    }
    return;
  }

  const startedAt = parseOpenDate(live.openDate);
  const key = live.openDate ?? cur?.key ?? stamp(Date.now());
  if (cur && cur.key === key) {
    // 같은 방송 — 제목·카테고리가 바뀌었으면 그것만 남긴다
    if (live.liveTitle && live.liveTitle !== cur.title) {
      cur.title = live.liveTitle;
      writeEvent(channelId, cur, Date.now(), "제목 변경", live.liveTitle);
    }
    if (live.categoryValue && live.categoryValue !== cur.category) {
      cur.category = live.categoryValue;
      writeEvent(channelId, cur, Date.now(), "카테고리 변경", live.categoryValue);
    }
    return;
  }

  const session = startSession(channelId, {
    key,
    startedAt: startedAt ?? Date.now(),
    title: live.liveTitle ?? "",
    category: live.categoryValue ?? "",
  });
  sessions.set(channelId, session);
  // 채팅이 하나도 없어도 방송 기록은 남도록 파일을 미리 만들어 둔다
  append(channelId, session, "");
}

function startSession(
  channelId: string,
  info: { key: string; startedAt: number; title: string; category: string },
): Session {
  const format = getSettings().logFormat;
  const d = new Date(info.startedAt);
  const file = `${dateOf(d)}_${pad(d.getHours())}${pad(d.getMinutes())}.${ext(format)}`;
  const name = channelName(channelId);

  const header =
    format === "csv"
      ? `${CSV_COLUMNS}\n` +
        csvRow([
          stamp(info.startedAt),
          name,
          "방송시작",
          "",
          channelId,
          "",
          "",
          `${info.title} / ${info.category}`,
        ])
      : `# 채널: ${name} (${channelId})\n` +
        `# 방송 시작: ${stamp(info.startedAt)}\n` +
        `# 제목: ${info.title}\n` +
        `# 카테고리: ${info.category}\n` +
        `# ----------------------------------------`;

  return { key: info.key, file, header, title: info.title, category: info.category };
}

/** 방송이 아닐 때 들어온 채팅을 담을 날짜별 파일 */
function fallbackSession(channelId: string, time: number): Session {
  const format = getSettings().logFormat;
  const date = dateOf(new Date(time));
  const name = channelName(channelId);
  const header =
    format === "csv"
      ? CSV_COLUMNS
      : `# 채널: ${name} (${channelId})\n` +
        `# ${date} — 방송 정보 없이 수집된 채팅\n` +
        `# ----------------------------------------`;
  return {
    key: `date:${date}`,
    file: `${date}.${ext(format)}`,
    header,
    title: "",
    category: "",
  };
}

// ---------- 기록 ----------

/** 제목 변경·방송 종료 등 방송 자체에 대한 기록 */
function writeEvent(
  channelId: string,
  session: Session,
  time: number,
  kind: string,
  detail: string,
): void {
  const format = getSettings().logFormat;
  const line =
    format === "csv"
      ? csvRow([stamp(time), channelName(channelId), kind, "", "", "", "", detail])
      : `[${timeOf(new Date(time))}] * ${kind}${detail ? `: ${detail}` : ""}`;
  append(channelId, session, line);
}

/** 수신한 채팅 한 줄을 지금 회차 파일에 남긴다 */
export function logMessage(m: ChatMessage): void {
  if (!getSettings().logTxt) return;
  // 재접속 시 다시 내려오는 최근 채팅은 파일에 중복 기록하지 않는다
  if (m.isHistory) return;

  const session = sessions.get(m.channelId) ?? fallbackSession(m.channelId, m.time);
  const format = getSettings().logFormat;
  const content = plainContent(m.content);
  const blind = blindLabel(m.blind);
  const amount =
    m.type === "donation" ? (m.payAmount === null ? "금액숨김" : m.payAmount) : "";

  let line: string;
  if (format === "csv") {
    line = csvRow([
      stamp(m.time),
      channelName(m.channelId),
      m.type,
      m.nickname,
      m.userIdHash,
      amount,
      blind,
      content,
    ]);
  } else {
    const time = timeOf(new Date(m.time));
    const tags =
      (blind ? ` [${blind}]` : "") +
      (m.type === "donation"
        ? ` [후원 ${m.payAmount === null ? "금액숨김" : `${m.payAmount.toLocaleString("ko-KR")}치즈`}]`
        : "");
    // 구독/시스템 알림은 문구에 닉네임이 이미 들어 있어 * 표시로만 기록
    line =
      m.type === "subscription" || m.type === "system"
        ? `[${time}]${tags} * ${content}`
        : `[${time}]${tags} <${m.nickname}> ${content}`;
  }
  append(m.channelId, session, line);
}

function append(channelId: string, session: Session, line: string): void {
  const baseDir = getSettings().logDir || null;
  const channel = channelName(channelId);
  chain = chain
    .then(() =>
      invoke("append_chat_log", {
        channel,
        fileName: session.file,
        header: session.header,
        line,
        baseDir,
      }),
    )
    .catch((e) => console.error("로그 저장 실패:", e));
}

/** 형식이나 폴더가 바뀌면 다음 방송부터 새 파일을 쓰도록 회차를 비운다 */
export function resetSessions(): void {
  sessions.clear();
}
