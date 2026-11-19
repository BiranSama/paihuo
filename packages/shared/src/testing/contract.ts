import {
  type AdapterEvent,
  type NativeSessionRef,
  type StaffAdapter,
  StaffAdapterError,
  type StartInput,
  type TurnInput,
} from "@paihuo/shared/staff";

export type StaffContractCase =
  | "turn"
  | "resume"
  | "guide"
  | "interrupt"
  | "parallel"
  | "images"
  | "nativeApproval";
type Outcome = "passed" | "supported" | "refused";
type Reason = Extract<AdapterEvent, { type: "turn_done" }>["reason"];
export interface StaffContractOptions {
  /** 两个槽位使用同一个成员；真实适配器应提供各自的临时工作目录。 */
  startInput?: (slot: "a" | "b") => StartInput;
  /** ongoing 场景须让第一条非终结事件抵达后留出控制窗口。 */
  turnInput?: (marker: string, ongoing: boolean) => TurnInput;
  /** 两个首事件均已收到；由传输夹具检查底层两轮确实重叠，并释放屏障。 */
  assertParallelOverlap?: (
    first: NativeSessionRef,
    second: NativeSessionRef,
  ) => void | Promise<void>;
  /** 在真实适配器测试中指向一个有效的本机测试图片。 */
  imagePath?: string;
  /** 询问上一轮的标记；该输入不应包含标记本身。 */
  recallInput?: TurnInput;
  /** 有原生审批能力时，提供一条确实会触发审批的安全测试输入。 */
  approvalInput?: TurnInput;
  /** 仅同意与当前测试夹具匹配的审批。 */
  acceptApproval?: (request: Extract<AdapterEvent, { type: "needs_approval" }>) => boolean;
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function collect(
  source: AsyncIterator<AdapterEvent>,
  first?: AdapterEvent,
): Promise<AdapterEvent[]> {
  const events = first ? [first] : [];
  for (let step = await source.next(); !step.done; step = await source.next()) {
    check(step.value.type !== "needs_approval", "普通测试轮次意外进入审批，请检查测试夹具");
    events.push(step.value);
  }
  return events;
}

function expectEnd(events: AdapterEvent[], reason: Reason): void {
  const ends = events.filter((event) => event.type === "turn_done");
  check(ends.length === 1, `期望恰好一个 turn_done，实际为 ${ends.length}`);
  check(events.at(-1) === ends[0], "turn_done 后还有事件");
  check(ends[0]?.reason === reason, `期望以 ${reason} 结束，实际为 ${ends[0]?.reason}`);
}

function hasMarker(events: AdapterEvent[], marker: string): boolean {
  const deltas = events.filter((event) => event.type === "text_delta").map((event) => event.text);
  return (
    deltas.join("").includes(marker) ||
    events.some((event) => event.type === "message_done" && event.text.includes(marker))
  );
}

function marker(): string {
  return `PH-${crypto.randomUUID()}`;
}

async function expectUnsupported(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof StaffAdapterError && error.code === "unsupported_capability") return;
    throw error;
  }
  throw new Error("操作声明为不支持，调用却成功");
}

function reader(adapter: StaffAdapter, ref: NativeSessionRef, input: TurnInput) {
  return adapter.send(ref, input)[Symbol.asyncIterator]();
}

/** 先读到一条非终结事件，才能向真正处于运行中的轮次发送引导或中断。 */
async function duringTurn<T>(
  adapter: StaffAdapter,
  ref: NativeSessionRef,
  input: TurnInput,
  work: (finish: () => Promise<AdapterEvent[]>) => Promise<T>,
): Promise<T> {
  const stream = reader(adapter, ref, input);
  try {
    const first = await stream.next();
    check(!first.done && first.value.type !== "turn_done", "需要一条尚未结束的受控测试轮次");
    check(first.value.type !== "needs_approval", "普通测试轮次意外进入审批，请检查测试夹具");
    return await work(() => collect(stream, first.value));
  } finally {
    await stream.return?.();
  }
}

class ContractFixture {
  readonly awake = new Set<NativeSessionRef>();
  readonly adapter: StaffAdapter;
  readonly options: StaffContractOptions;

  constructor(adapter: StaffAdapter, options: StaffContractOptions) {
    this.adapter = adapter;
    this.options = options;
  }

  async start(slot: "a" | "b") {
    const input = this.options.startInput?.(slot) ?? {
      memberId: "contract-member",
      cwd: ".",
      preamble: "",
      runtimeConfig: {},
    };
    const ref = await this.adapter.start(input);
    this.awake.add(ref);
    check(
      ref.runtimeKind === this.adapter.kind && ref.nativeSession.length > 0,
      "原生会话引用无效",
    );
    return ref;
  }

  turn(token: string, ongoing = false): TurnInput {
    return (
      this.options.turnInput?.(token, ongoing) ?? {
        text: ongoing
          ? `先输出标记 ${token}，再分段列出十个不同的颜色。`
          : `请原样输出标记 ${token}。`,
      }
    );
  }

  async send(ref: NativeSessionRef, input: TurnInput) {
    const stream = reader(this.adapter, ref, input);
    try {
      return await collect(stream);
    } finally {
      await stream.return?.();
    }
  }

  /** 操作应在启动前被拒绝；已输出事件再抛错误同样违反契约。 */
  async probeRefusal(ref: NativeSessionRef, input: TurnInput) {
    const stream = reader(this.adapter, ref, input);
    try {
      const first = await stream.next();
      check(first.done, "不支持的投递仍然产生了事件");
    } finally {
      await stream.return?.();
    }
  }

  async sleep(ref: NativeSessionRef) {
    await this.adapter.sleep(ref);
    this.awake.delete(ref);
  }
}

