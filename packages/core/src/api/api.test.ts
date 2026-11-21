import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ApiEvent,
  ApiMethod,
  ApiParams,
  ApiReply,
  ApiResults,
  Member,
  SystemInfo,
} from "@paihuo/shared";
import { FakeStaffAdapter } from "@paihuo/shared/testing";
import { buildSync } from "esbuild";
import { afterEach, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { AdapterRegistry, createDispatch } from "../dispatch";
import { startCore } from "../server";
import { openStore } from "../store";
import { createApi } from "./index";
import { EVENT_BYTES, FRAME_BYTES, TEXT_BYTES } from "./protocol";
import { sendFrame } from "./transport";

const token = "d".repeat(64);
const origin = "http://tauri.localhost";
const configMarker = "test-private-configuration";
const fixtureMember: Member = {
  id: "m",
  name: "联调成员",
  title: "校对",
  salutation: "主编",
  runtime_kind: "native",
  runtime_config: { testSetting: configMarker },
  builtin: false,
  status: "active",
  created_by: "boss",
  created_at: "2026-01-01",
  archived_at: null,
};
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

type Frame = ApiEvent | ApiReply;
class Client {
  readonly frames: Frame[] = [];
  constructor(readonly socket: WebSocket) {
    socket.on("message", (data) => this.frames.push(JSON.parse(data.toString())));
  }
  async request(message: unknown, id: string | null) {
    const index = this.frames.length;
    this.socket.send(JSON.stringify(message));
    return vi.waitFor(
      () => {
        const reply = this.frames.slice(index).find((frame) => "id" in frame && frame.id === id);
        if (!reply || !("id" in reply)) throw new Error("等待命令回执");
        return reply;
      },
      { interval: 5 },
    );
  }
  async call<M extends keyof ApiResults>(
    method: M,
    ...args: ApiParams[M] extends undefined ? [] : [ApiParams[M]]
  ) {
    const id = crypto.randomUUID();
    const reply = await this.request({ id, method, params: args[0] }, id);
    if ("error" in reply) throw new Error(reply.error.code);
    return reply.result as ApiResults[M];
  }
  event<M extends ApiEvent["event"]>(
    type: M,
    match: (event: Extract<ApiEvent, { event: M }>) => boolean = () => true,
  ) {
    return vi.waitFor(
      () => {
        const event = this.frames.find(
          (frame): frame is Extract<ApiEvent, { event: M }> =>
            "event" in frame &&
            frame.event === type &&
            frame.data !== null &&
            match(frame as Extract<ApiEvent, { event: M }>),
        );
        if (!event) throw new Error(`等待 ${type}`);
        return event;
      },
      { interval: 5 },
    );
  }
}
async function connect(port: number) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, ["paihuo.v1", token], { origin });
  const client = new Client(socket);
  await once(socket, "open");
  cleanups.push(() => socket.terminate());
  return client;
}
async function fixture(adapter = new FakeStaffAdapter()) {
  const store = openStore({ temporary: true });
  cleanups.push(store.close);
  store.members.insert(fixtureMember);
  const registry = new AdapterRegistry([adapter]);
  const dispatch = createDispatch(store, registry);
  cleanups.push(dispatch.close);
  const info: SystemInfo = {
    version: "test",
    dataDir: store.dataDir,
    harnesses: [],
    memoryBytes: 1234,
  };
  const core = await startCore({
    origin,
    token,
    systemInfo: () => info,
    api: createApi(store, dispatch, registry),
  });
  cleanups.push(core.close);
  const client = await connect(core.port);
  return { core, store, dispatch, info, client };
}

