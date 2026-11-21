import type { Message, Run, RunEvent, WorkItem } from "@paihuo/shared";
import type { AdapterEvent } from "@paihuo/shared/staff";

export interface RunScope {
  memberId: string;
  sessionId: string;
  conversationId: string;
  workItemId: string | null;
  runId: string;
}

export type MemberStatus = "idle" | "working";
export type DispatchEvent =
  | { type: "message.created"; message: Message; runId: string | null; sessionId: string }
  | ({ type: "message.delta"; text: string } & RunScope)
  | ({ type: "run.started" | "run.ended"; run: Run } & RunScope)
  | ({
      type: "run.event";
      event: RunEvent;
      approval?: { requestId: string; summary: string };
    } & RunScope)
  | { type: "member.status"; memberId: string; status: MemberStatus }
  | { type: "work.updated"; work: WorkItem };

export type RecordableEvent = Extract<
  AdapterEvent,
  { type: "tool_started" | "tool_finished" | "error" | "needs_approval" }
>;

// 适配器摘要、报错和工具名都可能夹带命令、凭证、路径或原始输出。持久化只选取已知分类。
const toolNames = new Set([
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "exec_command",
  "apply_patch",
]);
export function describeEvent(event: RecordableEvent): Pick<RunEvent, "kind" | "summary"> {
  switch (event.type) {
    case "tool_started":
    case "tool_finished": {
      const tool = toolNames.has(event.name) ? event.name : "工具";
      const action =
        event.type === "tool_started" ? "开始执行" : event.ok ? "执行成功" : "执行失败";
      return { kind: event.type, summary: `${tool}${action}` };
    }
    case "needs_approval":
      return { kind: "note", summary: "工具请求需要老板确认" };
    case "error":
      return {
        kind: "error",
        summary: event.recoverable ? "适配器报告可恢复错误" : "适配器报告错误",
      };
  }
}
