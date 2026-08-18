import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { config } from '../config';

export type Db = Database.Database;

let instance: Db | null = null;

/**
 * Opens a SQLite database and applies the pragmas the application relies on.
 *  - foreign_keys: referential integrity is enforced by the engine, not by hope.
 *  - journal_mode WAL: better concurrent read performance (skipped for :memory:).
 *  - busy_timeout: avoids spurious SQLITE_BUSY on slower disks.
 */
export function openDatabase(file: string): Db {
  if (file !== ':memory:') {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  if (file !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  return db;
}

/** Process-wide database handle. */
export function getDb(): Db {
  if (!instance) instance = openDatabase(config.databasePath);
  return instance;
}

/** Replaces the process-wide handle (used by the test harness). */
export function setDb(db: Db): void {
  instance = db;
}

export function closeDb(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}

/**
 * Runs a callback inside a transaction. better-sqlite3 transactions are
 * synchronous, so any thrown error rolls the whole unit of work back.
 */
export function transaction<T>(fn: (db: Db) => T): T {
  const db = getDb();
  return db.transaction(fn)(db);
}
