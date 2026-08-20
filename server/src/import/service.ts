import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { getDb, type Db } from '../database/connection';
import { badRequest, notFound } from '../utils/errors';
import { logActivity } from '../services/activityService';
import { paginate, type Paged } from '../services/inventoryService';
import { importDef } from './fields';
import { headerSignature, suggestMapping } from './detect';
import { analyseWorkbook, fileTypeOf, readWorkbook, type ParsedWorkbook, type SheetData } from './workbook';
import { validateSheet } from './validate';
import { runImport } from './importers';
import type {
  ColumnMapping,
  ImportOptions,
  ImportType,
  RowIssue,
  ValidationResult,
  WorkbookAnalysis,
} from './types';

/**
 * Import Center - job lifecycle.
 *
 *   upload  -> the file is stored, every sheet analysed, a type and mapping
 *              suggested for each
 *   preview -> the chosen sheet is validated under the chosen mapping and the
 *              first rows plus every finding are returned. Nothing is written.
 *   commit  -> the whole sheet is re-validated and imported in one transaction
 *
 * Preview and commit deliberately share `validateSheet`, so what the user
 * approved is exactly what is checked again at commit time.
 */

/** Where uploaded files live until the job is committed or cancelled. */
export const UPLOAD_DIR = path.resolve(config.repoRoot, 'database', 'uploads');

/** Upload ceiling. A 25 MB xlsx is roughly a quarter-million product rows. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Rows returned in the preview table. */
const PREVIEW_ROWS = 20;

/** Findings stored per job. Enough for a full report without unbounded growth. */
const MAX_STORED_ISSUES = 5000;

export interface ImportJobRow {
  id: number;
  file_name: string;
  file_size: number;
  stored_path: string | null;
  file_type: string;
  import_type: ImportType | null;
  sheet_name: string | null;
  status: string;
  total_rows: number;
  valid_rows: number;
  invalid_rows: number;
  duplicate_rows: number;
  imported_rows: number;
  rejected_rows: number;
  created_count: number;
  updated_count: number;
  skipped_count: number;
  mapping_json: string | null;
  options_json: string | null;
  analysis_json: string | null;
  user_id: number | null;
  username: string | null;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

/* -------------------------------------------------------------------------- */
/* Upload                                                                      */
/* -------------------------------------------------------------------------- */

function safeFileName(name: string): string {
  // Only the basename is kept, and only characters that cannot escape the
  // upload directory survive - the file name comes from a request header.
  return path
    .basename(name)
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 120) || 'upload.xlsx';
}

