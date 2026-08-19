import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Award, Check, Info, ShoppingCart, TrendingDown } from 'lucide-react';
import { useApi, useDebounced } from '../hooks/useApi';
import { useCart } from '../hooks/useCart';
import { Card, EmptyState, ErrorState, LoadingBlock, PageHeader, Pill } from '../components/ui';
import { SearchInput } from '../components/DataTable';
import { currency, number, percent } from '../utils/format';
import { api } from '../services/api';

/**
 * SUPPLIER COMPARISON
 * ===================
 *
 * Ranks every distributor listing a product by EFFECTIVE COST rather than by
 * the quoted rate.
 *
 * This distinction is the entire point of the screen. A distributor quoting a
 * higher PTR with a 10+1 scheme frequently costs less per unit actually
 * received than one quoting a lower PTR with no scheme — and buying on the
 * headline rate is the most common purchasing error in pharmacy retail.
 */

interface Option {
  distributor_id: number;
  distributor_name: string;
  distributor_code: string;
  product_id: number;
  product_name: string;
  pack_size: string | null;
  ptr: number;
  pts: number;
  mrp: number;
  scheme_label: string;
  scheme_buy_qty: number;
  scheme_free_qty: number;
  discount_pct: number;
  available_qty: number;
  min_order_qty: number;
  delivery_days: number;
  distance_km: number;
  rating: number;
  payment_terms: string;
  quotedQty: number;
  freeQty: number;
  totalUnits: number;
  grossAmount: number;
  discountAmount: number;
  netAmount: number;
  effective_cost: number;
  savings: number;
  savingsPct: number;
  canFulfil: boolean;
  rank: number;
  premiumPct: number;
  isBest: boolean;
}

interface ComparisonResponse {
  product: { id: number; product_name: string; generic_name: string | null; pack_size: string | null; mrp: number; ptr: number };
  quantity: number;
  options: Option[];
  bestOption: Option | null;
  potentialSaving: number;
  methodology: string;
}

interface ProductHit {
  id: number;
  product_name: string;
  generic_name: string | null;
  product_code: string;
}

