import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Member } from "@paihuo/shared";
import {
  type AdapterEvent,
  type NativeSessionRef,
  StaffAdapterError,
  type TurnInput,
} from "@paihuo/shared/staff";
import { FakeStaffAdapter } from "@paihuo/shared/testing";
import { afterEach, expect, test, vi } from "vitest";
import { openStore, type Store } from "../store";
import { AdapterRegistry, createDispatch, type DispatchEvent } from "./index";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function member(id: string): Member {
  return {
    id,
    name: `成员${id}`,
    title: "校对",
    salutation: "主编",
    runtime_kind: "native",
    runtime_config: {},
    builtin: false,
    status: "active",
    created_by: "boss",
    created_at: new Date().toISOString(),
    archived_at: null,
  };
}

function setup(
  adapter = new FakeStaffAdapter(),
  options: Parameters<typeof createDispatch>[2] = {},
) {
  const store = openStore({ temporary: true });
  cleanups.push(store.close);
  const events: DispatchEvent[] = [];
  const errors: unknown[] = [];
  const dispatch = createDispatch(store, new AdapterRegistry([adapter]), {
    onEvent: (event) => events.push(event),
    onError: (error) => errors.push(error),
    ...options,
  });
  for (const id of ["a", "b"]) store.members.insert(member(id));
  function work(goal: string, id = "a") {
    return dispatch.startWork({
      memberId: id,
      conversationId: dispatch.openDm(id).id,
      title: goal,
      goal,
    });
  }
  return { store, adapter, dispatch, events, errors, work };
}
type Fixture = ReturnType<typeof setup>;
type Receipt = { runId: string; sessionId: string };
function waitForEnd({ store }: Fixture, receipt: Receipt, state = "done") {
  return vi.waitFor(() => expect(store.runs.get(receipt.runId)?.state).toBe(state));
}
function ref(store: Store, receipt: Receipt): NativeSessionRef {
  const s = store.sessions.get(receipt.sessionId);
  if (!s?.native_session) throw new Error("测试会话尚未启动");
  return { runtimeKind: s.runtime_kind, nativeSession: s.native_session, cwd: s.cwd };
}

// 审批事件是可控屏障。测试在明确观察到两条会话都进入适配器后才释放。
function barrier(interrupt = true) {
  return new FakeStaffAdapter({
    capabilities: { nativeApproval: true, interrupt },
    script: ({ text }) => [
      { type: "needs_approval", requestId: text, summary: "等待测试许可" },
      { type: "text_delta", text: `片段 ${text}` },
      { type: "message_done", text: `答复 ${text}` },
      { type: "turn_done", reason: "completed" },
    ],
  });
}
function waiting(f: Fixture, receipt: Receipt) {
  return vi.waitFor(() =>
    expect(
      f.events.some(
        (event) => event.type === "run.event" && event.runId === receipt.runId && event.approval,
      ),
    ).toBe(true),
  );
}
async function release(f: Fixture, receipt: Receipt, text: string) {
  await f.adapter.approve(ref(f.store, receipt), text, true);
  await waitForEnd(f, receipt);
}

test("1 首次发私聊才打开原生会话，复用同一场合及前言", async () => {
  const f = setup();
  const start = vi.spyOn(f.adapter, "start");
  const chat = f.dispatch.openDm("a");
  expect(f.dispatch.openDm("a")).toEqual(chat);
  expect(start).not.toHaveBeenCalled();
  const one = f.dispatch.sendMessage(chat.id, "甲");
  await waitForEnd(f, one);
  const two = f.dispatch.sendMessage(chat.id, "乙");
  await waitForEnd(f, two);
  expect(start).toHaveBeenCalledTimes(1);
  for (const text of ["成员a", "校对", "主编", "保持安静", "具体问题", "群内"])
    expect(start.mock.calls[0]?.[0].preamble).toContain(text);
  expect(one.sessionId).toBe(two.sessionId);
  expect(f.store.messages.dmAfter(chat.id, undefined, 10).map((m) => m.body)).toEqual([
    "甲",
    "甲",
    "乙",
    "乙",
  ]);
});

