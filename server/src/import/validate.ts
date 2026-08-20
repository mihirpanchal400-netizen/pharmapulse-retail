import { importDef } from './fields';
import {
  cleanText,
  coerceBoolean,
  coerceDate,
  coerceEnum,
  coerceInteger,
  coerceNumber,
  isBlank,
} from './coerce';
import type { SheetData, CellValue } from './workbook';
import type {
  ColumnMapping,
  ImportType,
  RowIssue,
  TargetField,
  ValidatedRow,
  ValidationResult,
} from './types';

/**
 * Import Center - validation.
 *
 * Runs before anything is written, and is the reason the importer can be
 * trusted with a 4,000-row file. Its contract:
 *
 *   - every problem is attributed to a row number the user can find in Excel
 *   - a bad row is rejected, never silently repaired
 *   - a suspicious but usable value is a WARNING and still imports
 *   - the whole file is checked, so the user sees all 17 problems at once
 *     rather than fixing one and re-uploading seventeen times
 */

/** Fields whose blank value means "the end of the month", not "the 1st". */
const MONTH_END_FIELDS = new Set(['expiry_date']);

/** How far ahead an expiry can plausibly sit. Beyond this it is a typo. */
const MAX_EXPIRY_YEARS = 15;

function issue(
  rowNumber: number,
  severity: 'ERROR' | 'WARNING',
  message: string,
  field?: string,
  columnName?: string,
  value?: string,
): RowIssue {
  return { rowNumber, severity, message, field, columnName, value };
}

/**
 * Coerces one cell according to its target field's type and range.
 * Returns the value plus any findings; a finding does not stop other cells
 * being read, so one row yields its full problem list in a single pass.
 */
function readCell(
  field: TargetField,
  raw: CellValue,
  rowNumber: number,
  columnName: string,
): { value: string | number | boolean | null; issues: RowIssue[] } {
  const issues: RowIssue[] = [];
  const text = raw instanceof Date ? raw.toISOString().slice(0, 10) : cleanText(raw);

  if (isBlank(raw)) {
    if (field.required) {
      issues.push(
        issue(rowNumber, 'ERROR', `${field.label} is required but blank`, field.key, columnName, ''),
      );
    }
    return { value: null, issues };
  }

  switch (field.type) {
    case 'number':
    case 'integer': {
      const result = field.type === 'integer' ? coerceInteger(raw) : coerceNumber(raw);
      if (!result.ok) {
        issues.push(issue(rowNumber, 'ERROR', `${field.label} ${result.message}`, field.key, columnName, text));
        return { value: null, issues };
      }
      const value = result.value;
      if (value !== null && field.min !== undefined && value < field.min) {
        issues.push(
          issue(rowNumber, 'ERROR', `${field.label} cannot be below ${field.min} (found ${value})`, field.key, columnName, text),
        );
        return { value: null, issues };
      }
      if (value !== null && field.max !== undefined && value > field.max) {
        issues.push(
          issue(rowNumber, 'ERROR', `${field.label} cannot be above ${field.max} (found ${value})`, field.key, columnName, text),
        );
        return { value: null, issues };
      }
      return { value, issues };
    }

    case 'date': {
      const result = coerceDate(raw, MONTH_END_FIELDS.has(field.key));
      if (!result.ok) {
        issues.push(issue(rowNumber, 'ERROR', `${field.label}: ${result.message}`, field.key, columnName, text));
        return { value: null, issues };
      }
      return { value: result.value, issues };
    }

    case 'boolean': {
      const result = coerceBoolean(raw);
      if (!result.ok) {
        issues.push(issue(rowNumber, 'ERROR', `${field.label}: ${result.message}`, field.key, columnName, text));
        return { value: null, issues };
      }
      return { value: result.value, issues };
    }

    case 'enum': {
      const result = coerceEnum(raw, field.values ?? []);
      if (!result.ok) {
        issues.push(issue(rowNumber, 'ERROR', `${field.label}: ${result.message}`, field.key, columnName, text));
        return { value: null, issues };
      }
      return { value: result.value, issues };
    }

    default:
      return { value: text, issues };
  }
}

