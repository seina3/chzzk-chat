import { ChatView } from "./chat-view";
import { Dashboard } from "./dashboard";

export interface PaneCallbacks {
  /** 창을 닫을 때 */
  onClose(channelId: string): void;
  /** 채팅 전송 */
  onSend(channelId: string, text: string): void;
  /** 닉네임 클릭 */
  onUserClick(userIdHash: string, nickname: string): void;
  /** 이 창이 눌렸을 때 (포커스 이동) */
  onFocus(channelId: string): void;
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

  constructor(
    readonly channelId: string,
    cb: PaneCallbacks,
  ) {
    const tpl = document.getElementById("pane-template") as HTMLTemplateElement;
    this.el = tpl.content.firstElementChild!.cloneNode(true) as HTMLElement;
    this.el.dataset.channelId = channelId;

    const pick = <T extends HTMLElement>(cls: string) =>
      this.el.querySelector<T>(`.${cls}`)!;

    this.input = pick<HTMLInputElement>("pane-text-input");
    // 웹뷰가 "저장된 정보" 목록을 띄우지 않도록 입력칸 이름을 매번 새로 짓는다
    this.input.autocomplete = "off";
    this.input.name = `chat-${Math.random().toString(36).slice(2, 10)}`;
    this.sendBtn = pick<HTMLButtonElement>("pane-send");
    this.statusEl = pick("pane-status");

    this.dash = new Dashboard(pick("pane-head"));
    this.chat = new ChatView(
      pick("pane-messages"),
      pick<HTMLButtonElement>("pane-scroll"),
      (uid, nick) => cb.onUserClick(uid, nick),
    );

    pick<HTMLButtonElement>("pane-close").addEventListener("click", (e) => {
      e.stopPropagation();
      cb.onClose(channelId);
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
  }

  focusInput(): void {
    if (!this.input.disabled) this.input.focus();
  }

  dispose(): void {
    this.dash.dispose();
    this.el.remove();
  }
}
