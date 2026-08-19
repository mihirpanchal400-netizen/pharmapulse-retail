import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  Banknote,
  Boxes,
  CalendarClock,
  IndianRupee,
  Receipt,
  ShoppingCart,
  Truck,
  Users,
  Zap,
} from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { Card, ErrorState, KpiCard, LoadingBlock, PageHeader, SegmentedControl, StockBadge, ViewLink } from '../components/ui';
import { InsightCard } from '../components/InsightCard';
import { CategoryBarChart, InventoryHealthChart, SalesTrendChart } from '../charts';
import { currency, currencyCompact, number, percent } from '../utils/format';
import type { DashboardData } from '../types';

/**
 * PHARMACY OPERATIONS DASHBOARD
 * =============================
 *
 * Deliberately operations-first, not analytics-first: what needs doing today,
 * then how the business is performing. A pharmacist opening this at 9am should
 * see the reorder list and the expiry risk before any chart.
 */

const WINDOWS = [
  { label: '7 days', value: 7 },
  { label: '30 days', value: 30 },
  { label: '90 days', value: 90 },
];

interface ProcurementSummary {
  todayValue: number;
  todayOrders: number;
  openOrders: number;
  openValue: number;
  supplierOutstanding: number;
  overdueOutstanding: number;
  activeDistributors: number;
  lifetimeSavings: number;
  statusCounts: Record<string, number>;
}

interface ReplenishmentSummary {
  summary: { products: number; critical: number; outOfStock: number; estimatedCost: number };
}

interface CustomerDueSummary {
  summary: { totalOutstanding: number; overdue: number; invoices: number };
}