test("2 同会话三条回执即刻可查 queued，阻塞首轮时其余不启动，释放后保持 FIFO", async () => {
  const f = setup(barrier());
  const start = vi.spyOn(f.adapter, "start");
  const chat = f.dispatch.openDm("a");
  const entries = ["一", "二", "三"].map((text) => ({
    text,
    ...f.dispatch.sendMessage(chat.id, text),
  }));
  for (const entry of entries) expect(f.store.runs.get(entry.runId)?.state).toBe("queued");
  for (const [index, entry] of entries.entries()) {
    await waiting(f, entry);
    expect(entries.map((e) => f.store.runs.get(e.runId)?.state)).toEqual(
      entries.map((_, i) => (i < index ? "done" : i === index ? "running" : "queued")),
    );
    await release(f, entry, entry.text);
  }
  expect(f.events.filter((e) => e.type === "run.started").map((e) => e.runId)).toEqual(
    entries.map((e) => e.runId),
  );
  expect(start).toHaveBeenCalledTimes(1);
});

test("3 不同成员私聊同时进入适配器，不占任务额度", async () => {
  const f = setup(barrier(), { taskConcurrency: 1 });
  const a = f.dispatch.sendMessage(f.dispatch.openDm("a").id, "a");
  const b = f.dispatch.sendMessage(f.dispatch.openDm("b").id, "b");
  await Promise.all([waiting(f, a), waiting(f, b)]);
  expect(f.dispatch.memberStatus("a")).toBe("working");
  await release(f, b, "b");
  expect(f.dispatch.memberStatus("a")).toBe("working");
  await release(f, a, "a");
  expect(f.dispatch.memberStatus("a")).toBe("idle");
});

test("4 同一成员的私聊和任务并行，各用自己的原生会话、工作目录、消息和事件", async () => {
  const f = setup(barrier());
  const chat = f.dispatch.openDm("a");
  const dm = f.dispatch.sendMessage(chat.id, "私聊");
  await waiting(f, dm);
  const task = f.work("任务");
  await waiting(f, task);
  expect(ref(f.store, dm).nativeSession).not.toBe(ref(f.store, task).nativeSession);
  expect(ref(f.store, task).cwd).toBe(task.work.dir);
  expect(existsSync(task.work.dir)).toBe(true);
  expect(ref(f.store, dm).cwd).not.toBe(task.work.dir);
  await release(f, task, "任务");
  expect(f.dispatch.memberStatus("a")).toBe("working");
  await release(f, dm, "私聊");
  expect(f.store.messages.dmBefore(chat.id, undefined, 20).map((m) => m.body)).toEqual([
    "私聊",
    "答复 私聊",
  ]);
  const scoped = f.store.messages
    .before(chat.id, undefined, 20)
    .filter((m) => m.work_item_id === task.work.id);
  expect(scoped.map((m) => m.body)).toEqual(["任务", "答复 任务"]);
  for (const event of f.events.filter((e) => e.type === "message.delta")) {
    const privateMessage = event.runId === dm.runId;
    expect(event.workItemId).toBe(privateMessage ? null : task.work.id);
    expect(event.sessionId).toBe(privateMessage ? dm.sessionId : task.sessionId);
    expect(event.text).toBe(privateMessage ? "片段 私聊" : "片段 任务");
  }
  expect(f.events.filter((e) => e.type === "member.status").map((e) => e.status)).toEqual([
    "working",
    "idle",
  ]);
  expect((await f.dispatch.finishWork(task.work.id)).status).toBe("done");
  expect(f.store.sessions.get(task.sessionId)?.state).toBe("archived");
  expect(f.store.dispatch.listWork().map((w) => w.id)).toEqual([task.work.id]);
  expect(f.store.dispatch.recentWorkEvents(task.work.id).map((e) => e.run_id)).toEqual([
    task.runId,
  ]);
  expect(f.store.dispatch.listMemberIds()).toEqual(["a", "b"]);
});

test("5 任务槽已满且下一工作已在排队，负责人的私聊仍可立即执行", async () => {
  const f = setup(barrier(), { taskConcurrency: 1 });
  const task = f.work("第一");
  const next = f.work("第二");
  await waiting(f, task);
  const dm = f.dispatch.sendMessage(f.dispatch.openDm("a").id, "追问");
  await waiting(f, dm);
  expect(f.store.runs.get(next.runId)?.state).toBe("queued");
  await release(f, dm, "追问");
  await release(f, task, "第一");
  await waiting(f, next);
  await release(f, next, "第二");
});

