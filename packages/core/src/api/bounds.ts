import type {
  ApiEvent,
  ApiEventData,
  ApiReply,
  Message,
  MessagePage,
  MessageView,
} from "@paihuo/shared";
import type { DispatchEvent } from "../dispatch";
import { EVENT_BYTES, FRAME_BYTES, failure } from "./protocol";

// 以 JSON 编码后的 UTF-8 字节计费，包含控制字符转义；截断时保留完整的代理对。
export function clip(text: string, budget: number): string {
  let high = Math.min(text.length, budget);
  if (high === text.length && Buffer.byteLength(JSON.stringify(text)) <= budget) return text;
  let low = 0;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(text.slice(0, mid))) <= budget) low = mid;
    else high = mid - 1;
  }
  const last = text.charCodeAt(low - 1);
  if (
    last >= 0xd800 &&
    last <= 0xdbff &&
    low < text.length &&
    text.charCodeAt(low) >= 0xdc00 &&
    text.charCodeAt(low) <= 0xdfff
  )
    low--;
  return text.slice(0, low);
}
const pageBudget = FRAME_BYTES - 16 * 1024; // 预留回执 ID、对话标题和分页结构。
export function pageOf(rows: Message[], direction: "before" | "after", limit: number): MessagePage {
  const entries: MessageView[] = [];
  let used = 2;
  for (let i = 0; i < rows.length && i < limit; i++) {
    const row = rows[direction === "before" ? rows.length - i - 1 : i];
    if (!row) break;
    const overhead = Buffer.byteLength(JSON.stringify({ ...row, body: "", truncated: true })) + 2;
    if (overhead >= pageBudget) throw new RangeError("消息元数据超过单帧上限");
    const body = clip(row.body, pageBudget - overhead);
    const entry = body === row.body ? row : { ...row, body, truncated: true as const };
    const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (entries.length && used + size > pageBudget) break;
    entries.push(entry);
    used += size;
  }
  const nextCursor = entries.length < rows.length ? (entries.at(-1)?.seq ?? null) : null;
  if (direction === "before") entries.reverse();
  return { messages: entries, nextCursor };
}
export function packReply(response: ApiReply): string {
  return (
    encodeFrame(response, FRAME_BYTES) ??
    JSON.stringify(failure(response.id, "RESPONSE_TOO_LARGE", "响应超过单帧上限"))
  );
}

function encodeFrame(value: object, limit: number): string | undefined {
  // 先用标量长度下界中止超大列表的序列化，再对可发送结果精确计 UTF-8 字节。
  let minimum = 0;
  const tooLarge = Symbol();
  try {
    const encoded = JSON.stringify(value, (key, item: unknown) => {
      minimum += key.length + (typeof item === "string" ? item.length : 1);
      if (minimum > limit) throw tooLarge;
      return item;
    });
    return Buffer.byteLength(encoded) <= limit ? encoded : undefined;
  } catch (error) {
    if (error !== tooLarge) throw error;
    return undefined;
  }
}

export function packEvent(source: DispatchEvent): string {
  // 可变正文先减到预算内，再编码整个事件，避免为超大模型输出复制整段 JSON。
  let truncated = false;
  const bounded = (value: string, budget = EVENT_BYTES - 2048) => {
    const result = clip(value, budget);
    if (result !== value) truncated = true;
    return result;
  };
  let event: ApiEvent;
  switch (source.type) {
    case "message.created": {
      const body = bounded(source.message.body);
      event = {
        event: source.type,
        data: {
          sessionId: source.sessionId,
          runId: source.runId,
          message:
            body === source.message.body
              ? source.message
              : { ...source.message, body, truncated: true },
        },
      };
      break;
    }
    case "message.delta": {
      const { type, text, ...scope } = source;
      event = { event: type, data: { ...scope, text: bounded(text) } };
      break;
    }
    case "work.updated": {
      const work = source.work;
      event = {
        event: source.type,
        data: {
          work: {
            ...work,
            title: bounded(work.title, 4096),
            goal: bounded(work.goal, EVENT_BYTES - 8192),
          },
        },
      };
      break;
    }
    case "run.event": {
      const { type, event: record, approval, ...scope } = source;
      // 只转发 T-008 已脱敏的摘要。原生审批原文可能含完整命令或凭据。
      const data: ApiEventData["run.event"] = { ...scope, event: record };
      if (approval) data.approval = { requestId: approval.requestId, summary: record.summary };
      event = { event: type, data };
      break;
    }
    case "run.started":
    case "run.ended": {
      const { type, ...data } = source;
      event = { event: type, data };
      break;
    }
    case "member.status": {
      event = { event: source.type, data: { memberId: source.memberId, status: source.status } };
      break;
    }
  }
  return (
    encodeFrame(truncated ? { ...event, truncated: true } : event, EVENT_BYTES) ??
    JSON.stringify({ event: source.type, data: null, truncated: true } satisfies ApiEvent)
  );
}
