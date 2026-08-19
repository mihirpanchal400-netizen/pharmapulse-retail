import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  Boxes,
  IndianRupee,
  Percent,
  Receipt,
  RefreshCcw,
  TrendingUp,
} from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { Card, ErrorState, KpiCard, LoadingBlock, PageHeader, Pill, SegmentedControl, StockBadge } from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { CategoryBarChart, MarginTrendChart, PaymentMixChart, SalesTrendChart, SimpleBarChart } from '../charts';
import { currency, currencyCompact, date, month, number, percent, percentSigned } from '../utils/format';
import type { CategorySales, GrowthComparison, ProductPerformance, TrendPoint } from '../types';

/**
 * ANALYTICS
 * =========
 *
 * Four views over the same measurement layer the dashboard and the CSV reports
 * use, so no two screens can disagree. Each carries the definition it is
 * measuring against, because a number without its definition is not a fact.
 */

const WINDOWS = [
  { label: '7 days', value: 7 },
  { label: '30 days', value: 30 },
  { label: '90 days', value: 90 },
  { label: '180 days', value: 180 },
];

function Shell({
  title,
  subtitle,
  days,
  setDays,
  error,
  loading,
  ready,
  children,
  footnote,
}: {
  title: string;
  subtitle: string;
  days: number;
  setDays: (d: number) => void;
  error: string | null;
  loading: boolean;
  ready: boolean;
  children: React.ReactNode;
  footnote: string;
}) {
  return (
    <>
      <PageHeader
        title={title}
        subtitle={subtitle}
        actions={<SegmentedControl options={WINDOWS} value={days} onChange={setDays} />}
      />
      {error ? (
        <Card>
          <ErrorState message={error} />
        </Card>
      ) : !ready && loading ? (
        <Card>
          <LoadingBlock rows={8} />
        </Card>
      ) : (
        <>
          {children}
          <p className="mt-6 text-xs leading-relaxed text-slate-400">{footnote}</p>
        </>
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Sales analytics                                                             */
/* -------------------------------------------------------------------------- */

interface SalesAnalyticsData {
  windowDays: number;
  growth: GrowthComparison;
  trend: TrendPoint[];
  monthly: { month: string; revenue: number; grossProfit: number; transactions: number; units: number }[];
  categories: CategorySales[];
  weekday: { day: string; fullDay: string; revenue: number; transactions: number }[];
  paymentMix: { method: string; transactions: number; value: number; sharePct: number }[];
  concentration: {
    top5: { concentrationPct: number; topRevenue: number; totalRevenue: number; products: { id: number; product_name: string; revenue: number; sharePct: number }[] };
    top10: { concentrationPct: number };
    top20: { concentrationPct: number };
  };
}

export function SalesAnalytics() {
  const [days, setDays] = useState(30);
  const { data, error, loading } = useApi<SalesAnalyticsData>('/analytics/sales', { days });

  return (
    <Shell
      title="Sales Analytics"
      subtitle={`Revenue, growth and mix over the last ${days} days against the preceding ${days}`}
      days={days}
      setDays={setDays}
      error={error}
      loading={loading}
      ready={Boolean(data)}
      footnote="Revenue is net of tax and net of returns — tax collected is not the pharmacy's income, and a returned unit was not really sold. Growth compares the trailing window with the immediately preceding window of equal length."
    >
      {data && (
        <>
          <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Revenue" value={currencyCompact(data.growth.current.revenue)} change={data.growth.revenueGrowthPct} sub="vs previous period" icon={IndianRupee} />
            <KpiCard label="Transactions" value={number(data.growth.current.transactions)} change={data.growth.transactionGrowthPct} sub="bills raised" icon={Receipt} />
            <KpiCard label="Average bill" value={currency(data.growth.current.averageBillValue)} sub={`${number(data.growth.current.averageUnitsPerBill, 1)} units per bill`} icon={TrendingUp} />
            <KpiCard label="Units sold" value={number(data.growth.current.unitsSold)} sub="net of returns" icon={Boxes} />
          </div>

          <div className="grid gap-4 xl:grid-cols-3">
            <Card title="Daily revenue and gross profit" className="xl:col-span-2" bodyClassName="p-4">
              <SalesTrendChart data={data.trend} height={300} />
            </Card>
            <Card title="Payment mix" subtitle={`How customers paid, last ${days} days`} bodyClassName="p-4">
              <PaymentMixChart data={data.paymentMix.map((p) => ({ method: p.method, value: p.value }))} height={300} />
            </Card>
          </div>

          <div className="mt-4 grid gap-4 xl:grid-cols-2">
            <Card title="Category performance" bodyClassName="p-4">
              <CategoryBarChart data={data.categories.slice(0, 10)} height={320} />
            </Card>

            <Card title="Weekday pattern" subtitle="Which days carry the shop (90-day basis)" bodyClassName="p-4">
              <SimpleBarChart
                data={data.weekday as unknown as Record<string, unknown>[]}
                xKey="day"
                bars={[{ key: 'revenue', name: 'Revenue', color: '#279492' }]}
                height={320}
              />
            </Card>
          </div>

          <div className="mt-4 grid gap-4 xl:grid-cols-2">
            <Card title="Monthly trend" subtitle="Revenue and gross profit by month" bodyClassName="p-4">
              <SimpleBarChart
                data={data.monthly.map((m) => ({ ...m, label: month(m.month) }))}
                xKey="label"
                bars={[
                  { key: 'revenue', name: 'Revenue', color: '#279492' },
                  { key: 'grossProfit', name: 'Gross profit', color: '#93c5fd' },
                ]}
                height={300}
              />
            </Card>

            <Card
              title="Revenue concentration"
              subtitle="How much of the business rests on how few products"
              bodyClassName="p-4"
            >
              <div className="grid grid-cols-3 gap-3 text-center">
                {[
                  ['Top 5', data.concentration.top5.concentrationPct],
                  ['Top 10', data.concentration.top10.concentrationPct],
                  ['Top 20', data.concentration.top20.concentrationPct],
                ].map(([label, value]) => (
                  <div key={String(label)} className="rounded-lg bg-slate-50 p-3">
                    <p className="text-xs uppercase tracking-wide text-slate-500">{String(label)}</p>
                    <p className="mt-1 text-xl font-semibold tnum text-slate-900">{percent(Number(value))}</p>
                  </div>
                ))}
              </div>

              <ul className="mt-4 space-y-1.5 border-t border-slate-100 pt-3">
                {data.concentration.top5.products.slice(0, 5).map((p, i) => (
                  <li key={p.id} className="flex items-center justify-between gap-3 text-sm">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="w-4 shrink-0 text-xs text-slate-400">#{i + 1}</span>
                      <Link to={`/inventory/products/${p.id}`} className="truncate text-slate-700 hover:text-brand-700">
                        {p.product_name}
                      </Link>
                    </span>
                    <span className="shrink-0 tnum text-slate-600">
                      {currency(p.revenue)} <span className="text-xs text-slate-400">({percent(p.sharePct)})</span>
                    </span>
                  </li>
                ))}
              </ul>

              {data.concentration.top5.concentrationPct >= 40 && (
                <p className="mt-3 flex items-start gap-1.5 rounded-lg bg-amber-50 p-2.5 text-xs text-amber-800">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  Top 5 products carry {percent(data.concentration.top5.concentrationPct)} of revenue. A
                  stock-out in any one of them hits the business disproportionately.
                </p>
              )}
            </Card>
          </div>
        </>
      )}
    </Shell>
  );
}

/* -------------------------------------------------------------------------- */
/* Product analytics                                                           */
/* -------------------------------------------------------------------------- */

interface ProductAnalyticsData {
  windowDays: number;
  performance: ProductPerformance[];
  fastMoving: ProductPerformance[];
  slowMoving: ProductPerformance[];
  deadStock: ProductPerformance[];
  topProducts: ProductPerformance[];
}

const ABC_TONE: Record<string, string> = { A: 'emerald', B: 'amber', C: 'slate' };

export function ProductAnalytics() {
  const [days, setDays] = useState(30);
  const [view, setView] = useState<'all' | 'fast' | 'slow' | 'dead'>('all');
  const { data, error, loading } = useApi<ProductAnalyticsData>('/analytics/products', { days });

  const rows =
    view === 'fast' ? data?.fastMoving ?? []
    : view === 'slow' ? data?.slowMoving ?? []
    : view === 'dead' ? data?.deadStock ?? []
    : data?.performance ?? [];

  const columns: Column<ProductPerformance>[] = [
    {
      key: 'product',
      header: 'Product',
      render: (r) => (
        <div className="max-w-[240px]">
          <Link to={`/inventory/products/${r.id}`} className="block truncate font-medium text-slate-800 hover:text-brand-700">
            {r.product_name}
          </Link>
          <span className="text-xs text-slate-500">{r.category}</span>
        </div>
      ),
    },
    { key: 'abc', header: 'ABC', render: (r) => <Pill tone={ABC_TONE[r.abcClass]}>{r.abcClass}</Pill> },
    { key: 'units', header: 'Units', align: 'right', render: (r) => number(r.unitsSold) },
    { key: 'revenue', header: 'Revenue', align: 'right', render: (r) => currency(r.revenue) },
    {
      key: 'growth',
      header: 'Growth',
      align: 'right',
      secondary: true,
      render: (r) => (
        <span className={r.revenueGrowthPct > 0 ? 'text-emerald-600' : r.revenueGrowthPct < 0 ? 'text-rose-600' : ''}>
          {percentSigned(r.revenueGrowthPct)}
        </span>
      ),
    },
    { key: 'profit', header: 'Gross profit', align: 'right', render: (r) => currency(r.grossProfit) },
    { key: 'margin', header: 'Margin', align: 'right', render: (r) => percent(r.marginPct) },
    { key: 'velocity', header: 'Velocity', align: 'right', secondary: true, render: (r) => `${number(r.salesVelocity, 1)}/d` },
    { key: 'stock', header: 'Stock', align: 'right', render: (r) => number(r.currentStock) },
    {
      key: 'coverage',
      header: 'Coverage',
      align: 'right',
      render: (r) => (r.stockCoverageDays === null ? '—' : `${number(r.stockCoverageDays, 1)}d`),
    },
    { key: 'status', header: 'Status', render: (r) => <StockBadge status={r.stockStatus} /> },
    {
      key: 'score',
      header: 'Score',
      align: 'right',
      secondary: true,
      render: (r) => <span className="font-medium tnum">{number(r.performanceScore, 1)}</span>,
    },
  ];

  const deadValue = (data?.deadStock ?? []).reduce((s, p) => s + p.inventoryValue, 0);

  return (
    <Shell
      title="Product Analytics"
      subtitle={`Performance, velocity and ABC class over the last ${days} days`}
      days={days}
      setDays={setDays}
      error={error}
      loading={loading}
      ready={Boolean(data)}
      footnote="ABC class is by revenue contribution: A is the top 80%, B the next 15%, C the last 5%. Fast-moving is a percentile within this catalogue rather than an absolute cut-off — 5 units a day is fast for a cardiac drug and slow for paracetamol. The performance score weights velocity, revenue, profit and margin, then deducts inventory-risk penalties."
    >
      {data && (
        <>
          <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Products sold" value={number(data.performance.filter((p) => p.unitsSold > 0).length)} sub={`of ${number(data.performance.length)} in catalogue`} icon={Boxes} />
            <KpiCard label="Fast movers" value={number(data.fastMoving.length)} sub="top velocity decile" icon={TrendingUp} tone="success" />
            <KpiCard label="Slow movers" value={number(data.slowMoving.length)} sub="sold, but barely" icon={RefreshCcw} tone="warning" />
            <KpiCard label="Dead stock" value={number(data.deadStock.length)} sub={`${currencyCompact(deadValue)} trapped`} icon={AlertTriangle} tone={data.deadStock.length > 0 ? 'danger' : 'default'} />
          </div>

          <Card bodyClassName="p-0">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-4">
              <SegmentedControl
                options={[
                  { label: `All (${data.performance.length})`, value: 'all' },
                  { label: `Fast (${data.fastMoving.length})`, value: 'fast' },
                  { label: `Slow (${data.slowMoving.length})`, value: 'slow' },
                  { label: `Dead (${data.deadStock.length})`, value: 'dead' },
                ]}
                value={view}
                onChange={(v) => setView(v as typeof view)}
              />
              <p className="text-xs text-slate-500">{number(rows.length)} product(s)</p>
            </div>

            <DataTable
              columns={columns}
              rows={rows.slice(0, 100)}
              rowKey={(row) => row.id}
              emptyTitle="Nothing in this view"
              emptyMessage={view === 'dead' ? 'No product has stock sitting unsold past the dead-stock threshold.' : 'No products match.'}
            />
          </Card>
        </>
      )}
    </Shell>
  );
}

/* -------------------------------------------------------------------------- */
/* Inventory analytics                                                         */
/* -------------------------------------------------------------------------- */

interface InventoryAnalyticsData {
  summary: {
    totalSkus: number;
    activeSkus: number;
    totalUnits: number;
    inventoryValueAtCost: number;
    inventoryValueAtRetail: number;
    potentialMargin: number;
    outOfStock: number;
    lowStock: number;
    overstock: number;
    healthy: number;
    expiring: number;
    deadStockCount: number;
    deadStockValue: number;
  };
  health: { score: number; grade: string; penalties: { reason: string; points: number; detail: string }[]; formula: string };
  turnover: {
    windowDays: number;
    cogs: number;
    averageInventory: number;
    turnover: number;
    annualisedTurnover: number;
    daysOfInventory: number | null;
    method: string;
  };
  byCategory: { category: string; value: number; units: number; skus: number; sharePct: number }[];
  valueConcentration: { topN: number; concentrationPct: number; products: { id: number; product_name: string; inventoryValue: number; sharePct: number }[] };
  reorderList: { id: number; product_name: string; current_stock: number; suggestedOrderQty: number; stock_coverage_days: number | null }[];
}

export function InventoryAnalytics() {
  const [days, setDays] = useState(90);
  const { data, error, loading } = useApi<InventoryAnalyticsData>('/analytics/inventory', { days });

  const gradeTone: Record<string, 'success' | 'warning' | 'danger' | 'default'> = {
    EXCELLENT: 'success',
    GOOD: 'success',
    FAIR: 'warning',
    POOR: 'danger',
  };

  return (
    <Shell
      title="Inventory Analytics"
      subtitle="Turnover, coverage, concentration and health"
      days={days}
      setDays={setDays}
      error={error}
      loading={loading}
      ready={Boolean(data)}
      footnote="Turnover is COGS divided by average inventory at cost, annualised for interpretability. A retail pharmacy typically targets 8–12 turns; below about 6 suggests over-buying, above 15 suggests stock-outs are likely. Average inventory is reconstructed from the movement ledger rather than nightly snapshots, so it is approximate on a young database — the method is reported alongside the figure."
    >
      {data && (
        <>
          <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Inventory at cost" value={currencyCompact(data.summary.inventoryValueAtCost)} sub={`${number(data.summary.totalUnits)} units`} icon={IndianRupee} />
            <KpiCard label="Annualised turnover" value={`${number(data.turnover.annualisedTurnover, 1)}x`} sub={data.turnover.daysOfInventory !== null ? `${number(data.turnover.daysOfInventory)} days of stock` : ''} icon={RefreshCcw} tone={data.turnover.annualisedTurnover < 6 ? 'warning' : 'success'} />
            <KpiCard label="Health score" value={`${number(data.health.score, 1)}/100`} sub={data.health.grade.toLowerCase()} icon={Activity} tone={gradeTone[data.health.grade] ?? 'default'} />
            <KpiCard label="Dead stock" value={number(data.summary.deadStockCount)} sub={`${currencyCompact(data.summary.deadStockValue)} trapped`} icon={AlertTriangle} tone={data.summary.deadStockCount > 0 ? 'warning' : 'default'} />
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <Card title="Health score breakdown" subtitle={data.health.formula} bodyClassName="p-4">
              <div className="mb-4 flex items-baseline gap-2">
                <span className="text-3xl font-semibold tnum text-slate-900">{number(data.health.score, 1)}</span>
                <span className="text-sm text-slate-500">/ 100 · {data.health.grade.toLowerCase()}</span>
              </div>
              {data.health.penalties.length === 0 ? (
                <p className="text-sm text-slate-500">No penalties — every SKU is in a healthy state.</p>
              ) : (
                <ul className="space-y-2">
                  {data.health.penalties.map((penalty) => (
                    <li key={penalty.reason} className="flex items-start justify-between gap-3 border-b border-slate-100 pb-2">
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-slate-800">{penalty.reason}</span>
                        <span className="block text-xs text-slate-500">{penalty.detail}</span>
                      </span>
                      <span className="shrink-0 text-sm font-semibold tnum text-rose-600">
                        −{number(penalty.points, 1)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title="Capital by category" subtitle="Where the money actually sits" bodyClassName="p-4">
              <SimpleBarChart
                data={data.byCategory.slice(0, 10) as unknown as Record<string, unknown>[]}
                xKey="category"
                bars={[{ key: 'value', name: 'Value at cost', color: '#279492' }]}
                height={300}
              />
            </Card>
          </div>

          <div className="mt-4 grid gap-4 xl:grid-cols-2">
            <Card title="Stock status mix" bodyClassName="p-4">
              <dl className="space-y-2">
                {[
                  ['Healthy', data.summary.healthy, 'bg-emerald-500'],
                  ['Low stock', data.summary.lowStock, 'bg-amber-400'],
                  ['Out of stock', data.summary.outOfStock, 'bg-rose-500'],
                  ['Overstocked', data.summary.overstock, 'bg-sky-500'],
                  ['Expiring', data.summary.expiring, 'bg-orange-500'],
                ].map(([label, value, color]) => {
                  const pct = data.summary.activeSkus > 0 ? (Number(value) / data.summary.activeSkus) * 100 : 0;
                  return (
                    <div key={String(label)}>
                      <div className="flex justify-between text-sm">
                        <dt className="text-slate-600">{String(label)}</dt>
                        <dd className="tnum font-medium text-slate-800">
                          {number(Number(value))} <span className="text-xs text-slate-400">({percent(pct)})</span>
                        </dd>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100">
                        <div className={`h-full ${String(color)}`} style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </dl>
            </Card>

            <Card title={`Value concentration — top ${data.valueConcentration.topN}`} subtitle={`${percent(data.valueConcentration.concentrationPct)} of stock value`} bodyClassName="p-4">
              <ul className="space-y-1.5">
                {data.valueConcentration.products.slice(0, 10).map((p, i) => (
                  <li key={p.id} className="flex items-center justify-between gap-3 text-sm">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="w-4 shrink-0 text-xs text-slate-400">#{i + 1}</span>
                      <Link to={`/inventory/products/${p.id}`} className="truncate text-slate-700 hover:text-brand-700">
                        {p.product_name}
                      </Link>
                    </span>
                    <span className="shrink-0 tnum text-slate-600">
                      {currency(p.inventoryValue)} <span className="text-xs text-slate-400">({percent(p.sharePct)})</span>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </>
      )}
    </Shell>
  );
}

/* -------------------------------------------------------------------------- */
/* Profit analytics                                                            */
/* -------------------------------------------------------------------------- */

interface ProfitAnalyticsData {
  windowDays: number;
  comparison: {
    current: { revenue: number; cogs: number; grossProfit: number; grossMarginPct: number; unitsSold: number; transactions: number; profitPerTransaction: number; profitPerUnit: number; discount: number; tax: number };
    previous: { revenue: number; grossProfit: number; grossMarginPct: number };
    revenueGrowthPct: number;
    profitGrowthPct: number;
    marginChangePoints: number;
  };
  trend: { date: string; revenue: number; cogs: number; grossProfit: number; marginPct: number }[];
  byCategory: { category: string; revenue: number; cogs: number; grossProfit: number; marginPct: number; units: number; profitSharePct: number; revenueSharePct: number; profitGrowthPct: number }[];
  byProduct: { id: number; product_name: string; category: string; revenue: number; cogs: number; grossProfit: number; marginPct: number; units: number; profitSharePct: number }[];
  marginDistribution: { label: string; products: number; revenue: number; grossProfit: number }[];
}

export function ProfitAnalytics() {
  const [days, setDays] = useState(30);
  const { data, error, loading } = useApi<ProfitAnalyticsData>('/analytics/profit', { days });

  const categoryColumns: Column<ProfitAnalyticsData['byCategory'][number]>[] = [
    { key: 'category', header: 'Category', render: (r) => <span className="font-medium text-slate-800">{r.category}</span> },
    { key: 'units', header: 'Units', align: 'right', secondary: true, render: (r) => number(r.units) },
    { key: 'revenue', header: 'Revenue', align: 'right', render: (r) => currency(r.revenue) },
    { key: 'cogs', header: 'COGS', align: 'right', secondary: true, render: (r) => currency(r.cogs) },
    { key: 'profit', header: 'Gross profit', align: 'right', render: (r) => currency(r.grossProfit) },
    { key: 'margin', header: 'Margin', align: 'right', render: (r) => percent(r.marginPct) },
    {
      key: 'share',
      header: 'Revenue vs profit share',
      render: (r) => (
        <span className="text-xs">
          <span className="text-slate-500">{percent(r.revenueSharePct)} rev</span>
          {' · '}
          <span className={r.profitSharePct >= r.revenueSharePct ? 'font-medium text-emerald-600' : 'font-medium text-rose-600'}>
            {percent(r.profitSharePct)} profit
          </span>
        </span>
      ),
    },
    {
      key: 'growth',
      header: 'Profit growth',
      align: 'right',
      render: (r) => (
        <span className={r.profitGrowthPct > 0 ? 'text-emerald-600' : r.profitGrowthPct < 0 ? 'text-rose-600' : ''}>
          {percentSigned(r.profitGrowthPct)}
        </span>
      ),
    },
  ];

  return (
    <Shell
      title="Profit Analytics"
      subtitle={`Gross margin by category and product, last ${days} days`}
      days={days}
      setDays={setDays}
      error={error}
      loading={loading}
      ready={Boolean(data)}
      footnote="This is GROSS profit only — revenue minus cost of goods sold. Rent, salaries, electricity, licence fees and shrinkage are not modelled, so nothing here is net profit. COGS uses the cost of the specific batch dispensed, not a product-level average, which is what makes the figure accurate when the same product was bought at different prices. Margin change is stated in percentage POINTS, not percent."
    >
      {data && (
        <>
          <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Revenue" value={currencyCompact(data.comparison.current.revenue)} change={data.comparison.revenueGrowthPct} sub="net of tax and returns" icon={IndianRupee} />
            <KpiCard label="Gross profit" value={currencyCompact(data.comparison.current.grossProfit)} change={data.comparison.profitGrowthPct} sub={`COGS ${currencyCompact(data.comparison.current.cogs)}`} icon={TrendingUp} />
            <KpiCard
              label="Gross margin"
              value={percent(data.comparison.current.grossMarginPct)}
              sub={`${data.comparison.marginChangePoints >= 0 ? '+' : ''}${number(data.comparison.marginChangePoints, 1)} points vs previous`}
              icon={Percent}
              tone={data.comparison.marginChangePoints < -2 ? 'danger' : data.comparison.marginChangePoints < 0 ? 'warning' : 'success'}
            />
            <KpiCard label="Profit per bill" value={currency(data.comparison.current.profitPerTransaction)} sub={`${currency(data.comparison.current.profitPerUnit, 2)} per unit`} icon={Receipt} />
          </div>

          <div className="grid gap-4 xl:grid-cols-3">
            <Card title="Margin trend" subtitle="Daily gross margin percentage" className="xl:col-span-2" bodyClassName="p-4">
              <MarginTrendChart data={data.trend} height={300} />
            </Card>

            <Card title="Margin distribution" subtitle="Products grouped by margin band" bodyClassName="p-4">
              <ul className="space-y-2">
                {data.marginDistribution.map((bucket) => (
                  <li key={bucket.label} className="flex items-center justify-between gap-3 border-b border-slate-100 pb-2 text-sm">
                    <span className={bucket.label === 'Loss making' ? 'font-medium text-rose-600' : 'text-slate-600'}>
                      {bucket.label}
                    </span>
                    <span className="text-right">
                      <span className="block tnum font-medium text-slate-800">{number(bucket.products)} products</span>
                      <span className="block text-xs tnum text-slate-500">{currency(bucket.grossProfit)} profit</span>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>

          <Card className="mt-4" title="Profit by category" subtitle="Where revenue share and profit share disagree is where the insight is" bodyClassName="p-0">
            <DataTable columns={categoryColumns} rows={data.byCategory} rowKey={(r) => r.category} emptyTitle="No sales in this period" />
          </Card>

          <Card className="mt-4" title="Most profitable products" subtitle={`Top ${data.byProduct.length} by gross profit`} bodyClassName="p-0">
            <DataTable
              columns={[
                {
                  key: 'product',
                  header: 'Product',
                  render: (r) => (
                    <div className="max-w-[260px]">
                      <Link to={`/inventory/products/${r.id}`} className="block truncate font-medium text-slate-800 hover:text-brand-700">
                        {r.product_name}
                      </Link>
                      <span className="text-xs text-slate-500">{r.category}</span>
                    </div>
                  ),
                },
                { key: 'units', header: 'Units', align: 'right', render: (r) => number(r.units) },
                { key: 'revenue', header: 'Revenue', align: 'right', render: (r) => currency(r.revenue) },
                { key: 'cogs', header: 'COGS', align: 'right', secondary: true, render: (r) => currency(r.cogs) },
                { key: 'profit', header: 'Gross profit', align: 'right', render: (r) => <span className="font-medium tnum">{currency(r.grossProfit)}</span> },
                { key: 'margin', header: 'Margin', align: 'right', render: (r) => percent(r.marginPct) },
                { key: 'share', header: 'Profit share', align: 'right', secondary: true, render: (r) => percent(r.profitSharePct) },
              ] as Column<ProfitAnalyticsData['byProduct'][number]>[]}
              rows={data.byProduct}
              rowKey={(r) => r.id}
              emptyTitle="No sales in this period"
            />
          </Card>
        </>
      )}
    </Shell>
  );
}
