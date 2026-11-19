import type { SystemInfoRequest } from "@paihuo/shared";
import {
  type AdapterEvent,
  type NativeSessionRef,
  StaffAdapterError,
  type StaffErrorCode,
  type TurnInput,
} from "@paihuo/shared/staff";
import { FakeStaffAdapter, runStaffContract } from "@paihuo/shared/testing";
import { describe, expect, it, vi } from "vitest";

async function drain(source: AsyncIterable<AdapterEvent>): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}

const startInput = { memberId: "member", cwd: ".", preamble: "初次启动", runtimeConfig: {} };
const completed: AdapterEvent = { type: "turn_done", reason: "completed" };
const approval: AdapterEvent = {
  type: "needs_approval",
  requestId: "ask",
  summary: "读取测试数据",
};

function reply(text: string): AdapterEvent[] {
  return [{ type: "message_done", text }, completed];
}

describe("共用员工契约", () => {
  it("从包入口对默认工厂运行七个场景，原内核类型仍可导入", async () => {
    const command: SystemInfoRequest = { id: "contract", method: "system.info" };
    expect(command.method).toBe("system.info");
    expect(await runStaffContract(() => new FakeStaffAdapter())).toEqual({
      turn: "passed",
      resume: "supported",
      guide: "supported",
      interrupt: "supported",
      parallel: "supported",
      images: "refused",
      nativeApproval: "refused",
    });
  });

  it("关闭六项能力后分别验证拒绝分支", async () => {
    const capabilities = {
      resume: false,
      guide: false,
      interrupt: false,
      parallel: false,
      images: false,
      nativeApproval: false,
    };
    expect(await runStaffContract(() => new FakeStaffAdapter({ capabilities }))).toEqual({
      turn: "passed",
      resume: "refused",
      guide: "refused",
      interrupt: "refused",
      parallel: "refused",
      images: "refused",
      nativeApproval: "refused",
    });
  });

  it("使用同一工厂入口验证恢复上下文、接收图片和原生审批", async () => {
    const outcomes = await runStaffContract(
      () =>
        new FakeStaffAdapter({
          capabilities: { images: true, nativeApproval: true },
          script: (input, { previousInputs }) => {
            if (input.text === "审批") return [approval, completed];
            if (input.text === "回忆") return reply(previousInputs.at(-1)?.text ?? "");
            return reply(input.text);
          },
        }),
      {
        approvalInput: { text: "审批" },
        acceptApproval: (request) => request.summary === "读取测试数据",
        recallInput: { text: "回忆" },
      },
    );
    expect(Object.values(outcomes)).toEqual(["passed", ...Array(6).fill("supported")]);
  });

  it.each([
    { events: [completed, completed], message: "实际为 2" },
    { events: [], message: "实际为 0" },
    { events: [completed, { type: "text_delta", text: "晚到" }], message: "turn_done 后还有事件" },
  ] satisfies { events: AdapterEvent[]; message: string }[])(
    "检出非法流 $message",
    async ({ events, message }) => {
      await expect(
        runStaffContract(() => new FakeStaffAdapter({ script: () => events })),
      ).rejects.toThrow(message);
    },
  );

  it("使用回忆夹具时，静默重建会话、忘掉上一轮的实现必须失败", async () => {
    await expect(
      runStaffContract(() => new FakeStaffAdapter(), {
        recallInput: { text: "上轮的标记？" },
      }),
    ).rejects.toThrow("原引用恢复后无法返回预期的标记");
  });

  it("能力声明为拒绝时，已产生事件再抛错同样不通过", async () => {
    class LateImageRejection extends FakeStaffAdapter {
      override async *send(ref: NativeSessionRef, input: TurnInput): AsyncGenerator<AdapterEvent> {
        if (input.attachments?.length) {
          yield { type: "tool_started", name: "read", summary: "偷偷读图" };
          throw new StaffAdapterError("unsupported_capability", "事后拒绝");
        }
        yield* super.send(ref, input);
      }
    }
    await expect(runStaffContract(() => new LateImageRejection())).rejects.toThrow(
      "不支持的投递仍然产生了事件",
    );
  });

  it("检出收下引导却丢掉消息的适配器", async () => {
    class DropsGuide extends FakeStaffAdapter {
      override async guide() {
        return { accepted: true };
      }
    }
    await expect(runStaffContract(() => new DropsGuide())).rejects.toThrow(
      "本轮收到的引导与 accepted 不符",
    );
  });

  it.each([false, true])("传输层并行屏障检查，整轮缓冲=%s", async (buffered) => {
    const active = new Set<string>();
    const sent = new Set<string>();
    const release = Promise.withResolvers<void>();
    const blocked = Promise.withResolvers<void>();
    const timeout = 3000;
    let expired = false;

    // 底层第一轮给出首事件后，必须等 B 已下发才可结束。
    async function* transport(
      ref: NativeSessionRef,
      input: TurnInput,
    ): AsyncGenerator<AdapterEvent> {
      const first = sent.size === 0;
      sent.add(ref.nativeSession);
      active.add(ref.nativeSession);
      try {
        yield { type: "text_delta", text: input.text };
        if (first) {
          blocked.resolve();
          await release.promise;
        }
        yield completed;
      } finally {
        active.delete(ref.nativeSession);
      }
    }
    class ObservedAdapter extends FakeStaffAdapter {
      override async *send(ref: NativeSessionRef, input: TurnInput): AsyncGenerator<AdapterEvent> {
        const source = transport(ref, input);
        if (buffered) yield* await drain(source);
        else yield* source;
      }
    }

    vi.useFakeTimers();
    const watchdog = setTimeout(() => {
      expired = true;
      release.resolve();
    }, timeout);
    try {
      const run = runStaffContract(
        (scenario) => (scenario === "parallel" ? new ObservedAdapter() : new FakeStaffAdapter()),
        {
          assertParallelOverlap: (a, b) => {
            if (expired || !active.has(a.nativeSession) || !active.has(b.nativeSession)) {
              throw new Error("B 的首事件未在 A 底层结束前到达");
            }
            release.resolve();
          },
        },
      );
      if (buffered) {
        const failure = expect(run).rejects.toThrow("B 的首事件未在 A 底层结束前到达");
        await blocked.promise;
        await vi.advanceTimersByTimeAsync(timeout);
        await failure;
      } else {
        expect((await run).parallel).toBe("supported");
      }
    } finally {
      clearTimeout(watchdog);
      release.resolve();
      vi.useRealTimers();
    }
  });

  it("检出套用另一条会话回复的适配器", async () => {
    await expect(
      runStaffContract((scenario) => {
        if (scenario !== "parallel") return new FakeStaffAdapter();
        let first = "";
        return new FakeStaffAdapter({
          script: (input) => {
            first ||= input.text;
            return reply(first);
          },
        });
      }),
    ).rejects.toThrow("两条会话的标记缺失或串线");
  });
});

