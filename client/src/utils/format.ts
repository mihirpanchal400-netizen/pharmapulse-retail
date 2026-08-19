/**
 * Display formatting.
 *
 * Indian numbering (lakh/crore grouping) is used throughout, because that is
 * how the figures would be read in the context this software models.
 */

let currencySymbol = '₹';

export function setCurrencySymbol(symbol: string): void {
  if (symbol) currencySymbol = symbol;
}

export function currency(value: number | null | undefined, decimals = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${currencySymbol}${value.toLocaleString('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

/**
 * Compact currency for KPI tiles and chart axes, where a full figure would
 * crowd the space: 1,25,000 -> ₹1.25L
 */
export function currencyCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 10_000_000) return `${sign}${currencySymbol}${(abs / 10_000_000).toFixed(2)}Cr`;
  if (abs >= 100_000) return `${sign}${currencySymbol}${(abs / 100_000).toFixed(2)}L`;
  if (abs >= 1_000) return `${sign}${currencySymbol}${(abs / 1_000).toFixed(1)}K`;
  return `${sign}${currencySymbol}${Math.round(abs)}`;
}

export function number(value: number | null | undefined, decimals = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function percent(value: number | null | undefined, decimals = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(decimals)}%`;
}

/** Signed percentage for growth figures, where the direction is the point. */
export function percentSigned(value: number | null | undefined, decimals = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value > 0 ? '+' : ''}${value.toFixed(decimals)}%`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-08-19' -> '19 Aug 2026' */
export function date(value: string | null | undefined): string {
  if (!value) return '—';
  const [y, m, d] = value.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return value;
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** '2026-08-19' -> '19 Aug' — for chart axes where the year is implied. */
export function dateShort(value: string | null | undefined): string {
  if (!value) return '';
  const [, m, d] = value.slice(0, 10).split('-').map(Number);
  if (!m || !d) return value;
  return `${d} ${MONTHS[m - 1]}`;
}

/** '2026-08-19 14:30:00' -> '19 Aug 2026, 14:30' */
export function dateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const datePart = date(value);
  const timePart = value.slice(11, 16);
  return timePart ? `${datePart}, ${timePart}` : datePart;
}

/** '2026-08' -> 'Aug 2026' */
export function month(value: string | null | undefined): string {
  if (!value) return '—';
  const [y, m] = value.split('-').map(Number);
  if (!y || !m) return value;
  return `${MONTHS[m - 1]} ${y}`;
}

export function days(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${Math.round(value)} ${Math.round(value) === 1 ? 'day' : 'days'}`;
}

/** Turns an enum-ish token into a readable label: 'OUT_OF_STOCK' -> 'Out of stock'. */
export function humanize(value: string | null | undefined): string {
  if (!value) return '—';
  const spaced = value.replace(/_/g, ' ').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function initials(fullName: string): string {
  return fullName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}
