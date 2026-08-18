import { getDb } from '../database/connection';
import { round1, round2, safeDiv, grossMarginPct, pctChange } from '../utils/money';
import { windowEndingToday, previousWindow } from '../utils/dates';
import { LIVE_SALE, NET_COGS, NET_REVENUE, NET_TAX, NET_UNITS, type DateRange } from './shared';

/**
 * Profitability analytics.
 *
 * IMPORTANT - what "profit" means here:
 *
 *   Gross Profit = Net Revenue - Cost of Goods Sold
 *
 * This is GROSS profit only. Rent, salaries, electricity, licence fees and
 * shrinkage are not modelled, so nothing in this module is net profit. The
 * distinction is stated in ANALYTICS_METHODOLOGY.md and surfaced in the UI,
 * because reporting gross margin as if it were net margin is the single most
 * common way retail analytics misleads its reader.
 *
 * COGS is taken from `sale_items.purchase_price`, which is a snapshot of the
 * cost of the SPECIFIC BATCH dispensed. It is not the product's current cost.
 */

export interface ProfitSummary {
  range: DateRange;
  revenue: number;
  cogs: number;
  grossProfit: number;
  grossMarginPct: number;
  tax: number;
  discount: number;
  unitsSold: number;
  transactions: number;
  /** Gross profit per transaction - what one bill contributes on average. */
  profitPerTransaction: number;
  /** Gross profit per unit dispensed. */
  profitPerUnit: number;
}

function summaryFor(range: DateRange): ProfitSummary {
  const row = getDb()
    .prepare(
      `SELECT
         COALESCE(SUM(${NET_REVENUE}), 0) AS revenue,
         COALESCE(SUM(${NET_COGS}), 0)    AS cogs,
         COALESCE(SUM(${NET_TAX}), 0)     AS tax,
         COALESCE(SUM(si.discount * (si.quantity - si.returned_quantity) / CAST(si.quantity AS REAL)), 0) AS discount,
         COALESCE(SUM(${NET_UNITS}), 0)   AS units,
         COUNT(DISTINCT s.id)             AS transactions
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       WHERE ${LIVE_SALE} AND date(s.sale_date) BETWEEN @from AND @to`,
    )
    .get(range) as {
    revenue: number;
    cogs: number;
    tax: number;
    discount: number;
    units: number;
    transactions: number;
  };

  const grossProfit = row.revenue - row.cogs;

  return {
    range,
    revenue: round2(row.revenue),
    cogs: round2(row.cogs),
    grossProfit: round2(grossProfit),
    grossMarginPct: grossMarginPct(row.revenue, row.cogs),
    tax: round2(row.tax),
    discount: round2(row.discount),
    unitsSold: row.units,
    transactions: row.transactions,
    profitPerTransaction: round2(safeDiv(grossProfit, row.transactions)),
    profitPerUnit: round2(safeDiv(grossProfit, row.units)),
  };
}

export function getProfitSummary(days: number): ProfitSummary {
  return summaryFor(windowEndingToday(days));
}

export interface ProfitComparison {
  windowDays: number;
  current: ProfitSummary;
  previous: ProfitSummary;
  revenueGrowthPct: number;
  profitGrowthPct: number;
  /** Change in margin expressed in PERCENTAGE POINTS, not percent. */
  marginChangePoints: number;
}

/**
 * Current window vs the immediately preceding window of equal length.
 *
 * Margin change is reported in percentage POINTS. A move from 22% to 20% is
 * "-2.0 points", not "-9.1%". Conflating the two is a classic reporting error.
 */
export function getProfitComparison(days: number): ProfitComparison {
  const current = summaryFor(windowEndingToday(days));
  const previous = summaryFor(previousWindow(days));

  return {
    windowDays: days,
    current,
    previous,
    revenueGrowthPct: pctChange(current.revenue, previous.revenue),
    profitGrowthPct: pctChange(current.grossProfit, previous.grossProfit),
    marginChangePoints: round1(current.grossMarginPct - previous.grossMarginPct),
  };
}

export interface CategoryProfit {
  category: string;
  revenue: number;
  cogs: number;
  grossProfit: number;
  marginPct: number;
  units: number;
  /** Share of TOTAL GROSS PROFIT contributed by this category. */
  profitSharePct: number;
  revenueSharePct: number;
  previousProfit: number;
  profitGrowthPct: number;
}

/**
 * Profit by category, with growth against the preceding window.
 *
 * Both revenue share and profit share are returned because they frequently
 * disagree: a high-revenue, low-margin category (e.g. chronic-care generics)
 * can contribute far less profit than its turnover suggests. That gap is the
 * insight a category manager actually acts on.
 */
