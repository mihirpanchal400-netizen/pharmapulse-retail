import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Check, GitCompare, ShoppingCart, Truck } from 'lucide-react';
import { useApi, useDebounced } from '../hooks/useApi';
import { useCart } from '../hooks/useCart';
import { Card, KpiCard, PageHeader, Pill, SegmentedControl } from '../components/ui';
import { DataTable, SearchInput, Select, type Column } from '../components/DataTable';
import { currency, currencyCompact, number } from '../utils/format';

/**
 * REPLENISHMENT CENTER
 * ====================
 *
 * The screen that closes the loop between "stock is low" and "order placed".
 *
 * Every row already carries the suggested quantity, the cheapest distributor by
 * effective cost, the scheme that quantity earns, and what the line will cost -
 * so the decision to buy can be made without leaving the page.
 */

interface ReplenishmentLine {
  productId: number;
  productCode: string;
  productName: string;
  genericName: string | null;
  category: string;
  packSize: string | null;
  currentStock: number;
  reorderLevel: number;
  maximumStock: number;
  avgDailySales: number;
  stockCoverageDays: number | null;
  leadTimeDays: number;
  requiredQty: number;
  suggestedQty: number;
  schemeFreeQty: number;
  quantityNote: string;
  lastPurchasePrice: number;
  urgency: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  reason: string;
  supplier: {
    distributorId: number;
    name: string;
    ptr: number;
    schemeLabel: string;
    effectiveCost: number;
    availableQty: number;
    deliveryDays: number;
    canFulfil: boolean;
    estimatedCost: number;
    savings: number;
  } | null;
}

interface PlanResponse {
  lines: ReplenishmentLine[];
  summary: {
    products: number;
    critical: number;
    high: number;
    outOfStock: number;
    estimatedCost: number;
    estimatedSavings: number;
    unsourced: number;
  };
}

const URGENCY_TONE: Record<string, string> = {
  CRITICAL: 'rose',
  HIGH: 'amber',
  MEDIUM: 'slate',
  LOW: 'slate',
};

const URGENCY_FILTERS = [
  { label: 'All', value: 'ALL' },
  { label: 'Critical', value: 'CRITICAL' },
  { label: 'High', value: 'HIGH' },
  { label: 'Medium', value: 'MEDIUM' },
];

