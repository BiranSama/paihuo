import { mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Conversation, Member, Session } from "@paihuo/shared";
import type { NativeSessionRef, StaffAdapter } from "@paihuo/shared/staff";
import type { Store } from "../store";

export type PreambleProvider = (member: Member, session: Session) => string | Promise<string>;
export const defaultPreamble: PreambleProvider = (member) =>
  [
    `你是${member.name}，职责是${member.title}。称呼老板为“${member.salutation}”。`,
    "收到请求只确认一次，说明打算做什么。干活时保持安静，过程写进工作记录。",
    "只有可用的结果、需要决定或做不下去时主动找老板。每次只问一个具体问题。",
    "老板参与群内讨论时，成员可以参与讨论。",
  ].join("\n");

export function activeMember(store: Store, memberId: string): Member {
  const member = store.members.get(memberId);
  if (member?.status !== "active") throw new Error("成员不存在或已停用");
  return member;
}

export function openDm(store: Store, memberId: string): Conversation {
  const member = activeMember(store, memberId);
  return store.dispatch.transaction(() => {
    const existing = store.dispatch.dmForMember(memberId);
    if (existing) return existing;
    const dm: Conversation = {
      id: crypto.randomUUID(),
      kind: "dm",
      title: member.name,
      created_at: new Date().toISOString(),
    };
    store.conversations.insert(dm);
    store.conversationMembers.insert({ conversation_id: dm.id, member_id: memberId });
    return dm;
  });
}

export function dmDirectory(store: Store, member: Member): string {
  const cwd = member.runtime_config.cwd;
  if (typeof cwd === "string" && isAbsolute(cwd)) return cwd;
  // 成员 ID 用作 Windows 单级目录名，禁止越界、设备名和尾部别名。
  if (
    !/^[\p{L}\p{N}_-][\p{L}\p{N}_.-]*$/u.test(member.id) ||
    member.id.endsWith(".") ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(member.id)
  )
    throw new Error("成员目录名无效");
  const dir = join(store.dataDir, "members", member.id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// 占位行使回执和 queued 记录可以先提交；直到获得运行名额才启动原生进程。
export function sessionFor(
  store: Store,
  member: Member,
  kind: "dm" | "task",
  scopeId: string,
  cwd: string,
): Session {
  const existing = store.dispatch.currentSession(member.id, kind, scopeId);
  if (existing) return existing;
  const now = new Date().toISOString();
  const session: Session = {
    id: crypto.randomUUID(),
    member_id: member.id,
    kind,
    scope_id: scopeId,
    runtime_kind: member.runtime_kind,
    native_session: null,
    cwd,
    state: "sleeping",
    prev_session_id: null,
    created_at: now,
    last_active_at: now,
  };
  store.sessions.insert(session);
  return session;
}

// 同一会话的调用由调度器串行化。新内核第一次接触已有原生 ID 时必须重新连接。
export async function connectSession(
  store: Store,
  adapter: StaffAdapter,
  member: Member,
  session: Session,
  connected: boolean,
  preamble: PreambleProvider,
  signal: AbortSignal,
): Promise<NativeSessionRef> {
  let ref: NativeSessionRef;
  if (session.native_session !== null) {
    ref = {
      runtimeKind: session.runtime_kind,
      nativeSession: session.native_session,
      cwd: session.cwd,
    };
    if (connected && session.state === "active") return ref;
    const prompt = await preamble(member, session);
    signal.throwIfAborted();
    await adapter.resume(ref, prompt);
  } else {
    const prompt = await preamble(member, session);
    signal.throwIfAborted();
    ref = await adapter.start({
      memberId: member.id,
      cwd: session.cwd,
      runtimeConfig: member.runtime_config,
      preamble: prompt,
    });
  }
  try {
    signal.throwIfAborted();
    store.sessions.update({
      ...session,
      native_session: ref.nativeSession,
      state: "active",
      last_active_at: new Date().toISOString(),
    });
  } catch (error) {
    await adapter.sleep(ref);
    throw error;
  }
  return ref;
}