test("6 默认四个任务槽，第五个等名额释放才启动原生会话", async () => {
  const f = setup(barrier());
  const start = vi.spyOn(f.adapter, "start");
  const [a, b, c, d, e] = [
    f.work("一"),
    f.work("二"),
    f.work("三"),
    f.work("四"),
    f.work("五"),
  ] as const;
  await Promise.all([a, b, c, d].map((r) => waiting(f, r)));
  expect(start).toHaveBeenCalledTimes(4);
  expect(f.store.sessions.get(e.sessionId)?.native_session).toBeNull();
  expect(f.store.runs.get(e.runId)?.state).toBe("queued");
  await release(f, b, "二");
  await waiting(f, e);
  expect(start).toHaveBeenCalledTimes(5);
  await Promise.all([
    release(f, a, "一"),
    release(f, c, "三"),
    release(f, d, "四"),
    release(f, e, "五"),
  ]);
});

test("7 工具、错误事件只落一行分类摘要；临时片段和原始输出在数据库文件中均找不到", async () => {
  const raw = "sensitive-test-output-12345";
  const transient = "transient-test-delta-12345";
  const f = setup(
    new FakeStaffAdapter({
      script: () => [
        { type: "tool_started", name: "Bash", summary: raw },
        { type: "tool_finished", name: raw, ok: false, summary: `首行\n${raw}` },
        { type: "error", message: raw, recoverable: true },
        { type: "text_delta", text: transient },
        { type: "message_done", text: "老板可见结论" },
        { type: "turn_done", reason: "completed" },
      ],
    }),
  );
  const receipt = f.work("记录");
  await waitForEnd(f, receipt);
  expect(
    f.store.dispatch.recentWorkEvents(receipt.work.id).map((r) => [r.seq, r.kind, r.summary]),
  ).toEqual([
    [1, "tool_started", "Bash开始执行"],
    [2, "tool_finished", "工具执行失败"],
    [3, "error", "适配器报告可恢复错误"],
  ]);
  const data = readFileSync(join(f.store.dataDir, "paihuo.db"));
  expect(data.includes(Buffer.from(raw))).toBe(false);
  expect(data.includes(Buffer.from(transient))).toBe(false);
  expect(data.includes(Buffer.from("老板可见结论"))).toBe(true);
});

test("8 中途抛错仍释放会话，下一轮正常完成", async () => {
  class ThrowOnce extends FakeStaffAdapter {
    override async *send(
      reference: NativeSessionRef,
      input: TurnInput,
    ): AsyncGenerator<AdapterEvent> {
      if (input.text === "失败") {
        yield { type: "text_delta", text: "开始" };
        throw new StaffAdapterError("other", "不能写入原始错误细节");
      }
      yield* super.send(reference, input);
    }
  }
  const f = setup(new ThrowOnce());
  const chat = f.dispatch.openDm("a");
  const one = f.dispatch.sendMessage(chat.id, "失败");
  const two = f.dispatch.sendMessage(chat.id, "成功");
  await waitForEnd(f, one, "failed");
  await waitForEnd(f, two);
  expect(f.store.runs.get(one.runId)?.end_reason).toBe("other");
  expect(f.errors).toEqual([]);
  expect(f.events.filter((e) => e.type === "run.ended").map((e) => e.runId)).toEqual([
    one.runId,
    two.runId,
  ]);
});

test("摘要入库故障仍终结运行，后续会话可以继续执行", async () => {
  const f = setup(
    new FakeStaffAdapter({
      script: ({ text }) =>
        text === "触发记录"
          ? [
              { type: "tool_started", name: "Read", summary: "读" },
              { type: "turn_done", reason: "completed" },
            ]
          : [{ type: "turn_done", reason: "completed" }],
    }),
  );
  vi.spyOn(f.store.runEvents, "insert").mockImplementation(() => {
    throw new Error("模拟摘要写入失败");
  });
  const chat = f.dispatch.openDm("a");
  const first = f.dispatch.sendMessage(chat.id, "触发记录");
  const second = f.dispatch.sendMessage(chat.id, "新一轮");
  await waitForEnd(f, first, "failed");
  await waitForEnd(f, second);
  expect(f.errors).toHaveLength(1);
});

