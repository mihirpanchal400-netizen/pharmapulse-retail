import { getDb } from '../database/connection';
import { round1, round2, safeDiv, grossMarginPct, pctChange } from '../utils/money';
import { windowEndingToday, previousWindow } from '../utils/dates';
import { getInventory, type InventoryItem } from '../services/inventoryService';
import { getThresholds } from '../services/settingsService';
import { LIVE_SALE, NET_COGS, NET_REVENUE, NET_UNITS } from './shared';

export interface ProductPerformance {
  id: number;
  product_code: string;
  product_name: string;
  category: string;
  manufacturer: string | null;
  revenue: number;
  previousRevenue: number;
  revenueGrowthPct: number;
  unitsSold: number;
  cogs: number;
  grossProfit: number;
  marginPct: number;
  revenueSharePct: number;
  salesVelocity: number;
  currentStock: number;
  inventoryValue: number;
  stockCoverageDays: number | null;
  daysSinceLastSale: number | null;
  lastSaleDate: string | null;
  stockStatus: InventoryItem['stock_status'];
  isDeadStock: boolean;
  performanceScore: number;
  /** ABC class by revenue contribution: A = top 80%, B = next 15%, C = last 5%. */
  abcClass: 'A' | 'B' | 'C';
}

interface SalesByProduct {
  product_id: number;
  revenue: number;
  cogs: number;
  units: number;
}

function salesByProduct(range: { from: string; to: string }): Map<number, SalesByProduct> {
  const rows = getDb()
    .prepare(
      `SELECT si.product_id AS product_id,
              COALESCE(SUM(${NET_REVENUE}), 0) AS revenue,
              COALESCE(SUM(${NET_COGS}), 0)    AS cogs,
              COALESCE(SUM(${NET_UNITS}), 0)   AS units
       FROM sale_items si JOIN sales s ON s.id = si.sale_id
       WHERE ${LIVE_SALE} AND date(s.sale_date) BETWEEN @from AND @to
       GROUP BY si.product_id`,
    )
    .all(range) as SalesByProduct[];
  return new Map(rows.map((r) => [r.product_id, r]));
}

/** Min-max normalisation to a 0-100 scale. Flat inputs score 0. */
function normalize(value: number, min: number, max: number): number {
  if (max <= min) return 0;
  return ((value - min) / (max - min)) * 100;
}

/**
 * Product Performance Score (0-100).
 *
 *   Score = 0.30 x velocityIndex        (how fast it moves)
 *         + 0.25 x revenueIndex         (how much turnover it produces)
 *         + 0.25 x profitIndex          (how much gross profit it produces)
 *         + 0.20 x marginIndex          (how profitable each rupee of sales is)
 *         -        inventoryRiskPenalty (dead stock / expiring / overstock / stock-out)
 *
 * Each index is min-max normalised across the catalogue for the selected window,
 * so the score ranks products against each other rather than against an
 * arbitrary absolute scale. The result is clamped to 0-100.
 *
 * Risk penalties (points): dead stock -25, expiring soon -10, overstocked -8,
 * out of stock -12. They are deliberately blunt: the score is a triage aid, not
 * a financial instrument.
 */
