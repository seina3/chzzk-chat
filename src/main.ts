import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { getChannelInfo, getUserStatus, parseChannelInput } from "./chzzk/api";
import { ChatCollector } from "./collector";
import {
  getRecentMessages,
  initDb,
  markMessageBlinded,
  saveMessage,
} from "./db";
import { channelName, loadChannelNames, noteChannelName } from "./channel-names";
import { logMessage, noteLive, resetSessions } from "./logger";
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
  type SavedChannel,
} from "./settings";
import { ChatView } from "./ui/chat-view";
import { Dashboard } from "./ui/dashboard";
import { DonationsModal } from "./ui/donations";
import { GlobalSearchModal } from "./ui/global-search";
import { escapeHtml } from "./ui/render";
import { UserHistoryModal } from "./ui/user-history";

let activeChannelId: string | null = null;
let notifyGranted = false;

const dashboard = new Dashboard();
const userModal = new UserHistoryModal();
const searchModal = new GlobalSearchModal((uid, nick) => {
  void userModal.open(uid, nick);
});
const donationsModal = new DonationsModal((uid, nick, donationsOnly) => {
  void userModal.open(uid, nick, donationsOnly);
});
const chatView = new ChatView("chat-messages", "scroll-bottom", (uid, nick) => {
  void userModal.open(uid, nick);
});

const chatInput = document.getElementById("chat-input") as HTMLInputElement;
const sendBtn = document.getElementById("send-btn") as HTMLButtonElement;
const statusEl = document.getElementById("conn-status")!;

