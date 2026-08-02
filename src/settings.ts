export interface Settings {
  nidAut: string;
  nidSes: string;
  /** 채팅을 txt 파일로도 실시간 저장 */
  logTxt: boolean;
  /** txt 로그 저장 폴더. 빈 문자열이면 기본(앱 데이터/logs) */
  logDir: string;
  /** 등록된 모든 채널의 채팅을 백그라운드에서 함께 수집 */
  collectAll: boolean;
  /** 방송 시작 시 OS 알림 표시 */
  notifyLive: boolean;
  /** 채팅 DB를 둘 폴더. 빈 문자열이면 앱 기본 위치 */
  dbDir: string;
}

const DEFAULT_SETTINGS: Settings = {
  nidAut: "",
  nidSes: "",
  logTxt: true,
  logDir: "",
  collectAll: true,
  notifyLive: true,
  dbDir: "",
};

export interface SavedChannel {
  channelId: string;
  /** 치지직에서 가져온 원래 채널명 */
  name: string;
  imageUrl: string | null;
  /** 사용자가 지정한 별명 — 있으면 이 이름으로 표시한다 */
  alias?: string;
}

/** 화면에 표시할 이름 (별명이 있으면 별명) */
export function displayName(ch: SavedChannel): string {
  return ch.alias?.trim() || ch.name;
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
