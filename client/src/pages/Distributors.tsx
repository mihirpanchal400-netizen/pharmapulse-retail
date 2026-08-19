import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Building2, Check, Info, MapPin, Phone, ShoppingCart, Star, Truck } from 'lucide-react';
import { useApi, useDebounced } from '../hooks/useApi';
import { useCart } from '../hooks/useCart';
import { Card, EmptyState, ErrorState, KpiCard, LoadingBlock, PageHeader, Pill } from '../components/ui';
import { DataTable, Pagination, SearchInput, Select, type Column } from '../components/DataTable';
import { currency, currencyCompact, date, number } from '../utils/format';

/**
 * DISTRIBUTOR NETWORK
 * ===================
 *
 * Discovery and catalogue browsing for the pharmacy's upstream trading
 * partners.
 *
 * Every distributor, price, scheme and availability figure shown on these
 * screens is SYNTHETIC DEMO DATA generated locally. Nothing is sourced from
 * Retailio, Pharmarack or any commercial distributor platform, and no live
 * market data is represented. The banner on the page says so to the user.
 */

interface Distributor {
  id: number;
  distributor_code: string;
  name: string;
  type: string;
  contact_person: string | null;
  phone: string | null;
  email: string | null;
  area: string | null;
  city: string | null;
  pin_code: string | null;
  payment_terms: string;
  credit_days: number;
  delivery_days: number;
  min_order_value: number;
  distance_km: number;
  rating: number;
  status: string;
  catalogue_size: number;
  in_stock_items: number;
  open_orders: number;
  outstanding: number;
  last_order_date: string | null;
}

interface ListResponse {
  data: Distributor[];
  page: number;
  totalPages: number;
  total: number;
  pharmacyLocation: { city: string; area: string; pinCode: string };
  disclaimer: string;
}

const DemoBanner = ({ text }: { text: string }) => (
  <div className="card mb-4 flex items-start gap-2.5 border-amber-200 bg-amber-50/60 p-3">
    <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
    <p className="text-xs leading-relaxed text-amber-900">
      <strong>Demo distributor network.</strong> {text}
    </p>
  </div>
);

