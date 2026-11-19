import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore } from "../index";

// 仅由隔离测试 fork。父进程收到确认后强杀，本进程故意不调用 close。
const dir = process.argv[2];
if (!process.send || !dir) throw new Error("Expected IPC and temporary data directory");
const store = openStore(dir);
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
const pending = new DatabaseSync(join(dir, "paihuo.db"));
pending.exec(
  "BEGIN IMMEDIATE; INSERT INTO conversations VALUES ('uncommitted','dm','临时','time')",
);
process.once("disconnect", () => process.exit(1));
process.send("committed-and-transaction-open");
