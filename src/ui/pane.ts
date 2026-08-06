import type { PaneStyle } from "../settings";
import { ChatView } from "./chat-view";
import { Dashboard } from "./dashboard";
import { logPowerIcon } from "./icons";
import { formatNumber } from "./render";

export interface PaneCallbacks {
  /** 창을 닫을 때 */
  onClose(channelId: string): void;
  /** 채팅 전송 */
  onSend(channelId: string, text: string): void;
  /** 닉네임 클릭 */
  onUserClick(userIdHash: string, nickname: string, channelId: string): void;
  /** 닉네임 우클릭 — 메모·강조·차단 메뉴 */
  onUserContext(
    userIdHash: string,
    nickname: string,
    channelId: string,
    x: number,
    y: number,
  ): void;
  /** 이 창이 눌렸을 때 (포커스 이동) */
  onFocus(channelId: string): void;
  /** 색·투명도 설정 창 열기 */
  onStyle(channelId: string): void;
  /** LIVE 표시를 눌러 치지직에서 방송 열기 */
  onOpenLive(channelId: string): void;
  /** 띄워 둔 창을 오른쪽에 붙이기 (팝업일 때만) */
  onDock(channelId: string): void;
  /** 통나무 파워 창 열기 (보유 파워 · 획득 기록) */
  onLogPowerHistory(channelId: string): void;
  /** 내 프로필 · 뱃지 고르기 창 열기 */
  onPickBadge(channelId: string): void;
}

/**
 * 채널 하나를 보여주는 창.
 * 방송 정보 · 채팅 · 상태줄 · 입력칸을 한 벌로 묶어, 여러 채널을
 * 나란히 열어 두고 각각에 채팅을 칠 수 있게 한다.
 */
export class ChannelPane {
  readonly el: HTMLElement;
  readonly chat: ChatView;
  readonly dash: Dashboard;

  private input: HTMLInputElement;
  private sendBtn: HTMLButtonElement;
  private statusEl: HTMLElement;
  private liveEl: HTMLElement;
  private staffBtn: HTMLButtonElement;
  private dockBtn: HTMLButtonElement;
  private powerBtn: HTMLButtonElement;
  private powerValueEl: HTMLElement;
  private badgeImg: HTMLImageElement;
  private badgeNoImg: HTMLElement;
  private staffOnly = false;

