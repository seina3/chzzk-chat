import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import {
  activateBadges,
  getChannelInfo,
  getLiveDetail,
  getMyProfileCard,
  getUserStatus,
  parseChannelInput,
  type ChzzkBadge,
} from "./chzzk/api";
import { ChatCollector } from "./collector";
import {
  getChannelLastActivity,
  getLatestLogPower,
  getLogPowerHistory,
  getRecentMessages,
  initDb,
  markMessageBlinded,
  recordLogPower,
  saveMessage,
  type LogPowerPoint,
} from "./db";
import { channelName, loadChannelNames, noteChannelName } from "./channel-names";
import { logMessage, noteLive, resetSessions } from "./logger";
import {
  allBlocks,
  allMarks,
  block,
  blockedChannels,
  highlightOf,
  knownNickname,
  loadMarks,
  noteOf,
  onMarksChanged,
  setMark,
  unblock,
} from "./marks";
import {
  displayName,
  getChannels,
  getSettings,
  hasAuth,
  saveChannels,
  saveSettings,
  sortChannels,
  type ChannelOrder,
  type LogFormat,
  type PaneLayout,
  type PaneStyle,
  type SavedChannel,
} from "./settings";
import { DonationsModal } from "./ui/donations";
import { GlobalSearchModal } from "./ui/global-search";
import { ChannelPane } from "./ui/pane";
import { logPowerIcon } from "./ui/icons";
import {
  escapeHtml,
  formatDateTime,
  formatNumber,
  nickColor,
} from "./ui/render";
import { UserHistoryModal } from "./ui/user-history";

let notifyGranted = false;

const userModal = new UserHistoryModal();
const searchModal = new GlobalSearchModal((uid, nick) => {
  void userModal.open(uid, nick);
});
const donationsModal = new DonationsModal(
  (uid, nick, donationsOnly, channelId) => {
    void userModal.open(uid, nick, donationsOnly, channelId);
  },
);

/** 모든 등록 채널의 채팅을 수집한다 (화면에 열려 있는지와 무관) */
const collector = new ChatCollector({
  onMessage: (m) => {
    saveMessage(m);
    logMessage(m);
    panes.get(m.channelId)?.chat.add(m);
  },
  onBlind: (channelId, uid, time) => {
    // 기록에도 남겨야 검색·유저 기록에서도 취소선으로 보인다
    markMessageBlinded(channelId, uid, time);
    panes.get(channelId)?.chat.markBlinded(uid, time);
  },
  onError: (channelId, message) => {
    const pane = panes.get(channelId);
    if (pane) pane.chat.addSystem(`⚠️ ${message}`);
    else console.warn(`[${channelId}] ${message}`);
  },
  onDebug: (channelId, direction, frame) => {
    panes.get(channelId)?.chat.addSystem(`${direction} ${frame}`);
  },
  onStatus: (channelId) => {
    renderPaneStatus(channelId);
    renderChannelList();
  },
  onLive: (channelId, live, justStarted) => {
    panes.get(channelId)?.dash.update(live);
    // 방송 회차·제목·카테고리 변화를 로그 파일에 반영
    noteLive(channelId, live);
    if (live?.status === "OPEN") markChannelLive(channelId, live.openDate);
    if (justStarted && live) {
      notifyLiveStart(channelName(channelId), live.liveTitle);
      panes
        .get(channelId)
        ?.chat.addSystem(`🔴 방송이 시작되었습니다: ${live.liveTitle}`);
    }
    renderChannelList();
  },
  onLogPower: (channelId, value) => {
    // 값이 달라졌을 때만 기록하고, 늘었으면 창에 알려 준다
    void recordLogPower(channelId, value).then((delta) => {
      panes.get(channelId)?.setLogPower(value, delta);
      if (delta && delta > 0) {
        panes
          .get(channelId)
          ?.chat.addSystem(
            `통나무 파워 +${delta.toLocaleString("ko-KR")} (${value.toLocaleString("ko-KR")})`,
          );
      }
    });
  },
});

// ---------- 알림 ----------

async function initNotifications(): Promise<void> {
  notifyGranted = await isPermissionGranted();
  if (!notifyGranted) {
    notifyGranted = (await requestPermission()) === "granted";
  }
}

function notifyLiveStart(name: string, title: string): void {
  if (!notifyGranted || !getSettings().notifyLive) return;
  sendNotification({ title: `${name} 방송 시작`, body: title || "방송이 시작되었습니다." });
}

// ---------- 채널 목록 ----------

/** 방송 시작 시각을 남긴다 ("최신순" 정렬용) */
function markChannelLive(channelId: string, openDate: string | null): void {
  // openDate는 "YYYY-MM-DD HH:mm:ss" (KST)
  const started = openDate ? new Date(openDate.replace(" ", "T")).getTime() : NaN;
  const openAt = Number.isFinite(started) ? started : Date.now();
  const channels = getChannels();
  const ch = channels.find((c) => c.channelId === channelId);
  if (!ch || ch.lastOpenAt === openAt) return;
  ch.lastOpenAt = openAt;
  saveChannels(channels);
}

/** 채널별 마지막 채팅 시각 — 방송 기록이 없는 채널의 "최신순" 대용 */
let lastActivity = new Map<string, number>();

async function loadLastActivity(): Promise<void> {
  lastActivity = await getChannelLastActivity().catch(() => new Map());
}

function orderedChannels(): SavedChannel[] {
  return sortChannels(getChannels(), getSettings().channelOrder, {
    isLive: (id) => collector.isLive(id),
    lastActivity: (id) => lastActivity.get(id) ?? 0,
  });
}

function renderChannelList(): void {
  const listEl = document.getElementById("channel-list")!;
  const order = getSettings().channelOrder;
  listEl.innerHTML = "";
  for (const ch of orderedChannels()) {
    const li = document.createElement("li");
    li.className = panes.has(ch.channelId) ? "channel active" : "channel";
    li.dataset.channelId = ch.channelId;
    // 창 영역으로 끌어다 놓을 수 있어야 하므로 항상 드래그 가능
    li.draggable = true;
    const img = ch.imageUrl
      ? `<img src="${escapeHtml(ch.imageUrl)}" alt="" loading="lazy">`
      : `<span class="channel-noimg"></span>`;
    const live = collector.isLive(ch.channelId) ? `<span class="dot"></span>` : "";
    // 수집 중(연결됨) 표시 — 보고 있지 않아도 채팅이 쌓이고 있음을 알린다
    const rec =
      collector.getStatus(ch.channelId) === "connected"
        ? `<span class="rec" title="채팅 수집 중">●</span>`
        : "";
    // 이름이 잘리므로 전체 이름과 채널 ID를 툴팁으로 보여준다
    const shown = displayName(ch);
    li.title =
      (ch.alias ? `${shown} (원래 이름: ${ch.name})` : shown) +
      `\n${ch.channelId}` +
      "\n오른쪽으로 끌어다 놓으면 나란히 볼 수 있습니다" +
      (order === "manual" ? "\n목록 안에서 끌면 순서가 바뀝니다" : "");
    li.innerHTML = `${img}<span class="channel-name">${escapeHtml(shown)}</span>${rec}${live}<button class="channel-remove" title="삭제">×</button>`;
    li.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).classList.contains("channel-remove")) {
        void removeChannel(ch.channelId);
      } else {
        // Ctrl(⌘)을 누르면 옆에 나란히, 그냥 누르면 상황에 맞게
        // (창이 하나면 바꿔 열고, 여럿이면 팝업으로 띄운다)
        void openChannel(ch.channelId, e.ctrlKey || e.metaKey ? "add" : "auto");
      }
    });
    li.addEventListener("auxclick", (e) => {
      if (e.button === 1) void openChannel(ch.channelId, "add");
    });
    li.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openChannelMenu(ch.channelId, e.clientX, e.clientY);
    });
    listEl.appendChild(li);
  }
}

// ---------- 채널 순서 ----------

/** 드래그 중인 채널 ID */
let dragChannelId: string | null = null;

function syncOrderButtons(): void {
  const order = getSettings().channelOrder;
  for (const btn of document.querySelectorAll<HTMLButtonElement>(
    "#channel-order button",
  )) {
    btn.classList.toggle("active", btn.dataset.order === order);
  }
}