export function getProductPerformance(days?: number): ProductPerformance[] {
  const t = getThresholds();
  const windowDays = days ?? t.analysisWindowDays;
  const current = windowEndingToday(windowDays);
  const previous = previousWindow(windowDays);

  const inventory = getInventory(windowDays);
  const curSales = salesByProduct(current);
  const prevSales = salesByProduct(previous);

  const totalRevenue = [...curSales.values()].reduce((s, r) => s + r.revenue, 0);

  const base = inventory.map((item) => {
    const sale = curSales.get(item.id);
    const revenue = sale?.revenue ?? 0;
    const cogs = sale?.cogs ?? 0;
    const units = sale?.units ?? 0;
    const previousRevenue = prevSales.get(item.id)?.revenue ?? 0;
    const velocity = safeDiv(units, windowDays);

    return {
      item,
      revenue,
      cogs,
      units,
      previousRevenue,
      velocity,
      grossProfit: revenue - cogs,
      marginPct: grossMarginPct(revenue, cogs),
      isDeadStock:
        item.current_stock > 0 &&
        (item.days_since_last_sale === null || item.days_since_last_sale >= t.deadStockDays),
    };
  });

  const maxVelocity = Math.max(...base.map((b) => b.velocity), 0);
  const maxRevenue = Math.max(...base.map((b) => b.revenue), 0);
  const maxProfit = Math.max(...base.map((b) => b.grossProfit), 0);
  const minProfit = Math.min(...base.map((b) => b.grossProfit), 0);
  const maxMargin = Math.max(...base.map((b) => b.marginPct), 0);

  const scored = base.map((b) => {
    const velocityIndex = normalize(b.velocity, 0, maxVelocity);
    const revenueIndex = normalize(b.revenue, 0, maxRevenue);
    const profitIndex = normalize(b.grossProfit, minProfit, maxProfit);
    const marginIndex = normalize(b.marginPct, 0, maxMargin);

    let penalty = 0;
    if (b.isDeadStock) penalty += 25;
    if (b.item.stock_status === 'EXPIRING') penalty += 10;
    if (b.item.stock_status === 'OVERSTOCKED') penalty += 8;
    if (b.item.stock_status === 'OUT_OF_STOCK') penalty += 12;

    const raw =
      0.3 * velocityIndex + 0.25 * revenueIndex + 0.25 * profitIndex + 0.2 * marginIndex - penalty;

    return {
      id: b.item.id,
      product_code: b.item.product_code,
      product_name: b.item.product_name,
      category: b.item.category,
      manufacturer: b.item.manufacturer,
      revenue: round2(b.revenue),
      previousRevenue: round2(b.previousRevenue),
      revenueGrowthPct: pctChange(b.revenue, b.previousRevenue),
      unitsSold: b.units,
      cogs: round2(b.cogs),
      grossProfit: round2(b.grossProfit),
      marginPct: b.marginPct,
      revenueSharePct: round1(safeDiv(b.revenue, totalRevenue) * 100),
      salesVelocity: round2(b.velocity),
      currentStock: b.item.current_stock,
      inventoryValue: b.item.inventory_value,
      stockCoverageDays: b.item.stock_coverage_days,
      daysSinceLastSale: b.item.days_since_last_sale,
      lastSaleDate: b.item.last_sale_date,
      stockStatus: b.item.stock_status,
      isDeadStock: b.isDeadStock,
      performanceScore: round1(Math.max(0, Math.min(100, raw))),
      abcClass: 'C' as 'A' | 'B' | 'C',
    };
  });

  // ABC classification by cumulative revenue share (Pareto).
  const byRevenue = [...scored].sort((a, b) => b.revenue - a.revenue);
  let cumulative = 0;
  for (const p of byRevenue) {
    cumulative += p.revenue;
    const sharePct = safeDiv(cumulative, totalRevenue) * 100;
    p.abcClass = sharePct <= 80 ? 'A' : sharePct <= 95 ? 'B' : 'C';
  }

  return scored.sort((a, b) => b.performanceScore - a.performanceScore);
}

/** Highest sales velocity, only counting products that actually moved. */
export function getFastMoving(days?: number, limit = 10): ProductPerformance[] {
  return getProductPerformance(days)
    .filter((p) => p.unitsSold > 0)
    .sort((a, b) => b.salesVelocity - a.salesVelocity)
    .slice(0, limit);
}

/**
 * Slow movers: products holding stock whose velocity is in the bottom band.
 * Ranked by stock coverage (worst first) so the biggest cash traps surface.
 */
export function getSlowMoving(days?: number, limit = 10): ProductPerformance[] {
  const all = getProductPerformance(days).filter((p) => p.currentStock > 0);
  const velocities = all.map((p) => p.salesVelocity).sort((a, b) => a - b);
  const cutoff = velocities[Math.floor(velocities.length * 0.25)] ?? 0;

  return all
    .filter((p) => p.salesVelocity <= cutoff)
    .sort((a, b) => (b.stockCoverageDays ?? 9999) - (a.stockCoverageDays ?? 9999))
    .slice(0, limit);
}

/**
 * Dead stock: units on the shelf with no sale for `deadStockDays`.
 * These are the clearest example of cash sitting still.
 */
export function getDeadStock(days?: number): ProductPerformance[] {
  return getProductPerformance(days)
    .filter((p) => p.isDeadStock)
    .sort((a, b) => b.inventoryValue - a.inventoryValue);
}

/** Top products by revenue for the dashboard table. */
export function getTopProducts(days?: number, limit = 10): ProductPerformance[] {
  return getProductPerformance(days)
    .filter((p) => p.revenue > 0)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, limit);
}

/** Per-product detail used by the product analytics drill-down. */
export function getProductTrend(productId: number, days = 90) {
  const range = windowEndingToday(days);
  return getDb()
    .prepare(
      `SELECT date(s.sale_date) AS date,
              ROUND(COALESCE(SUM(${NET_REVENUE}), 0), 2) AS revenue,
              COALESCE(SUM(${NET_UNITS}), 0) AS units
       FROM sale_items si JOIN sales s ON s.id = si.sale_id
       WHERE ${LIVE_SALE} AND si.product_id = @productId
         AND date(s.sale_date) BETWEEN @from AND @to
       GROUP BY date(s.sale_date) ORDER BY date`,
    )
    .all({ ...range, productId });
}
