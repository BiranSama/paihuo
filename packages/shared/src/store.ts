export type RuntimeKind = "claude-code" | "codex" | "acp" | "native";
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface Member {
  id: string;
  name: string;
  title: string;
  salutation: string;
  runtime_kind: RuntimeKind;
  runtime_config: { [key: string]: JsonValue };
  builtin: boolean;
  status: "active" | "archived";
  created_by: string;
  created_at: string;
  archived_at: string | null;
}

export interface Conversation {
  id: string;
  kind: "dm" | "group";
  title: string;
  created_at: string;
}

export interface ConversationMember {
  conversation_id: string;
  member_id: string;
}

export interface Session {
  id: string;
  member_id: string;
  kind: "dm" | "group" | "task" | "oneshot";
  scope_id: string;
  runtime_kind: RuntimeKind;
  native_session: string | null;
  cwd: string;
  state: "active" | "sleeping" | "archived";
  prev_session_id: string | null;
  created_at: string;
  last_active_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  seq: number;
  author_kind: "boss" | "member" | "system";
  author_id: string | null;
  body: string;
  work_item_id: string | null;
  created_at: string;
}

export interface WorkItem {
  id: string;
  title: string;
  goal: string;
  owner_member_id: string;
  status: "running" | "waiting_boss" | "done" | "archived";
  conversation_id: string;
  dir: string;
  created_at: string;
  updated_at: string;
}

export interface Run {
  id: string;
  session_id: string;
  input_message_id: string;
  state: "queued" | "running" | "done" | "failed" | "cancelled" | "unknown";
  started_at: string | null;
  ended_at: string | null;
  end_reason: string | null;
}

export interface RunEvent {
  id: string;
  run_id: string;
  seq: number;
  kind: "tool_started" | "tool_finished" | "note" | "error";
  summary: string;
  created_at: string;
}
