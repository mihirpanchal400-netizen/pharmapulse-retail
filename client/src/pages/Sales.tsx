import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  IndianRupee,
  Printer,
  Receipt,
  RotateCcw,
  ShieldAlert,
  TrendingUp,
  Users,
} from 'lucide-react';
import { useApi, useDebounced } from '../hooks/useApi';
import { Card, ErrorState, KpiCard, LoadingBlock, PageHeader, Pill } from '../components/ui';
import { DataTable, Pagination, SearchInput, Select, type Column } from '../components/DataTable';
import { currency, currencyCompact, date, dateTime, number, percent } from '../utils/format';

/**
 * SALES HISTORY AND INVOICE
 * =========================
 *
 * The sales register a pharmacy is expected to be able to produce on demand,
 * plus a printable invoice showing exactly which batch each unit came from.
 * Batch traceability on the bill is what makes a recall or a return workable.
 */

const STATUS_TONE: Record<string, string> = {
  COMPLETED: 'emerald',
  PARTIALLY_RETURNED: 'amber',
  RETURNED: 'rose',
  CANCELLED: 'slate',
};

const PAYMENT_TONE: Record<string, string> = {
  CASH: 'slate',
  UPI: 'brand',
  CARD: 'brand',
  CREDIT: 'amber',
  OTHER: 'slate',
};

interface SaleRow {
  id: number;
  invoice_number: string;
  sale_date: string;
  customer_name: string | null;
  customer_phone: string | null;
  cashier: string | null;
  item_count: number;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  cogs: number;
  paid_amount: number;
  payment_method: string;
  status: string;
}

interface SalesResponse {
  data: SaleRow[];
  page: number;
  totalPages: number;
  total: number;
  summary: { transactions: number; revenue: number; grossProfit: number; averageBill: number };
}

