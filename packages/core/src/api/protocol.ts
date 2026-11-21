import type { ApiErrorCode, ApiFailure, ApiMethod, ApiRequest } from "@paihuo/shared";

export const FRAME_BYTES = 1024 * 1024;
export const EVENT_BYTES = 64 * 1024;
export const PAGE_SIZE = 50;
export const TEXT_BYTES = 16 * 1024;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
// 请求 ID 沿用旧客户端的 128 字符限制。数据库主键是不透明值，必须能用返回的游标继续翻页。
const id = (v: unknown) => typeof v === "string" && v.trim().length > 0;
const text = (v: unknown) =>
  typeof v === "string" && v.trim().length > 0 && Buffer.byteLength(v) <= TEXT_BYTES;
const runtime = (v: unknown) =>
  v === "native" || v === "codex" || v === "acp" || v === "claude-code";
const integer = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
type Rule = (value: unknown) => boolean;
interface Rules {
  required?: Record<string, Rule>;
  optional?: Record<string, Rule>;
}
const fields = { name: text, title: text, runtimeKind: runtime, salutation: text };
const pageLimit = (v: unknown) => typeof v === "number" && integer(v) && v >= 1 && v <= PAGE_SIZE;
const listRules = { optional: { cursor: id, limit: pageLimit } };
const rules: Record<ApiMethod, Rules> = {
  "system.info": {},
  "member.list": listRules,
  "work.list": listRules,
  "conversation.open": { required: { memberId: id } },
  "message.page": {
    required: { conversationId: id, direction: (v) => v === "before" || v === "after" },
    optional: {
      cursor: integer,
      limit: pageLimit,
    },
  },
  "message.send": { required: { conversationId: id, text } },
  "work.get": { required: { workId: id } },
  "member.create": {
    required: { name: text, title: text, runtimeKind: runtime },
    optional: { salutation: text },
  },
  "member.update": { required: { memberId: id }, optional: fields },
  "member.archive": { required: { memberId: id } },
  "session.sleep": { required: { sessionId: id } },
  "session.wake": { required: { sessionId: id } },
  "request.answer": { required: { requestId: id, allow: (v) => typeof v === "boolean" } },
};

export function failure(requestId: string | null, code: ApiErrorCode, message: string): ApiFailure {
  return { id: requestId, error: { code, message } };
}
export function parseRequest(message: unknown): ApiFailure | ApiRequest {
  const requestId =
    object(message) &&
    typeof message.id === "string" &&
    message.id.trim().length > 0 &&
    message.id.length <= 128
      ? message.id
      : null;
  if (
    !object(message) ||
    !requestId ||
    typeof message.method !== "string" ||
    Object.keys(message).some((k) => k !== "id" && k !== "method" && k !== "params")
  )
    return failure(requestId, "INVALID_REQUEST", "请求需要有效的 id 和 method");
  if (!Object.hasOwn(rules, message.method))
    return failure(requestId, "UNKNOWN_METHOD", "未知命令");
  const spec = rules[message.method as ApiMethod];
  const params: unknown = message.params === undefined ? {} : message.params;
  if (
    !object(params) ||
    Object.entries(spec.required ?? {}).some(
      ([k, check]) => !Object.hasOwn(params, k) || !check(params[k]),
    ) ||
    Object.keys(params).some((k) => {
      if (spec.required && Object.hasOwn(spec.required, k)) return false;
      return !spec.optional || !Object.hasOwn(spec.optional, k) || !spec.optional[k]?.(params[k]);
    }) ||
    (message.method === "member.update" && Object.keys(params).length < 2)
  )
    return failure(requestId, "INVALID_PARAMS", "命令参数无效");
  // 所有已知方法的必填、可选字段及值域已由上面的同名规则逐项检查。
  return message as unknown as ApiRequest;
}
