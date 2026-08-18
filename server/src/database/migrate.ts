import bcrypt from 'bcryptjs';
import { getDb, type Db } from './connection';
import { SCHEMA_SQL } from './schema';
import { defaultThresholds } from '../config';

/**
 * Default settings written on first run. Users can change all of these from the
 * Settings screen; the analytics engine reads them at request time.
 */
export const DEFAULT_SETTINGS: Record<string, string> = {
  pharmacy_name: 'PharmaPulse Demo Pharmacy',
  pharmacy_address: '14 MG Road, Pune, Maharashtra 411001',
  pharmacy_phone: '+91 20 4000 1234',
  pharmacy_email: 'contact@pharmapulse.demo',
  pharmacy_tax_id: '27ABCDE1234F1Z5',
  invoice_prefix: 'INV',
  purchase_prefix: 'PO',
  return_prefix: 'RET',
  currency_symbol: '₹',
  ...Object.fromEntries(Object.entries(defaultThresholds).map(([k, v]) => [k, String(v)])),
};

/**
 * Demo accounts. These are DEMONSTRATION credentials for a student portfolio
 * project - they are documented in the README and are not production security.
 */
export const DEMO_USERS = [
  { username: 'admin', password: 'admin123', full_name: 'Anita Deshmukh', role: 'ADMIN' },
  { username: 'pharmacist', password: 'pharma123', full_name: 'Rahul Kulkarni', role: 'PHARMACIST' },
  { username: 'staff', password: 'staff123', full_name: 'Sneha Patil', role: 'STAFF' },
] as const;

/** Creates every table/index if it does not exist. Safe to run repeatedly. */
export function createSchema(db: Db = getDb()): void {
  db.exec(SCHEMA_SQL);
}

/** Inserts default settings rows without overwriting values the user changed. */
export function seedSettings(db: Db = getDb()): void {
  const stmt = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  const run = db.transaction(() => {
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) stmt.run(key, value);
  });
  run();
}

/** Creates the three demo accounts if the users table is empty. */
export function seedUsers(db: Db = getDb()): void {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  if (count.n > 0) return;

  const stmt = db.prepare(
    'INSERT INTO users (username, password_hash, full_name, role) VALUES (?, ?, ?, ?)',
  );
  const run = db.transaction(() => {
    for (const u of DEMO_USERS) {
      stmt.run(u.username, bcrypt.hashSync(u.password, 10), u.full_name, u.role);
    }
  });
  run();
}

/**
 * Full bootstrap: schema + settings + demo users.
 * Called on server start so the app is usable immediately after `npm run dev`.
 */
export function runMigrations(db: Db = getDb()): void {
  createSchema(db);
  seedSettings(db);
  seedUsers(db);
}
