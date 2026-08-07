import {
  findCommonViewers,
  getChannelsWithData,
  getStreamerMessages,
  searchMessages,
  searchUsers,
  type StoredMessage,
} from "../db";
import { channelName, resolveUnknownChannelNames } from "../channel-names";
import { highlightOf, noteOf } from "../marks";
import { getChannels } from "../settings";
import {
  blindRowClass,
  blindTagHtml,
  donationTierClass,
  escapeHtml,
  formatDateTime,
  formatNumber,
  nickColor,
  nickColorFor,
  noteTagHtml,
  renderContent,
  roleBadgeHtml,
  roleRowClass,
} from "./render";

type SearchMode = "user" | "chat" | "streamer" | "common";

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
  private tabStreamer: HTMLButtonElement;
  private tabCommon: HTMLButtonElement;
  private channelSel: HTMLSelectElement;
  private commonBox: HTMLElement;
  private commonFind: HTMLInputElement;
  /** 고를 수 있는 채널 전부 (이름순) */
  private allChannels: string[] = [];
  /** «겹치는 시청자»에서 고른 채널 (고른 차례대로) */
  private picked: string[] = [];

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
    this.tabStreamer = document.getElementById(
      "search-tab-streamer",
    ) as HTMLButtonElement;
    this.tabCommon = document.getElementById(
      "search-tab-common",
    ) as HTMLButtonElement;
    this.commonBox = document.getElementById("common-picker")!;
    this.commonFind = document.getElementById("common-find") as HTMLInputElement;
    this.channelSel = document.getElementById(
      "search-channel",
    ) as HTMLSelectElement;

    document.getElementById("search-close")!.addEventListener("click", () => {
      this.dialog.close();
    });
    this.tabUser.addEventListener("click", () => this.setMode("user"));
    this.tabChat.addEventListener("click", () => this.setMode("chat"));
    this.tabStreamer.addEventListener("click", () => this.setMode("streamer"));
    this.tabCommon.addEventListener("click", () => this.setMode("common"));

    this.commonFind.addEventListener("input", () => this.renderPickList());
    document.getElementById("common-list")!.addEventListener("click", (e) => {
      const id = (e.target as HTMLElement).closest<HTMLElement>("[data-pick]")
        ?.dataset.pick;
      if (!id || this.picked.includes(id)) return;
      this.picked.push(id);
      this.commonFind.value = "";
      this.renderPicked();
      void this.reload();
    });
    document.getElementById("common-clear")!.addEventListener("click", () => {
      this.picked = [];
      this.commonFind.value = "";
      this.renderPicked();
      void this.reload();
    });
    document.getElementById("common-picked")!.addEventListener("click", (e) => {
      const id = (e.target as HTMLElement).closest<HTMLElement>("[data-drop]")
        ?.dataset.drop;
      if (!id) return;
      this.picked = this.picked.filter((c) => c !== id);
      this.renderPicked();
      void this.reload();
    });
    this.channelSel.addEventListener("change", () => void this.reload());
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
    void this.fillChannels();
    if (
      this.mode === "streamer" ||
      this.mode === "common" ||
      this.input.value.trim()
    ) {
      void this.reload();
    }
  }

  /** 스트리머 모아보기에서 쓸 채널 목록 (기록만 남은 채널까지) */
  private async fillChannels(): Promise<void> {
    const current = this.channelSel.value;
    const registered = getChannels().map((c) => c.channelId);
    const withData = await getChannelsWithData().catch(() => []);
    const ids = [...new Set([...registered, ...withData])];
    await resolveUnknownChannelNames(ids).catch(() => false);
    this.channelSel.innerHTML = `<option value="">전체 채널</option>`;
    const sorted = [...ids].sort((a, b) =>
      channelName(a).localeCompare(channelName(b), "ko"),
    );
    for (const id of sorted) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = channelName(id);
      this.channelSel.appendChild(opt);
    }
    this.channelSel.value = current;

    // «겹치는 시청자»의 고를 목록도 같은 채널들을 쓴다
    this.allChannels = sorted;
    this.renderPicked();
  }

  private setMode(mode: SearchMode): void {
    this.mode = mode;
    this.tabUser.classList.toggle("active", mode === "user");
    this.tabChat.classList.toggle("active", mode === "chat");
    this.tabStreamer.classList.toggle("active", mode === "streamer");
    this.tabCommon.classList.toggle("active", mode === "common");
    // 채널별로 좁혀 보는 것은 채팅 검색·스트리머 모아보기 둘 다 쓸모가 있다
    this.channelSel.classList.toggle(
      "hidden",
      mode === "user" || mode === "common",
    );
    this.commonBox.classList.toggle("hidden", mode !== "common");
    this.input.placeholder =
      mode === "user"
        ? "닉네임 또는 유저 ID 검색… (과거 닉네임 포함)"
        : mode === "chat"
          ? "채팅 내용 검색…"
          : mode === "common"
            ? "닉네임으로 좁히기… (비워 두면 전체)"
            : "스트리머 채팅 안에서 검색… (비워 두면 전체)";
    void this.reload();
  }

  private query(): string {
    return this.input.value.trim();
  }

  private async reload(): Promise<void> {
    this.resultsEl.innerHTML = "";
    this.oldestLoaded = undefined;
    this.moreBtn.classList.add("hidden");
    if (this.mode === "common") {
      await this.loadCommon();
      return;
    }
    if (this.mode !== "streamer" && !this.query()) return;
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

  /** 고른 채널을 지운 버튼과 함께 늘어놓는다 */
  private renderPicked(): void {
    const box = document.getElementById("common-picked")!;
    box.innerHTML = this.picked
      .map(
        (id) =>
          `<span class="chip">${escapeHtml(channelName(id))}` +
          `<button type="button" data-drop="${escapeHtml(id)}" aria-label="빼기">×</button>` +
          `</span>`,
      )
      .join("");
    this.renderPickList();
  }

  /**
   * 더할 수 있는 채널 목록.
   *
   * 채널이 수십 개면 운영체제가 그리는 목록 상자가 창 밖으로 흘러 잘렸다.
   * 그래서 창 안에서 스스로 굴러가는 목록으로 두고, 이름으로 걸러 찾는다.
   */
  private renderPickList(): void {
    const listEl = document.getElementById("common-list")!;
    const q = this.commonFind.value.trim().toLowerCase();
    const rest = this.allChannels.filter(
      (id) =>
        !this.picked.includes(id) &&
        (!q || channelName(id).toLowerCase().includes(q)),
    );
    if (rest.length === 0) {
      listEl.innerHTML = `<div class="pick-empty">${
        q ? "찾는 채널이 없습니다." : "더 고를 채널이 없습니다."
      }</div>`;
      return;
    }
    listEl.innerHTML = rest
      .map(
        (id) =>
          `<button type="button" class="pick-item" data-pick="${escapeHtml(id)}">` +
          `${escapeHtml(channelName(id))}</button>`,
      )
      .join("");
  }

  /** 고른 채널 모두에 채팅한 적이 있는 사람들 */
  private async loadCommon(): Promise<void> {
    if (this.picked.length < 2) {
      this.empty("채널을 두 개 이상 고르면, 그 채널에 모두 채팅한 시청자를 찾아 줍니다.");
      return;
    }
    const picked = [...this.picked];
    const q = this.query();
    const rows = await findCommonViewers(picked, { nickname: q || undefined });
    if (this.mode !== "common" || this.picked.join() !== picked.join()) return;
    if (rows.length === 0) {
      this.empty("고른 채널에 모두 채팅한 시청자가 없습니다.");
      return;
    }

    const head = document.createElement("div");
    head.className = "common-head";
    head.textContent = `${picked.length}개 채널 모두 참여 · ${formatNumber(rows.length)}명`;
    this.resultsEl.appendChild(head);

    for (const row of rows) {
      const el = document.createElement("div");
      el.className = "search-user";
      el.dataset.uid = row.user_id_hash;
      el.dataset.nick = row.nickname;
      const per = row.per_channel
        .map(
          (c) =>
            `<span class="chip-count">${escapeHtml(channelName(c.channel_id))}` +
            `<b>${formatNumber(c.cnt)}</b></span>`,
        )
        .join("");
      el.innerHTML =
        `<span class="nick" style="color:${nickColor(row.user_id_hash)}">${escapeHtml(row.nickname)}</span>` +
        `<span class="common-counts">${per}</span>` +
        `<span class="search-user-meta">합계 ${formatNumber(row.total)}개 · 마지막 활동 ${formatDateTime(row.last_seen)}</span>`;
      this.resultsEl.appendChild(el);
    }
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
    const mode = this.mode;
    const rows =
      mode === "streamer"
        ? await getStreamerMessages({
            search: q || undefined,
            channelId: this.channelSel.value || undefined,
            before: this.oldestLoaded,
            limit: 100,
          })
        : await searchMessages(q, {
            before: this.oldestLoaded,
            limit: 100,
            channelId: this.channelSel.value || undefined,
          });
    if (this.query() !== q || this.mode !== mode) return;
    if (rows.length > 0) {
      this.oldestLoaded = rows[rows.length - 1].msg_time;
    }
    for (const row of rows) this.resultsEl.appendChild(this.renderChatRow(row));
    this.moreBtn.classList.toggle("hidden", rows.length < 100);
    if (rows.length === 0 && this.resultsEl.childElementCount === 0) {
      this.empty(
        mode === "streamer"
          ? "저장된 스트리머 채팅이 없습니다. (권한 정보를 남기기 시작한 이후의 채팅만 모입니다)"
          : "일치하는 채팅이 없습니다.",
      );
    }
  }

  private renderChatRow(row: StoredMessage): HTMLElement {
    const el = document.createElement("div");
    el.className =
      (row.msg_type === "donation"
        ? `history-row donation ${donationTierClass(row.pay_amount ?? 0)}`
        : "history-row") +
      blindRowClass(row.blind) +
      roleRowClass(row.role_code) +
      (highlightOf(row.user_id_hash) ? " marked" : "");
    const mark = highlightOf(row.user_id_hash);
    if (mark) el.style.setProperty("--mark", mark);
    let emojis: Record<string, string> = {};
    try {
      if (row.emojis) emojis = JSON.parse(row.emojis);
    } catch {
      /* 무시 */
    }
    const channelTag = `<span class="channel-tag">${escapeHtml(channelName(row.channel_id))}</span>`;
    const cheese =
      row.msg_type !== "donation"
        ? ""
        : row.pay_amount
          ? `<span class="cheese">🧀 ${formatNumber(row.pay_amount)}</span> `
          : `<span class="cheese cheese-hidden" title="채널 설정으로 금액이 숨겨진 후원입니다">🧀 금액 숨김</span> `;
    el.innerHTML =
      `<span class="time">${formatDateTime(row.msg_time)}</span>` +
      channelTag +
      blindTagHtml(row.blind) +
      cheese +
      roleBadgeHtml(row.role_code) +
      noteTagHtml(noteOf(row.user_id_hash)) +
      `<span class="nick${noteOf(row.user_id_hash) ? " noted" : ""}" data-uid="${escapeHtml(row.user_id_hash)}" data-nick="${escapeHtml(row.nickname)}" style="color:${nickColorFor(row.user_id_hash, row.role_code)}">${escapeHtml(row.nickname)}</span> ` +
      `<span class="content">${renderContent(row.content, emojis)}</span>`;
    return el;
  }
}