function initChannelOrder(): void {
  for (const btn of document.querySelectorAll<HTMLButtonElement>(
    "#channel-order button",
  )) {
    btn.addEventListener("click", () => {
      saveSettings({ channelOrder: btn.dataset.order as ChannelOrder });
      syncOrderButtons();
      renderChannelList();
    });
  }
  syncOrderButtons();

  const listEl = document.getElementById("channel-list")!;

  listEl.addEventListener("dragstart", (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>(".channel");
    if (!li?.dataset.channelId) return;
    dragChannelId = li.dataset.channelId;
    li.classList.add("dragging");
    e.dataTransfer?.setData("text/plain", dragChannelId);
  });

  listEl.addEventListener("dragend", () => {
    dragChannelId = null;
    for (const el of listEl.querySelectorAll(".drop-target, .dragging")) {
      el.classList.remove("drop-target", "dragging");
    }
  });

  listEl.addEventListener("dragover", (e) => {
    if (!dragChannelId) return;
    e.preventDefault();
    const li = (e.target as HTMLElement).closest<HTMLElement>(".channel");
    for (const el of listEl.querySelectorAll(".drop-target")) {
      el.classList.remove("drop-target");
    }
    li?.classList.add("drop-target");
  });

  listEl.addEventListener("drop", (e) => {
    e.preventDefault();
    const li = (e.target as HTMLElement).closest<HTMLElement>(".channel");
    const target = li?.dataset.channelId;
    const moved = dragChannelId;
    dragChannelId = null;
    if (!moved || !target || moved === target) {
      renderChannelList();
      return;
    }
    if (getSettings().channelOrder !== "manual") {
      notify("순서를 바꾸려면 목록 위의 «직접정렬»을 골라 주세요.");
      return;
    }
    const channels = getChannels();
    const from = channels.findIndex((c) => c.channelId === moved);
    const to = channels.findIndex((c) => c.channelId === target);
    if (from < 0 || to < 0) return;
    const [item] = channels.splice(from, 1);
    channels.splice(to, 0, item);
    saveChannels(channels);
    renderChannelList();
  });
}

// ---------- 채널 우클릭 메뉴 ----------

let menuChannelId: string | null = null;

function openChannelMenu(channelId: string, x: number, y: number): void {
  const menu = document.getElementById("channel-menu")!;
  menuChannelId = channelId;
  const ch = getChannels().find((c) => c.channelId === channelId);
  // 별명이 없으면 "원래 이름으로" 항목은 숨긴다
  menu
    .querySelector<HTMLElement>('[data-action="reset-name"]')!
    .classList.toggle("hidden", !ch?.alias);
  // 순서 옮기기는 직접정렬일 때만 의미가 있다
  const manual = getSettings().channelOrder === "manual";
  for (const action of ["move-up", "move-down"]) {
    menu
      .querySelector<HTMLElement>(`[data-action="${action}"]`)!
      .classList.toggle("hidden", !manual);
  }

  menu.classList.remove("hidden");
  // 화면 밖으로 나가지 않게 위치 보정
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
}

function closeChannelMenu(): void {
  document.getElementById("channel-menu")!.classList.add("hidden");
  menuChannelId = null;
}

function initChannelMenu(): void {
  const menu = document.getElementById("channel-menu")!;
  menu.addEventListener("click", (e) => {
    const action = (e.target as HTMLElement).closest<HTMLElement>("[data-action]")
      ?.dataset.action;
    const channelId = menuChannelId;
    closeChannelMenu();
    if (!action || !channelId) return;

    const url = `https://chzzk.naver.com/live/${channelId}`;
    switch (action) {
      case "show":
        void openChannel(channelId, "replace");
        break;
      case "add-pane":
        void openChannel(channelId, "add");
        break;
      case "popup":
        void openChannel(channelId, "popup");
        break;
      case "open":
        invoke("open_url", { url }).catch((err) =>
          notify(`채널을 열지 못했습니다: ${err}`),
        );
        break;
      case "copy":
        navigator.clipboard
          .writeText(url)
          .then(() => notify(`채널 링크를 복사했습니다: ${url}`))
          .catch(() => notify(`링크 복사에 실패했습니다: ${url}`));
        break;
      case "rename":
        openRenameDialog(channelId);
        break;
      case "reset-name":
        setChannelAlias(channelId, "");
        break;
      case "move-up":
        moveChannel(channelId, -1);
        break;
      case "move-down":
        moveChannel(channelId, 1);
        break;
      case "remove":
        void removeChannel(channelId);
        break;
    }
  });
  // 바깥을 누르거나 ESC로 닫기
  window.addEventListener("click", (e) => {
    if (!menu.contains(e.target as Node)) closeChannelMenu();
  });
  window.addEventListener("blur", closeChannelMenu);
}

/** 우클릭 메뉴로 한 칸씩 옮기기 (드래그가 어려울 때의 대안) */
function moveChannel(channelId: string, delta: number): void {
  const channels = getChannels();
  const from = channels.findIndex((c) => c.channelId === channelId);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= channels.length) return;
  const [item] = channels.splice(from, 1);
  channels.splice(to, 0, item);
  saveChannels(channels);
  renderChannelList();
}

function setChannelAlias(channelId: string, alias: string): void {
  const channels = getChannels().map((c) =>
    c.channelId === channelId ? { ...c, alias: alias.trim() || undefined } : c,
  );
  saveChannels(channels);
  renderChannelList();
  const ch = getChannels().find((c) => c.channelId === channelId);
  if (ch) panes.get(channelId)?.dash.setName(displayName(ch));
}

function initRenameDialog(): void {
  const dialog = document.getElementById("rename-modal") as HTMLDialogElement;
  const input = document.getElementById("rename-input") as HTMLInputElement;
  const save = () => {
    if (renameChannelId) setChannelAlias(renameChannelId, input.value);
    dialog.close();
  };
  document.getElementById("rename-close")!.addEventListener("click", () =>
    dialog.close(),
  );
  document.getElementById("rename-save")!.addEventListener("click", save);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") save();
  });
}

let renameChannelId: string | null = null;

function openRenameDialog(channelId: string): void {
  const dialog = document.getElementById("rename-modal") as HTMLDialogElement;
  const input = document.getElementById("rename-input") as HTMLInputElement;
  const ch = getChannels().find((c) => c.channelId === channelId);
  renameChannelId = channelId;
  input.value = ch?.alias ?? "";
  input.placeholder = ch?.name ?? "채널 이름";
  dialog.showModal();
  input.focus();
  input.select();
}

async function removeChannel(channelId: string): Promise<void> {
  saveChannels(getChannels().filter((c) => c.channelId !== channelId));
  await collector.drop(channelId);
  closePane(channelId, true);
  renderChannelList();
}

async function addChannel(input: string): Promise<void> {
  const channelId = parseChannelInput(input);
  if (!channelId) {
    notify("채널 URL 또는 32자리 채널 ID를 입력해 주세요.");
    return;
  }
  const channels = getChannels();
  if (!channels.some((c) => c.channelId === channelId)) {
    const info = await getChannelInfo(channelId);
    channels.push({
      channelId,
      name: info.channelName,
      imageUrl: info.channelImageUrl,
    } satisfies SavedChannel);
    saveChannels(channels);
    noteChannelName(channelId, info.channelName, info.channelImageUrl);
  }
  renderChannelList();
  await collector.syncChannel(channelId);
  await openChannel(channelId, "replace");
}

// ---------- 채널 창 ----------

/** 지금 열려 있는 창들 (채널 ID → 창) */
const panes = new Map<string, ChannelPane>();
/** 마지막으로 만진 창 — 안내 메시지를 여기에 띄운다 */
let focusedChannelId: string | null = null;

const panesEl = document.getElementById("panes")!;
const panesEmptyEl = document.getElementById("panes-empty")!;
const floatLayerEl = document.getElementById("pane-float-layer")!;

/**
 * 창을 어떤 식으로 열지.
 * - replace: 다른 창을 닫고 이 채널만
 * - add: 오른쪽에 나란히 붙이기
 * - popup: 화면 위에 띄우기 (옮길 수 있는 작은 창)
 * - auto: 열린 창이 하나뿐이면 replace, 여럿이면 popup
 */
type OpenMode = "replace" | "add" | "popup" | "auto";

function layoutName(): string {
  return { columns: "세로분할", rows: "가로분할", grid: "격자" }[
    getSettings().paneLayout
  ];
}

/** 열린 창 목록을 저장해 다음 실행 때 그대로 복원한다 */
function saveOpenChannels(): void {
  // 띄워 둔 팝업은 임시로 보는 것이라 복원 목록에 넣지 않는다.
  // 순서는 화면에 놓인 순서를 그대로 따른다 (드래그로 바꾼 순서).
  const docked = [...panesEl.querySelectorAll<HTMLElement>(".pane")]
    .map((el) => el.dataset.channelId!)
    .filter((id) => id && !panes.get(id)?.floating);
  saveSettings({ openChannels: docked });
  collector.viewing = new Set(panes.keys());
}

