/** 채팅 로그 파일 형식 */
export type LogFormat = "txt" | "csv";

/** 사이드바 채널 정렬 방식 */
export type ChannelOrder = "manual" | "name" | "recent";

/** 채널 창 배치 — 세로 분할(좌우로 늘어놓기) / 가로 분할(위아래) / 격자 */
export type PaneLayout = "columns" | "rows" | "grid";

/** 채널 창마다 지정할 수 있는 색 */
export interface PaneStyle {
  /** 강조색 — 테두리·머리글 */
  accent?: string;
  /** 창 배경색 */
  bg?: string;
  /** 글자색 */
  text?: string;
  /**
   * 입힌 색의 진하기 (0.1 ~ 1).
   * 창 자체를 투명하게 만드는 것이 아니라, 강조색·배경색을 얼마나
   * 진하게 얹을지를 정한다.
   */
  opacity?: number;
}

/** 이름을 붙여 저장해 둔 색 조합 */
export interface PanePreset extends PaneStyle {
  name: string;
}

export interface Settings {
  nidAut: string;
  nidSes: string;
  /** 채팅을 파일로도 실시간 저장 */
  logTxt: boolean;
  /** 로그 파일 형식 — txt(사람이 읽기 좋음) / csv(통계·공유용) */
  logFormat: LogFormat;
  /** 로그 저장 폴더. 빈 문자열이면 기본(앱 데이터/logs) */
  logDir: string;
  /** 등록된 모든 채널의 채팅을 백그라운드에서 함께 수집 */
  collectAll: boolean;
  /** 방송 시작 시 OS 알림 표시 */
  notifyLive: boolean;
  /** 채팅 DB를 둘 폴더. 빈 문자열이면 앱 기본 위치 */
  dbDir: string;
  /** 사이드바 채널 정렬 */
  channelOrder: ChannelOrder;
  /** 채널 목록을 접어 뒀는지 */
  sidebarCollapsed: boolean;
  /** 나란히 열어 둔 채널들 (다음 실행 때 그대로 복원) */
  openChannels: string[];
  /** 채널 창 배치 */
  paneLayout: PaneLayout;
  /** 채널별 창 색 설정 */
  paneStyles: Record<string, PaneStyle>;
  /** 직접 만들어 저장한 색 조합 */
  panePresets: PanePreset[];
  /** 채널을 묶어 두는 폴더 (표시 순서대로) */
  folders: ChannelFolder[];
}

/** 사이드바에서 채널 몇 개를 묶어 접었다 펼 수 있는 묶음 */
export interface ChannelFolder {
  id: string;
  name: string;
  /** 접어 둔 상태인지 */
  collapsed: boolean;
  /** 폴더 이름·테두리에 입힐 색 (없으면 기본색) */
  color?: string;
}

const DEFAULT_SETTINGS: Settings = {
  nidAut: "",
  nidSes: "",
  logTxt: true,
  logFormat: "txt",
  logDir: "",
  collectAll: true,
  notifyLive: true,
  dbDir: "",
  channelOrder: "manual",
  sidebarCollapsed: false,
  openChannels: [],
  paneLayout: "columns",
  paneStyles: {},
  panePresets: [],
  folders: [],
};

export interface SavedChannel {
  channelId: string;
  /** 치지직에서 가져온 원래 채널명 */
  name: string;
  imageUrl: string | null;
  /** 사용자가 지정한 별명 — 있으면 이 이름으로 표시한다 */
  alias?: string;
  /** 마지막으로 확인한 방송의 시작 시각(ms) — "최신순" 정렬용 */
  lastOpenAt?: number;
  /** 들어가 있는 폴더 (없으면 목록 바깥) */
  folderId?: string;
}

/** 화면에 표시할 이름 (별명이 있으면 별명) */
export function displayName(ch: SavedChannel): string {
  return ch.alias?.trim() || ch.name;
}

/** "최신순" 정렬에 필요한, 저장된 값 밖의 정보 */
export interface ChannelSortHints {
  /** 지금 방송 중인지 */
  isLive(channelId: string): boolean;
  /** 방송 기록이 없을 때 대신 쓸 마지막 활동 시각(ms) */
  lastActivity(channelId: string): number;
}

/**
 * 설정한 방식으로 채널 목록을 정렬한다.
 * manual은 저장된 순서 그대로(드래그·우클릭 메뉴로 바꾼 순서).
 * recent는 방송 중인 채널을 위로 올리고, 그다음 방송을 켠 시각 순으로 늘어놓는다.
 */
export function sortChannels(
  channels: SavedChannel[],
  order: ChannelOrder,
  hints?: ChannelSortHints,
): SavedChannel[] {
  if (order === "manual") return channels;
  const list = [...channels];
  const byName = (a: SavedChannel, b: SavedChannel) =>
    displayName(a).localeCompare(displayName(b), "ko");

  if (order === "name") {
    list.sort(byName);
    return list;
  }

  // 방송을 켠 시각을 모르면 채팅이 마지막으로 들어온 시각으로 대신한다
  const startedAt = (ch: SavedChannel) =>
    ch.lastOpenAt ?? hints?.lastActivity(ch.channelId) ?? 0;

  list.sort((a, b) => {
    const liveA = hints?.isLive(a.channelId) ? 1 : 0;
    const liveB = hints?.isLive(b.channelId) ? 1 : 0;
    if (liveA !== liveB) return liveB - liveA;
    const d = startedAt(b) - startedAt(a);
    return d !== 0 ? d : byName(a, b);
  });
  return list;
}

const SETTINGS_KEY = "chzzk-chat.settings";
const CHANNELS_KEY = "chzzk-chat.channels";

export function getSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    /* corrupt settings fall back to defaults */
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(patch: Partial<Settings>): void {
  localStorage.setItem(
    SETTINGS_KEY,
    JSON.stringify({ ...getSettings(), ...patch }),
  );
}

export function hasAuth(): boolean {
  const s = getSettings();
  return s.nidAut.length > 0 && s.nidSes.length > 0;
}

const UUID_KEY = "chzzk-chat.deviceUuid";

/** 기기 식별자 — 치지직 접속 시 보내는 uuid. 한 번 만들면 계속 재사용한다 */
export function getDeviceUuid(): string {
  let v = localStorage.getItem(UUID_KEY);
  if (!v) {
    v = crypto.randomUUID();
    localStorage.setItem(UUID_KEY, v);
  }
  return v;
}

/** 창 식별자 — 앱 실행마다 새로 만든다 (웹의 windowId에 해당) */
export const WINDOW_ID = crypto.randomUUID();

export function getChannels(): SavedChannel[] {
  try {
    const raw = localStorage.getItem(CHANNELS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return [];
}

export function saveChannels(channels: SavedChannel[]): void {
  localStorage.setItem(CHANNELS_KEY, JSON.stringify(channels));
}
