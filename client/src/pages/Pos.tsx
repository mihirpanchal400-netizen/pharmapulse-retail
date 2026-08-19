import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Barcode as BarcodeIcon,
  Plus,
  Receipt,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import { useDebounced } from '../hooks/useApi';
import { Card, PageHeader, Pill } from '../components/ui';
import { currency, number } from '../utils/format';
import { api, ApiError } from '../services/api';

/**
 * POINT OF SALE
 * =============
 *
 * Counter billing. Products are found by name, generic, brand, code or barcode;
 * the batch is chosen automatically by FEFO on the server, so the earliest
 * expiring stock always leaves first and an expired batch can never be sold.
 *
 * The barcode field is a plain text input. A USB barcode scanner behaves as a
 * keyboard and types into it, so no driver, SDK or special hardware support is
 * needed — scanning simply fills the box and submits.
 */

interface ProductHit {
  id: number;
  product_code: string;
  product_name: string;
  generic_name: string | null;
  brand_name: string | null;
  pack_size: string | null;
  selling_price: number;
  mrp?: number;
  tax_rate: number;
  prescription_flag: number;
  current_stock?: number;
}

interface CartLine {
  product: ProductHit;
  quantity: number;
  discount: number;
}

interface BatchInfo {
  id: number;
  batch_number: string;
  expiry_date: string;
  quantity: number;
}

interface CompletedSale {
  id: number;
  invoice_number: string;
  total: number;
  subtotal: number;
  tax: number;
  discount: number;
  payment_method: string;
  items: { product_id: number; quantity: number; batch_id: number | null; line_total: number }[];
}

const PAYMENT_METHODS = ['CASH', 'UPI', 'CARD', 'CREDIT'] as const;

