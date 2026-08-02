/** 채팅 로그 파일 형식 */
export type LogFormat = "txt" | "csv";

/** 사이드바 채널 정렬 방식 */
export type ChannelOrder = "manual" | "name" | "recent";

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
};

export interface SavedChannel {
  channelId: string;
  /** 치지직에서 가져온 원래 채널명 */
  name: string;
  imageUrl: string | null;
  /** 사용자가 지정한 별명 — 있으면 이 이름으로 표시한다 */
  alias?: string;
  /** 마지막으로 방송 중인 것을 확인한 시각(ms) — "최근 방송순" 정렬용 */
  lastLiveAt?: number;
}

/** 화면에 표시할 이름 (별명이 있으면 별명) */
export function displayName(ch: SavedChannel): string {
  return ch.alias?.trim() || ch.name;
}

/**
 * 설정한 방식으로 채널 목록을 정렬한다.
 * manual은 저장된 순서 그대로(드래그로 바꾼 순서).
 */
export function sortChannels(
  channels: SavedChannel[],
  order: ChannelOrder,
): SavedChannel[] {
  if (order === "manual") return channels;
  const list = [...channels];
  if (order === "name") {
    list.sort((a, b) => displayName(a).localeCompare(displayName(b), "ko"));
  } else {
    // 최근 방송순 — 방송 기록이 없는 채널은 뒤로 보내고 이름순으로
    list.sort((a, b) => {
      const d = (b.lastLiveAt ?? 0) - (a.lastLiveAt ?? 0);
      return d !== 0 ? d : displayName(a).localeCompare(displayName(b), "ko");
    });
  }
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
