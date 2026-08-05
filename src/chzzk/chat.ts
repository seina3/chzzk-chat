import WebSocket from "@tauri-apps/plugin-websocket";
import { getDeviceUuid, WINDOW_ID } from "../settings";
import type { BlindType, ChatMessage } from "./types";

/** 치지직 채팅 웹소켓 명령 코드 (비공식 프로토콜) */
const CMD = {
  ping: 0,
  pong: 10000,
  connect: 100,
  connected: 10100,
  requestRecentChat: 5101,
  recentChat: 15101,
  sendChat: 3101,
  /** 전송 결과 응답 (3101 + 10000) */
  sendChatAck: 13101,
  chat: 93101,
  donation: 93102,
  blind: 94008,
} as const;

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** 치지직 메시지 타입 코드 */
const MSG_TYPE = {
  text: 1,
  donation: 10,
  subscription: 11,
  system: 30,
} as const;

export type ChatStatus = "connecting" | "connected" | "reconnecting" | "disconnected";

interface ChzzkChatOptions {
  channelId: string;
  chatChannelId: string;
  accessToken: string;
  /** 로그인 유저의 userIdHash. null이면 익명(읽기 전용) */
  uid: string | null;
  /** 로그인 유저의 닉네임 (내가 보낸 메시지 표시용) */
  nickname?: string;
  onMessage: (m: ChatMessage) => void;
  onBlind: (userIdHash: string, msgTime: number, kind: BlindType) => void;
  onStatus: (status: ChatStatus, detail?: string) => void;
  /** 서버가 돌려준 오류 (전송 실패 원인 등) */
  onError: (message: string) => void;
  /** 진단 모드일 때 주고받은 원본 프레임 */
  onDebug?: (direction: "→" | "←", frame: string) => void;
  /**
   * 방금 보낸 내 채팅이 곧바로 가려졌을 때.
   * 접속 토큰이 다른 세션에 밀려 낡았을 수 있어, 호출부가 토큰을 새로
   * 받아 다시 붙어 볼 기회를 준다.
   */
  onSendBlinded?: () => void;
}

/** 제재 처분의 종류 */
const MOD_ACTIONS: [RegExp, string][] = [
  [/영구\s*제한|영구\s*정지|이용\s*정지/, "영구 제한"],
  [/임시\s*제한|일시\s*정지/, "임시 제한"],
  [/삭제/, "메시지 삭제"],
  [/활동\s*제한|채팅\s*제한/, "채팅 제한"],
];

/**
 * "OOO 님이 팬 구독권 3개를 채널에 선물하였습니다" 꼴의 안내에서
 * 선물한 개수를 뽑는다. 선물 안내가 아니면 0.
 *
 * 구독권 이름은 채널마다 다르고 티어마다도 달라("팬 구독권", "이웃집
 * 깔냥이" …) 이름으로는 찾을 수 없다. 변하지 않는 것은 "선물"이라는
 * 말과 "N개"라는 수량뿐이라 그 둘만 본다.
 */
function parseGiftCount(text: string): number {
  if (!/선물/.test(text)) return 0;
  const m = text.match(/(\d[\d,]*)\s*개/);
  // 수량이 적히지 않는 문구도 있어, 선물이라면 최소 1개로 센다
  return m ? Number(m[1].replace(/,/g, "")) || 1 : 1;
}

/**
 * "OOO님이 XXX님을 임시 제한 처리했습니다" 꼴의 안내에서
 * 처분 종류와 대상 닉네임을 뽑는다. 제재 안내가 아니면 둘 다 null.
 */
function parseModNotice(
  text: string,
  extras: any,
  blind: string | null,
): { modAction: string | null; targetNickname: string | null } {
  // 운영자가 가린 내 메시지도 하나의 처분으로 본다
  if (!text) {
    return {
      modAction: blind === "moderator" ? "메시지 삭제" : null,
      targetNickname: null,
    };
  }

  const action = MOD_ACTIONS.find(([re]) => re.test(text))?.[1] ?? null;
  if (!action) return { modAction: null, targetNickname: null };

  // 대상은 extras에 들어 있으면 그것을 쓰고, 없으면 문구에서 읽는다
  const fromExtras =
    extras?.targetChatProfile?.nickname ?? extras?.targetNickname ?? null;
  const fromText = text.match(/(?:님이\s*)?(.+?)\s*님을/)?.[1]?.trim() ?? null;
  return { modAction: action, targetNickname: fromExtras || fromText };
}