export default function Replenishment() {
  const [search, setSearch] = useState('');
  const [urgency, setUrgency] = useState('ALL');
  const [category, setCategory] = useState('ALL');
  const debounced = useDebounced(search);
  const cart = useCart();

  const { data, error, loading, reload } = useApi<PlanResponse>('/procurement/replenishment', {
    search: debounced || undefined,
    urgency: urgency === 'ALL' ? undefined : urgency,
    category: category === 'ALL' ? undefined : category,
  });

  const categories = useMemo(() => {
    const set = new Set((data?.lines ?? []).map((l) => l.category));
    return [
      { label: 'All categories', value: 'ALL' },
      ...[...set].sort().map((c) => ({ label: c, value: c })),
    ];
  }, [data]);

  function addToCart(line: ReplenishmentLine) {
    if (!line.supplier) return;
    cart.add({
      productId: line.productId,
      productName: line.productName,
      productCode: line.productCode,
      packSize: line.packSize,
      distributorId: line.supplier.distributorId,
      distributorName: line.supplier.name,
      quantity: line.suggestedQty,
      ptr: line.supplier.ptr,
      // The label is authoritative for display; the server re-derives the
      // arithmetic from the distributor's catalogue when the PO is created.
      schemeBuyQty: 0,
      schemeFreeQty: 0,
      discountPct: 0,
      schemeLabel: line.supplier.schemeLabel,
      effectiveCost: line.supplier.effectiveCost,
      availableQty: line.supplier.availableQty,
      addedFrom: 'Replenishment Center',
    });
  }

  function addAllCritical() {
    (data?.lines ?? [])
      .filter((l) => (l.urgency === 'CRITICAL' || l.urgency === 'HIGH') && l.supplier?.canFulfil)
      .forEach(addToCart);
  }

  const columns: Column<ReplenishmentLine>[] = [
    {
      key: 'product',
      header: 'Product',
      render: (row) => (
        <div className="max-w-[240px]">
          <Link
            to={`/inventory/products/${row.productId}`}
            className="block truncate font-medium text-slate-800 hover:text-brand-700"
          >
            {row.productName}
          </Link>
          <span className="text-xs text-slate-500">
            {row.genericName ?? row.category}
            {row.packSize ? ` · ${row.packSize}` : ''}
          </span>
        </div>
      ),
    },
    {
      key: 'urgency',
      header: 'Urgency',
      render: (row) => <Pill tone={URGENCY_TONE[row.urgency]}>{row.urgency}</Pill>,
    },
    {
      key: 'stock',
      header: 'Stock',
      align: 'right',
      render: (row) => (
        <span className={row.currentStock === 0 ? 'font-semibold text-rose-600' : ''}>
          {number(row.currentStock)}
        </span>
      ),
    },
    {
      key: 'velocity',
      header: 'Daily sales',
      align: 'right',
      secondary: true,
      render: (row) => `${number(row.avgDailySales, 1)}`,
    },
    {
      key: 'coverage',
      header: 'Coverage',
      align: 'right',
      render: (row) => (
        <span className={(row.stockCoverageDays ?? 99) <= row.leadTimeDays ? 'font-semibold text-rose-600' : ''}>
          {row.stockCoverageDays === null ? '—' : `${number(row.stockCoverageDays, 1)}d`}
        </span>
      ),
    },
    {
      key: 'reorder',
      header: 'Reorder at',
      align: 'right',
      secondary: true,
      render: (row) => number(row.reorderLevel),
    },
    {
      key: 'suggested',
      header: 'Order',
      align: 'right',
      render: (row) => (
        <div>
          <span className="font-semibold text-slate-900">{number(row.suggestedQty)}</span>
          {row.schemeFreeQty > 0 && (
            <span className="ml-1 text-xs font-medium text-emerald-600">+{row.schemeFreeQty}</span>
          )}
        </div>
      ),
    },
    {
      key: 'supplier',
      header: 'Best source',
      render: (row) =>
        row.supplier ? (
          <div className="max-w-[200px]">
            <Link
              to={`/procurement/distributors/${row.supplier.distributorId}`}
              className="block truncate text-sm font-medium text-slate-800 hover:text-brand-700"
            >
              {row.supplier.name}
            </Link>
            <span className="text-xs text-slate-500">
              {row.supplier.schemeLabel} · {row.supplier.deliveryDays}d
              {!row.supplier.canFulfil && (
                <span className="ml-1 font-medium text-amber-600">short stock</span>
              )}
            </span>
          </div>
        ) : (
          <span className="text-xs text-slate-400">No distributor lists this</span>
        ),
    },
    {
      key: 'cost',
      header: 'Effective',
      align: 'right',
      render: (row) =>
        row.supplier ? (
          <div>
            <span className="font-medium tnum">{currency(row.supplier.effectiveCost, 2)}</span>
            <span className="block text-xs text-slate-500 tnum">
              {currency(row.supplier.estimatedCost)}
            </span>
          </div>
        ) : (
          '—'
        ),
    },
    {
      key: 'action',
      header: '',
      align: 'right',
      render: (row) => {
        const inCart = row.supplier ? cart.has(row.productId, row.supplier.distributorId) : false;
        return (
          <div className="flex justify-end gap-1">
            <Link
              to={`/procurement/compare?productId=${row.productId}&quantity=${row.suggestedQty}`}
              className="btn-ghost px-2 py-1.5"
              title="Compare suppliers"
              aria-label={`Compare suppliers for ${row.productName}`}
            >
              <GitCompare className="h-4 w-4" aria-hidden />
            </Link>
            <button
              type="button"
              className={inCart ? 'btn-secondary px-2 py-1.5' : 'btn-primary px-2 py-1.5'}
              disabled={!row.supplier}
              onClick={() => addToCart(row)}
              title={inCart ? 'Already in cart — click to add more' : 'Add to procurement cart'}
              aria-label={`Add ${row.productName} to cart`}
            >
              {inCart ? <Check className="h-4 w-4" aria-hidden /> : <ShoppingCart className="h-4 w-4" aria-hidden />}
            </button>
          </div>
        );
      },
    },
  ];

  const summary = data?.summary;

  return (
    <>
      <PageHeader
        title="Replenishment Center"
        subtitle="Products needing purchase, each matched to its cheapest distributor by effective cost"
        actions={
          <>
            <Link to="/procurement/cart" className="btn-secondary">
              <ShoppingCart className="h-4 w-4" aria-hidden />
              Cart {cart.count > 0 && <span className="ml-1 rounded-full bg-brand-600 px-1.5 text-xs text-white">{cart.count}</span>}
            </Link>
            <button
              type="button"
              className="btn-primary"
              onClick={addAllCritical}
              disabled={!summary || summary.critical + summary.high === 0}
            >
              Add all urgent to cart
            </button>
          </>
        }
      />

      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Need replenishment"
          value={number(summary?.products ?? 0)}
          sub={`${number(summary?.outOfStock ?? 0)} already out of stock`}
          icon={AlertTriangle}
          tone={(summary?.products ?? 0) > 0 ? 'warning' : 'default'}
        />
        <KpiCard
          label="Critical"
          value={number(summary?.critical ?? 0)}
          sub="will run out inside the lead time"
          icon={AlertTriangle}
          tone={(summary?.critical ?? 0) > 0 ? 'danger' : 'default'}
        />
        <KpiCard
          label="Estimated basket"
          value={currencyCompact(summary?.estimatedCost ?? 0)}
          sub="at best effective cost"
          icon={Truck}
        />
        <KpiCard
          label="Scheme savings"
          value={currencyCompact(summary?.estimatedSavings ?? 0)}
          sub="from free goods and discounts"
          icon={Check}
          tone="success"
        />
      </div>

      <Card bodyClassName="p-0">
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-4">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search product, generic or code…"
            className="min-w-[240px] flex-1"
          />
          <Select value={category} onChange={setCategory} options={categories} label="Category" className="w-auto" />
          <SegmentedControl options={URGENCY_FILTERS} value={urgency} onChange={setUrgency} />
        </div>

        <DataTable
          columns={columns}
          rows={data?.lines ?? []}
          rowKey={(row) => row.productId}
          loading={loading}
          error={error}
          onRetry={reload}
          emptyTitle="Nothing needs replenishing"
          emptyMessage="Every active product is above its reorder level. Adjust the filters or lower a reorder level to see more."
        />
      </Card>

      {summary && summary.unsourced > 0 && (
        <p className="mt-3 flex items-start gap-1.5 text-xs text-amber-700">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {summary.unsourced} product(s) have no distributor listing in the demo network, so no
          source or cost is shown for them. Add them to a distributor catalogue to get a
          recommendation.
        </p>
      )}

      <p className="mt-4 text-xs leading-relaxed text-slate-400">
        Suggested quantity tops stock back up to its maximum level, then rounds up to the nearest
        scheme boundary where the extra units are worth the free goods. Effective cost is the net
        payable divided by units actually received, free goods included — which is why the cheapest
        source here is often not the one with the lowest headline PTR. Distributor prices,
        schemes and availability are <strong>demo data</strong>.
      </p>
    </>
  );
}
