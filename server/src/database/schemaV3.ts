/**
 * Schema v3 - the Import Center.
 *
 * Kept separate from schema.ts / schemaV2.ts for the same reason those are
 * separate: each file is one reviewable unit of change. Everything here is
 * ADDITIVE and IDEMPOTENT, so an existing database with real trading history
 * upgrades in place with no data loss.
 *
 * Three tables, and each earns its place:
 *
 *   import_jobs     One row per uploaded file. Survives the whole wizard
 *                   (upload -> map -> preview -> commit) so a mapping is not
 *                   lost when the user closes the tab, and remains afterwards
 *                   as the Import History a pharmacy needs to answer "where did
 *                   these 4,000 products come from?".
 *
 *   import_errors   Per-row problems found during validation. Stored rather
 *                   than only returned, because the error report is downloaded
 *                   after the fact and often days later.
 *
 *   import_mappings Remembered column mappings, keyed by a signature of the
 *                   sheet headers. A pharmacy re-uploads the same distributor's
 *                   price list every month; it should only map it once.
 */

export const SCHEMA_V3_SQL = `
-- ------------------------------------------------------------- import jobs
CREATE TABLE IF NOT EXISTS import_jobs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  file_name        TEXT NOT NULL,
  file_size        INTEGER NOT NULL DEFAULT 0,
  -- Path of the uploaded file inside database/uploads. Cleared once the job is
  -- committed or cancelled, so raw spreadsheets are not kept indefinitely.
  stored_path      TEXT,
  file_type        TEXT NOT NULL DEFAULT 'XLSX' CHECK (file_type IN ('XLSX','XLS','CSV')),
  -- Which predefined import this file is being treated as. NULL until the user
  -- (or the detector) picks one.
  import_type      TEXT,
  sheet_name       TEXT,
  status           TEXT NOT NULL DEFAULT 'UPLOADED'
                     CHECK (status IN ('UPLOADED','MAPPED','PREVIEWED','COMPLETED','FAILED','CANCELLED')),
  -- Row counts. total_rows counts data rows, excluding the header row.
  total_rows       INTEGER NOT NULL DEFAULT 0,
  valid_rows       INTEGER NOT NULL DEFAULT 0,
  invalid_rows     INTEGER NOT NULL DEFAULT 0,
  duplicate_rows   INTEGER NOT NULL DEFAULT 0,
  imported_rows    INTEGER NOT NULL DEFAULT 0,
  rejected_rows    INTEGER NOT NULL DEFAULT 0,
  created_count    INTEGER NOT NULL DEFAULT 0,
  updated_count    INTEGER NOT NULL DEFAULT 0,
  skipped_count    INTEGER NOT NULL DEFAULT 0,
  -- JSON: { targetField: excelColumnName | null }
  mapping_json     TEXT,
  -- JSON: importer options, e.g. { updateExisting: true }
  options_json     TEXT,
  -- JSON: the workbook analysis (sheets, headers, row counts) so the wizard can
  -- be resumed without re-reading the file.
  analysis_json    TEXT,
  user_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username         TEXT,
  error_message    TEXT,
  started_at       TEXT,
  finished_at      TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_import_jobs_created ON import_jobs(created_at);
CREATE INDEX IF NOT EXISTS idx_import_jobs_status  ON import_jobs(status);

-- ----------------------------------------------------------- import errors
CREATE TABLE IF NOT EXISTS import_errors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      INTEGER NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  -- 1-based row number as the user sees it in Excel, header row included, so
  -- "row 24" in the report is row 24 in their spreadsheet.
  row_number  INTEGER NOT NULL,
  column_name TEXT,
  field       TEXT,
  value       TEXT,
  severity    TEXT NOT NULL DEFAULT 'ERROR' CHECK (severity IN ('ERROR','WARNING')),
  message     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_import_errors_job ON import_errors(job_id);

-- --------------------------------------------------------- saved mappings
CREATE TABLE IF NOT EXISTS import_mappings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  import_type  TEXT NOT NULL,
  -- Lower-cased, sorted, comma-joined header list. Two files with the same
  -- columns in a different order share one mapping.
  signature    TEXT NOT NULL,
  name         TEXT,
  mapping_json TEXT NOT NULL,
  use_count    INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (import_type, signature)
);
`;

/**
 * Columns added to existing tables by v3.
 *
 * `source_import_job_id` lets any imported record be traced back to the file it
 * came from - the question "which upload created this product?" is the first
 * one asked when an import goes wrong, and answering it from an activity-log
 * string search is not good enough.
 */
export const V3_COLUMNS: {
  table: string;
  column: string;
  definition: string;
  backfill?: string;
}[] = [
  { table: 'products', column: 'source_import_job_id', definition: 'INTEGER REFERENCES import_jobs(id) ON DELETE SET NULL' },
  { table: 'suppliers', column: 'source_import_job_id', definition: 'INTEGER REFERENCES import_jobs(id) ON DELETE SET NULL' },
  { table: 'distributors', column: 'source_import_job_id', definition: 'INTEGER REFERENCES import_jobs(id) ON DELETE SET NULL' },
  { table: 'product_batches', column: 'source_import_job_id', definition: 'INTEGER REFERENCES import_jobs(id) ON DELETE SET NULL' },
  { table: 'manufacturers', column: 'source_import_job_id', definition: 'INTEGER REFERENCES import_jobs(id) ON DELETE SET NULL' },
];
