/**
 * Monetary helpers.
 *
 * Amounts are stored as REAL rupees. Every computed amount passes through
 * `round2` before it is persisted or returned, which keeps floating-point drift
 * out of invoices and reports.
 */

export function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function round1(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

/** Safe division that returns 0 instead of NaN/Infinity when the divisor is 0. */
export function safeDiv(numerator: number, denominator: number): number {
  if (!denominator || !Number.isFinite(denominator)) return 0;
  const result = numerator / denominator;
  return Number.isFinite(result) ? result : 0;
}

/** Percentage change from `previous` to `current`. Returns 0 when there is no base. */
export function pctChange(current: number, previous: number): number {
  if (!previous) return current > 0 ? 100 : 0;
  return round1(((current - previous) / Math.abs(previous)) * 100);
}

/** `part` as a percentage of `whole`. */
export function pctOf(part: number, whole: number): number {
  return round1(safeDiv(part, whole) * 100);
}

/**
 * Gross margin percentage.
 *   Gross Profit  = Revenue - COGS
 *   Gross Margin% = Gross Profit / Revenue x 100
 */
export function grossMarginPct(revenue: number, cogs: number): number {
  return round1(safeDiv(revenue - cogs, revenue) * 100);
}