/**
 * Cross-field checks - the ones that catch the mistakes that actually cost a
 * pharmacy money, and that no per-cell type check can see.
 */
function checkRowConsistency(
  type: ImportType,
  values: Record<string, string | number | boolean | null>,
  rowNumber: number,
): RowIssue[] {
  const issues: RowIssue[] = [];
  const num = (key: string) => (typeof values[key] === 'number' ? (values[key] as number) : null);

  const expiry = typeof values.expiry_date === 'string' ? values.expiry_date : null;
  const mfg = typeof values.manufacturing_date === 'string' ? values.manufacturing_date : null;

  if (expiry && mfg && mfg >= expiry) {
    issues.push(issue(rowNumber, 'ERROR', `Expiry date (${expiry}) must be after the manufacturing date (${mfg})`, 'expiry_date'));
  }

  if (expiry) {
    const today = new Date().toISOString().slice(0, 10);
    const limit = new Date();
    limit.setUTCFullYear(limit.getUTCFullYear() + MAX_EXPIRY_YEARS);

    if (expiry > limit.toISOString().slice(0, 10)) {
      issues.push(issue(rowNumber, 'ERROR', `Expiry date ${expiry} is more than ${MAX_EXPIRY_YEARS} years away - check the year`, 'expiry_date'));
    } else if (expiry < today) {
      // Genuinely expired stock is a warning: a stock statement legitimately
      // contains it, and blocking the import would strand the pharmacy.
      issues.push(issue(rowNumber, 'WARNING', `This batch expired on ${expiry} - it will be imported but cannot be sold`, 'expiry_date'));
    }
  }

  const mrp = num('mrp');
  const ptr = num('ptr');
  const selling = num('selling_price');
  const pts = num('pts');

  if (mrp !== null && ptr !== null && ptr > mrp && mrp > 0) {
    issues.push(issue(rowNumber, 'WARNING', `Purchase price ${ptr} is above MRP ${mrp} - this sells at a loss`, 'ptr'));
  }
  if (mrp !== null && selling !== null && selling > mrp && mrp > 0) {
    issues.push(issue(rowNumber, 'ERROR', `Selling price ${selling} is above MRP ${mrp}, which is not permitted`, 'selling_price'));
  }
  if (pts !== null && ptr !== null && pts > ptr && ptr > 0) {
    issues.push(issue(rowNumber, 'WARNING', `PTS ${pts} is above PTR ${ptr} - these two may be swapped`, 'pts'));
  }

  const taxRate = num('tax_rate');
  if (taxRate !== null && ![0, 5, 12, 18, 28].includes(taxRate)) {
    issues.push(issue(rowNumber, 'WARNING', `GST of ${taxRate}% is not a standard Indian slab (0/5/12/18/28)`, 'tax_rate'));
  }

  const quantity = num('quantity');
  if (quantity !== null && quantity === 0 && (type === 'OPENING_STOCK' || type === 'BATCH_MASTER')) {
    issues.push(issue(rowNumber, 'WARNING', 'Quantity is zero - the batch will be created empty', 'quantity'));
  }

  // A product master row identified only by its code is a legitimate update to
  // an existing product, but as a NEW product it would have no name to sell
  // under. Worth flagging without blocking the file.
  if (type === 'PRODUCT_MASTER') {
    const name = typeof values.product_name === 'string' ? values.product_name.trim() : '';
    const code = typeof values.product_code === 'string' ? values.product_code.trim() : '';
    if (name === '' && code !== '') {
      issues.push(issue(rowNumber, 'WARNING', `No product name - this row will be filed under code ${code}`, 'product_name'));
    }
  }

  const buy = num('scheme_buy_qty');
  const free = num('scheme_free_qty');
  if (free !== null && free > 0 && (buy === null || buy === 0)) {
    issues.push(issue(rowNumber, 'ERROR', 'A free quantity was given without a buy quantity - a scheme needs both, e.g. 10+1', 'scheme_buy_qty'));
  }

  return issues;
}