export async function createImportJob(args: {
  fileName: string;
  buffer: Buffer;
  userId?: number | null;
  username?: string | null;
}): Promise<{ job: PublicImportJob; analysis: WorkbookAnalysis; suggestions: Record<string, ColumnMapping> }> {
  if (args.buffer.length === 0) throw badRequest('That file is empty.');
  if (args.buffer.length > MAX_UPLOAD_BYTES) {
    throw badRequest(
      `That file is ${(args.buffer.length / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB - split it into smaller files.`,
    );
  }

  // Throws early with a readable message when the extension is unsupported,
  // before anything is written to disk.
  const fileType = fileTypeOf(args.fileName);

  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const stored = path.join(UPLOAD_DIR, `${Date.now()}-${safeFileName(args.fileName)}`);
  fs.writeFileSync(stored, args.buffer);

  let parsed: ParsedWorkbook;
  try {
    parsed = await readWorkbook(stored, args.fileName);
  } catch (err) {
    // A file that cannot be read is not worth keeping.
    fs.rmSync(stored, { force: true });
    throw err;
  }

  const analysis = analyseWorkbook(parsed, path.basename(args.fileName), args.buffer.length);

  // A suggested mapping per sheet, so the wizard opens already filled in.
  const suggestions: Record<string, ColumnMapping> = {};
  parsed.sheets.forEach((sheet, index) => {
    const suggestedType = analysis.sheets[index].suggestedType;
    if (!suggestedType) return;
    suggestions[sheet.name] = resolveMapping(sheet, suggestedType).mapping;
  });

  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO import_jobs (file_name, file_size, stored_path, file_type, status, analysis_json, user_id, username)
       VALUES (?, ?, ?, ?, 'UPLOADED', ?, ?, ?)`,
    )
    .run(
      path.basename(args.fileName),
      args.buffer.length,
      stored,
      fileType,
      JSON.stringify(analysis),
      args.userId ?? null,
      args.username ?? null,
    );

  const jobId = Number(result.lastInsertRowid);
  logActivity({
    userId: args.userId ?? null,
    username: args.username ?? null,
    action: 'Uploaded import file',
    module: 'SETTINGS',
    recordType: 'IMPORT_JOB',
    recordId: jobId,
    summary: `${path.basename(args.fileName)} - ${analysis.sheets.length} sheet(s)`,
  });

  return { job: publicJob(getJob(jobId)), analysis, suggestions };
}

/**
 * A saved mapping for these headers, if one exists, otherwise the detector's
 * suggestion. Remembering beats re-detecting: the user's correction from last
 * month is better evidence than this month's fuzzy match.
 */
function resolveMapping(sheet: SheetData, type: ImportType): { mapping: ColumnMapping; remembered: boolean } {
  const signature = headerSignature(sheet.headers);
  const saved = getDb()
    .prepare('SELECT mapping_json FROM import_mappings WHERE import_type = ? AND signature = ?')
    .get(type, signature) as { mapping_json: string } | undefined;

  if (saved) {
    try {
      const mapping = JSON.parse(saved.mapping_json) as ColumnMapping;
      // Columns that have since disappeared from the file are dropped rather
      // than left pointing at nothing.
      const headers = new Set(sheet.headers);
      for (const key of Object.keys(mapping)) {
        if (mapping[key] && !headers.has(mapping[key] as string)) mapping[key] = null;
      }
      return { mapping, remembered: true };
    } catch {
      /* fall through to detection */
    }
  }

  return { mapping: suggestMapping(sheet.headers, type).mapping, remembered: false };
}

function rememberMapping(type: ImportType, headers: string[], mapping: ColumnMapping): void {
  const signature = headerSignature(headers);
  if (signature === '') return;

  getDb()
    .prepare(
      `INSERT INTO import_mappings (import_type, signature, mapping_json)
       VALUES (?, ?, ?)
       ON CONFLICT (import_type, signature) DO UPDATE SET
         mapping_json = excluded.mapping_json,
         use_count = use_count + 1,
         updated_at = datetime('now')`,
    )
    .run(type, signature, JSON.stringify(mapping));
}

/* -------------------------------------------------------------------------- */
/* Job access                                                                  */
/* -------------------------------------------------------------------------- */

export function getJob(id: number): ImportJobRow {
  const row = getDb().prepare('SELECT * FROM import_jobs WHERE id = ?').get(id) as ImportJobRow | undefined;
  if (!row) throw notFound('Import job');
  return row;
}

/**
 * A job as the browser may see it.
 *
 * `stored_path` is an absolute path on the server's disk. It is useful
 * internally and has no business reaching a client, so every response goes
 * through here. The field is replaced with a boolean saying only whether the
 * uploaded file is still available to re-run.
 */
export type PublicImportJob = Omit<ImportJobRow, 'stored_path'> & { file_available: boolean };

/** A history row: the same job without the stored JSON blobs. */
export type ImportJobSummary = Omit<
  PublicImportJob,
  'mapping_json' | 'options_json' | 'analysis_json'
>;

export function publicJob(job: ImportJobRow): PublicImportJob {
  const { stored_path, ...rest } = job;
  return { ...rest, file_available: Boolean(stored_path) };
}

/** Reads the stored file back and returns the requested sheet. */
async function loadSheet(job: ImportJobRow, sheetName?: string | null): Promise<SheetData> {
  if (!job.stored_path || !fs.existsSync(job.stored_path)) {
    throw badRequest(
      'The uploaded file is no longer available. Files are removed once an import finishes - upload it again to re-run it.',
    );
  }

  const parsed = await readWorkbook(job.stored_path, job.file_name);
  const sheet = sheetName ? parsed.sheets.find((s) => s.name === sheetName) : parsed.sheets[0];
  if (!sheet) throw badRequest(`This workbook has no sheet named "${sheetName}".`);
  if (sheet.headers.length === 0) throw badRequest(`Sheet "${sheet.name}" has no readable header row.`);
  return sheet;
}

/**
 * The mapping the wizard should open with for a given sheet and type: saved,
 * else detected. Exposed so the user can switch import type mid-wizard and get
 * a fresh suggestion without re-uploading.
 */
export async function suggestForSheet(
  jobId: number,
  sheetName: string,
  type: ImportType,
): Promise<{ mapping: ColumnMapping; remembered: boolean; headers: string[]; fields: ReturnType<typeof importDef>['fields'] }> {
  const job = getJob(jobId);
  const sheet = await loadSheet(job, sheetName);
  const { mapping, remembered } = resolveMapping(sheet, type);
  return { mapping, remembered, headers: sheet.headers, fields: importDef(type).fields };
}

/* -------------------------------------------------------------------------- */
/* Preview                                                                     */
/* -------------------------------------------------------------------------- */

export interface PreviewResult {
  job: PublicImportJob;
  summary: {
    totalRows: number;
    validRows: number;
    invalidRows: number;
    duplicateRows: number;
    missingRequired: string[];
    warnings: number;
    errors: number;
  };
  /** Target fields with a column behind them, in definition order. */
  columns: { key: string; label: string }[];
  /** First rows, already coerced, as they would be stored. */
  rows: { rowNumber: number; valid: boolean; duplicate: boolean; values: Record<string, unknown>; issues: RowIssue[] }[];
  /** Every finding in the file, capped for transport. */
  issues: RowIssue[];
  issuesTruncated: boolean;
}

export async function previewImport(args: {
  jobId: number;
  sheetName: string;
  type: ImportType;
  mapping: ColumnMapping;
  options?: ImportOptions;
}): Promise<PreviewResult> {
  const job = getJob(args.jobId);
  const sheet = await loadSheet(job, args.sheetName);
  const def = importDef(args.type);

  const validation = validateSheet({ sheet, type: args.type, mapping: args.mapping });

  const db = getDb();
  db.prepare(
    `UPDATE import_jobs SET import_type = ?, sheet_name = ?, mapping_json = ?, options_json = ?,
       status = 'PREVIEWED', total_rows = ?, valid_rows = ?, invalid_rows = ?, duplicate_rows = ?
     WHERE id = ?`,
  ).run(
    args.type,
    args.sheetName,
    JSON.stringify(args.mapping),
    JSON.stringify(args.options ?? {}),
    validation.totalRows,
    validation.validRows,
    validation.invalidRows,
    validation.duplicateRows,
    args.jobId,
  );

  // Findings are stored now, so the error report can be downloaded from the
  // history screen even if the user never commits the import.
  storeIssues(db, args.jobId, validation.issues);

  const columns = def.fields
    .filter((field) => validation.mappedFields.includes(field.key))
    .map((field) => ({ key: field.key, label: field.label }));

  return {
    job: publicJob(getJob(args.jobId)),
    summary: {
      totalRows: validation.totalRows,
      validRows: validation.validRows,
      invalidRows: validation.invalidRows,
      duplicateRows: validation.duplicateRows,
      missingRequired: validation.missingRequired,
      warnings: validation.issues.filter((i) => i.severity === 'WARNING').length,
      errors: validation.issues.filter((i) => i.severity === 'ERROR').length,
    },
    columns,
    rows: validation.rows.slice(0, PREVIEW_ROWS).map((row) => ({
      rowNumber: row.rowNumber,
      valid: row.valid,
      duplicate: row.duplicate,
      values: row.values,
      issues: row.issues,
    })),
    issues: validation.issues.slice(0, 500),
    issuesTruncated: validation.issues.length > 500,
  };
}

function storeIssues(db: Db, jobId: number, issues: RowIssue[]): void {
  db.prepare('DELETE FROM import_errors WHERE job_id = ?').run(jobId);

  const insert = db.prepare(
    `INSERT INTO import_errors (job_id, row_number, column_name, field, value, severity, message)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const write = db.transaction((list: RowIssue[]) => {
    for (const item of list) {
      insert.run(jobId, item.rowNumber, item.columnName ?? null, item.field ?? null, item.value ?? null, item.severity, item.message);
    }
  });
  write(issues.slice(0, MAX_STORED_ISSUES));
}

