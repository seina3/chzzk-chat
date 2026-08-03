import {
  getChatAccessToken,
  getLiveDetail,
  getLiveStatus,
  getLogPowerState,
  claimLogPower,
  getUserStatus,
} from "./chzzk/api";
import { ChzzkChat, type ChatStatus } from "./chzzk/chat";
import type { ChatMessage, LiveInfo } from "./chzzk/types";
import { getChannels, getSettings, hasAuth } from "./settings";

export type ChannelStatus = ChatStatus | "idle";

interface CollectorOptions {
  onMessage(m: ChatMessage): void;
  onBlind(channelId: string, userIdHash: string, msgTime: number): void;
  onError(channelId: string, message: string): void;
  onDebug(channelId: string, direction: "→" | "←", frame: string): void;
  onStatus(channelId: string, status: ChannelStatus, detail?: string): void;
  /** 방송 정보 갱신. justStarted면 방금 방송이 시작된 것 */
  onLive(channelId: string, live: LiveInfo | null, justStarted: boolean): void;
  /** 이 채널에서 내가 모은 통나무 파워. claimed는 방금 수령한 보상 수 */
  onLogPower(channelId: string, value: number, claimed: number): void;
}

const POLL_MS = 30_000;
/** 통나무 파워는 자주 바뀌지 않아 5분에 한 번만 확인한다 */
const LOG_POWER_MS = 300_000;

/**
 * 등록된 모든 채널의 채팅을 동시에 수집한다.
 * 화면에 보이는 채널과 무관하게 연결을 유지하므로, 창을 열어두지 않은
 * 채널의 채팅도 DB와 txt 로그에 쌓인다.
 */
