import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, IndianRupee, Phone, Plus, ShieldCheck, UserPlus, Users } from 'lucide-react';
import { useApi, useDebounced } from '../hooks/useApi';
import { Card, ErrorState, KpiCard, LoadingBlock, PageHeader, Pill } from '../components/ui';
import { DataTable, Pagination, SearchInput, Select, type Column } from '../components/DataTable';
import { currency, currencyCompact, date, dateTime, number } from '../utils/format';
import { api, ApiError } from '../services/api';

/**
 * CUSTOMERS
 * =========
 *
 * Deliberately minimal, and that is a design decision rather than an omission:
 * this system stores a name, a phone number and a customer type, and nothing
 * else. No diagnosis, no prescription, no medical history, no insurance data.
 * A retail pharmacy needs to know who to bill and who owes money — it does not
 * need a clinical record to do that.
 */

const TYPE_TONE: Record<string, string> = {
  WALK_IN: 'slate',
  REGULAR: 'brand',
  INSTITUTIONAL: 'emerald',
};

interface CustomerRow {
  id: number;
  customer_code: string;
  name: string;
  phone: string | null;
  customer_type: string;
  purchase_count: number;
  total_spent: number;
  last_visit: string | null;
  created_at: string;
}

export function CustomerList() {
  const [search, setSearch] = useState('');
  const [type, setType] = useState('ALL');
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', phone: '', customer_type: 'REGULAR' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const debounced = useDebounced(search);

  const { data, error, loading, reload } = useApi<{
    data: CustomerRow[];
    page: number;
    totalPages: number;
    total: number;
  }>('/customers', {
    search: debounced || undefined,
    type: type === 'ALL' ? undefined : type,
    page,
    pageSize: 25,
  });

  async function create() {
    setBusy(true);
    setMessage(null);
    try {
      await api.post('/customers', {
        name: form.name.trim(),
        phone: form.phone.trim() || null,
        customer_type: form.customer_type,
      });
      setMessage(`${form.name} added.`);
      setForm({ name: '', phone: '', customer_type: 'REGULAR' });
      setAdding(false);
      reload();
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Could not add the customer.');
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<CustomerRow>[] = [
    {
      key: 'name',
      header: 'Customer',
      render: (row) => (
        <div className="max-w-[220px]">
          <Link to={`/customers/${row.id}`} className="block truncate font-medium text-slate-800 hover:text-brand-700">
            {row.name}
          </Link>
          <span className="font-mono text-xs text-slate-500">{row.customer_code}</span>
        </div>
      ),
    },
    { key: 'phone', header: 'Phone', render: (r) => r.phone ?? '—' },
    {
      key: 'type',
      header: 'Type',
      render: (r) => <Pill tone={TYPE_TONE[r.customer_type] ?? 'slate'}>{r.customer_type.replace('_', ' ').toLowerCase()}</Pill>,
    },
    { key: 'visits', header: 'Bills', align: 'right', render: (r) => number(r.purchase_count) },
    { key: 'spent', header: 'Lifetime value', align: 'right', render: (r) => currency(r.total_spent) },
    {
      key: 'last',
      header: 'Last visit',
      render: (r) => (r.last_visit ? date(r.last_visit) : <span className="text-slate-400">never</span>),
    },
  ];

  const totals = (data?.data ?? []).reduce(
    (acc, c) => ({
      spend: acc.spend + c.total_spent,
      institutional: acc.institutional + (c.customer_type === 'INSTITUTIONAL' ? 1 : 0),
      active: acc.active + (c.purchase_count > 0 ? 1 : 0),
    }),
    { spend: 0, institutional: 0, active: 0 },
  );

  return (
    <>
      <PageHeader
        title="Customers"
        subtitle="Name, phone and type only — no medical information is stored"
        actions={
          <>
            <Link to="/customers/outstanding" className="btn-secondary">
              Outstanding
            </Link>
            <button type="button" className="btn-primary" onClick={() => setAdding((v) => !v)}>
              <UserPlus className="h-4 w-4" aria-hidden />
              Add customer
            </button>
          </>
        }
      />

      {message && <div className="card mb-4 p-3 text-sm text-slate-700">{message}</div>}

      {adding && (
        <Card className="mb-4" title="New customer" bodyClassName="p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[220px] flex-1">
              <label className="label" htmlFor="cust-name">Name</label>
              <input
                id="cust-name"
                className="input"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Full name or organisation"
              />
            </div>
            <div className="w-48">
              <label className="label" htmlFor="cust-phone">Phone</label>
              <input
                id="cust-phone"
                className="input"
                value={form.phone}
                onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                placeholder="+91 …"
              />
            </div>
            <div className="w-48">
              <label className="label" htmlFor="cust-type">Type</label>
              <select
                id="cust-type"
                className="input"
                value={form.customer_type}
                onChange={(e) => setForm((f) => ({ ...f, customer_type: e.target.value }))}
              >
                <option value="WALK_IN">Walk-in</option>
                <option value="REGULAR">Regular</option>
                <option value="INSTITUTIONAL">Institutional</option>
              </select>
            </div>
            <button type="button" className="btn-primary" onClick={create} disabled={busy || !form.name.trim()}>
              <Plus className="h-4 w-4" aria-hidden />
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setAdding(false)} disabled={busy}>
              Cancel
            </button>
          </div>
        </Card>
      )}

      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Customers" value={number(data?.total ?? 0)} sub="on this page's filters" icon={Users} />
        <KpiCard label="With purchases" value={number(totals.active)} sub="have bought at least once" icon={ShieldCheck} />
        <KpiCard label="Institutional" value={number(totals.institutional)} sub="clinics, care homes" icon={Users} />
        <KpiCard label="Page lifetime value" value={currencyCompact(totals.spend)} icon={IndianRupee} />
      </div>

      <Card bodyClassName="p-0">
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-4">
          <SearchInput
            value={search}
            onChange={(v) => { setSearch(v); setPage(1); }}
            placeholder="Search name, phone or code…"
            className="min-w-[240px] flex-1"
          />
          <Select
            value={type}
            onChange={(v) => { setType(v); setPage(1); }}
            label="Type"
            className="w-auto"
            options={[
              { label: 'All types', value: 'ALL' },
              { label: 'Walk-in', value: 'WALK_IN' },
              { label: 'Regular', value: 'REGULAR' },
              { label: 'Institutional', value: 'INSTITUTIONAL' },
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
          emptyTitle="No customers match"
        />

        {data && <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onChange={setPage} />}
      </Card>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Customer detail                                                             */
/* -------------------------------------------------------------------------- */

interface CustomerHistory {
  customer: CustomerRow;
  sales: {
    id: number;
    invoice_number: string;
    sale_date: string;
    total: number;
    paid_amount: number;
    payment_method: string;
    status: string;
    item_count?: number;
  }[];
  summary?: { purchases: number; totalSpent: number; averageBill: number };
}

export function CustomerDetail() {
  const { id } = useParams();
  const { data, error, loading, reload } = useApi<CustomerHistory>(id ? `/customers/${id}` : null);

  if (error) {
    return (
      <>
        <PageHeader title="Customer" />
        <Card><ErrorState message={error} onRetry={reload} /></Card>
      </>
    );
  }

  if (!data || loading) {
    return (
      <>
        <PageHeader title="Customer" />
        <Card><LoadingBlock rows={6} /></Card>
      </>
    );
  }

  const customer = data.customer;
  const sales = data.sales ?? [];
  const spent = sales.reduce((s, x) => s + x.total, 0);
  const owed = sales.reduce((s, x) => s + Math.max(0, x.total - x.paid_amount), 0);

  const columns: Column<CustomerHistory['sales'][number]>[] = [
    {
      key: 'invoice',
      header: 'Invoice',
      render: (r) => (
        <Link to={`/sales/${r.id}`} className="font-mono text-xs font-medium text-brand-700 hover:text-brand-800">
          {r.invoice_number}
        </Link>
      ),
    },
    { key: 'date', header: 'Date', render: (r) => dateTime(r.sale_date) },
    { key: 'payment', header: 'Payment', render: (r) => <Pill tone="slate">{r.payment_method}</Pill> },
    { key: 'total', header: 'Total', align: 'right', render: (r) => currency(r.total) },
    {
      key: 'balance',
      header: 'Balance',
      align: 'right',
      render: (r) => {
        const balance = r.total - r.paid_amount;
        return balance > 0.005 ? <span className="font-medium text-amber-700">{currency(balance)}</span> : '—';
      },
    },
    { key: 'status', header: 'Status', render: (r) => <Pill tone="slate">{r.status.replace('_', ' ').toLowerCase()}</Pill> },
  ];

  return (
    <>
      <PageHeader
        title={customer.name}
        subtitle={`${customer.customer_code}${customer.phone ? ` · ${customer.phone}` : ''} · ${customer.customer_type.replace('_', ' ').toLowerCase()}`}
        actions={
          <>
            <Link to="/customers" className="btn-secondary">
              <ArrowLeft className="h-4 w-4" aria-hidden />
              All customers
            </Link>
            {customer.phone && (
              <a href={`tel:${customer.phone.replace(/\s/g, '')}`} className="btn-secondary">
                <Phone className="h-4 w-4" aria-hidden />
                Call
              </a>
            )}
          </>
        }
      />

      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Bills" value={number(sales.length)} icon={Users} />
        <KpiCard label="Lifetime value" value={currency(spent)} icon={IndianRupee} />
        <KpiCard label="Average bill" value={currency(sales.length ? spent / sales.length : 0)} icon={IndianRupee} />
        <KpiCard
          label="Outstanding"
          value={currency(owed)}
          sub={owed > 0 ? 'unsettled credit' : 'all settled'}
          icon={ShieldCheck}
          tone={owed > 0 ? 'warning' : 'success'}
          to="/customers/outstanding"
        />
      </div>

      <Card title="Purchase history" bodyClassName="p-0">
        <DataTable
          columns={columns}
          rows={sales}
          rowKey={(row) => row.id}
          emptyTitle="No purchases yet"
          emptyMessage="This customer has not been billed."
        />
      </Card>

      <p className="mt-4 text-xs leading-relaxed text-slate-400">
        This record holds a name, phone number and customer type. No diagnosis, prescription,
        medical history or insurance information is stored anywhere in this system.
      </p>
    </>
  );
}
