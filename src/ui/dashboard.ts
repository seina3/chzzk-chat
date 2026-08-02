import type { ChannelInfo, LiveInfo } from "../chzzk/types";
import { formatNumber } from "./render";

/** 상단 방송 정보 대시보드: 제목/카테고리/시청자/업타임 */
export class Dashboard {
  private root = document.getElementById("dashboard")!;
  private imgEl = document.getElementById("dash-img") as HTMLImageElement;
  private nameEl = document.getElementById("dash-name")!;
  private liveEl = document.getElementById("dash-live")!;
  private titleEl = document.getElementById("dash-title")!;
  private categoryEl = document.getElementById("dash-category")!;
  private viewersEl = document.getElementById("dash-viewers")!;
  private uptimeEl = document.getElementById("dash-uptime")!;

  private openDate: number | null = null;
  private uptimeTimer: ReturnType<typeof setInterval> | null = null;

  hide(): void {
    this.root.classList.add("hidden");
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

  update(live: LiveInfo | null): void {
    const isLive = live?.status === "OPEN";
    this.liveEl.classList.toggle("on-air", isLive);
    this.liveEl.textContent = isLive ? "LIVE" : "오프라인";
    this.titleEl.textContent = live?.liveTitle ?? "";
    this.categoryEl.textContent = live?.categoryValue ?? "";
    this.viewersEl.textContent = isLive
      ? `시청자 ${formatNumber(live!.concurrentUserCount)}명`
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
      this.uptimeEl.textContent = `업타임 ${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    };
    tick();
    this.uptimeTimer = setInterval(tick, 1000);
  }
}
