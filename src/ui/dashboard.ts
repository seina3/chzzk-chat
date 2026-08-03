import type { ChannelInfo, LiveInfo } from "../chzzk/types";
import { formatNumber } from "./render";

/**
 * 창 하나의 방송 정보 머리글: 제목/카테고리/시청자/업타임.
 * 여러 채널을 나란히 볼 수 있으므로 창마다 하나씩 만든다.
 */
export class Dashboard {
  private imgEl: HTMLImageElement;
  private nameEl: HTMLElement;
  private liveEl: HTMLElement;
  private titleEl: HTMLElement;
  private categoryEl: HTMLElement;
  private viewersEl: HTMLElement;
  private uptimeEl: HTMLElement;
  private powerEl: HTMLElement;

  private openDate: number | null = null;
  private uptimeTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private root: HTMLElement) {
    const pick = <T extends HTMLElement>(cls: string) =>
      root.querySelector<T>(`.${cls}`)!;
    this.imgEl = pick<HTMLImageElement>("pane-img");
    this.nameEl = pick("pane-name");
    this.liveEl = pick("pane-live");
    this.titleEl = pick("pane-title");
    this.categoryEl = pick("pane-category");
    this.viewersEl = pick("pane-viewers");
    this.uptimeEl = pick("pane-uptime");
    this.powerEl = pick("pane-power");
  }

  setChannel(info: ChannelInfo): void {
    this.root.classList.remove("hidden");
    if (info.channelImageUrl) {
      this.imgEl.src = info.channelImageUrl;
      this.imgEl.classList.remove("hidden");
    } else {
      this.imgEl.classList.add("hidden");
    }
    this.nameEl.textContent = info.channelName;
    this.update(null);
  }

  /** 통나무 파워 — 늘었으면 얼마나 늘었는지도 함께 알려 준다 */
  setLogPower(value: number | null, delta: number | null): void {
    if (value === null) {
      this.powerEl.textContent = "";
      return;
    }
    this.powerEl.textContent = `🪵 ${formatNumber(value)}`;
    this.powerEl.title =
      delta && delta > 0
        ? `이 채널에서 모은 통나무 파워 (방금 +${formatNumber(delta)})`
        : "이 채널에서 모은 통나무 파워";
    if (delta && delta > 0) {
      this.powerEl.classList.remove("bumped");
      // 다시 애니메이션이 걸리도록 한 프레임 쉬었다 붙인다
      void this.powerEl.offsetWidth;
      this.powerEl.classList.add("bumped");
    }
  }

  setName(name: string): void {
    this.nameEl.textContent = name;
  }

  update(live: LiveInfo | null): void {
    const isLive = live?.status === "OPEN";
    this.liveEl.classList.toggle("on-air", isLive);
    this.liveEl.textContent = isLive ? "LIVE" : "오프라인";
    this.titleEl.textContent = live?.liveTitle ?? "";
    this.categoryEl.textContent = live?.categoryValue ?? "";
    this.viewersEl.textContent = isLive
      ? `${formatNumber(live!.concurrentUserCount)}명`
      : "";

    if (isLive && live?.openDate) {
      // openDate는 KST 기준 "YYYY-MM-DD HH:mm:ss" — 로컬 시간대로 해석
      const parsed = Date.parse(live.openDate.replace(" ", "T"));
      this.openDate = Number.isNaN(parsed) ? null : parsed;
    } else if (!isLive) {
      this.openDate = null;
    }
    this.restartUptime();
  }

  /** 창을 닫을 때 타이머 정리 */
  dispose(): void {
    if (this.uptimeTimer) clearInterval(this.uptimeTimer);
    this.uptimeTimer = null;
  }

  private restartUptime(): void {
    if (this.uptimeTimer) {
      clearInterval(this.uptimeTimer);
      this.uptimeTimer = null;
    }
    if (this.openDate === null) {
      this.uptimeEl.textContent = "";
      return;
    }
    const tick = () => {
      const sec = Math.max(0, Math.floor((Date.now() - this.openDate!) / 1000));
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = sec % 60;
      this.uptimeEl.textContent = `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    };
    tick();
    this.uptimeTimer = setInterval(tick, 1000);
  }
}
