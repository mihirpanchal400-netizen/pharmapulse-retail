import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AlertCircle, CheckCircle2, FileText, Info, PackageCheck, Send, Truck } from 'lucide-react';
import { useApi, useDebounced } from '../hooks/useApi';
import { Card, ErrorState, KpiCard, LoadingBlock, PageHeader, Pill } from '../components/ui';
import { DataTable, Pagination, SearchInput, Select, type Column } from '../components/DataTable';
import { currency, currencyCompact, date, number } from '../utils/format';
import { api, ApiError } from '../services/api';

/**
 * PURCHASE ORDERS
 * ===============
 *
 * List, detail and goods receipt.
 *
 * Orders here are SIMULATED: creating or sending one writes to the local
 * database and transmits nothing. Receiving goods is where the procurement
 * chain rejoins inventory — batches are created, stock moves, and a supplier
 * invoice is raised that feeds the outstanding ledger.
 */

const STATUS_TONE: Record<string, string> = {
  DRAFT: 'slate',
  SENT: 'amber',
  CONFIRMED: 'brand',
  PARTIALLY_RECEIVED: 'amber',
  RECEIVED: 'emerald',
  CANCELLED: 'rose',
};

interface PoRow {
  id: number;
  po_number: string;
  distributor_name: string;
  distributor_city: string;
  po_date: string;
  expected_delivery: string | null;
  total_amount: number;
  free_units: number;
  savings_amount: number;
  status: string;
  item_count: number;
}

interface PoListResponse {
  data: PoRow[];
  page: number;
  totalPages: number;
  total: number;
  summary: { orders: number; openOrders: number; openValue: number; totalValue: number; totalSavings: number };
}

