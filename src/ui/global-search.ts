import {
  searchMessages,
  searchUsers,
  type StoredMessage,
} from "../db";
import { getChannels } from "../settings";
import {
  blindRowClass,
  blindTagHtml,
  donationTierClass,
  escapeHtml,
  formatDateTime,
  formatNumber,
  nickColor,
  renderContent,
} from "./render";

type SearchMode = "user" | "chat";

/**
 * 전체 검색 모달.
 * - 유저 검색: 닉네임(과거 닉네임 포함)으로 유저를 찾고, 클릭 시 전체 기록 열람
 * - 채팅 검색: 저장된 모든 메시지에서 내용으로 검색, 작성자 표시
 */
export class GlobalSearchModal {
  private dialog: HTMLDialogElement;
  private input: HTMLInputElement;
  private resultsEl: HTMLElement;
  private moreBtn: HTMLButtonElement;
  private tabUser: HTMLButtonElement;
  private tabChat: HTMLButtonElement;

  private mode: SearchMode = "user";
  private oldestLoaded: number | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private onUserClick: (userIdHash: string, nickname: string) => void,
  ) {
    this.dialog = document.getElementById("search-modal") as HTMLDialogElement;
    this.input = document.getElementById("search-input") as HTMLInputElement;
    this.resultsEl = document.getElementById("search-results")!;
    this.moreBtn = document.getElementById("search-more") as HTMLButtonElement;
    this.tabUser = document.getElementById("search-tab-user") as HTMLButtonElement;
    this.tabChat = document.getElementById("search-tab-chat") as HTMLButtonElement;

    document.getElementById("search-close")!.addEventListener("click", () => {
      this.dialog.close();
    });
    this.tabUser.addEventListener("click", () => this.setMode("user"));
    this.tabChat.addEventListener("click", () => this.setMode("chat"));
    this.input.addEventListener("input", () => {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => void this.reload(), 300);
    });
    this.moreBtn.addEventListener("click", () => void this.loadChatPage());

    this.resultsEl.addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-uid]");
      if (el?.dataset.uid) {
        this.onUserClick(el.dataset.uid, el.dataset.nick ?? "");
      }
    });
  }

  open(): void {
    this.dialog.showModal();
    this.input.focus();
    if (this.input.value.trim()) void this.reload();
  }

  private setMode(mode: SearchMode): void {
    this.mode = mode;
    this.tabUser.classList.toggle("active", mode === "user");
    this.tabChat.classList.toggle("active", mode === "chat");
    this.input.placeholder =
      mode === "user"
        ? "닉네임 또는 유저 ID 검색… (과거 닉네임 포함)"
        : "채팅 내용 검색…";
    void this.reload();
  }

  private query(): string {
    return this.input.value.trim();
  }

  private async reload(): Promise<void> {
    this.resultsEl.innerHTML = "";
    this.oldestLoaded = undefined;
    this.moreBtn.classList.add("hidden");
    if (!this.query()) return;
    if (this.mode === "user") {
      await this.loadUsers();
    } else {
      await this.loadChatPage();
    }
  }

  private empty(text: string): void {
    const el = document.createElement("div");
    el.className = "history-empty";
    el.textContent = text;
    this.resultsEl.appendChild(el);
  }

  private async loadUsers(): Promise<void> {
    const q = this.query();
    const rows = await searchUsers(q);
    if (this.query() !== q || this.mode !== "user") return; // 입력이 바뀌면 폐기
    if (rows.length === 0) {
      this.empty("일치하는 유저가 없습니다.");
      return;
    }
    for (const row of rows) {
      const el = document.createElement("div");
      el.className = "search-user";
      el.dataset.uid = row.user_id_hash;
      el.dataset.nick = row.nickname;
      el.innerHTML =
        `<span class="nick" style="color:${nickColor(row.user_id_hash)}">${escapeHtml(row.nickname)}</span>` +
        `<span class="search-user-meta">메시지 ${formatNumber(row.cnt)}개 · 마지막 활동 ${formatDateTime(row.last_seen)}</span>` +
        `<span class="uid">${escapeHtml(row.user_id_hash)}</span>`;
      this.resultsEl.appendChild(el);
    }
  }

  private async loadChatPage(): Promise<void> {
    const q = this.query();
    const rows = await searchMessages(q, { before: this.oldestLoaded, limit: 100 });
    if (this.query() !== q || this.mode !== "chat") return;
    if (rows.length > 0) {
      this.oldestLoaded = rows[rows.length - 1].msg_time;
    }
    for (const row of rows) this.resultsEl.appendChild(this.renderChatRow(row));
    this.moreBtn.classList.toggle("hidden", rows.length < 100);
    if (rows.length === 0 && this.resultsEl.childElementCount === 0) {
      this.empty("일치하는 채팅이 없습니다.");
    }
  }

  private renderChatRow(row: StoredMessage): HTMLElement {
    const el = document.createElement("div");
    el.className =
      (row.msg_type === "donation"
        ? `history-row donation ${donationTierClass(row.pay_amount ?? 0)}`
        : "history-row") + blindRowClass(row.blind);
    let emojis: Record<string, string> = {};
    try {
      if (row.emojis) emojis = JSON.parse(row.emojis);
    } catch {
      /* 무시 */
    }
    const channelName = getChannels().find(
      (c) => c.channelId === row.channel_id,
    )?.name;
    const channelTag = channelName
      ? `<span class="channel-tag">${escapeHtml(channelName)}</span>`
      : "";
    const cheese =
      row.msg_type === "donation" && row.pay_amount
        ? `<span class="cheese">🧀 ${formatNumber(row.pay_amount)}</span> `
        : "";
    el.innerHTML =
      `<span class="time">${formatDateTime(row.msg_time)}</span>` +
      channelTag +
      blindTagHtml(row.blind) +
      cheese +
      `<span class="nick" data-uid="${escapeHtml(row.user_id_hash)}" data-nick="${escapeHtml(row.nickname)}" style="color:${nickColor(row.user_id_hash)}">${escapeHtml(row.nickname)}</span> ` +
      `<span class="content">${renderContent(row.content, emojis)}</span>`;
    return el;
  }
}