export function DistributorNetwork() {
  const [search, setSearch] = useState('');
  const [city, setCity] = useState('ALL');
  const [sortBy, setSortBy] = useState('distance');
  const [page, setPage] = useState(1);
  const debounced = useDebounced(search);

  const { data, error, loading, reload } = useApi<ListResponse>('/procurement/distributors', {
    search: debounced || undefined,
    city: city === 'ALL' ? undefined : city,
    sortBy,
    page,
    pageSize: 24,
  });

  const cities = [
    { label: 'All cities', value: 'ALL' },
    ...[...new Set((data?.data ?? []).map((d) => d.city).filter(Boolean))].map((c) => ({
      label: String(c),
      value: String(c),
    })),
  ];

  return (
    <>
      <PageHeader
        title="Distributor Network"
        subtitle={
          data
            ? `${number(data.total)} distributors · your pharmacy is in ${data.pharmacyLocation.area}, ${data.pharmacyLocation.city} ${data.pharmacyLocation.pinCode}`
            : 'Find and compare distributors and stockists'
        }
      />

      <DemoBanner text="All distributors, catalogue prices, schemes and stock availability below are synthetic data generated locally for demonstration. No external platform is contacted and no live distributor feed is used." />

      <Card className="mb-4" bodyClassName="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <SearchInput
            value={search}
            onChange={(v) => {
              setSearch(v);
              setPage(1);
            }}
            placeholder="Search name, city, area or contact…"
            className="min-w-[240px] flex-1"
          />
          <Select value={city} onChange={setCity} options={cities} label="City" className="w-auto" />
          <Select
            value={sortBy}
            onChange={setSortBy}
            label="Sort by"
            className="w-auto"
            options={[
              { label: 'Nearest first', value: 'distance' },
              { label: 'Highest rated', value: 'rating' },
              { label: 'Largest catalogue', value: 'catalogue' },
              { label: 'Most owed', value: 'outstanding' },
              { label: 'Name', value: 'name' },
            ]}
          />
        </div>
      </Card>

      {error && (
        <Card>
          <ErrorState message={error} onRetry={reload} />
        </Card>
      )}

      {loading && !data && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="card p-4">
              <LoadingBlock rows={4} />
            </div>
          ))}
        </div>
      )}

      {data && data.data.length === 0 && (
        <Card>
          <EmptyState title="No distributors match" message="Try a different city or clear the search." />
        </Card>
      )}

      {data && data.data.length > 0 && (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {data.data.map((d) => (
              <article key={d.id} className="card flex flex-col p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Link
                      to={`/procurement/distributors/${d.id}`}
                      className="block truncate text-sm font-semibold text-slate-900 hover:text-brand-700"
                    >
                      {d.name}
                    </Link>
                    <p className="mt-0.5 flex items-center gap-1 text-xs text-slate-500">
                      <MapPin className="h-3 w-3" aria-hidden />
                      {d.area}, {d.city} · {d.distance_km} km
                    </p>
                  </div>
                  <Pill tone={d.type === 'SUPER_STOCKIST' ? 'brand' : 'slate'}>
                    {d.type.replace('_', ' ').toLowerCase()}
                  </Pill>
                </div>

                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 border-t border-slate-100 pt-3 text-xs">
                  <div className="flex justify-between">
                    <dt className="text-slate-500">Delivery</dt>
                    <dd className="font-medium">{d.delivery_days === 0 ? 'Same day' : `${d.delivery_days} d`}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-slate-500">Rating</dt>
                    <dd className="flex items-center gap-0.5 font-medium">
                      <Star className="h-3 w-3 fill-amber-400 text-amber-400" aria-hidden />
                      {d.rating}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-slate-500">Catalogue</dt>
                    <dd className="font-medium tnum">{number(d.catalogue_size)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-slate-500">In stock</dt>
                    <dd className="font-medium tnum">{number(d.in_stock_items)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-slate-500">Terms</dt>
                    <dd className="font-medium">{d.payment_terms}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-slate-500">Min order</dt>
                    <dd className="font-medium tnum">
                      {d.min_order_value > 0 ? currency(d.min_order_value) : '—'}
                    </dd>
                  </div>
                </dl>

                {(d.outstanding > 0 || d.open_orders > 0) && (
                  <div className="mt-2 flex flex-wrap gap-2 text-xs">
                    {d.open_orders > 0 && <Pill tone="amber">{d.open_orders} open order(s)</Pill>}
                    {d.outstanding > 0 && <Pill tone="rose">{currency(d.outstanding)} owed</Pill>}
                  </div>
                )}

                <div className="mt-auto flex gap-2 pt-3">
                  <Link to={`/procurement/distributors/${d.id}`} className="btn-primary flex-1 text-xs">
                    View catalogue
                  </Link>
                  {d.phone && (
                    <a
                      href={`tel:${d.phone.replace(/\s/g, '')}`}
                      className="btn-secondary px-2.5"
                      title={`Call ${d.contact_person ?? d.name}`}
                      aria-label={`Call ${d.name}`}
                    >
                      <Phone className="h-4 w-4" aria-hidden />
                    </a>
                  )}
                </div>
              </article>
            ))}
          </div>

          <div className="card mt-4">
            <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onChange={setPage} />
          </div>
        </>
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Distributor detail + catalogue                                              */
/* -------------------------------------------------------------------------- */

interface CatalogueItem {
  id: number;
  product_id: number;
  product_name: string;
  generic_name: string | null;
  category: string;
  pack_size: string | null;
  ptr: number;
  mrp: number;
  scheme_label: string;
  scheme_buy_qty: number;
  scheme_free_qty: number;
  discount_pct: number;
  available_qty: number;
  min_order_qty: number;
  effective_cost: number;
  current_stock: number;
}

interface CatalogueResponse {
  distributor: Distributor;
  data: CatalogueItem[];
  page: number;
  totalPages: number;
  total: number;
}

export function DistributorDetail() {
  const { id } = useParams();
  const [search, setSearch] = useState('');
  const [inStockOnly, setInStockOnly] = useState(false);
  const [page, setPage] = useState(1);
  const debounced = useDebounced(search);
  const cart = useCart();

  const { data, error, loading, reload } = useApi<CatalogueResponse>(
    id ? `/procurement/distributors/${id}/catalogue` : null,
    { search: debounced || undefined, inStockOnly: inStockOnly || undefined, page, pageSize: 25 },
  );

  const d = data?.distributor;

  function add(item: CatalogueItem) {
    if (!d) return;
    cart.add({
      productId: item.product_id,
      productName: item.product_name,
      productCode: String(item.product_id),
      packSize: item.pack_size,
      distributorId: d.id,
      distributorName: d.name,
      quantity: Math.max(item.min_order_qty, item.scheme_buy_qty || 10),
      ptr: item.ptr,
      schemeBuyQty: item.scheme_buy_qty,
      schemeFreeQty: item.scheme_free_qty,
      discountPct: item.discount_pct,
      schemeLabel: item.scheme_label,
      effectiveCost: item.effective_cost,
      availableQty: item.available_qty,
      addedFrom: d.name,
    });
  }

  const columns: Column<CatalogueItem>[] = [
    {
      key: 'product',
      header: 'Product',
      render: (row) => (
        <div className="max-w-[260px]">
          <Link
            to={`/inventory/products/${row.product_id}`}
            className="block truncate font-medium text-slate-800 hover:text-brand-700"
          >
            {row.product_name}
          </Link>
          <span className="text-xs text-slate-500">
            {row.generic_name ?? row.category}
            {row.pack_size ? ` · ${row.pack_size}` : ''}
          </span>
        </div>
      ),
    },
    { key: 'mrp', header: 'MRP', align: 'right', secondary: true, render: (r) => currency(r.mrp, 2) },
    { key: 'ptr', header: 'PTR', align: 'right', render: (r) => currency(r.ptr, 2) },
    {
      key: 'scheme',
      header: 'Scheme',
      render: (r) => (
        <Pill tone={r.scheme_label === 'No scheme' ? 'slate' : 'emerald'}>{r.scheme_label}</Pill>
      ),
    },
    {
      key: 'effective',
      header: 'Effective',
      align: 'right',
      render: (r) => <span className="font-medium tnum">{currency(r.effective_cost, 2)}</span>,
    },
    {
      key: 'available',
      header: 'Their stock',
      align: 'right',
      render: (r) => (
        <span className={r.available_qty === 0 ? 'text-rose-600' : ''}>{number(r.available_qty)}</span>
      ),
    },
    {
      key: 'mine',
      header: 'My stock',
      align: 'right',
      secondary: true,
      render: (r) => number(r.current_stock),
    },
    {
      key: 'action',
      header: '',
      align: 'right',
      render: (row) => (
        <button
          type="button"
          className={cart.has(row.product_id, d?.id) ? 'btn-secondary px-2 py-1.5' : 'btn-primary px-2 py-1.5'}
          disabled={row.available_qty === 0}
          onClick={() => add(row)}
          aria-label={`Add ${row.product_name} to cart`}
        >
          {cart.has(row.product_id, d?.id) ? (
            <Check className="h-4 w-4" aria-hidden />
          ) : (
            <ShoppingCart className="h-4 w-4" aria-hidden />
          )}
        </button>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title={d?.name ?? 'Distributor'}
        subtitle={d ? `${d.distributor_code} · ${d.area}, ${d.city} ${d.pin_code} · ${d.distance_km} km away` : undefined}
        actions={
          <>
            <Link to="/procurement/distributors" className="btn-secondary">
              All distributors
            </Link>
            <Link to="/procurement/cart" className="btn-secondary">
              <ShoppingCart className="h-4 w-4" aria-hidden />
              Cart {cart.count > 0 && <span className="ml-1 rounded-full bg-brand-600 px-1.5 text-xs text-white">{cart.count}</span>}
            </Link>
          </>
        }
      />

      <DemoBanner text="This distributor and its catalogue are synthetic demo records held in your local database. Prices, schemes and stock figures do not represent any real company or live availability." />

      {d && (
        <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard label="Catalogue" value={number(d.catalogue_size)} sub={`${number(d.in_stock_items)} in stock`} icon={Building2} />
          <KpiCard label="Delivery" value={d.delivery_days === 0 ? 'Same day' : `${d.delivery_days} days`} sub={d.payment_terms} icon={Truck} />
          <KpiCard label="Open orders" value={number(d.open_orders)} sub={d.last_order_date ? `last ordered ${date(d.last_order_date)}` : 'no orders yet'} icon={ShoppingCart} />
          <KpiCard
            label="Outstanding"
            value={currencyCompact(d.outstanding)}
            sub={`credit ${d.credit_days} days`}
            icon={Building2}
            tone={d.outstanding > 0 ? 'warning' : 'default'}
          />
        </div>
      )}

      <Card bodyClassName="p-0">
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-4">
          <SearchInput
            value={search}
            onChange={(v) => {
              setSearch(v);
              setPage(1);
            }}
            placeholder="Search this catalogue…"
            className="min-w-[240px] flex-1"
          />
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              className="rounded border-slate-300"
              checked={inStockOnly}
              onChange={(e) => {
                setInStockOnly(e.target.checked);
                setPage(1);
              }}
            />
            In stock only
          </label>
        </div>

        <DataTable
          columns={columns}
          rows={data?.data ?? []}
          rowKey={(row) => row.id}
          loading={loading}
          error={error}
          onRetry={reload}
          emptyTitle="No products in this catalogue"
          emptyMessage="This distributor does not list any product matching your filters."
        />

        {data && <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onChange={setPage} />}
      </Card>
    </>
  );
}