async function openChannel(channelId: string, mode: OpenMode): Promise<void> {
  const dockedCount = [...panes.values()].filter((p) => !p.floating).length;
  const resolved: Exclude<OpenMode, "auto"> =
    mode !== "auto" ? mode : dockedCount > 1 ? "popup" : "replace";

  if (resolved === "replace") {
    for (const id of [...panes.keys()]) {
      if (id !== channelId) closePane(id, false);
    }
  }
  // 붙일 자리가 없으면 팝업으로 띄운다
  if (
    resolved === "add" &&
    !panes.has(channelId) &&
    dockedPaneCount() >= paneLimit()
  ) {
    notify(
      `${layoutName()} 배치에서는 창을 ${paneLimit()}개까지 붙일 수 있어 팝업으로 띄웁니다.`,
    );
    return openChannel(channelId, "popup");
  }
  const existing = panes.get(channelId);
  if (existing) {
    setFocusedPane(channelId);
    existing.el.scrollIntoView({ behavior: "smooth", inline: "nearest" });
    // 다른 창을 닫았다면 그 결과도 저장해 둔다
    if (resolved === "replace") {
      saveOpenChannels();
      renderChannelList();
    }
    return;
  }

  const floating = resolved === "popup";
  const pane = new ChannelPane(channelId, paneCallbacks, floating);
  panes.set(channelId, pane);
  if (floating) {
    pane.placeAt([...panes.values()].filter((p) => p.floating).length - 1);
    floatLayerEl.appendChild(pane.el);
  } else {
    panesEl.appendChild(pane.el);
  }
  pane.applyStyle(getSettings().paneStyles[channelId]);
  panesEmptyEl.classList.toggle("hidden", dockedPaneCount() > 0);
  applyPaneLayout();
  setFocusedPane(channelId);
  saveOpenChannels();
  renderChannelList();

  const info = getChannels().find((c) => c.channelId === channelId);
  pane.dash.setChannel({
    channelId,
    channelName: info ? displayName(info) : channelName(channelId),
    channelImageUrl: info?.imageUrl ?? null,
    followerCount: 0,
  });
  pane.dash.update(collector.getLive(channelId));
  pane.setMyProfileImage(loginProfileImage);
  const power = collector.getLogPower(channelId);
  if (power !== null) pane.setLogPower(power, null);
  else {
    // 아직 안 읽었으면 지난번에 확인해 둔 값을 먼저 보여 준다
    void getLatestLogPower(channelId).then((p) => {
      if (p) panes.get(channelId)?.setLogPower(p.value, null);
    });
  }
  renderPaneStatus(channelId);

  // 수집해 둔 최근 대화를 먼저 보여준다
  const recent = await getRecentMessages(channelId, 200);
  if (!panes.has(channelId)) return; // 불러오는 사이에 닫혔다
  for (const row of recent) pane.chat.addStored(row);
  if (recent.length > 0) pane.chat.addSystem("─── 저장된 최근 대화 ───");

  await collector.syncChannel(channelId).catch(() => {});
  renderPaneStatus(channelId);
  pane.scrollToLatest();
  scrollPanesToLatest();
}

const paneCallbacks = {
  onClose: (id: string) => closePane(id, true),
  onSend: (id: string, text: string) => void sendTo(id, text),
  // 통나무처럼, 창에서 누른 닉네임은 그 채널에서의 기록부터 보여준다
  onUserClick: (uid: string, nick: string, channelId: string) =>
    void userModal.open(uid, nick, false, channelId),
  onUserContext: (
    uid: string,
    nick: string,
    channelId: string,
    x: number,
    y: number,
  ) => openUserMenu(uid, nick, channelId, x, y),
  onFocus: (id: string) => setFocusedPane(id),
  onStyle: (id: string) => openPaneStyle(id),
  onOpenLive: (id: string) => openChannelPage(id),
  onDock: (id: string) => void dockPane(id),
  onLogPowerHistory: (id: string) => void openLogPowerHistory(id),
  onPickBadge: (id: string) => void openBadgePicker(id),
};

/** 통나무 파워 창이 지금 보고 있는 채널 */
let powerChannelId: string | null = null;

/**
 * 보유 파워와 그동안의 획득 기록.
 * 값이 달라질 때마다 한 줄씩 남겨 둔 것을 최근 것부터 읽는다.
 */
async function openLogPowerHistory(channelId: string): Promise<void> {
  const dialog = document.getElementById("power-modal") as HTMLDialogElement;
  const listEl = document.getElementById("power-log")!;
  powerChannelId = channelId;
  document.getElementById("power-title")!.textContent =
    `${channelName(channelId)} — 통나무 파워`;
  document.getElementById("power-hold-icon")!.innerHTML = logPowerIcon(16);
  listEl.innerHTML = `<div class="history-empty">불러오는 중…</div>`;
  if (!dialog.open) dialog.showModal();

  await renderPowerModal(channelId);
}

async function renderPowerModal(channelId: string): Promise<void> {
  const points = await getLogPowerHistory(channelId).catch(() => []);
  if (powerChannelId !== channelId) return;

  const held =
    collector.getLogPower(channelId) ??
    (points.length > 0 ? points[points.length - 1].value : null);
  document.getElementById("power-hold-value")!.textContent =
    held === null ? "–" : formatNumber(held);
  renderLogPowerHistory(points);
}

function renderLogPowerHistory(points: LogPowerPoint[]): void {
  const listEl = document.getElementById("power-log")!;
  if (points.length === 0) {
    listEl.innerHTML = `<div class="history-empty">아직 남은 기록이 없습니다.</div>`;
    return;
  }

  // 첫 줄은 그때까지 모아 둔 값이라 늘어난 몫을 알 수 없다
  const deltas = points.map((p, i) => (i === 0 ? null : p.value - points[i - 1].value));
  const gained = deltas.reduce<number>((sum, d) => (d && d > 0 ? sum + d : sum), 0);

  const rows = points
    .map((p, i) => {
      const d = deltas[i];
      const delta =
        d === null
          ? `<span class="power-row-delta">처음 확인</span>`
          : d > 0
            ? `<span class="power-row-delta up">+${formatNumber(d)}</span>`
            : `<span class="power-row-delta down">${formatNumber(d)}</span>`;
      return (
        `<div class="power-row">` +
        `<span class="power-row-time">${formatDateTime(p.checked_at)}</span>` +
        delta +
        `<span class="power-row-value">${formatNumber(p.value)}</span>` +
        `</div>`
      );
    })
    .reverse()
    .join("");

  listEl.innerHTML =
    `<div class="power-sum">` +
    `기록이 시작된 뒤 <strong>+${formatNumber(gained)}</strong>` +
    ` · ${points.length}번 변했습니다` +
    `</div>` +
    rows;
}

function initPowerModal(): void {
  const dialog = document.getElementById("power-modal") as HTMLDialogElement;
  document
    .getElementById("power-close")!
    .addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    powerChannelId = null;
  });

  const refreshBtn = document.getElementById("power-refresh") as HTMLButtonElement;
  refreshBtn.addEventListener("click", () => {
    const channelId = powerChannelId;
    if (!channelId) return;
    if (!hasAuth()) {
      notify("통나무 파워는 네이버 로그인 후에 확인할 수 있습니다.");
      return;
    }
    refreshBtn.disabled = true;
    void collector
      .refreshLogPower(channelId)
      .catch((e) => notify(`확인 실패: ${e}`))
      .then(async () => {
        panes.get(channelId)?.setLogPower(collector.getLogPower(channelId), null);
        if (powerChannelId === channelId) await renderPowerModal(channelId);
      })
      .finally(() => {
        refreshBtn.disabled = false;
      });
  });
}

function dockedPaneCount(): number {
  return [...panes.values()].filter((p) => !p.floating).length;
}

/** 띄워 둔 팝업을 오른쪽에 붙은 창으로 바꾼다 */
async function dockPane(channelId: string): Promise<void> {
  const pane = panes.get(channelId);
  if (!pane || !pane.floating) return;
  closePane(channelId, false);
  await openChannel(channelId, "add");
}

function closePane(channelId: string, persist: boolean): void {
  const pane = panes.get(channelId);
  if (!pane) return;
  pane.dispose();
  panes.delete(channelId);
  if (focusedChannelId === channelId) {
    focusedChannelId = panes.keys().next().value ?? null;
    if (focusedChannelId) panes.get(focusedChannelId)!.setFocused(true);
  }
  panesEmptyEl.classList.toggle("hidden", dockedPaneCount() > 0);
  applyPaneLayout();
  if (persist) {
    saveOpenChannels();
    renderChannelList();
  }
}

function openChannelPage(channelId: string): void {
  invoke("open_url", { url: `https://chzzk.naver.com/live/${channelId}` }).catch(
    (e) => notify(`채널을 열지 못했습니다: ${e}`),
  );
}

function setFocusedPane(channelId: string): void {
  if (focusedChannelId === channelId) return;
  focusedChannelId = channelId;
  for (const [id, pane] of panes) pane.setFocused(id === channelId);
}

/** 안내 메시지 — 포커스된 창이 있으면 그 창에, 없으면 토스트로 */
function notify(text: string): void {
  const pane = focusedChannelId ? panes.get(focusedChannelId) : undefined;
  if (pane) pane.chat.addSystem(text);
  else showToast(text);
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

function showToast(text: string): void {
  const el = document.getElementById("toast")!;
  el.textContent = text;
  el.classList.remove("hidden");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 4000);
}

async function sendTo(channelId: string, text: string): Promise<void> {
  try {
    await collector.sendChat(channelId, text);
  } catch (e) {
    panes
      .get(channelId)
      ?.chat.addSystem(
        `전송 실패: ${e instanceof Error ? e.message : String(e)}`,
      );
  }
}

function renderPaneStatus(channelId: string): void {
  const pane = panes.get(channelId);
  if (!pane) return;
  const status = collector.getStatus(channelId);
  const live = collector.getLive(channelId);
  let text: string;
  switch (status) {
    case "connected":
      text = collector.canSend(channelId)
        ? `연결됨 (${loginNickname ?? "로그인됨"})`
        : "연결됨 (읽기 전용)";
      break;
    case "connecting":
      text = "채팅 서버 연결 중…";
      break;
    case "reconnecting":
      text = "연결 끊김 — 재연결 중";
      break;
    default:
      text =
        live?.status === "OPEN"
          ? "채팅방 연결 대기 중…"
          : "오프라인 (방송이 시작되면 자동으로 수집합니다)";
  }
  pane.setStatus(text);

  const canSend = collector.canSend(channelId);
  pane.setSendEnabled(
    canSend,
    canSend
      ? "채팅 입력…"
      : hasAuth()
        ? "연결되면 채팅을 보낼 수 있습니다"
        : "채팅 전송은 설정에서 네이버 로그인 후 가능합니다 (읽기 전용)",
  );
}

