import { getChannelInfo } from "./chzzk/api";
import { getKnownChannelNames, rememberChannel } from "./db";
import { displayName, getChannels } from "./settings";

/** DB에 기억해 둔 채널 이름 (목록에서 지운 채널도 포함) */
let known = new Map<string, string>();

export async function loadChannelNames(): Promise<void> {
  known = await getKnownChannelNames().catch(() => new Map());
  // 현재 등록된 채널도 기억해 둔다
  for (const ch of getChannels()) {
    if (!known.has(ch.channelId)) {
      known.set(ch.channelId, ch.name);
      rememberChannel(ch.channelId, ch.name, ch.imageUrl);
    }
  }
}

/** 채널 이름. 모르면 ID를 그대로 돌려준다 */
export function channelName(channelId: string): string {
  const saved = getChannels().find((c) => c.channelId === channelId);
  if (saved) return displayName(saved);
  return known.get(channelId) ?? channelId;
}

/**
 * 이름을 모르는 채널(기록에는 있는데 목록에서 지운 경우)을 치지직에서 조회해 채운다.
 * 하나라도 새로 알아냈으면 true — 호출한 쪽에서 다시 그리면 된다.
 */
export async function resolveUnknownChannelNames(
  channelIds: string[],
): Promise<boolean> {
  const unknown = [...new Set(channelIds)].filter(
    (id) => channelName(id) === id && !failed.has(id),
  );
  if (unknown.length === 0) return false;

  const results = await Promise.all(
    unknown.map(async (id) => {
      try {
        const info = await getChannelInfo(id);
        noteChannelName(id, info.channelName, info.channelImageUrl);
        return true;
      } catch {
        // 없어진 채널 등 — 다시 조회하지 않도록 기억
        failed.add(id);
        return false;
      }
    }),
  );
  return results.some(Boolean);
}

/** 조회에 실패한 채널 (반복 요청 방지) */
const failed = new Set<string>();

/** 이름을 알게 되면 기억해 둔다 */
export function noteChannelName(
  channelId: string,
  name: string,
  imageUrl?: string | null,
): void {
  if (!name || known.get(channelId) === name) return;
  known.set(channelId, name);
  rememberChannel(channelId, name, imageUrl);
}
