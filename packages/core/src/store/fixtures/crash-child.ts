import { DatabaseSync } from "node:sqlite";
import { mock } from "node:test";
import { openStore } from "../index";

// 仅由隔离测试 fork。父进程收到确认后强杀，本进程故意不调用 close。
const dir = process.argv[2];
if (!process.send || !dir) throw new Error("Expected IPC and temporary data directory");
// 仅在夹具捕获开库所用连接，以便模拟持锁内核写到一半时被强杀。
const tracker = mock.method(DatabaseSync.prototype, "prepare");
const store = openStore(dir);
const pending: unknown = tracker.mock.calls[0]?.this;
tracker.mock.restore();
if (!(pending instanceof DatabaseSync)) throw new Error("Missing owner database connection");
store.messages.append({
  id: "committed",
  conversation_id: "chat",
  author_kind: "boss",
  author_id: null,
  work_item_id: null,
  body: "已提交",
  created_at: "time",
});
for (const state of ["queued", "running", "unknown", "done", "cancelled", "failed"] as const) {
  store.runs.insert({
    id: state,
    session_id: "s",
    input_message_id: "committed",
    state,
    started_at: null,
    ended_at: state === "done" ? "finished" : null,
    end_reason: null,
  });
}
process.once("disconnect", () => process.exit(1));
process.once("message", (command) => {
  if (command !== "begin-pending") throw new Error("Unexpected parent command");
  for (const state of ["queued", "running"]) {
    if (store.runs.get(state)?.state !== state) throw new Error("Contender changed live run");
  }
  pending.exec(
    "BEGIN IMMEDIATE; INSERT INTO conversations VALUES ('uncommitted','dm','临时','time')",
  );
  process.send?.("committed-and-transaction-open");
});
process.send("committed-and-idle");