function renderAllPaneStatus(): void {
  for (const id of panes.keys()) renderPaneStatus(id);
}

/** 창 머리글을 잡고 끌면 붙어 있는 창끼리 순서를 바꾼다 */
function initPaneReorder(): void {
  let dragging: string | null = null;

  panesEl.addEventListener("dragstart", (e) => {
    const head = (e.target as HTMLElement).closest<HTMLElement>(".pane-head");
    const pane = head?.closest<HTMLElement>(".pane");
    if (!pane?.dataset.channelId || pane.classList.contains("floating")) return;
    dragging = pane.dataset.channelId;
    pane.classList.add("dragging");
    e.dataTransfer?.setData("text/plain", dragging);
  });

  panesEl.addEventListener("dragend", () => {
    dragging = null;
    for (const el of panesEl.querySelectorAll(".dragging, .drop-target")) {
      el.classList.remove("dragging", "drop-target");
    }
  });

  panesEl.addEventListener("dragover", (e) => {
    if (!dragging) return;
    e.preventDefault();
    autoScrollPanes(e);
    const over = (e.target as HTMLElement).closest<HTMLElement>(".pane");
    for (const el of panesEl.querySelectorAll(".drop-target")) {
      el.classList.remove("drop-target");
    }
    if (over && over.dataset.channelId !== dragging) {
      over.classList.add("drop-target");
    }
  });

  panesEl.addEventListener("drop", (e) => {
    if (!dragging) return;
    e.preventDefault();
    e.stopPropagation();
    const over = (e.target as HTMLElement).closest<HTMLElement>(".pane");
    const moved = dragging;
    dragging = null;
    for (const el of panesEl.querySelectorAll(".drop-target")) {
      el.classList.remove("drop-target");
    }
    if (!over?.dataset.channelId || over.dataset.channelId === moved) return;

    const movedEl = panes.get(moved)?.el;
    if (!movedEl) return;
    // 끌어 온 창이 원래 뒤에 있었으면 앞에, 앞에 있었으면 뒤에 끼운다
    const before =
      movedEl.compareDocumentPosition(over) & Node.DOCUMENT_POSITION_FOLLOWING;
    over.insertAdjacentElement(before ? "afterend" : "beforebegin", movedEl);
    saveOpenChannels();
    scrollPanesToLatest();
  });
}

/**
 * 끌고 있는 동안 창 영역 가장자리에 가까워지면 저절로 밀어 준다.
 * 화면 밖으로 스크롤된 창까지 옮길 수 있어야 하므로 양쪽·위아래 모두 본다.
 */
function autoScrollPanes(e: DragEvent): void {
  const box = panesEl.getBoundingClientRect();
  const edge = 90;
  const step = 24;
  if (e.clientX < box.left + edge) panesEl.scrollLeft -= step;
  else if (e.clientX > box.right - edge) panesEl.scrollLeft += step;
  if (e.clientY < box.top + edge) panesEl.scrollTop -= step;
  else if (e.clientY > box.bottom - edge) panesEl.scrollTop += step;
}

/** 사이드바에서 창 영역으로 채널을 끌어다 놓으면 나란히 연다 */
function initPaneDrop(): void {
  panesEl.addEventListener("dragover", (e) => {
    if (!dragChannelId) return;
    e.preventDefault();
    autoScrollPanes(e);
    panesEl.classList.add("drop-here");
  });
  panesEl.addEventListener("dragleave", (e) => {
    if (e.target === panesEl) panesEl.classList.remove("drop-here");
  });
  panesEl.addEventListener("drop", (e) => {
    panesEl.classList.remove("drop-here");
    const id = dragChannelId;
    dragChannelId = null;
    if (!id) return;
    e.preventDefault();
    void openChannel(id, "add");
  });
}

// ---------- 설정 모달 ----------

function initSettingsModal(): void {
  const dialog = document.getElementById("settings-modal") as HTMLDialogElement;
  const autInput = document.getElementById("set-nid-aut") as HTMLInputElement;
  const sesInput = document.getElementById("set-nid-ses") as HTMLInputElement;
  const statusEl = document.getElementById("login-status")!;
  const logTxtInput = document.getElementById("set-log-txt") as HTMLInputElement;
  const loginBtn = document.getElementById("naver-login-btn") as HTMLButtonElement;
  const logoutBtn = document.getElementById("naver-logout-btn") as HTMLButtonElement;

  logTxtInput.checked = getSettings().logTxt;
  logTxtInput.addEventListener("change", () => {
    saveSettings({ logTxt: logTxtInput.checked });
    resetSessions();
  });

  // 로그 파일 형식 — 바꾸면 다음 기록부터 새 파일에 쌓인다
  const logFormatSel = document.getElementById("set-log-format") as HTMLSelectElement;
  logFormatSel.value = getSettings().logFormat;
  logFormatSel.addEventListener("change", () => {
    saveSettings({ logFormat: logFormatSel.value as LogFormat });
    resetSessions();
    notify(
      `로그를 ${logFormatSel.value === "csv" ? "csv" : "txt"} 형식으로 저장합니다.`,
    );
  });

  const notifyLiveInput = document.getElementById(
    "set-notify-live",
  ) as HTMLInputElement;
  notifyLiveInput.checked = getSettings().notifyLive;
  notifyLiveInput.addEventListener("change", () => {
    saveSettings({ notifyLive: notifyLiveInput.checked });
  });

  const collectAllInput = document.getElementById(
    "set-collect-all",
  ) as HTMLInputElement;
  collectAllInput.checked = getSettings().collectAll;
  collectAllInput.addEventListener("change", () => {
    saveSettings({ collectAll: collectAllInput.checked });
    notify(
      collectAllInput.checked
        ? "모든 등록 채널의 채팅을 수집합니다."
        : "지금 보고 있는 채널만 수집합니다.",
    );
    void collector.syncNow();
  });

  document.getElementById("frame-debug-btn")!.addEventListener("click", () => {
    if (!focusedChannelId || !collector.startFrameDebug(focusedChannelId)) {
      notify("⚠️ 진단하려면 먼저 채팅에 연결되어야 합니다.");
      return;
    }
    dialog.close();
    notify(
      "🔎 전송 진단을 시작했습니다. 지금 채팅을 보내 보세요 (15초간 원본 표시).",
    );
  });

  // txt 로그 저장 폴더
  const logDirInput = document.getElementById("set-log-dir") as HTMLInputElement;
  logDirInput.value = getSettings().logDir;
  void invoke<string>("get_default_log_dir")
    .then((d) => (logDirInput.placeholder = `(기본) ${d}`))
    .catch(() => {});
  logDirInput.addEventListener("change", () => {
    saveSettings({ logDir: logDirInput.value.trim() });
    resetSessions();
  });
  document.getElementById("log-dir-pick")!.addEventListener("click", async () => {
    const picked = await openDialog({
      directory: true,
      title: "txt 로그 저장 폴더 선택",
      defaultPath: getSettings().logDir || undefined,
    }).catch(() => null);
    if (typeof picked === "string" && picked) {
      logDirInput.value = picked;
      saveSettings({ logDir: picked });
      resetSessions();
    }
  });
  document.getElementById("log-dir-open")!.addEventListener("click", () => {
    invoke("open_log_dir", { baseDir: getSettings().logDir || null }).catch(
      (e) => notify(`폴더 열기 실패: ${e}`),
    );
  });

  // 채팅 DB 저장 폴더
  const dbDirInput = document.getElementById("set-db-dir") as HTMLInputElement;
  dbDirInput.value = getSettings().dbDir;
  void invoke<string>("get_default_db_path")
    .then((p) => (dbDirInput.placeholder = `(기본) ${p}`))
    .catch(() => {});

  /** 폴더를 바꾸면 지금 DB를 새 위치로 복사해 두고, 재시작 후 적용된다 */
  const applyDbDir = async (dir: string) => {
    const before = getSettings().dbDir;
    if (dir === before) return;
    try {
      const target = await invoke<string>("prepare_db_dir", {
        dir: dir || null,
        current: currentDbPath,
      });
      saveSettings({ dbDir: dir });
      dbDirInput.value = dir;
      notify(
        `DB 위치를 ${target} 으로 정했습니다. 앱을 다시 시작하면 적용됩니다.`,
      );
    } catch (e) {
      notify(`DB 폴더 변경 실패: ${e}`);
      dbDirInput.value = before;
    }
  };

  dbDirInput.addEventListener("change", () => {
    void applyDbDir(dbDirInput.value.trim());
  });
  document.getElementById("db-dir-pick")!.addEventListener("click", async () => {
    const picked = await openDialog({
      directory: true,
      title: "채팅 DB를 둘 폴더 선택",
      defaultPath: getSettings().dbDir || undefined,
    }).catch(() => null);
    if (typeof picked === "string" && picked) await applyDbDir(picked);
  });
  document.getElementById("db-dir-open")!.addEventListener("click", () => {
    invoke("open_dir", { path: currentDbPath }).catch((e) =>
      notify(`폴더 열기 실패: ${e}`),
    );
  });

  /** 로그인 상태에 따라 상태 문구/버튼 표시를 갱신 (닉네임 확인 포함) */
  const refreshStatus = async () => {
    if (!hasAuth()) {
      statusEl.textContent = "🔓 로그인되어 있지 않습니다 (읽기 전용)";
      loginBtn.textContent = "N 네이버 아이디로 로그인";
      logoutBtn.classList.add("hidden");
      return;
    }
    loginBtn.textContent = "다른 계정으로 다시 로그인";
    logoutBtn.classList.remove("hidden");
    statusEl.textContent = "로그인 정보 확인 중…";
    const user = await getUserStatus();
    statusEl.textContent = user
      ? `✅ ${user.nickname}님으로 로그인됨 — 채팅 전송 가능`
      : "⚠️ 로그인 정보가 만료되었거나 유효하지 않습니다. 다시 로그인해 주세요.";
  };

  document.getElementById("open-settings")!.addEventListener("click", () => {
    const s = getSettings();
    autInput.value = s.nidAut;
    sesInput.value = s.nidSes;
    void refreshStatus();
    dialog.showModal();
  });
  document.getElementById("settings-close")!.addEventListener("click", () => dialog.close());
  document.getElementById("settings-save")!.addEventListener("click", () => {
    saveSettings({ nidAut: autInput.value.trim(), nidSes: sesInput.value.trim() });
    void refreshStatus();
    dialog.close();
    applyAuthChange("설정이 저장되었습니다.");
  });

  loginBtn.addEventListener("click", async () => {
    statusEl.textContent = "로그인 창을 여는 중…";
    try {
      await invoke("naver_login");
      // 창이 떴다는 진행 알림이 오지 않으면 사용자가 원인을 알 수 있게 한다
      setTimeout(() => {
        if (statusEl.textContent === "로그인 창을 여는 중…") {
          statusEl.textContent =
            "로그인 창이 뜨지 않으면 다른 창 뒤에 가려졌는지 확인해 주세요. " +
            "계속 안 되면 아래 «수동 쿠키 입력»을 쓸 수 있습니다.";
        }
      }, 4000);
    } catch (e) {
      notify(`로그인 창을 열지 못했습니다: ${e}`);
      statusEl.textContent = `로그인 창을 열지 못했습니다: ${e}`;
    }
  });

  logoutBtn.addEventListener("click", () => {
    saveSettings({ nidAut: "", nidSes: "" });
    autInput.value = "";
    sesInput.value = "";
    void refreshStatus();
    // 로그인 창 웹뷰에 남은 네이버 세션도 정리
    invoke("naver_logout").catch(() => {});
    applyAuthChange("로그아웃되었습니다.");
  });

  // Rust 쪽 로그인 창에서 쿠키 확보 시
  void listen<{ nidAut: string; nidSes: string }>("naver-login-success", (e) => {
    const cur = getSettings();
    const changed =
      cur.nidAut !== e.payload.nidAut || cur.nidSes !== e.payload.nidSes;
    saveSettings({ nidAut: e.payload.nidAut, nidSes: e.payload.nidSes });
    autInput.value = e.payload.nidAut;
    sesInput.value = e.payload.nidSes;
    void refreshStatus();
    if (changed) applyAuthChange("네이버 로그인 완료!");
    // 같은 계정으로 다시 들어온 경우에도 아무 반응이 없으면 실패로 보이므로 알린다
    else notify("이미 같은 계정으로 로그인되어 있습니다.");
  });
  void listen("naver-login-cancelled", () => {
    notify("네이버 로그인이 취소되었습니다.");
  });
  // 로그인 창에서 쿠키를 찾는 중의 진행 상황 (문제 진단용)
  void listen<string>("naver-login-progress", (e) => {
    statusEl.textContent = e.payload;
    notify(e.payload);
  });

  void refreshStatus();
}

