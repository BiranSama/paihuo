import { fork } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { Conversation, Member, Message, Run, Session, WorkItem } from "@paihuo/shared";
import { buildSync } from "esbuild";
import { afterEach, expect, test, vi } from "vitest";
import { openStore } from "./index";
import { migrate } from "./migrate";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});
function directory() {
  const dir = mkdtempSync(join(tmpdir(), "paihuo-storage-test-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function open(dir: string) {
  const store = openStore(dir);
  cleanups.push(store.close);
  return store;
}
function inspect(dir: string) {
  const db = new DatabaseSync(join(dir, "paihuo.db"));
  cleanups.push(() => {
    if (db.isOpen) db.close();
  });
  return db;
}

const time = "2026-01-01T00:00:00Z";
const member: Member = {
  id: "m",
  name: "成员",
  title: "测试",
  salutation: "老板",
  runtime_kind: "codex",
  runtime_config: { names: ["a", "b"], enabled: true },
  builtin: false,
  status: "active",
  created_by: "boss",
  created_at: time,
  archived_at: null,
};
const chat: Conversation = { id: "chat", kind: "dm", title: "对话", created_at: time };
const session: Session = {
  id: "s",
  member_id: "m",
  kind: "dm",
  scope_id: "chat",
  runtime_kind: "codex",
  native_session: null,
  cwd: "./work",
  state: "active",
  prev_session_id: null,
  created_at: time,
  last_active_at: time,
};
const input: Omit<Message, "seq"> = {
  id: "input",
  conversation_id: "chat",
  author_kind: "boss",
  author_id: null,
  body: "你好",
  work_item_id: null,
  created_at: time,
};
function seed(store: ReturnType<typeof openStore>) {
  store.members.insert(member);
  store.conversations.insert(chat);
  store.sessions.insert(session);
  store.messages.append(input);
}

test("创建八张一期表和数据目录；同一路径反复打开只执行一次迁移", () => {
  const dir = join(directory(), "自定义 空目录");
  const first = open(dir);
  const dirs = ["members", "logs", "work", "paihuo.db"];
  for (const entry of dirs) expect(existsSync(join(dir, entry))).toBe(true);
  first.conversations.insert(chat);
  first.close();
  const second = open(dir);
  expect(second.conversations.get(chat.id)).toEqual(chat);
  second.close();
  const db = inspect(dir);
  expect(db.prepare("SELECT version FROM schema_migrations").all()).toEqual([{ version: 1 }]);
  expect(
    db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name),
  ).toEqual([
    "conversation_members",
    "conversations",
    "members",
    "messages",
    "run_events",
    "runs",
    "schema_migrations",
    "sessions",
    "work_items",
  ]);
});

test("临时目录选项用自己的目录并在关闭时释放", () => {
  expect(() => openStore("relative-path")).toThrow(/absolute/);
  const store = openStore({ temporary: true });
  try {
    expect(existsSync(join(store.dataDir, "paihuo.db"))).toBe(true);
  } finally {
    store.close();
  }
  expect(existsSync(store.dataDir)).toBe(false);
});

test("逐个迁移按编号提交；失败的 DDL 和数据与版本标记一起回滚，修正后可重试", () => {
  const db = inspect(directory());
  const first = {
    version: 1,
    sql: "CREATE TABLE sample (id INTEGER); INSERT INTO sample VALUES (7)",
  };
  const failing = {
    version: 2,
    sql: "CREATE TABLE incomplete (id INTEGER); INSERT INTO sample VALUES (8); INSERT INTO missing VALUES (1)",
  };
  expect(() => migrate(db, [failing, first])).toThrow(/missing/);
  expect(db.prepare("SELECT version FROM schema_migrations").all()).toEqual([{ version: 1 }]);
  expect(db.prepare("SELECT id FROM sample").all()).toEqual([{ id: 7 }]);
  expect(
    db.prepare("SELECT name FROM sqlite_schema WHERE name = 'incomplete'").get(),
  ).toBeUndefined();
  const fixed = { version: 2, sql: "INSERT INTO sample VALUES (9)" };
  migrate(db, [fixed, first]);
  migrate(db, [first, fixed]);
  expect(db.prepare("SELECT id FROM sample ORDER BY id").all()).toEqual([{ id: 7 }, { id: 9 }]);
  expect(() => migrate(db, [first])).toThrow(/history/);
  expect(db.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([
    { version: 1 },
    { version: 2 },
  ]);
});

test.each(["COMMIT", "END", "SAVEPOINT nested", "ATTACH ':memory:' AS other"])(
  "迁移载荷内的 %s 不能越过版本事务，失败后可修正重试",
  (command) => {
    const db = inspect(directory());
    const first = {
      version: 1,
      sql: "CREATE TABLE sample (n INTEGER); INSERT INTO sample VALUES (1)",
    };
    const invalid = {
      version: 2,
      sql: `CREATE TABLE partial (id INTEGER); INSERT INTO sample VALUES (2);
      /* 事务由引擎管理 */ ${command}; INSERT INTO missing VALUES (99)`,
    };
    expect(() => migrate(db, [first, invalid])).toThrow(/not authorized/);
    expect(db.prepare("SELECT version FROM schema_migrations").all()).toEqual([{ version: 1 }]);
    expect(db.prepare("SELECT n FROM sample").all()).toEqual([{ n: 1 }]);
    expect(
      db.prepare("SELECT name FROM sqlite_schema WHERE name = 'partial'").get(),
    ).toBeUndefined();
    migrate(db, [first, { version: 2, sql: "INSERT INTO sample VALUES (3)" }]);
    expect(db.prepare("SELECT n FROM sample ORDER BY n").all()).toEqual([{ n: 1 }, { n: 3 }]);
  },
);

test("迁移 SQL 不能解除连接的独占锁，回滚后其他连接仍然无法接管", () => {
  const dir = directory();
  const owner = inspect(dir);
  owner.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT");
  const first = { version: 1, sql: "CREATE TABLE sample (id INTEGER)" };
  const invalid = {
    version: 2,
    sql: "INSERT INTO sample VALUES (1); PRAGMA locking_mode = NORMAL",
  };
  expect(() => migrate(owner, [first, invalid])).toThrow(/not authorized/);
  expect(owner.prepare("SELECT version FROM schema_migrations").all()).toEqual([{ version: 1 }]);
  expect(owner.prepare("SELECT id FROM sample").all()).toEqual([]);
  const contender = inspect(dir);
  expect(() => contender.exec("BEGIN EXCLUSIVE")).toThrow(/database is locked/);
  migrate(owner, [first, { version: 2, sql: "INSERT INTO sample VALUES (2)" }]);
  owner.close();
  expect(contender.prepare("SELECT id FROM sample").all()).toEqual([{ id: 2 }]);
});

test("同进程第二次开库失败，活动运行持续有效，持有者正常退出后可接管恢复", () => {
  const dir = directory();
  const owner = open(dir);
  seed(owner);
  for (const state of ["queued", "running"] as const) {
    owner.runs.insert({
      id: state,
      session_id: "s",
      input_message_id: "input",
      state,
      started_at: null,
      ended_at: null,
      end_reason: null,
    });
  }
  expect(() => open(dir)).toThrow(/already in use/);
  for (const state of ["queued", "running"] as const)
    expect(owner.runs.get(state)?.state).toBe(state);
  expect(owner.messages.append({ ...input, id: "after-contention" }).seq).toBe(2);
  owner.close();
  const successor = open(dir);
  expect(successor.runs.get("queued")?.state).toBe("unknown");
  expect(successor.runs.get("running")?.state).toBe("unknown");
  expect(successor.messages.get("after-contention")?.seq).toBe(2);
});

test("八张表支持类型化写入、回读与引用约束", () => {
  const store = open(directory());
  seed(store);
  expect(store.members.get("m")).toEqual(member);
  expect(store.members.update({ ...member, builtin: true })).toBe(true);
  expect(store.members.get("m")?.builtin).toBe(true);
  expect(store.conversations.get(chat.id)).toEqual(chat);
  const membership = { conversation_id: chat.id, member_id: member.id };
  store.conversationMembers.insert(membership);
  expect(store.conversationMembers.get(chat.id, member.id)).toEqual(membership);
  expect(() => store.conversationMembers.insert({ ...membership, member_id: "absent" })).toThrow(
    /foreign key/i,
  );
  const item: WorkItem = {
    id: "w",
    title: "事项",
    goal: "完成",
    owner_member_id: "m",
    status: "running",
    conversation_id: "chat",
    dir: "work",
    created_at: time,
    updated_at: time,
  };
  store.workItems.insert(item);
  expect(store.workItems.get("w")).toEqual(item);
  const message = store.messages.append({
    ...input,
    id: "reply",
    body: "好的",
    author_kind: "member",
    author_id: "m",
    work_item_id: "w",
  });
  expect(message.seq).toBe(2);
  expect(store.messages.get("reply")).toEqual(message);
  expect(store.sessions.get("s")).toEqual(session);
  const run: Run = {
    id: "r",
    session_id: "s",
    input_message_id: "input",
    state: "done",
    started_at: time,
    ended_at: time,
    end_reason: "结束",
  };
  store.runs.insert(run);
  expect(store.runs.get("r")).toEqual(run);
  const event = {
    id: "e",
    run_id: "r",
    seq: 1,
    kind: "note",
    summary: "一行摘要",
    created_at: time,
  } as const;
  store.runEvents.insert(event);
  expect(store.runEvents.get("e")).toEqual(event);
});

test("同一成员的活跃和休眠互斥，归档释放；不同成员、种类、场合 ID 互不占位", () => {
  const store = open(directory());
  seed(store);
  const second = { ...session, id: "second" };
  expect(() => store.sessions.insert(second)).toThrow(/unique/i);
  expect(store.sessions.update({ ...session, state: "sleeping" })).toBe(true);
  expect(() => store.sessions.insert(second)).toThrow(/unique/i);
  expect(() => store.sessions.insert({ ...second, state: "sleeping" })).toThrow(/unique/i);
  store.members.insert({ ...member, id: "other" });
  store.sessions.insert({ ...session, id: "other-member", member_id: "other" });
  store.sessions.insert({ ...session, id: "other-kind", kind: "task" });
  store.sessions.insert({ ...session, id: "other-scope", scope_id: "second-chat" });
  store.sessions.update({ ...session, state: "archived" });
  store.sessions.insert({ ...second, prev_session_id: session.id });
  expect(() => store.sessions.update({ ...session, state: "active" })).toThrow(/unique/i);
  expect(store.sessions.get(second.id)?.prev_session_id).toBe(session.id);
  expect(store.sessions.get(session.id)?.state).toBe("archived");
});

test("一万条消息按会话和排他游标双向取页，实际预编译查询以索引和 LIMIT 限定读取", () => {
  const dir = directory();
  const initial = open(dir);
  initial.conversations.insert(chat);
  initial.conversations.insert({ ...chat, id: "other" });
  initial.close();
  const db = inspect(dir);
  db.exec(`WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n<10000)
    INSERT INTO messages (id, conversation_id, seq, author_kind, body, created_at)
    SELECT 'bulk-' || n, 'chat', n, 'boss', 'text', 'time' FROM numbers`);
  db.close();
  const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
  const queries: string[] = [];
  let store: ReturnType<typeof openStore>;
  try {
    store = open(dir);
    for (const [sql] of prepare.mock.calls) {
      if (sql.startsWith("SELECT * FROM messages WHERE conversation_id")) queries.push(sql);
    }
  } finally {
    prepare.mockRestore();
  }
  expect(queries).toHaveLength(4);
  expect(store.messages.append({ ...input, id: "other", conversation_id: "other" }).seq).toBe(1);
  expect(store.messages.append({ ...input, id: "last" }).seq).toBe(10001);

  const seqs = (messages: Message[]) => messages.map((row) => row.seq);
  expect(seqs(store.messages.after("chat", undefined, 3))).toEqual([1, 2, 3]);
  expect(seqs(store.messages.before("chat", undefined, 3))).toEqual([9999, 10000, 10001]);
  expect(seqs(store.messages.before("chat", 5000, 3))).toEqual([4997, 4998, 4999]);
  expect(seqs(store.messages.after("chat", 4999, 3))).toEqual([5000, 5001, 5002]);
  expect(seqs(store.messages.before("chat", 1, 3))).toEqual([]);
  expect(seqs(store.messages.after("chat", 10001, 3))).toEqual([]);
  expect(seqs(store.messages.after("chat", 9999, 20))).toEqual([10000, 10001]);
  expect(seqs(store.messages.before("other", undefined, 20))).toEqual([1]);
  expect(() => store.messages.after("chat", 0, -1)).toThrow(RangeError);
  store.close();
  const inspection = inspect(dir);
  for (const sql of queries) {
    expect(sql).toMatch(/LIMIT \?$/);
    const crossCursor = sql.includes("AND seq");
    const parameters = crossCursor ? ["chat", 5000, 3] : ["chat", 3];
    const plan = inspection
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...parameters)
      .map((row) => row.detail)
      .join(" ");
    expect(plan).toMatch(/SEARCH messages USING INDEX messages_conversation_seq/);
    expect(plan).not.toMatch(/TEMP B-TREE|SCAN messages/);
    if (crossCursor) expect(plan).toMatch(/seq[<>]\?/);
  }
});

test("外部强杀持库子进程后已提交内容保留、未提交内容回滚，只恢复未结束的运行", async () => {
  const dir = directory();
  const before = open(dir);
  seed(before);
  before.close();
  const executable = join(dir, "crash-child.cjs");
  buildSync({
    entryPoints: [fileURLToPath(new URL("./fixtures/crash-child.ts", import.meta.url))],
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    outfile: executable,
  });
  const child = fork(executable, [dir], {
    execArgv: [],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let diagnostics = "";
  child.stderr?.on("data", (data) => {
    diagnostics += data.toString();
  });
  const exit = once(child, "exit");
  const timeout = AbortSignal.timeout(6000);
  try {
    function nextMessage() {
      return Promise.race([
        once(child, "message", { signal: timeout }),
        exit.then(() => {
          throw new Error(`Child exited before checkpoint: ${diagnostics}`);
        }),
      ]);
    }
    expect((await nextMessage())[0]).toBe("committed-and-idle");
    expect(() => open(dir)).toThrow(/already in use/);
    const pending = nextMessage();
    child.send("begin-pending");
    expect((await pending)[0]).toBe("committed-and-transaction-open");
    expect(child.kill("SIGKILL")).toBe(true);
    const [code, signal] = await exit;
    expect(signal === "SIGKILL" || code !== 0).toBe(true);
    const after = open(dir);
    expect(after.messages.get("committed")?.body).toBe("已提交");
    expect(after.conversations.get("uncommitted")).toBeUndefined();
    for (const state of ["queued", "running", "unknown", "done", "cancelled", "failed"] as const) {
      const run = after.runs.get(state);
      expect(run?.state).toBe(state === "queued" || state === "running" ? "unknown" : state);
      if (state === "done") expect(run?.ended_at).toBe("finished");
    }
    after.close();
    expect(inspect(dir).prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exit;
  }
}, 15000);
