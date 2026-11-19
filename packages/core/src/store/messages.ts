import type { DatabaseSync } from "node:sqlite";
import type { Message } from "@paihuo/shared";

function pages(db: DatabaseSync, direction: "before" | "after") {
  const older = direction === "before";
  const order = older ? "DESC" : "ASC";
  const base = "SELECT * FROM messages WHERE conversation_id = ?";
  const end = `ORDER BY seq ${order} LIMIT ?`;
  const first = db.prepare(`${base} ${end}`);
  const next = db.prepare(`${base} AND seq ${older ? "<" : ">"} ? ${end}`);
  return (conversationId: string, cursor: number | undefined, limit: number): Message[] => {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("Invalid page size");
    if (cursor !== undefined && !Number.isSafeInteger(cursor))
      throw new RangeError("Invalid message cursor");
    const rows =
      cursor === undefined
        ? first.all(conversationId, limit)
        : next.all(conversationId, cursor, limit);
    // 两个方向都以时间正序返回；只反转 SQL 已经截断的一页。
    return (older ? rows.reverse() : rows) as unknown as Message[];
  };
}

export function createMessages(db: DatabaseSync) {
  const get = db.prepare("SELECT * FROM messages WHERE id = ?");
  // 分配会话内下个序号和插入属于同一条写语句，失败或并发时不会复用已提交的序号。
  const append = db.prepare(`
    INSERT INTO messages (seq,conversation_id,id,author_kind,author_id,body,work_item_id,created_at)
    SELECT coalesce(max(seq),0) + 1, ?, ?, ?, ?, ?, ?, ? FROM messages WHERE conversation_id = ?
    RETURNING *
  `);
  return {
    get(id: string) {
      return get.get(id) as unknown as Message | undefined;
    },
    append(message: Omit<Message, "seq">): Message {
      return append.get(
        message.conversation_id,
        message.id,
        message.author_kind,
        message.author_id,
        message.body,
        message.work_item_id,
        message.created_at,
        message.conversation_id,
      ) as unknown as Message;
    },
    before: pages(db, "before"),
    after: pages(db, "after"),
  };
}