export class ChzzkChat {
  private ws: Awaited<ReturnType<typeof WebSocket.connect>> | null = null;
  private sid = "";
  private tid = 2;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private retries = 0;
  /** 전송 후 자기 메시지가 되돌아오는지 확인하는 타이머 */
  private sendEchoTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSentAt = 0;
  private lastSentText = "";
  /** 접수 응답을 기다리는 전송 내용 */
  private pendingSendText = "";
  readonly canSend: boolean;

  constructor(private opts: ChzzkChatOptions) {
    this.canSend = opts.uid !== null;
  }

  /** 채팅 서버는 kr-ss1 ~ kr-ss9 로 샤딩되며 chatChannelId로 결정 */
  private serverUrl(): string {
    const sum = [...this.opts.chatChannelId].reduce(
      (acc, ch) => acc + ch.charCodeAt(0),
      0,
    );
    return `wss://kr-ss${(sum % 9) + 1}.chat.naver.com/chat`;
  }

  /**
   * 웹소켓 연결. 브라우저와 동일한 Origin/User-Agent를 붙여 시도한다.
   * (헤더 없이 붙으면 치지직이 비정상 클라이언트로 보고 보낸 채팅을
   *  접수한 뒤 자동 블라인드하는 것으로 의심됨)
   * 플러그인이 헤더 옵션을 지원하지 않으면 헤더 없이 다시 시도한다.
   */
  private async openSocket() {
    const url = this.serverUrl();
    try {
      return await WebSocket.connect(url, {
        headers: [
          ["Origin", "https://chzzk.naver.com"],
          ["User-Agent", BROWSER_UA],
        ],
      });
    } catch (e) {
      console.warn("헤더 포함 연결 실패, 헤더 없이 재시도:", e);
      return await WebSocket.connect(url);
    }
  }

  async connect(): Promise<void> {
    this.closed = false;
    this.opts.onStatus(this.retries > 0 ? "reconnecting" : "connecting");
    this.ws = await this.openSocket();
    this.ws.addListener((msg) => {
      if (msg.type === "Text") {
        this.handleRaw(msg.data as string);
      } else if (msg.type === "Close") {
        this.handleClose();
      }
    });
    // 웹 클라이언트의 접속 프레임과 동일하게 맞춘다.
    // uuid / windowId는 기기·창 식별자로, 빠지면 보낸 채팅이 자동 블라인드된다.
    await this.send({
      ver: "3",
      cmd: CMD.connect,
      svcid: "game",
      cid: this.opts.chatChannelId,
      sid: null,
      bdy: {
        uid: this.opts.uid,
        devType: 2001,
        accTkn: this.opts.accessToken,
        auth: this.opts.uid ? "SEND" : "READ",
        libVer: "4.11.0",
        osVer: "Windows/10",
        devName: "Google Chrome/150.0.0.0",
        locale: "ko",
        timezone: "Asia/Seoul",
        uuid: getDeviceUuid(),
        windowId: WINDOW_ID,
      },
      tid: 1,
    });
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    this.stopPing();
    this.clearEchoTimer();
    if (this.ws) {
      await this.ws.disconnect().catch(() => {});
      this.ws = null;
    }
    this.opts.onStatus("disconnected");
  }

