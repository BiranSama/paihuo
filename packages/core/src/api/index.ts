import type { ApiReply, ApiRequest, MemberView, SystemInfo } from "@paihuo/shared";
import type { AdapterRegistry, createDispatch } from "../dispatch";
import type { Store } from "../store";
import { clip, pageOf } from "./bounds";
import { failure, PAGE_SIZE, parseRequest } from "./protocol";

type Dispatch = ReturnType<typeof createDispatch>;
type DomainRequest = Exclude<ApiRequest, { method: "system.info" }>;

export function createApi(store: Store, dispatch: Dispatch, registry: AdapterRegistry) {
  function page(
    conversationId: string,
    direction: "before" | "after",
    cursor?: number,
    limit = PAGE_SIZE,
  ) {
    const read = direction === "before" ? store.messages.dmBefore : store.messages.dmAfter;
    return pageOf(read(conversationId, cursor, limit + 1), direction, limit);
  }

  function handle(request: DomainRequest): ApiReply {
    const { id } = request;
    switch (request.method) {
      case "member.list": {
        const members: MemberView[] = [];
        for (const memberId of store.dispatch.listMemberIds()) {
          const member = store.members.get(memberId);
          if (member) {
            const { id, name, title, salutation, runtime_kind, builtin } = member;
            members.push({
              id,
              name,
              title,
              salutation,
              runtime_kind,
              builtin,
              activity: dispatch.memberStatus(id),
            });
          }
        }
        return { id, result: { members } };
      }
      case "conversation.open": {
        const { memberId } = request.params;
        if (store.members.get(memberId)?.status !== "active")
          return failure(id, "NOT_FOUND", "成员不存在或已停用");
        const dm = dispatch.openDm(memberId);
        const title = clip(dm.title, 4096);
        const conversation = title === dm.title ? dm : { ...dm, title, truncated: true as const };
        return { id, result: { conversation, page: page(dm.id, "before") } };
      }
      case "message.page": {
        const { conversationId, direction, cursor, limit } = request.params;
        if (!store.dispatch.dmRecipient(conversationId))
          return failure(id, "NOT_FOUND", "私聊不存在");
        return { id, result: page(conversationId, direction, cursor, limit) };
      }
      case "message.send": {
        const { conversationId, text } = request.params;
        const memberId = store.dispatch.dmRecipient(conversationId);
        const member = memberId ? store.members.get(memberId) : undefined;
        if (member?.status !== "active") return failure(id, "NOT_FOUND", "私聊或在职成员不存在");
        try {
          registry.get(member.runtime_kind);
        } catch {
          return failure(id, "ADAPTER_NOT_READY", "该成员的运行时适配器尚未就绪");
        }
        return { id, result: { accepted: true, ...dispatch.sendMessage(conversationId, text) } };
      }
      case "work.list":
        return { id, result: { items: store.dispatch.listWork() } };
      case "work.get": {
        const work = store.workItems.get(request.params.workId);
        return work
          ? { id, result: { work, events: store.dispatch.recentWorkEvents(work.id) } }
          : failure(id, "NOT_FOUND", "工作项不存在");
      }
      case "member.create":
      case "member.update":
      case "member.archive":
      case "session.sleep":
      case "session.wake":
      case "request.answer":
        return failure(id, "NOT_IMPLEMENTED", "尚未实现");
    }
  }
  return { handle, subscribe: dispatch.subscribe };
}
export type CoreApi = ReturnType<typeof createApi>;

export function handleMessage(
  message: unknown,
  systemInfo: () => SystemInfo,
  api?: CoreApi,
): ApiReply {
  const request = parseRequest(message);
  if ("error" in request) return request;
  try {
    if (request.method === "system.info") return { id: request.id, result: systemInfo() };
    if (!api) return failure(request.id, "CORE_NOT_READY", "内核接口尚未就绪");
    return api.handle(request);
  } catch (error) {
    if (error instanceof RangeError)
      return failure(request.id, "RESPONSE_TOO_LARGE", "响应超过单帧上限");
    return failure(request.id, "INTERNAL_ERROR", "内核未能完成命令");
  }
}
