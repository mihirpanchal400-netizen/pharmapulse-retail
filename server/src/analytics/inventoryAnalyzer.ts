import { getDb } from '../database/connection';
import { round1, round2, safeDiv } from '../utils/money';
import { windowEndingToday } from '../utils/dates';
import { getInventory } from '../services/inventoryService';
import { getThresholds } from '../services/settingsService';
import { getDeadStock } from './productAnalyzer';
import { LIVE_SALE, NET_COGS } from './shared';
import type { StockStatus } from '../types';

export interface InventorySummary {
  totalSkus: number;
  activeSkus: number;
  totalUnits: number;
  inventoryValueAtCost: number;
  inventoryValueAtRetail: number;
  potentialMargin: number;
  statusCounts: Record<StockStatus, number>;
  outOfStock: number;
  lowStock: number;
  overstock: number;
  expiring: number;
  healthy: number;
  deadStockCount: number;
  deadStockValue: number;
  expiredUnits: number;
}

export function getInventorySummary(): InventorySummary {
  const items = getInventory();
  const active = items.filter((i) => i.status === 'ACTIVE');

  const statusCounts: Record<StockStatus, number> = {
    OUT_OF_STOCK: 0,
    LOW_STOCK: 0,
    HEALTHY: 0,
    OVERSTOCKED: 0,
    EXPIRING: 0,
  };
  for (const i of active) statusCounts[i.stock_status] += 1;

  const dead = getDeadStock();
  const cost = active.reduce((s, i) => s + i.inventory_value, 0);
  const retail = active.reduce((s, i) => s + i.retail_value, 0);

  return {
    totalSkus: items.length,
    activeSkus: active.length,
    totalUnits: active.reduce((s, i) => s + i.current_stock, 0),
    inventoryValueAtCost: round2(cost),
    inventoryValueAtRetail: round2(retail),
    potentialMargin: round2(retail - cost),
    statusCounts,
    outOfStock: statusCounts.OUT_OF_STOCK,
    lowStock: statusCounts.LOW_STOCK,
    overstock: statusCounts.OVERSTOCKED,
    expiring: statusCounts.EXPIRING,
    healthy: statusCounts.HEALTHY,
    deadStockCount: dead.length,
    deadStockValue: round2(dead.reduce((s, p) => s + p.inventoryValue, 0)),
    expiredUnits: active.reduce((s, i) => s + i.expired_stock, 0),
  };
}

export interface TurnoverResult {
  windowDays: number;
  cogs: number;
  closingInventory: number;
  estimatedOpeningInventory: number;
  averageInventory: number;
  turnover: number;
  annualisedTurnover: number;
  daysOfInventory: number | null;
  method: string;
}

/**
 * Inventory turnover.
 *
 *   Turnover = COGS / Average Inventory
 *
 * The application does not store nightly inventory snapshots, so average
 * inventory is DERIVED from the standard inventory identity rather than guessed:
 *
 *   Opening = Closing - Goods Received + COGS + Write-offs
 *   Average = (Opening + Closing) / 2
 *
 * Goods received is valued at purchase cost; write-offs cover expired, damaged
 * and adjustment movements valued at the product's cost price. Stock adjustments
 * made before any purchase history exists can make the estimate rough on a very
 * young database - the method is reported alongside the number so the figure is
 * never mistaken for an audited one.
 */
export function getInventoryTurnover(days = 90): TurnoverResult {
  const range = windowEndingToday(days);
  const db = getDb();

  const cogsRow = db
    .prepare(
      `SELECT COALESCE(SUM(${NET_COGS}), 0) AS cogs
       FROM sale_items si JOIN sales s ON s.id = si.sale_id
       WHERE ${LIVE_SALE} AND date(s.sale_date) BETWEEN @from AND @to`,
    )
    .get(range) as { cogs: number };

  const receivedRow = db
    .prepare(
      `SELECT COALESCE(SUM(pi.quantity * pi.purchase_price), 0) AS received
       FROM purchase_items pi JOIN purchases p ON p.id = pi.purchase_id
       WHERE p.purchase_date BETWEEN @from AND @to`,
    )
    .get(range) as { received: number };

  const writeOffRow = db
    .prepare(
      `SELECT COALESCE(SUM(ABS(t.quantity) * pr.purchase_price), 0) AS value
       FROM inventory_transactions t JOIN products pr ON pr.id = t.product_id
       WHERE t.transaction_type IN ('EXPIRED','DAMAGED','ADJUSTMENT')
         AND t.quantity < 0
         AND date(t.transaction_date) BETWEEN @from AND @to`,
    )
    .get(range) as { value: number };

  const closing = getInventory().reduce((s, i) => s + i.inventory_value, 0);
  const opening = Math.max(0, closing - receivedRow.received + cogsRow.cogs + writeOffRow.value);
  const average = (opening + closing) / 2;
  const turnover = safeDiv(cogsRow.cogs, average);

  return {
    windowDays: days,
    cogs: round2(cogsRow.cogs),
    closingInventory: round2(closing),
    estimatedOpeningInventory: round2(opening),
    averageInventory: round2(average),
    turnover: round2(turnover),
    annualisedTurnover: round2(turnover * (365 / days)),
    daysOfInventory: turnover > 0 ? Math.round(days / turnover) : null,
    method: 'Opening inventory derived from: Closing - Receipts + COGS + Write-offs',
  };
}

