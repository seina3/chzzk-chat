import {
  getChannelsWithData,
  getChatSummary,
  getChattersByCount,
  getChatsByChannel,
  getDonationSummary,
  getDonationsByChannel,
  getDonationsByUser,
  getTimeSeries,
  type DonationFilter,
} from "../db";
import { renderChart } from "./chart";
import { channelName, resolveUnknownChannelNames } from "../channel-names";
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

/** 목록에 보여줄 이름 — 익명 후원처럼 닉네임이 없는 경우를 메운다 */
function displayNick(userIdHash: string, nickname: string | null): string {
  if (nickname && nickname.trim()) return nickname;
  return userIdHash === "anonymous" ? "익명의 후원자" : "(알 수 없음)";
}

/** 금액을 숨긴 채널의 후원은 액수를 알 수 없어 건수만 따로 적는다 */
function hiddenNote(cnt: number | null | undefined): string {
  return cnt ? ` · 금액 숨김 ${formatNumber(cnt)}건` : "";
}

/**
 * 집계 모달.
 * 기간(1일/7일/30일/전체)과 채널로 걸러, 후원 총액과 함께
 * 유저별·채널별 후원 순위와 채널별·유저별 채팅 순위를 보여준다.
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
    /**
     * 후원 순위에서 누르면 후원 내역, 채팅 순위에서 누르면 채팅 내역을 연다.
     * 채널을 걸러 둔 상태면 그 채널의 기록만 보여준다.
     */
    private onUserClick: (
      userIdHash: string,
      nickname: string,
      donationsOnly: boolean,
      channelId?: string,
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
      const target = e.target as HTMLElement;
      // 채널 행을 누르면 그 채널로 좁혀 유저 순위로 파고든다
      const chan = target.closest<HTMLElement>("[data-channel]");
      if (chan?.dataset.channel !== undefined) {
        this.channelSel.value = chan.dataset.channel;
        void this.reload();
        return;
      }
      const el = target.closest<HTMLElement>("[data-uid]");
      if (el?.dataset.uid) {
        this.onUserClick(
          el.dataset.uid,
          el.dataset.nick ?? "",
          this.tab !== "chatter",
          this.channelSel.value || undefined,
        );
      }
    });
  }

  open(): void {
    this.syncButtons();
    this.dialog.showModal();
    void this.fillChannels();
    void this.reload();
  }

  /** 등록된 채널 + 기록만 남은 채널(목록에서 지운 채널)까지 모두 고른다 */
  private async fillChannels(): Promise<void> {
    const current = this.channelSel.value;
    const registered = getChannels().map((c) => c.channelId);
    const withData = await getChannelsWithData().catch(() => []);
    const ids = [...new Set([...registered, ...withData])];
    await resolveUnknownChannelNames(ids).catch(() => false);

    this.channelSel.innerHTML = `<option value="">전체 채널</option>`;
    for (const id of ids) {
      const opt = document.createElement("option");
      opt.value = id;
      const removed = !registered.includes(id);
      opt.textContent = removed
        ? `${channelName(id)} (삭제됨)`
        : channelName(id);
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
        `<div class="donation-sub">${label} · 채팅 ${formatNumber(c.total)}개 · 참여자 ${formatNumber(c.chatters)}명</div>` +
        `<div class="chart-slot"></div>`;
    } else {
      const s = await getDonationSummary(f);
      this.summaryEl.innerHTML =
        `<div class="donation-total">🧀 ${formatNumber(s.total)}</div>` +
        `<div class="donation-sub">${label} · 후원 ${formatNumber(s.count)}건 · 후원자 ${formatNumber(s.donors)}명` +
        `${hiddenNote(s.hidden)}</div>` +
        `<div class="chart-slot"></div>`;
    }
    await this.drawChart(f);

    if (this.tab === "user") {
      await this.loadUsers();
    } else if (this.tab === "channel") {
      await this.loadChannels();
    } else if (this.channelSel.value) {
      // 채널이 정해져 있으면 곧바로 그 채널의 유저 순위
      await this.loadChatters();
    } else {
      await this.loadChatChannels();
    }
  }

  /** 채널을 좁혀 본 상태에서 전체로 돌아가는 줄 */
  private backRow(): void {
    const el = document.createElement("button");
    el.className = "rank-back";
    el.dataset.channel = "";
    el.textContent = `← 전체 채널 · 지금은 ${channelName(this.channelSel.value)}`;
    this.resultsEl.appendChild(el);
  }

  /** 선택한 기간의 추이 그래프 (1일은 시간별, 그 외는 날짜별) */
  private async drawChart(f: DonationFilter): Promise<void> {
    const host = this.summaryEl.querySelector<HTMLElement>(".chart-slot");
    if (!host) return;
    const donations = this.tab !== "chatter";
    const hourly = this.period === "1d";
    const bucketMs = hourly ? 3_600_000 : DAY_MS;

    const rows = await getTimeSeries(f, bucketMs, donations);
    if (rows.length === 0) return;
    // 전체 기간이면 가장 오래된 기록부터, 아니면 기간 시작부터
    const from = f.since > 0 ? f.since : rows[0].bucket * bucketMs;

    const pad = (n: number) => String(n).padStart(2, "0");
    const date = (d: Date) =>
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

    renderChart(host, rows, {
      bucketMs,
      from,
      to: Date.now(),
      metric: donations ? "total" : "cnt",
      color: donations ? "#ffc44d" : "#00e6a1",
      unit: donations ? "🧀 " : "💬 ",
      label: (t) => {
        const d = new Date(t);
        return hourly
          ? `${pad(d.getHours())}시`
          : `${d.getMonth() + 1}/${d.getDate()}`;
      },
      tipLabel: (t) => {
        const d = new Date(t);
        return hourly ? `${date(d)} ${pad(d.getHours())}시` : date(d);
      },
    });
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
      const nick = displayNick(row.user_id_hash, row.nickname);
      const el = document.createElement("div");
      el.className = "donation-user";
      el.dataset.uid = row.user_id_hash;
      el.dataset.nick = nick;
      el.innerHTML =
        `<span class="rank">${rank}</span>` +
        `<span class="nick" style="color:${nickColor(row.user_id_hash)}">${escapeHtml(nick)}</span>` +
        `<span class="donation-user-meta">${formatNumber(row.cnt)}회${hiddenNote(row.hidden_cnt)} · 마지막 ${formatDateTime(row.last_time)}</span>` +
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
    // 목록에서 지워 이름을 모르는 채널은 치지직에서 이름을 받아온다
    void resolveUnknownChannelNames(rows.map((r) => r.channel_id)).then(
      (changed) => {
        if (changed && this.tab === "channel") void this.reload();
      },
    );

    let rank = 0;
    for (const row of rows) {
      rank += 1;
      const name = channelName(row.channel_id);
      const el = document.createElement("div");
      el.className = "donation-user";
      el.innerHTML =
        `<span class="rank">${rank}</span>` +
        `<span class="nick">${escapeHtml(name)}</span>` +
        `<span class="donation-user-meta">${formatNumber(row.cnt)}회 · 후원자 ${formatNumber(row.donors)}명${hiddenNote(row.hidden_cnt)} · 마지막 ${formatDateTime(row.last_time)}</span>` +
        `<span class="donation-user-total ${donationTierClass(row.total)}">🧀 ${formatNumber(row.total)}</span>`;
      this.resultsEl.appendChild(el);
    }
  }

  /** 채널별 채팅 수 순위 — 채널을 누르면 그 채널의 유저 순위로 들어간다 */
  private async loadChatChannels(): Promise<void> {
    const rows = await getChatsByChannel(this.filter());
    if (this.tab !== "chatter" || this.channelSel.value) return;
    if (rows.length === 0) {
      this.empty("해당 기간에 채팅 기록이 없습니다.");
      return;
    }
    void resolveUnknownChannelNames(rows.map((r) => r.channel_id)).then(
      (changed) => {
        if (changed && this.tab === "chatter" && !this.channelSel.value) {
          void this.reload();
        }
      },
    );

    let rank = 0;
    for (const row of rows) {
      rank += 1;
      const el = document.createElement("div");
      el.className = "donation-user clickable";
      el.dataset.channel = row.channel_id;
      el.title = "누르면 이 채널의 유저 순위를 봅니다";
      el.innerHTML =
        `<span class="rank">${rank}</span>` +
        `<span class="nick">${escapeHtml(channelName(row.channel_id))}</span>` +
        `<span class="donation-user-meta">참여자 ${formatNumber(row.chatters)}명 · 마지막 ${formatDateTime(row.last_time)}</span>` +
        `<span class="donation-user-total chat-count">💬 ${formatNumber(row.cnt)}</span>`;
      this.resultsEl.appendChild(el);
    }
  }

  /** 유저별 채팅 수 순위 (선택한 채널·기간 기준) */
  private async loadChatters(): Promise<void> {
    const rows = await getChattersByCount(this.filter());
    if (this.tab !== "chatter") return;
    if (this.channelSel.value) this.backRow();
    if (rows.length === 0) {
      this.empty("해당 기간에 채팅 기록이 없습니다.");
      return;
    }
    let rank = 0;
    for (const row of rows) {
      rank += 1;
      const nick = displayNick(row.user_id_hash, row.nickname);
      const el = document.createElement("div");
      el.className = "donation-user";
      el.dataset.uid = row.user_id_hash;
      el.dataset.nick = nick;
      el.innerHTML =
        `<span class="rank">${rank}</span>` +
        `<span class="nick" style="color:${nickColor(row.user_id_hash)}">${escapeHtml(nick)}</span>` +
        `<span class="donation-user-meta">마지막 ${formatDateTime(row.last_time)}</span>` +
        `<span class="donation-user-total chat-count">💬 ${formatNumber(row.cnt)}</span>`;
      this.resultsEl.appendChild(el);
    }
  }
}
