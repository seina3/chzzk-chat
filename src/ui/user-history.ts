import {
  getUserChannelBreakdown,
  getUserMessages,
  getUserModLog,
  getUserStats,
  type StoredMessage,
  type UserChannelBreakdown,
  type UserStats,
} from "../db";
import type { ProfileCard } from "../chzzk/api";
import { channelName } from "../channel-names";
import { noteOf } from "../marks";
import {
  blindRowClass,
  blindTagHtml,
  donationTierClass,
  escapeHtml,
  formatDateTime,
  formatNumber,
  renderContent,
  roleBadgeHtml,
  roleRowClass,
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
  private nickname = "";
  private oldestLoaded: number | undefined;
  private search = "";
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  /** 채팅 / 후원 / 제재 기록 / 치지직 프로필 */
  private mode: "all" | "donation" | "mod" | "profile" = "all";
  /** 이 창을 연 채널 — "이 채널만" 범위를 고를 수 있게 기억해 둔다 */
  private originChannelId: string | undefined;
  /** 지금 보고 있는 범위 (정해져 있으면 그 채널만) */
  private channelId: string | undefined;
  private stats: UserStats | null = null;
  private breakdown: UserChannelBreakdown[] = [];

  private noteBtn: HTMLButtonElement;

  constructor(
    /** 📝 버튼이나 메모 줄을 누르면 메모 창을 연다 */
    private onEditNote?: (userIdHash: string, nickname: string) => void,
    /** 치지직에서 이 사람의 프로필 카드를 읽어 온다 */
    private loadProfile?: (
      userIdHash: string,
      channelId: string,
    ) => Promise<ProfileCard | null>,
  ) {
    this.dialog = document.getElementById("user-modal") as HTMLDialogElement;
    this.titleEl = document.getElementById("user-modal-title")!;
    this.statsEl = document.getElementById("user-modal-stats")!;
    this.listEl = document.getElementById("user-modal-list")!;
    this.searchInput = document.getElementById("user-modal-search") as HTMLInputElement;
    this.loadMoreBtn = document.getElementById("user-modal-more") as HTMLButtonElement;
    this.noteBtn = document.getElementById("user-modal-note") as HTMLButtonElement;

    document.getElementById("user-modal-close")!.addEventListener("click", () => {
      this.dialog.close();
    });
    this.noteBtn.addEventListener("click", () => this.editNote());
    // 이미 적어 둔 메모 줄을 눌러도 고칠 수 있게 한다
    this.statsEl.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".user-note")) this.editNote();
    });
    this.loadMoreBtn.addEventListener("click", () => void this.loadPage());

    for (const btn of document.querySelectorAll<HTMLButtonElement>(
      "#user-modal-tabs button",
    )) {
      btn.addEventListener("click", () => {
        this.mode = btn.dataset.mode as typeof this.mode;
        void this.refresh();
      });
    }
    // 통나무처럼 이 채널에서의 기록만 따로 볼 수 있게
    for (const btn of document.querySelectorAll<HTMLButtonElement>(
      "#user-modal-scope button",
    )) {
      btn.addEventListener("click", () => {
        this.channelId =
          btn.dataset.scope === "channel" ? this.originChannelId : undefined;
        void this.refresh();
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

  /**
   * donationsOnly로 열면 후원 내역 탭이 선택된 상태로 시작.
   * channelId를 주면 그 채널에서의 기록만 보여준다 (집계 창의 채널 필터).
   */
  async open(
    userIdHash: string,
    nickname: string,
    donationsOnly = false,
    channelId?: string,
  ): Promise<void> {
    this.userIdHash = userIdHash;
    this.nickname = nickname;
    this.originChannelId = channelId;
    this.channelId = channelId;
    this.searchInput.value = "";
    this.search = "";
    this.mode = donationsOnly ? "donation" : "all";
    this.dialog.showModal();
    await this.refresh();
  }

  private editNote(): void {
    // 익명 후원은 보낸 사람을 가릴 수 없어 메모를 달 데가 없다
    if (this.userIdHash === "anonymous" || !this.userIdHash) return;
    this.onEditNote?.(this.userIdHash, this.nickname);
  }

  /** 메모가 바뀌었을 때 요약 줄만 다시 그린다 */
  refreshMarks(): void {
    if (this.dialog.open) this.renderStats();
  }

  /** 탭이나 범위가 바뀔 때마다 제목·요약·목록을 다시 맞춘다 */
  private async refresh(): Promise<void> {
    this.titleEl.textContent = this.channelId
      ? `${this.nickname} — ${channelName(this.channelId)}`
      : this.nickname;
    this.noteBtn.classList.toggle(
      "hidden",
      this.userIdHash === "anonymous" || !this.onEditNote,
    );
    this.syncTabs();
    this.searchInput.classList.toggle("hidden", this.profileMode);
    this.searchInput.placeholder = this.searchHint();
    this.stats = await getUserStats(this.userIdHash, this.channelId);
    await this.loadBreakdown();
    this.renderStats();
    await this.reload();
  }

  private get donationsOnly(): boolean {
    return this.mode === "donation";
  }

  private searchHint(): string {
    return this.mode === "donation"
      ? "후원 메시지 내용 검색…"
      : this.mode === "mod"
        ? "제재 기록 검색…"
        : "메시지 내용 검색…";
  }

  private empty(text: string): void {
    const el = document.createElement("div");
    el.className = "history-empty";
    el.textContent = text;
    this.listEl.appendChild(el);
  }

  /** 프로필은 치지직에서 바로 읽어 오는 것이라 검색·범위가 쓰이지 않는다 */
  private get profileMode(): boolean {
    return this.mode === "profile";
  }

  /**
   * 치지직 프로필을 읽을 채널.
   * 창을 연 채널이 있으면 그곳, 없으면 이 사람이 가장 많이 말한 채널.
   */
  private profileChannel(): string | undefined {
    return this.channelId ?? this.originChannelId ?? this.breakdown[0]?.channel_id;
  }

  /** 개월 수를 "1년 8개월"처럼 */
  private monthsLabel(months: number): string {
    const y = Math.floor(months / 12);
    const m = months % 12;
    if (y > 0 && m > 0) return `${y}년 ${m}개월`;
    if (y > 0) return `${y}년`;
    return `${m}개월`;
  }

  /** 치지직에서 이 사람의 프로필을 읽어 보여준다 */
  private async loadProfileCard(): Promise<void> {
    const channelId = this.profileChannel();
    if (!this.loadProfile || !channelId) {
      this.empty("프로필을 읽을 채널을 알 수 없습니다.");
      return;
    }
    if (this.userIdHash === "anonymous") {
      this.empty("익명 후원은 보낸 사람을 알 수 없어 프로필이 없습니다.");
      return;
    }

    const loading = document.createElement("div");
    loading.className = "history-empty";
    loading.textContent = "치지직에서 불러오는 중…";
    this.listEl.appendChild(loading);

    const uid = this.userIdHash;
    const card = await this.loadProfile(uid, channelId).catch(() => null);
    if (this.userIdHash !== uid || this.mode !== "profile") return;
    this.listEl.innerHTML = "";
    if (!card) {
      this.empty(
        "프로필을 불러오지 못했습니다. 네이버 로그인 상태와 방송 여부를 확인해 주세요.",
      );
      return;
    }
    this.renderProfileCard(card, channelId);
  }

  private renderProfileCard(card: ProfileCard, channelId: string): void {
    const worn = card.badges
      .filter((b) => b.activated)
      .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));

    const face = (url: string | null, title: string) =>
      url
        ? `<img src="${escapeHtml(url)}" alt="" title="${escapeHtml(title)}" loading="lazy">`
        : `<span class="badge-noimg" title="${escapeHtml(title)}">?</span>`;

    const lines: string[] = [];
    if (card.subscription) {
      const s = card.subscription;
      const tier = s.tierName ? ` · ${escapeHtml(s.tierName)}` : "";
      lines.push(
        `<div class="pc-line">` +
          `<span class="pc-ico">${face(s.badgeUrl, s.badgeTitle)}</span>` +
          `<span><b>${this.monthsLabel(s.months)}</b> 구독 중${tier}</span>` +
          `</div>`,
      );
    }
    if (card.continuousDonationDays > 0) {
      lines.push(
        `<div class="pc-line">` +
          `<span class="pc-ico">🔥</span>` +
          `<span class="pc-hot"><b>${formatNumber(card.continuousDonationDays)}일째</b> 연속 후원 중</span>` +
          `</div>`,
      );
    }
    const day = card.followDate?.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (day) {
      lines.push(
        `<div class="pc-line">` +
          `<span class="pc-ico">♥</span>` +
          `<span>${day[1]}년 ${Number(day[2])}월 ${Number(day[3])}일 부터 팔로우</span>` +
          `</div>`,
      );
    }
    if (lines.length === 0) {
      lines.push(
        `<div class="pc-line"><span class="pc-ico">·</span>` +
          `<span>구독·팔로우 기록이 없습니다.</span></div>`,
      );
    }

    const box = document.createElement("div");
    box.className = "profile-view";
    box.innerHTML =
      `<div class="pc-top">` +
      (card.profileImageUrl
        ? `<img class="pc-avatar" src="${escapeHtml(card.profileImageUrl)}" alt="">`
        : `<span class="pc-avatar pc-avatar-none"></span>`) +
      `<div class="pc-who">` +
      `<div class="pc-nick">${escapeHtml(card.nickname || this.nickname)}</div>` +
      (worn.length > 0
        ? `<div class="pc-worn">${worn
            .map((b) => `<span class="pc-badge">${face(b.imageUrl, b.title)}</span>`)
            .join("")}</div>`
        : `<div class="pc-none">달고 있는 뱃지 없음</div>`) +
      `</div></div>` +
      `<div class="pc-lines">${lines.join("")}</div>` +
      `<div class="pc-section">` +
      `<div class="profile-section-title">가지고 있는 뱃지 ${formatNumber(card.badges.length)}개</div>` +
      (card.badges.length > 0
        ? `<div class="badge-grid">` +
          card.badges
            .map(
              (b) =>
                `<div class="badge-choice${b.activated ? " active" : ""}" title="${escapeHtml(b.badgeId)}">` +
                face(b.imageUrl, b.title) +
                `<span class="badge-choice-name">${escapeHtml(b.title)}</span>` +
                (b.activated
                  ? `<span class="badge-check">${(b.order ?? 0) || "✓"}</span>`
                  : "") +
                `</div>`,
            )
            .join("") +
          `</div>`
        : `<div class="history-empty">뱃지가 없습니다.</div>`) +
      `</div>` +
      `<div class="settings-help">${escapeHtml(channelName(channelId))} 채널 기준입니다.</div>`;
    this.listEl.appendChild(box);
  }

  /** 채널별 분포 — 익명 후원처럼 사람을 구분할 수 없을 때 특히 유용 */
  private async loadBreakdown(): Promise<void> {
    // 한 채널만 보는 중이면 분포를 보여줄 것이 없다
    if (this.channelId) {
      this.breakdown = [];
      return;
    }
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
    const note = noteOf(this.userIdHash);
    const noteBox = note
      ? `<div class="user-note clickable" title="눌러서 메모 고치기">📝 ${escapeHtml(note)}</div>`
      : "";
    this.noteBtn.textContent = note ? "📝 메모 고치기" : "📝 메모";
    const scope = this.channelId
      ? `<br><span class="uid">${escapeHtml(channelName(this.channelId))} 채널에서의 기록만 보고 있습니다.</span>`
      : "";
    const uid =
      scope +
      (anonymous
        ? `<br><span class="uid">익명 후원은 보낸 사람을 구분할 수 없어 전체를 합쳐 보여줍니다.</span>`
        : `<br><span class="uid">ID: ${escapeHtml(this.userIdHash)}</span>`);

    const hidden =
      s.donationHidden > 0
        ? ` · 금액 숨김 ${formatNumber(s.donationHidden)}건`
        : "";

    if (this.profileMode) {
      this.statsEl.innerHTML =
        noteBox +
        `치지직에 지금 올라 있는 프로필입니다${uid}`;
      return;
    }

    if (this.mode === "mod") {
      this.statsEl.innerHTML =
        noteBox +
        `운영자에게 가려진 메시지 ${formatNumber(s.blindedCount)}개 · 전체 채팅 ${formatNumber(s.count)}회${uid}` +
        `<div class="settings-help">가려지기 전의 원문을 그대로 보여줍니다. 클린봇 자동 가림은 제외했습니다.</div>`;
      return;
    }

    if (this.donationsOnly) {
      const total = `<span class="cheese">🧀 ${formatNumber(s.donationTotal)}</span>`;
      this.statsEl.innerHTML =
        noteBox +
        `후원 ${total} · ${formatNumber(s.donationCount)}회${hidden}${uid}` +
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
          ` (${formatNumber(s.donationCount)}회${hidden})`
        : "";
    const blinded =
      s.blindedCount > 0
        ? ` · <span class="blinded-count">가려짐 ${formatNumber(s.blindedCount)}개</span>`
        : "";
    this.statsEl.innerHTML =
      noteBox +
      `총 채팅 ${formatNumber(s.count)}회${donation}${blinded}${range}${uid}` +
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
      btn.classList.toggle("active", btn.dataset.mode === this.mode);
    }
    // 채널을 알 수 없는 경로로 열었으면 범위를 고를 수 없다
    const scopeRow = document.querySelector<HTMLElement>(".scope-row")!;
    scopeRow.classList.toggle("hidden", !this.originChannelId);
    for (const btn of document.querySelectorAll<HTMLButtonElement>(
      "#user-modal-scope button",
    )) {
      const isChannel = btn.dataset.scope === "channel";
      btn.classList.toggle("active", isChannel === !!this.channelId);
    }
    // 제재 기록은 검색 대신 통째로 보여 준다
    this.searchInput.classList.toggle("hidden", this.mode === "mod");
  }

  private async reload(): Promise<void> {
    this.listEl.innerHTML = "";
    this.oldestLoaded = undefined;
    this.loadMoreBtn.classList.add("hidden");
    if (this.profileMode) {
      await this.loadProfileCard();
      return;
    }
    await this.loadPage();
  }

  private async loadPage(): Promise<void> {
    const rows =
      this.mode === "mod"
        ? await getUserModLog(this.userIdHash, this.nickname, this.channelId)
        : await getUserMessages(this.userIdHash, {
            before: this.oldestLoaded,
            search: this.search || undefined,
            donationsOnly: this.donationsOnly,
            channelId: this.channelId,
            limit: 100,
          });
    if (this.mode === "mod") {
      for (const row of rows) this.listEl.appendChild(this.renderRow(row));
      this.loadMoreBtn.classList.add("hidden");
      if (rows.length === 0) {
        const empty = document.createElement("div");
        empty.className = "history-empty";
        empty.textContent =
          "가려지거나 제재된 기록이 없습니다. (수집 중에 일어난 것만 남습니다)";
        this.listEl.appendChild(empty);
      }
      return;
    }
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
        : "history-row") +
      blindRowClass(row.blind) +
      roleRowClass(row.role_code);
    let emojis: Record<string, string> = {};
    try {
      if (row.emojis) emojis = JSON.parse(row.emojis);
    } catch {
      /* 구버전 데이터 무시 */
    }
    const channelTag = `<span class="channel-tag">${escapeHtml(channelName(row.channel_id))}</span>`;
    const action = row.mod_action
      ? `<span class="mod-action">${escapeHtml(row.mod_action)}</span>`
      : "";
    // 구독·선물도 후원 내역에 함께 나오므로 한눈에 구분되게 표시한다
    const gift =
      row.gift_cnt && row.gift_cnt > 0
        ? `<span class="gift-tag">🎁 구독권 ${formatNumber(row.gift_cnt)}개</span> `
        : row.msg_type === "subscription"
          ? `<span class="gift-tag">🎁 구독</span> `
          : "";
    const cheese =
      row.msg_type !== "donation"
        ? ""
        : row.pay_amount
          ? `<span class="cheese">🧀 ${formatNumber(row.pay_amount)}</span> `
          : `<span class="cheese cheese-hidden" title="채널 설정으로 금액이 숨겨진 후원입니다">🧀 금액 숨김</span> `;
    el.innerHTML =
      `<span class="time">${formatDateTime(row.msg_time)}</span>` +
      channelTag +
      action +
      blindTagHtml(row.blind) +
      gift +
      cheese +
      roleBadgeHtml(row.role_code) +
      `<span class="content">${renderContent(row.content, emojis)}</span>`;
    return el;
  }
}
