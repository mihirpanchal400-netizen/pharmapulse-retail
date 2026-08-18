import { getDb } from '../database/connection';
import { defaultThresholds, type Thresholds } from '../config';

export function getAllSettings(): Record<string, string> {
  const rows = getDb().prepare('SELECT key, value FROM settings').all() as {
    key: string;
    value: string;
  }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function getSetting(key: string, fallback = ''): string {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? fallback;
}

export function updateSettings(updates: Record<string, string>): Record<string, string> {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  );
  db.transaction(() => {
    for (const [key, value] of Object.entries(updates)) stmt.run(key, String(value));
  })();
  return getAllSettings();
}

/**
 * Effective analytics thresholds = code defaults overridden by anything stored
 * in the `settings` table. Nothing in the analytics engine hardcodes a number.
 */
export function getThresholds(): Thresholds {
  const stored = getAllSettings();
  const result = { ...defaultThresholds } as Record<string, number>;
  for (const key of Object.keys(defaultThresholds)) {
    const raw = stored[key];
    if (raw !== undefined && raw !== '' && Number.isFinite(Number(raw))) {
      result[key] = Number(raw);
    }
  }
  return result as Thresholds;
}

export interface PharmacyProfile {
  pharmacy_name: string;
  pharmacy_address: string;
  pharmacy_phone: string;
  pharmacy_email: string;
  pharmacy_tax_id: string;
  invoice_prefix: string;
  purchase_prefix: string;
  return_prefix: string;
  currency_symbol: string;
}

export function getPharmacyProfile(): PharmacyProfile {
  const s = getAllSettings();
  return {
    pharmacy_name: s.pharmacy_name ?? 'PharmaPulse Retail',
    pharmacy_address: s.pharmacy_address ?? '',
    pharmacy_phone: s.pharmacy_phone ?? '',
    pharmacy_email: s.pharmacy_email ?? '',
    pharmacy_tax_id: s.pharmacy_tax_id ?? '',
    invoice_prefix: s.invoice_prefix ?? 'INV',
    purchase_prefix: s.purchase_prefix ?? 'PO',
    return_prefix: s.return_prefix ?? 'RET',
    currency_symbol: s.currency_symbol ?? '₹',
  };
}

/**
 * Sequential document numbers, e.g. INV-2026-000148.
 * The counter is derived from the highest existing number for the current year,
 * inside the caller's transaction, so concurrent sales cannot collide.
 */
export function nextDocumentNumber(
  table: 'sales' | 'purchases' | 'sale_returns',
  column: 'invoice_number' | 'purchase_number' | 'return_number',
  prefix: string,
): string {
  const year = new Date().getFullYear();
  const like = `${prefix}-${year}-%`;
  const row = getDb()
    .prepare(`SELECT ${column} AS num FROM ${table} WHERE ${column} LIKE ? ORDER BY id DESC LIMIT 1`)
    .get(like) as { num: string } | undefined;

  let next = 1;
  if (row?.num) {
    const tail = Number(row.num.split('-').pop());
    if (Number.isFinite(tail)) next = tail + 1;
  }
  return `${prefix}-${year}-${String(next).padStart(6, '0')}`;
}