test("员工名册 → 打开私聊 → 已收到回执 → 两个界面收到相同的回复 → 按 seq 翻页", async () => {
  const f = await fixture();
  const second = await connect(f.core.port);
  const members = await f.client.call("member.list");
  expect(members.members).toEqual([
    {
      id: "m",
      name: "联调成员",
      title: "校对",
      salutation: "主编",
      runtime_kind: "native",
      builtin: false,
      activity: "idle",
    },
  ]);
  expect(await second.call("system.info")).toEqual(f.info);
  const { conversation, page } = await f.client.call("conversation.open", { memberId: "m" });
  expect(page).toEqual({ messages: [], nextCursor: null });
  const offset = f.client.frames.length;
  const receipt = await f.client.call("message.send", {
    conversationId: conversation.id,
    text: "你好，🙂",
  });
  expect(receipt.accepted).toBe(true);
  expect(f.client.frames[offset]).toHaveProperty("result.messageId", receipt.messageId);
  for (const client of [f.client, second]) {
    expect(
      (await client.event("message.created", (e) => e.data.message.author_kind === "boss")).data
        .message.id,
    ).toBe(receipt.messageId);
    const delta = await client.event("message.delta");
    expect(delta.data.text).toBe("你好，🙂");
    expect((await client.event("run.started")).data.runId).toBe(receipt.runId);
    expect((await client.event("run.ended")).data.run.state).toBe("done");
    await client.event("member.status", (e) => e.data.status === "idle");
  }
  const result = await f.client.call("message.page", {
    conversationId: conversation.id,
    direction: "after",
    limit: 1,
  });
  expect(result.nextCursor).toBe(result.messages[0]?.seq);
  const after = await f.client.call("message.page", {
    conversationId: conversation.id,
    direction: "after",
    cursor: result.nextCursor ?? 0,
  });
  expect(after.messages.map((m) => [m.author_kind, m.body])).toEqual([["member", "你好，🙂"]]);
  expect(after.nextCursor).toBeNull();
  const a = await f.client.event("message.created", (e) => e.data.message.author_kind === "member");
  const b = await second.event("message.created", (e) => e.data.message.author_kind === "member");
  expect(a).toEqual(b);
  expect(JSON.stringify(second.frames)).not.toContain(configMarker);
  expect(JSON.stringify(second.frames)).not.toContain(token);
});

test("旧版客户端首条 system.info 回执前不会被后台事件打断", async () => {
  const f = await fixture();
  const legacy = await connect(f.core.port);
  const dm = await f.client.call("conversation.open", { memberId: "m" });
  await f.client.call("message.send", { conversationId: dm.conversation.id, text: "后台" });
  await f.client.event("run.ended");
  const info = await legacy.call("system.info");
  expect(info).toEqual(f.info);
  expect(legacy.frames[0]).toHaveProperty("result.version", "test");
  await legacy.event("run.ended");
  expect(
    legacy.frames.filter((frame) => "event" in frame && frame.event === "run.ended"),
  ).toHaveLength(1);
});

test("参数、封包与未知方法分别回错误码，同一连接还能继续；非法 JSON 和二进制单独关闭", async () => {
  const f = await fixture();
  for (const [params, code] of [
    [
      { method: "message.page", params: { conversationId: "c", direction: "after", limit: 51 } },
      "INVALID_PARAMS",
    ],
    [
      { method: "message.page", params: { conversationId: "c", direction: "before", cursor: -1 } },
      "INVALID_PARAMS",
    ],
    [
      { method: "message.send", params: { conversationId: "c", text: "界".repeat(TEXT_BYTES) } },
      "INVALID_PARAMS",
    ],
    [{ method: "system.info", params: null }, "INVALID_PARAMS"],
    [{ method: "member.list", params: { bad: 3 } }, "INVALID_PARAMS"],
    [{ method: "constructor" }, "UNKNOWN_METHOD"],
    [{ method: "member.list", extra: true }, "INVALID_REQUEST"],
  ] as const)
    expect(await f.client.request({ id: "bad", ...params }, "bad")).toMatchObject({
      id: "bad",
      error: { code },
    });
  for (const value of [null, [], {}, { id: 1, method: "work.list" }])
    expect(await f.client.request(value, null)).toMatchObject({
      id: null,
      error: { code: "INVALID_REQUEST" },
    });
  expect((await f.client.call("member.list")).members).toHaveLength(1);
  for (const payload of ["{bad", Buffer.from("{}")]) {
    const client = await connect(f.core.port);
    const closed = once(client.socket, "close");
    client.socket.send(payload);
    expect((await closed)[0]).toBe(1008);
  }
});

test("六项预留命令均有有效的尚未实现回执，也能拒绝错误参数", async () => {
  const f = await fixture();
  const requests: Partial<Record<ApiMethod, unknown>> = {
    "member.create": { name: "新人", title: "校对", runtimeKind: "native" },
    "member.update": { memberId: "m", name: "新名" },
    "member.archive": { memberId: "m" },
    "session.sleep": { sessionId: "s" },
    "session.wake": { sessionId: "s" },
    "request.answer": { requestId: "r", allow: false },
  };
  for (const [method, params] of Object.entries(requests)) {
    expect(await f.client.request({ id: "reserved", method, params }, "reserved")).toMatchObject({
      error: { code: "NOT_IMPLEMENTED", message: "尚未实现" },
    });
    expect(await f.client.request({ id: "invalid", method, params: {} }, "invalid")).toMatchObject({
      error: { code: "INVALID_PARAMS" },
    });
  }
  expect((await f.client.call("member.list")).members[0]?.name).toBe("联调成员");
});