export function PurchaseOrderList() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('ALL');
  const [page, setPage] = useState(1);
  const debounced = useDebounced(search);

  const { data, error, loading, reload } = useApi<PoListResponse>('/procurement/purchase-orders', {
    search: debounced || undefined,
    status: status === 'ALL' ? undefined : status,
    page,
    pageSize: 25,
  });

  const columns: Column<PoRow>[] = [
    {
      key: 'po',
      header: 'Order',
      render: (row) => (
        <Link to={`/procurement/orders/${row.id}`} className="font-medium text-brand-700 hover:text-brand-800">
          {row.po_number}
        </Link>
      ),
    },
    { key: 'distributor', header: 'Distributor', render: (r) => r.distributor_name },
    { key: 'date', header: 'Date', render: (r) => date(r.po_date) },
    {
      key: 'expected',
      header: 'Expected',
      secondary: true,
      render: (r) => (r.expected_delivery ? date(r.expected_delivery) : '—'),
    },
    { key: 'items', header: 'Lines', align: 'right', render: (r) => number(r.item_count) },
    {
      key: 'free',
      header: 'Free',
      align: 'right',
      secondary: true,
      render: (r) => (r.free_units > 0 ? <span className="text-emerald-600">+{r.free_units}</span> : '—'),
    },
    { key: 'total', header: 'Value', align: 'right', render: (r) => currency(r.total_amount) },
    {
      key: 'status',
      header: 'Status',
      render: (r) => <Pill tone={STATUS_TONE[r.status]}>{r.status.replace('_', ' ').toLowerCase()}</Pill>,
    },
  ];

  return (
    <>
      <PageHeader
        title="Purchase Orders"
        subtitle="Simulated orders — created locally, never transmitted to any distributor"
        actions={
          <Link to="/procurement/replenishment" className="btn-primary">
            New order from Replenishment
          </Link>
        }
      />

      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Total orders" value={number(data?.summary.orders ?? 0)} icon={FileText} />
        <KpiCard
          label="Open orders"
          value={number(data?.summary.openOrders ?? 0)}
          sub="awaiting goods"
          icon={Truck}
          tone={(data?.summary.openOrders ?? 0) > 0 ? 'warning' : 'default'}
        />
        <KpiCard label="Open value" value={currencyCompact(data?.summary.openValue ?? 0)} icon={Truck} />
        <KpiCard
          label="Scheme savings"
          value={currencyCompact(data?.summary.totalSavings ?? 0)}
          sub="lifetime, from free goods"
          icon={CheckCircle2}
          tone="success"
        />
      </div>

      <Card bodyClassName="p-0">
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-4">
          <SearchInput
            value={search}
            onChange={(v) => {
              setSearch(v);
              setPage(1);
            }}
            placeholder="Search order number or distributor…"
            className="min-w-[240px] flex-1"
          />
          <Select
            value={status}
            onChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
            label="Status"
            className="w-auto"
            options={[
              { label: 'All statuses', value: 'ALL' },
              { label: 'Draft', value: 'DRAFT' },
              { label: 'Sent', value: 'SENT' },
              { label: 'Confirmed', value: 'CONFIRMED' },
              { label: 'Partially received', value: 'PARTIALLY_RECEIVED' },
              { label: 'Received', value: 'RECEIVED' },
              { label: 'Cancelled', value: 'CANCELLED' },
            ]}
          />
        </div>

        <DataTable
          columns={columns}
          rows={data?.data ?? []}
          rowKey={(row) => row.id}
          loading={loading}
          error={error}
          onRetry={reload}
          emptyTitle="No purchase orders"
          emptyMessage="Build a basket in the Replenishment Center and create your first order."
        />

        {data && <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onChange={setPage} />}
      </Card>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Detail + goods receipt                                                      */
/* -------------------------------------------------------------------------- */

interface PoItem {
  id: number;
  product_id: number;
  product_name: string;
  product_code: string;
  pack_size: string | null;
  ordered_qty: number;
  free_qty: number;
  received_qty: number;
  pending_qty: number;
  ptr: number;
  mrp: number;
  scheme_buy_qty: number;
  scheme_free_qty: number;
  line_total: number;
  effective_cost: number;
}

interface PoDetail {
  id: number;
  po_number: string;
  distributor_id: number;
  distributor_name: string;
  distributor_city: string;
  po_date: string;
  expected_delivery: string | null;
  payment_terms: string | null;
  gross_amount: number;
  discount_amount: number;
  tax_amount: number;
  total_amount: number;
  free_units: number;
  savings_amount: number;
  status: string;
  created_by: string | null;
  items: PoItem[];
}

/** Today + n days, as YYYY-MM-DD. */
function futureDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export function PurchaseOrderDetail() {
  const { id } = useParams();
  const { data, error, loading, reload } = useApi<PoDetail>(id ? `/procurement/purchase-orders/${id}` : null);

  const [receiving, setReceiving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [lines, setLines] = useState<Record<number, { qty: number; batch: string; expiry: string }>>({});

  function startReceiving() {
    if (!data) return;
    const initial: Record<number, { qty: number; batch: string; expiry: string }> = {};
    for (const item of data.items) {
      if (item.pending_qty <= 0) continue;
      initial[item.id] = {
        qty: item.pending_qty,
        // A sensible default the storekeeper can overwrite from the physical pack.
        batch: `B${data.po_number.slice(-5)}-${item.product_id}`,
        expiry: futureDate(540),
      };
    }
    setLines(initial);
    setReceiving(true);
    setMessage(null);
  }

  async function submitReceipt() {
    if (!data) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.post<{ receiptNumber: string; total: number; freeUnits: number; status: string }>(
        `/procurement/purchase-orders/${data.id}/receive`,
        {
          invoice_number: invoiceNumber || undefined,
          items: Object.entries(lines)
            .filter(([, line]) => line.qty > 0)
            .map(([itemId, line]) => ({
              po_item_id: Number(itemId),
              received_qty: line.qty,
              batch_number: line.batch,
              expiry_date: line.expiry,
            })),
        },
      );
      setMessage({
        tone: 'ok',
        text: `Goods receipt ${result.receiptNumber} booked. ${currency(result.total)} invoiced${result.freeUnits > 0 ? `, ${result.freeUnits} free units received` : ''}. Batches created and stock updated.`,
      });
      setReceiving(false);
      reload();
    } catch (err) {
      setMessage({ tone: 'error', text: err instanceof ApiError ? err.message : 'Goods receipt failed.' });
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(status: string) {
    if (!data) return;
    setBusy(true);
    setMessage(null);
    try {
      await api.patch(`/procurement/purchase-orders/${data.id}/status`, { status });
      reload();
    } catch (err) {
      setMessage({ tone: 'error', text: err instanceof ApiError ? err.message : 'Could not update the order.' });
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <>
        <PageHeader title="Purchase Order" />
        <Card>
          <ErrorState message={error} onRetry={reload} />
        </Card>
      </>
    );
  }

  if (!data) {
    return (
      <>
        <PageHeader title="Purchase Order" />
        <Card>
          <LoadingBlock rows={6} />
        </Card>
      </>
    );
  }

  const canReceive = ['CONFIRMED', 'PARTIALLY_RECEIVED', 'SENT'].includes(data.status);
  const pendingTotal = data.items.reduce((s, i) => s + i.pending_qty, 0);

  return (
    <>
      <PageHeader
        title={data.po_number}
        subtitle={`${data.distributor_name} · raised ${date(data.po_date)}${data.created_by ? ` by ${data.created_by}` : ''}`}
        actions={
          <>
            <Link to="/procurement/orders" className="btn-secondary">
              All orders
            </Link>
            {data.status === 'DRAFT' && (
              <button type="button" className="btn-secondary" onClick={() => setStatus('SENT')} disabled={busy}>
                <Send className="h-4 w-4" aria-hidden />
                Mark as sent
              </button>
            )}
            {data.status === 'SENT' && (
              <button type="button" className="btn-secondary" onClick={() => setStatus('CONFIRMED')} disabled={busy}>
                Mark confirmed
              </button>
            )}
            {canReceive && pendingTotal > 0 && !receiving && (
              <button type="button" className="btn-primary" onClick={startReceiving} disabled={busy}>
                <PackageCheck className="h-4 w-4" aria-hidden />
                Receive goods
              </button>
            )}
          </>
        }
      />

      <div className="card mb-4 flex items-start gap-2.5 border-amber-200 bg-amber-50/60 p-3">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
        <p className="text-xs leading-relaxed text-amber-900">
          <strong>Simulated purchase order.</strong> This order exists only in your local database.
          It has not been sent to any distributor, marketplace or external platform.
        </p>
      </div>

      {message && (
        <div className={`card mb-4 border-l-4 p-4 ${message.tone === 'ok' ? 'border-l-emerald-500' : 'border-l-rose-500'}`}>
          <div className="flex items-start gap-2.5">
            {message.tone === 'ok' ? (
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" aria-hidden />
            ) : (
              <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-rose-600" aria-hidden />
            )}
            <p className="text-sm text-slate-700">{message.text}</p>
          </div>
        </div>
      )}

      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Status" value={data.status.replace('_', ' ').toLowerCase()} sub={data.payment_terms ?? ''} icon={FileText} />
        <KpiCard label="Order value" value={currency(data.total_amount)} sub={`incl. ${currency(data.tax_amount)} GST`} icon={Truck} />
        <KpiCard label="Free units" value={number(data.free_units)} sub="from schemes" icon={CheckCircle2} tone={data.free_units > 0 ? 'success' : 'default'} />
        <KpiCard label="Scheme saving" value={currency(data.savings_amount)} sub="vs list rate" icon={CheckCircle2} tone="success" />
      </div>

      <Card title="Order lines" bodyClassName="p-0">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-slate-50/70">
                <th className="th">Product</th>
                <th className="th text-right">Ordered</th>
                <th className="th text-right">Free</th>
                <th className="th text-right">Received</th>
                <th className="th text-right">PTR</th>
                <th className="th text-right">Effective</th>
                <th className="th text-right">Line total</th>
                {receiving && <th className="th">Receive</th>}
              </tr>
            </thead>
            <tbody>
              {data.items.map((item) => (
                <tr key={item.id} className="table-row align-top">
                  <td className="td max-w-[240px]">
                    <span className="block truncate font-medium text-slate-800">{item.product_name}</span>
                    <span className="text-xs text-slate-500">
                      {item.product_code}
                      {item.pack_size ? ` · ${item.pack_size}` : ''}
                    </span>
                  </td>
                  <td className="td text-right tnum">{number(item.ordered_qty)}</td>
                  <td className="td text-right tnum text-emerald-600">
                    {item.free_qty > 0 ? `+${item.free_qty}` : '—'}
                  </td>
                  <td className="td text-right tnum">
                    {number(item.received_qty)}
                    {item.pending_qty > 0 && (
                      <span className="block text-xs text-amber-600">{item.pending_qty} pending</span>
                    )}
                  </td>
                  <td className="td text-right tnum">{currency(item.ptr, 2)}</td>
                  <td className="td text-right tnum font-medium">{currency(item.effective_cost, 2)}</td>
                  <td className="td text-right tnum">{currency(item.line_total)}</td>
                  {receiving && (
                    <td className="td">
                      {item.pending_qty > 0 ? (
                        <div className="flex flex-col gap-1.5">
                          <input
                            type="number"
                            min={0}
                            max={item.pending_qty}
                            aria-label={`Received quantity for ${item.product_name}`}
                            className="input w-24 py-1 text-right"
                            value={lines[item.id]?.qty ?? 0}
                            onChange={(e) =>
                              setLines((s) => ({
                                ...s,
                                [item.id]: {
                                  ...s[item.id],
                                  qty: Math.min(item.pending_qty, Math.max(0, Number(e.target.value) || 0)),
                                },
                              }))
                            }
                          />
                          <input
                            type="text"
                            aria-label={`Batch number for ${item.product_name}`}
                            placeholder="Batch no."
                            className="input w-32 py-1"
                            value={lines[item.id]?.batch ?? ''}
                            onChange={(e) =>
                              setLines((s) => ({ ...s, [item.id]: { ...s[item.id], batch: e.target.value } }))
                            }
                          />
                          <input
                            type="date"
                            aria-label={`Expiry date for ${item.product_name}`}
                            className="input w-36 py-1"
                            value={lines[item.id]?.expiry ?? ''}
                            onChange={(e) =>
                              setLines((s) => ({ ...s, [item.id]: { ...s[item.id], expiry: e.target.value } }))
                            }
                          />
                        </div>
                      ) : (
                        <span className="text-xs text-emerald-600">complete</span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {receiving && (
          <div className="flex flex-wrap items-end gap-3 border-t border-slate-100 bg-slate-50/60 p-4">
            <div className="w-56">
              <label className="label" htmlFor="invoice">
                Supplier invoice number
              </label>
              <input
                id="invoice"
                className="input"
                placeholder="e.g. INV/2608/4471"
                value={invoiceNumber}
                onChange={(e) => setInvoiceNumber(e.target.value)}
              />
            </div>
            <button type="button" className="btn-primary" onClick={submitReceipt} disabled={busy}>
              <PackageCheck className="h-4 w-4" aria-hidden />
              {busy ? 'Booking…' : 'Confirm goods receipt'}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setReceiving(false)} disabled={busy}>
              Cancel
            </button>
            <p className="w-full text-xs leading-relaxed text-slate-500">
              Confirming creates a batch per line, moves stock in, records the inventory movement,
              and raises a supplier invoice against{' '}
              <strong>{data.distributor_name}</strong> on {data.payment_terms ?? 'the agreed terms'}.
              Free units under the scheme are added at zero cost, which is what makes the batch cost
              — and therefore your gross margin — reflect the scheme correctly.
            </p>
          </div>
        )}
      </Card>
    </>
  );
}
