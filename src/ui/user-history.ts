import {
  getUserChannelBreakdown,
  getUserMessages,
  getUserStats,
  type StoredMessage,
  type UserChannelBreakdown,
  type UserStats,
} from "../db";
import { channelName } from "../channel-names";
import {
  blindRowClass,
  blindTagHtml,
  donationTierClass,
  escapeHtml,
  formatDateTime,
  formatNumber,
  renderContent,
} from "./render";

/**
 * 유저 클릭 시 DB에 저장된 그 유저의 "전체" 채팅 기록을 보여주는 모달.
 * 최신순 100개씩 페이지네이션, 내용 검색 지원.
 */
export class UserHistoryModal {
  private dialog: HTMLDialogElement;
  private titleEl: HTMLElement;
  private statsEl: HTMLElement;
  private listEl: HTMLElement;
  private searchInput: HTMLInputElement;
  private loadMoreBtn: HTMLButtonElement;

  private userIdHash = "";
  private oldestLoaded: number | undefined;
  private search = "";
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private donationsOnly = false;
  private stats: UserStats | null = null;
  private breakdown: UserChannelBreakdown[] = [];

  constructor() {
    this.dialog = document.getElementById("user-modal") as HTMLDialogElement;
    this.titleEl = document.getElementById("user-modal-title")!;
    this.statsEl = document.getElementById("user-modal-stats")!;
    this.listEl = document.getElementById("user-modal-list")!;
    this.searchInput = document.getElementById("user-modal-search") as HTMLInputElement;
    this.loadMoreBtn = document.getElementById("user-modal-more") as HTMLButtonElement;

    document.getElementById("user-modal-close")!.addEventListener("click", () => {
      this.dialog.close();
    });
    this.loadMoreBtn.addEventListener("click", () => void this.loadPage());

    for (const btn of document.querySelectorAll<HTMLButtonElement>(
      "#user-modal-tabs button",
    )) {
      btn.addEventListener("click", () => {
        this.donationsOnly = btn.dataset.mode === "donation";
        this.syncTabs();
        this.searchInput.placeholder = this.donationsOnly
          ? "후원 메시지 내용 검색…"
          : "메시지 내용 검색…";
        void this.loadBreakdown().then(() => this.renderStats());
        void this.reload();
      });
    }
    this.searchInput.addEventListener("input", () => {
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => {
        this.search = this.searchInput.value.trim();
        void this.reload();
      }, 300);
    });
  }

  /** donationsOnly로 열면 후원 내역 탭이 선택된 상태로 시작 */
  async open(
    userIdHash: string,
    nickname: string,
    donationsOnly = false,
  ): Promise<void> {
    this.userIdHash = userIdHash;
    this.titleEl.textContent = nickname;
    this.searchInput.value = "";
    this.search = "";
    this.donationsOnly = donationsOnly;
    this.syncTabs();
    this.searchInput.placeholder = donationsOnly
      ? "후원 메시지 내용 검색…"
      : "메시지 내용 검색…";
    this.dialog.showModal();

    this.stats = await getUserStats(userIdHash);
    await this.loadBreakdown();
    this.renderStats();
    await this.reload();
  }

  /** 채널별 분포 — 익명 후원처럼 사람을 구분할 수 없을 때 특히 유용 */
  private async loadBreakdown(): Promise<void> {
    this.breakdown = await getUserChannelBreakdown(
      this.userIdHash,
      this.donationsOnly,
    ).catch(() => []);
  }

  /** 상단 요약은 지금 보고 있는 탭에 맞춰 보여준다 */
  private renderStats(): void {
    const s = this.stats;
    if (!s) return;
    // 익명 후원은 보낸 사람을 구분할 수 없어 전체를 한데 모아 보여준다
    const anonymous = this.userIdHash === "anonymous";
    // 닉네임을 바꾼 적이 있으면 접어서 보여준다 (기간과 사용 횟수 포함)
    const aka =
      !anonymous && s.nicknames.length > 1
        ? `<details class="nick-history"><summary>닉네임 ${s.nicknames.length}개 사용 (변경 기록 보기)</summary>` +
          s.nicknames
            .map(
              (n, i) =>
                `<div class="nick-history-row">` +
                `<span class="nick">${escapeHtml(n.nickname)}</span>` +
                `${i === 0 ? '<span class="nick-current">현재</span>' : ""}` +
                `<span class="nick-history-meta">${formatDateTime(n.first_seen)} ~ ${formatDateTime(n.last_seen)} · ${formatNumber(n.cnt)}회</span>` +
                `</div>`,
            )
            .join("") +
          `</details>`
        : "";
    const uid = anonymous
      ? `<br><span class="uid">익명 후원은 보낸 사람을 구분할 수 없어 전체를 합쳐 보여줍니다.</span>`
      : `<br><span class="uid">ID: ${escapeHtml(this.userIdHash)}</span>`;

    if (this.donationsOnly) {
      const total = `<span class="cheese">🧀 ${formatNumber(s.donationTotal)}</span>`;
      this.statsEl.innerHTML =
        `후원 ${total} · ${formatNumber(s.donationCount)}회${uid}` +
        this.breakdownHtml() +
        aka;
      return;
    }

    const range =
      s.firstSeen && s.lastSeen
        ? ` · ${formatDateTime(s.firstSeen)} ~ ${formatDateTime(s.lastSeen)}`
        : "";
    // 채팅 내역에는 후원 요약도 함께 보여준다
    const donation =
      s.donationCount > 0
        ? ` · 후원 <span class="cheese">🧀 ${formatNumber(s.donationTotal)}</span>` +
          ` (${formatNumber(s.donationCount)}회)`
        : "";
    this.statsEl.innerHTML =
      `총 채팅 ${formatNumber(s.count)}회${donation}${range}${uid}` +
      this.breakdownHtml() +
      aka;
  }

  /** 채널별 분포 칩 — 어느 채널에서 얼마나 나왔는지 */
  private breakdownHtml(): string {
    if (this.breakdown.length === 0) return "";
    const chips = this.breakdown
      .map((b) => {
        const amount = this.donationsOnly
          ? `🧀 ${formatNumber(b.total)}`
          : `${formatNumber(b.cnt)}회`;
        const extra = this.donationsOnly ? ` (${formatNumber(b.cnt)}회)` : "";
        return (
          `<span class="breakdown-chip">` +
          `<span class="channel-tag">${escapeHtml(channelName(b.channel_id))}</span>` +
          `<span class="breakdown-amount">${amount}${extra}</span>` +
          `</span>`
        );
      })
      .join("");
    const title = this.donationsOnly ? "채널별 후원" : "채널별 채팅";
    return `<div class="breakdown"><span class="breakdown-title">${title}</span>${chips}</div>`;
  }

  private syncTabs(): void {
    for (const btn of document.querySelectorAll<HTMLButtonElement>(
      "#user-modal-tabs button",
    )) {
      const isDonation = btn.dataset.mode === "donation";
      btn.classList.toggle("active", isDonation === this.donationsOnly);
    }
  }

  private async reload(): Promise<void> {
    this.listEl.innerHTML = "";
    this.oldestLoaded = undefined;
    await this.loadPage();
  }

  private async loadPage(): Promise<void> {
    const rows = await getUserMessages(this.userIdHash, {
      before: this.oldestLoaded,
      search: this.search || undefined,
      donationsOnly: this.donationsOnly,
      limit: 100,
    });
    if (rows.length > 0) {
      this.oldestLoaded = rows[rows.length - 1].msg_time;
    }
    for (const row of rows) this.listEl.appendChild(this.renderRow(row));
    this.loadMoreBtn.classList.toggle("hidden", rows.length < 100);
    if (rows.length === 0 && this.listEl.childElementCount === 0) {
      const empty = document.createElement("div");
      empty.className = "history-empty";
      empty.textContent = this.search
        ? "검색 결과가 없습니다."
        : this.donationsOnly
          ? "후원 기록이 없습니다."
          : "저장된 메시지가 없습니다.";
      this.listEl.appendChild(empty);
    }
  }

  private renderRow(row: StoredMessage): HTMLElement {
    const el = document.createElement("div");
    el.className =
      (row.msg_type === "donation"
        ? `history-row donation ${donationTierClass(row.pay_amount ?? 0)}`
        : "history-row") + blindRowClass(row.blind);
    let emojis: Record<string, string> = {};
    try {
      if (row.emojis) emojis = JSON.parse(row.emojis);
    } catch {
      /* 구버전 데이터 무시 */
    }
    const channelTag = `<span class="channel-tag">${escapeHtml(channelName(row.channel_id))}</span>`;
    const cheese =
      row.msg_type === "donation" && row.pay_amount
        ? `<span class="cheese">🧀 ${formatNumber(row.pay_amount)}</span> `
        : "";
    el.innerHTML =
      `<span class="time">${formatDateTime(row.msg_time)}</span>` +
      channelTag +
      blindTagHtml(row.blind) +
      cheese +
      `<span class="content">${renderContent(row.content, emojis)}</span>`;
    return el;
  }
}