/** 로그인 상태 변경을 반영 — 모든 채널을 새 권한으로 다시 연결 */
function applyAuthChange(message: string): void {
  notify(message);
  void refreshLoginNickname();
  void collector
    .reauth()
    .then(() => renderAllPaneStatus())
    .catch((e) => notify(`재접속 실패: ${e}`));
}

// ---------- 내 프로필 · 뱃지 고르기 ----------

let badgeChannelId: string | null = null;
let badgeChatId: string | null = null;
/** 이 채널에서 쓰는 내 닉네임 (미리보기에 쓴다) */
let badgeNickname = "";
let badgeList: ChzzkBadge[] = [];
const badgeOn = new Set<string>();
/** 저장 요청이 겹치지 않도록 — 저장 중이면 마지막 상태만 한 번 더 보낸다 */
let badgeSaving = false;
let badgeQueued = false;

/**
 * 이 채널에서의 내 프로필.
 * 치지직 웹이 프로필을 열 때와 같은 조회로 팔로우 시작일·뱃지를 읽고,
 * 뱃지를 켜고 끄면 웹과 같은 요청으로 바로 저장한다.
 *
 * 채팅방 ID는 방송이 켜져 있어야만 알 수 있는 값이 아니다 — 붙어 있는
 * 연결에서, 없으면 이번 실행 중 확인해 둔 것에서, 그것도 없으면 상세
 * 조회를 한 번 해서 얻는다. 그래서 방송이 꺼져 있어도 바꿀 수 있다.
 */
async function openBadgePicker(channelId: string): Promise<void> {
  const dialog = document.getElementById("badge-modal") as HTMLDialogElement;
  const listEl = document.getElementById("badge-list")!;
  const uid = collector.getMyUid();

  if (!hasAuth() || !uid) {
    notify("뱃지를 바꾸려면 네이버 로그인이 필요합니다.");
    return;
  }

  badgeChannelId = channelId;
  badgeChatId = null;
  badgeList = [];
  badgeOn.clear();
  document.getElementById("badge-title")!.textContent =
    `${channelName(channelId)} — 사용 중인 프로필`;
  document.getElementById("badge-state")!.textContent = "";
  document.getElementById("badge-power-icon")!.innerHTML = logPowerIcon(14);
  setBadgeProfile(loginNickname, loginProfileImage, null);
  renderBadgePower(channelId);
  document.getElementById("badge-preview")!.innerHTML = "";
  listEl.innerHTML = `<div class="history-empty">불러오는 중…</div>`;
  if (!dialog.open) dialog.showModal();

  const chatChannelId = await resolveChatChannelId(channelId);
  if (badgeChannelId !== channelId) return;
  if (!chatChannelId) {
    listEl.innerHTML =
      `<div class="history-empty">이 채널의 채팅방을 찾지 못했습니다. 방송이 한 번 켜진 뒤에 다시 시도해 주세요.</div>`;
    return;
  }
  badgeChatId = chatChannelId;

  const card = await getMyProfileCard(chatChannelId, uid).catch(() => null);
  if (badgeChannelId !== channelId) return;
  if (!card) {
    listEl.innerHTML =
      `<div class="history-empty">프로필을 불러오지 못했습니다.</div>`;
    return;
  }

  setBadgeProfile(
    card.nickname || loginNickname,
    card.profileImageUrl ?? loginProfileImage,
    card.followDate,
  );
  badgeList = card.badges;
  for (const b of badgeList) if (b.activated) badgeOn.add(b.badgeId);
  renderBadges();
}

/** 붙어 있는 연결 → 확인해 둔 값 → 상세 조회 순으로 채팅방 ID를 찾는다 */
async function resolveChatChannelId(channelId: string): Promise<string | null> {
  const known = collector.getKnownChatChannelId(channelId);
  if (known) return known;
  const detail = await getLiveDetail(channelId).catch(() => null);
  return detail?.chatChannelId ?? null;
}

function setBadgeProfile(
  nickname: string | null,
  imageUrl: string | null,
  followDate: string | null,
): void {
  const img = document.getElementById("badge-avatar") as HTMLImageElement;
  const noimg = document.getElementById("badge-avatar-noimg")!;
  img.classList.toggle("hidden", !imageUrl);
  noimg.classList.toggle("hidden", !!imageUrl);
  if (imageUrl) img.src = imageUrl;
  badgeNickname = nickname ?? "";
  document.getElementById("badge-nick")!.textContent = badgeNickname;

  const followEl = document.getElementById("badge-follow")!;
  const day = followDate?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  followEl.classList.toggle("hidden", !day);
  if (day) {
    followEl.textContent =
      `♥ ${day[1]}년 ${Number(day[2])}월 ${Number(day[3])}일 부터 팔로우`;
  }
}

function renderBadgePower(channelId: string): void {
  const value = collector.getLogPower(channelId);
  const el = document.getElementById("badge-power-value")!;
  el.textContent = value === null ? "–" : formatNumber(value);
  if (value === null) {
    void getLatestLogPower(channelId).then((p) => {
      if (p && badgeChannelId === channelId) el.textContent = formatNumber(p.value);
    });
  }
}