export default function SupplierComparison() {
  const [params, setParams] = useSearchParams();
  const cart = useCart();

  const productId = Number(params.get('productId')) || 0;
  const [quantity, setQuantity] = useState(Number(params.get('quantity')) || 100);
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search);
  const [hits, setHits] = useState<ProductHit[]>([]);

  // Product picker, shown when no product is selected yet.
  useEffect(() => {
    if (!debounced || productId) {
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
  }, [debounced, productId]);

  const { data, error, loading, reload } = useApi<ComparisonResponse>(
    productId ? '/procurement/compare' : null,
    { productId, quantity },
  );

  function select(id: number) {
    setParams({ productId: String(id), quantity: String(quantity) });
    setSearch('');
  }

  function addToCart(option: Option) {
    cart.add({
      productId: option.product_id,
      productName: data?.product.product_name ?? option.product_name,
      productCode: option.distributor_code,
      packSize: option.pack_size,
      distributorId: option.distributor_id,
      distributorName: option.distributor_name,
      quantity: option.quotedQty,
      ptr: option.ptr,
      schemeBuyQty: option.scheme_buy_qty,
      schemeFreeQty: option.scheme_free_qty,
      discountPct: option.discount_pct,
      schemeLabel: option.scheme_label,
      effectiveCost: option.effective_cost,
      availableQty: option.available_qty,
      addedFrom: 'Supplier comparison',
    });
  }

  return (
    <>
      <PageHeader
        title="Supplier Comparison"
        subtitle="Ranked by effective cost — what you actually pay per unit received, free goods included"
        actions={
          <Link to="/procurement/cart" className="btn-secondary">
            <ShoppingCart className="h-4 w-4" aria-hidden />
            Cart {cart.count > 0 && <span className="ml-1 rounded-full bg-brand-600 px-1.5 text-xs text-white">{cart.count}</span>}
          </Link>
        }
      />

      <Card className="mb-5" bodyClassName="p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="relative min-w-[280px] flex-1">
            <label className="label" htmlFor="product-search">
              Product
            </label>
            {productId && data ? (
              <div className="flex items-center gap-2">
                <div className="input flex items-center justify-between">
                  <span className="truncate">
                    {data.product.product_name}
                    {data.product.pack_size ? ` · ${data.product.pack_size}` : ''}
                  </span>
                </div>
                <button
                  type="button"
                  className="btn-ghost shrink-0"
                  onClick={() => setParams({})}
                >
                  Change
                </button>
              </div>
            ) : (
              <SearchInput
                value={search}
                onChange={setSearch}
                placeholder="Search a product to compare…"
              />
            )}

            {hits.length > 0 && (
              <ul className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-slate-200 bg-white shadow-pop">
                {hits.map((hit) => (
                  <li key={hit.id}>
                    <button
                      type="button"
                      className="flex w-full flex-col items-start px-3 py-2 text-left hover:bg-slate-50"
                      onClick={() => select(hit.id)}
                    >
                      <span className="text-sm font-medium text-slate-800">{hit.product_name}</span>
                      <span className="text-xs text-slate-500">
                        {hit.generic_name ?? ''} · {hit.product_code}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="w-32">
            <label className="label" htmlFor="qty">
              Quantity
            </label>
            <input
              id="qty"
              type="number"
              min={1}
              className="input"
              value={quantity}
              onChange={(e) => setQuantity(Math.max(1, Number(e.target.value) || 1))}
            />
          </div>

          <button type="button" className="btn-secondary" onClick={reload} disabled={!productId}>
            Recalculate
          </button>
        </div>
      </Card>

      {!productId && (
        <Card>
          <EmptyState
            title="Choose a product to compare"
            message="Search above, or arrive here from the Replenishment Center with the quantity already filled in."
            icon={TrendingDown}
          />
        </Card>
      )}

      {productId && error && (
        <Card>
          <ErrorState message={error} onRetry={reload} />
        </Card>
      )}

      {productId && loading && !data && (
        <Card>
          <LoadingBlock rows={6} />
        </Card>
      )}

      {data && data.options.length === 0 && (
        <Card>
          <EmptyState
            title="No distributor lists this product"
            message="Add it to a distributor's catalogue from the Distributor Network to get a quote."
          />
        </Card>
      )}

      {data && data.options.length > 0 && (
        <>
          {data.bestOption && (
            <div className="card mb-4 border-l-4 border-l-emerald-500 p-4">
              <div className="flex flex-wrap items-start gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-emerald-100 text-emerald-700">
                  <Award className="h-5 w-5" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-slate-900">
                    Best value: {data.bestOption.distributor_name}
                  </p>
                  <p className="mt-1 text-sm leading-relaxed text-slate-600">
                    {number(quantity)} units at {currency(data.bestOption.ptr, 2)} PTR with{' '}
                    {data.bestOption.scheme_label.toLowerCase()} gives{' '}
                    <strong>{data.bestOption.freeQty} free</strong> — {data.bestOption.totalUnits}{' '}
                    units for {currency(data.bestOption.netAmount)}, an effective{' '}
                    <strong>{currency(data.bestOption.effective_cost, 2)}</strong> per unit.
                    {data.potentialSaving > 0 && (
                      <> Choosing this over the dearest usable quote saves {currency(data.potentialSaving)}.</>
                    )}
                  </p>
                </div>
                <button type="button" className="btn-primary shrink-0" onClick={() => addToCart(data.bestOption!)}>
                  <ShoppingCart className="h-4 w-4" aria-hidden />
                  Add to cart
                </button>
              </div>
            </div>
          )}

          <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
            {data.options.map((option) => {
              const inCart = cart.has(option.product_id, option.distributor_id);
              return (
                <article
                  key={option.distributor_id}
                  className={`card p-4 ${option.isBest ? 'ring-2 ring-emerald-500' : ''} ${!option.canFulfil ? 'opacity-75' : ''}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <Link
                        to={`/procurement/distributors/${option.distributor_id}`}
                        className="block truncate text-sm font-semibold text-slate-900 hover:text-brand-700"
                      >
                        {option.distributor_name}
                      </Link>
                      <p className="text-xs text-slate-500">
                        {option.distance_km} km · {option.delivery_days}d delivery · ★ {option.rating}
                      </p>
                    </div>
                    {option.isBest ? (
                      <Pill tone="emerald">Best</Pill>
                    ) : (
                      <Pill tone="slate">#{option.rank}</Pill>
                    )}
                  </div>

                  <dl className="mt-3 space-y-1.5 border-t border-slate-100 pt-3 text-xs">
                    <div className="flex justify-between">
                      <dt className="text-slate-500">PTR</dt>
                      <dd className="font-medium tnum">{currency(option.ptr, 2)}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-slate-500">Scheme</dt>
                      <dd className="font-medium">{option.scheme_label}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-slate-500">Free units</dt>
                      <dd className="font-medium tnum text-emerald-600">
                        {option.freeQty > 0 ? `+${option.freeQty}` : '—'}
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-slate-500">Net payable</dt>
                      <dd className="font-medium tnum">{currency(option.netAmount)}</dd>
                    </div>
                    <div className="flex justify-between border-t border-slate-100 pt-1.5">
                      <dt className="font-medium text-slate-700">Effective cost</dt>
                      <dd className={`text-sm font-semibold tnum ${option.isBest ? 'text-emerald-600' : 'text-slate-900'}`}>
                        {currency(option.effective_cost, 2)}
                      </dd>
                    </div>
                    {!option.isBest && option.premiumPct > 0 && (
                      <div className="flex justify-between">
                        <dt className="text-slate-500">vs best</dt>
                        <dd className="font-medium tnum text-rose-600">+{percent(option.premiumPct)}</dd>
                      </div>
                    )}
                    <div className="flex justify-between">
                      <dt className="text-slate-500">Stock</dt>
                      <dd className={`font-medium tnum ${option.canFulfil ? '' : 'text-amber-600'}`}>
                        {number(option.available_qty)}
                        {!option.canFulfil && ' (short)'}
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-slate-500">Terms</dt>
                      <dd className="font-medium">{option.payment_terms}</dd>
                    </div>
                  </dl>

                  <button
                    type="button"
                    className={`${inCart ? 'btn-secondary' : 'btn-primary'} mt-3 w-full`}
                    onClick={() => addToCart(option)}
                  >
                    {inCart ? <Check className="h-4 w-4" aria-hidden /> : <ShoppingCart className="h-4 w-4" aria-hidden />}
                    {inCart ? 'In cart — add more' : 'Add to cart'}
                  </button>
                </article>
              );
            })}
          </div>

          <div className="card mt-5 flex items-start gap-3 bg-slate-50/60 p-4">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden />
            <p className="text-xs leading-relaxed text-slate-600">
              <strong className="text-slate-800">How the ranking works.</strong> {data.methodology}{' '}
              Effective cost excludes GST, which a registered pharmacy recovers as input credit;
              including it would overstate the true cost of goods. All distributor prices, schemes
              and availability shown here are <strong>synthetic demo data</strong> held locally — no
              live market or distributor feed is involved.
            </p>
          </div>
        </>
      )}
    </>
  );
}