export class ChatCollector {
  private chats = new Map<string, ChzzkChat>();
  private chatChannelIds = new Map<string, string>();
  private lives = new Map<string, LiveInfo | null>();
  private statuses = new Map<string, ChannelStatus>();
  /** 접속 절차가 진행 중인 채널 (중복 접속 방지) */
  private busy = new Set<string>();
  private logPowers = new Map<string, number>();
  private logPowerAt = new Map<string, number>();
  /** 이미 수령을 시도한 보상 ID — 같은 것을 두 번 부르지 않는다 */
  private claimedIds = new Set<string>();
  private uid: string | null = null;
  private nickname = "";
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private opts: CollectorOptions) {}

  async start(): Promise<void> {
    await this.refreshUser();
    await this.syncAll();
    this.timer = setInterval(() => void this.syncAll(), POLL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getLive(channelId: string): LiveInfo | null {
    return this.lives.get(channelId) ?? null;
  }

  getStatus(channelId: string): ChannelStatus {
    return this.statuses.get(channelId) ?? "idle";
  }

  /** 마지막으로 확인한 통나무 파워 (아직 모르면 null) */
  getLogPower(channelId: string): number | null {
    return this.logPowers.get(channelId) ?? null;
  }

  /** 지금 바로 확인하고, 받을 수 있는 보상이 있으면 받는다 */
  async claimLogPowerNow(channelId: string): Promise<void> {
    await this.pollLogPower(channelId, true, true);
  }

  isLive(channelId: string): boolean {
    return this.lives.get(channelId)?.status === "OPEN";
  }

  canSend(channelId: string): boolean {
    const chat = this.chats.get(channelId);
    return !!chat && chat.canSend && this.getStatus(channelId) === "connected";
  }

  async sendChat(channelId: string, text: string): Promise<void> {
    const chat = this.chats.get(channelId);
    if (!chat) throw new Error("이 채널의 채팅에 연결되어 있지 않습니다.");
    await chat.sendChat(text);
  }

  /** 다음 전송 주변의 원본 프레임을 진단용으로 수집 */
  startFrameDebug(channelId: string, durationMs = 15_000): boolean {
    const chat = this.chats.get(channelId);
    if (!chat) return false;
    chat.startFrameDebug(durationMs);
    return true;
  }

  /** 로그인 상태가 바뀐 뒤 호출 — 모든 연결을 새 권한으로 다시 맺는다 */
  async reauth(): Promise<void> {
    await this.refreshUser();
    for (const channelId of [...this.chats.keys()]) {
      await this.disconnect(channelId);
    }
    await this.syncAll();
  }

  /** 채널이 목록에서 빠졌을 때 정리 */
  async drop(channelId: string): Promise<void> {
    await this.disconnect(channelId);
    this.lives.delete(channelId);
    this.statuses.delete(channelId);
  }

  /** 특정 채널을 지금 즉시 점검 (채널 추가 직후 등) */
  async syncChannel(channelId: string): Promise<void> {
    await this.poll(channelId, true);
  }

  /** 설정 변경 후 전체 재점검 */
  async syncNow(): Promise<void> {
    await this.syncAll();
  }

  private async refreshUser(): Promise<void> {
    const user = hasAuth() ? await getUserStatus() : null;
    this.uid = user?.userIdHash ?? null;
    this.nickname = user?.nickname ?? "";
  }

  private async syncAll(): Promise<void> {
    const channels = getChannels();
    const known = new Set(channels.map((c) => c.channelId));

    // 목록에서 사라진 채널 정리
    for (const channelId of [...this.chats.keys()]) {
      if (!known.has(channelId)) await this.drop(channelId);
    }

    const collectAll = getSettings().collectAll;
    for (const ch of channels) {
      // 전체 수집이 꺼져 있으면 보고 있는 채널만 연결한다
      if (!collectAll && !this.viewing.has(ch.channelId)) {
        await this.disconnect(ch.channelId);
        // 방송 상태는 알림을 위해 계속 확인한다
      }
      await this.poll(ch.channelId, false);
    }
  }

  /** 전체 수집이 꺼져 있을 때에도 연결을 유지할 채널 (지금 화면에 열린 창들) */
  viewing = new Set<string>();

  private async poll(channelId: string, force: boolean): Promise<void> {
    const status = await getLiveStatus(channelId).catch(() => null);
    if (!status) return;

    const prev = this.lives.get(channelId);
    const justStarted = status.status === "OPEN" && prev?.status !== "OPEN";

    let live: LiveInfo = status;
    if (justStarted || force || (status.status === "OPEN" && !prev?.openDate)) {
      // openDate는 상세 조회에만 있다
      const detail = await getLiveDetail(channelId).catch(() => null);
      if (detail) live = detail;
    } else if (prev?.openDate && status.status === "OPEN") {
      live = { ...status, openDate: prev.openDate };
    }
    this.lives.set(channelId, live);
    this.opts.onLive(channelId, live, justStarted);
    void this.pollLogPower(channelId, force || justStarted, false);

    const shouldCollect =
      getSettings().collectAll || this.viewing.has(channelId);
    if (!shouldCollect) return;

    if (live.status !== "OPEN" || !live.chatChannelId) {
      // 방송이 끝나면 채팅방도 닫힌다
      if (this.chats.has(channelId)) await this.disconnect(channelId);
      return;
    }

    const currentChatId = this.chatChannelIds.get(channelId);
    if (this.chats.has(channelId) && currentChatId === live.chatChannelId) {
      return; // 이미 올바른 채팅방에 연결됨
    }
    await this.connect(channelId, live.chatChannelId);
  }

  /**
   * 통나무 파워를 확인하고, 받아 둔 보상이 있으면 수령한다.
   *
   * 적립 자체는 치지직이 한다 (시청·팔로우·후원 등). 여기서 하는 일은
   * 웹에서 버튼을 눌러 받는 것과 같은 수령 요청뿐이고, 이미 받은 것은
   * 다시 부르지 않는다.
   */
  private async pollLogPower(
    channelId: string,
    force: boolean,
    manual: boolean,
  ): Promise<void> {
    if (!hasAuth()) return;
    const last = this.logPowerAt.get(channelId) ?? 0;
    if (!force && Date.now() - last < LOG_POWER_MS) return;
    this.logPowerAt.set(channelId, Date.now());

    const state = await getLogPowerState(channelId).catch(() => null);
    if (!state) return;

    let claimed = 0;
    if (manual || getSettings().autoClaimLogPower) {
      const pending = state.claims.filter((id) => !this.claimedIds.has(id));
      for (const id of pending) {
        this.claimedIds.add(id);
        if (await claimLogPower(channelId, id)) claimed += 1;
      }
    }

    // 수령했다면 늘어난 값을 다시 읽어 온다
    const value =
      claimed > 0
        ? ((await getLogPowerState(channelId).catch(() => null))?.power ??
          state.power)
        : state.power;
    if (value === null) return;
    this.logPowers.set(channelId, value);
    this.opts.onLogPower(channelId, value, claimed);
  }

  private async connect(channelId: string, chatChannelId: string): Promise<void> {
    if (this.busy.has(channelId)) return;
    this.busy.add(channelId);
    try {
      await this.disconnect(channelId);
      const token = await getChatAccessToken(chatChannelId);
      const chat = new ChzzkChat({
        channelId,
        chatChannelId,
        accessToken: token,
        uid: this.uid,
        nickname: this.nickname,
        onMessage: (m) => this.opts.onMessage(m),
        onBlind: (uid, time) => this.opts.onBlind(channelId, uid, time),
        onError: (message) => this.opts.onError(channelId, message),
        onDebug: (direction, frame) =>
          this.opts.onDebug(channelId, direction, frame),
        onStatus: (status, detail) => {
          this.statuses.set(channelId, status);
          this.opts.onStatus(channelId, status, detail);
        },
      });
      this.chats.set(channelId, chat);
      this.chatChannelIds.set(channelId, chatChannelId);
      await chat.connect();
    } catch (e) {
      this.chats.delete(channelId);
      this.chatChannelIds.delete(channelId);
      this.statuses.set(channelId, "disconnected");
      this.opts.onError(
        channelId,
        `채팅 접속 실패: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      this.busy.delete(channelId);
    }
  }

  private async disconnect(channelId: string): Promise<void> {
    const chat = this.chats.get(channelId);
    if (!chat) return;
    this.chats.delete(channelId);
    this.chatChannelIds.delete(channelId);
    this.statuses.set(channelId, "idle");
    await chat.disconnect().catch(() => {});
  }
}