/**
 * 뱃지 목록. 치지직은 여러 개를 함께 달 수 있어, 누를 때마다
 * 켜고 끄기만 하고 창은 열어 둔다.
 */
function renderBadges(): void {
  const listEl = document.getElementById("badge-list")!;
  if (badgeList.length === 0) {
    listEl.innerHTML =
      `<div class="history-empty">이 채널에서 쓸 수 있는 뱃지가 없습니다.</div>`;
    renderBadgePreview();
    return;
  }
  listEl.innerHTML = badgeList
    .map((b) => {
      const on = badgeOn.has(b.badgeId);
      return (
        `<button class="badge-choice${on ? " active" : ""}" data-badge="${escapeHtml(b.badgeId)}"` +
        ` title="${escapeHtml(b.badgeId)}" aria-pressed="${on}">` +
        badgeFaceHtml(b) +
        `<span class="badge-choice-name">${escapeHtml(b.title)}</span>` +
        (on ? `<span class="badge-check">✓</span>` : "") +
        `</button>`
      );
    })
    .join("");
  renderBadgePreview();
}

function badgeFaceHtml(b: ChzzkBadge): string {
  return b.imageUrl
    ? `<img src="${escapeHtml(b.imageUrl)}" alt="" loading="lazy">`
    : `<span class="badge-noimg">?</span>`;
}

/** 고른 뱃지를 달면 채팅에 어떻게 보일지 */
function renderBadgePreview(): void {
  const el = document.getElementById("badge-preview")!;
  const nick = badgeNickname || loginNickname || "나";
  const uid = collector.getMyUid() ?? "";
  const badges = badgeList
    .filter((b) => badgeOn.has(b.badgeId))
    .map((b) => `<span class="badge-preview-icon">${badgeFaceHtml(b)}</span>`)
    .join("");
  el.innerHTML =
    badges +
    `<span class="badge-preview-nick" style="color:${nickColor(uid)}">${escapeHtml(nick)}</span>`;
}

/**
 * 지금 켜 둔 뱃지를 치지직에 저장한다.
 * 빠르게 여러 번 눌러도 요청이 겹치지 않도록, 저장 중에는 마지막
 * 상태만 한 번 더 보낸다.
 */
async function saveBadges(): Promise<void> {
  const stateEl = document.getElementById("badge-state")!;
  if (badgeSaving) {
    badgeQueued = true;
    return;
  }
  badgeSaving = true;
  try {
    do {
      badgeQueued = false;
      const channelId = badgeChannelId;
      const chatChannelId = badgeChatId;
      if (!channelId || !chatChannelId) return;
      const ids = [...badgeOn];
      stateEl.textContent = "저장 중…";
      await activateBadges(chatChannelId, channelId, ids);
      stateEl.textContent =
        ids.length > 0
          ? "저장했습니다 · 다음 채팅부터 보입니다"
          : "뱃지를 떼었습니다";
    } while (badgeQueued);
  } catch (e) {
    stateEl.textContent = `저장 실패: ${e}`;
  } finally {
    badgeSaving = false;
  }
}

function initBadgeModal(): void {
  const dialog = document.getElementById("badge-modal") as HTMLDialogElement;
  document
    .getElementById("badge-close")!
    .addEventListener("click", () => dialog.close());
  // Esc로 닫는 경우도 있어 정리는 close에서 한다
  dialog.addEventListener("close", () => {
    badgeChannelId = null;
    badgeChatId = null;
  });

  document.getElementById("badge-list")!.addEventListener("click", (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>("[data-badge]")
      ?.dataset.badge;
    if (!id || !badgeChatId) return;
    if (badgeOn.has(id)) badgeOn.delete(id);
    else badgeOn.add(id);
    renderBadges();
    void saveBadges();
  });

  document.getElementById("badge-clear")!.addEventListener("click", () => {
    if (!badgeChatId || badgeOn.size === 0) return;
    badgeOn.clear();
    renderBadges();
    void saveBadges();
  });

  // 프로필의 통나무 파워 줄을 누르면 그 채널의 파워 창으로 넘어간다
  document.getElementById("badge-power")!.addEventListener("click", () => {
    if (badgeChannelId) void openLogPowerHistory(badgeChannelId);
  });
}

// ---------- 창 배치 ----------

/**
 * 배치별로 붙여 둘 수 있는 창 수.
 * 가로분할은 위아래로 쌓아 3개가 넘으면 한 창이 너무 납작해지고,
 * 격자는 5×2(또는 2×5)인 10개까지 본다. 세로분할은 제한을 두지 않는다.
 */
const PANE_LIMIT: Record<PaneLayout, number> = {
  columns: 99,
  rows: 3,
  grid: 10,
};

function paneLimit(): number {
  return PANE_LIMIT[getSettings().paneLayout];
}

function applyPaneLayout(): void {
  const layout = getSettings().paneLayout;
  panesEl.classList.remove("layout-columns", "layout-rows", "layout-grid");
  panesEl.classList.add(`layout-${layout}`);

  // 격자는 창 수와 화면 비율에 맞춰 열 수를 정한다.
  // 가로로 넓으면 5열까지 늘리고, 세로로 긴 화면에서는 열을 줄여
  // 2×5처럼 세워서도 쓸 수 있게 한다.
  const n = Math.max(1, dockedPaneCount());
  const box = panesEl.getBoundingClientRect();
  const ratio = box.height > 0 ? box.width / box.height : 1.6;
  const cols = Math.min(5, Math.max(1, Math.round(Math.sqrt(n * ratio))));
  panesEl.style.setProperty("--cols", String(cols));

  for (const btn of document.querySelectorAll<HTMLButtonElement>(
    "#pane-layout button",
  )) {
    btn.classList.toggle("active", btn.dataset.layout === layout);
  }
}

/** 배치가 바뀌면 창 높이가 달라지므로 모두 최신 채팅으로 내린다 */
function scrollPanesToLatest(): void {
  requestAnimationFrame(() => {
    for (const pane of panes.values()) pane.scrollToLatest();
  });
}

function initPaneLayout(): void {
  for (const btn of document.querySelectorAll<HTMLButtonElement>(
    "#pane-layout button",
  )) {
    btn.addEventListener("click", () => {
      saveSettings({ paneLayout: btn.dataset.layout as PaneLayout });
      applyPaneLayout();
      scrollPanesToLatest();
    });
  }
  applyPaneLayout();
  // 창 크기가 바뀌면 격자 열 수도 다시 계산한다
  window.addEventListener("resize", () => applyPaneLayout());
}

// ---------- 유저 우클릭 메뉴 (메모 · 강조 · 차단) ----------

/** 지금 메뉴가 가리키는 유저 */
let menuUser: { uid: string; nick: string; channelId: string } | null = null;

function openUserMenu(
  uid: string,
  nick: string,
  channelId: string,
  x: number,
  y: number,
): void {
  const menu = document.getElementById("user-menu")!;
  menuUser = { uid, nick, channelId };
  const blocked = blockedChannels(uid);
  menu
    .querySelector<HTMLElement>('[data-action="unblock"]')!
    .classList.toggle("hidden", blocked.length === 0);
  menu
    .querySelector<HTMLElement>('[data-action="block-channel"]')!
    .classList.toggle("hidden", blocked.includes(channelId) || blocked.includes(""));
  menu
    .querySelector<HTMLElement>('[data-action="block-all"]')!
    .classList.toggle("hidden", blocked.includes(""));

  menu.classList.remove("hidden");
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
}

function closeUserMenu(): void {
  document.getElementById("user-menu")!.classList.add("hidden");
  menuUser = null;
}

function initUserMenu(): void {
  const menu = document.getElementById("user-menu")!;
  menu.addEventListener("click", (e) => {
    const action = (e.target as HTMLElement).closest<HTMLElement>("[data-action]")
      ?.dataset.action;
    const target = menuUser;
    closeUserMenu();
    if (!action || !target) return;
    const { uid, nick, channelId } = target;

    switch (action) {
      case "history":
        void userModal.open(uid, nick);
        break;
      case "donations":
        void userModal.open(uid, nick, true);
        break;
      case "note":
        openNoteDialog(uid, nick);
        break;
      case "highlight":
        openHighlightDialog(uid, nick);
        break;
      case "block-channel":
        void block(uid, channelId, nick).then(() =>
          notify(`${nick} 님을 ${channelName(channelId)} 채널에서 차단했습니다.`),
        );
        break;
      case "block-all":
        void block(uid, "", nick).then(() =>
          notify(`${nick} 님을 모든 채널에서 차단했습니다.`),
        );
        break;
      case "unblock":
        void Promise.all(
          blockedChannels(uid).map((c) => unblock(uid, c)),
        ).then(() => notify(`${nick} 님의 차단을 해제했습니다.`));
        break;
    }
  });
  window.addEventListener("click", (e) => {
    if (!menu.contains(e.target as Node)) closeUserMenu();
  });
  window.addEventListener("blur", closeUserMenu);
}

// ---------- 메모 ----------

let noteUser: { uid: string; nick: string } | null = null;

function openNoteDialog(uid: string, nick: string): void {
  const dialog = document.getElementById("note-modal") as HTMLDialogElement;
  const input = document.getElementById("note-input") as HTMLTextAreaElement;
  noteUser = { uid, nick };
  document.getElementById("note-title")!.textContent = `${nick} 메모`;
  input.value = noteOf(uid);
  dialog.showModal();
  input.focus();
}

