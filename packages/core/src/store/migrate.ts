import { constants, type DatabaseSync } from "node:sqlite";
import { initialMigration } from "../../migrations/001-initial";

interface Migration {
  version: number;
  sql: string;
}

// 事务边界和数据库文件由迁移引擎持有。交给 SQLite 判断操作类别，含注释、别名和多语句。
const blockedOperations = new Set([
  constants.SQLITE_TRANSACTION,
  constants.SQLITE_SAVEPOINT,
  constants.SQLITE_ATTACH,
  constants.SQLITE_DETACH,
]);

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
    // 版本记录和本次 DDL/DML 在同一事务内提交。
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY) STRICT");
      const applied = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
      if (applied.some((row, index) => row.version !== ordered[index]?.version)) {
        throw new Error("Database migration history does not match this core");
      }
      if (!applied.some((row) => row.version === migration.version)) {
        db.setAuthorizer((action) =>
          blockedOperations.has(action) ? constants.SQLITE_DENY : constants.SQLITE_OK,
        );
        try {
          db.exec(migration.sql);
        } finally {
          db.setAuthorizer(null);
        }
        db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(migration.version);
      }
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }
}