  async sendChat(text: string): Promise<void> {
    if (!this.canSend) throw new Error("채팅 전송에는 네이버 로그인이 필요합니다.");
    if (!this.ws || !this.sid) throw new Error("채팅 서버에 연결되어 있지 않습니다.");
    // 같은 내용을 연달아 보내면 치지직 도배 방지에 걸려 블라인드된다
    if (text === this.lastSentText && Date.now() - this.lastSentAt < 3000) {
      throw new Error("같은 내용을 너무 빨리 다시 보낼 수 없습니다.");
    }
    this.lastSentText = text;
    this.pendingSendText = text;

    // 실제 클라이언트가 보내는 형식 그대로 맞춘다.
    // (수신 프레임에 남아 있는 다른 사용자의 extras 원문에서 확인:
    //  emojis는 빈 문자열이 아니라 빈 객체이고, extraToken이 포함된다)
    const extras = {
      chatType: "STREAMING",
      osType: "PC",
      extraToken: this.opts.accessToken,
      streamingChannelId: this.opts.channelId,
      emojis: {},
    };

    await this.send({
      ver: "3",
      cmd: CMD.sendChat,
      svcid: "game",
      cid: this.opts.chatChannelId,
      sid: this.sid,
      retry: false,
      bdy: {
        msg: text,
        msgTypeCode: MSG_TYPE.text,
        extras: JSON.stringify(extras),
        msgTime: Date.now(),
      },
      tid: this.tid++,
    });

    // 서버가 접수 응답조차 주지 않는 경우를 잡는다 (응답이 오면 곧 해제됨)
    this.lastSentAt = Date.now();
    if (this.sendEchoTimer) clearTimeout(this.sendEchoTimer);
    this.sendEchoTimer = setTimeout(() => {
      this.sendEchoTimer = null;
      this.opts.onError("전송한 채팅에 대한 서버 응답이 없습니다.");
    }, 6000);
  }

  private async send(payload: unknown): Promise<void> {
    if (!this.ws) return;
    const frame = JSON.stringify(payload);
    // 핑/퐁은 잡음이라 진단에서 제외
    if (this.debugUntil > Date.now() && (payload as any)?.cmd !== CMD.ping) {
      this.opts.onDebug?.("→", frame);
    }
    await this.ws.send(frame);
  }

  /** 지정한 시간(ms) 동안 주고받는 프레임을 onDebug로 흘려보낸다 */
  private debugUntil = 0;

  startFrameDebug(durationMs: number): void {
    this.debugUntil = Date.now() + durationMs;
  }

  private handleRaw(raw: string): void {
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    if (this.debugUntil > Date.now() && data.cmd !== CMD.ping && data.cmd !== CMD.pong) {
      this.opts.onDebug?.("←", raw.length > 1500 ? `${raw.slice(0, 1500)}…` : raw);
    }

    // 서버가 거절한 요청은 retCode로 알려준다 (0 또는 없음 = 정상)
    if (data.retCode !== undefined && data.retCode !== null && data.retCode !== 0) {
      this.clearEchoTimer();
      this.opts.onError(
        `서버 오류 ${data.retCode}${data.retMsg ? `: ${data.retMsg}` : ""}`,
      );
      return;
    }

    switch (data.cmd) {
      case CMD.connected:
        this.sid = data.bdy?.sid ?? "";
        this.retries = 0;
        this.opts.onStatus("connected");
        this.startPing();
        void this.requestRecentChat();
        break;
      case CMD.ping:
        void this.send({ ver: "3", cmd: CMD.pong });
        break;
      case CMD.pong:
        break;
      case CMD.sendChatAck: {
        // 서버가 전송을 접수했다 (retCode가 0이 아니면 위에서 이미 오류 처리).
        // 치지직은 내가 보낸 채팅을 되돌려주지 않으므로 직접 화면에 올린다.
        this.clearEchoTimer();
        const text = this.pendingSendText;
        this.pendingSendText = "";
        if (text && this.opts.uid) {
          this.opts.onMessage({
            channelId: this.opts.channelId,
            userIdHash: this.opts.uid,
            nickname: this.opts.nickname ?? "나",
            content: text,
            emojis: {},
            roleCode: "common_user",
            subscriptionBadgeUrl: null,
            subscriptionMonth: null,
            payAmount: null,
            // 서버가 정한 시각을 쓰면 나중에 같은 메시지가 와도 중복되지 않는다
            time: data.bdy?.msgTime ?? data.bdy?.ctime ?? Date.now(),
            type: "chat",
            blind: null,
          });
        }
        break;
      }
      case CMD.chat:
      case CMD.donation: {
        const isDonation = data.cmd === CMD.donation;
        for (const raw of data.bdy ?? []) {
          const m = this.parseChat(raw, isDonation);
          if (!m) continue;
          // 내 메시지가 되돌아왔으면 전송이 확인된 것
          if (this.opts.uid && m.userIdHash === this.opts.uid) {
            this.clearEchoTimer();
          }
          this.opts.onMessage(m);
        }
        break;
      }
      case CMD.recentChat: {
        const list: any[] = data.bdy?.messageList ?? [];
        const parsed = list
          .map((raw) =>
            this.parseChat(
              raw,
              (raw.messageTypeCode ?? raw.msgTypeCode) === MSG_TYPE.donation,
            ),
          )
          .filter((m): m is ChatMessage => m !== null)
          .sort((a, b) => a.time - b.time);
        for (const m of parsed) this.opts.onMessage({ ...m, isHistory: true });
        break;
      }
      case CMD.blind: {
        const b = data.bdy ?? {};
        const uid = b.userId ?? b.userIdHash ?? "";
        const time = b.messageTime ?? b.msgTime ?? 0;
        // 누가 가렸는지는 blindType으로 갈린다 — 클린봇이면 문구 자체가
        // 걸린 것이고, BLIND면 채널 쪽 조치(제재·제한)다
        const kind: BlindType = b.blindType === "CBOTBLIND" ? "cleanbot" : "moderator";
        // 방금 보낸 내 메시지가 블라인드되면 전송은 됐지만 노출되지 않는다
        if (uid && uid === this.opts.uid && Date.now() - this.lastSentAt < 10_000) {
          this.clearEchoTimer();
          if (kind === "cleanbot") {
            this.opts.onError(
              "보낸 메시지를 클린봇이 가렸습니다. 다른 표현으로 바꿔 보세요.",
            );
          } else {
            this.opts.onError(
              "보낸 메시지가 이 채널에서 가려졌습니다. 전송 자체는 되었습니다.",
            );
            // 치지직 웹을 같이 켜 두면 나중에 받은 쪽이 접속 토큰을 가져가,
            // 남은 쪽이 보낸 채팅은 접수만 되고 가려진다. 토큰을 새로 받아
            // 다시 붙어 보게 한다.
            this.opts.onSendBlinded?.();
          }
        }
        if (uid && time) this.opts.onBlind(uid, time, kind);
        break;
      }
    }
  }

