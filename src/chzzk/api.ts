import { invoke } from "@tauri-apps/api/core";
import { getSettings } from "../settings";
import type { ChannelInfo, LiveInfo, UserStatus } from "./types";

const API_BASE = "https://api.chzzk.naver.com";
const COMM_BASE = "https://comm-api.game.naver.com/nng_main";

function cookieHeader(): string | null {
  const { nidAut, nidSes } = getSettings();
  return nidAut && nidSes ? `NID_AUT=${nidAut}; NID_SES=${nidSes}` : null;
}

/**
 * 치지직 API GET. 웹뷰 fetch는 User-Agent/Cookie를 강제 제거하므로
 * Rust 커맨드(chzzk_get)를 통해 요청한다.
 */
async function getContent<T>(url: string): Promise<T> {
  const body = await invoke<string>("chzzk_get", {
    url,
    cookie: cookieHeader(),
  });
  const json = JSON.parse(body);
  if (json.code !== 200) {
    throw new Error(`치지직 API 오류 ${json.code}: ${json.message ?? ""}`);
  }
  return json.content as T;
}

/** 채널 URL / live URL / 32자리 ID 어느 형태든 채널 ID로 정규화 */
export function parseChannelInput(input: string): string | null {
  const trimmed = input.trim();
  const urlMatch = trimmed.match(
    /chzzk\.naver\.com\/(?:live\/|video\/)?([0-9a-f]{32})/i,
  );
  if (urlMatch) return urlMatch[1].toLowerCase();
  if (/^[0-9a-f]{32}$/i.test(trimmed)) return trimmed.toLowerCase();
  return null;
}

export async function getChannelInfo(channelId: string): Promise<ChannelInfo> {
  const c = await getContent<any>(`${API_BASE}/service/v1/channels/${channelId}`);
  if (!c || !c.channelId) throw new Error("존재하지 않는 채널입니다.");
  return {
    channelId: c.channelId,
    channelName: c.channelName,
    channelImageUrl: c.channelImageUrl ?? null,
    followerCount: c.followerCount ?? 0,
  };
}

function toLiveInfo(c: any): LiveInfo {
  return {
    status: c.status === "OPEN" ? "OPEN" : "CLOSE",
    liveTitle: c.liveTitle ?? "",
    categoryValue: c.liveCategoryValue || c.liveCategory || "",
    concurrentUserCount: c.concurrentUserCount ?? 0,
    openDate: c.openDate ?? null,
    chatChannelId: c.chatChannelId ?? null,
    adult: c.adult ?? false,
  };
}

/** 상세 정보 (openDate 포함) — 접속 시 1회 */
export async function getLiveDetail(channelId: string): Promise<LiveInfo | null> {
  const c = await getContent<any>(
    `${API_BASE}/service/v2/channels/${channelId}/live-detail`,
  ).catch(() => null);
  return c ? toLiveInfo(c) : null;
}

/** 가벼운 폴링용 상태 (openDate 없음) */
export async function getLiveStatus(channelId: string): Promise<LiveInfo | null> {
  const c = await getContent<any>(
    `${API_BASE}/polling/v2/channels/${channelId}/live-status`,
  ).catch(() => null);
  return c ? toLiveInfo(c) : null;
}

export async function getChatAccessToken(chatChannelId: string): Promise<string> {
  const c = await getContent<any>(
    `${COMM_BASE}/v1/chats/access-token?channelId=${chatChannelId}&chatType=STREAMING`,
  );
  return c.accessToken as string;
}

export interface LogPowerState {
  /** 지금까지 모은 통나무 파워 */
  power: number | null;
  /** 아직 받지 않은 보상들의 수령 ID (예: FOLLOW-<uuid>) */
  claims: string[];
}

/**
 * 이 채널의 통나무 파워 현황.
 *
 * 치지직 웹이 쓰는 것과 같은 조회다 (GET, 로그인 쿠키 필요).
 * 응답 구조를 문서로 확인할 수 없어, 필드 이름 대신 값의 생김새로 찾는다:
 * 수령 ID는 "FOLLOW-<UUID>"처럼 대문자 종류 + UUID 꼴이라 구분이 확실하다.
 */
export async function getLogPowerState(
  channelId: string,
): Promise<LogPowerState> {
  if (!cookieHeader()) return { power: null, claims: [] };
  const c = await getContent<any>(
    `${API_BASE}/service/v1/channels/${channelId}/log-power`,
  ).catch(() => null);
  return { power: pickPower(c), claims: findClaimIds(c) };
}

/** 하위 호환 — 값만 필요할 때 */
export async function getLogPower(channelId: string): Promise<number | null> {
  return (await getLogPowerState(channelId)).power;
}

const CLAIM_ID = /^[A-Z][A-Z0-9_]*-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 응답 어디에 있든 수령 ID 꼴의 문자열을 모두 찾아낸다 */
function findClaimIds(value: unknown, out = new Set<string>()): string[] {
  if (typeof value === "string") {
    if (CLAIM_ID.test(value)) out.add(value);
  } else if (Array.isArray(value)) {
    for (const v of value) findClaimIds(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) findClaimIds(v, out);
  }
  return [...out];
}

/**
 * 보상 하나를 수령한다 (PUT, 본문 없음).
 * 이미 받은 것을 다시 부르면 서버가 거절하므로 호출 쪽에서 한 번만 시도한다.
 */
export async function claimLogPower(
  channelId: string,
  claimId: string,
): Promise<boolean> {
  if (!cookieHeader()) return false;
  if (!CLAIM_ID.test(claimId)) return false;
  try {
    await invoke<string>("chzzk_put", {
      url: `${API_BASE}/service/v1/channels/${channelId}/log-power/claims/${claimId}`,
      cookie: cookieHeader(),
    });
    return true;
  } catch (e) {
    console.warn("통나무 파워 수령 실패:", claimId, e);
    return false;
  }
}

function pickPower(content: any): number | null {
  if (content === null || content === undefined) return null;
  if (typeof content === "number") return content;
  if (typeof content !== "object") return null;

  const entries = Object.entries(content);
  const named = entries.find(
    ([k, v]) => typeof v === "number" && /power|point/i.test(k),
  );
  if (named) return named[1] as number;
  const anyNumber = entries.find(([, v]) => typeof v === "number");
  if (anyNumber) return anyNumber[1] as number;
  // 한 겹 더 들어가 있는 경우 (예: { logPower: { amount: 123 } })
  for (const [, v] of entries) {
    const nested = v && typeof v === "object" ? pickPower(v) : null;
    if (nested !== null) return nested;
  }
  return null;
}

/**
 * 네이버 쿠키가 설정된 경우 로그인 유저의 치지직 프로필. 미로그인이면 null.
 * getUserStatus는 치지직 닉네임(userIdHash 포함)을 돌려준다.
 */
export async function getUserStatus(): Promise<UserStatus | null> {
  try {
    const c = await getContent<any>(`${COMM_BASE}/v1/user/getUserStatus`);
    if (!c || c.loggedIn === false || !c.userIdHash) return null;
    return { userIdHash: c.userIdHash, nickname: c.nickname ?? "", loggedIn: true };
  } catch {
    return null;
  }
}
