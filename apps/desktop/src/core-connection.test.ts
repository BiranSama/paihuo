import { invoke, isTauri } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { watchCore } from "./core-connection";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn() }));

class Socket {
  static last: Socket;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly send = vi.fn();
  readonly close = vi.fn();

  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    Socket.last = this;
  }
}

const first = { phase: "ready", port: 49152, token: "a".repeat(64), restarts: 0 };
const second = { phase: "ready", port: 49153, token: "b".repeat(64), restarts: 1 };
const info = { version: "0.1.0", dataDir: "C:\\test", harnesses: [], memoryBytes: 2_097_152 };
const ok = JSON.stringify({ id: "system-info", result: info });

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", Socket);
  vi.mocked(isTauri).mockReturnValue(true);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

test("使用对应令牌认证，连接掉线后从外壳取得新端口和令牌", async () => {
  vi.mocked(invoke).mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  const publish = vi.fn();
  const cleanup = watchCore(publish);
  await vi.advanceTimersByTimeAsync(0);

  const initial = Socket.last;
  expect(initial.url).toBe("ws://127.0.0.1:49152/");
  expect(initial.protocols).toEqual(["paihuo.v1", first.token]);
  initial.onopen?.();
  expect(initial.send).toHaveBeenCalledWith(
    JSON.stringify({ id: "system-info", method: "system.info" }),
  );
  initial.onmessage?.({ data: ok });
  expect(publish).toHaveBeenLastCalledWith({ phase: "connected", info, recovered: false });

  initial.onclose?.();
  expect(publish).toHaveBeenLastCalledWith({ phase: "restarting" });
  await vi.advanceTimersByTimeAsync(500);
  const replacement = Socket.last;
  expect(replacement.url).toBe("ws://127.0.0.1:49153/");
  expect(replacement.protocols).toEqual(["paihuo.v1", second.token]);
  replacement.onmessage?.({ data: ok });
  expect(publish).toHaveBeenLastCalledWith({ phase: "connected", info, recovered: true });
  cleanup();
  expect(replacement.close).toHaveBeenCalledOnce();
});

test("普通浏览器页面显示桌面入口说明", () => {
  vi.mocked(isTauri).mockReturnValue(false);
  const publish = vi.fn();
  const cleanup = watchCore(publish);
  expect(publish).toHaveBeenCalledWith({ phase: "browser" });
  expect(invoke).not.toHaveBeenCalled();
  cleanup();
});

test("首次连接迟迟没有响应时会重试，卸载后不再尝试连接", async () => {
  vi.mocked(invoke).mockResolvedValue(first);
  const publish = vi.fn();
  const cleanup = watchCore(publish);
  await vi.advanceTimersByTimeAsync(0);
  const initial = Socket.last;

  await vi.advanceTimersByTimeAsync(4_000);
  expect(initial.close).toHaveBeenCalledOnce();
  expect(publish).toHaveBeenLastCalledWith({ phase: "unavailable" });
  cleanup();
  await vi.advanceTimersByTimeAsync(500);
  expect(invoke).toHaveBeenCalledOnce();
});
