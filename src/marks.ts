import {
  addUserBlock,
  getUserBlocks,
  getUserMarks,
  removeUserBlock,
  saveUserMark,
  type UserBlock,
  type UserMark,
} from "./db";

/**
 * 내가 유저에게 붙여 둔 표시 — 메모 · 강조 색 · 차단.
 *
 * 채팅 한 줄을 그릴 때마다 조회하므로 전부 메모리에 올려 두고,
 * 바뀔 때만 DB에 쓴다. (모두 내가 직접 지정한 것이라 양이 적다)
 */

export interface Mark {
  nickname: string;
  note: string;
  highlight: string;
}

const marks = new Map<string, Mark>();
/** userIdHash → 차단된 채널 집합. 빈 문자열은 "모든 채널" */
const blocks = new Map<string, Set<string>>();
const listeners = new Set<() => void>();

export async function loadMarks(): Promise<void> {
  marks.clear();
  blocks.clear();
  const [markRows, blockRows] = await Promise.all([
    getUserMarks().catch((): UserMark[] => []),
    getUserBlocks().catch((): UserBlock[] => []),
  ]);
  for (const r of markRows) {
    marks.set(r.user_id_hash, {
      nickname: r.nickname ?? "",
      note: r.note ?? "",
      highlight: r.highlight ?? "",
    });
  }
  for (const r of blockRows) {
    let set = blocks.get(r.user_id_hash);
    if (!set) blocks.set(r.user_id_hash, (set = new Set()));
    set.add(r.channel_id);
  }
}

/** 표시가 바뀌면 화면을 다시 그리도록 알린다 */
export function onMarksChanged(fn: () => void): void {
  listeners.add(fn);
}

function changed(): void {
  for (const fn of listeners) fn();
}

export function markOf(userIdHash: string): Mark | undefined {
  return marks.get(userIdHash);
}

export function noteOf(userIdHash: string): string {
  return marks.get(userIdHash)?.note ?? "";
}

export function highlightOf(userIdHash: string): string {
  return marks.get(userIdHash)?.highlight ?? "";
}

/** 모든 채널 차단이거나 이 채널이 차단됐으면 true */
export function isBlocked(userIdHash: string, channelId: string): boolean {
  const set = blocks.get(userIdHash);
  if (!set) return false;
  return set.has("") || set.has(channelId);
}

export function blockedChannels(userIdHash: string): string[] {
  return [...(blocks.get(userIdHash) ?? [])];
}

export async function setMark(
  userIdHash: string,
  nickname: string,
  patch: { note?: string; highlight?: string },
): Promise<void> {
  const cur = marks.get(userIdHash);
  const note = patch.note ?? cur?.note ?? "";
  const highlight = patch.highlight ?? cur?.highlight ?? "";
  if (!note && !highlight) marks.delete(userIdHash);
  else marks.set(userIdHash, { nickname, note, highlight });
  await saveUserMark(userIdHash, nickname, note, highlight);
  changed();
}

export async function block(
  userIdHash: string,
  channelId: string,
  nickname: string,
): Promise<void> {
  let set = blocks.get(userIdHash);
  if (!set) blocks.set(userIdHash, (set = new Set()));
  set.add(channelId);
  await addUserBlock(userIdHash, channelId, nickname);
  changed();
}

export async function unblock(
  userIdHash: string,
  channelId: string,
): Promise<void> {
  const set = blocks.get(userIdHash);
  set?.delete(channelId);
  if (set && set.size === 0) blocks.delete(userIdHash);
  await removeUserBlock(userIdHash, channelId);
  changed();
}

/** 관리 창에서 쓸 목록 (메모/강조가 있는 유저) */
export function allMarks(): { userIdHash: string; mark: Mark }[] {
  return [...marks].map(([userIdHash, mark]) => ({ userIdHash, mark }));
}

/** 관리 창에서 쓸 목록 (차단) */
export function allBlocks(): { userIdHash: string; channelId: string; nickname: string }[] {
  const out: { userIdHash: string; channelId: string; nickname: string }[] = [];
  for (const [userIdHash, set] of blocks) {
    for (const channelId of set) {
      out.push({
        userIdHash,
        channelId,
        nickname: marks.get(userIdHash)?.nickname ?? "",
      });
    }
  }
  return out;
}

/** 차단 목록에 이름이 없을 때 화면에서 본 닉네임을 채워 둔다 */
const seenNicknames = new Map<string, string>();

export function rememberNickname(userIdHash: string, nickname: string): void {
  if (nickname) seenNicknames.set(userIdHash, nickname);
}

export function knownNickname(userIdHash: string): string {
  return marks.get(userIdHash)?.nickname || seenNicknames.get(userIdHash) || "";
}