const cases: Record<StaffContractCase, (fixture: ContractFixture) => Promise<Outcome>> = {
  async turn(f) {
    const token = marker();
    const events = await f.send(await f.start("a"), f.turn(token));
    expectEnd(events, "completed");
    check(hasMarker(events, token), "新会话没有返回本轮标记");
    return "passed";
  },

  async resume(f) {
    const ref = await f.start("a");
    const remembered = marker();
    expectEnd(await f.send(ref, f.turn(remembered)), "completed");
    await f.sleep(ref);
    const wake = () => f.adapter.resume(ref, "恢复契约测试会话");
    if (!f.adapter.capabilities().resume) {
      await expectUnsupported(wake);
      return "refused";
    }
    await wake();
    f.awake.add(ref);
    const token = f.options.recallInput ? remembered : marker();
    const events = await f.send(ref, f.options.recallInput ?? f.turn(token));
    expectEnd(events, "completed");
    check(hasMarker(events, token), "原引用恢复后无法返回预期的标记");
    return "supported";
  },

  async guide(f) {
    const ref = await f.start("a");
    const guideToken = marker();
    return duringTurn(f.adapter, ref, f.turn(marker(), true), async (finish) => {
      const { accepted } = await f.adapter.guide(ref, f.turn(guideToken));
      check(accepted === f.adapter.capabilities().guide, "引导结果与能力声明不符");
      const events = await finish();
      expectEnd(events, "completed");
      check(hasMarker(events, guideToken) === accepted, "本轮收到的引导与 accepted 不符");
      return accepted ? "supported" : "refused";
    });
  },

  async interrupt(f) {
    const ref = await f.start("a");
    return duringTurn(f.adapter, ref, f.turn(marker(), true), async (finish) => {
      if (!f.adapter.capabilities().interrupt) {
        await expectUnsupported(() => f.adapter.interrupt(ref));
        expectEnd(await finish(), "completed");
        return "refused";
      }
      await f.adapter.interrupt(ref);
      expectEnd(await finish(), "interrupted");
      return "supported";
    });
  },

  async parallel(f) {
    const first = await f.start("a");
    const left = marker();
    const right = marker();
    return duringTurn(f.adapter, first, f.turn(left, true), async (finishFirst) => {
      if (!f.adapter.capabilities().parallel) {
        await expectUnsupported(async () => f.probeRefusal(await f.start("b"), f.turn(right)));
        const firstEvents = await finishFirst();
        expectEnd(firstEvents, "completed");
        check(
          hasMarker(firstEvents, left) && !hasMarker(firstEvents, right),
          "被拒绝的并行输入串到了第一条会话",
        );
        return "refused";
      }
      const second = await f.start("b");
      check(first.nativeSession !== second.nativeSession, "并行会话共用了原生标识");
      return duringTurn<Outcome>(f.adapter, second, f.turn(right, true), async (finishSecond) => {
        await f.options.assertParallelOverlap?.(first, second);
        const [a, b] = await Promise.all([finishFirst(), finishSecond()]);
        expectEnd(a, "completed");
        expectEnd(b, "completed");
        check(
          hasMarker(a, left) && !hasMarker(a, right) && hasMarker(b, right) && !hasMarker(b, left),
          "两条会话的标记缺失或串线",
        );
        return "supported";
      });
    });
  },

  async images(f) {
    const ref = await f.start("a");
    const input = {
      ...f.turn(marker()),
      attachments: [{ path: f.options.imagePath ?? "contract.png", mime: "image/png" }],
    };
    if (!f.adapter.capabilities().images) {
      await expectUnsupported(() => f.probeRefusal(ref, input));
      return "refused";
    }
    expectEnd(await f.send(ref, input), "completed");
    return "supported";
  },

  async nativeApproval(f) {
    const ref = await f.start("a");
    if (!f.adapter.capabilities().nativeApproval) {
      await expectUnsupported(() => f.adapter.approve(ref, "contract-request", true));
      return "refused";
    }
    const input = f.options.approvalInput;
    const accept = f.options.acceptApproval;
    check(input && accept, "请提供审批测试用的 approvalInput 和 acceptApproval");
    const stream = reader(f.adapter, ref, input);
    const events: AdapterEvent[] = [];
    let approvals = 0;
    try {
      for (let step = await stream.next(); !step.done; step = await stream.next()) {
        events.push(step.value);
        if (step.value.type === "needs_approval") {
          const allow = accept(step.value);
          await f.adapter.approve(ref, step.value.requestId, allow);
          check(allow, "原生审批请求与测试夹具不符，已拒绝");
          approvals++;
        }
      }
    } finally {
      await stream.return?.();
    }
    check(approvals > 0, "没有收到原生审批请求");
    expectEnd(events, "completed");
    return "supported";
  },
};

/** 每个场景创建独立适配器；失败时带场景名抛错，可直接交给 Vitest。 */
export async function runStaffContract(
  createAdapter: (scenario: StaffContractCase) => StaffAdapter | Promise<StaffAdapter>,
  options: StaffContractOptions = {},
): Promise<Record<StaffContractCase, Outcome>> {
  const outcomes = {} as Record<StaffContractCase, Outcome>;
  for (const scenario of Object.keys(cases) as StaffContractCase[]) {
    try {
      const f = new ContractFixture(await createAdapter(scenario), options);
      try {
        outcomes[scenario] = await cases[scenario](f);
      } finally {
        await Promise.all(Array.from(f.awake, (ref) => f.sleep(ref)));
      }
    } catch (cause) {
      throw new Error(
        `员工契约 ${scenario} 失败：${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
  }
  return outcomes;
}
