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
