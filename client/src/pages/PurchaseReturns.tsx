import { useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, PackageX, Undo2 } from 'lucide-react';
import { useApi, useDebounced } from '../hooks/useApi';
import { Card, EmptyState, KpiCard, PageHeader, Pill } from '../components/ui';
import { DataTable, Pagination, SearchInput, Select, type Column } from '../components/DataTable';
import { currency, currencyCompact, date, number } from '../utils/format';
import { api, ApiError } from '../services/api';

/**
 * PURCHASE RETURNS
 * ================
 *
 * Sending stock back up the chain for credit — expired, damaged, wrongly
 * supplied or over-supplied goods.
 *
 * Unlike a sales return there is no restock option: the goods are physically
 * leaving the pharmacy, so stock always decreases. Credit is valued at what was
 * actually paid for those units (the batch cost, which already reflects any
 * free-goods scheme), not at the current list rate.
 */

const REASONS = [
  { value: 'EXPIRED', label: 'Expired' },
  { value: 'DAMAGED', label: 'Damaged in transit or storage' },
  { value: 'WRONG_ITEM', label: 'Wrong item supplied' },
  { value: 'EXCESS', label: 'Over-supplied' },
  { value: 'OTHER', label: 'Other' },
];

const REASON_TONE: Record<string, string> = {
  EXPIRED: 'rose',
  DAMAGED: 'rose',
  WRONG_ITEM: 'amber',
  EXCESS: 'slate',
  OTHER: 'slate',
};

const STATUS_TONE: Record<string, string> = {
  RAISED: 'amber',
  CREDITED: 'emerald',
  REJECTED: 'slate',
};

interface ReturnableBatch {
  batch_id: number;
  batch_number: string;
  expiry_date: string;
  quantity: number;
  purchase_price: number;
  purchase_invoice: string | null;
  product_id: number;
  product_name: string;
  product_code: string;
  pack_size: string | null;
  supplier_name: string | null;
  days_to_expiry: number;
}

interface ReturnRow {
  id: number;
  return_number: string;
  return_date: string;
  distributor_name: string | null;
  reason: string;
  credit_amount: number;
  status: string;
  units: number;
  line_count: number;
  notes: string | null;
}