function initNoteDialog(): void {
  const dialog = document.getElementById("note-modal") as HTMLDialogElement;
  const input = document.getElementById("note-input") as HTMLTextAreaElement;
  const save = (text: string) => {
    if (noteUser) void setMark(noteUser.uid, noteUser.nick, { note: text });
    dialog.close();
  };
  document
    .getElementById("note-close")!
    .addEventListener("click", () => dialog.close());
  document
    .getElementById("note-save")!
    .addEventListener("click", () => save(input.value.trim()));
  document.getElementById("note-clear")!.addEventListener("click", () => save(""));
}

// ---------- 강조 색 ----------

const MARK_COLORS = [
  "#ff6b6b", "#ff9f43", "#ffd93d", "#6bcB77", "#4dd4c4",
  "#4d9fff", "#9b7bff", "#ff7bd5", "#b0bec5", "#ffffff",
];

let highlightUser: { uid: string; nick: string } | null = null;

function openHighlightDialog(uid: string, nick: string): void {
  const dialog = document.getElementById("highlight-modal") as HTMLDialogElement;
  const picker = document.getElementById("highlight-color") as HTMLInputElement;
  highlightUser = { uid, nick };
  document.getElementById("highlight-title")!.textContent = `${nick} 강조 표시`;
  const cur = highlightOf(uid);
  if (cur) picker.value = cur;
  const swatches = document.getElementById("highlight-swatches")!;
  swatches.innerHTML = MARK_COLORS.map(
    (c) =>
      `<button class="swatch${c === cur ? " active" : ""}" data-color="${c}" style="background:${c}" title="${c}"></button>`,
  ).join("");
  dialog.showModal();
}

function initHighlightDialog(): void {
  const dialog = document.getElementById("highlight-modal") as HTMLDialogElement;
  const picker = document.getElementById("highlight-color") as HTMLInputElement;
  const apply = (color: string) => {
    if (highlightUser) {
      void setMark(highlightUser.uid, highlightUser.nick, { highlight: color });
    }
    dialog.close();
  };
  document
    .getElementById("highlight-close")!
    .addEventListener("click", () => dialog.close());
  document
    .getElementById("highlight-swatches")!
    .addEventListener("click", (e) => {
      const c = (e.target as HTMLElement).closest<HTMLElement>("[data-color]")
        ?.dataset.color;
      if (c) apply(c);
    });
  picker.addEventListener("change", () => apply(picker.value));
  document
    .getElementById("highlight-clear")!
    .addEventListener("click", () => apply(""));
}

// ---------- 창 색 ----------

/** 프리셋 배경색 — 앱 기본 창 배경(--bg-card, rgb 20 22 27)과 같게 둔다 */
const PRESET_BG = "#14161b";

/** 미리 준비해 둔 강조색 */
const PRESET_ACCENTS = [
  "#00e6a1",
  "#4d9fff",
  "#ff7bd5",
  "#ff9f43",
  "#9b7bff",
  "#ffd93d",
  "#ff6b6b",
  "#b0bec5",
];

let styleChannelId: string | null = null;

function paneStyleOf(channelId: string): PaneStyle {
  return getSettings().paneStyles[channelId] ?? {};
}

function savePaneStyle(channelId: string, patch: PaneStyle | null): void {
  const styles = { ...getSettings().paneStyles };
  if (patch === null) delete styles[channelId];
  else styles[channelId] = { ...styles[channelId], ...patch };
  saveSettings({ paneStyles: styles });
  panes.get(channelId)?.applyStyle(patch === null ? undefined : styles[channelId]);
}

function openPaneStyle(channelId: string): void {
  const dialog = document.getElementById("pane-style-modal") as HTMLDialogElement;
  styleChannelId = channelId;
  document.getElementById("pane-style-title")!.textContent =
    `${channelName(channelId)} 창 색`;

  const st = paneStyleOf(channelId);
  (document.getElementById("pane-accent") as HTMLInputElement).value =
    st.accent ?? "#00e6a1";
  (document.getElementById("pane-bg") as HTMLInputElement).value =
    st.bg ?? "#14161b";
  (document.getElementById("pane-text") as HTMLInputElement).value =
    st.text ?? "#edeef1";
  const opacity = Math.round((st.opacity ?? 1) * 100);
  (document.getElementById("pane-opacity") as HTMLInputElement).value =
    String(opacity);
  document.getElementById("pane-opacity-val")!.textContent = `${opacity}%`;

  renderPresets(st);
  dialog.showModal();
}

/** 기본 조합 + 내가 저장해 둔 조합을 함께 보여준다 */
function renderPresets(current: PaneStyle): void {
  const swatch = (
    accent: string,
    bg: string,
    label: string,
    extra = "",
  ): string =>
    `<button class="swatch${accent === current.accent ? " active" : ""}" ` +
    `data-accent="${escapeHtml(accent)}" data-bg="${escapeHtml(bg)}"${extra} ` +
    `style="background:${escapeHtml(bg)};border-color:${escapeHtml(accent)}" ` +
    `title="${escapeHtml(label)}"><span style="background:${escapeHtml(accent)}"></span></button>`;

  document.getElementById("pane-style-presets")!.innerHTML = PRESET_ACCENTS.map(
    (accent) => swatch(accent, PRESET_BG, accent),
  ).join("");

  const saved = getSettings().panePresets;
  const savedEl = document.getElementById("pane-style-saved")!;
  savedEl.innerHTML = saved.length
    ? saved
        .map(
          (p, i) =>
            `<span class="preset-chip">` +
            swatch(
              p.accent ?? "#00e6a1",
              p.bg ?? PRESET_BG,
              p.name,
              ` data-text="${escapeHtml(p.text ?? "")}" data-opacity="${p.opacity ?? 1}"`,
            ) +
            `<span class="preset-name">${escapeHtml(p.name)}</span>` +
            `<button class="preset-del" data-del="${i}" title="이 조합 지우기">×</button>` +
            `</span>`,
        )
        .join("")
    : `<span class="settings-help">저장해 둔 조합이 없습니다.</span>`;
}

function initPaneStyleDialog(): void {
  const dialog = document.getElementById("pane-style-modal") as HTMLDialogElement;
  const accent = document.getElementById("pane-accent") as HTMLInputElement;
  const bg = document.getElementById("pane-bg") as HTMLInputElement;
  const text = document.getElementById("pane-text") as HTMLInputElement;
  const opacity = document.getElementById("pane-opacity") as HTMLInputElement;

  document
    .getElementById("pane-style-close")!
    .addEventListener("click", () => dialog.close());

  // 색을 고르는 즉시 창에 반영해 눈으로 보며 맞출 수 있게 한다
  const live = () => {
    if (!styleChannelId) return;
    savePaneStyle(styleChannelId, {
      accent: accent.value,
      bg: bg.value,
      text: text.value,
      opacity: Number(opacity.value) / 100,
    });
  };
  for (const el of [accent, bg, text]) {
    el.addEventListener("input", live);
  }
  opacity.addEventListener("input", () => {
    document.getElementById("pane-opacity-val")!.textContent =
      `${opacity.value}%`;
    live();
  });

  /** 프리셋을 누르면 그 조합을 그대로 입힌다 */
  const usePreset = (e: Event) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-accent]");
    if (!el || !styleChannelId) return;
    accent.value = el.dataset.accent!;
    bg.value = el.dataset.bg!;
    if (el.dataset.text) text.value = el.dataset.text;
    if (el.dataset.opacity) {
      opacity.value = String(Math.round(Number(el.dataset.opacity) * 100));
      document.getElementById("pane-opacity-val")!.textContent =
        `${opacity.value}%`;
    }
    live();
    for (const s of document.querySelectorAll(".swatch")) {
      s.classList.toggle("active", s === el);
    }
  };
  document
    .getElementById("pane-style-presets")!
    .addEventListener("click", usePreset);

  const savedEl = document.getElementById("pane-style-saved")!;
  savedEl.addEventListener("click", (e) => {
    const del = (e.target as HTMLElement).closest<HTMLElement>("[data-del]");
    if (del) {
      const presets = [...getSettings().panePresets];
      presets.splice(Number(del.dataset.del), 1);
      saveSettings({ panePresets: presets });
      renderPresets(styleChannelId ? paneStyleOf(styleChannelId) : {});
      return;
    }
    usePreset(e);
  });

  // 지금 색 조합을 이름 붙여 저장
  const nameInput = document.getElementById("preset-name") as HTMLInputElement;
  document.getElementById("preset-save")!.addEventListener("click", () => {
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.focus();
      return;
    }
    const presets = [...getSettings().panePresets].filter(
      (p) => p.name !== name,
    );
    presets.push({
      name,
      accent: accent.value,
      bg: bg.value,
      text: text.value,
      opacity: Number(opacity.value) / 100,
    });
    saveSettings({ panePresets: presets });
    nameInput.value = "";
    renderPresets(styleChannelId ? paneStyleOf(styleChannelId) : {});
  });

  document.getElementById("pane-style-reset")!.addEventListener("click", () => {
    if (styleChannelId) savePaneStyle(styleChannelId, null);
    dialog.close();
  });
}

