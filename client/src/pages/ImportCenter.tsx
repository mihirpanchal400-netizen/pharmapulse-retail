import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  History,
  Info,
  Table2,
  Upload,
  X,
} from 'lucide-react';
import { Card, EmptyState, ErrorState, LoadingBlock, PageHeader, Pill, Spinner } from '../components/ui';
import { Select } from '../components/DataTable';
import { api, ApiError, downloadFile, uploadImportFile } from '../services/api';
import { useApi } from '../hooks/useApi';
import { number as fmtNumber } from '../utils/format';
import type {
  ImportCommitResult,
  ImportField,
  ImportPreview,
  ImportType,
  ImportTypeSummary,
  ImportUploadResult,
  SheetAnalysis,
} from '../types';

/**
 * IMPORT CENTER
 * =============
 *
 * A four-step wizard: upload, choose sheet and type, map columns, review and
 * import. The design rule throughout is that nothing is written until the user
 * has seen what will be written - the Review step is not a formality, it is
 * where an import is actually decided.
 *
 * The step bar is deliberately linear. A pharmacist importing a stock file
 * should never be wondering which of five panels to fill in first.
 */

type Step = 'upload' | 'sheet' | 'map' | 'review' | 'done';

const STEPS: { id: Step; label: string }[] = [
  { id: 'upload', label: 'Upload file' },
  { id: 'sheet', label: 'Sheet & type' },
  { id: 'map', label: 'Map columns' },
  { id: 'review', label: 'Review & import' },
];

const MAX_MB = 25;