export default function PurchaseReturns() {
  const [search, setSearch] = useState('');
  const [expiredOnly, setExpiredOnly] = useState(true);
  const [selected, setSelected] = useState<Record<number, number>>({});
  const [reason, setReason] = useState('EXPIRED');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [historyPage, setHistoryPage] = useState(1);
  const debounced = useDebounced(search);

  const { data: batches, loading, reload: reloadBatches } = useApi<{ data: ReturnableBatch[] }>(
    '/procurement/returnable-batches',
    { search: debounced || undefined, expiredOnly: expiredOnly || undefined },
  );

  const { data: history, reload: reloadHistory } = useApi<{
    data: ReturnRow[];
    page: number;
    totalPages: number;
    total: number;
    summary: { returns: number; units: number; creditRaised: number; creditPending: number };
  }>('/procurement/purchase-returns', { page: historyPage, pageSize: 15 });

  const rows = batches?.data ?? [];

  const creditEstimate = useMemo(
    () =>
      Object.entries(selected).reduce((sum, [batchId, qty]) => {
        const batch = rows.find((b) => b.batch_id === Number(batchId));
        return sum + (batch ? batch.purchase_price * qty : 0);
      }, 0),
    [selected, rows],
  );

  const selectedCount = Object.values(selected).filter((q) => q > 0).length;

  async function submit() {
    setBusy(true);
    setMessage(null);
    try {
      const created = await api.post<{ return_number: string; credit_amount: number }>(
        '/procurement/purchase-returns',
        {
          reason,
          notes: notes.trim() || null,
          items: Object.entries(selected)
            .filter(([, qty]) => qty > 0)
            .map(([batchId, qty]) => ({ batch_id: Number(batchId), quantity: qty })),
        },
      );
      setMessage({
        tone: 'ok',
        text: `Return ${created.return_number} raised for ${currency(created.credit_amount)} credit. Stock has been removed and the movement recorded.`,
      });
      setSelected({});
      setNotes('');
      reloadBatches();
      reloadHistory();
    } catch (err) {
      setMessage({ tone: 'error', text: err instanceof ApiError ? err.message : 'The return could not be raised.' });
    } finally {
      setBusy(false);
    }
  }

  async function settle(row: ReturnRow, status: 'CREDITED' | 'REJECTED') {
    setBusy(true);
    setMessage(null);
    try {
      await api.patch(`/procurement/purchase-returns/${row.id}/status`, { status });
      reloadHistory();
    } catch (err) {
      setMessage({ tone: 'error', text: err instanceof ApiError ? err.message : 'Could not update the return.' });
    } finally {
      setBusy(false);
    }
  }

  const batchColumns: Column<ReturnableBatch>[] = [
    {
      key: 'product',
      header: 'Product',
      render: (r) => (
        <div className="max-w-[240px]">
          <span className="block truncate font-medium text-slate-800">{r.product_name}</span>
          <span className="text-xs text-slate-500">
            {r.pack_size ?? r.product_code}
            {r.supplier_name ? ` · ${r.supplier_name}` : ''}
          </span>
        </div>
      ),
    },
    { key: 'batch', header: 'Batch', render: (r) => <span className="font-mono text-xs">{r.batch_number}</span> },
    {
      key: 'expiry',
      header: 'Expiry',
      render: (r) => (
        <span className={r.days_to_expiry < 0 ? 'font-medium text-rose-600' : r.days_to_expiry <= 90 ? 'text-amber-700' : ''}>
          {date(r.expiry_date)}
          <span className="block text-[11px] text-slate-400">
            {r.days_to_expiry < 0 ? `${Math.abs(r.days_to_expiry)} days ago` : `${r.days_to_expiry} days left`}
          </span>
        </span>
      ),
    },
    { key: 'invoice', header: 'Purchase invoice', secondary: true, render: (r) => r.purchase_invoice ?? '—' },
    { key: 'stock', header: 'On hand', align: 'right', render: (r) => number(r.quantity) },
    { key: 'cost', header: 'Batch cost', align: 'right', render: (r) => currency(r.purchase_price, 2) },
    {
      key: 'return',
      header: 'Return qty',
      align: 'right',
      render: (r) => (
        <input
          type="number"
          min={0}
          max={r.quantity}
          aria-label={`Quantity to return for ${r.product_name} batch ${r.batch_number}`}
          className="input w-20 py-1 text-right"
          value={selected[r.batch_id] ?? 0}
          onChange={(e) =>
            setSelected((s) => ({
              ...s,
              [r.batch_id]: Math.min(r.quantity, Math.max(0, Number(e.target.value) || 0)),
            }))
          }
        />
      ),
    },
    {
      key: 'credit',
      header: 'Credit',
      align: 'right',
      render: (r) => {
        const qty = selected[r.batch_id] ?? 0;
        return qty > 0 ? <span className="font-medium tnum">{currency(r.purchase_price * qty)}</span> : '—';
      },
    },
  ];

  const historyColumns: Column<ReturnRow>[] = [
    { key: 'number', header: 'Return', render: (r) => <span className="font-mono text-xs">{r.return_number}</span> },
    { key: 'date', header: 'Date', render: (r) => date(r.return_date) },
    { key: 'distributor', header: 'Distributor', render: (r) => r.distributor_name ?? '—' },
    { key: 'reason', header: 'Reason', render: (r) => <Pill tone={REASON_TONE[r.reason] ?? 'slate'}>{r.reason.replace('_', ' ').toLowerCase()}</Pill> },
    { key: 'lines', header: 'Lines', align: 'right', secondary: true, render: (r) => number(r.line_count) },
    { key: 'units', header: 'Units', align: 'right', render: (r) => number(r.units) },
    { key: 'credit', header: 'Credit', align: 'right', render: (r) => currency(r.credit_amount) },
    { key: 'status', header: 'Status', render: (r) => <Pill tone={STATUS_TONE[r.status] ?? 'slate'}>{r.status.toLowerCase()}</Pill> },
    {
      key: 'action',
      header: '',
      align: 'right',
      render: (r) =>
        r.status === 'RAISED' ? (
          <div className="flex justify-end gap-1">
            <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => settle(r, 'CREDITED')} disabled={busy}>
              Credited
            </button>
            <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => settle(r, 'REJECTED')} disabled={busy}>
              Rejected
            </button>
          </div>
        ) : null,
    },
  ];

  const s = history?.summary;

  return (
    <>
      <PageHeader
        title="Purchase Returns"
        subtitle="Send stock back to a distributor for credit — expired, damaged, wrong or excess"
      />

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
        <KpiCard label="Returns raised" value={number(s?.returns ?? 0)} icon={Undo2} />
        <KpiCard label="Units returned" value={number(s?.units ?? 0)} icon={PackageX} />
        <KpiCard label="Credit raised" value={currencyCompact(s?.creditRaised ?? 0)} sub="lifetime" icon={CheckCircle2} />
        <KpiCard
          label="Credit pending"
          value={currencyCompact(s?.creditPending ?? 0)}
          sub="not yet confirmed"
          icon={AlertCircle}
          tone={(s?.creditPending ?? 0) > 0 ? 'warning' : 'default'}
        />
      </div>

      <Card
        className="mb-5"
        title="Raise a return"
        subtitle="Choose batches with stock on hand, set the quantity, give a reason"
        bodyClassName="p-0"
      >
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-4">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search product, batch or supplier…"
            className="min-w-[240px] flex-1"
          />
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              className="rounded border-slate-300"
              checked={expiredOnly}
              onChange={(e) => setExpiredOnly(e.target.checked)}
            />
            Expired batches only
          </label>
        </div>

        {rows.length === 0 && !loading ? (
          <EmptyState
            title={expiredOnly ? 'No expired batches with stock' : 'No batches match'}
            icon={PackageX}
            message={
              expiredOnly
                ? 'Nothing has expired while still holding stock. Untick the filter to return non-expired goods.'
                : 'Try a different search term.'
            }
          />
        ) : (
          <DataTable
            columns={batchColumns}
            rows={rows}
            rowKey={(row) => row.batch_id}
            loading={loading}
            emptyTitle="No batches available"
          />
        )}

        <div className="flex flex-wrap items-end gap-4 border-t border-slate-100 bg-slate-50/60 p-4">
          <div className="w-56">
            <label className="label" htmlFor="pr-reason">
              Reason
            </label>
            <Select value={reason} onChange={setReason} options={REASONS} label="Reason" />
          </div>
          <div className="min-w-[220px] flex-1">
            <label className="label" htmlFor="pr-notes">
              Notes
            </label>
            <input
              id="pr-notes"
              className="input"
              placeholder="Optional — e.g. debit note reference"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          <div className="text-right">
            <p className="text-xs uppercase tracking-wide text-slate-500">Estimated credit</p>
            <p className="text-lg font-semibold tnum text-slate-900">{currency(creditEstimate)}</p>
          </div>
          <button type="button" className="btn-primary" onClick={submit} disabled={busy || selectedCount === 0}>
            <Undo2 className="h-4 w-4" aria-hidden />
            {busy ? 'Raising…' : `Raise return for ${selectedCount} batch(es)`}
          </button>
          <p className="w-full text-xs leading-relaxed text-slate-500">
            Stock is removed immediately and an inventory movement is recorded against each batch.
            Credit is valued at the <strong>batch cost</strong> — what the pharmacy actually paid,
            after any free-goods scheme — rather than the current list rate.
          </p>
        </div>
      </Card>

      <Card title="Return history" bodyClassName="p-0">
        <DataTable
          columns={historyColumns}
          rows={history?.data ?? []}
          rowKey={(row) => row.id}
          emptyTitle="No purchase returns yet"
          emptyMessage="Returns raised here will appear in this list."
        />
        {history && (
          <Pagination page={history.page} totalPages={history.totalPages} total={history.total} onChange={setHistoryPage} />
        )}
      </Card>

      <p className="mt-4 text-xs leading-relaxed text-slate-400">
        A purchase return always reduces stock — the goods are leaving the pharmacy, so there is no
        restock option. Marking a return <strong>Credited</strong> or <strong>Rejected</strong>{' '}
        records the distributor's response; it does not move stock again, because the stock already
        left when the return was raised.
      </p>
    </>
  );
}