export default function Dashboard() {
  const [days, setDays] = useState(30);
  const { data, error, loading, reload } = useApi<DashboardData>('/analytics/dashboard', { days });
  const { data: procurement } = useApi<ProcurementSummary>('/procurement/summary');
  const { data: replenishment } = useApi<ReplenishmentSummary>('/procurement/replenishment');
  const { data: dues } = useApi<CustomerDueSummary>('/procurement/customer-dues', { pageSize: 1 });

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
        title="Pharmacy Operations"
        subtitle={`Today's business, and the ${days}-day trading position against the preceding ${days} days`}
        actions={
          <>
            <Link to="/sales/new" className="btn-primary">
              <Receipt className="h-4 w-4" aria-hidden />
              New sale
            </Link>
            <SegmentedControl options={WINDOWS} value={days} onChange={setDays} />
          </>
        }
      />

      {/* --------------------------------------------------- today's business */}
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
        Today's business
      </h2>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Today's sales" value={currency(today.revenue)} sub={`${number(today.transactions)} bills`} icon={IndianRupee} />
        <KpiCard label="Today's gross profit" value={currency(today.grossProfit)} sub={`${percent(today.grossMarginPct)} margin`} icon={Receipt} />
        <KpiCard label="Inventory value" value={currencyCompact(inventory.inventoryValueAtCost)} sub={`${number(inventory.activeSkus)} active SKUs`} icon={Boxes} to="/inventory" />
        <KpiCard
          label="Inventory health"
          value={`${number(health.score, 1)}/100`}
          sub={health.grade.toLowerCase()}
          icon={Activity}
          tone={gradeTone[health.grade] ?? 'default'}
          to="/analytics/inventory"
        />
      </div>

      {/* ------------------------------------------------- what needs doing */}
      <h2 className="mb-3 mt-6 text-sm font-semibold uppercase tracking-wide text-slate-500">
        Needs attention
      </h2>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Reorder required"
          value={number(replenishment?.summary.products ?? inventory.lowStock)}
          sub={`${number(replenishment?.summary.critical ?? 0)} critical · ${currencyCompact(replenishment?.summary.estimatedCost ?? 0)} to restock`}
          icon={AlertTriangle}
          tone={(replenishment?.summary.critical ?? 0) > 0 ? 'danger' : (replenishment?.summary.products ?? 0) > 0 ? 'warning' : 'default'}
          to="/procurement/replenishment"
        />
        <KpiCard
          label="Expiry risk"
          value={number(inventory.expiring)}
          sub="SKUs inside the expiry window"
          icon={CalendarClock}
          tone={inventory.expiring > 0 ? 'warning' : 'default'}
          to="/inventory/expiry"
        />
        <KpiCard
          label="Pending orders"
          value={number(procurement?.openOrders ?? 0)}
          sub={`${currencyCompact(procurement?.openValue ?? 0)} awaiting delivery`}
          icon={Truck}
          tone={(procurement?.openOrders ?? 0) > 0 ? 'warning' : 'default'}
          to="/procurement/orders"
        />
        <KpiCard
          label="Supplier dues"
          value={currencyCompact(procurement?.supplierOutstanding ?? 0)}
          sub={`${currencyCompact(procurement?.overdueOutstanding ?? 0)} overdue`}
          icon={Banknote}
          tone={(procurement?.overdueOutstanding ?? 0) > 0 ? 'danger' : 'default'}
          to="/procurement/outstanding"
        />
      </div>

      {/* ---------------------------------------------- procurement snapshot */}
      <div className="mt-4 grid gap-4 md:grid-cols-3">
        <Link to="/procurement/distributors" className="card flex items-center gap-3 p-4 transition-shadow hover:shadow-pop">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700">
            <Truck className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-slate-900">{number(procurement?.activeDistributors ?? 0)} distributors</p>
            <p className="text-xs text-slate-500">Demo network — find, compare and order</p>
          </div>
        </Link>

        <Link to="/procurement/cart" className="card flex items-center gap-3 p-4 transition-shadow hover:shadow-pop">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-emerald-50 text-emerald-700">
            <ShoppingCart className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-slate-900">{currencyCompact(procurement?.lifetimeSavings ?? 0)} saved</p>
            <p className="text-xs text-slate-500">Scheme savings across all orders</p>
          </div>
        </Link>

        <Link to="/customers/outstanding" className="card flex items-center gap-3 p-4 transition-shadow hover:shadow-pop">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-amber-50 text-amber-700">
            <Users className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-slate-900">{currencyCompact(dues?.summary.totalOutstanding ?? 0)} receivable</p>
            <p className="text-xs text-slate-500">{number(dues?.summary.invoices ?? 0)} customer bills open</p>
          </div>
        </Link>
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
              Top {insights.length} of the ranked findings, each with the arithmetic behind it.
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

      {/* ------------------------------------------------------------ charts */}
      <h2 className="mb-3 mt-6 text-sm font-semibold uppercase tracking-wide text-slate-500">
        Performance
      </h2>
      <div className="grid gap-4 xl:grid-cols-3">
        <Card title="Sales trend" subtitle={`Daily revenue and gross profit, last ${days} days`} className="xl:col-span-2" bodyClassName="p-4">
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
        <Card title="Category performance" subtitle={`Revenue and gross profit by therapeutic category, last ${days} days`} bodyClassName="p-4">
          <CategoryBarChart data={categories.slice(0, 8)} />
        </Card>

        <Card
          title="Fast movers"
          subtitle={`Top products by revenue, last ${days} days`}
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
                  <th className="th text-right">Margin</th>
                  <th className="th">Stock</th>
                </tr>
              </thead>
              <tbody>
                {topProducts.map((product) => (
                  <tr key={product.id} className="table-row">
                    <td className="td max-w-[200px]">
                      <Link to={`/inventory/products/${product.id}`} className="block truncate font-medium text-slate-800 hover:text-brand-700">
                        {product.product_name}
                      </Link>
                      <span className="text-xs text-slate-500">{product.category}</span>
                    </td>
                    <td className="td text-right tnum">{number(product.unitsSold)}</td>
                    <td className="td text-right tnum">{currency(product.revenue)}</td>
                    <td className="td text-right tnum">{percent(product.marginPct)}</td>
                    <td className="td">
                      <StockBadge status={product.stockStatus} />
                    </td>
                  </tr>
                ))}
                {topProducts.length === 0 && (
                  <tr>
                    <td colSpan={5} className="td py-8 text-center text-slate-500">
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
        Revenue is net of tax and net of returns. Profit shown is <strong>gross</strong> profit
        (revenue − cost of goods sold); rent, salaries and other operating costs are not modelled.
        Period-on-period comparison is against {growth.previousRange.from} to{' '}
        {growth.previousRange.to}. Distributor prices, schemes and availability throughout the
        procurement screens are <strong>synthetic demo data</strong>.
      </p>
    </>
  );
}
