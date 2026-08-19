import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, Banknote, CheckCircle2, Clock, IndianRupee } from 'lucide-react';
import { useApi, useDebounced } from '../hooks/useApi';
import { Card, KpiCard, PageHeader, Pill } from '../components/ui';
import { DataTable, Pagination, SearchInput, type Column } from '../components/DataTable';
import { currency, currencyCompact, date, number } from '../utils/format';
import { api, ApiError } from '../services/api';

/**
 * OUTSTANDING
 * ===========
 *
 * Credit in both directions — payable to distributors, receivable from
 * customers — with standard receivables ageing (current / 1-30 / 31-60 / 60+).
 *
 * A pharmacy can be profitable on paper and still fail on cash timing, which is
 * why this sits alongside the profit screens rather than buried in a report.
 */

const BUCKET_TONE: Record<string, string> = {
  CURRENT: 'emerald',
  D1_30: 'amber',
  D31_60: 'amber',
  D60_PLUS: 'rose',
};

const BUCKET_LABEL: Record<string, string> = {
  CURRENT: 'Not due',
  D1_30: '1-30 days',
  D31_60: '31-60 days',
  D60_PLUS: '60+ days',
};

interface AgeingSummary {
  totalOutstanding: number;
  overdue: number;
  current: number;
  d1_30: number;
  d31_60: number;
  d60_plus: number;
  openInvoices?: number;
  invoices: number;
}