export function getProfitByCategory(days: number): CategoryProfit[] {
  const db = getDb();
  const sql = `SELECT p.category AS category,
                      COALESCE(SUM(${NET_REVENUE}), 0) AS revenue,
                      COALESCE(SUM(${NET_COGS}), 0)    AS cogs,
                      COALESCE(SUM(${NET_UNITS}), 0)   AS units
               FROM sale_items si
               JOIN sales s ON s.id = si.sale_id
               JOIN products p ON p.id = si.product_id
               WHERE ${LIVE_SALE} AND date(s.sale_date) BETWEEN @from AND @to
               GROUP BY p.category`;

  type Row = { category: string; revenue: number; cogs: number; units: number };
  const current = db.prepare(sql).all(windowEndingToday(days)) as Row[];
  const previous = db.prepare(sql).all(previousWindow(days)) as Row[];
  const prevMap = new Map(previous.map((r) => [r.category, r.revenue - r.cogs]));

  const totalRevenue = current.reduce((s, r) => s + r.revenue, 0);
  const totalProfit = current.reduce((s, r) => s + (r.revenue - r.cogs), 0);

  return current
    .map((r) => {
      const grossProfit = r.revenue - r.cogs;
      const previousProfit = prevMap.get(r.category) ?? 0;
      return {
        category: r.category,
        revenue: round2(r.revenue),
        cogs: round2(r.cogs),
        grossProfit: round2(grossProfit),
        marginPct: grossMarginPct(r.revenue, r.cogs),
        units: r.units,
        profitSharePct: round1(safeDiv(grossProfit, totalProfit) * 100),
        revenueSharePct: round1(safeDiv(r.revenue, totalRevenue) * 100),
        previousProfit: round2(previousProfit),
        profitGrowthPct: pctChange(grossProfit, previousProfit),
      };
    })
    .sort((a, b) => b.grossProfit - a.grossProfit);
}

export interface ProductProfit {
  id: number;
  product_code: string;
  product_name: string;
  category: string;
  revenue: number;
  cogs: number;
  grossProfit: number;
  marginPct: number;
  units: number;
  profitSharePct: number;
}

/** Profit by product, ranked. `limit = 0` returns every product that sold. */
export function getProfitByProduct(days: number, limit = 20): ProductProfit[] {
  const rows = getDb()
    .prepare(
      `SELECT p.id, p.product_code, p.product_name, p.category,
              COALESCE(SUM(${NET_REVENUE}), 0) AS revenue,
              COALESCE(SUM(${NET_COGS}), 0)    AS cogs,
              COALESCE(SUM(${NET_UNITS}), 0)   AS units
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       JOIN products p ON p.id = si.product_id
       WHERE ${LIVE_SALE} AND date(s.sale_date) BETWEEN @from AND @to
       GROUP BY p.id
       ORDER BY (COALESCE(SUM(${NET_REVENUE}), 0) - COALESCE(SUM(${NET_COGS}), 0)) DESC`,
    )
    .all(windowEndingToday(days)) as (Omit<ProductProfit, 'grossProfit' | 'marginPct' | 'profitSharePct'> & {
    revenue: number;
    cogs: number;
  })[];

  const totalProfit = rows.reduce((s, r) => s + (r.revenue - r.cogs), 0);
  const sliced = limit > 0 ? rows.slice(0, limit) : rows;

  return sliced.map((r) => {
    const grossProfit = r.revenue - r.cogs;
    return {
      id: r.id,
      product_code: r.product_code,
      product_name: r.product_name,
      category: r.category,
      revenue: round2(r.revenue),
      cogs: round2(r.cogs),
      grossProfit: round2(grossProfit),
      marginPct: grossMarginPct(r.revenue, r.cogs),
      units: r.units,
      profitSharePct: round1(safeDiv(grossProfit, totalProfit) * 100),
    };
  });
}

export interface ProfitTrendPoint {
  date: string;
  revenue: number;
  cogs: number;
  grossProfit: number;
  marginPct: number;
}

/**
 * Daily revenue / COGS / profit / margin series.
 * Days with no trade are emitted as zeros so a chart shows the gap honestly
 * rather than joining across it.
 */
export function getProfitTrend(days: number): ProfitTrendPoint[] {
  const range = windowEndingToday(days);
  const rows = getDb()
    .prepare(
      `SELECT date(s.sale_date) AS date,
              COALESCE(SUM(${NET_REVENUE}), 0) AS revenue,
              COALESCE(SUM(${NET_COGS}), 0)    AS cogs
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       WHERE ${LIVE_SALE} AND date(s.sale_date) BETWEEN @from AND @to
       GROUP BY date(s.sale_date)`,
    )
    .all(range) as { date: string; revenue: number; cogs: number }[];

  const byDate = new Map(rows.map((r) => [r.date, r]));
  const out: ProfitTrendPoint[] = [];

  const start = new Date(range.from);
  for (let i = 0; i < days; i += 1) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate(),
    ).padStart(2, '0')}`;
    const hit = byDate.get(key);
    const revenue = hit?.revenue ?? 0;
    const cogs = hit?.cogs ?? 0;
    out.push({
      date: key,
      revenue: round2(revenue),
      cogs: round2(cogs),
      grossProfit: round2(revenue - cogs),
      marginPct: grossMarginPct(revenue, cogs),
    });
  }
  return out;
}

/**
 * Margin distribution across products that sold in the window.
 *
 * A single average margin hides the shape of the business. Buckets reveal
 * whether the pharmacy runs on a few high-margin lines or a broad middle - and
 * whether anything is being sold at a loss.
 */
export function getMarginDistribution(days: number) {
  const products = getProfitByProduct(days, 0);
  const buckets = [
    { label: 'Loss making', min: -Infinity, max: 0 },
    { label: '0-10%', min: 0, max: 10 },
    { label: '10-20%', min: 10, max: 20 },
    { label: '20-30%', min: 20, max: 30 },
    { label: '30-40%', min: 30, max: 40 },
    { label: 'Above 40%', min: 40, max: Infinity },
  ];

  return buckets.map((b) => {
    const hits = products.filter((p) => p.marginPct >= b.min && p.marginPct < b.max);
    return {
      label: b.label,
      products: hits.length,
      revenue: round2(hits.reduce((s, p) => s + p.revenue, 0)),
      grossProfit: round2(hits.reduce((s, p) => s + p.grossProfit, 0)),
    };
  });
}
