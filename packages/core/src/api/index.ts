import type { ApiReply, ApiRequest, MemberView, SystemInfo } from "@paihuo/shared";
import { type createDispatch, MissingAdapterError } from "../dispatch";
import type { Store } from "../store";
import { catalogPage, clip, pageOf, workView } from "./bounds";
import { failure, PAGE_SIZE, parseRequest } from "./protocol";

type Dispatch = ReturnType<typeof createDispatch>;
type DomainRequest = Exclude<ApiRequest, { method: "system.info" }>;

export function createApi(store: Store, dispatch: Dispatch) {
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
        const { cursor, limit = PAGE_SIZE } = request.params ?? {};
        const ids = store.dispatch.pageMemberIds(cursor, limit + 1);
        const { items: members, nextCursor } = catalogPage(ids, limit, (memberId): MemberView => {
          const member = store.members.get(memberId);
          if (!member) throw new Error("缺少成员记录");
          const name = clip(member.name, 32 * 1024),
            title = clip(member.title, 256 * 1024),
            salutation = clip(member.salutation, 16 * 1024);
          const truncated =
            name !== member.name || title !== member.title || salutation !== member.salutation;
          return {
            id: memberId,
            name,
            title,
            salutation,
            runtime_kind: member.runtime_kind,
            builtin: member.builtin,
            activity: dispatch.memberStatus(memberId),
            ...(truncated ? { truncated: true as const } : {}),
          };
        });
        return { id, result: { members, nextCursor } };
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
        return { id, result: { accepted: true, ...dispatch.sendMessage(conversationId, text) } };
      }
      case "work.list": {
        const { cursor, limit = PAGE_SIZE } = request.params ?? {};
        return {
          id,
          result: catalogPage(store.dispatch.pageWork(cursor, limit + 1), limit, workView),
        };
      }
      case "work.get": {
        const work = store.workItems.get(request.params.workId);
        if (!work) return failure(id, "NOT_FOUND", "工作项不存在");
        const events = store.dispatch.recentWorkEvents(work.id).map((record) => {
          const summary = clip(record.summary, 4096);
          return summary === record.summary
            ? record
            : { ...record, summary, truncated: true as const };
        });
        return {
          id,
          result: {
            work: workView(work),
            events,
            notices: store.dispatch.recentWorkNotices(work.id),
          },
        };
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
    if (error instanceof MissingAdapterError)
      return failure(request.id, "ADAPTER_NOT_READY", "该成员的运行时适配器尚未就绪");
    if (error instanceof RangeError)
      return failure(request.id, "RESPONSE_TOO_LARGE", "响应超过单帧上限");
    return failure(request.id, "INTERNAL_ERROR", "内核未能完成命令");
  }
}
