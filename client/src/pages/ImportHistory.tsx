import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, FileSpreadsheet, Upload } from 'lucide-react';
import { Card, EmptyState, KpiCard, PageHeader, Pill } from '../components/ui';
import { DataTable, Pagination, SearchInput, Select, type Column } from '../components/DataTable';
import { useApi, useDebounced } from '../hooks/useApi';
import { downloadFile } from '../services/api';
import { dateTime, number as fmtNumber } from '../utils/format';
import type { ImportErrorRow, ImportJob, Paged } from '../types';

/**
 * IMPORT HISTORY
 * ==============
 *
 * The durable record of every file that has been brought into the pharmacy:
 * what was uploaded, by whom, how many rows landed and how many were rejected.
 * Selecting a row opens its findings, which stay downloadable long after the
 * spreadsheet itself has been cleaned up.
 */

const STATUS_TONES: Record<string, string> = {
  COMPLETED: 'emerald',
  FAILED: 'rose',
  CANCELLED: 'slate',
  PREVIEWED: 'amber',
  UPLOADED: 'amber',
  MAPPED: 'amber',
};

const TYPE_LABELS: Record<string, string> = {
  PRODUCT_MASTER: 'Product Master',
  MANUFACTURER_MASTER: 'Manufacturer Master',
  SUPPLIER_MASTER: 'Supplier Master',
  DISTRIBUTOR_MASTER: 'Distributor Master',
  OPENING_STOCK: 'Opening Stock',
  BATCH_MASTER: 'Batch Master',
  PRICE_LIST: 'Price List',
  PURCHASE_HISTORY: 'Purchase History',
  SALES_HISTORY: 'Sales History',
};

interface HistoryResponse extends Paged<ImportJob> {
  stats: {
    totalJobs: number;
    completedJobs: number;
    failedJobs: number;
    rowsImported: number;
    lastImportAt: string | null;
  };
}

export default function ImportHistory() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('ALL');
  const [type, setType] = useState('ALL');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<ImportJob | null>(null);

  const debounced = useDebounced(search);
  const { data, error, loading, reload } = useApi<HistoryResponse>('/imports', {
    search: debounced,
    status,
    type,
    page,
    pageSize: 20,
  });

  const columns: Column<ImportJob>[] = [
    {
      key: 'file',
      header: 'File',
      render: (job) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-slate-800">{job.file_name}</p>
          <p className="text-xs text-slate-500">
            {job.sheet_name ? `Sheet: ${job.sheet_name}` : 'No sheet chosen'} · {job.file_type}
          </p>
        </div>
      ),
    },
    {
      key: 'type',
      header: 'Import type',
      render: (job) => (job.import_type ? TYPE_LABELS[job.import_type] ?? job.import_type : <span className="text-slate-400">—</span>),
    },
    { key: 'date', header: 'Date', secondary: true, render: (job) => dateTime(job.created_at) },
    { key: 'user', header: 'User', secondary: true, render: (job) => job.username ?? '—' },
    {
      key: 'imported',
      header: 'Imported',
      align: 'right',
      render: (job) => <span className="tabular-nums text-emerald-700">{fmtNumber(job.imported_rows)}</span>,
    },
    {
      key: 'rejected',
      header: 'Rejected',
      align: 'right',
      render: (job) =>
        job.rejected_rows > 0 ? (
          <span className="tabular-nums text-rose-700">{fmtNumber(job.rejected_rows)}</span>
        ) : (
          <span className="text-slate-300">—</span>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (job) => <Pill tone={STATUS_TONES[job.status] ?? 'slate'}>{job.status}</Pill>,
    },
  ];

  return (
    <>
      <PageHeader
        title="Import History"
        subtitle="Every file brought into PharmaPulse, with its row counts and findings."
        actions={
          <Link className="btn-primary" to="/import">
            <Upload className="h-4 w-4" aria-hidden />
            New import
          </Link>
        }
      />

      {data?.stats && (
        <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard label="Files imported" value={fmtNumber(data.stats.completedJobs)} />
          <KpiCard label="Rows imported" value={fmtNumber(data.stats.rowsImported)} />
          <KpiCard label="Failed imports" value={fmtNumber(data.stats.failedJobs)} />
          <KpiCard label="Last import" value={data.stats.lastImportAt ? dateTime(data.stats.lastImportAt) : 'Never'} />
        </div>
      )}

      <Card bodyClassName="p-0">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-4">
          <SearchInput
            value={search}
            onChange={(value) => {
              setSearch(value);
              setPage(1);
            }}
            placeholder="Search by file name or user…"
            className="min-w-[220px] flex-1"
          />
          <Select
            label="Status"
            value={status}
            onChange={(value) => {
              setStatus(value);
              setPage(1);
            }}
            options={[
              { label: 'All statuses', value: 'ALL' },
              { label: 'Completed', value: 'COMPLETED' },
              { label: 'Failed', value: 'FAILED' },
              { label: 'Cancelled', value: 'CANCELLED' },
              { label: 'Not finished', value: 'PREVIEWED' },
            ]}
            className="w-44"
          />
          <Select
            label="Import type"
            value={type}
            onChange={(value) => {
              setType(value);
              setPage(1);
            }}
            options={[
              { label: 'All types', value: 'ALL' },
              ...Object.entries(TYPE_LABELS).map(([value, label]) => ({ label, value })),
            ]}
            className="w-52"
          />
        </div>

        <DataTable
          columns={columns}
          rows={data?.data ?? []}
          rowKey={(job) => job.id}
          loading={loading}
          error={error}
          onRetry={reload}
          onRowClick={setSelected}
          emptyTitle="No imports yet"
          emptyMessage="Upload a product master or stock file to get started."
        />

        {data && (
          <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onChange={setPage} />
        )}
      </Card>

      {selected && <JobDetail job={selected} onClose={() => setSelected(null)} />}
    </>
  );
}

