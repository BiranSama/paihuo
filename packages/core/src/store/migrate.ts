import type { DatabaseSync } from "node:sqlite";
import { initialMigration } from "../../migrations/001-initial";

interface Migration {
  version: number;
  sql: string;
}

export function migrate(db: DatabaseSync, migrations: readonly Migration[] = [initialMigration]) {
  const ordered = [...migrations].sort((left, right) => left.version - right.version);
  for (const [index, migration] of ordered.entries()) {
    if (
      !Number.isSafeInteger(migration.version) ||
      migration.version < 1 ||
      migration.version === ordered[index - 1]?.version
    ) {
      throw new Error("Invalid migration version");
    }
  }
  for (const migration of ordered) {
    // 先取得写锁，再核对已执行版本，两个开库进程也不会重复执行同一条迁移。
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY) STRICT");
      const applied = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
      if (applied.some((row, index) => row.version !== ordered[index]?.version)) {
        throw new Error("Database migration history does not match this core");
      }
      if (!applied.some((row) => row.version === migration.version)) {
        db.exec(migration.sql);
        db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(migration.version);
      }
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }
}