  private parseChat(raw: any, isDonationCmd: boolean): ChatMessage | null {
    // 클린봇/운영자가 가린 메시지도 버리지 않고 사유를 붙여 그대로 전달한다
    const status = raw.msgStatusType ?? raw.messageStatusType;
    const blind: BlindType | null =
      status === "CBOTBLIND"
        ? "cleanbot"
        : status === "BLIND"
          ? "moderator"
          : status === "HIDDEN"
            ? "hidden"
            : null;

    let profile: any = null;
    try {
      profile = raw.profile ? JSON.parse(raw.profile) : null;
    } catch {
      /* 프로필 파싱 실패 시 익명 취급 */
    }
    let extras: any = {};
    try {
      extras = raw.extras ? JSON.parse(raw.extras) : {};
    } catch {
      /* extras 없는 메시지도 존재 */
    }

    // 치지직 메시지 타입 코드: 10=후원, 11=구독, 30=시스템 메시지.
    // 구독 알림과 각종 안내(채팅 제한 등)가 후원과 같은 명령(93102)으로 오므로,
    // 명령만 보고 후원으로 단정하지 않고 구독 → 후원 → 시스템 순으로 판정한다.
    const typeCode: number = raw.msgTypeCode ?? raw.messageTypeCode ?? 1;
    const payAmount = Number(extras?.payAmount ?? 0);
    const hasPay = Number.isFinite(payAmount) && payAmount > 0;
    // 채널이 "금액 숨기기"를 켜면 후원이 금액 없이 내려온다.
    // 안내 메시지(채팅 제한 등)와 구분하려면 후원 전용 필드가 있는지 본다.
    const donationFields =
      extras?.donationType !== undefined ||
      extras?.isAnonymous !== undefined ||
      extras?.payType !== undefined ||
      extras?.donationUserWeeklyRank !== undefined;

    // 구독자가 친 평범한 채팅에도 month 자리가 (null로) 딸려 오는 경우가 있어,
    // 있고 없고가 아니라 실제 개월 수가 들어 있을 때만 구독 알림으로 본다.
    const subMonth = typeof extras?.month === "number" ? extras.month : null;
    const isSubscription =
      typeCode === MSG_TYPE.subscription || (subMonth !== null && subMonth > 0);
    const isDonation =
      !isSubscription &&
      (hasPay || donationFields) &&
      (isDonationCmd || typeCode === MSG_TYPE.donation);
    // 금액을 알 수 없는 후원 — 건수만 따로 집계한다
    const amountHidden = isDonation && !hasPay;
    const isSystem =
      !isSubscription &&
      !isDonation &&
      (typeCode === MSG_TYPE.system || isDonationCmd);

    // 시스템/구독 알림에는 profile이 없을 수 있고, 대상자는 extras 쪽에 들어 있다
    const actor =
      profile ?? extras?.registerChatProfile ?? extras?.targetChatProfile ?? null;
    const nickname: string = actor?.nickname ?? (isDonation ? "익명의 후원자" : "");
    const userMsg: string = (raw.msg ?? raw.content ?? "").toString();
    const desc: string = (extras?.description ?? "").toString().trim();

    let content = userMsg;
    if (isSubscription) {
      // 안내 문구(설명)가 없으면 개월 수로 직접 만든다
      const tier = extras?.tierName ? ` (${extras.tierName})` : "";
      const headline =
        desc ||
        (subMonth
          ? `${nickname} 님이 ${subMonth}개월 동안 구독 중이에요 🎉${tier}`
          : `${nickname} 님이 구독했어요 🎉${tier}`);
      const typed = userMsg.trim();
      content = typed && typed !== headline ? `${headline} — ${typed}` : headline;
    } else if (isSystem) {
      content = desc || userMsg;
    }

    // 후원·구독은 메시지 없이 오는 경우가 흔하므로 그대로 남기고,
    // 내용 없는 일반/시스템 메시지만 빈 줄이 되지 않게 건너뛴다
    if (!content.trim() && !isDonation && !isSubscription) return null;

    const time: number = raw.msgTime ?? raw.messageTime ?? Date.now();
    const sub = profile?.streamingProperty?.subscription;

    // 운영자 제재 안내라면 처분 종류와 대상을 뽑아 둔다.
    // ("모로이 모나님이 왜클릭님을 임시 제한 처리했습니다" 같은 문구)
    const { modAction, targetNickname } = parseModNotice(
      isSystem ? content : "",
      extras,
      blind,
    );

    let type: ChatMessage["type"] = "chat";
    if (isDonation) type = "donation";
    else if (isSubscription) type = "subscription";
    else if (isSystem) type = "system";

    return {
      channelId: this.opts.channelId,
      userIdHash: actor?.userIdHash ?? "anonymous",
      nickname,
      content,
      emojis:
        extras && typeof extras.emojis === "object" && extras.emojis !== null
          ? extras.emojis
          : {},
      roleCode: actor?.userRoleCode ?? "common_user",
      subscriptionBadgeUrl: sub?.badge?.imageUrl ?? null,
      subscriptionMonth: sub?.accumulativeMonth ?? extras?.month ?? null,
      // 구독·안내는 금액이 아니므로 후원 집계에 섞이지 않게 null로 둔다
      payAmount: isDonation && !amountHidden ? payAmount : null,
      amountHidden,
      time,
      type,
      blind,
      modAction,
      targetNickname,
      // 일반 채팅에 "선물"·"3개" 같은 말이 섞여 오해받지 않도록 안내류만 본다
      giftCount: type === "chat" ? 0 : parseGiftCount(content),
    };
  }

  private async requestRecentChat(count = 50): Promise<void> {
    await this.send({
      ver: "3",
      cmd: CMD.requestRecentChat,
      svcid: "game",
      cid: this.opts.chatChannelId,
      sid: this.sid,
      bdy: { recentMessageCount: count },
      tid: this.tid++,
    });
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      void this.send({ ver: "3", cmd: CMD.ping });
    }, 20_000);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private clearEchoTimer(): void {
    if (this.sendEchoTimer !== null) {
      clearTimeout(this.sendEchoTimer);
      this.sendEchoTimer = null;
    }
  }

  private handleClose(): void {
    this.stopPing();
    this.ws = null;
    if (this.closed) return;
    if (this.retries >= 5) {
      this.opts.onStatus("disconnected", "재연결 실패 (5회 초과)");
      return;
    }
    const delay = Math.min(3_000 * 2 ** this.retries, 30_000);
    this.retries += 1;
    this.opts.onStatus("reconnecting", `${delay / 1000}초 후 재연결`);
    setTimeout(() => {
      if (!this.closed) {
        this.connect().catch(() => this.handleClose());
      }
    }, delay);
  }
}
