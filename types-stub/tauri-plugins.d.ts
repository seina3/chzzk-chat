/**
 * 오프라인 타입체크용 @tauri-apps 플러그인 API 스텁.
 * 실제 빌드에서는 node_modules의 진짜 타입이 사용된다.
 * `npm run check:offline` (tsconfig.check.json) 전용.
 */

declare module "@tauri-apps/api/core" {
  export function invoke<T = void>(
    cmd: string,
    args?: Record<string, unknown>,
  ): Promise<T>;
}

declare module "@tauri-apps/api/event" {
  export interface Event<T> {
    event: string;
    id: number;
    payload: T;
  }
  export type UnlistenFn = () => void;
  export function listen<T>(
    event: string,
    handler: (event: Event<T>) => void,
  ): Promise<UnlistenFn>;
}

declare module "@tauri-apps/plugin-dialog" {
  export interface OpenDialogOptions {
    directory?: boolean;
    multiple?: boolean;
    title?: string;
    defaultPath?: string;
  }
  export function open(
    options?: OpenDialogOptions,
  ): Promise<string | string[] | null>;
}

declare module "@tauri-apps/plugin-websocket" {
  export type Message =
    | { type: "Text"; data: string }
    | { type: "Binary"; data: number[] }
    | { type: "Ping"; data: number[] }
    | { type: "Pong"; data: number[] }
    | { type: "Close"; data: { code: number; reason: string } | null };

  export default class WebSocket {
    static connect(
      url: string,
      config?: Record<string, unknown>,
    ): Promise<WebSocket>;
    addListener(cb: (message: Message) => void): () => void;
    send(message: string | number[] | Message): Promise<void>;
    disconnect(): Promise<void>;
  }
}

declare module "@tauri-apps/plugin-notification" {
  export interface Options {
    title: string;
    body?: string;
  }
  export function isPermissionGranted(): Promise<boolean>;
  export function requestPermission(): Promise<"granted" | "denied" | "default">;
  export function sendNotification(options: Options | string): void;
}

declare module "@tauri-apps/plugin-sql" {
  export interface QueryResult {
    rowsAffected: number;
    lastInsertId?: number;
  }
  export default class Database {
    static load(path: string): Promise<Database>;
    execute(query: string, bindValues?: unknown[]): Promise<QueryResult>;
    select<T>(query: string, bindValues?: unknown[]): Promise<T>;
    close(db?: string): Promise<boolean>;
  }
}
