import { round1, round2 } from '../utils/money';
import { getInventory, type InventoryItem } from './inventoryService';
import { getThresholds } from './settingsService';
import { bestSupplierFor, type SupplierOption } from './distributorService';
import { optimiseOrderQty } from './schemeService';

/**
 * REPLENISHMENT CENTER
 * ====================
 *
 * The bridge between "you are low on stock" and "here is the order to place".
 *
 * A low-stock list on its own is a report. What a pharmacy actually needs is:
 * how much to order, from whom, at what effective cost, and what the scheme
 * makes that worth. This service answers all four for every product that needs
 * replenishing, which is what turns the alert into a decision.
 */

export interface ReplenishmentLine {
  productId: number;
  productCode: string;
  productName: string;
  genericName: string | null;
  category: string;
  packSize: string | null;
  currentStock: number;
  reorderLevel: number;
  minimumStock: number;
  maximumStock: number;
  /** Average units sold per day over the analysis window. */
  avgDailySales: number;
  /** currentStock / avgDailySales, in days. null when nothing is selling. */
  stockCoverageDays: number | null;
  leadTimeDays: number;
  stockStatus: InventoryItem['stock_status'];
  /** Raw top-up quantity before any scheme optimisation. */
  requiredQty: number;
  /** Quantity to actually order, nudged to a scheme boundary where worthwhile. */
  suggestedQty: number;
  /** Free units the suggested quantity earns. */
  schemeFreeQty: number;
  /** Explains any adjustment between required and suggested. */
  quantityNote: string;
  lastPurchasePrice: number;
  /** Best distributor by effective cost, or null when nobody lists the product. */
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
  /** How urgently this needs ordering. */
  urgency: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  /** Plain-English justification, mirroring the Mini Analyst's contract. */
  reason: string;
}

/**
 * Urgency from stock coverage against lead time.
 *
 * The question is not "is stock low" but "will it run out before a replacement
 * can arrive". A product with 10 days of cover and a 2-day lead time is fine;
 * one with 3 days of cover and a 5-day lead time is already too late.
 */
function urgencyFor(coverageDays: number | null, leadTime: number, currentStock: number): ReplenishmentLine['urgency'] {
  if (currentStock <= 0) return 'CRITICAL';
  if (coverageDays === null) return 'LOW';
  if (coverageDays <= leadTime) return 'CRITICAL';
  if (coverageDays <= leadTime * 2) return 'HIGH';
  if (coverageDays <= leadTime * 4) return 'MEDIUM';
  return 'LOW';
}

const URGENCY_ORDER: Record<ReplenishmentLine['urgency'], number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

export interface ReplenishmentQuery {
  search?: string;
  category?: string;
  urgency?: string;
  /** Include products that are merely below maximum, not just below reorder level. */
  includeAll?: boolean;
}

