import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import { badRequest } from '../utils/errors';
import { cleanText, coerceDate, coerceNumber, isBlank } from './coerce';
import type { SheetAnalysis, SheetColumn, WorkbookAnalysis } from './types';
import { detectImportType } from './detect';

/**
 * Import Center - reading the uploaded file.
 *
 * Supports .xlsx / .xlsm through ExcelJS and .csv through a small reader below.
 * A workbook is read once and every sheet is analysed, because a pharmacy's
 * "master file" routinely holds Products, Suppliers and Stock as three tabs of
 * one workbook and the user should not have to split it by hand.
 *
 * Two habits of real spreadsheets are handled here rather than left to the user:
 *   - a title row or a blank row above the headers (the header row is found by
 *     scoring the first few rows, not assumed to be row 1)
 *   - trailing empty rows and columns Excel leaves behind
 */

/** Sampling limit for type detection and previews. Keeps a 50k-row file quick. */
const SAMPLE_ROWS = 200;
/** Rows scanned when looking for the header row. */
const HEADER_SEARCH_DEPTH = 10;

export type CellValue = string | number | boolean | Date | null;

export interface SheetData {
  name: string;
  headerRow: number;
  headers: string[];
  /** Data rows, aligned to `headers` by position. */
  rows: CellValue[][];
  /** Spreadsheet row number of each entry in `rows`, for error reporting. */
  rowNumbers: number[];
}

export interface ParsedWorkbook {
  fileType: 'XLSX' | 'XLS' | 'CSV';
  sheets: SheetData[];
}

/* -------------------------------------------------------------------------- */
/* Cell normalisation                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Flattens whatever ExcelJS hands back into a primitive.
 *
 * Formula cells carry a cached `result`, hyperlinks carry `text`, and rich text
 * arrives as an array of runs. Reading `.value` alone would put "[object
 * Object]" into the database for all three.
 */
function normaliseCell(value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  const obj = value as Record<string, unknown>;
  if (Array.isArray(obj.richText)) {
    return (obj.richText as { text?: string }[]).map((run) => run.text ?? '').join('');
  }
  if ('result' in obj) return normaliseCell(obj.result);
  if ('text' in obj) return normaliseCell(obj.text);
  if ('hyperlink' in obj) return normaliseCell(obj.hyperlink);
  if ('error' in obj) return null;

  return cleanText(String(value)) || null;
}

const cellIsEmpty = (value: CellValue): boolean =>
  value === null || (typeof value === 'string' && cleanText(value) === '');

/* -------------------------------------------------------------------------- */
/* Header discovery                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Scores a row on how much it looks like a header: mostly non-empty, mostly
 * short text, and no numbers. A title row ("STOCK STATEMENT AS ON 31/07/2026")
 * loses because it has one filled cell out of twenty; a data row loses because
 * it is full of numbers and dates.
 */
function headerScore(row: CellValue[]): number {
  const filled = row.filter((c) => !cellIsEmpty(c));
  if (filled.length < 2) return 0;

  const textual = filled.filter(
    (c) => typeof c === 'string' && cleanText(c).length > 0 && cleanText(c).length <= 40,
  ).length;
  const numeric = filled.filter((c) => typeof c === 'number' || c instanceof Date).length;

  const density = filled.length / Math.max(row.length, 1);
  return (textual / filled.length) * 0.6 + density * 0.4 - (numeric / filled.length) * 0.5;
}

