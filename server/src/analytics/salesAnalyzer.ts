import { getDb } from '../database/connection';
import { round2, round1, safeDiv, pctChange, grossMarginPct } from '../utils/money';
import { windowEndingToday, previousWindow, addDays, today } from '../utils/dates';
import { LIVE_SALE, NET_COGS, NET_REVENUE, NET_UNITS, type DateRange } from './shared';

export interface SalesSummary {
  revenue: number;
  grossRevenueWithTax: number;
  tax: number;
  discount: number;
  cogs: number;
  grossProfit: number;
  grossMarginPct: number;
  transactions: number;
  unitsSold: number;
  averageBillValue: number;
  averageUnitsPerBill: number;
}

/** Headline sales figures for a date range (inclusive). */
export function getSalesSummary(range: DateRange): SalesSummary {
  const row = getDb()
    .prepare(
      `SELECT
         COALESCE(SUM(${NET_REVENUE}), 0)  AS revenue,
         COALESCE(SUM(${NET_COGS}), 0)     AS cogs,
         COALESCE(SUM(${NET_UNITS}), 0)    AS units,
         COALESCE(SUM(si.tax * (si.quantity - si.returned_quantity) / CAST(si.quantity AS REAL)), 0) AS tax,
         COALESCE(SUM(si.discount * (si.quantity - si.returned_quantity) / CAST(si.quantity AS REAL)), 0) AS discount,
         COUNT(DISTINCT s.id)              AS transactions
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       WHERE ${LIVE_SALE} AND date(s.sale_date) BETWEEN @from AND @to`,
    )
    .get(range) as {
    revenue: number;
    cogs: number;
    units: number;
    tax: number;
    discount: number;
    transactions: number;
  };

  const revenue = round2(row.revenue);
  const cogs = round2(row.cogs);

  return {
    revenue,
    grossRevenueWithTax: round2(row.revenue + row.tax),
    tax: round2(row.tax),
    discount: round2(row.discount),
    cogs,
    grossProfit: round2(revenue - cogs),
    grossMarginPct: grossMarginPct(revenue, cogs),
    transactions: row.transactions,
    unitsSold: row.units,
    averageBillValue: round2(safeDiv(row.revenue + row.tax, row.transactions)),
    averageUnitsPerBill: round1(safeDiv(row.units, row.transactions)),
  };
}

export interface TrendPoint {
  date: string;
  revenue: number;
  grossProfit: number;
  transactions: number;
  units: number;
}

/**
 * Daily sales series for the last `days` days.
 * Days with no sales are emitted as zeros so charts show real gaps rather than
 * silently compressing the x-axis.
 */
export function getSalesTrend(days: number): TrendPoint[] {
  const range = windowEndingToday(days);
  const rows = getDb()
    .prepare(
      `SELECT date(s.sale_date) AS date,
              COALESCE(SUM(${NET_REVENUE}), 0) AS revenue,
              COALESCE(SUM(${NET_REVENUE} - ${NET_COGS}), 0) AS profit,
              COALESCE(SUM(${NET_UNITS}), 0) AS units,
              COUNT(DISTINCT s.id) AS transactions
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       WHERE ${LIVE_SALE} AND date(s.sale_date) BETWEEN @from AND @to
       GROUP BY date(s.sale_date)`,
    )
    .all(range) as { date: string; revenue: number; profit: number; units: number; transactions: number }[];

  const byDate = new Map(rows.map((r) => [r.date, r]));
  const series: TrendPoint[] = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(range.from, i);
    const hit = byDate.get(date);
    series.push({
      date,
      revenue: round2(hit?.revenue ?? 0),
      grossProfit: round2(hit?.profit ?? 0),
      transactions: hit?.transactions ?? 0,
      units: hit?.units ?? 0,
    });
  }
  return series;
}

/** Monthly roll-up for the last `months` calendar months. */
export function getMonthlySales(months = 12) {
  return getDb()
    .prepare(
      `SELECT strftime('%Y-%m', s.sale_date) AS month,
              ROUND(COALESCE(SUM(${NET_REVENUE}), 0), 2) AS revenue,
              ROUND(COALESCE(SUM(${NET_REVENUE} - ${NET_COGS}), 0), 2) AS grossProfit,
              COUNT(DISTINCT s.id) AS transactions,
              COALESCE(SUM(${NET_UNITS}), 0) AS units
       FROM sale_items si JOIN sales s ON s.id = si.sale_id
       WHERE ${LIVE_SALE}
       GROUP BY month
       ORDER BY month DESC
       LIMIT ?`,
    )
    .all(months)
    .reverse();
}

/** Sales by day of week - shows which weekdays carry the shop. */
export function getWeekdayPattern(days = 90) {
  const range = windowEndingToday(days);
  const rows = getDb()
    .prepare(
      `SELECT CAST(strftime('%w', s.sale_date) AS INTEGER) AS dow,
              ROUND(COALESCE(SUM(${NET_REVENUE}), 0), 2) AS revenue,
              COUNT(DISTINCT s.id) AS transactions
       FROM sale_items si JOIN sales s ON s.id = si.sale_id
       WHERE ${LIVE_SALE} AND date(s.sale_date) BETWEEN @from AND @to
       GROUP BY dow ORDER BY dow`,
    )
    .all(range) as { dow: number; revenue: number; transactions: number }[];

  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return names.map((name, i) => {
    const hit = rows.find((r) => r.dow === i);
    return { day: name.slice(0, 3), fullDay: name, revenue: hit?.revenue ?? 0, transactions: hit?.transactions ?? 0 };
  });
}