/** Findings for one import, opened from the history table. */
function JobDetail({ job, onClose }: { job: ImportJob; onClose: () => void }) {
  const { data, loading } = useApi<{ data: ImportErrorRow[] }>(`/imports/${job.id}/errors`);
  const rows = data?.data ?? [];

  return (
    <Card
      className="mt-5"
      title={job.file_name}
      subtitle={`${fmtNumber(job.total_rows)} rows read · ${fmtNumber(job.created_count)} created · ${fmtNumber(job.updated_count)} updated · ${fmtNumber(job.rejected_rows)} rejected`}
      actions={
        <div className="flex items-center gap-2">
          {rows.length > 0 && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                void downloadFile(`/imports/${job.id}/errors/download`, `import-${job.id}-errors.csv`);
              }}
            >
              <Download className="h-4 w-4" aria-hidden />
              Error report
            </button>
          )}
          <button type="button" className="btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
      }
      bodyClassName="p-0"
    >
      {job.error_message && (
        <p className="border-b border-rose-100 bg-rose-50 px-5 py-3 text-sm text-rose-800">{job.error_message}</p>
      )}

      {loading ? (
        <p className="px-5 py-6 text-sm text-slate-500">Loading findings…</p>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No problems recorded"
          message="Every row in this file passed validation."
          icon={FileSpreadsheet}
        />
      ) : (
        <div className="max-h-96 overflow-y-auto">
          <table className="w-full">
            <thead className="sticky top-0">
              <tr className="bg-slate-50">
                <th className="th w-16">Row</th>
                <th className="th w-28">Severity</th>
                <th className="th hidden lg:table-cell">Column</th>
                <th className="th hidden lg:table-cell">Value</th>
                <th className="th">Problem</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="table-row">
                  <td className="td tabular-nums text-slate-500">{row.row_number}</td>
                  <td className="td">
                    <Pill tone={row.severity === 'ERROR' ? 'rose' : 'amber'}>
                      {row.severity === 'ERROR' ? 'Rejected' : 'Warning'}
                    </Pill>
                  </td>
                  <td className="td hidden text-slate-600 lg:table-cell">{row.column_name ?? '—'}</td>
                  <td className="td hidden max-w-[180px] truncate text-slate-600 lg:table-cell">{row.value ?? '—'}</td>
                  <td className="td text-slate-700">{row.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