describe("内存原生会话", () => {
  it("休眠期间不能投递，序列化后的原引用恢复了之前的输入和新前言", async () => {
    const adapter = new FakeStaffAdapter({
      script: (input, { previousInputs, preamble }) =>
        reply([preamble, ...previousInputs.map((x) => x.text), input.text].join("|")),
    });
    const ref = await adapter.start(startInput);
    expect(await drain(adapter.send(ref, { text: "甲" }))).toEqual(reply("初次启动|甲"));
    await adapter.sleep(ref);
    await expect(drain(adapter.send(ref, { text: "不应进入历史" }))).rejects.toMatchObject({
      code: "other",
    });
    await adapter.resume(structuredClone(ref), "恢复启动");
    expect(await drain(adapter.send(ref, { text: "乙" }))).toEqual(reply("恢复启动|甲|乙"));
    await adapter.sleep(ref);
    adapter.loseSession(ref);
    await expect(adapter.resume(ref, "")).rejects.toMatchObject({ code: "native_session_lost" });
  });

  it.each([
    "harness_not_installed",
    "harness_not_authenticated",
    "interrupted",
    "other",
  ] satisfies StaffErrorCode[])("可注入可辨认错误 %s", async (code) => {
    const failure = new StaffAdapterError(code, "模拟启动失败");
    const adapter = new FakeStaffAdapter({
      failure: (operation) => (operation === "start" ? failure : undefined),
    });
    await expect(adapter.start(startInput)).rejects.toBe(failure);
    expect(failure.code).toBe(code);
  });

  it("脚本按顺序回放工具摘要、错误和失败结束事件", async () => {
    const events: AdapterEvent[] = [
      { type: "tool_started", name: "read", summary: "读测试文件" },
      { type: "tool_finished", name: "read", ok: false, summary: "文件不存在" },
      { type: "error", message: "测试失败", recoverable: true },
      { type: "turn_done", reason: "failed" },
    ];
    const adapter = new FakeStaffAdapter({ script: () => events });
    expect(await drain(adapter.send(await adapter.start(startInput), { text: "测试" }))).toEqual(
      events,
    );
  });

  it("一轮收到终结事件即可开始下一轮，旧迭代器的清理不影响新轮次", async () => {
    const adapter = new FakeStaffAdapter({ script: (input) => reply(input.text) });
    const ref = await adapter.start(startInput);
    const first = adapter.send(ref, { text: "甲" });
    await first.next();
    expect((await first.next()).value).toEqual(completed);
    expect(await adapter.guide(ref, { text: "晚到" })).toEqual({ accepted: false });
    const next = adapter.send(ref, { text: "乙" });
    expect((await next.next()).value).toMatchObject({ text: "乙" });
    expect((await first.next()).done).toBe(true);
    await adapter.interrupt(ref);
    expect(await drain(next)).toEqual([{ type: "turn_done", reason: "interrupted" }]);
  });

  it("事件延迟可控，等待中的下一条事件可被立即打断", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new FakeStaffAdapter({ delayMs: 500 });
      const ref = await adapter.start(startInput);
      const stream = adapter.send(ref, { text: "慢" });
      let arrived = false;
      const first = stream.next().then((event) => {
        arrived = true;
        return event;
      });
      await vi.advanceTimersByTimeAsync(499);
      expect(arrived).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect((await first).value).toMatchObject({ type: "text_delta" });
      const waiting = stream.next();
      await vi.advanceTimersByTimeAsync(1);
      await adapter.interrupt(ref);
      expect((await waiting).value).toEqual({ type: "turn_done", reason: "interrupted" });
      expect((await stream.next()).done).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("审批按请求及会话路由，拒绝和中断分别结束等待中的轮次", async () => {
    const adapter = new FakeStaffAdapter({
      capabilities: { nativeApproval: true },
      script: () => [approval, completed],
    });
    const a = await adapter.start(startInput);
    const b = await adapter.start(startInput);
    const first = adapter.send(a, { text: "甲" });
    const second = adapter.send(b, { text: "乙" });
    expect((await first.next()).value).toEqual(approval);
    expect((await second.next()).value).toEqual(approval);
    await expect(adapter.approve(a, "不存在", true)).rejects.toMatchObject({ code: "other" });
    const one = first.next();
    const two = second.next();
    await adapter.approve(a, "ask", false);
    await expect(adapter.approve(a, "ask", true)).rejects.toMatchObject({ code: "other" });
    await adapter.interrupt(b);
    expect((await one).value).toEqual({ type: "turn_done", reason: "failed" });
    expect((await two).value).toEqual({ type: "turn_done", reason: "interrupted" });
    expect((await first.next()).done && (await second.next()).done).toBe(true);
  });

  it("拒绝使用更改工作目录或 runtime 的原生引用", async () => {
    const adapter = new FakeStaffAdapter();
    const ref = await adapter.start(startInput);
    const wrongRuntime: NativeSessionRef = { ...ref, runtimeKind: "codex" };
    for (const wrong of [wrongRuntime, { ...ref, cwd: "elsewhere" }]) {
      await expect(drain(adapter.send(wrong, { text: "测试" }))).rejects.toMatchObject({
        code: "native_session_lost",
      });
    }
  });
});
