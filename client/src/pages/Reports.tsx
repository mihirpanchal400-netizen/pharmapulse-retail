import { useState } from 'react';
import { Download, FileSpreadsheet, Loader2 } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { Card, ErrorState, LoadingBlock, PageHeader, SegmentedControl } from '../components/ui';
import { downloadCsv, ApiError } from '../services/api';
import { number } from '../utils/format';

/**
 * REPORTS
 * =======
 *
 * Every report is a projection of the same analytics the screens use, so an
 * exported file can never disagree with what the user just looked at.
 *
 * The preview is deliberately shown before download: exporting a 12,000-row CSV
 * only to find it was the wrong date range is a waste of everyone's time.
 */

interface ReportMeta {
  id: string;
  title: string;
  description: string;
  dated: boolean;
  columns: number;
}

interface PreviewData {
  id: string;
  title: string;
  description: string;
  headers: string[];
  rows: (string | number)[][];
  totalRows: number;
}

const WINDOWS = [
  { label: '7 days', value: 7 },
  { label: '30 days', value: 30 },
  { label: '90 days', value: 90 },
  { label: '365 days', value: 365 },
];

export default function Reports() {
  const [selected, setSelected] = useState<string | null>(null);
  const [days, setDays] = useState(30);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const { data: reports, error, loading, reload } = useApi<{ data: ReportMeta[] }>('/reports');
  const { data: preview, loading: previewLoading } = useApi<PreviewData>(
    selected ? `/reports/${selected}/preview` : null,
    { days, limit: 12 },
  );

  async function download(id: string) {
    setDownloading(id);
    setMessage(null);
    try {
      const result = await downloadCsv(id, { days });
      setMessage(`Downloaded ${result.filename} — ${number(result.rows)} row(s).`);
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Export failed.');
    } finally {
      setDownloading(null);
    }
  }

  if (error) {
    return (
      <>
        <PageHeader title="Reports" />
        <Card>
          <ErrorState message={error} onRetry={reload} />
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle="CSV exports for sales, inventory, expiry, purchasing and profitability"
        actions={<SegmentedControl options={WINDOWS} value={days} onChange={setDays} />}
      />

      {message && <div className="card mb-4 p-3 text-sm text-slate-700">{message}</div>}

      {loading && !reports && (
        <Card>
          <LoadingBlock rows={6} />
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {(reports?.data ?? []).map((report) => (
          <article key={report.id} className={`card flex flex-col p-4 ${selected === report.id ? 'ring-2 ring-brand-500' : ''}`}>
            <div className="flex items-start gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-500">
                <FileSpreadsheet className="h-4 w-4" aria-hidden />
              </span>
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-slate-900">{report.title}</h3>
                <p className="mt-0.5 text-xs leading-relaxed text-slate-500">{report.description}</p>
              </div>
            </div>

            <p className="mt-2 text-xs text-slate-400">
              {report.columns} columns · {report.dated ? `honours the ${days}-day window` : 'full dataset'}
            </p>

            <div className="mt-auto flex gap-2 pt-3">
              <button
                type="button"
                className="btn-secondary flex-1 text-xs"
                onClick={() => setSelected(selected === report.id ? null : report.id)}
              >
                {selected === report.id ? 'Hide preview' : 'Preview'}
              </button>
              <button
                type="button"
                className="btn-primary flex-1 text-xs"
                onClick={() => download(report.id)}
                disabled={downloading === report.id}
              >
                {downloading === report.id ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <Download className="h-3.5 w-3.5" aria-hidden />
                )}
                CSV
              </button>
            </div>
          </article>
        ))}
      </div>

      {selected && (
        <Card
          className="mt-5"
          title={preview?.title ?? 'Preview'}
          subtitle={preview ? `First ${preview.rows.length} of ${number(preview.totalRows)} rows` : undefined}
          bodyClassName="p-0"
        >
          {previewLoading && !preview ? (
            <div className="p-5">
              <LoadingBlock rows={5} />
            </div>
          ) : preview && preview.rows.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-slate-50/70">
                    {preview.headers.map((header) => (
                      <th key={header} className="th whitespace-nowrap">
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row, i) => (
                    <tr key={i} className="table-row">
                      {row.map((cell, j) => (
                        <td key={j} className="td whitespace-nowrap">
                          {String(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="px-5 py-10 text-center text-sm text-slate-500">
              This report has no rows for the selected period.
            </p>
          )}
        </Card>
      )}

      <p className="mt-5 text-xs leading-relaxed text-slate-400">
        Exports open directly in Excel — a byte-order mark is written so rupee symbols and names
        render correctly. Revenue figures are net of tax and net of returns, and profit is gross
        profit (revenue minus cost of goods sold), consistent with every other screen.
      </p>
    </>
  );
}