function findHeaderRow(rows: CellValue[][]): number {
  let best = 0;
  let bestScore = -Infinity;

  for (let i = 0; i < Math.min(rows.length, HEADER_SEARCH_DEPTH); i += 1) {
    const score = headerScore(rows[i]);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return bestScore <= 0 ? 0 : best;
}

/**
 * Names the columns. Blank headers become "Column 4" so they can still be
 * mapped, and a repeated header gets a numeric suffix so the mapping stays
 * unambiguous.
 */
function buildHeaders(headerRow: CellValue[], width: number): string[] {
  const seen = new Map<string, number>();
  const headers: string[] = [];

  for (let i = 0; i < width; i += 1) {
    const raw = cleanText(headerRow[i] ?? '');
    let name = raw === '' ? `Column ${i + 1}` : raw.replace(/\s+/g, ' ');

    const count = seen.get(name.toLowerCase()) ?? 0;
    seen.set(name.toLowerCase(), count + 1);
    if (count > 0) name = `${name} (${count + 1})`;

    headers.push(name);
  }
  return headers;
}

/* -------------------------------------------------------------------------- */
/* CSV                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Minimal RFC-4180 CSV reader.
 *
 * Written here rather than pulled in as a dependency: the format is small, the
 * project already writes CSV by hand in utils/csv.ts, and a parser is easier to
 * reason about than a transitive dependency tree. Handles quoted fields,
 * embedded commas, doubled quotes and both line endings. The delimiter is
 * sniffed, because exports from Indian accounting packages are often
 * semicolon-separated.
 */
export function parseCsv(text: string): string[][] {
  const body = text.replace(/^﻿/, '');
  const firstLine = body.split(/\r?\n/)[0] ?? '';
  const delimiter = [';', '\t', '|'].find(
    (d) => firstLine.split(d).length > firstLine.split(',').length,
  ) ?? ',';

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];

    if (inQuotes) {
      if (char === '"') {
        if (body[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

export function fileTypeOf(fileName: string): 'XLSX' | 'XLS' | 'CSV' {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.csv' || ext === '.txt') return 'CSV';
  if (ext === '.xls') return 'XLS';
  if (ext === '.xlsx' || ext === '.xlsm') return 'XLSX';
  throw badRequest(
    `PharmaPulse can read .xlsx, .xlsm and .csv files. "${path.basename(fileName)}" is not one of those. Open it in Excel and use Save As -> Excel Workbook (.xlsx).`,
  );
}

function sheetFromMatrix(name: string, matrix: CellValue[][]): SheetData {
  const width = matrix.reduce((max, row) => Math.max(max, row.length), 0);
  if (matrix.length === 0 || width === 0) {
    return { name, headerRow: 1, headers: [], rows: [], rowNumbers: [] };
  }

  const headerIndex = findHeaderRow(matrix);
  const headers = buildHeaders(matrix[headerIndex] ?? [], width);

  const rows: CellValue[][] = [];
  const rowNumbers: number[] = [];
  for (let i = headerIndex + 1; i < matrix.length; i += 1) {
    const row = matrix[i];
    if (row.every(cellIsEmpty)) continue;

    const padded: CellValue[] = [];
    for (let c = 0; c < width; c += 1) padded.push(row[c] ?? null);
    rows.push(padded);
    // +1 because spreadsheet rows are 1-based, matching what the user sees.
    rowNumbers.push(i + 1);
  }

  return { name, headerRow: headerIndex + 1, headers, rows, rowNumbers };
}

/** Reads an uploaded file from disk into per-sheet tables. */
export async function readWorkbook(filePath: string, fileName: string): Promise<ParsedWorkbook> {
  const fileType = fileTypeOf(fileName);

  if (fileType === 'CSV') {
    const text = fs.readFileSync(filePath, 'utf8');
    const matrix = parseCsv(text) as CellValue[][];
    return { fileType, sheets: [sheetFromMatrix(path.parse(fileName).name, matrix)] };
  }

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(filePath);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw badRequest(
      `That file could not be opened as an Excel workbook. If it is an old .xls file, open it in Excel and re-save as .xlsx. (${detail})`,
    );
  }

  const sheets: SheetData[] = [];
  workbook.eachSheet((worksheet) => {
    const matrix: CellValue[][] = [];
    worksheet.eachRow({ includeEmpty: true }, (row) => {
      const values: CellValue[] = [];
      // ExcelJS row.values is 1-based with a leading hole at index 0.
      const raw = row.values as unknown[];
      for (let c = 1; c < raw.length; c += 1) values.push(normaliseCell(raw[c]));
      matrix.push(values);
    });
    sheets.push(sheetFromMatrix(worksheet.name, matrix));
  });

  if (sheets.length === 0) {
    throw badRequest('That workbook has no sheets in it.');
  }
  return { fileType, sheets };
}

/* -------------------------------------------------------------------------- */
/* Analysis                                                                    */
/* -------------------------------------------------------------------------- */

/** Guesses what a column holds, from its sampled values. */
function detectColumnType(values: CellValue[]): SheetColumn['detectedType'] {
  const filled = values.filter((v) => !isBlank(v));
  if (filled.length === 0) return 'empty';

  let numbers = 0;
  let dates = 0;
  for (const value of filled) {
    if (value instanceof Date) {
      dates += 1;
      continue;
    }
    if (typeof value === 'number') {
      numbers += 1;
      continue;
    }
    if (coerceNumber(value).ok && coerceNumber(value).value !== null) numbers += 1;
    else if (coerceDate(value).ok && coerceDate(value).value !== null) dates += 1;
  }

  if (dates / filled.length >= 0.7) return 'date';
  if (numbers / filled.length >= 0.7) return 'number';
  return 'text';
}

/** Counts rows that repeat an earlier row exactly. */
function countDuplicateRows(rows: CellValue[][]): number {
  const seen = new Set<string>();
  let duplicates = 0;
  for (const row of rows) {
    const key = row.map((c) => (c instanceof Date ? c.toISOString() : cleanText(c))).join('');
    if (seen.has(key)) duplicates += 1;
    else seen.add(key);
  }
  return duplicates;
}

export function analyseSheet(sheet: SheetData): SheetAnalysis {
  if (sheet.headers.length === 0) {
    return {
      name: sheet.name,
      rowCount: 0,
      headerRow: sheet.headerRow,
      columns: [],
      emptyColumns: [],
      suggestedType: null,
      confidence: 0,
      duplicateRowCount: 0,
      problem: 'This sheet is empty.',
    };
  }

  const sample = sheet.rows.slice(0, SAMPLE_ROWS);

  const columns: SheetColumn[] = sheet.headers.map((name, index) => {
    const values = sample.map((row) => row[index] ?? null);
    const filled = values.filter((v) => !isBlank(v));
    return {
      name,
      index: index + 1,
      fillRate: sample.length === 0 ? 0 : filled.length / sample.length,
      detectedType: detectColumnType(values),
      samples: filled
        .slice(0, 3)
        .map((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : cleanText(v))),
    };
  });

  const detection = detectImportType(sheet.name, sheet.headers);

  return {
    name: sheet.name,
    rowCount: sheet.rows.length,
    headerRow: sheet.headerRow,
    columns,
    emptyColumns: columns.filter((c) => c.detectedType === 'empty').map((c) => c.name),
    suggestedType: detection.type,
    confidence: detection.confidence,
    duplicateRowCount: countDuplicateRows(sample),
    problem: sheet.rows.length === 0 ? 'This sheet has headers but no data rows.' : undefined,
  };
}

export function analyseWorkbook(
  parsed: ParsedWorkbook,
  fileName: string,
  fileSize: number,
): WorkbookAnalysis {
  return {
    fileName,
    fileType: parsed.fileType,
    fileSize,
    sheets: parsed.sheets.map(analyseSheet),
  };
}