// ---------- 표시한 유저 관리 ----------

type MarksTab = "note" | "highlight" | "block";
let marksTab: MarksTab = "note";

function renderMarksList(): void {
  const listEl = document.getElementById("marks-list")!;
  listEl.innerHTML = "";
  for (const btn of document.querySelectorAll<HTMLButtonElement>(
    "#marks-tabs button",
  )) {
    btn.classList.toggle("active", btn.dataset.tab === marksTab);
  }

  const rows: HTMLElement[] = [];
  if (marksTab === "block") {
    for (const b of allBlocks()) {
      const el = document.createElement("div");
      el.className = "mark-row";
      const where = b.channelId
        ? `${escapeHtml(channelName(b.channelId))} 채널`
        : "모든 채널";
      el.innerHTML =
        `<span class="nick">${escapeHtml(b.nickname || knownNickname(b.userIdHash) || "(이름 모름)")}</span>` +
        `<span class="mark-meta">${where}</span>` +
        `<button class="mark-undo">차단 해제</button>`;
      el.querySelector(".mark-undo")!.addEventListener("click", () => {
        void unblock(b.userIdHash, b.channelId);
      });
      rows.push(el);
    }
  } else {
    for (const { userIdHash, mark } of allMarks()) {
      const value = marksTab === "note" ? mark.note : mark.highlight;
      if (!value) continue;
      const el = document.createElement("div");
      el.className = "mark-row";
      const detail =
        marksTab === "note"
          ? `<span class="mark-meta">${escapeHtml(mark.note)}</span>`
          : `<span class="mark-meta"><span class="swatch small" style="background:${escapeHtml(mark.highlight)}"></span>${escapeHtml(mark.highlight)}</span>`;
      el.innerHTML =
        `<span class="nick">${escapeHtml(mark.nickname || knownNickname(userIdHash) || "(이름 모름)")}</span>` +
        detail +
        `<button class="mark-undo">지우기</button>`;
      el.querySelector(".mark-undo")!.addEventListener("click", () => {
        void setMark(
          userIdHash,
          mark.nickname,
          marksTab === "note" ? { note: "" } : { highlight: "" },
        );
      });
      rows.push(el);
    }
  }

  if (rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent =
      marksTab === "note"
        ? "메모한 유저가 없습니다."
        : marksTab === "highlight"
          ? "강조 표시한 유저가 없습니다."
          : "차단한 유저가 없습니다.";
    rows.push(empty);
  }
  for (const el of rows) listEl.appendChild(el);
}

function initMarksModal(): void {
  const dialog = document.getElementById("marks-modal") as HTMLDialogElement;
  document
    .getElementById("marks-close")!
    .addEventListener("click", () => dialog.close());
  for (const btn of document.querySelectorAll<HTMLButtonElement>(
    "#marks-tabs button",
  )) {
    btn.addEventListener("click", () => {
      marksTab = btn.dataset.tab as MarksTab;
      renderMarksList();
    });
  }
  document.getElementById("open-marks")!.addEventListener("click", () => {
    (document.getElementById("settings-modal") as HTMLDialogElement).close();
    renderMarksList();
    dialog.showModal();
  });
  // 표시가 바뀌면 열려 있는 목록과 채팅 화면을 함께 갱신한다
  onMarksChanged(() => {
    if (dialog.open) renderMarksList();
    refreshOpenPanes();
  });
}

/** 차단·강조가 바뀌면 열려 있는 창의 대화를 다시 불러온다 */
function refreshOpenPanes(): void {
  for (const [id, pane] of panes) {
    pane.chat.clear();
    void getRecentMessages(id, 200).then((rows) => {
      for (const row of rows) pane.chat.addStored(row);
    });
  }
}

// ---------- 부트스트랩 ----------

/**
 * 웹뷰가 입력칸에 "저장된 정보"(이전에 입력한 값) 목록을 띄우지 않게 한다.
 * 자동완성을 끄는 것만으로는 부족해서, 입력칸 이름을 실행할 때마다 새로 지어
 * 웹뷰가 예전에 저장해 둔 값과 이어 붙이지 못하게 한다.
 */
function suppressAutofill(): void {
  const salt = Math.random().toString(36).slice(2, 10);
  for (const el of document.querySelectorAll<HTMLInputElement>("input")) {
    if (el.type === "checkbox" || el.type === "radio") continue;
    el.autocomplete = "off";
    el.setAttribute("autocorrect", "off");
    el.setAttribute("autocapitalize", "off");
    el.name = `${el.id || "f"}-${salt}`;
  }
}

/**
 * 웹뷰 기본 동작을 앱에 맞게 바꾼다.
 * 브라우저 우클릭 메뉴(새로 고침·인쇄 등)를 없애고,
 * Ctrl+F는 브라우저 찾기 대신 앱 검색을 연다.
 */
function initWebviewBehavior(): void {
  suppressAutofill();

  document.addEventListener("contextmenu", (e) => {
    // 입력칸에서는 복사·붙여넣기 메뉴가 필요하다
    const el = e.target as HTMLElement;
    if (el.closest("input, textarea")) return;
    e.preventDefault();
  });

  window.addEventListener(
    "keydown",
    (e) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchModal.open();
      } else if (ctrl && e.key.toLowerCase() === "p") {
        e.preventDefault(); // 인쇄 대화상자
      } else if (e.key === "F3" || (ctrl && e.key.toLowerCase() === "g")) {
        e.preventDefault(); // 다음 찾기
      } else if (ctrl && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleSidebar();
      } else if (e.key === "F5" || (ctrl && e.key.toLowerCase() === "r")) {
        e.preventDefault(); // 새로 고침 — 수집이 끊기므로 막는다
      }
    },
    true,
  );
}

// ---------- 사이드바 접기 ----------

function applySidebarState(): void {
  const collapsed = getSettings().sidebarCollapsed;
  document.getElementById("sidebar")!.classList.toggle("collapsed", collapsed);
  const btn = document.getElementById("sidebar-toggle")!;
  btn.textContent = collapsed ? "»" : "«";
  btn.title = collapsed ? "채널 목록 펼치기 (Ctrl+B)" : "채널 목록 접기 (Ctrl+B)";
}

function toggleSidebar(): void {
  saveSettings({ sidebarCollapsed: !getSettings().sidebarCollapsed });
  applySidebarState();
}

function initSidebarToggle(): void {
  document
    .getElementById("sidebar-toggle")!
    .addEventListener("click", toggleSidebar);
  applySidebarState();
}

/** 지금 열려 있는 DB 파일 경로 (설정 표시·복사에 사용) */
let currentDbPath = "";

async function main(): Promise<void> {
  // 설정된 폴더가 있으면 그곳의 DB를 연다
  currentDbPath = await invoke<string>("prepare_db_dir", {
    dir: getSettings().dbDir || null,
    current: null,
  }).catch(() => "");
  await initDb(currentDbPath || undefined);
  await loadChannelNames();
  await loadLastActivity();
  await loadMarks();
  await initNotifications().catch(() => {});
  await refreshLoginNickname();
  initSettingsModal();
  initWebviewBehavior();
  initChannelMenu();
  initChannelOrder();
  initSidebarToggle();
  initPaneDrop();
  initPaneReorder();
  initPaneLayout();
  initBadgeModal();
  initPowerModal();
  initUserMenu();
  initNoteDialog();
  initHighlightDialog();
  initPaneStyleDialog();
  initMarksModal();
  initRenameDialog();
  document
    .getElementById("open-search")!
    .addEventListener("click", () => searchModal.open());
  document
    .getElementById("open-donations")!
    .addEventListener("click", () => donationsModal.open());
  renderChannelList();

  const input = document.getElementById("channel-input") as HTMLInputElement;
  const addBtn = document.getElementById("add-channel") as HTMLButtonElement;
  const doAdd = () => {
    const v = input.value;
    input.value = "";
    void addChannel(v).catch((e) =>
      notify(`채널 추가 실패: ${e instanceof Error ? e.message : String(e)}`),
    );
  };
  addBtn.addEventListener("click", doAdd);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doAdd();
  });

  // 지난번에 열어 뒀던 창들을 복원한다 (없으면 첫 채널 하나)
  const known = new Set(getChannels().map((c) => c.channelId));
  const restore = getSettings().openChannels.filter((id) => known.has(id));
  if (restore.length === 0) {
    const first = orderedChannels()[0];
    if (first) restore.push(first.channelId);
  }
  collector.viewing = new Set(restore);

  // 등록된 모든 채널 수집 시작
  await collector.start();
  for (const id of restore) await openChannel(id, "add");
}

/** 로그인 닉네임 (상태 표시용) */
let loginNickname: string | null = null;
/** 내 치지직 프로필 사진 — 채팅 입력칸 왼쪽 버튼에 쓴다 */
let loginProfileImage: string | null = null;

async function refreshLoginNickname(): Promise<void> {
  const user = hasAuth() ? await getUserStatus().catch(() => null) : null;
  loginNickname = user?.nickname ?? null;
  loginProfileImage = user?.profileImageUrl ?? null;
  for (const pane of panes.values()) pane.setMyProfileImage(loginProfileImage);
}

void main();
