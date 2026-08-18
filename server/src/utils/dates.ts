/**
 * Date helpers.
 *
 * All dates are stored as ISO strings:
 *   - date-only columns  -> 'YYYY-MM-DD'   (expiry_date, purchase_date, ...)
 *   - timestamp columns  -> 'YYYY-MM-DD HH:MM:SS'
 *
 * Working in UTC-free plain strings keeps SQLite comparisons (`BETWEEN`,
 * `>=`) lexicographically correct and avoids timezone surprises in reports.
 */

export type IsoDate = string; // YYYY-MM-DD

export function toIsoDate(d: Date): IsoDate {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function toIsoDateTime(d: Date): string {
  const time = [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
  return `${toIsoDate(d)} ${time}`;
}

export function today(): IsoDate {
  return toIsoDate(new Date());
}

export function now(): string {
  return toIsoDateTime(new Date());
}

export function addDays(date: Date | IsoDate, days: number): IsoDate {
  const d = typeof date === 'string' ? parseIsoDate(date) : new Date(date);
  d.setDate(d.getDate() + days);
  return toIsoDate(d);
}

export function parseIsoDate(value: IsoDate): Date {
  const [y, m, d] = value.slice(0, 10).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

/** Whole days from `from` to `to`. Negative when `to` is in the past. */
export function daysBetween(from: IsoDate | Date, to: IsoDate | Date): number {
  const a = typeof from === 'string' ? parseIsoDate(from) : from;
  const b = typeof to === 'string' ? parseIsoDate(to) : to;
  const ms = b.getTime() - a.getTime();
  return Math.round(ms / 86_400_000);
}

/** Days remaining until `expiry`. Negative means already expired. */
export function daysUntil(expiry: IsoDate): number {
  return daysBetween(today(), expiry);
}

/**
 * Inclusive date window ending today.
 * `days = 30` returns the 30-day window [today-29 .. today].
 */
export function windowEndingToday(days: number): { from: IsoDate; to: IsoDate } {
  const to = today();
  return { from: addDays(to, -(days - 1)), to };
}

/** The equivalent window immediately preceding `windowEndingToday(days)`. */
export function previousWindow(days: number): { from: IsoDate; to: IsoDate } {
  const current = windowEndingToday(days);
  return { from: addDays(current.from, -days), to: addDays(current.from, -1) };
}

/** End-of-day bound so `sale_date` timestamps on the final day are included. */
export function endOfDay(date: IsoDate): string {
  return `${date} 23:59:59`;
}

export function startOfDay(date: IsoDate): string {
  return `${date} 00:00:00`;
}

export function monthKey(date: IsoDate): string {
  return date.slice(0, 7);
}
