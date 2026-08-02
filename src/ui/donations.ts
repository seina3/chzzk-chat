import {
  getChatSummary,
  getChattersByCount,
  getDonationSummary,
  getDonationsByChannel,
  getDonationsByUser,
  type DonationFilter,
} from "../db";
import { channelName } from "../channel-names";
import { getChannels } from "../settings";
import {
  donationTierClass,
  escapeHtml,
  formatDateTime,
  formatNumber,
  nickColor,
} from "./render";

type Period = "1d" | "7d" | "30d" | "all";
type Tab = "user" | "channel" | "chatter";

const DAY_MS = 86_400_000;

/**
 * 집계 모달.
 * 기간(1일/7일/30일/전체)과 채널로 걸러, 후원 총액과 함께
 * 유저별·채널별 후원 순위와 유저별 채팅 순위를 보여준다.
 */
export class DonationsModal {
  private dialog: HTMLDialogElement;
  private summaryEl: HTMLElement;
  private resultsEl: HTMLElement;
  private moreBtn: HTMLButtonElement;
  private channelSel: HTMLSelectElement;

  private period: Period = "7d";
  private tab: Tab = "user";

  constructor(
    /** 후원 순위에서 누르면 후원 내역, 채팅 순위에서 누르면 채팅 내역을 연다 */
    private onUserClick: (
      userIdHash: string,
      nickname: string,
      donationsOnly: boolean,
    ) => void,
  ) {
    this.dialog = document.getElementById("donation-modal") as HTMLDialogElement;
    this.summaryEl = document.getElementById("donation-summary")!;
    this.resultsEl = document.getElementById("donation-results")!;
    this.moreBtn = document.getElementById("donation-more") as HTMLButtonElement;
    this.channelSel = document.getElementById(
      "donation-channel",
    ) as HTMLSelectElement;

    document.getElementById("donation-close")!.addEventListener("click", () => {
      this.dialog.close();
    });

    for (const btn of document.querySelectorAll<HTMLButtonElement>(
      "#donation-periods button",
    )) {
      btn.addEventListener("click", () => {
        this.period = btn.dataset.period as Period;
        this.syncButtons();
        void this.reload();
      });
    }
    for (const btn of document.querySelectorAll<HTMLButtonElement>(
      "#donation-tabs button",
    )) {
      btn.addEventListener("click", () => {
        this.tab = btn.dataset.tab as Tab;
        this.syncButtons();
        void this.reload();
      });
    }
    this.channelSel.addEventListener("change", () => void this.reload());

    this.resultsEl.addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-uid]");
      if (el?.dataset.uid) {
        this.onUserClick(
          el.dataset.uid,
          el.dataset.nick ?? "",
          this.tab !== "chatter",
        );
      }
    });
  }

  open(): void {
    this.fillChannels();
    this.syncButtons();
    this.dialog.showModal();
    void this.reload();
  }

  private fillChannels(): void {
    const current = this.channelSel.value;
    this.channelSel.innerHTML = `<option value="">전체 채널</option>`;
    for (const ch of getChannels()) {
      const opt = document.createElement("option");
      opt.value = ch.channelId;
      opt.textContent = channelName(ch.channelId);
      this.channelSel.appendChild(opt);
    }
    this.channelSel.value = current;
  }

  private syncButtons(): void {
    for (const btn of document.querySelectorAll<HTMLButtonElement>(
      "#donation-periods button",
    )) {
      btn.classList.toggle("active", btn.dataset.period === this.period);
    }
    for (const btn of document.querySelectorAll<HTMLButtonElement>(
      "#donation-tabs button",
    )) {
      btn.classList.toggle("active", btn.dataset.tab === this.tab);
    }
  }

  private filter(): DonationFilter {
    const days = { "1d": 1, "7d": 7, "30d": 30, all: 0 }[this.period];
    return {
      since: days === 0 ? 0 : Date.now() - days * DAY_MS,
      channelId: this.channelSel.value || undefined,
    };
  }

  private async reload(): Promise<void> {
    this.resultsEl.innerHTML = "";
    this.moreBtn.classList.add("hidden");

    const f = this.filter();
    const label = {
      "1d": "최근 24시간",
      "7d": "최근 7일",
      "30d": "최근 30일",
      all: "전체 기간",
    }[this.period];

    // 요약은 보고 있는 탭에 맞춰 후원 총액 또는 채팅 수를 보여준다
    if (this.tab === "chatter") {
      const c = await getChatSummary(f);
      this.summaryEl.innerHTML =
        `<div class="donation-total chat-total">💬 ${formatNumber(c.total)}</div>` +
        `<div class="donation-sub">${label} · 채팅 ${formatNumber(c.total)}개 · 참여자 ${formatNumber(c.chatters)}명</div>`;
    } else {
      const s = await getDonationSummary(f);
      this.summaryEl.innerHTML =
        `<div class="donation-total">🧀 ${formatNumber(s.total)}</div>` +
        `<div class="donation-sub">${label} · 후원 ${formatNumber(s.count)}건 · 후원자 ${formatNumber(s.donors)}명</div>`;
    }

    if (this.tab === "user") {
      await this.loadUsers();
    } else if (this.tab === "channel") {
      await this.loadChannels();
    } else {
      await this.loadChatters();
    }
  }

  private empty(text: string): void {
    const el = document.createElement("div");
    el.className = "history-empty";
    el.textContent = text;
    this.resultsEl.appendChild(el);
  }

  private async loadUsers(): Promise<void> {
    const rows = await getDonationsByUser(this.filter());
    if (this.tab !== "user") return;
    if (rows.length === 0) {
      this.empty("해당 기간에 후원 기록이 없습니다.");
      return;
    }
    let rank = 0;
    for (const row of rows) {
      rank += 1;
      const el = document.createElement("div");
      el.className = "donation-user";
      el.dataset.uid = row.user_id_hash;
      el.dataset.nick = row.nickname ?? "";
      el.innerHTML =
        `<span class="rank">${rank}</span>` +
        `<span class="nick" style="color:${nickColor(row.user_id_hash)}">${escapeHtml(row.nickname ?? "(알 수 없음)")}</span>` +
        `<span class="donation-user-meta">${formatNumber(row.cnt)}회 · 마지막 ${formatDateTime(row.last_time)}</span>` +
        `<span class="donation-user-total ${donationTierClass(row.total)}">🧀 ${formatNumber(row.total)}</span>`;
      this.resultsEl.appendChild(el);
    }
  }

  /** 채널별 후원 순위 */
  private async loadChannels(): Promise<void> {
    const rows = await getDonationsByChannel(this.filter());
    if (this.tab !== "channel") return;
    if (rows.length === 0) {
      this.empty("해당 기간에 후원 기록이 없습니다.");
      return;
    }
    let rank = 0;
    for (const row of rows) {
      rank += 1;
      const name = channelName(row.channel_id);
      const el = document.createElement("div");
      el.className = "donation-user";
      el.innerHTML =
        `<span class="rank">${rank}</span>` +
        `<span class="nick">${escapeHtml(name)}</span>` +
        `<span class="donation-user-meta">${formatNumber(row.cnt)}회 · 후원자 ${formatNumber(row.donors)}명 · 마지막 ${formatDateTime(row.last_time)}</span>` +
        `<span class="donation-user-total ${donationTierClass(row.total)}">🧀 ${formatNumber(row.total)}</span>`;
      this.resultsEl.appendChild(el);
    }
  }

  /** 유저별 채팅 수 순위 (선택한 채널·기간 기준) */
  private async loadChatters(): Promise<void> {
    const rows = await getChattersByCount(this.filter());
    if (this.tab !== "chatter") return;
    if (rows.length === 0) {
      this.empty("해당 기간에 채팅 기록이 없습니다.");
      return;
    }
    let rank = 0;
    for (const row of rows) {
      rank += 1;
      const el = document.createElement("div");
      el.className = "donation-user";
      el.dataset.uid = row.user_id_hash;
      el.dataset.nick = row.nickname ?? "";
      el.innerHTML =
        `<span class="rank">${rank}</span>` +
        `<span class="nick" style="color:${nickColor(row.user_id_hash)}">${escapeHtml(row.nickname ?? "(알 수 없음)")}</span>` +
        `<span class="donation-user-meta">마지막 ${formatDateTime(row.last_time)}</span>` +
        `<span class="donation-user-total chat-count">💬 ${formatNumber(row.cnt)}</span>`;
      this.resultsEl.appendChild(el);
    }
  }
}