/** The identity of a row, used to spot the same record twice in one file. */
function identityKey(def: ReturnType<typeof importDef>, values: Record<string, unknown>): string | null {
  const parts = def.identity
    .map((key) => {
      const value = values[key];
      return value === null || value === undefined ? '' : String(value).trim().toLowerCase();
    })
    .filter((part) => part !== '');

  return parts.length === 0 ? null : parts.join('|');
}

export interface ValidateArgs {
  sheet: SheetData;
  type: ImportType;
  mapping: ColumnMapping;
  /** Cap on rows validated. Used by the preview; the commit validates everything. */
  limit?: number;
}

export function validateSheet({ sheet, type, mapping, limit }: ValidateArgs): ValidationResult {
  const def = importDef(type);

  // Column name -> position, so each row is read by index rather than searched.
  const columnIndex = new Map<string, number>();
  sheet.headers.forEach((header, index) => columnIndex.set(header, index));

  const mappedFields = def.fields.filter((f) => mapping[f.key]).map((f) => f.key);
  const mappedSet = new Set(mappedFields);

  /* --- mapping-level problems, reported once rather than per row ---------- */
  const missingRequired: string[] = [];
  for (const field of def.fields) {
    if (field.required && !mappedSet.has(field.key)) missingRequired.push(field.label);
  }
  for (const group of def.requireAnyOf ?? []) {
    if (!group.keys.some((key) => mappedSet.has(key))) missingRequired.push(group.label);
  }

  const rows: ValidatedRow[] = [];
  const issues: RowIssue[] = [];
  const seenIdentities = new Map<string, number>();

  const rowLimit = limit ? Math.min(limit, sheet.rows.length) : sheet.rows.length;

  for (let i = 0; i < rowLimit; i += 1) {
    const rowNumber = sheet.rowNumbers[i];
    const source = sheet.rows[i];

    const values: Record<string, string | number | boolean | null> = {};
    const raw: Record<string, string> = {};
    const rowIssues: RowIssue[] = [];

    for (const field of def.fields) {
      const column = mapping[field.key];
      if (!column) {
        if (field.required) {
          // Reported once via missingRequired; not repeated per row.
          values[field.key] = null;
        }
        continue;
      }

      const index = columnIndex.get(column);
      if (index === undefined) continue;

      const cell = source[index] ?? null;
      raw[field.key] = cell instanceof Date ? cell.toISOString().slice(0, 10) : cleanText(cell);

      const read = readCell(field, cell, rowNumber, column);
      values[field.key] = read.value;
      rowIssues.push(...read.issues);
    }

    /* --- "one of these is required" groups, checked per row --------------- */
    for (const group of def.requireAnyOf ?? []) {
      const hasValue = group.keys.some((key) => {
        const value = values[key];
        return value !== null && value !== undefined && String(value).trim() !== '';
      });
      if (!hasValue && group.keys.some((key) => mappedSet.has(key))) {
        rowIssues.push(issue(rowNumber, 'ERROR', `${group.label} - none of these has a value`, group.keys[0]));
      }
    }

    rowIssues.push(...checkRowConsistency(type, values, rowNumber));

    /* --- duplicates within the file --------------------------------------- */
    let duplicate = false;
    const key = identityKey(def, values);
    if (key) {
      const firstSeen = seenIdentities.get(key);
      if (firstSeen !== undefined) {
        duplicate = true;
        rowIssues.push(
          issue(rowNumber, 'WARNING', `Same record as row ${firstSeen} in this file - only the last one is kept`, def.identity[0]),
        );
      } else {
        seenIdentities.set(key, rowNumber);
      }
    }

    const hasError = rowIssues.some((it) => it.severity === 'ERROR');
    rows.push({ rowNumber, values, raw, issues: rowIssues, valid: !hasError, duplicate });
    issues.push(...rowIssues);
  }

  return {
    rows,
    totalRows: rows.length,
    validRows: rows.filter((r) => r.valid).length,
    invalidRows: rows.filter((r) => !r.valid).length,
    duplicateRows: rows.filter((r) => r.duplicate).length,
    issues,
    mappedFields,
    missingRequired,
  };
}
