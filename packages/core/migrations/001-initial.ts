// 迁移和内核静态打包；发布后的旧版本 SQL 保持原样，新版本另建文件。
export const initialMigration = {
  version: 1,
  sql: `
    CREATE TABLE members (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, title TEXT NOT NULL,
      salutation TEXT NOT NULL DEFAULT '老板',
      runtime_kind TEXT NOT NULL CHECK (runtime_kind IN ('claude-code','codex','acp','native')),
      runtime_config TEXT NOT NULL CHECK (json_valid(runtime_config) AND json_type(runtime_config) = 'object'),
      builtin INTEGER NOT NULL CHECK (builtin IN (0,1)),
      status TEXT NOT NULL CHECK (status IN ('active','archived')),
      created_by TEXT NOT NULL, created_at TEXT NOT NULL, archived_at TEXT
    ) STRICT;
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('dm','group')),
      title TEXT NOT NULL, created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE conversation_members (
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      member_id TEXT NOT NULL REFERENCES members(id),
      PRIMARY KEY (conversation_id, member_id)
    ) STRICT;
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id),
      kind TEXT NOT NULL CHECK (kind IN ('dm','group','task','oneshot')), scope_id TEXT NOT NULL,
      runtime_kind TEXT NOT NULL CHECK (runtime_kind IN ('claude-code','codex','acp','native')),
      native_session TEXT, cwd TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('active','sleeping','archived')),
      prev_session_id TEXT REFERENCES sessions(id), created_at TEXT NOT NULL, last_active_at TEXT NOT NULL
    ) STRICT;
    CREATE UNIQUE INDEX sessions_current_scope ON sessions(member_id,kind,scope_id) WHERE state != 'archived';
    CREATE TABLE work_items (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT NOT NULL,
      owner_member_id TEXT NOT NULL REFERENCES members(id),
      status TEXT NOT NULL CHECK (status IN ('running','waiting_boss','done','archived')),
      conversation_id TEXT NOT NULL REFERENCES conversations(id), dir TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
      seq INTEGER NOT NULL CHECK (seq BETWEEN 1 AND 9007199254740991),
      author_kind TEXT NOT NULL CHECK (author_kind IN ('boss','member','system')),
      author_id TEXT, body TEXT NOT NULL, work_item_id TEXT REFERENCES work_items(id), created_at TEXT NOT NULL
    ) STRICT;
    CREATE UNIQUE INDEX messages_conversation_seq ON messages(conversation_id,seq);
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
      input_message_id TEXT NOT NULL REFERENCES messages(id),
      state TEXT NOT NULL CHECK (state IN ('queued','running','done','failed','cancelled','unknown')),
      started_at TEXT, ended_at TEXT, end_reason TEXT
    ) STRICT;
    CREATE TABLE run_events (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), seq INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('tool_started','tool_finished','note','error')),
      summary TEXT NOT NULL, created_at TEXT NOT NULL
    ) STRICT;
  `,
};
