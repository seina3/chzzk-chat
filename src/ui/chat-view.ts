import type { ChatMessage } from "../chzzk/types";
import type { StoredMessage } from "../db";
import {
  blindTagHtml,
  donationTierClass,
  escapeHtml,
  formatTime,
  nickColorFor,
  renderContent,
  roleBadgeHtml,
  roleRowClass,
  subBadgeHtml,
} from "./render";

const MAX_ROWS = 1000;

export class ChatView {
  private container: HTMLElement;
  private scrollBtn: HTMLButtonElement;
  private autoScroll = true;

  constructor(
    containerId: string,
    scrollBtnId: string,
    private onUserClick: (userIdHash: string, nickname: string) => void,
  ) {
    this.container = document.getElementById(containerId)!;
    this.scrollBtn = document.getElementById(scrollBtnId) as HTMLButtonElement;

    this.container.addEventListener("click", (e) => {
      const nick = (e.target as HTMLElement).closest<HTMLElement>(".nick");
      if (nick?.dataset.uid) {
        this.onUserClick(nick.dataset.uid, nick.textContent ?? "");
      }
    });

    this.container.addEventListener("scroll", () => {
      const el = this.container;
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      this.autoScroll = nearBottom;
      this.scrollBtn.classList.toggle("hidden", nearBottom);
    });

    this.scrollBtn.addEventListener("click", () => {
      this.autoScroll = true;
      this.scrollToBottom();
      this.scrollBtn.classList.add("hidden");
    });
  }

  clear(): void {
    this.container.innerHTML = "";
    this.autoScroll = true;
    this.scrollBtn.classList.add("hidden");
  }

  addSystem(text: string): void {
    const row = document.createElement("div");
    row.className = "msg system";
    row.textContent = text;
    this.append(row);
  }

  /** DB에 저장된 행을 화면에 복원 */
  addStored(row: StoredMessage): void {
    let emojis: Record<string, string> = {};
    try {
      if (row.emojis) emojis = JSON.parse(row.emojis);
    } catch {
      /* 구버전 데이터 무시 */
    }
    const type = row.msg_type as ChatMessage["type"];
    this.add({
      channelId: row.channel_id,
      userIdHash: row.user_id_hash,
      nickname: row.nickname,
      content: row.content,
      emojis,
      roleCode: row.role_code ?? "common_user",
      subscriptionBadgeUrl: null,
      subscriptionMonth: null,
      payAmount: row.pay_amount,
      amountHidden: row.amount_hidden === 1,
      blind: (row.blind as ChatMessage["blind"]) ?? null,
      time: row.msg_time,
      type: type === "donation" || type === "subscription" || type === "system"
        ? type
        : "chat",
      isHistory: true,
    });
  }

  add(m: ChatMessage): void {
    // 같은 유저·같은 시각의 메시지는 한 번만 (내 메시지 직접 표시 + 서버 반향 중복 방지)
    if (
      m.userIdHash !== "anonymous" &&
      this.container.querySelector(
        `.msg[data-uid="${CSS.escape(m.userIdHash)}"][data-time="${CSS.escape(String(m.time))}"]`,
      )
    ) {
      return;
    }

    const row = document.createElement("div");
    row.dataset.uid = m.userIdHash;
    row.dataset.time = String(m.time);

    // 구독/시스템 알림은 닉네임이 문구에 이미 포함되어 있어 배너 형태로 표시
    if (m.type === "subscription" || m.type === "system") {
      row.className = m.type === "subscription" ? "msg notice subscribe" : "msg notice";
      row.innerHTML =
        `<span class="time">${formatTime(m.time)}</span>` +
        `<span class="notice-icon">${m.type === "subscription" ? "🎖️" : "ℹ️"}</span>` +
        `<span class="content">${renderContent(m.content, m.emojis)}</span>`;
      this.append(row);
      return;
    }

    // 스트리머·매니저 채팅은 줄 전체를 강조한다
    row.className =
      (m.type === "donation"
        ? `msg donation ${donationTierClass(m.payAmount ?? 0)}`
        : "msg") + roleRowClass(m.roleCode);
    if (m.blind) row.classList.add("blinded", `blind-${m.blind}`);
    const blindTag = blindTagHtml(m.blind);

    // 채널이 금액 숨기기를 켜 두면 액수 없이 후원만 알 수 있다
    const donationTag =
      m.type !== "donation"
        ? ""
        : m.payAmount !== null
          ? `<span class="cheese">🧀 ${m.payAmount.toLocaleString("ko-KR")}</span>`
          : `<span class="cheese cheese-hidden" title="채널 설정으로 금액이 숨겨진 후원입니다">🧀 금액 숨김</span>`;

    row.innerHTML =
      `<span class="time">${formatTime(m.time)}</span>` +
      blindTag +
      donationTag +
      roleBadgeHtml(m.roleCode) +
      subBadgeHtml(m.subscriptionBadgeUrl, m.subscriptionMonth) +
      `<span class="nick" data-uid="${escapeHtml(m.userIdHash)}" style="color:${nickColorFor(m.userIdHash, m.roleCode)}">${escapeHtml(m.nickname)}</span>` +
      `<span class="content">${renderContent(m.content, m.emojis)}</span>`;

    this.append(row);
  }

  /** 운영자 블라인드 처리 — 해당 메시지에 취소선 표시 */
  markBlinded(userIdHash: string, msgTime: number): void {
    const rows = this.container.querySelectorAll<HTMLElement>(
      `.msg[data-uid="${CSS.escape(userIdHash)}"]`,
    );
    for (const row of rows) {
      if (row.dataset.time !== String(msgTime)) continue;
      row.classList.add("blinded", "blind-moderator");
      if (!row.querySelector(".blind-tag")) {
        const tag = document.createElement("span");
        tag.className = "blind-tag";
        tag.textContent = "🚫 블라인드";
        row.querySelector(".time")?.after(tag);
      }
    }
  }

  private append(row: HTMLElement): void {
    this.container.appendChild(row);
    while (this.container.childElementCount > MAX_ROWS) {
      this.container.firstElementChild?.remove();
    }
    if (this.autoScroll) this.scrollToBottom();
  }

  private scrollToBottom(): void {
    this.container.scrollTop = this.container.scrollHeight;
  }
}