test("转义正文可使用超过旧 16 KiB 的文本帧，帧与投递字节限额分别检查", async () => {
  const f = await fixture();
  const { conversation } = await f.client.call("conversation.open", { memberId: "m" });
  const text = `边${"\u0001".repeat(TEXT_BYTES - 3)}`;
  expect(Buffer.byteLength(text)).toBe(TEXT_BYTES);
  expect(Buffer.byteLength(JSON.stringify(text))).toBeGreaterThan(TEXT_BYTES);
  const ok = await f.client.call("message.send", { conversationId: conversation.id, text });
  expect(ok.accepted).toBe(true);
  await f.client.event("run.ended");
  expect(
    (
      await f.client.call("message.page", {
        conversationId: conversation.id,
        direction: "before",
        limit: 1,
      })
    ).messages[0]?.body === text,
  ).toBe(true);
  expect(
    await f.client.request(
      {
        id: "over",
        method: "message.send",
        params: { conversationId: conversation.id, text: `${text}!` },
      },
      "over",
    ),
  ).toMatchObject({ error: { code: "INVALID_PARAMS" } });
  const oversized = await connect(f.core.port);
  const closed = once(oversized.socket, "close");
  oversized.socket.send("x".repeat(FRAME_BYTES + 1));
  expect((await closed)[0]).toBe(1009);
  expect((await f.client.call("system.info")).version).toBe("test");
});

test("一万条历史只读取有 LIMIT 的窗口，前向、后向、首末页游标正确", async () => {
  const f = await fixture();
  const dm = f.dispatch.openDm("m");
  f.store.dispatch.transaction(() => {
    for (let i = 1; i <= 10000; i++)
      f.store.messages.append({
        id: `msg-${i}`,
        conversation_id: dm.id,
        author_kind: "boss",
        author_id: null,
        body: `消息 ${i}`,
        work_item_id: null,
        created_at: "2026-01-01",
      });
  });
  const before = vi.spyOn(f.store.messages, "dmBefore"),
    after = vi.spyOn(f.store.messages, "dmAfter");
  const latest = await f.client.call("conversation.open", { memberId: "m" });
  expect(latest.page.messages.map((m) => m.seq)).toEqual(
    Array.from({ length: 50 }, (_, i) => 9951 + i),
  );
  expect(latest.page.nextCursor).toBe(9951);
  expect(before).toHaveBeenCalledWith(dm.id, undefined, 51);
  const prev = await f.client.call("message.page", {
    conversationId: dm.id,
    direction: "before",
    cursor: 9951,
    limit: 2,
  });
  expect(prev.messages.map((m) => m.seq)).toEqual([9949, 9950]);
  expect(prev.nextCursor).toBe(9949);
  const last = await f.client.call("message.page", {
    conversationId: dm.id,
    direction: "after",
    cursor: 9998,
  });
  expect(last.messages.map((m) => m.seq)).toEqual([9999, 10000]);
  expect(last.nextCursor).toBeNull();
  expect(after).toHaveBeenCalledWith(dm.id, 9998, 51);
  const none = await f.client.call("message.page", {
    conversationId: dm.id,
    direction: "before",
    cursor: 1,
  });
  expect(none).toEqual({ messages: [], nextCursor: null });
});

test("字节预算缩短页面和单条超长历史时有明确截断标记，双向遍历不跳序号", async () => {
  const f = await fixture(),
    dm = f.dispatch.openDm("m");
  const bodies = ["起", "界🙂".repeat(80_000), "\u0001".repeat(90_000), "🙂".repeat(400_000), "末"];
  for (const [i, body] of bodies.entries())
    f.store.messages.append({
      id: `large-${i}`,
      conversation_id: dm.id,
      author_kind: "member",
      author_id: "m",
      body,
      work_item_id: null,
      created_at: "now",
    });
  for (const direction of ["before", "after"] as const) {
    const seen: number[] = [];
    let cursor: number | undefined;
    for (let pages = 0; pages < 7; pages++) {
      const result = await f.client.call("message.page", {
        conversationId: dm.id,
        direction,
        cursor,
      });
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(FRAME_BYTES);
      const seq = result.messages.map((m) => m.seq);
      if (direction === "before") seen.unshift(...seq);
      else seen.push(...seq);
      for (const m of result.messages) {
        if (m.seq === 4) {
          expect(m.truncated).toBe(true);
          expect(m.body.endsWith("🙂")).toBe(true);
        } else expect(m.body === bodies[m.seq - 1]).toBe(true);
      }
      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
    }
    expect(seen).toEqual([1, 2, 3, 4, 5]);
  }
});

