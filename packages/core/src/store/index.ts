import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createMessages } from "./messages";
import { migrate } from "./migrate";
import { createRecords } from "./records";

// T-008 由内核启动处传入外壳给出的绝对目录，每个内核生命周期打开一次，并在退出时 close。
export function openStore(location: string | { temporary: true }) {
  const temporary = typeof location !== "string";
  const dataDir = temporary ? mkdtempSync(join(tmpdir(), "paihuo-store-")) : location;
  if (!isAbsolute(dataDir)) throw new Error("Store requires an absolute data directory");
  let db: DatabaseSync | undefined;
  let closed = false;
  function close() {
    if (closed) return;
    if (db?.isOpen) db.close();
    if (temporary) rmSync(dataDir, { recursive: true, force: true });
    closed = true;
  }
  try {
    for (const directory of ["members", "work", "logs"])
      mkdirSync(join(dataDir, directory), { recursive: true });
    db = new DatabaseSync(join(dataDir, "paihuo.db"));
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL");
    migrate(db);
    db.exec("UPDATE runs SET state = 'unknown' WHERE state IN ('queued','running')");
    return { dataDir, ...createRecords(db), messages: createMessages(db), close };
  } catch (error) {
    close();
    throw error;
  }
}
