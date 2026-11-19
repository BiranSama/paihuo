import type { SystemInfo, SystemInfoRequest } from "@paihuo/shared";
import { afterEach, beforeEach, expect, test } from "vitest";
import { WebSocket } from "ws";
import { startCore } from "./server";

const token = "a".repeat(64);
const origin = "http://tauri.localhost";
const info: SystemInfo = {
  version: "0.1.0",
  dataDir: "C:\\test\\paihuo",
  harnesses: ["codex"],
  memoryBytes: 1024,
};
let core: Awaited<ReturnType<typeof startCore>>;

beforeEach(async () => {
  core = await startCore({ token, origin, systemInfo: () => info });
});

afterEach(async () => {
  await core.close();
});

function connect(protocols: string[], requestedOrigin?: string) {
  return new WebSocket(`ws://127.0.0.1:${core.port}`, protocols, { origin: requestedOrigin });
}

test("校验令牌并以相同 id 返回实际的 system.info 数据", async () => {
  const connection = connect(["paihuo.v1", token], origin);
  const request: SystemInfoRequest = { id: "request-1", method: "system.info" };
  const result = await new Promise<unknown>((resolve, reject) => {
    connection.once("error", reject);
    connection.once("open", () => connection.send(JSON.stringify(request)));
    connection.once("message", (message) => resolve(JSON.parse(message.toString())));
  });
  expect(result).toEqual({ id: request.id, result: info });
  expect(connection.protocol).toBe("paihuo.v1");
});

test.each([
  { label: "缺少令牌", protocols: ["paihuo.v1"], requestedOrigin: origin },
  { label: "错误令牌", protocols: ["paihuo.v1", "b".repeat(64)], requestedOrigin: origin },
  { label: "无协议头", protocols: [], requestedOrigin: origin },
  {
    label: "不可信浏览器来源",
    protocols: ["paihuo.v1", token],
    requestedOrigin: "https://untrusted.invalid",
  },
])("$label 在升级前拒绝且错误不含令牌", async ({ protocols, requestedOrigin }) => {
  const connection = connect(protocols, requestedOrigin);
  const result = await new Promise<Error>((resolve, reject) => {
    connection.once("error", resolve);
    connection.once("open", () => reject(new Error("意外连接成功")));
  });
  expect(result.message).toBe("Unexpected server response: 401");
  expect(result.message).not.toContain(token);
});

test("同时运行的内核由系统分配不同端口", async () => {
  const second = await startCore({ token, origin, systemInfo: () => info });
  try {
    expect(core.port).toBeGreaterThan(0);
    expect(second.port).toBeGreaterThan(0);
    expect(second.port).not.toBe(core.port);
  } finally {
    await second.close();
  }
});
