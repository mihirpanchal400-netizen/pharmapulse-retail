import { getDb, type Db } from './connection';
import { SCHEMA_V2_SQL, V2_COLUMNS } from './schemaV2';

/**
 * Schema v2 migration.
 *
 * Runs on every server start, after the v1 migration. Every step is idempotent
 * and additive, so an existing database with real trading history upgrades in
 * place with no data loss and no separate migration tool.
 */

/** True when `table` already has `column`. */
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

/**
 * SQLite cannot ALTER an existing CHECK constraint, and the original `sales`
 * table restricted payment_method to CASH/UPI/CARD/OTHER. Credit sales are a
 * core part of Indian retail pharmacy trade, so the table is rebuilt once to
 * widen the constraint.
 *
 * The rebuild is guarded: it only runs when the stored DDL does not already
 * mention CREDIT, so it happens exactly once regardless of how many times the
 * server restarts.
 */
function widenPaymentMethods(db: Db): boolean {
  if (!tableExists(db, 'sales')) return false;

  const ddl = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sales'")
    .get() as { sql: string } | undefined;
  if (!ddl?.sql || ddl.sql.includes("'CREDIT'")) return false;

  // Foreign keys are suspended for the swap. This must sit OUTSIDE the
  // transaction: SQLite ignores a foreign_keys pragma issued inside one.
  db.pragma('foreign_keys = OFF');
  try {
    db.exec(`
      BEGIN;

      CREATE TABLE sales_v2 (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        invoice_number TEXT NOT NULL UNIQUE,
        customer_id    INTEGER REFERENCES customers(id) ON DELETE SET NULL,
        user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
        sale_date      TEXT NOT NULL,
        subtotal       REAL NOT NULL DEFAULT 0,
        discount       REAL NOT NULL DEFAULT 0,
        tax            REAL NOT NULL DEFAULT 0,
        total          REAL NOT NULL DEFAULT 0,
        cogs           REAL NOT NULL DEFAULT 0,
        payment_method TEXT NOT NULL DEFAULT 'CASH'
                         CHECK (payment_method IN ('CASH','UPI','CARD','CREDIT','OTHER')),
        status         TEXT NOT NULL DEFAULT 'COMPLETED'
                         CHECK (status IN ('COMPLETED','RETURNED','PARTIALLY_RETURNED','CANCELLED')),
        notes          TEXT,
        paid_amount    REAL NOT NULL DEFAULT 0,
        due_date       TEXT,
        created_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );

      INSERT INTO sales_v2
        (id, invoice_number, customer_id, user_id, sale_date, subtotal, discount, tax,
         total, cogs, payment_method, status, notes, paid_amount, due_date, created_at)
      SELECT
         id, invoice_number, customer_id, user_id, sale_date, subtotal, discount, tax,
         total, cogs, payment_method, status, notes,
         ${hasColumn(db, 'sales', 'paid_amount') ? 'paid_amount' : 'total'},
         ${hasColumn(db, 'sales', 'due_date') ? 'due_date' : 'NULL'},
         created_at
      FROM sales;

      DROP TABLE sales;
      ALTER TABLE sales_v2 RENAME TO sales;
      CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(sale_date);

      COMMIT;
    `);
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      /* nothing to roll back */
    }
    throw err;
  } finally {
    db.pragma('foreign_keys = ON');
  }

  return true;
}

export interface V2MigrationResult {
  tablesCreated: string[];
  columnsAdded: string[];
  paymentMethodsWidened: boolean;
}

export function runMigrationsV2(db: Db = getDb()): V2MigrationResult {
  const before = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
      .map((r) => r.name),
  );

  // 1. New tables.
  db.exec(SCHEMA_V2_SQL);

  const after = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
  ).map((r) => r.name);
  const tablesCreated = after.filter((name) => !before.has(name) && !name.startsWith('sqlite_'));

  // 2. New columns on existing tables, with backfills for rows already there.
  const columnsAdded: string[] = [];
  for (const spec of V2_COLUMNS) {
    if (!tableExists(db, spec.table)) continue;
    if (hasColumn(db, spec.table, spec.column)) continue;

    db.exec(`ALTER TABLE ${spec.table} ADD COLUMN ${spec.column} ${spec.definition}`);
    if (spec.backfill) db.exec(spec.backfill);
    columnsAdded.push(`${spec.table}.${spec.column}`);
  }

  // 3. Widen the sales payment-method constraint to allow CREDIT.
  //    Runs after step 2 so paid_amount / due_date already exist to copy.
  const paymentMethodsWidened = widenPaymentMethods(db);

  return { tablesCreated, columnsAdded, paymentMethodsWidened };
}