test("9 原生审批仅通知并登记，显式拒绝后才结束；中断原因正确映射", async () => {
  const f = setup(barrier());
  const approve = vi.spyOn(f.adapter, "approve");
  const task = f.work("审批");
  await waiting(f, task);
  expect(approve).not.toHaveBeenCalled();
  expect(f.store.runs.get(task.runId)?.state).toBe("running");
  expect(f.store.dispatch.recentWorkEvents(task.work.id)[0]).toMatchObject({
    kind: "note",
    summary: "工具请求需要老板确认",
  });
  expect(f.events.find((e) => e.type === "run.event")).toMatchObject({
    approval: { requestId: "审批", summary: "等待测试许可" },
  });
  await f.adapter.approve(ref(f.store, task), "审批", false);
  await waitForEnd(f, task, "failed");
  const dm = f.dispatch.sendMessage(f.dispatch.openDm("a").id, "中断");
  await waiting(f, dm);
  await f.adapter.interrupt(ref(f.store, dm));
  await waitForEnd(f, dm, "cancelled");
});

test("10 冷启动将同会话多轮中断汇总为一条持久提示；反复启动无重放或重复，下一次中断仍通知", async () => {
  const dir = mkdtempSync(join(tmpdir(), "paihuo-dispatch-recovery-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const adapter = new FakeStaffAdapter();
  const registry = new AdapterRegistry([adapter]);
  const start = vi.spyOn(adapter, "start");
  const resume = vi.spyOn(adapter, "resume");
  const send = vi.spyOn(adapter, "send");
  const open = () => {
    const result = openStore(dir);
    cleanups.push(result.close);
    return result;
  };
  const first = open();
  first.members.insert(member("a"));
  const dispatch = createDispatch(first, registry);
  const chat = dispatch.openDm("a");
  const receipt = dispatch.sendMessage(chat.id, "首次");
  await vi.waitFor(() => expect(first.runs.get(receipt.runId)?.state).toBe("done"));
  const oldRun = first.runs.get(receipt.runId);
  if (!oldRun) throw new Error("测试运行缺失");
  first.runs.insert({ ...oldRun, id: "old-running", state: "running", end_reason: null });
  first.runs.insert({ ...oldRun, id: "old-queued", state: "queued", end_reason: null });
  first.close();
  const second = open();
  const notices: DispatchEvent[] = [];
  createDispatch(second, registry, { onEvent: (e) => notices.push(e) });
  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatchObject({
    type: "message.created",
    message: { author_kind: "system", body: "上次的工作被中断，状态待核对" },
  });
  expect(second.runs.get("old-running")?.state).toBe("unknown");
  second.close();
  const third = open();
  const fresh = createDispatch(third, registry, { onEvent: (e) => notices.push(e) });
  expect(notices).toHaveLength(1);
  expect(send).toHaveBeenCalledTimes(1);
  const manual = fresh.sendMessage(chat.id, "新的请求");
  await vi.waitFor(() => expect(third.runs.get(manual.runId)?.state).toBe("done"));
  expect(start).toHaveBeenCalledTimes(1);
  expect(resume).toHaveBeenCalledTimes(1);
  third.runs.insert({ ...oldRun, id: "later", state: "queued", end_reason: null });
  third.close();
  const last = open();
  createDispatch(last, registry);
  expect(
    last.messages.dmAfter(chat.id, undefined, 20).filter((m) => m.author_kind === "system"),
  ).toHaveLength(2);
});

test("11 一万条历史存在时仅按本轮消息主键取一次，不调用任何消息分页", async () => {
  const f = setup();
  const chat = f.dispatch.openDm("a");
  f.store.dispatch.transaction(() => {
    for (let i = 0; i < 10_000; i++)
      f.store.messages.append({
        id: `history-${i}`,
        conversation_id: chat.id,
        author_kind: "boss",
        author_id: null,
        body: "历史",
        work_item_id: null,
        created_at: "2026-01-01",
      });
  });
  for (const method of ["before", "after", "dmBefore", "dmAfter"] as const)
    vi.spyOn(f.store.messages, method).mockImplementation(() => {
      throw new Error("意外读取历史");
    });
  const get = vi.spyOn(f.store.messages, "get");
  const receipt = f.dispatch.sendMessage(chat.id, "新消息");
  await waitForEnd(f, receipt);
  expect(get.mock.calls).toEqual([[receipt.messageId]]);
  expect(f.store.messages.get(receipt.messageId)?.seq).toBe(10_001);
});

test("投递事务失败回滚工作目录、工作、会话及消息，且不通知或启动原生会话", () => {
  const f = setup();
  const chat = f.dispatch.openDm("a");
  const start = vi.spyOn(f.adapter, "start");
  vi.spyOn(f.store.runs, "insert").mockImplementation(() => {
    throw new Error("注入失败");
  });
  expect(() => f.work("不能部分写入")).toThrow("注入失败");
  expect(readdirSync(join(f.store.dataDir, "work"))).toEqual([]);
  expect(f.store.dispatch.listWork()).toEqual([]);
  expect(() => f.dispatch.sendMessage(chat.id, "回滚")).toThrow("注入失败");
  expect(f.store.dispatch.currentSession("a", "dm", chat.id)).toBeUndefined();
  expect(f.store.messages.before(chat.id, undefined, 10)).toEqual([]);
  expect(f.events).toEqual([]);
  expect(start).not.toHaveBeenCalled();
});

test("异步前言阻塞时同会话只启动一次；启动失败后新的人工消息能重试", async () => {
  const gate = Promise.withResolvers<string>();
  let fail = true;
  const f = setup(
    new FakeStaffAdapter({
      failure: (op) => {
        if (op === "start" && fail) {
          fail = false;
          return new StaffAdapterError("harness_not_installed", "测试");
        }
      },
    }),
    { preamble: () => gate.promise },
  );
  const start = vi.spyOn(f.adapter, "start");
  const chat = f.dispatch.openDm("a");
  const one = f.dispatch.sendMessage(chat.id, "失败"),
    two = f.dispatch.sendMessage(chat.id, "重试");
  await vi.waitFor(() => expect(f.store.runs.get(one.runId)?.state).toBe("running"));
  expect(start).not.toHaveBeenCalled();
  expect(f.store.runs.get(two.runId)?.state).toBe("queued");
  gate.resolve("注入前言");
  await waitForEnd(f, one, "failed");
  await waitForEnd(f, two);
  expect(start).toHaveBeenCalledTimes(2);
  expect(start.mock.calls[1]?.[0].preamble).toBe("注入前言");
});

test("同一工作并发结束共用一次休眠，工作和会话同时提交，只发一次完成事件", async () => {
  const f = setup();
  const task = f.work("结束");
  await waitForEnd(f, task);
  const gate = Promise.withResolvers<void>();
  const sleep = f.adapter.sleep.bind(f.adapter);
  const sleeps = vi.spyOn(f.adapter, "sleep").mockImplementation(async (ref) => {
    await gate.promise;
    await sleep(ref);
  });
  const first = f.dispatch.finishWork(task.work.id);
  const second = f.dispatch.finishWork(task.work.id);
  await vi.waitFor(() => expect(sleeps).toHaveBeenCalledTimes(1));
  expect(f.store.workItems.get(task.work.id)?.status).toBe("running");
  expect(f.store.sessions.get(task.sessionId)?.state).toBe("active");
  gate.resolve();
  const [one, two] = await Promise.all([first, second]);
  expect(one).toEqual(two);
  expect((await f.dispatch.finishWork(task.work.id)).status).toBe("done");
  expect(f.store.sessions.get(task.sessionId)?.state).toBe("archived");
  expect(sleeps).toHaveBeenCalledTimes(1);
  expect(
    f.events.filter((e) => e.type === "work.updated" && e.work.status === "done"),
  ).toHaveLength(1);
});

test("运行中可请求完成且不阻塞该轮，休眠失败时保留可重试状态", async () => {
  const f = setup(barrier());
  const task = f.work("进行中");
  await waiting(f, task);
  const sleep = vi.spyOn(f.adapter, "sleep").mockRejectedValueOnce(new Error("模拟休眠失败"));
  expect((await f.dispatch.finishWork(task.work.id)).status).toBe("running");
  expect((await f.dispatch.finishWork(task.work.id)).status).toBe("running");
  expect(sleep).not.toHaveBeenCalled();
  await release(f, task, "进行中");
  await vi.waitFor(() => expect(f.errors).toHaveLength(1));
  expect(f.store.workItems.get(task.work.id)?.status).toBe("running");
  expect(f.store.sessions.get(task.sessionId)?.state).toBe("active");
  expect(
    f.events.filter((e) => e.type === "work.updated" && e.work.status === "done"),
  ).toHaveLength(0);
  expect((await f.dispatch.finishWork(task.work.id)).status).toBe("done");
  expect(f.store.sessions.get(task.sessionId)?.state).toBe("archived");
  expect(sleep).toHaveBeenCalledTimes(2);
  expect(
    f.events.filter((e) => e.type === "work.updated" && e.work.status === "done"),
  ).toHaveLength(1);
});

test("审批悬挂时同步关调度、立即关库，迟到事件不能写入，重启仅提示", async () => {
  const dir = mkdtempSync(join(tmpdir(), "paihuo-dispatch-close-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = openStore(dir);
  cleanups.push(store.close);
  const adapter = barrier();
  const registry = new AdapterRegistry([adapter]);
  const events: DispatchEvent[] = [];
  const errors: unknown[] = [];
  const dispatch = createDispatch(store, registry, {
    onEvent: (e) => events.push(e),
    onError: (e) => errors.push(e),
  });
  store.members.insert(member("a"));
  const chat = dispatch.openDm("a");
  const active = dispatch.sendMessage(chat.id, "待批准");
  const queued = dispatch.sendMessage(chat.id, "排队");
  await vi.waitFor(() =>
    expect(events.some((e) => e.type === "run.event" && e.approval)).toBe(true),
  );
  const interrupted = vi.spyOn(adapter, "interrupt"),
    slept = vi.spyOn(adapter, "sleep");
  const count = events.length;
  dispatch.close();
  dispatch.close();
  store.close();
  expect(() => dispatch.sendMessage(chat.id, "已经关闭")).toThrow("调度器已关闭");
  await vi.waitFor(() => expect(slept).toHaveBeenCalledTimes(1));
  expect(interrupted).toHaveBeenCalledTimes(1);
  expect(events).toHaveLength(count);
  expect(errors).toEqual([]);
  const next = openStore(dir);
  cleanups.push(next.close);
  expect(next.runs.get(active.runId)?.state).toBe("unknown");
  expect(next.runs.get(queued.runId)?.state).toBe("unknown");
  createDispatch(next, registry);
  expect(next.messages.dmBefore(chat.id, undefined, 10).map((m) => m.author_kind)).toEqual([
    "boss",
    "boss",
    "system",
  ]);
});

test("不支持中断的运行时拒绝忙时休眠，关库后流退出时仍会成功释放原生会话", async () => {
  const f = setup(barrier(false));
  const receipt = f.dispatch.sendMessage(f.dispatch.openDm("a").id, "等候");
  await waiting(f, receipt);
  const native = ref(f.store, receipt);
  const sleep = vi.spyOn(f.adapter, "sleep");
  const interrupt = vi.spyOn(f.adapter, "interrupt");
  f.dispatch.close();
  f.store.close();
  await vi.waitFor(() => expect(sleep).toHaveBeenCalledTimes(1));
  await expect(sleep.mock.results[0]?.value).rejects.toThrow("原生会话正在运行");
  await f.adapter.approve(native, "等候", true);
  await vi.waitFor(() => expect(sleep).toHaveBeenCalledTimes(2));
  await expect(sleep.mock.results[1]?.value).resolves.toBeUndefined();
  expect(interrupt).not.toHaveBeenCalled();
  expect(f.errors).toHaveLength(1);
});

test.each(["preamble", "start"] as const)(
  "异步 %s 挂起时关闭，迟到的原生启动只清理不落库",
  async (stage) => {
    const gate = Promise.withResolvers<void>();
    const preamble = vi.fn(async () => {
      if (stage === "preamble") await gate.promise;
      return "前言";
    });
    const f = setup(new FakeStaffAdapter(), { preamble });
    const realStart = f.adapter.start.bind(f.adapter);
    const start = vi.spyOn(f.adapter, "start").mockImplementation(async (input) => {
      if (stage === "start") await gate.promise;
      return realStart(input);
    });
    const sleep = vi.spyOn(f.adapter, "sleep"),
      send = vi.spyOn(f.adapter, "send");
    const chat = f.dispatch.openDm("a");
    f.dispatch.sendMessage(chat.id, "待启动");
    await vi.waitFor(() =>
      expect(stage === "preamble" ? preamble : start).toHaveBeenCalledTimes(1),
    );
    const count = f.events.length;
    f.dispatch.close();
    f.store.close();
    gate.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    expect(sleep).toHaveBeenCalledTimes(stage === "start" ? 1 : 0);
    expect(start).toHaveBeenCalledTimes(stage === "start" ? 1 : 0);
    expect(send).not.toHaveBeenCalled();
    expect(f.events).toHaveLength(count);
    expect(f.errors).toEqual([]);
  },
);
