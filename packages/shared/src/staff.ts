export type RuntimeKind = "claude-code" | "codex" | "acp" | "native";

export interface AdapterCapabilities {
  resume: boolean;
  guide: boolean;
  interrupt: boolean;
  parallel: boolean;
  images: boolean;
  nativeApproval: boolean;
}

export interface NativeSessionRef {
  runtimeKind: RuntimeKind;
  nativeSession: string;
  cwd: string;
}

export interface StartInput {
  memberId: string;
  cwd: string;
  preamble: string;
  runtimeConfig: Record<string, unknown>;
}

export interface TurnInput {
  text: string;
  attachments?: { path: string; mime: string }[];
}

export type AdapterEvent =
  | { type: "text_delta"; text: string }
  | { type: "message_done"; text: string }
  | { type: "tool_started"; name: string; summary: string }
  | { type: "tool_finished"; name: string; ok: boolean; summary: string }
  | { type: "needs_approval"; requestId: string; summary: string }
  | { type: "error"; message: string; recoverable: boolean }
  | { type: "turn_done"; reason: "completed" | "interrupted" | "failed" };

export type StaffErrorCode =
  | "native_session_lost"
  | "harness_not_installed"
  | "harness_not_authenticated"
  | "interrupted"
  | "unsupported_capability"
  | "other";

export class StaffAdapterError extends Error {
  readonly code: StaffErrorCode;

  constructor(code: StaffErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StaffAdapterError";
    this.code = code;
  }
}

export interface StaffAdapter {
  readonly kind: RuntimeKind;
  capabilities(): AdapterCapabilities;
  start(input: StartInput): Promise<NativeSessionRef>;
  resume(ref: NativeSessionRef, preamble: string): Promise<void>;
  send(ref: NativeSessionRef, input: TurnInput): AsyncIterable<AdapterEvent>;
  guide(ref: NativeSessionRef, input: TurnInput): Promise<{ accepted: boolean }>;
  interrupt(ref: NativeSessionRef): Promise<void>;
  approve(ref: NativeSessionRef, requestId: string, allow: boolean): Promise<void>;
  sleep(ref: NativeSessionRef): Promise<void>;
}
