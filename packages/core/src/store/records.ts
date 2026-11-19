import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type {
  Conversation,
  ConversationMember,
  Member,
  Run,
  RunEvent,
  Session,
  WorkItem,
} from "@paihuo/shared";

// 表名与列名只由下方静态声明提供，调用方的所有数据通过绑定参数传入。
function records<Row extends { id: string } & { [Key in keyof Row]: SQLInputValue }>(
  db: DatabaseSync,
  table: string,
  fields: readonly Exclude<Extract<keyof Row, string>, "id">[],
) {
  const columns = ["id", ...fields];
  const insert = db.prepare(
    `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
  );
  const get = db.prepare(`SELECT * FROM ${table} WHERE id = ?`);
  const update = db.prepare(
    `UPDATE ${table} SET ${fields.map((key) => `${key} = ?`).join(",")} WHERE id = ?`,
  );
  return {
    insert(row: Row) {
      insert.run(row.id, ...fields.map((key) => row[key]));
    },
    get(id: string) {
      return get.get(id) as Row | undefined;
    },
    update(row: Row) {
      return update.run(...fields.map((key) => row[key]), row.id).changes === 1;
    },
  };
}

type MemberRow = Omit<Member, "runtime_config" | "builtin"> & {
  runtime_config: string;
  builtin: number;
};

function memberRow(member: Member): MemberRow {
  return {
    ...member,
    runtime_config: JSON.stringify(member.runtime_config),
    builtin: Number(member.builtin),
  };
}

export function createRecords(db: DatabaseSync) {
  const members = records<MemberRow>(db, "members", [
    "name",
    "title",
    "salutation",
    "runtime_kind",
    "runtime_config",
    "builtin",
    "status",
    "created_by",
    "created_at",
    "archived_at",
  ]);
  const memberships = {
    insert: db.prepare("INSERT INTO conversation_members (conversation_id,member_id) VALUES (?,?)"),
    get: db.prepare(
      "SELECT * FROM conversation_members WHERE conversation_id = ? AND member_id = ?",
    ),
  };

  return {
    members: {
      insert(member: Member) {
        members.insert(memberRow(member));
      },
      get(id: string): Member | undefined {
        const row = members.get(id);
        if (!row) return undefined;
        return {
          ...row,
          runtime_config: JSON.parse(row.runtime_config),
          builtin: row.builtin === 1,
        };
      },
      update(member: Member) {
        return members.update(memberRow(member));
      },
    },
    conversations: records<Conversation>(db, "conversations", ["kind", "title", "created_at"]),
    conversationMembers: {
      insert(row: ConversationMember) {
        memberships.insert.run(row.conversation_id, row.member_id);
      },
      get(conversationId: string, memberId: string) {
        return memberships.get.get(conversationId, memberId) as unknown as
          | ConversationMember
          | undefined;
      },
    },
    sessions: records<Session>(db, "sessions", [
      "member_id",
      "kind",
      "scope_id",
      "runtime_kind",
      "native_session",
      "cwd",
      "state",
      "prev_session_id",
      "created_at",
      "last_active_at",
    ]),
    workItems: records<WorkItem>(db, "work_items", [
      "title",
      "goal",
      "owner_member_id",
      "status",
      "conversation_id",
      "dir",
      "created_at",
      "updated_at",
    ]),
    runs: records<Run>(db, "runs", [
      "session_id",
      "input_message_id",
      "state",
      "started_at",
      "ended_at",
      "end_reason",
    ]),
    runEvents: records<RunEvent>(db, "run_events", [
      "run_id",
      "seq",
      "kind",
      "summary",
      "created_at",
    ]),
  };
}
