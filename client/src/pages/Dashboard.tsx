import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  Boxes,
  CalendarClock,
  IndianRupee,
  Percent,
  Receipt,
  TrendingUp,
  Zap,
} from 'lucide-react';
import { useApi } from '../hooks/useApi';
import {
  Card,
  ErrorState,
  KpiCard,
  LoadingBlock,
  PageHeader,
  SegmentedControl,
  StockBadge,
  ViewLink,
} from '../components/ui';
import { InsightCard } from '../components/InsightCard';
import { CategoryBarChart, InventoryHealthChart, SalesTrendChart } from '../charts';
import { currency, currencyCompact, number, percent, percentSigned } from '../utils/format';
import type { DashboardData } from '../types';

const WINDOWS = [
  { label: '7 days', value: 7 },
  { label: '30 days', value: 30 },
  { label: '90 days', value: 90 },
];

export default function Dashboard() {
  const [days, setDays] = useState(30);
  const { data, error, loading, reload } = useApi<DashboardData>('/analytics/dashboard', { days });

  if (error) {
    return (
      <>
        <PageHeader title="Dashboard" />
        <Card>
          <ErrorState message={error} onRetry={reload} />
        </Card>
      </>
    );
  }

  if (loading && !data) {
    return (
      <>
        <PageHeader title="Dashboard" subtitle="Loading your pharmacy's position…" />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="card p-4">
              <LoadingBlock rows={2} />
            </div>
          ))}
        </div>
      </>
    );
  }

  if (!data) return null;

  const { today, growth, trend, categories, topProducts, inventory, health, insights } = data;

  const healthSegments = [
    { name: 'Healthy', value: inventory.healthy, color: '#10b981' },
    { name: 'Low stock', value: inventory.lowStock, color: '#f59e0b' },
    { name: 'Out of stock', value: inventory.outOfStock, color: '#ef4444' },
    { name: 'Overstocked', value: inventory.overstock, color: '#0ea5e9' },
    { name: 'Expiring', value: inventory.expiring, color: '#f97316' },
  ].filter((segment) => segment.value > 0);

  const gradeTone: Record<string, 'success' | 'default' | 'warning' | 'danger'> = {
    EXCELLENT: 'success',
    GOOD: 'success',
    FAIR: 'warning',
    POOR: 'danger',
  };

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={`Trading position for the last ${days} days, compared with the preceding ${days} days.`}
        actions={<SegmentedControl options={WINDOWS} value={days} onChange={setDays} />}
      />

      {/* ---------------------------------------------------------------- KPIs */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Today's sales"
          value={currency(today.revenue)}
          sub={`${number(today.transactions)} bills today`}
          icon={IndianRupee}
        />
        <KpiCard
          label={`Revenue (${days}d)`}
          value={currencyCompact(growth.current.revenue)}
          change={growth.revenueGrowthPct}
          sub="vs previous period"
          icon={TrendingUp}
        />
        <KpiCard
          label={`Gross profit (${days}d)`}
          value={currencyCompact(growth.current.grossProfit)}
          change={growth.profitGrowthPct}
          sub="vs previous period"
          icon={Receipt}
        />
        <KpiCard
          label="Gross margin"
          value={percent(growth.current.grossMarginPct)}
          sub={`Avg bill ${currency(growth.current.averageBillValue)}`}
          icon={Percent}
        />

        <KpiCard
          label="Low stock"
          value={number(inventory.lowStock)}
          sub={`${number(inventory.outOfStock)} out of stock`}
          icon={AlertTriangle}
          tone={inventory.lowStock > 0 ? 'warning' : 'default'}
          to="/inventory/low-stock"
        />
        <KpiCard
          label="Expiring soon"
          value={number(inventory.expiring)}
          sub="SKUs inside the expiry window"
          icon={CalendarClock}
          tone={inventory.expiring > 0 ? 'warning' : 'default'}
          to="/inventory/expiry"
        />
        <KpiCard
          label="Inventory value"
          value={currencyCompact(inventory.inventoryValueAtCost)}
          sub={`${number(inventory.activeSkus)} active SKUs`}
          icon={Boxes}
          to="/inventory"
        />
        <KpiCard
          label="Inventory health"
          value={`${number(health.score, 1)}/100`}
          sub={health.grade.toLowerCase()}
          icon={Activity}
          tone={gradeTone[health.grade] ?? 'default'}
          to="/analytics/inventory"
        />
      </div>

      {/* ------------------------------------------------------- Mini Analyst */}
      <section className="mt-6">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold text-slate-900">
              <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-600 text-white">
                <Zap className="h-4 w-4" aria-hidden />
              </span>
              Mini Analyst
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              Your pharmacy's business intelligence assistant — top {insights.length} of the ranked
              findings.
            </p>
          </div>
          <ViewLink to="/mini-analyst">See all insights</ViewLink>
        </div>

        {insights.length === 0 ? (
          <Card>
            <p className="py-6 text-center text-sm text-slate-500">
              No issues detected. Stock levels, expiry exposure and margin are all within their
              configured thresholds.
            </p>
          </Card>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {insights.map((insight) => (
              <InsightCard key={insight.id} insight={insight} />
            ))}
          </div>
        )}
      </section>

      {/* ------------------------------------------------------------- charts */}
      <div className="mt-6 grid gap-4 xl:grid-cols-3">
        <Card
          title="Sales trend"
          subtitle={`Daily revenue and gross profit, last ${days} days`}
          className="xl:col-span-2"
          bodyClassName="p-4"
        >
          <SalesTrendChart data={trend} />
        </Card>

        <Card title="Inventory health" subtitle="Active SKUs by stock status" bodyClassName="p-4">
          {healthSegments.length > 0 ? (
            <InventoryHealthChart data={healthSegments} />
          ) : (
            <p className="py-10 text-center text-sm text-slate-500">No stock data yet.</p>
          )}
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card
          title="Category performance"
          subtitle={`Revenue and gross profit by therapeutic category, last ${days} days`}
          bodyClassName="p-4"
        >
          <CategoryBarChart data={categories.slice(0, 8)} />
        </Card>

        <Card
          title="Top products"
          subtitle={`Ranked by revenue, last ${days} days`}
          actions={<ViewLink to="/analytics/products">All products</ViewLink>}
          bodyClassName="p-0"
        >
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-slate-50/70">
                  <th className="th">Product</th>
                  <th className="th text-right">Units</th>
                  <th className="th text-right">Revenue</th>
                  <th className="th text-right">Profit</th>
                  <th className="th text-right">Margin</th>
                  <th className="th">Stock</th>
                </tr>
              </thead>
              <tbody>
                {topProducts.map((product) => (
                  <tr key={product.id} className="table-row">
                    <td className="td max-w-[220px]">
                      <Link
                        to="/analytics/products"
                        className="block truncate font-medium text-slate-800 hover:text-brand-700"
                        title={product.product_name}
                      >
                        {product.product_name}
                      </Link>
                      <span className="text-xs text-slate-500">{product.category}</span>
                    </td>
                    <td className="td text-right tnum">{number(product.unitsSold)}</td>
                    <td className="td text-right tnum">{currency(product.revenue)}</td>
                    <td className="td text-right tnum">{currency(product.grossProfit)}</td>
                    <td className="td text-right tnum">{percent(product.marginPct)}</td>
                    <td className="td">
                      <StockBadge status={product.stockStatus} />
                    </td>
                  </tr>
                ))}
                {topProducts.length === 0 && (
                  <tr>
                    <td colSpan={6} className="td py-8 text-center text-slate-500">
                      No sales in this period.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <p className="mt-6 text-xs leading-relaxed text-slate-400">
        Revenue is measured net of tax and net of returns. Profit shown is <strong>gross</strong>{' '}
        profit (revenue − cost of goods sold); rent, salaries and other operating costs are not
        modelled. Comparison period: {growth.previousRange.from} to {growth.previousRange.to} (
        {percentSigned(growth.transactionGrowthPct)} transactions).
      </p>
    </>
  );
}