export interface CategorySales {
  category: string;
  revenue: number;
  cogs: number;
  grossProfit: number;
  marginPct: number;
  units: number;
  revenueSharePct: number;
  previousRevenue: number;
  growthPct: number;
}

/** Category performance for a range, with growth against the preceding window. */
export function getCategorySales(days: number): CategorySales[] {
  const current = windowEndingToday(days);
  const previous = previousWindow(days);
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

  const cur = db.prepare(sql).all(current) as { category: string; revenue: number; cogs: number; units: number }[];
  const prev = db.prepare(sql).all(previous) as { category: string; revenue: number }[];
  const prevMap = new Map(prev.map((r) => [r.category, r.revenue]));
  const totalRevenue = cur.reduce((s, r) => s + r.revenue, 0);

  return cur
    .map((r) => ({
      category: r.category,
      revenue: round2(r.revenue),
      cogs: round2(r.cogs),
      grossProfit: round2(r.revenue - r.cogs),
      marginPct: grossMarginPct(r.revenue, r.cogs),
      units: r.units,
      revenueSharePct: round1(safeDiv(r.revenue, totalRevenue) * 100),
      previousRevenue: round2(prevMap.get(r.category) ?? 0),
      growthPct: pctChange(r.revenue, prevMap.get(r.category) ?? 0),
    }))
    .sort((a, b) => b.revenue - a.revenue);
}

/** Payment-method mix. */
export function getPaymentMix(days: number) {
  const range = windowEndingToday(days);
  const rows = getDb()
    .prepare(
      `SELECT s.payment_method AS method, COUNT(*) AS transactions,
              ROUND(COALESCE(SUM(s.total), 0), 2) AS value
       FROM sales s
       WHERE ${LIVE_SALE} AND date(s.sale_date) BETWEEN @from AND @to
       GROUP BY s.payment_method ORDER BY value DESC`,
    )
    .all(range) as { method: string; transactions: number; value: number }[];

  const total = rows.reduce((s, r) => s + r.value, 0);
  return rows.map((r) => ({ ...r, sharePct: round1(safeDiv(r.value, total) * 100) }));
}

export interface GrowthComparison {
  windowDays: number;
  current: SalesSummary;
  previous: SalesSummary;
  revenueGrowthPct: number;
  profitGrowthPct: number;
  transactionGrowthPct: number;
  currentRange: DateRange;
  previousRange: DateRange;
}

/**
 * Compares the trailing `days` window with the immediately preceding window of
 * the same length - the comparison the Mini Analyst reports on.
 */
export function getSalesGrowth(days: number): GrowthComparison {
  const currentRange = windowEndingToday(days);
  const previousRange = previousWindow(days);
  const current = getSalesSummary(currentRange);
  const previous = getSalesSummary(previousRange);

  return {
    windowDays: days,
    current,
    previous,
    revenueGrowthPct: pctChange(current.revenue, previous.revenue),
    profitGrowthPct: pctChange(current.grossProfit, previous.grossProfit),
    transactionGrowthPct: pctChange(current.transactions, previous.transactions),
    currentRange,
    previousRange,
  };
}

/** Today's figures, used by the dashboard KPI row. */
export function getTodaySummary(): SalesSummary {
  const day = today();
  return getSalesSummary({ from: day, to: day });
}

/**
 * Revenue concentration: what share of revenue the top N products produce.
 * A high figure means the business depends on very few lines.
 */
export function getRevenueConcentration(days: number, topN: number) {
  const range = windowEndingToday(days);
  const rows = getDb()
    .prepare(
      `SELECT p.id, p.product_name, COALESCE(SUM(${NET_REVENUE}), 0) AS revenue
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       JOIN products p ON p.id = si.product_id
       WHERE ${LIVE_SALE} AND date(s.sale_date) BETWEEN @from AND @to
       GROUP BY p.id
       ORDER BY revenue DESC`,
    )
    .all(range) as { id: number; product_name: string; revenue: number }[];

  const totalRevenue = rows.reduce((s, r) => s + r.revenue, 0);
  const top = rows.slice(0, topN);
  const topRevenue = top.reduce((s, r) => s + r.revenue, 0);

  return {
    topN,
    productsSelling: rows.length,
    totalRevenue: round2(totalRevenue),
    topRevenue: round2(topRevenue),
    concentrationPct: round1(safeDiv(topRevenue, totalRevenue) * 100),
    products: top.map((r) => ({
      id: r.id,
      product_name: r.product_name,
      revenue: round2(r.revenue),
      sharePct: round1(safeDiv(r.revenue, totalRevenue) * 100),
    })),
  };
}