export function SalesHistory() {
  const [search, setSearch] = useState('');
  const [payment, setPayment] = useState('ALL');
  const [status, setStatus] = useState('ALL');
  const [page, setPage] = useState(1);
  const debounced = useDebounced(search);

  const { data, error, loading, reload } = useApi<SalesResponse>('/sales', {
    search: debounced || undefined,
    paymentMethod: payment === 'ALL' ? undefined : payment,
    status: status === 'ALL' ? undefined : status,
    page,
    pageSize: 25,
  });

  const columns: Column<SaleRow>[] = [
    {
      key: 'invoice',
      header: 'Invoice',
      render: (row) => (
        <Link to={`/sales/${row.id}`} className="font-mono text-xs font-medium text-brand-700 hover:text-brand-800">
          {row.invoice_number}
        </Link>
      ),
    },
    { key: 'date', header: 'Date', render: (r) => dateTime(r.sale_date) },
    {
      key: 'customer',
      header: 'Customer',
      render: (r) => (
        <div className="max-w-[180px]">
          <span className="block truncate">{r.customer_name ?? 'Walk-in'}</span>
          {r.customer_phone && <span className="text-xs text-slate-500">{r.customer_phone}</span>}
        </div>
      ),
    },
    { key: 'cashier', header: 'Billed by', secondary: true, render: (r) => r.cashier ?? '—' },
    { key: 'items', header: 'Lines', align: 'right', render: (r) => number(r.item_count) },
    { key: 'discount', header: 'Discount', align: 'right', secondary: true, render: (r) => currency(r.discount) },
    { key: 'tax', header: 'GST', align: 'right', secondary: true, render: (r) => currency(r.tax) },
    {
      key: 'total',
      header: 'Total',
      align: 'right',
      render: (r) => <span className="font-medium tnum">{currency(r.total)}</span>,
    },
    {
      key: 'payment',
      header: 'Payment',
      render: (r) => (
        <div>
          <Pill tone={PAYMENT_TONE[r.payment_method] ?? 'slate'}>{r.payment_method}</Pill>
          {r.total > r.paid_amount && (
            <span className="mt-0.5 block text-[11px] font-medium text-amber-600">
              {currency(r.total - r.paid_amount)} due
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => <Pill tone={STATUS_TONE[r.status] ?? 'slate'}>{r.status.replace('_', ' ').toLowerCase()}</Pill>,
    },
  ];

  const s = data?.summary;
  const margin = s && s.revenue > 0 ? (s.grossProfit / s.revenue) * 100 : 0;

  return (
    <>
      <PageHeader
        title="Sales History"
        subtitle="Every invoice raised at the counter"
        actions={
          <>
            <Link to="/sales/returns" className="btn-secondary">
              <RotateCcw className="h-4 w-4" aria-hidden />
              Returns
            </Link>
            <Link to="/sales/new" className="btn-primary">
              <Receipt className="h-4 w-4" aria-hidden />
              New sale
            </Link>
          </>
        }
      />

      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Transactions" value={number(s?.transactions ?? 0)} sub="matching your filters" icon={Receipt} />
        <KpiCard label="Revenue" value={currencyCompact(s?.revenue ?? 0)} sub="including GST" icon={IndianRupee} />
        <KpiCard label="Gross profit" value={currencyCompact(s?.grossProfit ?? 0)} sub={`${percent(margin)} margin`} icon={TrendingUp} />
        <KpiCard label="Average bill" value={currency(s?.averageBill ?? 0)} icon={Users} />
      </div>

      <Card bodyClassName="p-0">
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-4">
          <SearchInput
            value={search}
            onChange={(v) => {
              setSearch(v);
              setPage(1);
            }}
            placeholder="Search invoice number, customer or phone…"
            className="min-w-[240px] flex-1"
          />
          <Select
            value={payment}
            onChange={(v) => {
              setPayment(v);
              setPage(1);
            }}
            label="Payment method"
            className="w-auto"
            options={[
              { label: 'All payments', value: 'ALL' },
              { label: 'Cash', value: 'CASH' },
              { label: 'UPI', value: 'UPI' },
              { label: 'Card', value: 'CARD' },
              { label: 'Credit', value: 'CREDIT' },
              { label: 'Other', value: 'OTHER' },
            ]}
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
              { label: 'Completed', value: 'COMPLETED' },
              { label: 'Partially returned', value: 'PARTIALLY_RETURNED' },
              { label: 'Returned', value: 'RETURNED' },
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
          emptyTitle="No sales match"
          emptyMessage="Try a different search term, payment method or date range."
        />

        {data && <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onChange={setPage} />}
      </Card>

      <p className="mt-4 text-xs leading-relaxed text-slate-400">
        Revenue here is the invoice total <strong>including</strong> GST, because that is what the
        customer paid. Analytics screens report revenue net of tax and net of returns, which is why
        the two figures differ — both are correct for their purpose.
      </p>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Invoice                                                                     */
/* -------------------------------------------------------------------------- */

interface InvoiceItem {
  id: number;
  product_id: number;
  product_name: string;
  product_code: string;
  strength: string | null;
  pack_size: string | null;
  batch_number: string | null;
  expiry_date: string | null;
  quantity: number;
  returned_quantity: number;
  selling_price: number;
  discount: number;
  tax: number;
  tax_rate: number;
  line_total: number;
}

interface InvoicePayload {
  sale: {
    id: number;
    invoice_number: string;
    sale_date: string;
    subtotal: number;
    discount: number;
    tax: number;
    total: number;
    paid_amount: number;
    payment_method: string;
    status: string;
    notes: string | null;
    items: InvoiceItem[];
  };
  customer: { name: string; phone: string | null; customer_code: string } | null;
  cashier: { full_name: string; role: string } | null;
  pharmacy: {
    pharmacy_name: string;
    pharmacy_address: string;
    pharmacy_phone: string;
    pharmacy_tax_id: string;
  };
  returns: { return_number: string; return_date: string; reason: string; refund_amount: number }[];
}

export function InvoiceView() {
  const { id } = useParams();
  const { data, error, loading, reload } = useApi<InvoicePayload>(id ? `/sales/${id}/invoice` : null);

  if (error) {
    return (
      <>
        <PageHeader title="Invoice" />
        <Card>
          <ErrorState message={error} onRetry={reload} />
        </Card>
      </>
    );
  }

  if (!data || loading) {
    return (
      <>
        <PageHeader title="Invoice" />
        <Card>
          <LoadingBlock rows={8} />
        </Card>
      </>
    );
  }

  const { sale, customer, cashier, pharmacy, returns } = data;
  const balance = sale.total - sale.paid_amount;

  return (
    <>
      <PageHeader
        title={sale.invoice_number}
        subtitle={`${dateTime(sale.sale_date)}${cashier ? ` · billed by ${cashier.full_name}` : ''}`}
        actions={
          <>
            <Link to="/sales" className="btn-secondary">
              <ArrowLeft className="h-4 w-4" aria-hidden />
              All sales
            </Link>
            <Link to={`/sales/returns?invoice=${sale.invoice_number}`} className="btn-secondary">
              <RotateCcw className="h-4 w-4" aria-hidden />
              Process return
            </Link>
            <button type="button" className="btn-primary" onClick={() => window.print()}>
              <Printer className="h-4 w-4" aria-hidden />
              Print
            </button>
          </>
        }
      />

      <Card bodyClassName="p-0">
        {/* pharmacy header */}
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 p-5">
          <div>
            <h2 className="text-base font-semibold text-slate-900">{pharmacy.pharmacy_name}</h2>
            <p className="mt-0.5 text-xs leading-relaxed text-slate-500">
              {pharmacy.pharmacy_address}
              <br />
              {pharmacy.pharmacy_phone}
              {pharmacy.pharmacy_tax_id && ` · GSTIN ${pharmacy.pharmacy_tax_id}`}
            </p>
          </div>
          <div className="text-right">
            <p className="font-mono text-sm font-semibold text-slate-900">{sale.invoice_number}</p>
            <p className="text-xs text-slate-500">{dateTime(sale.sale_date)}</p>
            <div className="mt-1.5 flex justify-end gap-1.5">
              <Pill tone={PAYMENT_TONE[sale.payment_method] ?? 'slate'}>{sale.payment_method}</Pill>
              <Pill tone={STATUS_TONE[sale.status] ?? 'slate'}>{sale.status.replace('_', ' ').toLowerCase()}</Pill>
            </div>
          </div>
        </div>

        {/* customer */}
        <div className="border-b border-slate-100 px-5 py-3">
          <p className="text-xs uppercase tracking-wide text-slate-500">Billed to</p>
          <p className="mt-0.5 text-sm font-medium text-slate-800">
            {customer?.name ?? 'Walk-in customer'}
            {customer?.phone && <span className="ml-2 font-normal text-slate-500">{customer.phone}</span>}
          </p>
        </div>

        {/* lines */}
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-slate-50/70">
                <th className="th">Product</th>
                <th className="th">Batch</th>
                <th className="th">Expiry</th>
                <th className="th text-right">Qty</th>
                <th className="th text-right">Rate</th>
                <th className="th text-right">Discount</th>
                <th className="th text-right">GST</th>
                <th className="th text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {sale.items.map((item) => (
                <tr key={item.id} className="table-row">
                  <td className="td max-w-[240px]">
                    <Link
                      to={`/inventory/products/${item.product_id}`}
                      className="block truncate font-medium text-slate-800 hover:text-brand-700"
                    >
                      {item.product_name}
                    </Link>
                    <span className="text-xs text-slate-500">
                      {item.pack_size ?? item.product_code}
                      {item.returned_quantity > 0 && (
                        <span className="ml-1.5 font-medium text-rose-600">
                          {item.returned_quantity} returned
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="td font-mono text-xs">{item.batch_number ?? '—'}</td>
                  <td className="td text-xs">{item.expiry_date ? date(item.expiry_date) : '—'}</td>
                  <td className="td text-right tnum">{number(item.quantity)}</td>
                  <td className="td text-right tnum">{currency(item.selling_price, 2)}</td>
                  <td className="td text-right tnum">{item.discount > 0 ? currency(item.discount) : '—'}</td>
                  <td className="td text-right tnum">
                    {currency(item.tax)}
                    <span className="block text-[11px] text-slate-400">{percent(item.tax_rate, 0)}</span>
                  </td>
                  <td className="td text-right tnum font-medium">{currency(item.line_total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* totals */}
        <div className="flex justify-end border-t border-slate-100 bg-slate-50/60 p-5">
          <dl className="w-full max-w-xs space-y-1.5 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate-500">Subtotal</dt>
              <dd className="tnum">{currency(sale.subtotal)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Discount</dt>
              <dd className="tnum text-emerald-600">-{currency(sale.discount)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">GST</dt>
              <dd className="tnum">{currency(sale.tax)}</dd>
            </div>
            <div className="flex justify-between border-t border-slate-200 pt-1.5 text-base font-semibold">
              <dt>Total</dt>
              <dd className="tnum">{currency(sale.total)}</dd>
            </div>
            {balance > 0.005 && (
              <div className="flex justify-between text-amber-700">
                <dt>Balance due</dt>
                <dd className="tnum font-medium">{currency(balance)}</dd>
              </div>
            )}
          </dl>
        </div>

        {returns.length > 0 && (
          <div className="border-t border-slate-100 p-5">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
              Returns against this invoice
            </p>
            <ul className="space-y-1">
              {returns.map((r) => (
                <li key={r.return_number} className="flex justify-between text-sm text-slate-600">
                  <span>
                    <span className="font-mono text-xs">{r.return_number}</span> · {date(r.return_date)} ·{' '}
                    {r.reason.replace('_', ' ').toLowerCase()}
                  </span>
                  <span className="tnum font-medium">{currency(r.refund_amount)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      <p className="mt-4 text-xs leading-relaxed text-slate-400">
        Each line shows the exact batch dispensed. The original invoice is never rewritten — returns
        are recorded separately and increment a returned quantity, so this document stays
        historically accurate while analytics nets the returned units out of revenue.
      </p>
    </>
  );
}
