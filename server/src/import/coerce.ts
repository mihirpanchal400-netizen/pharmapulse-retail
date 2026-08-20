/**
 * Import Center - turning spreadsheet cells into stored values.
 *
 * Spreadsheets are not databases. A quantity arrives as "1,200", a price as
 * "Rs. 108.15", an expiry as "06/27", "Jun-27", "30-06-2027" or an Excel serial
 * number. This module is the single place that knows how to read all of that,
 * so no importer has to guess.
 *
 * Every function returns `{ ok, value, message }` rather than throwing. A bad
 * cell is a row-level finding to report, not an exception that aborts a
 * 4,000-row import.
 */

export interface CoerceResult<T> {
  ok: boolean;
  value: T | null;
  message?: string;
}

const ok = <T>(value: T | null): CoerceResult<T> => ({ ok: true, value });
const fail = <T>(message: string): CoerceResult<T> => ({ ok: false, value: null, message });
/** A blank cell: valid, with no value. Typed explicitly so `ok(null)` does not infer `null`. */
const blank = <T>(): CoerceResult<T> => ({ ok: true, value: null });

/** Cell text with surrounding whitespace, non-breaking spaces and quotes removed. */
export function cleanText(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  return String(raw)
    .replace(/ /g, ' ')
    .replace(/^["'\s]+|["'\s]+$/g, '')
    .trim();
}

export function isBlank(raw: unknown): boolean {
  const text = cleanText(raw);
  return text === '' || text === '-' || text === '--' || text.toUpperCase() === 'N/A' || text.toUpperCase() === 'NA';
}

/* -------------------------------------------------------------------------- */
/* Numbers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Parses a number written the way a person writes one.
 *
 * Handles the rupee symbol and "Rs", Indian digit grouping ("1,20,000"),
 * a trailing percent sign, and accounting negatives in brackets.
 */
export function coerceNumber(raw: unknown): CoerceResult<number> {
  if (isBlank(raw)) return blank<number>();
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? ok(raw) : fail('is not a finite number');
  }

  let text = cleanText(raw);

  // Accounting style: (150) means -150.
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }

  text = text
    .replace(/(?:rs\.?|inr|₹)/gi, '')
    .replace(/%/g, '')
    .replace(/,/g, '')
    .replace(/\s+/g, '')
    .trim();

  if (text === '' || text === '-') return blank<number>();
  if (text.startsWith('-')) {
    negative = true;
    text = text.slice(1);
  }

  if (!/^\d*\.?\d+$/.test(text)) return fail(`"${cleanText(raw)}" is not a number`);

  const value = Number(text);
  if (!Number.isFinite(value)) return fail(`"${cleanText(raw)}" is not a number`);
  return ok(negative ? -value : value);
}

export function coerceInteger(raw: unknown): CoerceResult<number> {
  const result = coerceNumber(raw);
  if (!result.ok || result.value === null) return result;

  // A quantity of 12.0 is a whole number written sloppily; 12.4 is a mistake
  // worth reporting rather than silently truncating.
  const rounded = Math.round(result.value);
  if (Math.abs(result.value - rounded) > 1e-9) {
    return fail(`"${cleanText(raw)}" must be a whole number`);
  }
  return ok(rounded);
}

/* -------------------------------------------------------------------------- */
/* Dates                                                                       */
/* -------------------------------------------------------------------------- */

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** Last day of a month, so a "06/2027" expiry becomes 2027-06-30. */
export function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Expands a two-digit year. Pharmacy files carry expiries a few years out and
 * purchase history a few years back, so the window is centred on the present:
 * anything more than 10 years ahead is read as the previous century's decade.
 */
function expandYear(value: number): number {
  if (value >= 100) return value;
  const currentCentury = Math.floor(new Date().getUTCFullYear() / 100) * 100;
  const candidate = currentCentury + value;
  return candidate > new Date().getUTCFullYear() + 20 ? candidate - 100 : candidate;
}

function validDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > lastDayOfMonth(y, m)) return false;
  if (y < 1900 || y > 2200) return false;
  return true;
}

/**
 * Parses a date to `YYYY-MM-DD`.
 *
 * `monthEnd` controls what a month-only value means: an expiry of "06/2027"
 * runs to the end of June, whereas a manufacturing date of "06/2027" starts at
 * the beginning of it.
 *
 * Ambiguous numeric dates are read DAY-FIRST. Indian pharmacy files are written
 * DD/MM/YYYY; reading 03/04/2027 as 4 March would silently corrupt expiry
 * tracking, which is the one thing this software must not get wrong.
 */
