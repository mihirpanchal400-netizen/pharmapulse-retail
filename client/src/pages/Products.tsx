import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Boxes,
  GitCompare,
  Package,
  Pill as PillIcon,
  ShieldAlert,
  ShoppingCart,
  TrendingUp,
} from 'lucide-react';
import { useApi, useDebounced } from '../hooks/useApi';
import { useCart } from '../hooks/useCart';
import { Card, ErrorState, KpiCard, LoadingBlock, PageHeader, Pill, StockBadge } from '../components/ui';
import { DataTable, Pagination, SearchInput, Select, type Column } from '../components/DataTable';
import { currency, currencyCompact, date, number, percent } from '../utils/format';
import type { InventoryItem, Paged } from '../types';

/**
 * PRODUCT MASTER
 * ==============
 *
 * List and detail. The detail page is deliberately dense: it answers the four
 * questions a pharmacist actually has about a medicine in one place — what is
 * it, how much have I got, how fast does it sell, and where do I buy more.
 */

const STATUS_FILTERS = [
  { label: 'All stock states', value: 'ALL' },
  { label: 'Out of stock', value: 'OUT_OF_STOCK' },
  { label: 'Low stock', value: 'LOW_STOCK' },
  { label: 'Expiring', value: 'EXPIRING' },
  { label: 'Overstocked', value: 'OVERSTOCKED' },
  { label: 'Healthy', value: 'HEALTHY' },
];