/** 모든 등록 채널의 채팅을 수집한다 (화면에 보이는 채널과 무관) */
const collector = new ChatCollector({
  onMessage: (m) => {
    saveMessage(m);
    logMessage(m);
    if (m.channelId === activeChannelId) chatView.add(m);
  },
  onBlind: (channelId, uid, time) => {
    // 기록에도 남겨야 검색·유저 기록에서도 취소선으로 보인다
    markMessageBlinded(channelId, uid, time);
    if (channelId === activeChannelId) chatView.markBlinded(uid, time);
  },
  onError: (channelId, message) => {
    if (channelId === activeChannelId) chatView.addSystem(`⚠️ ${message}`);
    else console.warn(`[${channelId}] ${message}`);
  },
  onDebug: (channelId, direction, frame) => {
    if (channelId === activeChannelId) chatView.addSystem(`${direction} ${frame}`);
  },
  onStatus: (channelId) => {
    if (channelId === activeChannelId) renderConnStatus();
    renderChannelList();
  },
  onLive: (channelId, live, justStarted) => {
    if (channelId === activeChannelId) dashboard.update(live);
    // 방송 회차·제목·카테고리 변화를 로그 파일에 반영
    noteLive(channelId, live);
    if (live?.status === "OPEN") markChannelLive(channelId);
    if (justStarted && live) {
      const name =
        channelName(channelId);
      notifyLiveStart(name, live.liveTitle);
      if (channelId === activeChannelId) {
        chatView.addSystem(`🔴 방송이 시작되었습니다: ${live.liveTitle}`);
      }
    }
    renderChannelList();
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

/** 방송 중인 것을 확인한 시각을 남긴다 ("최근 방송순" 정렬용) */
function markChannelLive(channelId: string): void {
  const channels = getChannels();
  const ch = channels.find((c) => c.channelId === channelId);
  if (!ch) return;
  // 1분 단위로만 갱신해 localStorage 쓰기를 줄인다
  const now = Date.now();
  if (ch.lastLiveAt && now - ch.lastLiveAt < 60_000) return;
  ch.lastLiveAt = now;
  saveChannels(channels);
}

function renderChannelList(): void {
  const listEl = document.getElementById("channel-list")!;
  const order = getSettings().channelOrder;
  listEl.innerHTML = "";
  for (const ch of sortChannels(getChannels(), order)) {
    const li = document.createElement("li");
    li.className = ch.channelId === activeChannelId ? "channel active" : "channel";
    li.dataset.channelId = ch.channelId;
    // 직접 정렬일 때만 드래그로 순서를 바꿀 수 있다
    if (order === "manual") li.draggable = true;
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
      (order === "manual" ? "\n드래그해서 순서를 바꿀 수 있습니다" : "");
    li.innerHTML = `${img}<span class="channel-name">${escapeHtml(shown)}</span>${rec}${live}<button class="channel-remove" title="삭제">×</button>`;
    li.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).classList.contains("channel-remove")) {
        void removeChannel(ch.channelId);
      } else {
        void showChannel(ch.channelId);
      }
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

function initChannelOrder(): void {
  const select = document.getElementById("channel-order") as HTMLSelectElement;
  select.value = getSettings().channelOrder;
  select.addEventListener("change", () => {
    saveSettings({ channelOrder: select.value as ChannelOrder });
    renderChannelList();
  });

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
      case "open":
        invoke("open_url", { url }).catch((err) =>
          chatView.addSystem(`채널을 열지 못했습니다: ${err}`),
        );
        break;
      case "copy":
        navigator.clipboard
          .writeText(url)
          .then(() => chatView.addSystem(`채널 링크를 복사했습니다: ${url}`))
          .catch(() => chatView.addSystem(`링크 복사에 실패했습니다: ${url}`));
        break;
      case "rename":
        openRenameDialog(channelId);
        break;
      case "reset-name":
        setChannelAlias(channelId, "");
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

function setChannelAlias(channelId: string, alias: string): void {
  const channels = getChannels().map((c) =>
    c.channelId === channelId ? { ...c, alias: alias.trim() || undefined } : c,
  );
  saveChannels(channels);
  renderChannelList();
  if (channelId === activeChannelId) void showChannel(channelId);
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
  if (channelId === activeChannelId) {
    activeChannelId = null;
    chatView.clear();
    dashboard.hide();
    setSendEnabled(false);
    statusEl.textContent = "";
  }
  renderChannelList();
}

async function addChannel(input: string): Promise<void> {
  const channelId = parseChannelInput(input);
  if (!channelId) {
    chatView.addSystem("채널 URL 또는 32자리 채널 ID를 입력해 주세요.");
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
  await showChannel(channelId);
}

// ---------- 채널 표시 ----------

/**
 * 화면에 보여줄 채널을 바꾼다.
 * 수집은 collector가 모든 채널에 대해 계속하고 있으므로 연결은 건드리지 않고,
 * 저장된 최근 대화를 불러와 화면만 전환한다.
 */
async function showChannel(channelId: string): Promise<void> {
  activeChannelId = channelId;
  collector.activeOnly = channelId;
  chatView.clear();
  renderChannelList();
  renderConnStatus();

  const info = getChannels().find((c) => c.channelId === channelId);
  if (info) {
    dashboard.setChannel({
      channelId,
      channelName: info.name,
      channelImageUrl: info.imageUrl,
      followerCount: 0,
    });
  }
  dashboard.update(collector.getLive(channelId));

  // 수집해 둔 최근 대화를 먼저 보여준다
  const recent = await getRecentMessages(channelId, 200);
  for (const row of recent) chatView.addStored(row);
  if (recent.length > 0) chatView.addSystem("─── 저장된 최근 대화 ───");

  await collector.syncChannel(channelId).catch(() => {});
  renderConnStatus();
}

function renderConnStatus(): void {
  if (!activeChannelId) {
    statusEl.textContent = "";
    setSendEnabled(false);
    return;
  }
  const status = collector.getStatus(activeChannelId);
  const live = collector.getLive(activeChannelId);
  switch (status) {
    case "connected":
      statusEl.textContent = collector.canSend(activeChannelId)
        ? `연결됨 (${loginNickname ?? "로그인됨"})`
        : "연결됨 (읽기 전용)";
      break;
    case "connecting":
      statusEl.textContent = "채팅 서버 연결 중…";
      break;
    case "reconnecting":
      statusEl.textContent = "연결 끊김 — 재연결 중";
      break;
    default:
      statusEl.textContent =
        live?.status === "OPEN"
          ? "채팅방 연결 대기 중…"
          : "오프라인 (방송이 시작되면 자동으로 수집합니다)";
  }
  setSendEnabled(collector.canSend(activeChannelId));
}

// ---------- 채팅 입력 ----------

function setSendEnabled(enabled: boolean): void {
  chatInput.disabled = !enabled;
  sendBtn.disabled = !enabled;
  chatInput.placeholder = enabled
    ? "채팅 입력…"
    : hasAuth()
      ? "연결되면 채팅을 보낼 수 있습니다"
      : "채팅 전송은 설정에서 네이버 쿠키 등록 후 가능합니다 (읽기 전용)";
}

async function sendCurrentInput(): Promise<void> {
  const text = chatInput.value.trim();
  if (!text || !activeChannelId) return;
  try {
    await collector.sendChat(activeChannelId, text);
    chatInput.value = "";
  } catch (e) {
    chatView.addSystem(`전송 실패: ${e instanceof Error ? e.message : String(e)}`);
  }
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
    chatView.addSystem(
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
    chatView.addSystem(
      collectAllInput.checked
        ? "모든 등록 채널의 채팅을 수집합니다."
        : "지금 보고 있는 채널만 수집합니다.",
    );
    void collector.syncNow();
  });

  document.getElementById("frame-debug-btn")!.addEventListener("click", () => {
    if (!activeChannelId || !collector.startFrameDebug(activeChannelId)) {
      chatView.addSystem("⚠️ 진단하려면 먼저 채팅에 연결되어야 합니다.");
      return;
    }
    dialog.close();
    chatView.addSystem(
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
      (e) => chatView.addSystem(`폴더 열기 실패: ${e}`),
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
      chatView.addSystem(
        `DB 위치를 ${target} 으로 정했습니다. 앱을 다시 시작하면 적용됩니다.`,
      );
    } catch (e) {
      chatView.addSystem(`DB 폴더 변경 실패: ${e}`);
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
      chatView.addSystem(`폴더 열기 실패: ${e}`),
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
    try {
      if (hasAuth()) {
        // 이미 로그인된 상태에서 다시 로그인: 웹뷰의 기존 네이버 세션을
        // 먼저 정리해야 로그인 창이 즉시 닫히지 않고 계정 선택이 가능하다.
        loginBtn.disabled = true;
        statusEl.textContent = "기존 로그인 세션 정리 중…";
        await invoke("naver_logout").catch(() => {});
        await new Promise((r) => setTimeout(r, 3500));
        loginBtn.disabled = false;
      }
      await invoke("naver_login");
    } catch (e) {
      loginBtn.disabled = false;
      chatView.addSystem(`로그인 창을 열지 못했습니다: ${e}`);
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
    // 같은 세션이 다시 감지된 경우(버튼 중복 클릭 등)에는 조용히 넘어간다
    if (changed) applyAuthChange("네이버 로그인 완료!");
  });
  void listen("naver-login-cancelled", () => {
    chatView.addSystem("네이버 로그인이 취소되었습니다.");
  });
  // 로그인 창에서 쿠키를 찾는 중의 진행 상황 (문제 진단용)
  void listen<string>("naver-login-progress", (e) => {
    statusEl.textContent = e.payload;
    chatView.addSystem(e.payload);
  });

  void refreshStatus();
}

/** 로그인 상태 변경을 반영 — 모든 채널을 새 권한으로 다시 연결 */
function applyAuthChange(message: string): void {
  chatView.addSystem(message);
  void collector
    .reauth()
    .then(() => renderConnStatus())
    .catch((e) => chatView.addSystem(`재접속 실패: ${e}`));
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
      } else if (e.key === "F5" || (ctrl && e.key.toLowerCase() === "r")) {
        e.preventDefault(); // 새로 고침 — 수집이 끊기므로 막는다
      }
    },
    true,
  );
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
  await initNotifications().catch(() => {});
  await refreshLoginNickname();
  initSettingsModal();
  initWebviewBehavior();
  initChannelMenu();
  initChannelOrder();
  initRenameDialog();
  document
    .getElementById("open-search")!
    .addEventListener("click", () => searchModal.open());
  document
    .getElementById("open-donations")!
    .addEventListener("click", () => donationsModal.open());
  setSendEnabled(false);
  renderChannelList();

  const input = document.getElementById("channel-input") as HTMLInputElement;
  const addBtn = document.getElementById("add-channel") as HTMLButtonElement;
  const doAdd = () => {
    const v = input.value;
    input.value = "";
    void addChannel(v).catch((e) =>
      chatView.addSystem(`채널 추가 실패: ${e instanceof Error ? e.message : String(e)}`),
    );
  };
  addBtn.addEventListener("click", doAdd);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doAdd();
  });

  sendBtn.addEventListener("click", () => void sendCurrentInput());
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void sendCurrentInput();
  });

  const first = getChannels()[0];
  if (first) {
    activeChannelId = first.channelId;
    collector.activeOnly = first.channelId;
  }
  // 등록된 모든 채널 수집 시작
  await collector.start();
  if (first) await showChannel(first.channelId);
}

/** 로그인 닉네임 (상태 표시용) */
let loginNickname: string | null = null;

async function refreshLoginNickname(): Promise<void> {
  const user = hasAuth() ? await getUserStatus().catch(() => null) : null;
  loginNickname = user?.nickname ?? null;
}

void main();