export interface HealthScore {
  score: number;
  grade: 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR';
  penalties: { reason: string; points: number; detail: string }[];
  formula: string;
}

/**
 * Inventory Health Score (0-100).
 *
 *   Score = 100
 *         - stockoutPct  x healthPenaltyStockoutPerPct
 *         - expiryPct    x healthPenaltyExpiryPerPct
 *         - deadStockPct x healthPenaltyDeadStockPerPct
 *         - overstockPct x healthPenaltyOverstockPerPct
 *
 * Each *Pct is the share of active SKUs in that condition. All four weights are
 * configurable from Settings, so the definition of "healthy" can be tuned to the
 * pharmacy rather than baked into the code.
 */
export function getInventoryHealthScore(): HealthScore {
  const t = getThresholds();
  const summary = getInventorySummary();
  const skus = Math.max(1, summary.activeSkus);

  const stockoutPct = safeDiv(summary.outOfStock, skus) * 100;
  const expiryPct = safeDiv(summary.expiring, skus) * 100;
  const deadPct = safeDiv(summary.deadStockCount, skus) * 100;
  const overstockPct = safeDiv(summary.overstock, skus) * 100;

  const penalties = [
    {
      reason: 'Stock-outs',
      points: round1(stockoutPct * t.healthPenaltyStockoutPerPct),
      detail: `${summary.outOfStock} of ${skus} active SKUs are out of stock (${round1(stockoutPct)}%)`,
    },
    {
      reason: 'Expiring stock',
      points: round1(expiryPct * t.healthPenaltyExpiryPerPct),
      detail: `${summary.expiring} SKUs hold batches expiring within ${t.expiryWarningDays} days (${round1(expiryPct)}%)`,
    },
    {
      reason: 'Dead stock',
      points: round1(deadPct * t.healthPenaltyDeadStockPerPct),
      detail: `${summary.deadStockCount} SKUs have not sold in ${t.deadStockDays} days (${round1(deadPct)}%)`,
    },
    {
      reason: 'Overstock',
      points: round1(overstockPct * t.healthPenaltyOverstockPerPct),
      detail: `${summary.overstock} SKUs are above their maximum stock level (${round1(overstockPct)}%)`,
    },
  ];

  const score = round1(
    Math.max(0, Math.min(100, 100 - penalties.reduce((s, p) => s + p.points, 0))),
  );

  return {
    score,
    grade: score >= 85 ? 'EXCELLENT' : score >= 70 ? 'GOOD' : score >= 50 ? 'FAIR' : 'POOR',
    penalties,
    formula:
      'Score = 100 - (stock-out% x w1) - (expiring% x w2) - (dead stock% x w3) - (overstock% x w4)',
  };
}

/** Products at or below their reorder level, worst coverage first. */
export function getReorderList() {
  const t = getThresholds();
  return getInventory()
    .filter((i) => i.status === 'ACTIVE' && i.needs_reorder)
    .map((i) => {
      // Suggested order quantity tops the product back up to its maximum level,
      // or to a month of demand when no maximum is configured.
      const target = i.maximum_stock > 0 ? i.maximum_stock : Math.ceil(i.sales_velocity * 30);
      return {
        ...i,
        suggestedOrderQty: Math.max(0, target - i.current_stock),
        isCritical:
          i.current_stock === 0 ||
          (i.stock_coverage_days !== null && i.stock_coverage_days <= t.criticalCoverageDays),
      };
    })
    .sort((a, b) => {
      const ac = a.stock_coverage_days ?? 9999;
      const bc = b.stock_coverage_days ?? 9999;
      return ac - bc;
    });
}

/** Value tied up per category - shows where the cash actually sits. */
export function getInventoryByCategory() {
  const items = getInventory().filter((i) => i.status === 'ACTIVE');
  const map = new Map<string, { category: string; value: number; units: number; skus: number }>();

  for (const i of items) {
    const row = map.get(i.category) ?? { category: i.category, value: 0, units: 0, skus: 0 };
    row.value += i.inventory_value;
    row.units += i.current_stock;
    row.skus += 1;
    map.set(i.category, row);
  }

  const total = [...map.values()].reduce((s, r) => s + r.value, 0);
  return [...map.values()]
    .map((r) => ({
      ...r,
      value: round2(r.value),
      sharePct: round1(safeDiv(r.value, total) * 100),
    }))
    .sort((a, b) => b.value - a.value);
}

/**
 * Inventory value concentration: the share of stock value held by the top SKUs.
 * Answers "how much of my money is sitting in how few products?".
 */
export function getValueConcentration(topN = 10) {
  const items = getInventory()
    .filter((i) => i.inventory_value > 0)
    .sort((a, b) => b.inventory_value - a.inventory_value);

  const total = items.reduce((s, i) => s + i.inventory_value, 0);
  const top = items.slice(0, topN);
  const topValue = top.reduce((s, i) => s + i.inventory_value, 0);

  return {
    topN,
    totalValue: round2(total),
    topValue: round2(topValue),
    concentrationPct: round1(safeDiv(topValue, total) * 100),
    products: top.map((i) => ({
      id: i.id,
      product_name: i.product_name,
      inventoryValue: i.inventory_value,
      currentStock: i.current_stock,
      sharePct: round1(safeDiv(i.inventory_value, total) * 100),
    })),
  };
}
