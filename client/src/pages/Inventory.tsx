import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Boxes, CalendarClock, IndianRupee, Layers, Trash2 } from 'lucide-react';
import { useApi, useDebounced } from '../hooks/useApi';
import { Card, ErrorState, KpiCard, LoadingBlock, PageHeader, Pill, StockBadge } from '../components/ui';
import { DataTable, Pagination, SearchInput, Select, type Column } from '../components/DataTable';
import { currency, currencyCompact, date, number } from '../utils/format';
import { api, ApiError } from '../services/api';
import type { InventoryItem, Paged } from '../types';

/* -------------------------------------------------------------------------- */
/* Current stock                                                               */
/* -------------------------------------------------------------------------- */

export function CurrentStock() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('ALL');
  const [page, setPage] = useState(1);
  const debounced = useDebounced(search);

  const { data: summary } = useApi<{ summary: { totalUnits: number; inventoryValueAtCost: number; inventoryValueAtRetail: number; activeSkus: number; lowStock: number; outOfStock: number; expiring: number } }>(
    '/analytics/inventory',
  );
  const { data, error, loading, reload } = useApi<Paged<InventoryItem>>('/inventory/stock', {
    search: debounced || undefined,
    status: status === 'ALL' ? undefined : status,
    page,
    pageSize: 25,
  });

  const columns: Column<InventoryItem>[] = [
    {
      key: 'product',
      header: 'Product',
      render: (row) => (
        <div className="max-w-[260px]">
          <Link to={`/inventory/products/${row.id}`} className="block truncate font-medium text-slate-800 hover:text-brand-700">
            {row.product_name}
          </Link>
          <span className="text-xs text-slate-500">{row.generic_name ?? row.category}</span>
        </div>
      ),
    },
    { key: 'batches', header: 'Batches', align: 'right', secondary: true, render: (r) => number(r.batch_count) },
    {
      key: 'stock',
      header: 'On hand',
      align: 'right',
      render: (r) => <span className="font-medium">{number(r.current_stock)}</span>,
    },
    { key: 'reorder', header: 'Reorder at', align: 'right', secondary: true, render: (r) => number(r.reorder_level) },
    { key: 'value', header: 'Value at cost', align: 'right', render: (r) => currency(r.inventory_value) },
    { key: 'retail', header: 'At retail', align: 'right', secondary: true, render: (r) => currency(r.retail_value) },
    {
      key: 'expiry',
      header: 'Nearest expiry',
      render: (r) =>
        r.nearest_expiry ? (
          <span className={(r.days_to_nearest_expiry ?? 999) <= 90 ? 'text-amber-700' : ''}>
            {date(r.nearest_expiry)}
          </span>
        ) : (
          '—'
        ),
    },
    { key: 'status', header: 'Status', render: (r) => <StockBadge status={r.stock_status} /> },
  ];

  const s = summary?.summary;

  return (
    <>
      <PageHeader title="Current Stock" subtitle="Live position across every product, valued at cost and at retail" />

      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Inventory value" value={currencyCompact(s?.inventoryValueAtCost ?? 0)} sub={`${number(s?.activeSkus ?? 0)} active SKUs`} icon={IndianRupee} />
        <KpiCard label="Units on hand" value={number(s?.totalUnits ?? 0)} sub={`retail ${currencyCompact(s?.inventoryValueAtRetail ?? 0)}`} icon={Boxes} />
        <KpiCard label="Low stock" value={number(s?.lowStock ?? 0)} sub={`${number(s?.outOfStock ?? 0)} out of stock`} icon={AlertTriangle} tone={(s?.lowStock ?? 0) > 0 ? 'warning' : 'default'} to="/procurement/replenishment" />
        <KpiCard label="Expiring" value={number(s?.expiring ?? 0)} sub="inside the warning window" icon={CalendarClock} tone={(s?.expiring ?? 0) > 0 ? 'warning' : 'default'} to="/inventory/expiry" />
      </div>

      <Card bodyClassName="p-0">
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-4">
          <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search stock…" className="min-w-[240px] flex-1" />
          <Select
            value={status}
            onChange={(v) => { setStatus(v); setPage(1); }}
            label="Status"
            className="w-auto"
            options={[
              { label: 'All statuses', value: 'ALL' },
              { label: 'Out of stock', value: 'OUT_OF_STOCK' },
              { label: 'Low stock', value: 'LOW_STOCK' },
              { label: 'Expiring', value: 'EXPIRING' },
              { label: 'Overstocked', value: 'OVERSTOCKED' },
              { label: 'Healthy', value: 'HEALTHY' },
            ]}
          />
        </div>

        <DataTable columns={columns} rows={data?.data ?? []} rowKey={(r) => r.id} loading={loading} error={error} onRetry={reload} emptyTitle="No stock matches" />
        {data && <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onChange={setPage} />}
      </Card>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Batch register                                                              */
/* -------------------------------------------------------------------------- */

interface BatchRow {
  id: number;
  product_id: number;
  product_name: string;
  product_code: string;
  batch_number: string;
  expiry_date: string;
  manufacturing_date: string | null;
  quantity: number;
  purchase_price: number;
  selling_price: number;
  supplier_name: string | null;
  days_to_expiry: number;
  expiry_bucket: string;
  stock_value: number;
  status: string;
}

const BUCKET_TONE: Record<string, string> = {
  EXPIRED: 'rose',
  DAYS_30: 'rose',
  DAYS_60: 'amber',
  DAYS_90: 'amber',
  SAFE: 'emerald',
};

export function Batches() {
  const [search, setSearch] = useState('');
  const [bucket, setBucket] = useState('ALL');
  const [page, setPage] = useState(1);
  const debounced = useDebounced(search);

  const { data, error, loading, reload } = useApi<Paged<BatchRow>>('/inventory/batches', {
    search: debounced || undefined,
    bucket: bucket === 'ALL' ? undefined : bucket,
    page,
    pageSize: 25,
  });

  const columns: Column<BatchRow>[] = [
    {
      key: 'product',
      header: 'Product',
      render: (r) => (
        <Link to={`/inventory/products/${r.product_id}`} className="block max-w-[220px] truncate font-medium text-slate-800 hover:text-brand-700">
          {r.product_name}
        </Link>
      ),
    },
    { key: 'batch', header: 'Batch', render: (r) => <span className="font-mono text-xs">{r.batch_number}</span> },
    { key: 'mfg', header: 'Mfg', secondary: true, render: (r) => (r.manufacturing_date ? date(r.manufacturing_date) : '—') },
    { key: 'expiry', header: 'Expiry', render: (r) => date(r.expiry_date) },
    {
      key: 'days',
      header: 'Days left',
      align: 'right',
      render: (r) => (
        <span className={r.days_to_expiry < 0 ? 'font-semibold text-rose-600' : r.days_to_expiry <= 90 ? 'text-amber-700' : ''}>
          {r.days_to_expiry < 0 ? `${Math.abs(r.days_to_expiry)} ago` : r.days_to_expiry}
        </span>
      ),
    },
    { key: 'qty', header: 'Qty', align: 'right', render: (r) => number(r.quantity) },
    { key: 'value', header: 'Value', align: 'right', render: (r) => currency(r.stock_value) },
    { key: 'supplier', header: 'Supplier', secondary: true, render: (r) => r.supplier_name ?? '—' },
    { key: 'bucket', header: 'Shelf life', render: (r) => <Pill tone={BUCKET_TONE[r.expiry_bucket]}>{r.expiry_bucket.replace('DAYS_', '≤')}</Pill> },
  ];

  return (
    <>
      <PageHeader title="Batch Register" subtitle="Every batch on record — the full traceability trail" />
      <Card bodyClassName="p-0">
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-4">
          <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search product, batch or supplier…" className="min-w-[240px] flex-1" />
          <Select
            value={bucket}
            onChange={(v) => { setBucket(v); setPage(1); }}
            label="Shelf life"
            className="w-auto"
            options={[
              { label: 'All shelf lives', value: 'ALL' },
              { label: 'Expired', value: 'EXPIRED' },
              { label: 'Within 30 days', value: 'DAYS_30' },
              { label: 'Within 60 days', value: 'DAYS_60' },
              { label: 'Within 90 days', value: 'DAYS_90' },
              { label: 'Safe', value: 'SAFE' },
            ]}
          />
        </div>
        <DataTable columns={columns} rows={data?.data ?? []} rowKey={(r) => r.id} loading={loading} error={error} onRetry={reload} emptyTitle="No batches match" />
        {data && <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onChange={setPage} />}
      </Card>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Expiry management                                                           */
/* -------------------------------------------------------------------------- */

interface ExpiryResponse {
  expired: BatchRow[];
  expiring: BatchRow[];
  buckets: Record<string, number>;
  valueAtRisk: { expired: number; expiring: number };
}

export function Expiry() {
  const { data, error, loading, reload } = useApi<ExpiryResponse>('/inventory/expiry');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function writeOff() {
    setBusy(true);
    try {
      const result = await api.post<{ message: string }>('/inventory/write-off-expired');
      setMessage(result.message);
      reload();
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Write-off failed.');
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<BatchRow>[] = [
    {
      key: 'product',
      header: 'Product',
      render: (r) => (
        <Link to={`/inventory/products/${r.product_id}`} className="block max-w-[220px] truncate font-medium text-slate-800 hover:text-brand-700">
          {r.product_name}
        </Link>
      ),
    },
    { key: 'batch', header: 'Batch', render: (r) => <span className="font-mono text-xs">{r.batch_number}</span> },
    { key: 'expiry', header: 'Expiry', render: (r) => date(r.expiry_date) },
    {
      key: 'days',
      header: 'Days',
      align: 'right',
      render: (r) => (
        <span className={r.days_to_expiry < 0 ? 'font-semibold text-rose-600' : 'text-amber-700'}>
          {r.days_to_expiry < 0 ? `${Math.abs(r.days_to_expiry)} ago` : r.days_to_expiry}
        </span>
      ),
    },
    { key: 'qty', header: 'Qty', align: 'right', render: (r) => number(r.quantity) },
    { key: 'value', header: 'Value at risk', align: 'right', render: (r) => currency(r.stock_value) },
    { key: 'supplier', header: 'Supplier', secondary: true, render: (r) => r.supplier_name ?? '—' },
  ];

  if (error) {
    return (
      <>
        <PageHeader title="Expiry" />
        <Card><ErrorState message={error} onRetry={reload} /></Card>
      </>
    );
  }

  if (!data) {
    return (
      <>
        <PageHeader title="Expiry" />
        <Card><LoadingBlock rows={6} /></Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Expiry Management"
        subtitle="Batches by remaining shelf life — FEFO already dispenses the earliest first"
        actions={
          data.expired.length > 0 && (
            <button type="button" className="btn-danger" onClick={writeOff} disabled={busy}>
              <Trash2 className="h-4 w-4" aria-hidden />
              {busy ? 'Writing off…' : `Write off ${data.expired.length} expired batch(es)`}
            </button>
          )
        }
      />

      {message && (
        <div className="card mb-4 border-l-4 border-l-emerald-500 p-4 text-sm text-slate-700">{message}</div>
      )}

      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Already expired" value={number(data.expired.length)} sub={`${currency(data.valueAtRisk.expired)} written off`} icon={AlertTriangle} tone={data.expired.length > 0 ? 'danger' : 'default'} />
        <KpiCard label="Within 30 days" value={number(data.buckets.DAYS_30 ?? 0)} sub="urgent clearance" icon={CalendarClock} tone={(data.buckets.DAYS_30 ?? 0) > 0 ? 'danger' : 'default'} />
        <KpiCard label="Within 60 days" value={number(data.buckets.DAYS_60 ?? 0)} icon={CalendarClock} tone="warning" />
        <KpiCard label="Value at risk" value={currencyCompact(data.valueAtRisk.expiring)} sub="expiring within window" icon={IndianRupee} tone="warning" />
      </div>

      {data.expired.length > 0 && (
        <Card title="Expired — must not be dispensed" subtitle="Already excluded from sale by FEFO, but still inflating reported inventory value" className="mb-4" bodyClassName="p-0">
          <DataTable columns={columns} rows={data.expired} rowKey={(r) => r.id} emptyTitle="None" />
        </Card>
      )}

      <Card title="Expiring soon" subtitle="Still sellable — clear these before they become a write-off" bodyClassName="p-0">
        <DataTable columns={columns} rows={data.expiring} rowKey={(r) => r.id} loading={loading} emptyTitle="Nothing expiring" emptyMessage="No batch falls inside the configured expiry warning window." />
      </Card>
    </>
  );
}
