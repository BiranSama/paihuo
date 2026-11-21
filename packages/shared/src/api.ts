import type { Conversation, Member, Message, Run, RunEvent, RuntimeKind, WorkItem } from "./store";

export interface SystemInfoRequest {
  id: string;
  method: "system.info";
}

export interface SystemInfo {
  version: string;
  dataDir: string;
  harnesses: ("claude-code" | "codex")[];
  memoryBytes: number;
}

export interface SystemInfoResponse {
  id: string;
  result: SystemInfo;
}

export type * from "./store";

export type MemberActivity = "idle" | "working" | "sleeping";
export interface MemberView
  extends Pick<Member, "id" | "name" | "title" | "salutation" | "runtime_kind" | "builtin"> {
  activity: MemberActivity;
}

export interface MessageView extends Message {
  truncated?: true;
}
export interface MessagePage {
  messages: MessageView[];
  /** 当前方向还有数据时，传回该排他游标即可继续。消息始终按 seq 升序排列。 */
  nextCursor: number | null;
}

interface MemberFields {
  name: string;
  title: string;
  runtimeKind: RuntimeKind;
  salutation?: string;
}
export interface ApiParams {
  "system.info": undefined;
  "member.list": undefined;
  "member.create": MemberFields;
  "member.update": { memberId: string } & Partial<MemberFields>;
  "member.archive": { memberId: string };
  "conversation.open": { memberId: string };
  "message.page": {
    conversationId: string;
    direction: "before" | "after";
    cursor?: number;
    limit?: number;
  };
  "message.send": { conversationId: string; text: string };
  "work.list": undefined;
  "work.get": { workId: string };
  "session.sleep": { sessionId: string };
  "session.wake": { sessionId: string };
  "request.answer": { requestId: string; allow: boolean };
}
export type ApiMethod = keyof ApiParams;
export type ApiRequest<M extends ApiMethod = ApiMethod> = {
  [K in M]: { id: string; method: K } & (ApiParams[K] extends undefined
    ? { params?: Record<string, never> }
    : { params: ApiParams[K] });
}[M];
export interface ApiResults {
  "system.info": SystemInfo;
  "member.list": { members: MemberView[] };
  "conversation.open": { conversation: Conversation & { truncated?: true }; page: MessagePage };
  "message.page": MessagePage;
  "message.send": { accepted: true; messageId: string; runId: string; sessionId: string };
  "work.list": { items: WorkItem[] };
  "work.get": { work: WorkItem; events: RunEvent[] };
}
export type ApiErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_PARAMS"
  | "UNKNOWN_METHOD"
  | "NOT_IMPLEMENTED"
  | "NOT_FOUND"
  | "ADAPTER_NOT_READY"
  | "CORE_NOT_READY"
  | "RESPONSE_TOO_LARGE"
  | "INTERNAL_ERROR";
export interface ApiFailure {
  id: string | null;
  error: { code: ApiErrorCode; message: string };
}
export type ApiReply<M extends ApiMethod = ApiMethod> =
  | ApiFailure
  | (M extends keyof ApiResults ? { id: string; result: ApiResults[M] } : never);

export interface ApiRunScope {
  memberId: string;
  sessionId: string;
  conversationId: string;
  workItemId: string | null;
  runId: string;
}
export interface ApiEventData {
  "message.created": { message: MessageView; sessionId: string; runId: string | null };
  "message.delta": ApiRunScope & { text: string };
  "run.started": ApiRunScope & { run: Run };
  "run.ended": ApiRunScope & { run: Run };
  "run.event": ApiRunScope & { event: RunEvent; approval?: { requestId: string; summary: string } };
  "member.status": { memberId: string; status: MemberActivity };
  "work.updated": { work: WorkItem };
  "request.created": { requestId: string; summary: string };
}
export type ApiEvent =
  | {
      [K in keyof ApiEventData]: { event: K; data: ApiEventData[K]; truncated?: true };
    }[keyof ApiEventData]
  | { event: keyof ApiEventData; data: null; truncated: true };
