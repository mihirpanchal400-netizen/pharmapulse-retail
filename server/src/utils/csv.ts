/**
 * Minimal RFC-4180 CSV writer (no dependency required).
 */

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number | null | undefined;
}

function escapeCell(raw: string | number | null | undefined): string {
  if (raw === null || raw === undefined) return '';
  const s = String(raw);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const head = columns.map((c) => escapeCell(c.header)).join(',');
  const body = rows.map((row) => columns.map((c) => escapeCell(c.value(row))).join(','));
  // Leading BOM so Excel opens rupee symbols and names correctly.
  return '﻿' + [head, ...body].join('\r\n') + '\r\n';
}

/** Builds a safe, dated download filename. */
export function csvFilename(base: string): string {
  const stamp = new Date().toISOString().slice(0, 10);
  const safe = base.replace(/[^a-zA-Z0-9_-]+/g, '-').toLowerCase();
  return `${safe}-${stamp}.csv`;
}