export function coerceDate(raw: unknown, monthEnd = false): CoerceResult<string> {
  if (isBlank(raw)) return blank<string>();

  // ExcelJS hands back a real Date for date-formatted cells.
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return fail('is not a valid date');
    return ok(iso(raw.getUTCFullYear(), raw.getUTCMonth() + 1, raw.getUTCDate()));
  }

  // A bare number is an Excel serial date (days since 1899-12-30).
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    if (raw < 1 || raw > 80000) return fail(`"${raw}" is not a valid date`);
    const date = new Date(Date.UTC(1899, 11, 30) + Math.round(raw) * 86400000);
    return ok(iso(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()));
  }

  const text = cleanText(raw);
  if (text === '') return blank<string>();

  // ISO first - unambiguous, so it never goes through the day-first rules.
  const isoMatch = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(text);
  if (isoMatch) {
    const [, y, m, d] = isoMatch.map(Number) as unknown as number[];
    if (!validDate(y, m, d)) return fail(`"${text}" is not a valid date`);
    return ok(iso(y, m, d));
  }

  // DD/MM/YYYY, D-M-YY, DD.MM.YYYY
  const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(text);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    const year = expandYear(Number(dmy[3]));
    if (!validDate(year, month, day)) return fail(`"${text}" is not a valid date`);
    return ok(iso(year, month, day));
  }

  // MM/YYYY or MM/YY - the classic pharma expiry.
  const my = /^(\d{1,2})[-/.](\d{2,4})$/.exec(text);
  if (my) {
    const month = Number(my[1]);
    const year = expandYear(Number(my[2]));
    if (month < 1 || month > 12) return fail(`"${text}" is not a valid month`);
    return ok(iso(year, month, monthEnd ? lastDayOfMonth(year, month) : 1));
  }

  // Jun-27, JUN 2027, 27-Jun
  const monthName = /^([a-z]{3,9})[-/ .]?(\d{2,4})$/i.exec(text);
  if (monthName) {
    const month = MONTHS[monthName[1].toLowerCase()];
    if (month) {
      const year = expandYear(Number(monthName[2]));
      return ok(iso(year, month, monthEnd ? lastDayOfMonth(year, month) : 1));
    }
  }

  // 30-Jun-2027, 30 June 27
  const dMonthY = /^(\d{1,2})[-/ .]([a-z]{3,9})[-/ .](\d{2,4})$/i.exec(text);
  if (dMonthY) {
    const month = MONTHS[dMonthY[2].toLowerCase()];
    const day = Number(dMonthY[1]);
    const year = expandYear(Number(dMonthY[3]));
    if (month && validDate(year, month, day)) return ok(iso(year, month, day));
  }

  // YYYYMMDD
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (compact) {
    const [, y, m, d] = compact.map(Number) as unknown as number[];
    if (validDate(y, m, d)) return ok(iso(y, m, d));
  }

  return fail(`"${text}" is not a date the importer recognises`);
}

/* -------------------------------------------------------------------------- */
/* Booleans and enums                                                          */
/* -------------------------------------------------------------------------- */

const TRUTHY = new Set(['yes', 'y', 'true', 't', '1', 'required', 'rx', 'active', 'sch h', 'h']);
const FALSY = new Set(['no', 'n', 'false', 'f', '0', 'not required', 'otc', 'inactive', '']);

export function coerceBoolean(raw: unknown): CoerceResult<boolean> {
  if (isBlank(raw)) return blank<boolean>();
  if (typeof raw === 'boolean') return ok(raw);

  const text = cleanText(raw).toLowerCase();
  if (TRUTHY.has(text)) return ok(true);
  if (FALSY.has(text)) return ok(false);
  return fail(`"${cleanText(raw)}" is not a yes/no value`);
}

/**
 * Matches a cell against an allowed value list, tolerating case, spaces and
 * hyphens ("Super Stockist" -> SUPER_STOCKIST).
 */
export function coerceEnum(raw: unknown, values: string[]): CoerceResult<string> {
  if (isBlank(raw)) return blank<string>();

  const normalise = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '');
  const text = normalise(cleanText(raw));
  const match = values.find((v) => normalise(v) === text);
  if (match) return ok(match);

  return fail(`"${cleanText(raw)}" must be one of: ${values.join(', ')}`);
}

/* -------------------------------------------------------------------------- */
/* Domain-specific readers                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Reads a free-goods scheme written the way distributors write it:
 * "10+1", "10 + 1", "10+1 free", "Buy 10 Get 1".
 */
export function parseScheme(raw: unknown): { buy: number; free: number } | null {
  if (isBlank(raw)) return null;
  const text = cleanText(raw).toLowerCase();

  const plus = /(\d+)\s*\+\s*(\d+)/.exec(text);
  if (plus) return { buy: Number(plus[1]), free: Number(plus[2]) };

  const buyGet = /buy\s*(\d+)\s*(?:get|free)\s*(\d+)/.exec(text);
  if (buyGet) return { buy: Number(buyGet[1]), free: Number(buyGet[2]) };

  const onOne = /(\d+)\s*(?:on|per)\s*(\d+)/.exec(text);
  if (onOne) return { free: Number(onOne[1]), buy: Number(onOne[2]) };

  return null;
}

/**
 * Builds a product code from a product name when the file has no code column.
 * Deterministic, so re-importing the same file matches the same product rather
 * than creating a second one.
 */
export function derivedProductCode(productName: string, salt = ''): string {
  const slug = productName
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, 10);

  // Cheap stable hash of the full name, so two products sharing the first ten
  // alphanumeric characters do not collide.
  let hash = 0;
  const source = `${productName}${salt}`;
  for (let i = 0; i < source.length; i += 1) {
    hash = (hash * 31 + source.charCodeAt(i)) >>> 0;
  }
  return `IMP-${slug || 'ITEM'}-${hash.toString(36).toUpperCase().slice(0, 5)}`;
}
