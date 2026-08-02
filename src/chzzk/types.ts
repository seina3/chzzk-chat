export interface ChannelInfo {
  channelId: string;
  channelName: string;
  channelImageUrl: string | null;
  followerCount: number;
}

export interface LiveInfo {
  status: "OPEN" | "CLOSE";
  liveTitle: string;
  categoryValue: string;
  concurrentUserCount: number;
  /** "YYYY-MM-DD HH:mm:ss" (KST) — live-detail에서만 제공 */
  openDate: string | null;
  chatChannelId: string | null;
  adult: boolean;
}

export type MessageType = "chat" | "donation" | "subscription" | "system";

/** 가려진 메시지의 사유 */
export type BlindType = "cleanbot" | "moderator" | "hidden";

export interface ChatMessage {
  channelId: string;
  userIdHash: string;
  nickname: string;
  content: string;
  /** emojiId -> imageUrl */
  emojis: Record<string, string>;
  roleCode: string;
  subscriptionBadgeUrl: string | null;
  subscriptionMonth: number | null;
  /** 후원 치즈 수량 (후원 메시지가 아니거나 금액이 숨겨졌으면 null) */
  payAmount: number | null;
  /** 채널이 금액 숨기기를 켜 둬 금액을 알 수 없는 후원 */
  amountHidden?: boolean;
  time: number;
  type: MessageType;
  /** 클린봇/운영자에 의해 가려진 메시지면 그 사유 */
  blind?: BlindType | null;
  /** 접속 시 최근 채팅 재생분 (실시간 수신이 아님) */
  isHistory?: boolean;
}

export interface UserStatus {
  userIdHash: string;
  nickname: string;
  loggedIn: boolean;
}