/* -------------------------------------------------------------------------- */
/* Commit                                                                      */
/* -------------------------------------------------------------------------- */

export interface CommitResult {
  job: PublicImportJob;
  outcome: {
    created: number;
    updated: number;
    skipped: number;
    imported: number;
    rejected: number;
    notes: string[];
  };
}

export async function commitImport(args: {
  jobId: number;
  sheetName?: string;
  type?: ImportType;
  mapping?: ColumnMapping;
  options?: ImportOptions;
  userId?: number | null;
  username?: string | null;
}): Promise<CommitResult> {
  const job = getJob(args.jobId);

  if (job.status === 'COMPLETED') {
    throw badRequest('This import has already been run. Upload the file again to import it a second time.');
  }

  // The wizard normally posts everything back; falling back to what the preview
  // stored means a resumed job still commits with the mapping the user approved.
  const type = args.type ?? job.import_type;
  const sheetName = args.sheetName ?? job.sheet_name;
  const mapping: ColumnMapping | null =
    args.mapping ?? (job.mapping_json ? (JSON.parse(job.mapping_json) as ColumnMapping) : null);

  if (!type || !mapping) throw badRequest('Choose an import type and map the columns before importing.');

  const sheet = await loadSheet(job, sheetName);
  const validation: ValidationResult = validateSheet({ sheet, type, mapping });

  if (validation.missingRequired.length > 0) {
    throw badRequest(
      `These required fields are not mapped: ${validation.missingRequired.join(', ')}. Map them and preview again.`,
    );
  }
  if (validation.validRows === 0) {
    throw badRequest('No row in this sheet passed validation, so there is nothing to import.');
  }

  const db = getDb();
  db.prepare("UPDATE import_jobs SET started_at = datetime('now') WHERE id = ?").run(args.jobId);

  let outcome;
  try {
    // One transaction for the whole file: an import lands completely or not at
    // all, so there is never a half-imported stock file to unpick.
    outcome = db.transaction(() =>
      runImport({
        db,
        jobId: args.jobId,
        type,
        rows: validation.rows,
        options: args.options,
        userId: args.userId ?? null,
      }),
    )();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.prepare(
      "UPDATE import_jobs SET status = 'FAILED', error_message = ?, finished_at = datetime('now') WHERE id = ?",
    ).run(message, args.jobId);
    throw err;
  }

  const imported = outcome.created + outcome.updated;
  const rejected = validation.invalidRows + outcome.skipped;

  storeIssues(db, args.jobId, [...validation.issues, ...outcome.issues]);

  db.prepare(
    `UPDATE import_jobs SET status = 'COMPLETED', import_type = ?, sheet_name = ?, mapping_json = ?,
       options_json = ?, total_rows = ?, valid_rows = ?, invalid_rows = ?, duplicate_rows = ?,
       imported_rows = ?, rejected_rows = ?, created_count = ?, updated_count = ?, skipped_count = ?,
       finished_at = datetime('now')
     WHERE id = ?`,
  ).run(
    type, sheetName, JSON.stringify(mapping), JSON.stringify(args.options ?? {}),
    validation.totalRows, validation.validRows, validation.invalidRows, validation.duplicateRows,
    imported, rejected, outcome.created, outcome.updated, outcome.skipped, args.jobId,
  );

  // The mapping proved itself on a real import, so it is worth remembering for
  // the next upload of the same file.
  rememberMapping(type, sheet.headers, mapping);

  // The raw spreadsheet has served its purpose; the job row and the error list
  // are the durable record.
  if (job.stored_path) {
    fs.rmSync(job.stored_path, { force: true });
    db.prepare('UPDATE import_jobs SET stored_path = NULL WHERE id = ?').run(args.jobId);
  }

  logActivity({
    userId: args.userId ?? null,
    username: args.username ?? null,
    action: 'Imported data from file',
    module: 'SETTINGS',
    recordType: 'IMPORT_JOB',
    recordId: args.jobId,
    summary: `${job.file_name} (${importDef(type).label}): ${outcome.created} created, ${outcome.updated} updated, ${rejected} rejected`,
  });

  return {
    job: publicJob(getJob(args.jobId)),
    outcome: {
      created: outcome.created,
      updated: outcome.updated,
      skipped: outcome.skipped,
      imported,
      rejected,
      notes: outcome.notes,
    },
  };
}