export default function Pos() {
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search, 200);
  const [hits, setHits] = useState<ProductHit[]>([]);
  const [lines, setLines] = useState<CartLine[]>([]);
  const [billDiscount, setBillDiscount] = useState(0);
  const [payment, setPayment] = useState<(typeof PAYMENT_METHODS)[number]>('CASH');
  const [customerId, setCustomerId] = useState<number | ''>('');
  const [customers, setCustomers] = useState<{ id: number; name: string; customer_type: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [completed, setCompleted] = useState<CompletedSale | null>(null);
  const [batchPreview, setBatchPreview] = useState<Record<number, BatchInfo[]>>({});
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .get<{ data: { id: number; name: string; customer_type: string }[] }>('/customers', { pageSize: 200 })
      .then((r) => setCustomers(r.data))
      .catch(() => setCustomers([]));
  }, []);

  useEffect(() => {
    if (!debounced.trim()) {
      setHits([]);
      return;
    }
    let cancelled = false;
    api
      .get<{ data: ProductHit[] }>('/products/search', { q: debounced, limit: 8 })
      .then((r) => !cancelled && setHits(r.data))
      .catch(() => !cancelled && setHits([]));
    return () => {
      cancelled = true;
    };
  }, [debounced]);

  /** Shows which batches FEFO will consume, so the counter can see traceability. */
  async function loadBatches(productId: number) {
    try {
      const r = await api.get<{ batches: BatchInfo[] }>(`/inventory/stock/${productId}`);
      setBatchPreview((s) => ({ ...s, [productId]: r.batches }));
    } catch {
      /* batch preview is informational only */
    }
  }

  function addProduct(product: ProductHit) {
    setLines((current) => {
      const index = current.findIndex((l) => l.product.id === product.id);
      if (index >= 0) {
        const next = [...current];
        next[index] = { ...next[index], quantity: next[index].quantity + 1 };
        return next;
      }
      return [...current, { product, quantity: 1, discount: 0 }];
    });
    void loadBatches(product.id);
    setSearch('');
    setHits([]);
    searchRef.current?.focus();
  }

  function updateLine(productId: number, patch: Partial<CartLine>) {
    setLines((current) => current.map((l) => (l.product.id === productId ? { ...l, ...patch } : l)));
  }

  function removeLine(productId: number) {
    setLines((current) => current.filter((l) => l.product.id !== productId));
  }

  // Totals mirror the server's pricing convention: selling_price is net of tax,
  // tax is charged on the discounted value.
  const totals = useMemo(() => {
    let subtotal = 0;
    let tax = 0;
    let lineDiscounts = 0;

    for (const line of lines) {
      const gross = line.product.selling_price * line.quantity;
      const taxable = Math.max(0, gross - line.discount);
      subtotal += gross;
      lineDiscounts += line.discount;
      tax += taxable * (line.product.tax_rate / 100);
    }

    const afterBill = Math.max(0, subtotal - lineDiscounts - billDiscount);
    // Bill discount reduces the taxable value proportionally.
    const taxableBase = Math.max(0, subtotal - lineDiscounts);
    const adjustedTax = taxableBase > 0 ? tax * (afterBill / taxableBase) : 0;

    return {
      subtotal: Math.round(subtotal * 100) / 100,
      discount: Math.round((lineDiscounts + billDiscount) * 100) / 100,
      tax: Math.round(adjustedTax * 100) / 100,
      total: Math.round((afterBill + adjustedTax) * 100) / 100,
      units: lines.reduce((s, l) => s + l.quantity, 0),
    };
  }, [lines, billDiscount]);

  async function completeSale() {
    if (lines.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const sale = await api.post<CompletedSale>('/sales', {
        items: lines.map((l) => ({
          product_id: l.product.id,
          quantity: l.quantity,
          discount: l.discount || undefined,
        })),
        customer_id: customerId === '' ? null : customerId,
        payment_method: payment,
        bill_discount: billDiscount || undefined,
      });
      setCompleted(sale);
      setLines([]);
      setBillDiscount(0);
      setCustomerId('');
      setPayment('CASH');
      setBatchPreview({});
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The sale could not be completed.');
    } finally {
      setBusy(false);
    }
  }

  const creditWithoutCustomer = payment === 'CREDIT' && customerId === '';

  return (
    <>
      <PageHeader
        title="New Sale"
        subtitle="Batch is selected automatically by FEFO — earliest expiry leaves first, expired stock is never sold"
      />

      {completed && (
        <div className="card mb-4 border-l-4 border-l-emerald-500 p-4">
          <div className="flex flex-wrap items-start gap-3">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-slate-900">
                Invoice {completed.invoice_number} completed — {currency(completed.total)}
              </p>
              <p className="mt-0.5 text-xs text-slate-500">
                {completed.items.length} batch line(s) dispensed. Stock has been deducted and the
                inventory movement recorded.
              </p>
            </div>
            <button type="button" className="btn-secondary shrink-0" onClick={() => setCompleted(null)}>
              Start next sale
            </button>
          </div>
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-3">
        {/* ------------------------------------------------------------ cart */}
        <div className="xl:col-span-2">
          <Card bodyClassName="p-0">
            <div className="relative border-b border-slate-100 p-4">
              <label className="label" htmlFor="pos-search">
                Scan barcode or search product
              </label>
              <div className="relative">
                <BarcodeIcon
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                  aria-hidden
                />
                <input
                  id="pos-search"
                  ref={searchRef}
                  className="input pl-9"
                  placeholder="Barcode, product name, generic, brand or code…"
                  value={search}
                  autoFocus
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => {
                    // A keyboard-wedge scanner ends its transmission with Enter.
                    if (e.key === 'Enter' && hits.length > 0) {
                      e.preventDefault();
                      addProduct(hits[0]);
                    }
                  }}
                />
              </div>

              {hits.length > 0 && (
                <ul className="absolute z-20 mt-1 max-h-72 w-[calc(100%-2rem)] overflow-auto rounded-lg border border-slate-200 bg-white shadow-pop">
                  {hits.map((hit) => (
                    <li key={hit.id}>
                      <button
                        type="button"
                        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-slate-50"
                        onClick={() => addProduct(hit)}
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-slate-800">
                            {hit.product_name}
                            {hit.prescription_flag === 1 && (
                              <span className="ml-1.5 inline-flex items-center gap-0.5 text-[10px] font-semibold text-rose-600">
                                <ShieldAlert className="h-3 w-3" aria-hidden />
                                Rx
                              </span>
                            )}
                          </span>
                          <span className="block truncate text-xs text-slate-500">
                            {hit.generic_name ?? ''} {hit.pack_size ? `· ${hit.pack_size}` : ''}
                          </span>
                        </span>
                        <span className="shrink-0 text-right">
                          <span className="block text-sm font-medium tnum">{currency(hit.selling_price, 2)}</span>
                          <span className="block text-xs text-slate-500">
                            stock {number(hit.current_stock ?? 0)}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {lines.length === 0 ? (
              <div className="px-4 py-14 text-center">
                <Plus className="mx-auto h-8 w-8 text-slate-300" aria-hidden />
                <p className="mt-2 text-sm font-medium text-slate-700">No items yet</p>
                <p className="text-sm text-slate-500">Scan a barcode or search to add the first product.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="bg-slate-50/70">
                      <th className="th">Product</th>
                      <th className="th text-right">Qty</th>
                      <th className="th text-right">Rate</th>
                      <th className="th text-right">Discount</th>
                      <th className="th text-right">Amount</th>
                      <th className="th" />
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line) => {
                      const batches = batchPreview[line.product.id] ?? [];
                      const amount = line.product.selling_price * line.quantity - line.discount;
                      return (
                        <tr key={line.product.id} className="table-row align-top">
                          <td className="td max-w-[240px]">
                            <span className="block truncate font-medium text-slate-800">
                              {line.product.product_name}
                            </span>
                            <span className="text-xs text-slate-500">
                              {line.product.pack_size ?? ''}
                              {batches[0] && (
                                <>
                                  {' · '}batch {batches[0].batch_number} exp{' '}
                                  {batches[0].expiry_date.slice(0, 7)}
                                </>
                              )}
                            </span>
                          </td>
                          <td className="td text-right">
                            <input
                              type="number"
                              min={1}
                              aria-label={`Quantity for ${line.product.product_name}`}
                              className="input w-20 py-1 text-right"
                              value={line.quantity}
                              onChange={(e) =>
                                updateLine(line.product.id, {
                                  quantity: Math.max(1, Number(e.target.value) || 1),
                                })
                              }
                            />
                          </td>
                          <td className="td text-right tnum">{currency(line.product.selling_price, 2)}</td>
                          <td className="td text-right">
                            <input
                              type="number"
                              min={0}
                              aria-label={`Discount for ${line.product.product_name}`}
                              className="input w-20 py-1 text-right"
                              value={line.discount}
                              onChange={(e) =>
                                updateLine(line.product.id, {
                                  discount: Math.max(0, Number(e.target.value) || 0),
                                })
                              }
                            />
                          </td>
                          <td className="td text-right tnum font-medium">{currency(amount)}</td>
                          <td className="td text-right">
                            <button
                              type="button"
                              className="btn-ghost px-2 py-1"
                              aria-label={`Remove ${line.product.product_name}`}
                              onClick={() => removeLine(line.product.id)}
                            >
                              <Trash2 className="h-4 w-4 text-slate-400" aria-hidden />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        {/* --------------------------------------------------------- payment */}
        <div>
          <Card title="Bill" bodyClassName="p-4">
            <div className="space-y-3">
              <div>
                <label className="label" htmlFor="customer">
                  Customer
                </label>
                <select
                  id="customer"
                  className="input"
                  value={customerId}
                  onChange={(e) => setCustomerId(e.target.value === '' ? '' : Number(e.target.value))}
                >
                  <option value="">Walk-in customer</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {c.customer_type === 'INSTITUTIONAL' ? ' (institutional)' : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="label" htmlFor="bill-discount">
                  Bill discount
                </label>
                <input
                  id="bill-discount"
                  type="number"
                  min={0}
                  className="input"
                  value={billDiscount}
                  onChange={(e) => setBillDiscount(Math.max(0, Number(e.target.value) || 0))}
                />
              </div>

              <div>
                <span className="label">Payment method</span>
                <div className="grid grid-cols-4 gap-1.5">
                  {PAYMENT_METHODS.map((method) => (
                    <button
                      key={method}
                      type="button"
                      onClick={() => setPayment(method)}
                      className={`rounded-lg border px-2 py-2 text-xs font-medium transition-colors ${
                        payment === method
                          ? 'border-brand-600 bg-brand-50 text-brand-800'
                          : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      {method}
                    </button>
                  ))}
                </div>
                {creditWithoutCustomer && (
                  <p className="mt-1.5 flex items-start gap-1 text-xs text-amber-700">
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                    A credit sale needs a named customer, otherwise there is nobody to collect from.
                  </p>
                )}
              </div>

              <dl className="space-y-1.5 border-t border-slate-100 pt-3 text-sm">
                <div className="flex justify-between">
                  <dt className="text-slate-500">Subtotal</dt>
                  <dd className="tnum">{currency(totals.subtotal)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">Discount</dt>
                  <dd className="tnum text-emerald-600">-{currency(totals.discount)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">GST</dt>
                  <dd className="tnum">{currency(totals.tax)}</dd>
                </div>
                <div className="flex justify-between border-t border-slate-100 pt-1.5 text-base font-semibold">
                  <dt>Total</dt>
                  <dd className="tnum">{currency(totals.total)}</dd>
                </div>
                <p className="text-xs text-slate-500">
                  {number(lines.length)} line(s) · {number(totals.units)} unit(s)
                </p>
              </dl>

              {error && (
                <div role="alert" className="flex items-start gap-2 rounded-lg bg-rose-50 p-3 text-sm text-rose-700">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  <span>{error}</span>
                </div>
              )}

              <button
                type="button"
                className="btn-primary w-full"
                disabled={busy || lines.length === 0 || creditWithoutCustomer}
                onClick={completeSale}
              >
                <Receipt className="h-4 w-4" aria-hidden />
                {busy ? 'Completing…' : `Complete sale · ${currency(totals.total)}`}
              </button>
            </div>
          </Card>

          <div className="card mt-4 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">FEFO dispensing</p>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
              The server allocates each line from the earliest-expiring valid batch, splitting across
              batches when one cannot cover the quantity. Expired batches are excluded entirely, and
              a sale that exceeds available stock is rejected with nothing written — the whole
              transaction rolls back.
            </p>
            {Object.values(batchPreview).some((b) => b.length > 1) && (
              <p className="mt-2 flex items-start gap-1.5 text-xs text-slate-500">
                <Pill tone="brand">Multi-batch</Pill>
                <span>One or more lines will draw from more than one batch.</span>
              </p>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
