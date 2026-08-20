import { getDb, type Db } from './connection';
import { SCHEMA_V3_SQL, V3_COLUMNS } from './schemaV3';

/**
 * Schema v3 migration - the Import Center tables.
 *
 * Runs on every server start after v1 and v2. Additive and idempotent, exactly
 * like migrateV2, so there is still no separate migration tool to run.
 */

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some((c) => c.name === column);
}

function tableExists(db: Db, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  return Boolean(row);
}

export interface V3MigrationResult {
  tablesCreated: string[];
  columnsAdded: string[];
}

export function runMigrationsV3(db: Db = getDb()): V3MigrationResult {
  const before = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
      .map((r) => r.name),
  );

  db.exec(SCHEMA_V3_SQL);

  const after = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
  ).map((r) => r.name);
  const tablesCreated = after.filter((name) => !before.has(name) && !name.startsWith('sqlite_'));

  const columnsAdded: string[] = [];
  for (const spec of V3_COLUMNS) {
    if (!tableExists(db, spec.table)) continue;
    if (hasColumn(db, spec.table, spec.column)) continue;

    db.exec(`ALTER TABLE ${spec.table} ADD COLUMN ${spec.column} ${spec.definition}`);
    if (spec.backfill) db.exec(spec.backfill);
    columnsAdded.push(`${spec.table}.${spec.column}`);
  }

  return { tablesCreated, columnsAdded };
}