export function cancelImport(jobId: number): PublicImportJob {
  const job = getJob(jobId);
  if (job.status === 'COMPLETED') throw badRequest('A completed import cannot be cancelled.');

  if (job.stored_path) fs.rmSync(job.stored_path, { force: true });
  getDb()
    .prepare("UPDATE import_jobs SET status = 'CANCELLED', stored_path = NULL, finished_at = datetime('now') WHERE id = ?")
    .run(jobId);
  return publicJob(getJob(jobId));
}

/* -------------------------------------------------------------------------- */
/* History and error report                                                    */
/* -------------------------------------------------------------------------- */

export function listImportJobs(query: {
  status?: string;
  type?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}): Paged<ImportJobSummary> {
  const where: string[] = [];
  const params: Record<string, unknown> = {};

  if (query.status && query.status !== 'ALL') {
    where.push('status = @status');
    params.status = query.status;
  }
  if (query.type && query.type !== 'ALL') {
    where.push('import_type = @type');
    params.type = query.type;
  }
  if (query.search) {
    where.push('(file_name LIKE @like OR username LIKE @like)');
    params.like = `%${query.search.trim()}%`;
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // The workbook analysis and the mapping are stored as JSON blobs and can run
  // to tens of kilobytes each. A history listing has no use for them, so they
  // are left out here and fetched only when one job is opened.
  const rows = getDb()
    .prepare(
      `SELECT id, file_name, file_size, file_type, import_type, sheet_name, status,
              total_rows, valid_rows, invalid_rows, duplicate_rows, imported_rows, rejected_rows,
              created_count, updated_count, skipped_count, user_id, username, error_message,
              started_at, finished_at, created_at,
              CASE WHEN stored_path IS NULL THEN 0 ELSE 1 END AS file_available
       FROM import_jobs ${clause}
       ORDER BY created_at DESC, id DESC
       LIMIT 1000`,
    )
    .all(params) as (Omit<ImportJobRow, 'stored_path' | 'mapping_json' | 'options_json' | 'analysis_json'> & {
      file_available: number;
    })[];

  return paginate(
    rows.map((row) => ({ ...row, file_available: Boolean(row.file_available) })),
    query.page,
    query.pageSize,
  );
}

export interface ImportErrorRow {
  id: number;
  job_id: number;
  row_number: number;
  column_name: string | null;
  field: string | null;
  value: string | null;
  severity: string;
  message: string;
}

export function listImportErrors(jobId: number, severity?: string): ImportErrorRow[] {
  getJob(jobId);

  const clause = severity && severity !== 'ALL' ? 'AND severity = ?' : '';
  const params: unknown[] = severity && severity !== 'ALL' ? [jobId, severity] : [jobId];

  return getDb()
    .prepare(`SELECT * FROM import_errors WHERE job_id = ? ${clause} ORDER BY row_number, id LIMIT 5000`)
    .all(...params) as ImportErrorRow[];
}

/** Summary counters for the Import Center landing screen. */
export function importStats(): {
  totalJobs: number;
  completedJobs: number;
  failedJobs: number;
  rowsImported: number;
  lastImportAt: string | null;
} {
  const row = getDb()
    .prepare(
      `SELECT
         COUNT(*) AS totalJobs,
         SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) AS completedJobs,
         SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failedJobs,
         COALESCE(SUM(imported_rows), 0) AS rowsImported,
         MAX(CASE WHEN status = 'COMPLETED' THEN finished_at END) AS lastImportAt
       FROM import_jobs`,
    )
    .get() as Record<string, number | string | null>;

  return {
    totalJobs: Number(row.totalJobs ?? 0),
    completedJobs: Number(row.completedJobs ?? 0),
    failedJobs: Number(row.failedJobs ?? 0),
    rowsImported: Number(row.rowsImported ?? 0),
    lastImportAt: (row.lastImportAt as string | null) ?? null,
  };
}

/**
 * Removes upload files left behind by abandoned wizards.
 * Called on server start; a file older than a day belongs to a job nobody
 * finished.
 */
export function pruneStaleUploads(maxAgeHours = 24): number {
  if (!fs.existsSync(UPLOAD_DIR)) return 0;

  const cutoff = Date.now() - maxAgeHours * 3600_000;
  let removed = 0;

  for (const entry of fs.readdirSync(UPLOAD_DIR)) {
    const full = path.join(UPLOAD_DIR, entry);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) {
        fs.rmSync(full, { force: true });
        removed += 1;
      }
    } catch {
      /* a file that cannot be read is left alone */
    }
  }

  if (removed > 0) {
    getDb()
      .prepare(
        `UPDATE import_jobs SET stored_path = NULL, status = 'CANCELLED'
         WHERE stored_path IS NOT NULL AND status NOT IN ('COMPLETED','FAILED')
           AND created_at < datetime('now', ?)`,
      )
      .run(`-${maxAgeHours} hours`);
  }
  return removed;
}