test("超长推送和审批不泄漏原生摘要，工作查询只返回相应工作记录", async () => {
  const huge = "🌲".repeat(25_000);
  const adapter = new FakeStaffAdapter({
    capabilities: { nativeApproval: true },
    script: () => [
      { type: "text_delta", text: huge },
      { type: "needs_approval", requestId: "permit-1", summary: configMarker },
      { type: "message_done", text: huge },
      { type: "turn_done", reason: "completed" },
    ],
  });
  const f = await fixture(adapter);
  const initializing = await connect(f.core.port);
  const dm = await f.client.call("conversation.open", { memberId: "m" });
  const task = f.dispatch.startWork({
    memberId: "m",
    conversationId: dm.conversation.id,
    title: "商量",
    goal: "任务",
  });
  expect((await f.client.event("work.updated")).data.work.id).toBe(task.work.id);
  const delta = await f.client.event("message.delta");
  expect(delta.truncated).toBe(true);
  expect(delta.data.text.endsWith("🌲")).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(delta))).toBeLessThanOrEqual(EVENT_BYTES);
  const record = await f.client.event("run.event");
  expect(record.data.approval).toEqual({ requestId: "permit-1", summary: "工具请求需要老板确认" });
  expect(JSON.stringify(record)).not.toContain(configMarker);
  await initializing.call("system.info");
  const restoredApproval = await initializing.event("run.event");
  expect(restoredApproval).toEqual(record);
  expect(initializing.frames[0]).toHaveProperty("result.version", "test");
  const native = f.store.sessions.get(task.sessionId);
  if (!native?.native_session) throw new Error("夹具缺少原生引用");
  await adapter.approve(
    { nativeSession: native.native_session, runtimeKind: native.runtime_kind, cwd: native.cwd },
    "permit-1",
    true,
  );
  const message = await f.client.event(
    "message.created",
    (e) => e.data.message.author_kind === "member",
  );
  expect(message.truncated).toBe(true);
  expect(message.data.message.truncated).toBe(true);
  expect(message.data.message.work_item_id).toBe(task.work.id);
  expect((await f.client.call("work.list")).items.map((w) => w.id)).toEqual([task.work.id]);
  const work = await f.client.call("work.get", { workId: task.work.id });
  expect(work.events.map((e) => e.run_id)).toEqual([task.runId]);
  const recoveryText = "上次的工作被中断，状态待核对";
  const otherTask = f.dispatch.startWork({
    memberId: "m",
    conversationId: dm.conversation.id,
    title: "其他工作",
    goal: "其他",
  });
  for (const item of [task.work, otherTask.work]) {
    f.store.messages.append({
      id: crypto.randomUUID(),
      conversation_id: dm.conversation.id,
      work_item_id: item.id,
      body: recoveryText,
      author_kind: "system",
      author_id: null,
      created_at: "now",
    });
  }
  const details = await f.client.call("work.get", { workId: task.work.id });
  expect(details).toMatchObject({ notices: [{ body: recoveryText, work_item_id: task.work.id }] });
  expect(
    (
      await f.client.call("message.page", {
        conversationId: dm.conversation.id,
        direction: "after",
      })
    ).messages,
  ).toEqual([]);
});

test("慢连接超过积压上限时只关闭该连接", async () => {
  const f = await fixture();
  const other = await connect(f.core.port);
  vi.spyOn(f.client.socket, "bufferedAmount", "get").mockReturnValue(2 * FRAME_BYTES);
  const closed = once(f.client.socket, "close");
  sendFrame(f.client.socket, "test");
  await closed;
  expect((await other.call("system.info")).version).toBe("test");
});

