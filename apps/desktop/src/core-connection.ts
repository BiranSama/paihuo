import type { SystemInfo, SystemInfoRequest, SystemInfoResponse } from "@paihuo/shared";
import { invoke, isTauri } from "@tauri-apps/api/core";

type CoreStatus =
  | { phase: "starting" | "restarting" | "unavailable" }
  | { phase: "ready"; port: number; token: string; restarts: number };

export type ConnectionState =
  | { phase: "starting" | "restarting" | "unavailable" | "browser" }
  | { phase: "connected"; info: SystemInfo; recovered: boolean };

const request: SystemInfoRequest = { id: "system-info", method: "system.info" };

function hasSystemInfo(value: unknown): value is SystemInfoResponse {
  if (typeof value !== "object" || value === null || !("id" in value) || value.id !== request.id) {
    return false;
  }
  if (!("result" in value) || typeof value.result !== "object" || value.result === null) {
    return false;
  }
  const info = value.result;
  return (
    "version" in info &&
    typeof info.version === "string" &&
    info.version.length > 0 &&
    "dataDir" in info &&
    typeof info.dataDir === "string" &&
    "harnesses" in info &&
    Array.isArray(info.harnesses) &&
    info.harnesses.every((harness: unknown) => harness === "claude-code" || harness === "codex") &&
    "memoryBytes" in info &&
    typeof info.memoryBytes === "number" &&
    Number.isSafeInteger(info.memoryBytes) &&
    info.memoryBytes >= 0
  );
}

export function watchCore(publish: (state: ConnectionState) => void): () => void {
  if (!isTauri()) {
    publish({ phase: "browser" });
    return () => {};
  }

  let disposed = false;
  let connectedOnce = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let active: WebSocket | undefined;

  function releaseSocket() {
    clearTimeout(timeout);
    if (active) {
      active.onopen = active.onmessage = active.onerror = active.onclose = null;
      active.close();
      active = undefined;
    }
  }

  function schedule() {
    retry = setTimeout(connect, 500);
  }

  function retryConnection() {
    releaseSocket();
    publish({ phase: connectedOnce ? "restarting" : "unavailable" });
    schedule();
  }

  async function connect() {
    try {
      const status = await invoke<CoreStatus>("core_status");
      if (disposed) return;

      if (status.phase !== "ready") {
        publish(status);
        schedule();
        return;
      }

      const socket = new WebSocket(`ws://127.0.0.1:${status.port}/`, ["paihuo.v1", status.token]);
      active = socket;
      socket.onopen = () => socket.send(JSON.stringify(request));
      socket.onerror = socket.onclose = retryConnection;
      timeout = setTimeout(retryConnection, 4_000);
      socket.onmessage = ({ data }) => {
        try {
          const response: unknown = typeof data === "string" ? JSON.parse(data) : undefined;
          if (hasSystemInfo(response)) {
            clearTimeout(timeout);
            socket.onmessage = null;
            connectedOnce = true;
            publish({ phase: "connected", info: response.result, recovered: status.restarts > 0 });
            return;
          }
        } catch {
          // 非法响应视为连接失败，保持重连状态。
        }
        retryConnection();
      };
    } catch {
      if (!disposed) retryConnection();
    }
  }

  void connect();
  return () => {
    disposed = true;
    clearTimeout(retry);
    releaseSocket();
  };
}