function AgeingBar({ summary }: { summary: AgeingSummary }) {
  const buckets = [
    { label: 'Not due', value: summary.current, color: 'bg-emerald-500' },
    { label: '1-30 days', value: summary.d1_30, color: 'bg-amber-400' },
    { label: '31-60 days', value: summary.d31_60, color: 'bg-orange-500' },
    { label: '60+ days', value: summary.d60_plus, color: 'bg-rose-500' },
  ];
  const total = buckets.reduce((s, b) => s + b.value, 0);
  if (total === 0) return null;

  return (
    <div>
      <div className="flex h-2.5 overflow-hidden rounded-full bg-slate-100">
        {buckets.map((bucket) => (
          <div
            key={bucket.label}
            className={bucket.color}
            style={{ width: `${(bucket.value / total) * 100}%` }}
            title={`${bucket.label}: ${currency(bucket.value)}`}
          />
        ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
        {buckets.map((bucket) => (
          <li key={bucket.label} className="flex items-center gap-1.5 text-xs">
            <span className={`h-2 w-2 rounded-full ${bucket.color}`} aria-hidden />
            <span className="text-slate-500">{bucket.label}</span>
            <span className="font-medium tnum text-slate-800">{currency(bucket.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Supplier outstanding                                                        */
/* -------------------------------------------------------------------------- */

interface SupplierInvoice {
  id: number;
  invoice_number: string;
  distributor_id: number;
  distributor_name: string;
  po_number: string | null;
  invoice_date: string;
  due_date: string;
  invoice_amount: number;
  paid_amount: number;
  outstanding: number;
  status: string;
  days_overdue: number;
  age_bucket: string;
}

export function SupplierOutstanding() {
  const [search, setSearch] = useState('');
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [paying, setPaying] = useState<SupplierInvoice | null>(null);
  const [amount, setAmount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const debounced = useDebounced(search);

  const { data, error, loading, reload } = useApi<{
    data: SupplierInvoice[];
    page: number;
    totalPages: number;
    total: number;
    summary: AgeingSummary;
  }>('/procurement/supplier-invoices', {
    search: debounced || undefined,
    overdueOnly: overdueOnly || undefined,
    page,
    pageSize: 25,
  });

  async function pay() {
    if (!paying) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.post<{ paymentNumber: string }>('/procurement/supplier-payments', {
        distributor_id: paying.distributor_id,
        invoice_id: paying.id,
        amount,
      });
      setMessage({ tone: 'ok', text: `Payment ${result.paymentNumber} recorded against ${paying.invoice_number}.` });
      setPaying(null);
      reload();
    } catch (err) {
      setMessage({ tone: 'error', text: err instanceof ApiError ? err.message : 'Payment failed.' });
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<SupplierInvoice>[] = [
    { key: 'invoice', header: 'Invoice', render: (r) => <span className="font-mono text-xs">{r.invoice_number}</span> },
    {
      key: 'distributor',
      header: 'Distributor',
      render: (r) => (
        <Link to={`/procurement/distributors/${r.distributor_id}`} className="font-medium text-slate-800 hover:text-brand-700">
          {r.distributor_name}
        </Link>
      ),
    },
    { key: 'po', header: 'Order', secondary: true, render: (r) => r.po_number ?? '—' },
    { key: 'date', header: 'Invoice date', secondary: true, render: (r) => date(r.invoice_date) },
    { key: 'due', header: 'Due', render: (r) => date(r.due_date) },
    { key: 'amount', header: 'Amount', align: 'right', render: (r) => currency(r.invoice_amount) },
    { key: 'paid', header: 'Paid', align: 'right', secondary: true, render: (r) => currency(r.paid_amount) },
    {
      key: 'outstanding',
      header: 'Outstanding',
      align: 'right',
      render: (r) => <span className="font-semibold tnum">{currency(r.outstanding)}</span>,
    },
    {
      key: 'age',
      header: 'Ageing',
      render: (r) => (
        <Pill tone={BUCKET_TONE[r.age_bucket]}>
          {r.days_overdue > 0 ? `${r.days_overdue}d late` : BUCKET_LABEL[r.age_bucket]}
        </Pill>
      ),
    },
    {
      key: 'action',
      header: '',
      align: 'right',
      render: (r) =>
        r.outstanding > 0 ? (
          <button
            type="button"
            className="btn-secondary px-2 py-1 text-xs"
            onClick={() => {
              setPaying(r);
              setAmount(r.outstanding);
              setMessage(null);
            }}
          >
            Pay
          </button>
        ) : (
          <CheckCircle2 className="ml-auto h-4 w-4 text-emerald-500" aria-hidden />
        ),
    },
  ];

  const s = data?.summary;

  return (
    <>
      <PageHeader title="Supplier Outstanding" subtitle="What the pharmacy owes its distributors, aged" />

      {message && (
        <div className={`card mb-4 border-l-4 p-4 ${message.tone === 'ok' ? 'border-l-emerald-500' : 'border-l-rose-500'}`}>
          <div className="flex items-start gap-2.5 text-sm text-slate-700">
            {message.tone === 'ok' ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
            ) : (
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" aria-hidden />
            )}
            {message.text}
          </div>
        </div>
      )}

      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Total payable" value={currencyCompact(s?.totalOutstanding ?? 0)} sub={`${number(s?.openInvoices ?? 0)} open invoices`} icon={IndianRupee} />
        <KpiCard label="Overdue" value={currencyCompact(s?.overdue ?? 0)} sub="past due date" icon={Clock} tone={(s?.overdue ?? 0) > 0 ? 'danger' : 'default'} />
        <KpiCard label="Not yet due" value={currencyCompact(s?.current ?? 0)} icon={CheckCircle2} tone="success" />
        <KpiCard label="Over 60 days" value={currencyCompact(s?.d60_plus ?? 0)} sub="credit terms at risk" icon={AlertCircle} tone={(s?.d60_plus ?? 0) > 0 ? 'danger' : 'default'} />
      </div>

      {s && (
        <Card className="mb-4" title="Ageing profile" bodyClassName="p-4">
          <AgeingBar summary={s} />
        </Card>
      )}

      {paying && (
        <Card className="mb-4" title={`Record payment — ${paying.invoice_number}`} bodyClassName="p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-40">
              <label className="label" htmlFor="pay-amount">Amount</label>
              <input
                id="pay-amount"
                type="number"
                min={0}
                max={paying.outstanding}
                className="input"
                value={amount}
                onChange={(e) => setAmount(Math.min(paying.outstanding, Math.max(0, Number(e.target.value) || 0)))}
              />
            </div>
            <button type="button" className="btn-primary" onClick={pay} disabled={busy || amount <= 0}>
              <Banknote className="h-4 w-4" aria-hidden />
              {busy ? 'Recording…' : `Pay ${currency(amount)}`}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setPaying(null)} disabled={busy}>
              Cancel
            </button>
            <p className="w-full text-xs text-slate-500">
              Outstanding on this invoice is {currency(paying.outstanding)} to {paying.distributor_name}.
              A partial payment leaves the invoice PARTIAL; paying in full closes it.
            </p>
          </div>
        </Card>
      )}

      <Card bodyClassName="p-0">
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-4">
          <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search invoice, distributor or order…" className="min-w-[240px] flex-1" />
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" className="rounded border-slate-300" checked={overdueOnly} onChange={(e) => { setOverdueOnly(e.target.checked); setPage(1); }} />
            Overdue only
          </label>
        </div>
        <DataTable columns={columns} rows={data?.data ?? []} rowKey={(r) => r.id} loading={loading} error={error} onRetry={reload} emptyTitle="Nothing outstanding" emptyMessage="Every supplier invoice is settled." />
        {data && <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onChange={setPage} />}
      </Card>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Customer outstanding                                                        */
/* -------------------------------------------------------------------------- */

interface CustomerDue {
  sale_id: number;
  invoice_number: string;
  customer_id: number;
  customer_name: string;
  phone: string | null;
  sale_date: string;
  due_date: string | null;
  total: number;
  paid_amount: number;
  outstanding: number;
  days_overdue: number;
  age_bucket: string;
}

export function CustomerOutstanding() {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [collecting, setCollecting] = useState<CustomerDue | null>(null);
  const [amount, setAmount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const debounced = useDebounced(search);

  const { data, error, loading, reload } = useApi<{
    data: CustomerDue[];
    page: number;
    totalPages: number;
    total: number;
    summary: AgeingSummary;
  }>('/procurement/customer-dues', { search: debounced || undefined, page, pageSize: 25 });

  async function collect() {
    if (!collecting) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.post<{ paymentNumber: string }>('/procurement/customer-payments', {
        customer_id: collecting.customer_id,
        sale_id: collecting.sale_id,
        amount,
      });
      setMessage({ tone: 'ok', text: `Receipt ${result.paymentNumber} recorded against ${collecting.invoice_number}.` });
      setCollecting(null);
      reload();
    } catch (err) {
      setMessage({ tone: 'error', text: err instanceof ApiError ? err.message : 'Could not record the receipt.' });
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<CustomerDue>[] = [
    { key: 'invoice', header: 'Invoice', render: (r) => <span className="font-mono text-xs">{r.invoice_number}</span> },
    { key: 'customer', header: 'Customer', render: (r) => <span className="font-medium text-slate-800">{r.customer_name}</span> },
    { key: 'phone', header: 'Phone', secondary: true, render: (r) => r.phone ?? '—' },
    { key: 'date', header: 'Sale date', secondary: true, render: (r) => date(r.sale_date) },
    { key: 'due', header: 'Due', render: (r) => (r.due_date ? date(r.due_date) : '—') },
    { key: 'total', header: 'Bill', align: 'right', render: (r) => currency(r.total) },
    { key: 'paid', header: 'Paid', align: 'right', secondary: true, render: (r) => currency(r.paid_amount) },
    { key: 'outstanding', header: 'Outstanding', align: 'right', render: (r) => <span className="font-semibold tnum">{currency(r.outstanding)}</span> },
    {
      key: 'age',
      header: 'Ageing',
      render: (r) => (
        <Pill tone={BUCKET_TONE[r.age_bucket]}>
          {r.days_overdue > 0 ? `${r.days_overdue}d late` : BUCKET_LABEL[r.age_bucket]}
        </Pill>
      ),
    },
    {
      key: 'action',
      header: '',
      align: 'right',
      render: (r) => (
        <button
          type="button"
          className="btn-secondary px-2 py-1 text-xs"
          onClick={() => {
            setCollecting(r);
            setAmount(r.outstanding);
            setMessage(null);
          }}
        >
          Collect
        </button>
      ),
    },
  ];

  const s = data?.summary;

  return (
    <>
      <PageHeader title="Customer Outstanding" subtitle="Credit extended to customers, aged" />

      {message && (
        <div className={`card mb-4 border-l-4 p-4 ${message.tone === 'ok' ? 'border-l-emerald-500' : 'border-l-rose-500'}`}>
          <p className="text-sm text-slate-700">{message.text}</p>
        </div>
      )}

      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Total receivable" value={currencyCompact(s?.totalOutstanding ?? 0)} sub={`${number(s?.invoices ?? 0)} open bills`} icon={IndianRupee} />
        <KpiCard label="Overdue" value={currencyCompact(s?.overdue ?? 0)} icon={Clock} tone={(s?.overdue ?? 0) > 0 ? 'warning' : 'default'} />
        <KpiCard label="Not yet due" value={currencyCompact(s?.current ?? 0)} icon={CheckCircle2} tone="success" />
        <KpiCard label="Over 60 days" value={currencyCompact(s?.d60_plus ?? 0)} sub="unlikely to collect" icon={AlertCircle} tone={(s?.d60_plus ?? 0) > 0 ? 'danger' : 'default'} />
      </div>

      {s && (
        <Card className="mb-4" title="Ageing profile" bodyClassName="p-4">
          <AgeingBar summary={s} />
        </Card>
      )}

      {collecting && (
        <Card className="mb-4" title={`Collect payment — ${collecting.invoice_number}`} bodyClassName="p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-40">
              <label className="label" htmlFor="collect-amount">Amount</label>
              <input
                id="collect-amount"
                type="number"
                min={0}
                max={collecting.outstanding}
                className="input"
                value={amount}
                onChange={(e) => setAmount(Math.min(collecting.outstanding, Math.max(0, Number(e.target.value) || 0)))}
              />
            </div>
            <button type="button" className="btn-primary" onClick={collect} disabled={busy || amount <= 0}>
              <Banknote className="h-4 w-4" aria-hidden />
              {busy ? 'Recording…' : `Collect ${currency(amount)}`}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setCollecting(null)} disabled={busy}>
              Cancel
            </button>
          </div>
        </Card>
      )}

      <Card bodyClassName="p-0">
        <div className="border-b border-slate-100 p-4">
          <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search customer, invoice or phone…" />
        </div>
        <DataTable columns={columns} rows={data?.data ?? []} rowKey={(r) => r.sale_id} loading={loading} error={error} onRetry={reload} emptyTitle="Nothing outstanding" emptyMessage="No customer has an unsettled bill." />
        {data && <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onChange={setPage} />}
      </Card>
    </>
  );
}
