import type { DatabaseSync } from "node:sqlite";
import type { Conversation, Member, Message, RunEvent, Session, WorkItem } from "@paihuo/shared";

export const interruptedRunNotice = "上次的工作被中断，状态待核对";

function validateLimit(limit: number, message = "Invalid dispatch page size") {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError(message);
}

export function createDispatchQueries(db: DatabaseSync) {
  const dm = db.prepare(`SELECT c.* FROM conversations c JOIN conversation_members cm
    ON cm.conversation_id = c.id WHERE cm.member_id = ? AND c.kind = 'dm'
    ORDER BY c.created_at, c.id LIMIT 1`);
  const recipient =
    db.prepare(`SELECT cm.member_id FROM conversation_members cm JOIN conversations c
    ON c.id = cm.conversation_id WHERE c.id = ? AND c.kind = 'dm' LIMIT 2`);
  const current = db.prepare(`SELECT * FROM sessions
    WHERE member_id = ? AND kind = ? AND scope_id = ? AND state != 'archived'`);
  const recovered = db.prepare(`SELECT r.session_id, m.conversation_id, m.work_item_id
    FROM runs r JOIN messages m ON m.id = r.input_message_id
    WHERE r.state = 'unknown' AND r.end_reason IS NOT 'recovery_notified'
    GROUP BY r.session_id, m.conversation_id, m.work_item_id LIMIT 1`);
  const mark = db.prepare(`UPDATE runs SET end_reason = 'recovery_notified' WHERE state = 'unknown'
    AND session_id = ? AND input_message_id IN
    (SELECT id FROM messages WHERE conversation_id = ? AND work_item_id IS ?)`);
  const workEvents = db.prepare(`SELECT e.* FROM sessions s JOIN runs r ON r.session_id = s.id
    JOIN run_events e ON e.run_id = r.id WHERE s.kind = 'task' AND s.scope_id = ?
    ORDER BY e.rowid DESC LIMIT ?`);
  const workNotices = db.prepare(`SELECT m.* FROM work_items w JOIN messages m
    ON m.conversation_id = w.conversation_id AND m.work_item_id = w.id
    WHERE w.id = ? AND m.author_kind = 'system' AND m.author_id IS NULL AND m.body = ?
    ORDER BY m.seq DESC LIMIT ?`);
  const memberIds = db.prepare(
    "SELECT id FROM members WHERE status = 'active' ORDER BY created_at,id",
  );
  const items = db.prepare("SELECT * FROM work_items ORDER BY created_at DESC,id");
  const firstMembersPage = db.prepare(
    "SELECT id FROM members WHERE status = 'active' ORDER BY id LIMIT ?",
  );
  const nextMembersPage = db.prepare(
    "SELECT id FROM members WHERE status = 'active' AND id > ? ORDER BY id LIMIT ?",
  );
  const firstWorkPage = db.prepare("SELECT * FROM work_items ORDER BY id LIMIT ?");
  const nextWorkPage = db.prepare("SELECT * FROM work_items WHERE id > ? ORDER BY id LIMIT ?");
  return {
    // 调用方只在同步回调中组合 SQL 操作。任一语句失败，连同此前分配的消息序号一起回滚。
    transaction<T>(body: () => T): T {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = body();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    },
    dmForMember(memberId: string) {
      return dm.get(memberId) as unknown as Conversation | undefined;
    },
    dmRecipient(conversationId: string) {
      const rows = recipient.all(conversationId);
      return rows.length === 1 ? (rows[0]?.member_id as string) : undefined;
    },
    currentSession(memberId: string, kind: Session["kind"], scopeId: string) {
      return current.get(memberId, kind, scopeId) as unknown as Session | undefined;
    },
    nextInterruptedScope() {
      return recovered.get() as unknown as
        | { session_id: string; conversation_id: string; work_item_id: string | null }
        | undefined;
    },
    markRecoveryNotified(sessionId: string, conversationId: string, workId: string | null) {
      mark.run(sessionId, conversationId, workId);
    },
    listMemberIds() {
      return memberIds.all().map((row) => row.id as Member["id"]);
    },
    listWork() {
      return items.all() as unknown as WorkItem[];
    },
    pageMemberIds(afterId?: string, limit = 51) {
      validateLimit(limit);
      const rows =
        afterId === undefined ? firstMembersPage.all(limit) : nextMembersPage.all(afterId, limit);
      return rows.map((row) => row.id as Member["id"]);
    },
    pageWork(afterId?: string, limit = 51) {
      validateLimit(limit);
      const rows =
        afterId === undefined ? firstWorkPage.all(limit) : nextWorkPage.all(afterId, limit);
      return rows as unknown as WorkItem[];
    },
    recentWorkEvents(workId: string, limit = 50) {
      validateLimit(limit, "Invalid work event limit");
      return workEvents.all(workId, limit).reverse() as unknown as RunEvent[];
    },
    recentWorkNotices(workId: string, limit = 50) {
      validateLimit(limit, "Invalid work notice limit");
      return workNotices.all(workId, interruptedRunNotice, limit).reverse() as unknown as Message[];
    },
  };
}
