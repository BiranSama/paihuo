import type { Member, Message, Run, Session, WorkItem } from "@paihuo/shared";
import { type NativeSessionRef, type StaffAdapter, StaffAdapterError } from "@paihuo/shared/staff";
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
  const lifetime = new AbortController();
  const { signal } = lifetime;
  const connected = new Map<
    string,
    { adapter: StaffAdapter; ref: NativeSessionRef; releasing?: Promise<void> }
  >();
  const finishRequested = new Set<string>();
  const finishing = new Map<string, Promise<WorkItem>>();
  const running = new Set<string>();
  const memberCounts = new Map<string, number>();
  // 每个待执行轮次只保留路由与主键。正文在获得执行槽时按主键读取。
  const queues = new Map<string, RunScope[]>();
  let activeTasks = 0;
  let scheduled = false;

  function emit(event: DispatchEvent) {
    for (const listener of [...listeners]) {
      if (signal.aborted) break;
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
    if (signal.aborted) return;
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
        signal,
      );
      if (signal.aborted) {
        if (!connected.has(sessionId)) await adapter.sleep(ref);
        return;
      }
      connected.set(sessionId, { adapter, ref });
      const input = store.messages.get(run.input_message_id);
      if (!input) throw new Error("缺少本轮输入");
      for await (const data of adapter.send(ref, { text: input.body })) {
        if (signal.aborted) return;
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
        if (signal.aborted) return;
      }
    } catch (error) {
      if (signal.aborted) return;
      reason = error instanceof StaffAdapterError ? error.code : "execution_failed";
      state = "failed";
      try {
        record(scope, ++seq, { type: "error", message: "", recoverable: false });
      } catch (recordError) {
        // 工作记录写入失败时仍须尝试将运行置为终态。
        report(recordError);
      }
    }
    if (signal.aborted) return;
    const ended = new Date().toISOString();
    const finished: Run = { ...started, state, end_reason: reason, ended_at: ended };
    store.dispatch.transaction(() => {
      store.runs.update(finished);
      const current = store.sessions.get(sessionId);
      if (current) store.sessions.update({ ...current, last_active_at: ended });
    });
    emit({ type: "run.ended", ...scope, run: finished });
  }

  function releaseConnection(sessionId: string, interrupt = false) {
    const connection = connected.get(sessionId);
    if (!connection) return Promise.resolve();
    if (connection.releasing) return connection.releasing;
    const { adapter, ref } = connection;
    connection.releasing = Promise.resolve()
      .then(async () => {
        try {
          if (interrupt && adapter.capabilities().interrupt) await adapter.interrupt(ref);
        } finally {
          await adapter.sleep(ref);
          connected.delete(sessionId);
        }
      })
      .finally(() => {
        connection.releasing = undefined;
      });
    return connection.releasing;
  }

  function archiveTask(session: Session) {
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
      if (signal.aborted) return;
      await execute(scope);
      if (signal.aborted) return;
      if (workItemId !== null && finishRequested.delete(workItemId)) {
        await finalizeWork(workItemId);
      }
    } finally {
      running.delete(sessionId);
      if (workItemId !== null) activeTasks--;
      changeBusy(memberId, -1);
      schedule();
    }
  }

  function schedule() {
    if (scheduled || signal.aborted) return;
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

  async function finish(workId: string) {
    signal.throwIfAborted();
    const item = store.workItems.get(workId);
    if (!item || item.status === "archived") throw new Error("工作项不存在或已归档");
    const session = store.dispatch.currentSession(item.owner_member_id, "task", item.id);
    if (session) await releaseConnection(session.id);
    signal.throwIfAborted();
    const work = store.dispatch.transaction(() => {
      if (session) archiveTask(session);
      return item.status === "done" ? item : completeWork(store, item);
    });
    if (item.status !== "done") emit({ type: "work.updated", work });
    return work;
  }

  function finalizeWork(workId: string) {
    const existing = finishing.get(workId);
    if (existing) return existing;
    const promise = Promise.resolve()
      .then(() => finish(workId))
      .finally(() => finishing.delete(workId));
    finishing.set(workId, promise);
    return promise;
  }

  recoverInterrupted(store, emit);
  return {
    openDm(memberId: string) {
      signal.throwIfAborted();
      return openDm(store, memberId);
    },
    memberStatus: status,
    subscribe(listener: (event: DispatchEvent) => void) {
      signal.throwIfAborted();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    sendMessage(conversationId: string, text: string) {
      signal.throwIfAborted();
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
      signal.throwIfAborted();
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
    finishWork(workId: string) {
      signal.throwIfAborted();
      const existing = finishing.get(workId);
      if (existing) return existing;
      const item = store.workItems.get(workId);
      if (!item || item.status === "archived")
        return Promise.reject(new Error("工作项不存在或已归档"));
      const session = store.dispatch.currentSession(item.owner_member_id, "task", workId);
      if (session && queues.has(session.id)) return Promise.reject(new Error("工作尚在排队"));
      if (session && running.has(session.id)) {
        // 成员可以在自己的一轮中请求收尾；同步登记意图，工具调用无需等待所属轮次结束。
        finishRequested.add(workId);
        return Promise.resolve(item);
      }
      return finalizeWork(workId);
    },
    // 先失效所有回调，调用方随后即可同步关库。原生进程的收尾不能阻塞内核退出。
    close() {
      if (signal.aborted) return;
      lifetime.abort(new Error("调度器已关闭"));
      queues.clear();
      finishRequested.clear();
      listeners.clear();
      for (const id of connected.keys()) {
        void releaseConnection(id, running.has(id)).catch(report);
      }
    },
  };
}
