const NICK_COLORS = [
  "#ef5350", "#ab47bc", "#7e57c2", "#5c6bc0", "#42a5f5",
  "#26c6da", "#26a69a", "#66bb6a", "#d4e157", "#ffa726",
  "#ff7043", "#8d6e63", "#78909c", "#ec407a", "#9ccc65",
];

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 스트리머 노란색, 매니저 파란색 */
const STREAMER_COLOR = "#ffc84d";
const MANAGER_COLOR = "#5eb7ff";

export type RoleKind = "streamer" | "manager" | null;

/**
 * 치지직 권한 코드를 스트리머/매니저로 간추린다.
 * (streamer, streaming_chat_manager, streaming_channel_manager, manager …)
 */
export function roleKind(roleCode: string | null | undefined): RoleKind {
  const code = (roleCode ?? "").toLowerCase();
  if (code === "streamer" || code === "streaming_streamer") return "streamer";
  if (code.includes("manager") || code.includes("operator")) return "manager";
  return null;
}

/** userIdHash 기반 고정 닉네임 색 (Chatty 방식) */
export function nickColor(userIdHash: string): string {
  let hash = 0;
  for (let i = 0; i < userIdHash.length; i++) {
    hash = (hash * 31 + userIdHash.charCodeAt(i)) | 0;
  }
  return NICK_COLORS[Math.abs(hash) % NICK_COLORS.length];
}

/** 스트리머·매니저는 고정 색으로, 나머지는 평소의 닉네임 색으로 */
export function nickColorFor(
  userIdHash: string,
  roleCode: string | null | undefined,
): string {
  const kind = roleKind(roleCode);
  if (kind === "streamer") return STREAMER_COLOR;
  if (kind === "manager") return MANAGER_COLOR;
  return nickColor(userIdHash);
}

/** 스트리머·매니저 채팅 줄에 붙일 강조 클래스 */
export function roleRowClass(roleCode: string | null | undefined): string {
  const kind = roleKind(roleCode);
  return kind ? ` role-${kind}` : "";
}

/** `{:emojiId:}` 플레이스홀더를 이모티콘 <img>로 치환 */
export function renderContent(
  content: string,
  emojis: Record<string, string>,
): string {
  const escaped = escapeHtml(content);
  return escaped.replace(/\{:([a-zA-Z0-9_-]+):\}/g, (match, id: string) => {
    const url = emojis[id];
    if (!url) return match;
    return `<img class="emote" src="${escapeHtml(url)}" alt=":${escapeHtml(id)}:" title=":${escapeHtml(id)}:" loading="lazy">`;
  });
}

export function roleBadgeHtml(roleCode: string | null | undefined): string {
  switch (roleKind(roleCode)) {
    case "streamer":
      return `<span class="badge badge-streamer" title="스트리머">방장</span>`;
    case "manager":
      return `<span class="badge badge-manager" title="매니저">매니저</span>`;
    default:
      return "";
  }
}

export function subBadgeHtml(url: string | null, month: number | null): string {
  if (!url) return "";
  const title = month ? `구독 ${month}개월` : "구독자";
  // alt는 비워 둔다 — 뱃지 이미지가 깨졌을 때 대체 텍스트가 채팅에 끼어들지 않도록
  return `<img class="badge-img" src="${escapeHtml(url)}" alt="" title="${title}" loading="lazy" onerror="this.remove()">`;
}

/**
 * 치지직 후원 UI의 금액 구간별 색상 티어.
 * 1,000+ 보라 / 10,000+ 청록 / 100,000+ 초록 / 500,000+ 주황 / 1,000,000+ 빨강
 */
export function donationTierClass(amount: number): string {
  if (amount >= 1_000_000) return "tier-red";
  if (amount >= 500_000) return "tier-orange";
  if (amount >= 100_000) return "tier-green";
  if (amount >= 10_000) return "tier-teal";
  if (amount >= 1_000) return "tier-purple";
  return "tier-base";
}

/** 가려진 메시지의 사유 태그 */
export function blindTagHtml(blind: string | null | undefined): string {
  if (!blind) return "";
  const label =
    blind === "cleanbot"
      ? "🤖 클린봇"
      : blind === "moderator"
        ? "🚫 블라인드"
        : "숨김";
  return `<span class="blind-tag" title="치지직에서 가려진 메시지입니다">${label}</span>`;
}

/** 가려진 메시지 행에 붙일 클래스 */
export function blindRowClass(blind: string | null | undefined): string {
  return blind ? ` blinded blind-${blind}` : "";
}

export function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `${date} ${formatTime(ms)}`;
}

export function formatNumber(n: number): string {
  return n.toLocaleString("ko-KR");
}
