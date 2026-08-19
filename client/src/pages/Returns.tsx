import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertCircle, CheckCircle2, RotateCcw, Search } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { Card, EmptyState, KpiCard, PageHeader, Pill } from '../components/ui';
import { DataTable, Pagination, type Column } from '../components/DataTable';
import { currency, date, dateTime, number } from '../utils/format';
import { api, ApiError } from '../services/api';

/**
 * SALES RETURNS
 * =============
 *
 * Find the invoice, choose the lines and quantities, give a reason, confirm.
 *
 * The original invoice is never rewritten. A return is a separate document that
 * increments `returned_quantity` on the sale line, so the printed bill stays
 * historically accurate while analytics nets the returned units out of revenue.
 *
 * Restocking is a decision, not an assumption: damaged goods go back to the
 * supplier or the bin, not onto the shelf.
 */

const REASONS = [
  { value: 'CUSTOMER_RETURN', label: 'Customer changed their mind', restock: true },
  { value: 'WRONG_ITEM', label: 'Wrong item dispensed', restock: true },
  { value: 'DAMAGED', label: 'Damaged or unsellable', restock: false },
  { value: 'OTHER', label: 'Other', restock: true },
];

interface InvoiceItem {
  id: number;
  product_id: number;
  product_name: string;
  pack_size: string | null;
  batch_number: string | null;
  expiry_date: string | null;
  quantity: number;
  returned_quantity: number;
  selling_price: number;
  line_total: number;
}

interface InvoicePayload {
  sale: {
    id: number;
    invoice_number: string;
    sale_date: string;
    total: number;
    status: string;
    items: InvoiceItem[];
  };
  customer: { name: string; phone: string | null } | null;
}

interface ReturnRow {
  id: number;
  return_number: string;
  return_date: string;
  invoice_number: string;
  customer_name: string | null;
  reason: string;
  refund_amount: number;
  units: number;
}

