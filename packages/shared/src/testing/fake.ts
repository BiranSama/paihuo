import {
  type AdapterCapabilities,
  type AdapterEvent,
  type NativeSessionRef,
  type StaffAdapter,
  StaffAdapterError,
  type StartInput,
  type TurnInput,
} from "@paihuo/shared/staff";

export interface FakeScriptContext {
  ref: NativeSessionRef;
  preamble: string;
  previousInputs: readonly TurnInput[];
}

type FakeOperation = "start" | "resume" | "send" | "guide" | "interrupt" | "approve" | "sleep";

export interface FakeAdapterOptions {
  capabilities?: Partial<AdapterCapabilities>;
  delayMs?: number;
  script?: (input: TurnInput, context: FakeScriptContext) => readonly AdapterEvent[];
  failure?: (operation: FakeOperation, ref?: NativeSessionRef) => StaffAdapterError | undefined;
}

interface RunningTurn {
  stop: AbortController;
  guidance: string[];
  approval?: { id: string; answer: (allow: boolean) => void };
}

interface MemorySession {
  ref: NativeSessionRef;
  memberId: string;
  preamble: string;
  previousInputs: TurnInput[];
  awake: boolean;
  run?: RunningTurn;
}

function other(message: string): StaffAdapterError {
  return new StaffAdapterError("other", message);
}

function unsupported(capability: keyof AdapterCapabilities): StaffAdapterError {
  return new StaffAdapterError("unsupported_capability", `不支持能力 ${capability}`);
}

function containsImage(input: TurnInput): boolean {
  return input.attachments?.some(({ mime }) => mime.toLowerCase().startsWith("image/")) ?? false;
}

function echo(input: TurnInput): AdapterEvent[] {
  return [
    { type: "text_delta", text: input.text },
    { type: "message_done", text: input.text },
    { type: "turn_done", reason: "completed" },
  ];
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms === 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

export class FakeStaffAdapter implements StaffAdapter {
  readonly kind = "native";
  private readonly sessions = new Map<string, MemorySession>();
  private readonly options: FakeAdapterOptions;
  private readonly supported: AdapterCapabilities;

  constructor(options: FakeAdapterOptions = {}) {
    this.options = options;
    this.supported = {
      resume: true,
      guide: true,
      interrupt: true,
      parallel: true,
      images: false,
      nativeApproval: false,
      ...options.capabilities,
    };
  }

  capabilities(): AdapterCapabilities {
    return { ...this.supported };
  }

  private checkFailure(operation: FakeOperation, ref?: NativeSessionRef) {
    const error = this.options.failure?.(operation, ref);
    if (error) throw error;
  }

  private session(ref: NativeSessionRef): MemorySession {
    const session = this.sessions.get(ref.nativeSession);
    if (!session || ref.runtimeKind !== this.kind || ref.cwd !== session.ref.cwd) {
      throw new StaffAdapterError("native_session_lost", "找不到原生会话");
    }
    return session;
  }

  async start(input: StartInput): Promise<NativeSessionRef> {
    this.checkFailure("start");
    const ref: NativeSessionRef = {
      runtimeKind: this.kind,
      nativeSession: crypto.randomUUID(),
      cwd: input.cwd,
    };
    this.sessions.set(ref.nativeSession, {
      ref: { ...ref },
      memberId: input.memberId,
      preamble: input.preamble,
      previousInputs: [],
      awake: true,
    });
    return ref;
  }

  async sleep(ref: NativeSessionRef): Promise<void> {
    this.checkFailure("sleep", ref);
    const session = this.session(ref);
    if (session.run) throw other("原生会话正在运行");
    session.awake = false;
  }

  async resume(ref: NativeSessionRef, preamble: string): Promise<void> {
    this.checkFailure("resume", ref);
    if (!this.supported.resume) throw unsupported("resume");
    const session = this.session(ref);
    if (session.run) throw other("原生会话正在运行");
    session.preamble = preamble;
    session.awake = true;
  }

  /** 模拟原生记录在休眠期间被删除。 */
  loseSession(ref: NativeSessionRef): void {
    if (this.session(ref).awake) throw other("只能删除已休眠的原生会话");
    this.sessions.delete(ref.nativeSession);
  }

  async *send(ref: NativeSessionRef, input: TurnInput): AsyncGenerator<AdapterEvent> {
    this.checkFailure("send", ref);
    const session = this.session(ref);
    if (!session.awake || session.run) throw other("会话正在休眠或已有一轮运行");
    if (!this.supported.images && containsImage(input)) throw unsupported("images");
    if (!this.supported.parallel) {
      for (const peer of this.sessions.values()) {
        if (peer.memberId === session.memberId && peer.run) throw unsupported("parallel");
      }
    }

    const events = (this.options.script ?? echo)(input, {
      ref: { ...ref },
      preamble: session.preamble,
      previousInputs: structuredClone(session.previousInputs),
    });
    session.previousInputs.push(structuredClone(input));
    const run: RunningTurn = { stop: new AbortController(), guidance: [] };
    session.run = run;
    // 一收到终结事件，调度层即可开始下一轮；迟到的迭代器清理不能清掉新轮次。
    const release = () => {
      if (session.run === run) session.run = undefined;
    };
    try {
      for (const event of events) {
        await delay(this.options.delayMs ?? 0, run.stop.signal);
        while (run.guidance.length && !run.stop.signal.aborted) {
          yield { type: "text_delta", text: run.guidance.shift() ?? "" };
        }
        if (run.stop.signal.aborted) {
          release();
          yield { type: "turn_done", reason: "interrupted" };
          return;
        }
        if (event.type === "needs_approval") {
          if (!this.supported.nativeApproval) throw unsupported("nativeApproval");
          const decision = Promise.withResolvers<boolean>();
          run.approval = { id: event.requestId, answer: decision.resolve };
          yield event;
          const allow = await decision.promise;
          run.approval = undefined;
          if (!allow || run.stop.signal.aborted) {
            release();
            yield { type: "turn_done", reason: run.stop.signal.aborted ? "interrupted" : "failed" };
            return;
          }
        } else {
          if (event.type === "turn_done") release();
          yield event;
        }
      }
    } finally {
      release();
    }
  }

  async guide(ref: NativeSessionRef, input: TurnInput): Promise<{ accepted: boolean }> {
    this.checkFailure("guide", ref);
    const session = this.session(ref);
    const run = session.run;
    if (
      !this.supported.guide ||
      !run ||
      run.stop.signal.aborted ||
      (!this.supported.images && containsImage(input))
    ) {
      return { accepted: false };
    }
    session.previousInputs.push(structuredClone(input));
    run.guidance.push(input.text);
    return { accepted: true };
  }

  async interrupt(ref: NativeSessionRef): Promise<void> {
    this.checkFailure("interrupt", ref);
    if (!this.supported.interrupt) throw unsupported("interrupt");
    const run = this.session(ref).run;
    if (run) {
      run.stop.abort();
      run.approval?.answer(false);
      run.approval = undefined;
    }
  }

  async approve(ref: NativeSessionRef, requestId: string, allow: boolean): Promise<void> {
    this.checkFailure("approve", ref);
    if (!this.supported.nativeApproval) throw unsupported("nativeApproval");
    const run = this.session(ref).run;
    const approval = run?.approval;
    if (!run || !approval || approval.id !== requestId) throw other("没有对应的待审批请求");
    run.approval = undefined;
    approval.answer(allow);
  }
}