test("成员及工作列表按已发 ID 逐页读完，超大单项保留 ID 与截断标志，详情可读", async () => {
  const f = await fixture(),
    dm = f.dispatch.openDm("m");
  const ordinary = "x".repeat(16 * 1024);
  const huge = "树🙂".repeat(210_000);
  const expected: string[] = [];
  f.store.dispatch.transaction(() => {
    for (let i = 0; i < 65; i++) {
      const id = `r-${i.toString().padStart(3, "0")}`;
      expected.push(id);
      f.store.members.insert({ ...fixtureMember, id, title: i === 0 ? huge : ordinary });
      f.store.workItems.insert({
        id,
        title: id,
        goal: i === 0 ? huge : ordinary,
        owner_member_id: "m",
        status: "running",
        conversation_id: dm.id,
        dir: "fixture",
        created_at: "now",
        updated_at: "now",
      });
    }
  });
  for (const method of ["member.list", "work.list"] as const) {
    let cursor: string | null = null;
    const seen: string[] = [];
    for (let page = 0; page < 12; page++) {
      const id = `list-${page}`;
      const reply = await f.client.request(
        { id, method, ...(cursor ? { params: { cursor } } : {}) },
        id,
      );
      if ("error" in reply) throw new Error(reply.error.code);
      const data = reply.result as {
        items?: { id: string; truncated?: boolean }[];
        members?: { id: string; truncated?: boolean }[];
        nextCursor: string | null;
      };
      const rows = data.items ?? data.members ?? [];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThanOrEqual(50);
      for (const row of rows) {
        if (row.id === "r-000") expect(row.truncated).toBe(true);
        seen.push(row.id);
      }
      if (data.nextCursor === null) break;
      expect(data.nextCursor).toBe(rows.at(-1)?.id);
      cursor = data.nextCursor;
    }
    expect(seen).toEqual(method === "work.list" ? expected : ["m", ...expected]);
    const invalid = await f.client.request(
      { id: "bad-page", method, params: { limit: 51 } },
      "bad-page",
    );
    expect(invalid).toMatchObject({ error: { code: "INVALID_PARAMS" } });
  }
  const detail = await f.client.call("work.get", { workId: "r-000" });
  expect(detail.work).toMatchObject({ id: "r-000", truncated: true });
  expect(huge.startsWith(detail.work.goal)).toBe(true);
  expect(detail.work.goal.length).toBeGreaterThan(0);
  expect(f.store.workItems.get("r-000")?.goal.length).toBe(huge.length);
});

test("初始化积压超过 128 个事件时明确通知该客户端重连，已就绪客户端继续收到完整轮次", async () => {
  const f = await fixture(
    new FakeStaffAdapter({
      script: () => [
        ...Array.from({ length: 150 }, () => ({ type: "text_delta" as const, text: "片段" })),
        { type: "message_done", text: "完成" },
        { type: "turn_done", reason: "completed" },
      ],
    }),
  );
  const pending = await connect(f.core.port);
  const closed = once(pending.socket, "close");
  const dm = await f.client.call("conversation.open", { memberId: "m" });
  await f.client.call("message.send", { conversationId: dm.conversation.id, text: "测试" });
  await f.client.event("run.ended");
  expect((await closed)[0]).toBe(1013);
  expect(
    f.client.frames.filter((frame) => "event" in frame && frame.event === "message.delta"),
  ).toHaveLength(150);
});

test("生产 main 使用外壳给定的隔离数据目录，未注册适配器明确报错，关闭 stdin 后释放库锁", async () => {
  const dir = mkdtempSync(join(tmpdir(), "paihuo-api-main-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const dataDir = join(dir, "fixture");
  const seed = openStore(dataDir);
  try {
    seed.members.insert(fixtureMember);
  } finally {
    seed.close();
  }
  const outfile = join(dir, "core.cjs");
  buildSync({
    entryPoints: [fileURLToPath(new URL("../main.ts", import.meta.url))],
    outfile,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    define: { "process.env.WS_NO_BUFFER_UTIL": "true" },
  });
  const child = spawn(process.execPath, [outfile], {
    windowsHide: true,
    stdio: "pipe",
    env: { ...process.env, PATH: "" },
  });
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit");
      child.kill();
      await exit;
    }
  });
  const output = once(child.stdout, "data");
  const exit = once(child, "exit");
  child.stdin.write(`${JSON.stringify({ token, origin, dataDir })}\n`);
  const [line] = await Promise.race([
    output,
    exit.then(() => {
      throw new Error("内核未就绪即退出");
    }),
  ]);
  const { port } = JSON.parse(line.toString()) as { port: number };
  const client = await connect(port);
  expect((await client.call("system.info")).dataDir).toBe(dataDir);
  expect((await client.call("member.list")).members.map((m) => m.id)).toEqual(["m"]);
  const { conversation } = await client.call("conversation.open", { memberId: "m" });
  expect(
    await client.request(
      {
        id: "send",
        method: "message.send",
        params: { conversationId: conversation.id, text: "真实接线" },
      },
      "send",
    ),
  ).toMatchObject({ error: { code: "ADAPTER_NOT_READY" } });
  child.stdin.end();
  expect((await exit)[0]).toBe(0);
  expect(existsSync(join(dataDir, "paihuo.db"))).toBe(true);
  const reopened = openStore(dataDir);
  try {
    expect(reopened.messages.dmAfter(conversation.id, undefined, 10)).toEqual([]);
  } finally {
    reopened.close();
  }
});