export default function Returns() {
  const [params] = useSearchParams();
  const [invoiceNumber, setInvoiceNumber] = useState(params.get('invoice') ?? '');
  const [invoice, setInvoice] = useState<InvoicePayload | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);

  const [quantities, setQuantities] = useState<Record<number, number>>({});
  const [reason, setReason] = useState(REASONS[0].value);
  const [restock, setRestock] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const { data: history, reload: reloadHistory } = useApi<{
    data: ReturnRow[];
    page: number;
    totalPages: number;
    total: number;
  }>('/returns', { pageSize: 15 });

  // Reason drives the restock default — damaged stock must not go back on the shelf.
  useEffect(() => {
    setRestock(REASONS.find((r) => r.value === reason)?.restock ?? true);
  }, [reason]);

  async function lookup(number_?: string) {
    const target = (number_ ?? invoiceNumber).trim();
    if (!target) return;
    setLooking(true);
    setLookupError(null);
    setResult(null);
    try {
      const payload = await api.get<InvoicePayload>(`/sales/by-invoice/${encodeURIComponent(target)}`);
      setInvoice(payload);
      setQuantities({});
    } catch (err) {
      setInvoice(null);
      setLookupError(err instanceof ApiError ? err.message : 'Could not find that invoice.');
    } finally {
      setLooking(false);
    }
  }

  // Deep link from an invoice page: look it up straight away.
  useEffect(() => {
    const preset = params.get('invoice');
    if (preset) void lookup(preset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedLines = Object.entries(quantities).filter(([, qty]) => qty > 0);
  const refundEstimate = invoice
    ? selectedLines.reduce((sum, [itemId, qty]) => {
        const item = invoice.sale.items.find((i) => i.id === Number(itemId));
        if (!item) return sum;
        // Pro-rated against the line total so any discount carries through.
        return sum + (item.line_total / item.quantity) * qty;
      }, 0)
    : 0;

  async function submit() {
    if (!invoice || selectedLines.length === 0) return;
    setBusy(true);
    setResult(null);
    try {
      const created = await api.post<{ return_number: string; refund_amount: number }>('/returns', {
        sale_id: invoice.sale.id,
        reason,
        restock,
        items: selectedLines.map(([itemId, qty]) => ({
          sale_item_id: Number(itemId),
          quantity: qty,
        })),
      });
      setResult({
        tone: 'ok',
        text: `Return ${created.return_number} recorded. ${currency(created.refund_amount)} refunded${
          restock ? ' and the units were returned to stock' : ' — the units were not restocked'
        }.`,
      });
      setQuantities({});
      await lookup(invoice.sale.invoice_number);
      reloadHistory();
    } catch (err) {
      setResult({ tone: 'error', text: err instanceof ApiError ? err.message : 'The return could not be processed.' });
    } finally {
      setBusy(false);
    }
  }

  const historyColumns: Column<ReturnRow>[] = [
    { key: 'number', header: 'Return', render: (r) => <span className="font-mono text-xs">{r.return_number}</span> },
    { key: 'date', header: 'Date', render: (r) => date(r.return_date) },
    {
      key: 'invoice',
      header: 'Against invoice',
      render: (r) => <span className="font-mono text-xs text-slate-600">{r.invoice_number}</span>,
    },
    { key: 'customer', header: 'Customer', secondary: true, render: (r) => r.customer_name ?? 'Walk-in' },
    { key: 'reason', header: 'Reason', render: (r) => <Pill tone={r.reason === 'DAMAGED' ? 'rose' : 'slate'}>{r.reason.replace('_', ' ').toLowerCase()}</Pill> },
    { key: 'units', header: 'Units', align: 'right', render: (r) => number(r.units) },
    { key: 'refund', header: 'Refund', align: 'right', render: (r) => currency(r.refund_amount) },
  ];

  return (
    <>
      <PageHeader title="Sales Returns" subtitle="Return against an existing invoice, with batch-level traceability" />

      {result && (
        <div className={`card mb-4 border-l-4 p-4 ${result.tone === 'ok' ? 'border-l-emerald-500' : 'border-l-rose-500'}`}>
          <div className="flex items-start gap-2.5">
            {result.tone === 'ok' ? (
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" aria-hidden />
            ) : (
              <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-rose-600" aria-hidden />
            )}
            <p className="text-sm text-slate-700">{result.text}</p>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------ lookup */}
      <Card className="mb-5" title="Find the invoice" bodyClassName="p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[260px] flex-1">
            <label className="label" htmlFor="invoice-number">
              Invoice number
            </label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
              <input
                id="invoice-number"
                className="input pl-9"
                placeholder="e.g. INV-2026-000148"
                value={invoiceNumber}
                onChange={(e) => setInvoiceNumber(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void lookup();
                  }
                }}
              />
            </div>
          </div>
          <button type="button" className="btn-primary" onClick={() => lookup()} disabled={looking || !invoiceNumber.trim()}>
            {looking ? 'Searching…' : 'Find invoice'}
          </button>
        </div>

        {lookupError && (
          <p className="mt-3 flex items-start gap-1.5 text-sm text-rose-700">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            {lookupError}
          </p>
        )}
      </Card>

      {/* ------------------------------------------------------------ return */}
      {invoice && (
        <Card
          className="mb-5"
          title={`Invoice ${invoice.sale.invoice_number}`}
          subtitle={`${dateTime(invoice.sale.sale_date)} · ${invoice.customer?.name ?? 'Walk-in customer'} · ${currency(invoice.sale.total)}`}
          bodyClassName="p-0"
        >
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-slate-50/70">
                  <th className="th">Product</th>
                  <th className="th">Batch</th>
                  <th className="th text-right">Sold</th>
                  <th className="th text-right">Already returned</th>
                  <th className="th text-right">Returnable</th>
                  <th className="th text-right">Return now</th>
                </tr>
              </thead>
              <tbody>
                {invoice.sale.items.map((item) => {
                  const returnable = item.quantity - item.returned_quantity;
                  return (
                    <tr key={item.id} className="table-row">
                      <td className="td max-w-[240px]">
                        <span className="block truncate font-medium text-slate-800">{item.product_name}</span>
                        <span className="text-xs text-slate-500">
                          {item.pack_size ?? ''} · {currency(item.selling_price, 2)} each
                        </span>
                      </td>
                      <td className="td font-mono text-xs">
                        {item.batch_number ?? '—'}
                        {item.expiry_date && (
                          <span className="block text-[11px] text-slate-400">exp {date(item.expiry_date)}</span>
                        )}
                      </td>
                      <td className="td text-right tnum">{number(item.quantity)}</td>
                      <td className="td text-right tnum">
                        {item.returned_quantity > 0 ? (
                          <span className="text-rose-600">{number(item.returned_quantity)}</span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="td text-right tnum font-medium">{number(returnable)}</td>
                      <td className="td text-right">
                        {returnable > 0 ? (
                          <input
                            type="number"
                            min={0}
                            max={returnable}
                            aria-label={`Quantity to return for ${item.product_name}`}
                            className="input w-20 py-1 text-right"
                            value={quantities[item.id] ?? 0}
                            onChange={(e) =>
                              setQuantities((s) => ({
                                ...s,
                                [item.id]: Math.min(returnable, Math.max(0, Number(e.target.value) || 0)),
                              }))
                            }
                          />
                        ) : (
                          <span className="text-xs text-slate-400">fully returned</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-end gap-4 border-t border-slate-100 bg-slate-50/60 p-4">
            <div className="min-w-[220px]">
              <label className="label" htmlFor="reason">
                Reason
              </label>
              <select id="reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)}>
                {REASONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>

            <label className="flex items-center gap-2 pb-2 text-sm text-slate-700">
              <input
                type="checkbox"
                className="rounded border-slate-300"
                checked={restock}
                onChange={(e) => setRestock(e.target.checked)}
              />
              Return units to stock
            </label>

            <div className="ml-auto text-right">
              <p className="text-xs uppercase tracking-wide text-slate-500">Estimated refund</p>
              <p className="text-lg font-semibold tnum text-slate-900">{currency(refundEstimate)}</p>
            </div>

            <button
              type="button"
              className="btn-primary"
              onClick={submit}
              disabled={busy || selectedLines.length === 0}
            >
              <RotateCcw className="h-4 w-4" aria-hidden />
              {busy ? 'Processing…' : `Confirm return of ${selectedLines.reduce((s, [, q]) => s + q, 0)} unit(s)`}
            </button>

            {!restock && (
              <p className="w-full text-xs leading-relaxed text-amber-700">
                These units will <strong>not</strong> go back on the shelf. The customer is refunded and
                the sale line is credited, but stock is not increased — which is the correct handling
                for damaged or unsellable goods.
              </p>
            )}
          </div>
        </Card>
      )}

      {!invoice && !lookupError && (
        <Card className="mb-5">
          <EmptyState
            title="Search for an invoice to begin"
            icon={RotateCcw}
            message="Enter the invoice number from the customer's bill, or arrive here from the invoice page with it already filled in."
          />
        </Card>
      )}

      {/* ----------------------------------------------------------- history */}
      <Card title="Recent returns" bodyClassName="p-0">
        <DataTable
          columns={historyColumns}
          rows={history?.data ?? []}
          rowKey={(row) => row.id}
          emptyTitle="No returns yet"
          emptyMessage="Returns processed here will appear in this list."
        />
        {history && (
          <Pagination page={history.page} totalPages={history.totalPages} total={history.total} onChange={() => {}} />
        )}
      </Card>

      <p className="mt-4 text-xs leading-relaxed text-slate-400">
        Restocked units go back to the <strong>original batch</strong>, preserving expiry
        traceability. Either way the sale line's returned quantity increases, so the unit stops
        counting as revenue in every analytic — while the printed invoice remains unchanged.
      </p>
    </>
  );
}