export function ProductList() {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('ALL');
  const [status, setStatus] = useState('ALL');
  const [page, setPage] = useState(1);
  const debounced = useDebounced(search);

  const { data: categories } = useApi<{ data: string[] }>('/products/categories');
  const { data, error, loading, reload } = useApi<Paged<InventoryItem>>('/inventory/stock', {
    search: debounced || undefined,
    category: category === 'ALL' ? undefined : category,
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
          <Link
            to={`/inventory/products/${row.id}`}
            className="block truncate font-medium text-slate-800 hover:text-brand-700"
          >
            {row.product_name}
            {row.prescription_flag === 1 && (
              <span className="ml-1.5 inline-flex items-center gap-0.5 text-[10px] font-semibold text-rose-600">
                <ShieldAlert className="h-3 w-3" aria-hidden />
                Rx
              </span>
            )}
          </Link>
          <span className="text-xs text-slate-500">
            {row.generic_name ?? row.category}
            {row.pack_size ? ` · ${row.pack_size}` : ''}
          </span>
        </div>
      ),
    },
    { key: 'code', header: 'Code', secondary: true, render: (r) => <span className="font-mono text-xs">{r.product_code}</span> },
    { key: 'category', header: 'Category', secondary: true, render: (r) => r.category },
    { key: 'mrp', header: 'MRP', align: 'right', render: (r) => currency(r.selling_price, 2) },
    { key: 'ptr', header: 'PTR', align: 'right', secondary: true, render: (r) => currency(r.purchase_price, 2) },
    {
      key: 'stock',
      header: 'Stock',
      align: 'right',
      render: (r) => (
        <span className={r.current_stock === 0 ? 'font-semibold text-rose-600' : 'font-medium'}>
          {number(r.current_stock)}
        </span>
      ),
    },
    {
      key: 'velocity',
      header: 'Velocity',
      align: 'right',
      secondary: true,
      render: (r) => `${number(r.sales_velocity, 1)}/d`,
    },
    {
      key: 'coverage',
      header: 'Coverage',
      align: 'right',
      render: (r) => (r.stock_coverage_days === null ? '—' : `${number(r.stock_coverage_days, 1)}d`),
    },
    { key: 'status', header: 'Status', render: (r) => <StockBadge status={r.stock_status} /> },
  ];

  return (
    <>
      <PageHeader
        title="Products"
        subtitle="Product master with live stock, pricing and sales velocity"
        actions={
          <Link to="/procurement/replenishment" className="btn-secondary">
            Replenishment Center
          </Link>
        }
      />

      <Card bodyClassName="p-0">
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-4">
          <SearchInput
            value={search}
            onChange={(v) => {
              setSearch(v);
              setPage(1);
            }}
            placeholder="Search name, generic, brand, code or manufacturer…"
            className="min-w-[260px] flex-1"
          />
          <Select
            value={category}
            onChange={(v) => {
              setCategory(v);
              setPage(1);
            }}
            label="Category"
            className="w-auto"
            options={[
              { label: 'All categories', value: 'ALL' },
              ...(categories?.data ?? []).map((c) => ({ label: c, value: c })),
            ]}
          />
          <Select
            value={status}
            onChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
            label="Stock status"
            className="w-auto"
            options={STATUS_FILTERS}
          />
        </div>

        <DataTable
          columns={columns}
          rows={data?.data ?? []}
          rowKey={(row) => row.id}
          loading={loading}
          error={error}
          onRetry={reload}
          emptyTitle="No products match"
          emptyMessage="Try a different search term or clear the filters."
        />

        {data && <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onChange={setPage} />}
      </Card>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Product detail                                                              */
/* -------------------------------------------------------------------------- */

interface ProductDetailData {
  id: number;
  product_code: string;
  product_name: string;
  generic_name: string | null;
  brand_name: string | null;
  category: string;
  dosage_form: string | null;
  strength: string | null;
  pack_size: string | null;
  manufacturer: string | null;
  prescription_flag: number;
  purchase_price: number;
  selling_price: number;
  tax_rate: number;
  reorder_level: number;
  minimum_stock: number;
  maximum_stock: number;
  status: string;
  mrp?: number;
  ptr?: number;
  pts?: number;
  hsn_code?: string | null;
  schedule_category?: string;
  barcode?: string | null;
  composition?: string | null;
  lead_time_days?: number;
  storage_condition?: string;
  current_stock?: number;
  batches?: {
    id: number;
    batch_number: string;
    expiry_date: string;
    quantity: number;
    purchase_price: number;
    selling_price: number;
  }[];
}

interface SupplierOption {
  distributor_id: number;
  distributor_name: string;
  ptr: number;
  mrp: number;
  scheme_label: string;
  scheme_buy_qty: number;
  scheme_free_qty: number;
  discount_pct: number;
  effective_cost: number;
  available_qty: number;
  delivery_days: number;
  payment_terms: string;
  isBest: boolean;
  rank: number;
}

export function ProductDetail() {
  const { id } = useParams();
  const cart = useCart();

  const { data, error, loading, reload } = useApi<ProductDetailData>(id ? `/products/${id}` : null);
  const { data: suppliers } = useApi<{ data: SupplierOption[] }>(
    id ? `/procurement/products/${id}/suppliers` : null,
  );
  const { data: replenishment } = useApi<{ data: { suggestedQty: number; stockCoverageDays: number | null; avgDailySales: number } | null }>(
    id ? `/procurement/replenishment/${id}` : null,
  );

  if (error) {
    return (
      <>
        <PageHeader title="Product" />
        <Card>
          <ErrorState message={error} onRetry={reload} />
        </Card>
      </>
    );
  }

  if (!data || loading) {
    return (
      <>
        <PageHeader title="Product" />
        <Card>
          <LoadingBlock rows={8} />
        </Card>
      </>
    );
  }

  const batches = data.batches ?? [];
  const stock = data.current_stock ?? batches.reduce((s, b) => s + b.quantity, 0);
  const plan = replenishment?.data;
  const suggestedQty = plan?.suggestedQty || Math.max(10, data.reorder_level);

  function addBest() {
    const best = suppliers?.data.find((s) => s.isBest);
    if (!best || !data) return;
    cart.add({
      productId: data.id,
      productName: data.product_name,
      productCode: data.product_code,
      packSize: data.pack_size,
      distributorId: best.distributor_id,
      distributorName: best.distributor_name,
      quantity: suggestedQty,
      ptr: best.ptr,
      schemeBuyQty: best.scheme_buy_qty,
      schemeFreeQty: best.scheme_free_qty,
      discountPct: best.discount_pct,
      schemeLabel: best.scheme_label,
      effectiveCost: best.effective_cost,
      availableQty: best.available_qty,
      addedFrom: 'Product page',
    });
  }

  return (
    <>
      <PageHeader
        title={data.product_name}
        subtitle={`${data.product_code} · ${data.generic_name ?? data.category}${data.strength ? ` · ${data.strength}` : ''}`}
        actions={
          <>
            <Link to="/inventory/products" className="btn-secondary">
              All products
            </Link>
            <Link
              to={`/procurement/compare?productId=${data.id}&quantity=${suggestedQty}`}
              className="btn-secondary"
            >
              <GitCompare className="h-4 w-4" aria-hidden />
              Compare suppliers
            </Link>
            <button type="button" className="btn-primary" onClick={addBest} disabled={!suppliers?.data.length}>
              <ShoppingCart className="h-4 w-4" aria-hidden />
              Add {suggestedQty} to cart
            </button>
          </>
        }
      />

      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Available stock" value={number(stock)} sub={`${batches.length} batch(es)`} icon={Boxes} tone={stock === 0 ? 'danger' : 'default'} />
        <KpiCard label="MRP" value={currency(data.mrp ?? data.selling_price, 2)} sub={`PTR ${currency(data.ptr ?? data.purchase_price, 2)}`} icon={PillIcon} />
        <KpiCard
          label="Sales velocity"
          value={`${number(plan?.avgDailySales ?? 0, 1)}/d`}
          sub={plan?.stockCoverageDays === null || plan === null ? 'no recent sales' : `${number(plan?.stockCoverageDays ?? 0, 1)} days cover`}
          icon={TrendingUp}
        />
        <KpiCard label="Reorder level" value={number(data.reorder_level)} sub={`max ${number(data.maximum_stock)}`} icon={Package} />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        {/* ------------------------------------------------------- profile */}
        <Card title="Product profile" bodyClassName="p-4">
          <dl className="space-y-2 text-sm">
            {[
              ['Generic', data.generic_name],
              ['Brand', data.brand_name],
              ['Composition', data.composition],
              ['Manufacturer', data.manufacturer],
              ['Category', data.category],
              ['Dosage form', data.dosage_form],
              ['Strength', data.strength],
              ['Pack size', data.pack_size],
              ['Barcode', data.barcode],
              ['HSN code', data.hsn_code],
              ['Schedule', data.schedule_category],
              ['Storage', data.storage_condition],
              ['Lead time', data.lead_time_days ? `${data.lead_time_days} days` : null],
            ]
              .filter(([, value]) => value)
              .map(([label, value]) => (
                <div key={String(label)} className="flex justify-between gap-3 border-b border-slate-100 pb-1.5">
                  <dt className="text-slate-500">{label}</dt>
                  <dd className="text-right font-medium text-slate-800">{String(value)}</dd>
                </div>
              ))}
            <div className="flex justify-between gap-3 pt-1">
              <dt className="text-slate-500">Prescription</dt>
              <dd>
                {data.prescription_flag === 1 ? (
                  <Pill tone="rose">Rx only</Pill>
                ) : (
                  <Pill tone="emerald">OTC</Pill>
                )}
              </dd>
            </div>
          </dl>

          <div className="mt-4 grid grid-cols-3 gap-2 border-t border-slate-100 pt-3 text-center">
            {[
              ['MRP', data.mrp ?? data.selling_price],
              ['PTR', data.ptr ?? data.purchase_price],
              ['PTS', data.pts ?? 0],
            ].map(([label, value]) => (
              <div key={String(label)}>
                <p className="text-[11px] uppercase tracking-wide text-slate-500">{String(label)}</p>
                <p className="text-sm font-semibold tnum text-slate-900">{currency(Number(value), 2)}</p>
              </div>
            ))}
          </div>
          <p className="mt-2 text-center text-xs text-slate-500">GST {percent(data.tax_rate, 0)}</p>
        </Card>

        {/* -------------------------------------------------------- batches */}
        <Card title="Batches" subtitle="Ordered by expiry — FEFO dispenses top-down" bodyClassName="p-0">
          {batches.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-slate-500">No stock on hand.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-slate-50/70">
                    <th className="th">Batch</th>
                    <th className="th">Expiry</th>
                    <th className="th text-right">Qty</th>
                    <th className="th text-right">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {batches.map((batch) => (
                    <tr key={batch.id} className="table-row">
                      <td className="td font-mono text-xs">{batch.batch_number}</td>
                      <td className="td">{date(batch.expiry_date)}</td>
                      <td className="td text-right tnum">{number(batch.quantity)}</td>
                      <td className="td text-right tnum">{currency(batch.purchase_price, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* ------------------------------------------------------ suppliers */}
        <Card
          title="Supplier options"
          subtitle="Demo distributor network — ranked by effective cost"
          bodyClassName="p-0"
        >
          {!suppliers?.data.length ? (
            <p className="px-4 py-10 text-center text-sm text-slate-500">
              No distributor in the demo network lists this product.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-slate-50/70">
                    <th className="th">Distributor</th>
                    <th className="th text-right">PTR</th>
                    <th className="th">Scheme</th>
                    <th className="th text-right">Effective</th>
                    <th className="th text-right">Stock</th>
                  </tr>
                </thead>
                <tbody>
                  {suppliers.data.slice(0, 8).map((option) => (
                    <tr key={option.distributor_id} className="table-row">
                      <td className="td max-w-[180px]">
                        <Link
                          to={`/procurement/distributors/${option.distributor_id}`}
                          className="block truncate font-medium text-slate-800 hover:text-brand-700"
                        >
                          {option.distributor_name}
                        </Link>
                        <span className="text-xs text-slate-500">{option.delivery_days}d · {option.payment_terms}</span>
                      </td>
                      <td className="td text-right tnum">{currency(option.ptr, 2)}</td>
                      <td className="td">
                        <Pill tone={option.scheme_label === 'No scheme' ? 'slate' : 'emerald'}>
                          {option.scheme_label}
                        </Pill>
                      </td>
                      <td className={`td text-right tnum font-medium ${option.isBest ? 'text-emerald-600' : ''}`}>
                        {currency(option.effective_cost, 2)}
                      </td>
                      <td className="td text-right tnum">{number(option.available_qty)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <p className="mt-4 text-xs leading-relaxed text-slate-400">
        Effective cost is the net payable divided by units actually received, free goods included —
        so the cheapest source here is often not the one quoting the lowest PTR. All distributor
        prices, schemes and stock figures are <strong>synthetic demo data</strong>.
      </p>
    </>
  );
}