  constructor(
    readonly channelId: string,
    cb: PaneCallbacks,
    /** 화면에 떠 있는 팝업 창인지 */
    readonly floating = false,
  ) {
    const tpl = document.getElementById("pane-template") as HTMLTemplateElement;
    this.el = tpl.content.firstElementChild!.cloneNode(true) as HTMLElement;
    this.el.dataset.channelId = channelId;
    if (floating) this.el.classList.add("floating");

    const pick = <T extends HTMLElement>(cls: string) =>
      this.el.querySelector<T>(`.${cls}`)!;

    this.input = pick<HTMLInputElement>("pane-text-input");
    // 웹뷰가 "저장된 정보" 목록을 띄우지 않도록 입력칸 이름을 매번 새로 짓는다
    this.input.autocomplete = "off";
    this.input.name = `chat-${Math.random().toString(36).slice(2, 10)}`;
    this.sendBtn = pick<HTMLButtonElement>("pane-send");
    this.statusEl = pick("pane-status");
    this.liveEl = pick("pane-live");
    this.staffBtn = pick<HTMLButtonElement>("pane-staff");
    this.dockBtn = pick<HTMLButtonElement>("pane-dock");
    this.dockBtn.classList.toggle("hidden", !floating);
    if (floating) {
      pick<HTMLButtonElement>("pane-close").title = "이 창 닫기 (Esc)";
    }

    this.dash = new Dashboard(pick("pane-head"));
    this.chat = new ChatView(
      pick("pane-messages"),
      pick<HTMLButtonElement>("pane-scroll"),
      (uid, nick) => cb.onUserClick(uid, nick, channelId),
      (uid, nick, x, y) => cb.onUserContext(uid, nick, channelId, x, y),
    );

    pick<HTMLButtonElement>("pane-close").addEventListener("click", (e) => {
      e.stopPropagation();
      cb.onClose(channelId);
    });
    pick<HTMLButtonElement>("pane-style").addEventListener("click", (e) => {
      e.stopPropagation();
      cb.onStyle(channelId);
    });
    this.dockBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      cb.onDock(channelId);
    });
    // 방송 중일 때만 눌러서 치지직으로 넘어간다
    this.liveEl.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.liveEl.classList.contains("on-air")) cb.onOpenLive(channelId);
    });
    this.powerBtn = pick<HTMLButtonElement>("pane-power");
    this.powerValueEl = pick("pane-power-value");
    pick("pane-power-icon").innerHTML = logPowerIcon();
    this.powerBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      cb.onLogPowerHistory(channelId);
    });
    this.badgeImg = pick<HTMLImageElement>("pane-badge-img");
    this.badgeNoImg = pick("pane-badge-noimg");
    pick<HTMLButtonElement>("pane-badge").addEventListener("click", (e) => {
      e.stopPropagation();
      cb.onPickBadge(channelId);
    });
    this.staffBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.staffOnly = !this.staffOnly;
      this.staffBtn.classList.toggle("active", this.staffOnly);
      this.staffBtn.title = this.staffOnly
        ? "모든 채팅 보기"
        : "관리자 보기 — 스트리머·매니저 채팅과 제재 기록만";
      this.chat.setStaffOnly(this.staffOnly);
    });

    this.el.addEventListener("mousedown", () => cb.onFocus(channelId));
    this.input.addEventListener("focus", () => cb.onFocus(channelId));

    const send = () => {
      const text = this.input.value.trim();
      if (!text) return;
      this.input.value = "";
      cb.onSend(channelId, text);
    };
    this.sendBtn.addEventListener("click", send);
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") send();
    });

    if (floating) this.makeDraggable(pick("pane-head"));
    // 붙어 있는 창은 머리글을 끌어 순서를 바꾼다
    else pick("pane-head").draggable = true;
  }

  /** 팝업 창은 머리글을 잡아 옮길 수 있다 */
  private makeDraggable(handle: HTMLElement): void {
    handle.addEventListener("mousedown", (e) => {
      // 머리글의 버튼을 누른 것은 이동이 아니다
      if ((e.target as HTMLElement).closest("button")) return;
      e.preventDefault();
      const rect = this.el.getBoundingClientRect();
      const dx = e.clientX - rect.left;
      const dy = e.clientY - rect.top;

      const move = (ev: MouseEvent) => {
        const x = Math.min(
          Math.max(ev.clientX - dx, 0),
          window.innerWidth - rect.width,
        );
        const y = Math.min(
          Math.max(ev.clientY - dy, 0),
          window.innerHeight - 40,
        );
        this.el.style.left = `${x}px`;
        this.el.style.top = `${y}px`;
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });
  }

  /** 팝업이 뜰 자리 — 열려 있는 팝업 수만큼 조금씩 어긋나게 */
  placeAt(index: number): void {
    const offset = 26 * (index % 6);
    this.el.style.left = `${Math.round(window.innerWidth * 0.42) + offset}px`;
    this.el.style.top = `${70 + offset}px`;
    this.el.style.width = "420px";
    this.el.style.height = "520px";
  }

  /**
   * 창마다 다른 색을 입힌다.
   * 진하기(opacity)는 창 자체를 투명하게 만드는 것이 아니라, 얹는 색을
   * 얼마나 진하게 섞을지를 정한다 — 글자는 항상 또렷하게 남는다.
   */
  applyStyle(style: PaneStyle | undefined): void {
    const s = this.el.style;
    const pct = Math.round((style?.opacity ?? 1) * 100);
    if (style?.accent) s.setProperty("--pane-accent", style.accent);
    else s.removeProperty("--pane-accent");
    if (style?.bg) s.setProperty("--pane-bg", style.bg);
    else s.removeProperty("--pane-bg");
    if (style?.text) s.setProperty("--pane-text", style.text);
    else s.removeProperty("--pane-text");
    s.setProperty("--tint", `${pct}%`);
    this.el.classList.toggle("tinted", !!(style?.accent || style?.bg));
  }

  /** 채팅 입력칸 왼쪽에 둘 내 프로필 사진 */
  setMyProfileImage(url: string | null): void {
    this.badgeImg.classList.toggle("hidden", !url);
    this.badgeNoImg.classList.toggle("hidden", !!url);
    if (url) this.badgeImg.src = url;
  }

  /** 이 채널에서 모은 통나무 파워 */
  setLogPower(value: number | null, delta: number | null): void {
    this.powerValueEl.textContent = value === null ? "–" : formatNumber(value);
    this.powerBtn.title =
      value === null
        ? "통나무 파워 (네이버 로그인 후 표시됩니다 · 눌러서 열기)"
        : delta && delta > 0
          ? `통나무 파워 ${formatNumber(value)} (방금 +${formatNumber(delta)}) · 눌러서 기록 보기`
          : `통나무 파워 ${formatNumber(value)} · 눌러서 기록 보기`;
    if (delta && delta > 0) {
      this.powerBtn.classList.remove("bumped");
      // 다시 애니메이션이 걸리도록 한 프레임 쉬었다 붙인다
      void this.powerBtn.offsetWidth;
      this.powerBtn.classList.add("bumped");
    }
  }

  /** 최신 채팅으로 내린다 (분할 방식이 바뀌거나 창이 새로 붙었을 때) */
  scrollToLatest(): void {
    this.chat.scrollToLatest();
  }

  /** 따라가는 중이었다면 다시 최신으로 (다른 창에 갔다 돌아왔을 때) */
  restickToLatest(): void {
    this.chat.restickToLatest();
  }

  setStatus(text: string): void {
    this.statusEl.textContent = text;
  }

  setSendEnabled(enabled: boolean, placeholder: string): void {
    this.input.disabled = !enabled;
    this.sendBtn.disabled = !enabled;
    this.input.placeholder = placeholder;
  }

  setFocused(focused: boolean): void {
    this.el.classList.toggle("focused", focused);
    // 팝업은 눌린 것이 항상 위로 오게 한다
    if (focused && this.floating) this.el.style.zIndex = String(nextZ());
  }

  focusInput(): void {
    if (!this.input.disabled) this.input.focus();
  }

  dispose(): void {
    this.dash.dispose();
    this.el.remove();
  }
}

let z = 20;

function nextZ(): number {
  return ++z;
}