function StepBar({ current }: { current: Step }) {
  const index = STEPS.findIndex((step) => step.id === current);
  const activeIndex = current === 'done' ? STEPS.length : index;

  return (
    <ol className="mb-6 flex flex-wrap items-center gap-1 text-sm">
      {STEPS.map((step, i) => {
        const done = i < activeIndex;
        const active = i === activeIndex;
        return (
          <li key={step.id} className="flex items-center gap-1">
            <span
              className={`flex items-center gap-2 rounded-lg px-3 py-1.5 ${
                active
                  ? 'bg-brand-600 font-medium text-white'
                  : done
                    ? 'bg-emerald-50 text-emerald-700'
                    : 'bg-slate-100 text-slate-500'
              }`}
            >
              <span
                className={`grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${
                  active ? 'bg-white/20 text-white' : done ? 'bg-emerald-600 text-white' : 'bg-white text-slate-500'
                }`}
              >
                {done ? <Check className="h-3 w-3" aria-hidden /> : i + 1}
              </span>
              {step.label}
            </span>
            {i < STEPS.length - 1 && <ArrowRight className="h-3.5 w-3.5 shrink-0 text-slate-300" aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
}

/* -------------------------------------------------------------------------- */
/* Step 1: upload                                                              */
/* -------------------------------------------------------------------------- */

function UploadStep({
  types,
  onUploaded,
}: {
  types: ImportTypeSummary[];
  onUploaded: (result: ImportUploadResult) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const send = useCallback(
    async (file: File) => {
      setError(null);

      if (file.size > MAX_MB * 1024 * 1024) {
        setError(`That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_MB} MB - split it into smaller files.`);
        return;
      }

      setBusy(true);
      setProgress(0);
      try {
        onUploaded(await uploadImportFile<ImportUploadResult>(file, setProgress));
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'That file could not be uploaded.');
      } finally {
        setBusy(false);
      }
    },
    [onUploaded],
  );

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
      <Card title="Upload a spreadsheet" subtitle="Excel (.xlsx, .xlsm) or CSV, up to 25 MB">
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const file = e.dataTransfer.files?.[0];
            if (file) void send(file);
          }}
          className={`flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-12 text-center transition-colors ${
            dragging ? 'border-brand-500 bg-brand-50' : 'border-slate-200 bg-slate-50/60'
          }`}
        >
          {busy ? (
            <>
              <Spinner className="h-7 w-7" />
              <p className="text-sm font-medium text-slate-700">Reading the workbook…</p>
              <div className="h-1.5 w-56 overflow-hidden rounded-full bg-slate-200">
                <div className="h-full bg-brand-600 transition-all" style={{ width: `${progress}%` }} />
              </div>
            </>
          ) : (
            <>
              <FileSpreadsheet className="h-9 w-9 text-slate-300" aria-hidden />
              <div>
                <p className="text-sm font-medium text-slate-700">Drop your file here</p>
                <p className="mt-1 text-sm text-slate-500">
                  Column names do not have to match ours - the next step maps them.
                </p>
              </div>
              <button type="button" className="btn-primary mt-1" onClick={() => inputRef.current?.click()}>
                <Upload className="h-4 w-4" aria-hidden />
                Choose file
              </button>
            </>
          )}

          <input
            ref={inputRef}
            type="file"
            className="hidden"
            accept=".xlsx,.xlsm,.csv,.txt"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void send(file);
              // Cleared so re-selecting the same file still fires a change.
              e.target.value = '';
            }}
          />
        </div>

        {error && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>{error}</span>
          </div>
        )}

        <div className="mt-5 flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-600">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden />
          <span>
            A workbook with several tabs is fine - every sheet is read and you choose which one to import.
            Nothing is saved until you confirm at the review step.
          </span>
        </div>
      </Card>

      <Card title="What you can import" subtitle="Download a template to start from">
        <ul className="divide-y divide-slate-100">
          {types.map((type) => (
            <li key={type.type} className="py-3 first:pt-0 last:pb-0">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-800">{type.label}</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-slate-500">{type.description}</p>
                </div>
                <button
                  type="button"
                  title={`Download the ${type.label} template`}
                  className="btn-ghost shrink-0 px-2 py-1"
                  onClick={() => {
                    void downloadFile(`/imports/types/${type.type}/template`, `${type.type}.xlsx`);
                  }}
                >
                  <Download className="h-4 w-4" aria-hidden />
                </button>
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Step 2: sheet and import type                                               */
/* -------------------------------------------------------------------------- */

function SheetStep({
  upload,
  types,
  selectedSheet,
  selectedType,
  onSelectSheet,
  onSelectType,
  onBack,
  onNext,
}: {
  upload: ImportUploadResult;
  types: ImportTypeSummary[];
  selectedSheet: string;
  selectedType: ImportType | '';
  onSelectSheet: (sheet: string) => void;
  onSelectType: (type: ImportType) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const sheet = upload.analysis.sheets.find((s) => s.name === selectedSheet);

  return (
    <div className="space-y-5">
      <Card
        title={upload.analysis.fileName}
        subtitle={`${upload.analysis.fileType} · ${(upload.analysis.fileSize / 1024).toFixed(0)} KB · ${upload.analysis.sheets.length} sheet(s) detected`}
        bodyClassName="p-0"
      >
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-slate-50/70">
                <th className="th w-10" />
                <th className="th">Sheet</th>
                <th className="th text-right">Rows</th>
                <th className="th text-right">Columns</th>
                <th className="th">Header row</th>
                <th className="th">Looks like</th>
                <th className="th text-right">Duplicates</th>
              </tr>
            </thead>
            <tbody>
              {upload.analysis.sheets.map((s) => (
                <SheetRow
                  key={s.name}
                  sheet={s}
                  selected={s.name === selectedSheet}
                  typeLabel={types.find((t) => t.type === s.suggestedType)?.label}
                  onSelect={() => onSelectSheet(s.name)}
                />
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {sheet && (
        <Card title="What is in this sheet?" subtitle="Pick the import that matches. The suggestion comes from the column names.">
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {types.map((type) => {
              const suggested = sheet.suggestedType === type.type;
              const active = selectedType === type.type;
              return (
                <button
                  key={type.type}
                  type="button"
                  onClick={() => onSelectType(type.type)}
                  className={`rounded-xl border px-3.5 py-3 text-left transition-colors ${
                    active ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-500' : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-slate-800">{type.label}</span>
                    {suggested && <Pill tone="emerald">Suggested</Pill>}
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-slate-500">{type.description}</p>
                  <p className="mt-2 text-[11px] uppercase tracking-wide text-slate-400">Writes to {type.affects}</p>
                </button>
              );
            })}
          </div>
        </Card>
      )}

      <div className="flex items-center justify-between">
        <button type="button" className="btn-secondary" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Choose another file
        </button>
        <button type="button" className="btn-primary" disabled={!selectedSheet || !selectedType} onClick={onNext}>
          Map the columns
          <ArrowRight className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}

function SheetRow({
  sheet,
  selected,
  typeLabel,
  onSelect,
}: {
  sheet: SheetAnalysis;
  selected: boolean;
  typeLabel?: string;
  onSelect: () => void;
}) {
  const unusable = sheet.rowCount === 0;

  return (
    <tr
      className={`table-row ${unusable ? 'opacity-50' : 'cursor-pointer'} ${selected ? 'bg-brand-50/60' : ''}`}
      onClick={unusable ? undefined : onSelect}
    >
      <td className="td">
        <span
          className={`grid h-4 w-4 place-items-center rounded-full border ${
            selected ? 'border-brand-600 bg-brand-600' : 'border-slate-300'
          }`}
        >
          {selected && <Check className="h-2.5 w-2.5 text-white" aria-hidden />}
        </span>
      </td>
      <td className="td font-medium text-slate-800">
        {sheet.name}
        {sheet.problem && <span className="ml-2 text-xs font-normal text-amber-600">{sheet.problem}</span>}
      </td>
      <td className="td text-right tabular-nums">{fmtNumber(sheet.rowCount)}</td>
      <td className="td text-right tabular-nums">{sheet.columns.length}</td>
      <td className="td text-slate-500">Row {sheet.headerRow}</td>
      <td className="td">
        {typeLabel ? (
          <span className="text-slate-700">
            {typeLabel}
            <span className="ml-1.5 text-xs text-slate-400">{Math.round(sheet.confidence * 100)}%</span>
          </span>
        ) : (
          <span className="text-slate-400">Not recognised - choose below</span>
        )}
      </td>
      <td className="td text-right tabular-nums">
        {sheet.duplicateRowCount > 0 ? (
          <span className="text-amber-600">{sheet.duplicateRowCount}</span>
        ) : (
          <span className="text-slate-400">—</span>
        )}
      </td>
    </tr>
  );
}

/* -------------------------------------------------------------------------- */
/* Step 3: column mapping                                                      */
/* -------------------------------------------------------------------------- */

function MapStep({
  upload,
  sheetName,
  type,
  fields,
  mapping,
  onChange,
  onBack,
  onNext,
  busy,
}: {
  upload: ImportUploadResult;
  sheetName: string;
  type: ImportType;
  fields: ImportField[];
  mapping: Record<string, string | null>;
  onChange: (field: string, column: string | null) => void;
  onBack: () => void;
  onNext: () => void;
  busy: boolean;
}) {
  const sheet = upload.analysis.sheets.find((s) => s.name === sheetName)!;

  const usedColumns = useMemo(
    () => new Set(Object.values(mapping).filter(Boolean) as string[]),
    [mapping],
  );
  const unmappedColumns = sheet.columns.filter((column) => !usedColumns.has(column.name));
  const missingRequired = fields.filter((field) => field.required && !mapping[field.key]);

  const options = useMemo(
    () => [
      { label: '— not imported —', value: '' },
      ...sheet.columns.map((column) => ({ label: column.name, value: column.name })),
    ],
    [sheet.columns],
  );

  return (
    <div className="space-y-5">
      <Card
        title="Map the columns"
        subtitle={`Sheet "${sheetName}" · ${fmtNumber(sheet.rowCount)} rows. Anything left unmapped is simply not imported.`}
        bodyClassName="p-0"
      >
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-slate-50/70">
                <th className="th w-1/4">PharmaPulse field</th>
                <th className="th w-1/4">Column in your file</th>
                <th className="th">Sample values</th>
                <th className="th hidden lg:table-cell">Notes</th>
              </tr>
            </thead>
            <tbody>
              {fields.map((field) => {
                const column = mapping[field.key] ?? '';
                const detail = sheet.columns.find((c) => c.name === column);
                const missing = field.required && !column;

                return (
                  <tr key={field.key} className={`table-row ${missing ? 'bg-rose-50/50' : ''}`}>
                    <td className="td">
                      <span className="font-medium text-slate-800">{field.label}</span>
                      {field.required && <span className="ml-1 text-rose-600" title="Required">*</span>}
                      <span className="ml-2 text-xs text-slate-400">{field.type}</span>
                    </td>
                    <td className="td">
                      <Select
                        label={`Column for ${field.label}`}
                        value={column}
                        onChange={(value) => onChange(field.key, value === '' ? null : value)}
                        options={options}
                        className="py-1.5 text-sm"
                      />
                    </td>
                    <td className="td text-slate-500">
                      {detail ? (
                        detail.samples.length > 0 ? (
                          <span className="line-clamp-1">{detail.samples.join(' · ')}</span>
                        ) : (
                          <span className="text-amber-600">This column is empty</span>
                        )
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="td hidden text-xs leading-relaxed text-slate-500 lg:table-cell">
                      {field.note ?? (field.values ? `One of: ${field.values.join(', ')}` : '')}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {unmappedColumns.length > 0 && (
        <Card title="Columns not being imported" subtitle="These exist in your file but are not mapped to anything.">
          <div className="flex flex-wrap gap-1.5">
            {unmappedColumns.map((column) => (
              <span key={column.name} className="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-600">
                {column.name}
              </span>
            ))}
          </div>
        </Card>
      )}

      {missingRequired.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm text-rose-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            Still to map: <strong>{missingRequired.map((field) => field.label).join(', ')}</strong>. These are
            required for a {type.replace(/_/g, ' ').toLowerCase()} import.
          </span>
        </div>
      )}

      <div className="flex items-center justify-between">
        <button type="button" className="btn-secondary" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Back
        </button>
        <button type="button" className="btn-primary" disabled={busy || missingRequired.length > 0} onClick={onNext}>
          {busy ? <Spinner className="h-4 w-4" /> : <Table2 className="h-4 w-4" aria-hidden />}
          Check the data
        </button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Step 4: preview and commit                                                  */
/* -------------------------------------------------------------------------- */

function ReviewStep({
  preview,
  options,
  onOptionChange,
  onBack,
  onImport,
  busy,
  error,
}: {
  preview: ImportPreview;
  options: { updateExisting: boolean; createMissingReferences: boolean };
  onOptionChange: (key: 'updateExisting' | 'createMissingReferences', value: boolean) => void;
  onBack: () => void;
  onImport: () => void;
  busy: boolean;
  error: string | null;
}) {
  const { summary } = preview;
  const errorIssues = preview.issues.filter((issue) => issue.severity === 'ERROR');
  const warningIssues = preview.issues.filter((issue) => issue.severity === 'WARNING');

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Rows found" value={summary.totalRows} />
        <Stat label="Will be imported" value={summary.validRows} tone="emerald" />
        <Stat label="Will be rejected" value={summary.invalidRows} tone={summary.invalidRows > 0 ? 'rose' : 'slate'} />
        <Stat label="Repeated in the file" value={summary.duplicateRows} tone={summary.duplicateRows > 0 ? 'amber' : 'slate'} />
      </div>

      <Card title="First 20 rows, as they will be stored" subtitle="Dates, prices and quantities shown here are the values after conversion." bodyClassName="p-0">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-slate-50/70">
                <th className="th w-16">Row</th>
                {preview.columns.map((column) => (
                  <th key={column.key} className="th whitespace-nowrap">{column.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((row) => (
                <tr key={row.rowNumber} className={`table-row ${row.valid ? '' : 'bg-rose-50/60'}`}>
                  <td className="td tabular-nums text-slate-500">
                    {row.rowNumber}
                    {!row.valid && <AlertTriangle className="ml-1 inline h-3.5 w-3.5 text-rose-500" aria-hidden />}
                    {row.duplicate && <span className="ml-1 text-[10px] uppercase text-amber-600">dup</span>}
                  </td>
                  {preview.columns.map((column) => {
                    const value = row.values[column.key];
                    return (
                      <td key={column.key} className="td whitespace-nowrap">
                        {value === null || value === undefined || value === '' ? (
                          <span className="text-slate-300">—</span>
                        ) : typeof value === 'boolean' ? (
                          value ? 'Yes' : 'No'
                        ) : (
                          String(value)
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {(errorIssues.length > 0 || warningIssues.length > 0) && (
        <Card
          title={`${summary.errors} problem(s) and ${summary.warnings} warning(s)`}
          subtitle="Row numbers match your spreadsheet, so each one can be found and fixed directly."
          actions={
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                void downloadFile(`/imports/${preview.job.id}/errors/download`, `import-${preview.job.id}-errors.csv`);
              }}
            >
              <Download className="h-4 w-4" aria-hidden />
              Error report
            </button>
          }
          bodyClassName="p-0"
        >
          <div className="max-h-80 overflow-y-auto">
            <table className="w-full">
              <thead className="sticky top-0">
                <tr className="bg-slate-50">
                  <th className="th w-16">Row</th>
                  <th className="th w-24">Severity</th>
                  <th className="th">Problem</th>
                </tr>
              </thead>
              <tbody>
                {[...errorIssues, ...warningIssues].slice(0, 200).map((issue, index) => (
                  <tr key={`${issue.rowNumber}-${index}`} className="table-row">
                    <td className="td tabular-nums text-slate-500">{issue.rowNumber}</td>
                    <td className="td">
                      <Pill tone={issue.severity === 'ERROR' ? 'rose' : 'amber'}>
                        {issue.severity === 'ERROR' ? 'Rejected' : 'Warning'}
                      </Pill>
                    </td>
                    <td className="td text-slate-700">{issue.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.issuesTruncated && (
            <p className="border-t border-slate-100 px-5 py-2.5 text-xs text-slate-500">
              Showing the first 500 findings. Download the error report for the complete list.
            </p>
          )}
        </Card>
      )}

      <Card title="Import options">
        <div className="space-y-3">
          <Toggle
            checked={options.updateExisting}
            onChange={(value) => onOptionChange('updateExisting', value)}
            label="Update records that already exist"
            hint="Off, a record already in PharmaPulse is left untouched and the row is skipped."
          />
          <Toggle
            checked={options.createMissingReferences}
            onChange={(value) => onOptionChange('createMissingReferences', value)}
            label="Create manufacturers, suppliers and products named in the file"
            hint="Off, a row referring to something not yet in PharmaPulse is skipped instead."
          />
        </div>
      </Card>

      {error && <ErrorState message={error} />}

      <div className="flex items-center justify-between">
        <button type="button" className="btn-secondary" onClick={onBack} disabled={busy}>
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Change the mapping
        </button>
        <button type="button" className="btn-primary" onClick={onImport} disabled={busy || summary.validRows === 0}>
          {busy ? <Spinner className="h-4 w-4" /> : <Check className="h-4 w-4" aria-hidden />}
          Import {fmtNumber(summary.validRows)} row(s)
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value, tone = 'slate' }: { label: string; value: number; tone?: string }) {
  const tones: Record<string, string> = {
    slate: 'text-slate-900',
    emerald: 'text-emerald-700',
    rose: 'text-rose-700',
    amber: 'text-amber-700',
  };
  return (
    <div className="card px-4 py-3">
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${tones[tone]}`}>{fmtNumber(value)}</p>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
      />
      <span>
        <span className="block text-sm font-medium text-slate-800">{label}</span>
        <span className="block text-xs text-slate-500">{hint}</span>
      </span>
    </label>
  );
}

/* -------------------------------------------------------------------------- */
/* Step 5: outcome                                                             */
/* -------------------------------------------------------------------------- */

function DoneStep({ result, onAnother }: { result: ImportCommitResult; onAnother: () => void }) {
  const { outcome, job } = result;

  return (
    <Card>
      <div className="flex flex-col items-center gap-3 py-6 text-center">
        <CheckCircle2 className="h-10 w-10 text-emerald-500" aria-hidden />
        <h2 className="text-lg font-semibold text-slate-900">Import complete</h2>
        <p className="text-sm text-slate-500">
          {job.file_name} · {job.sheet_name}
        </p>

        <div className="mt-2 grid w-full max-w-2xl gap-3 sm:grid-cols-3">
          <Stat label="Created" value={outcome.created} tone="emerald" />
          <Stat label="Updated" value={outcome.updated} tone="slate" />
          <Stat label="Rejected" value={outcome.rejected} tone={outcome.rejected > 0 ? 'rose' : 'slate'} />
        </div>

        {outcome.notes.length > 0 && (
          <ul className="mt-2 space-y-1 text-sm text-slate-600">
            {outcome.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        )}

        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <button type="button" className="btn-primary" onClick={onAnother}>
            <Upload className="h-4 w-4" aria-hidden />
            Import another file
          </button>
          {outcome.rejected > 0 && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                void downloadFile(`/imports/${job.id}/errors/download`, `import-${job.id}-errors.csv`);
              }}
            >
              <Download className="h-4 w-4" aria-hidden />
              Download error report
            </button>
          )}
          <Link className="btn-secondary" to="/import/history">
            <History className="h-4 w-4" aria-hidden />
            Import history
          </Link>
        </div>
      </div>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Wizard                                                                      */
/* -------------------------------------------------------------------------- */

export default function ImportCenter() {
  const { data: types, error: typesError, loading: typesLoading } = useApi<{ data: ImportTypeSummary[] }>('/imports/types');

  const [step, setStep] = useState<Step>('upload');
  const [upload, setUpload] = useState<ImportUploadResult | null>(null);
  const [sheetName, setSheetName] = useState('');
  const [type, setType] = useState<ImportType | ''>('');
  const [fields, setFields] = useState<ImportField[]>([]);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<ImportCommitResult | null>(null);
  const [options, setOptions] = useState({ updateExisting: true, createMissingReferences: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Fresh field list and mapping whenever the sheet or the import type changes. */
  useEffect(() => {
    if (!upload || !sheetName || !type) return;

    let cancelled = false;
    setBusy(true);
    api
      .get<{ data: { mapping: Record<string, string | null>; fields: ImportField[] } }>(
        `/imports/${upload.job.id}/suggest`,
        { sheet: sheetName, type },
      )
      .then((response) => {
        if (cancelled) return;
        setFields(response.data.fields);
        setMapping(response.data.mapping);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not read that sheet.');
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });

    return () => {
      cancelled = true;
    };
  }, [upload, sheetName, type]);

  const reset = () => {
    setStep('upload');
    setUpload(null);
    setSheetName('');
    setType('');
    setFields([]);
    setMapping({});
    setPreview(null);
    setResult(null);
    setError(null);
  };

  const runPreview = async () => {
    if (!upload || !type) return;
    setBusy(true);
    setError(null);
    try {
      const response = await api.post<{ data: ImportPreview }>(`/imports/${upload.job.id}/preview`, {
        sheet: sheetName,
        type,
        mapping,
        options,
      });
      setPreview(response.data);
      setStep('review');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That sheet could not be checked.');
    } finally {
      setBusy(false);
    }
  };

  const runImport = async () => {
    if (!upload || !type) return;
    setBusy(true);
    setError(null);
    try {
      const response = await api.post<{ data: ImportCommitResult }>(`/imports/${upload.job.id}/commit`, {
        sheet: sheetName,
        type,
        mapping,
        options,
      });
      setResult(response.data);
      setStep('done');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The import could not be completed.');
    } finally {
      setBusy(false);
    }
  };

  if (typesLoading) return <LoadingBlock label="Loading the Import Center…" rows={4} />;
  if (typesError) return <ErrorState message={typesError} />;
  if (!types) return <EmptyState title="Import Center unavailable" />;

  return (
    <>
      <PageHeader
        title="Import Center"
        subtitle="Bring your product master, suppliers, stock and trading history in from Excel or CSV."
        actions={
          <Link className="btn-secondary" to="/import/history">
            <History className="h-4 w-4" aria-hidden />
            Import history
          </Link>
        }
      />

      <StepBar current={step} />

      {step === 'upload' && (
        <UploadStep
          types={types.data}
          onUploaded={(uploaded) => {
            setUpload(uploaded);
            // Open on the first sheet that actually holds data.
            const firstUsable = uploaded.analysis.sheets.find((sheet) => sheet.rowCount > 0) ?? uploaded.analysis.sheets[0];
            setSheetName(firstUsable?.name ?? '');
            setType(firstUsable?.suggestedType ?? '');
            setStep('sheet');
          }}
        />
      )}

      {step === 'sheet' && upload && (
        <SheetStep
          upload={upload}
          types={types.data}
          selectedSheet={sheetName}
          selectedType={type}
          onSelectSheet={(name) => {
            setSheetName(name);
            const sheet = upload.analysis.sheets.find((s) => s.name === name);
            setType(sheet?.suggestedType ?? '');
          }}
          onSelectType={setType}
          onBack={reset}
          onNext={() => setStep('map')}
        />
      )}

      {step === 'map' && upload && type && (
        <MapStep
          upload={upload}
          sheetName={sheetName}
          type={type}
          fields={fields}
          mapping={mapping}
          busy={busy}
          onChange={(field, column) =>
            setMapping((current) => {
              // A column may back only one field, so assigning it here clears it
              // from wherever it was before.
              const next = { ...current };
              if (column) {
                for (const key of Object.keys(next)) if (next[key] === column) next[key] = null;
              }
              next[field] = column;
              return next;
            })
          }
          onBack={() => setStep('sheet')}
          onNext={() => void runPreview()}
        />
      )}

      {step === 'review' && preview && (
        <ReviewStep
          preview={preview}
          options={options}
          onOptionChange={(key, value) => setOptions((current) => ({ ...current, [key]: value }))}
          onBack={() => setStep('map')}
          onImport={() => void runImport()}
          busy={busy}
          error={error}
        />
      )}

      {step === 'done' && result && <DoneStep result={result} onAnother={reset} />}

      {error && step !== 'review' && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm text-rose-800">
          <X className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{error}</span>
        </div>
      )}
    </>
  );
}
