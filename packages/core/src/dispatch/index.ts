import type { Member, Message, Run, Session } from "@paihuo/shared";
import { StaffAdapterError } from "@paihuo/shared/staff";
import {
  activeMember,
  connectSession,
  defaultPreamble,
  dmDirectory,
  openDm,
  type PreambleProvider,
  sessionFor,
} from "../sessions";
import type { Store } from "../store";
import { completeWork, createWork, type StartWorkInput } from "../work";
import {
  type DispatchEvent,
  describeEvent,
  type MemberStatus,
  type RecordableEvent,
  type RunScope,
} from "./events";
import { recoverInterrupted } from "./recovery";
import type { AdapterRegistry } from "./registry";

export type { DispatchEvent, MemberStatus, RunScope } from "./events";
export { AdapterRegistry } from "./registry";

interface Options {
  taskConcurrency?: number;
  preamble?: PreambleProvider;
  onEvent?: (event: DispatchEvent) => void;
  onError?: (error: unknown) => void;
}

interface Queued {
  scope: RunScope;
  message: Message;
}

export function createDispatch(store: Store, registry: AdapterRegistry, options: Options = {}) {
  const limit = options.taskConcurrency ?? 4;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("任务并发上限必须为正整数");
  const listeners = new Set<(event: DispatchEvent) => void>();
  if (options.onEvent) listeners.add(options.onEvent);
  const report = options.onError ?? (() => console.error("调度模块发生内部错误"));
  const preamble = options.preamble ?? defaultPreamble;
  const connected = new Set<string>();
  const running = new Set<string>();
  const memberCounts = new Map<string, number>();
  // 每个待执行轮次只保留路由与主键。正文在获得执行槽时按主键读取。
  const queues = new Map<string, RunScope[]>();
  let activeTasks = 0;
  let scheduled = false;

  function emit(event: DispatchEvent) {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        report(error);
      }
    }
  }

  function status(memberId: string): MemberStatus {
    return memberCounts.has(memberId) ? "working" : "idle";
  }

  function changeBusy(memberId: string, delta: 1 | -1) {
    const before = status(memberId);
    const count = (memberCounts.get(memberId) ?? 0) + delta;
    if (count) memberCounts.set(memberId, count);
    else memberCounts.delete(memberId);
    if (status(memberId) !== before)
      emit({ type: "member.status", memberId, status: status(memberId) });
  }

  function queueRow(
    member: Member,
    session: Session,
    conversationId: string,
    workItemId: string | null,
    text: string,
  ): Queued {
    const message = store.messages.append({
      id: crypto.randomUUID(),
      conversation_id: conversationId,
      author_kind: "boss",
      author_id: null,
      body: text,
      work_item_id: workItemId,
      created_at: new Date().toISOString(),
    });
    const runId = crypto.randomUUID();
    store.runs.insert({
      id: runId,
      session_id: session.id,
      input_message_id: message.id,
      state: "queued",
      started_at: null,
      ended_at: null,
      end_reason: null,
    });
    return {
      message,
      scope: { memberId: member.id, sessionId: session.id, conversationId, workItemId, runId },
    };
  }

  function admit({ scope, message }: Queued) {
    const pending = queues.get(scope.sessionId);
    if (pending) pending.push(scope);
    else queues.set(scope.sessionId, [scope]);
    schedule();
    emit({ type: "message.created", message, sessionId: scope.sessionId, runId: scope.runId });
    return { messageId: message.id, runId: scope.runId, sessionId: scope.sessionId };
  }

  function record(scope: RunScope, seq: number, data: RecordableEvent) {
    const event = {
      ...describeEvent(data),
      id: crypto.randomUUID(),
      run_id: scope.runId,
      seq,
      created_at: new Date().toISOString(),
    };
    store.runEvents.insert(event);
    const approval =
      data.type === "needs_approval"
        ? { requestId: data.requestId, summary: data.summary }
        : undefined;
    emit({ type: "run.event", ...scope, event, ...(approval && { approval }) });
  }

  async function execute(scope: RunScope) {
    const { memberId, sessionId, conversationId, workItemId, runId } = scope;
    const run = store.runs.get(runId);
    const session = store.sessions.get(sessionId);
    if (!run || !session) throw new Error("缺少已入队的运行或会话");
    const started: Run = { ...run, state: "running", started_at: new Date().toISOString() };
    store.runs.update(started);
    emit({ type: "run.started", ...scope, run: started });
    let state: "done" | "failed" | "cancelled" = "failed";
    let reason = "missing_turn_done";
    let seq = 0;
    try {
      const member = activeMember(store, memberId);
      const adapter = registry.get(session.runtime_kind);
      const ref = await connectSession(
        store,
        adapter,
        member,
        session,
        connected.has(sessionId),
        preamble,
      );
      connected.add(sessionId);
      const input = store.messages.get(run.input_message_id);
      if (!input) throw new Error("缺少本轮输入");
      for await (const data of adapter.send(ref, { text: input.body })) {
        if (data.type === "turn_done") {
          reason = data.reason;
          state =
            reason === "completed" ? "done" : reason === "interrupted" ? "cancelled" : "failed";
          break;
        }
        switch (data.type) {
          case "text_delta":
            emit({ type: "message.delta", ...scope, text: data.text });
            break;
          case "message_done": {
            const message = store.messages.append({
              id: crypto.randomUUID(),
              conversation_id: conversationId,
              author_kind: "member",
              author_id: memberId,
              body: data.text,
              work_item_id: workItemId,
              created_at: new Date().toISOString(),
            });
            emit({ type: "message.created", message, sessionId, runId });
            break;
          }
          default:
            record(scope, ++seq, data);
        }
      }
    } catch (error) {
      reason = error instanceof StaffAdapterError ? error.code : "execution_failed";
      state = "failed";
      record(scope, ++seq, { type: "error", message: "", recoverable: false });
    }
    const ended = new Date().toISOString();
    const finished: Run = { ...started, state, end_reason: reason, ended_at: ended };
    store.dispatch.transaction(() => {
      store.runs.update(finished);
      const current = store.sessions.get(sessionId);
      if (current) store.sessions.update({ ...current, last_active_at: ended });
    });
    emit({ type: "run.ended", ...scope, run: finished });
  }

  async function archiveTask(session: Session) {
    if (session.native_session && connected.has(session.id)) {
      await registry.get(session.runtime_kind).sleep({
        runtimeKind: session.runtime_kind,
        nativeSession: session.native_session,
        cwd: session.cwd,
      });
      connected.delete(session.id);
    }
    store.sessions.update({
      ...session,
      state: "archived",
      last_active_at: new Date().toISOString(),
    });
  }

  async function run(scope: RunScope) {
    const { sessionId, memberId, workItemId } = scope;
    running.add(sessionId);
    if (workItemId !== null) activeTasks++;
    try {
      changeBusy(memberId, 1);
      await execute(scope);
      if (workItemId !== null && store.workItems.get(workItemId)?.status === "done") {
        const current = store.sessions.get(sessionId);
        if (current) await archiveTask(current);
      }
    } finally {
      running.delete(sessionId);
      if (workItemId !== null) activeTasks--;
      changeBusy(memberId, -1);
      schedule();
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      // 一次轮询给每条可运行会话一次机会；wait 中的任务不能挡住后面的私聊。
      for (const [id, pending] of queues) {
        const scope = pending[0];
        if (!scope || running.has(id) || (scope.workItemId !== null && activeTasks >= limit))
          continue;
        pending.shift();
        if (!pending.length) queues.delete(id);
        void run(scope).catch(report);
      }
    });
  }

  recoverInterrupted(store, emit);
  return {
    openDm: (memberId: string) => openDm(store, memberId),
    memberStatus: status,
    subscribe(listener: (event: DispatchEvent) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    sendMessage(conversationId: string, text: string) {
      const memberId = store.dispatch.dmRecipient(conversationId);
      if (!memberId) throw new Error("私聊不存在或没有唯一接收人");
      const member = activeMember(store, memberId);
      registry.get(member.runtime_kind);
      const cwd = dmDirectory(store, member);
      const queued = store.dispatch.transaction(() => {
        const session = sessionFor(store, member, "dm", conversationId, cwd);
        return queueRow(member, session, conversationId, null, text);
      });
      return admit(queued);
    },
    startWork(input: StartWorkInput) {
      const member = activeMember(store, input.memberId);
      registry.get(member.runtime_kind);
      const { item, queued } = createWork(store, input, (work) => {
        const session = sessionFor(store, member, "task", work.id, work.dir);
        return queueRow(member, session, work.conversation_id, work.id, work.goal);
      });
      const receipt = admit(queued);
      emit({ type: "work.updated", work: item });
      return { work: item, ...receipt };
    },
    async finishWork(workId: string) {
      const item = store.workItems.get(workId);
      if (!item || item.status === "archived") throw new Error("工作项不存在或已归档");
      const session = store.dispatch.currentSession(item.owner_member_id, "task", item.id);
      if (session && queues.has(session.id)) throw new Error("工作尚在排队");
      if (session && !running.has(session.id)) await archiveTask(session);
      if (item.status === "done") return item;
      const work = completeWork(store, item);
      emit({ type: "work.updated", work });
      return work;
    },
  };
}
