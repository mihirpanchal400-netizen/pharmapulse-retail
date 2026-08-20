/**
 * Import Center - shared vocabulary.
 *
 * The whole importer is built around one idea: a spreadsheet column is matched
 * to a *target field*, and everything downstream (validation, preview, commit)
 * works on target fields rather than on whatever the pharmacy happened to call
 * the column. That keeps a single validation and import path regardless of
 * whether the header said "Medicine Name", "Item" or "PRODUCT".
 */

/** The predefined imports the software understands. */
export type ImportType =
  | 'PRODUCT_MASTER'
  | 'MANUFACTURER_MASTER'
  | 'SUPPLIER_MASTER'
  | 'DISTRIBUTOR_MASTER'
  | 'OPENING_STOCK'
  | 'BATCH_MASTER'
  | 'PRICE_LIST'
  | 'PURCHASE_HISTORY'
  | 'SALES_HISTORY';

export const IMPORT_TYPES: ImportType[] = [
  'PRODUCT_MASTER',
  'MANUFACTURER_MASTER',
  'SUPPLIER_MASTER',
  'DISTRIBUTOR_MASTER',
  'OPENING_STOCK',
  'BATCH_MASTER',
  'PRICE_LIST',
  'PURCHASE_HISTORY',
  'SALES_HISTORY',
];

/** How a cell's raw text is turned into a stored value. */
export type FieldType = 'string' | 'number' | 'integer' | 'date' | 'boolean' | 'enum';

export interface TargetField {
  /** Stable key used in the mapping JSON and by the importers. */
  key: string;
  /** Shown in the mapping UI. */
  label: string;
  type: FieldType;
  /**
   * A row without this field is rejected. Where a record can be identified in
   * more than one way (product code OR product name), neither is marked
   * required individually - the import type declares a `requireAnyOf` group.
   */
  required?: boolean;
  /**
   * Header variations seen in real Indian pharmacy exports. Matching is done on
   * a normalised form (lower case, punctuation and spaces removed), so "Exp.
   * Date", "EXP_DATE" and "expdate" all collapse to the same token.
   */
  synonyms: string[];
  /** Allowed values for `enum` fields. Matching is case-insensitive. */
  values?: string[];
  /** Numeric guard rails used by the validator. */
  min?: number;
  max?: number;
  /** Shown as the example value in the downloadable template. */
  example?: string | number;
  /** Explanatory note shown under the field in the mapping screen. */
  note?: string;
}

export interface ImportTypeDef {
  type: ImportType;
  label: string;
  description: string;
  /** Target table(s) affected, shown in the UI so the effect is never a surprise. */
  affects: string;
  fields: TargetField[];
  /**
   * At least one field from each group must be mapped, and each row must carry
   * a value for at least one of them. Used for "product code or product name".
   */
  requireAnyOf?: { label: string; keys: string[] }[];
  /**
   * Fields that together identify an existing record. A second row with the
   * same key values is reported as a duplicate rather than silently imported
   * twice.
   */
  identity: string[];
  /** Words in a sheet or file name that suggest this import type. */
  nameHints: string[];
}

/* -------------------------------------------------------------------------- */
/* Workbook analysis                                                           */
/* -------------------------------------------------------------------------- */

export interface SheetColumn {
  /** Header text exactly as it appears in the file. */
  name: string;
  /** 1-based column index. */
  index: number;
  /** Share of non-empty cells in the sampled rows, 0-1. */
  fillRate: number;
  /** Best guess at the column's content, from the sampled values. */
  detectedType: 'text' | 'number' | 'date' | 'empty';
  /** Up to three example values, for the mapping screen. */
  samples: string[];
}

export interface SheetAnalysis {
  name: string;
  /** Data rows, header excluded. */
  rowCount: number;
  /** 1-based index of the row the headers were found on. */
  headerRow: number;
  columns: SheetColumn[];
  /** Columns with no values at all. */
  emptyColumns: string[];
  /** Best-guess import type for this sheet, from headers and sheet name. */
  suggestedType: ImportType | null;
  /** 0-1 confidence in `suggestedType`. */
  confidence: number;
  /** Rows that repeat an earlier row exactly. */
  duplicateRowCount: number;
  /** Set when the sheet could not be read as a table. */
  problem?: string;
}

export interface WorkbookAnalysis {
  fileName: string;
  fileType: 'XLSX' | 'XLS' | 'CSV';
  fileSize: number;
  sheets: SheetAnalysis[];
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

/** `{ targetFieldKey: excelColumnName | null }`. */
export type ColumnMapping = Record<string, string | null>;

export interface RowIssue {
  /** Row number as the user sees it in Excel (header included). */
  rowNumber: number;
  field?: string;
  columnName?: string;
  value?: string;
  severity: 'ERROR' | 'WARNING';
  message: string;
}

export interface ValidatedRow {
  rowNumber: number;
  /** Coerced values keyed by target field. */
  values: Record<string, string | number | boolean | null>;
  /** Raw cell text keyed by target field, kept for the error report. */
  raw: Record<string, string>;
  issues: RowIssue[];
  valid: boolean;
  duplicate: boolean;
}

export interface ValidationResult {
  rows: ValidatedRow[];
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  issues: RowIssue[];
  /** Mapped target fields, for the preview table's columns. */
  mappedFields: string[];
  /** Target fields the import needs but which are not mapped. */
  missingRequired: string[];
}

/* -------------------------------------------------------------------------- */
/* Commit                                                                      */
/* -------------------------------------------------------------------------- */

export interface ImportOptions {
  /** Update a record that already exists instead of skipping it. Default true. */
  updateExisting?: boolean;
  /** Import the valid rows even when some rows failed. Default true. */
  skipInvalid?: boolean;
  /**
   * Create referenced records that do not exist yet - a manufacturer named in a
   * product row, a supplier named in a stock row. Default true, because an
   * import that fails on the first unknown manufacturer is useless in practice.
   */
  createMissingReferences?: boolean;
}

export interface ImportOutcome {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  /** Problems hit while writing, as opposed to during validation. */
  issues: RowIssue[];
  /** Human-readable summary lines, e.g. "12 manufacturers created". */
  notes: string[];
}