export function getReplenishmentPlan(query: ReplenishmentQuery = {}): {
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
} {
  const thresholds = getThresholds();
  const inventory = getInventory();

  const candidates = inventory.filter((item) => {
    if (item.status !== 'ACTIVE') return false;
    if (query.includeAll) return item.current_stock < item.maximum_stock;
    return item.needs_reorder || item.current_stock === 0;
  });

  const lines: ReplenishmentLine[] = candidates.map((item) => {
    const leadTime = Number((item as InventoryItem & { lead_time_days?: number }).lead_time_days ?? 2) || 2;

    // Top back up to the maximum level, or to a month of demand when no
    // maximum is configured.
    const target = item.maximum_stock > 0 ? item.maximum_stock : Math.ceil(item.sales_velocity * 30);
    const requiredQty = Math.max(0, target - item.current_stock);

    // Ask the best supplier first, so the scheme can shape the quantity.
    const provisional = bestSupplierFor(item.id, Math.max(1, requiredQty));
    const optimised = optimiseOrderQty(
      requiredQty,
      provisional?.scheme_buy_qty,
      provisional?.scheme_free_qty,
    );

    // Re-price at the final quantity - the effective cost moves once the
    // quantity lands on a scheme boundary.
    const supplier: SupplierOption | null =
      optimised.quantity > 0 ? bestSupplierFor(item.id, optimised.quantity) : provisional;

    const urgency = urgencyFor(item.stock_coverage_days, leadTime, item.current_stock);

    const coverageText =
      item.stock_coverage_days === null
        ? 'no recent sales, so coverage cannot be projected'
        : `${round1(item.stock_coverage_days)} days of cover at ${round1(item.sales_velocity)} units/day`;

    const reason =
      item.current_stock === 0
        ? `Out of stock with demand of ${round1(item.sales_velocity)} units/day. Every day unstocked is lost revenue.`
        : `Stock is ${item.current_stock} against a reorder level of ${item.reorder_level} — ${coverageText}, versus a ${leadTime}-day lead time.`;

    return {
      productId: item.id,
      productCode: item.product_code,
      productName: item.product_name,
      genericName: item.generic_name,
      category: item.category,
      packSize: item.pack_size,
      currentStock: item.current_stock,
      reorderLevel: item.reorder_level,
      minimumStock: item.minimum_stock,
      maximumStock: item.maximum_stock,
      avgDailySales: round1(item.sales_velocity),
      stockCoverageDays: item.stock_coverage_days === null ? null : round1(item.stock_coverage_days),
      leadTimeDays: leadTime,
      stockStatus: item.stock_status,
      requiredQty,
      suggestedQty: optimised.quantity,
      schemeFreeQty: optimised.freeQty,
      quantityNote: optimised.reason,
      lastPurchasePrice: round2(item.purchase_price),
      supplier: supplier
        ? {
            distributorId: supplier.distributor_id,
            name: supplier.distributor_name,
            ptr: supplier.ptr,
            schemeLabel: supplier.scheme_label,
            effectiveCost: supplier.effective_cost,
            availableQty: supplier.available_qty,
            deliveryDays: supplier.delivery_days,
            canFulfil: supplier.available_qty >= optimised.quantity,
            estimatedCost: round2(supplier.effective_cost * (optimised.quantity + optimised.freeQty)),
            savings: supplier.savings,
          }
        : null,
      urgency,
      reason,
    };
  });

  let filtered = lines;
  if (query.category && query.category !== 'ALL') {
    filtered = filtered.filter((l) => l.category === query.category);
  }
  if (query.urgency && query.urgency !== 'ALL') {
    filtered = filtered.filter((l) => l.urgency === query.urgency);
  }
  if (query.search) {
    const needle = query.search.toLowerCase().trim();
    filtered = filtered.filter((l) =>
      [l.productName, l.genericName, l.productCode, l.category]
        .filter(Boolean)
        .some((f) => String(f).toLowerCase().includes(needle)),
    );
  }

  filtered.sort((a, b) => {
    const byUrgency = URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency];
    if (byUrgency !== 0) return byUrgency;
    return (a.stockCoverageDays ?? 9999) - (b.stockCoverageDays ?? 9999);
  });

  return {
    lines: filtered,
    summary: {
      products: filtered.length,
      critical: filtered.filter((l) => l.urgency === 'CRITICAL').length,
      high: filtered.filter((l) => l.urgency === 'HIGH').length,
      outOfStock: filtered.filter((l) => l.currentStock === 0).length,
      estimatedCost: round2(filtered.reduce((s, l) => s + (l.supplier?.estimatedCost ?? 0), 0)),
      estimatedSavings: round2(filtered.reduce((s, l) => s + (l.supplier?.savings ?? 0), 0)),
      unsourced: filtered.filter((l) => l.supplier === null).length,
    },
  };
}

/** One product's replenishment line — used by the Mini Analyst and Product Detail. */
export function getReplenishmentFor(productId: number): ReplenishmentLine | null {
  return (
    getReplenishmentPlan({ includeAll: true }).lines.find((l) => l.productId === productId) ?? null
  );
}
