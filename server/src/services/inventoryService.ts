import { getDb, type Db } from '../database/connection';
import { getThresholds } from './settingsService';
import { today, daysUntil } from '../utils/dates';
import { round2 } from '../utils/money';
import { badRequest, notFound } from '../utils/errors';
import type { BatchRow, StockStatus, TransactionType } from '../types';

/**
 * Inventory service.
 *
 * Stock model
 * -----------
 * `product_batches.quantity` is the source of truth. "Sellable stock" excludes
 * expired batches and batches that are not ACTIVE, because those units exist
 * physically but cannot legally be sold.
 *
 * Query strategy
 * --------------
 * The per-product roll-up is a single grouped SQL query (one row per product,
 * ~100-500 rows for a retail pharmacy). Classification, filtering and paging
 * then happen in TypeScript so the status rules live in exactly one place
 * (`classifyStock`) rather than being duplicated in SQL CASE expressions.
 */

export interface StockAggregateRow {
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
  current_stock: number;
  batch_count: number;
  inventory_value: number;
  retail_value: number;
  expired_stock: number;
  nearest_expiry: string | null;
  last_sale_date: string | null;
  units_sold_window: number;
}

export interface InventoryItem extends StockAggregateRow {
  stock_status: StockStatus;
  is_expiring: boolean;
  days_to_nearest_expiry: number | null;
  /** Average units sold per day over the analysis window. */
  sales_velocity: number;
  /** current_stock / sales_velocity, in days. null when nothing is selling. */
  stock_coverage_days: number | null;
  days_since_last_sale: number | null;
  needs_reorder: boolean;
}

/**
 * Mutually exclusive stock classification, evaluated in precedence order:
 *   OUT_OF_STOCK -> LOW_STOCK -> EXPIRING -> OVERSTOCKED -> HEALTHY
 *
 * Precedence matters: a product that is both low on stock and holding an
 * expiring batch is reported as LOW_STOCK, because replenishment is the more
 * urgent decision. The buckets stay non-overlapping so they can be charted.
 */
export function classifyStock(input: {
  currentStock: number;
  reorderLevel: number;
  maximumStock: number;
  daysToNearestExpiry: number | null;
  thresholds: { lowStockThresholdMultiplier: number; overstockMultiplier: number; expiryWarningDays: number };
}): StockStatus {
  const { currentStock, reorderLevel, maximumStock, daysToNearestExpiry, thresholds } = input;

  if (currentStock <= 0) return 'OUT_OF_STOCK';
  if (currentStock <= reorderLevel * thresholds.lowStockThresholdMultiplier) return 'LOW_STOCK';
  if (daysToNearestExpiry !== null && daysToNearestExpiry <= thresholds.expiryWarningDays) {
    return 'EXPIRING';
  }
  if (maximumStock > 0 && currentStock > maximumStock * thresholds.overstockMultiplier) {
    return 'OVERSTOCKED';
  }
  return 'HEALTHY';
}

/** One grouped query joining products to sellable batch stock and recent sales. */
export function getStockAggregate(windowDays?: number): StockAggregateRow[] {
  const t = getThresholds();
  const days = windowDays ?? t.analysisWindowDays;
  const day = today();
  const windowStart = new Date();
  windowStart.setDate(windowStart.getDate() - (days - 1));
  const windowStartIso = windowStart.toISOString().slice(0, 10);

  return getDb()
    .prepare(
      `SELECT
         p.id, p.product_code, p.product_name, p.generic_name, p.brand_name, p.category,
         p.dosage_form, p.strength, p.pack_size, p.manufacturer, p.prescription_flag,
         p.purchase_price, p.selling_price, p.tax_rate,
         p.reorder_level, p.minimum_stock, p.maximum_stock, p.status,
         COALESCE(sellable.qty, 0)            AS current_stock,
         COALESCE(sellable.batches, 0)        AS batch_count,
         COALESCE(sellable.cost_value, 0)     AS inventory_value,
         COALESCE(sellable.retail_value, 0)   AS retail_value,
         COALESCE(expired.qty, 0)             AS expired_stock,
         sellable.nearest_expiry              AS nearest_expiry,
         sold.last_sale_date                  AS last_sale_date,
         COALESCE(win.units, 0)               AS units_sold_window
       FROM products p
       LEFT JOIN (
         SELECT product_id,
                SUM(quantity)                  AS qty,
                COUNT(*)                       AS batches,
                SUM(quantity * purchase_price) AS cost_value,
                SUM(quantity * selling_price)  AS retail_value,
                MIN(expiry_date)               AS nearest_expiry
         FROM product_batches
         WHERE status = 'ACTIVE' AND quantity > 0 AND expiry_date >= @today
         GROUP BY product_id
       ) sellable ON sellable.product_id = p.id
       LEFT JOIN (
         SELECT product_id, SUM(quantity) AS qty
         FROM product_batches
         WHERE status = 'ACTIVE' AND quantity > 0 AND expiry_date < @today
         GROUP BY product_id
       ) expired ON expired.product_id = p.id
       LEFT JOIN (
         SELECT si.product_id, MAX(s.sale_date) AS last_sale_date
         FROM sale_items si JOIN sales s ON s.id = si.sale_id
         WHERE s.status <> 'CANCELLED'
         GROUP BY si.product_id
       ) sold ON sold.product_id = p.id
       LEFT JOIN (
         SELECT si.product_id, SUM(si.quantity - si.returned_quantity) AS units
         FROM sale_items si JOIN sales s ON s.id = si.sale_id
         WHERE s.status <> 'CANCELLED' AND date(s.sale_date) >= @windowStart
         GROUP BY si.product_id
       ) win ON win.product_id = p.id
       ORDER BY p.product_name`,
    )
    .all({ today: day, windowStart: windowStartIso }) as StockAggregateRow[];
}

/** Adds derived status, velocity and coverage figures to each aggregate row. */
export function enrichInventory(rows: StockAggregateRow[], windowDays?: number): InventoryItem[] {
  const t = getThresholds();
  const days = windowDays ?? t.analysisWindowDays;
  const day = today();

  return rows.map((r) => {
    const daysToExpiry = r.nearest_expiry ? daysUntil(r.nearest_expiry) : null;
    const velocity = days > 0 ? r.units_sold_window / days : 0;
    const coverage = velocity > 0 ? Math.round(r.current_stock / velocity) : null;
    const daysSinceSale = r.last_sale_date
      ? Math.max(
          0,
          Math.round(
            (new Date(day).getTime() - new Date(r.last_sale_date.slice(0, 10)).getTime()) /
              86_400_000,
          ),
        )
      : null;

    const stock_status = classifyStock({
      currentStock: r.current_stock,
      reorderLevel: r.reorder_level,
      maximumStock: r.maximum_stock,
      daysToNearestExpiry: daysToExpiry,
      thresholds: t,
    });

    return {
      ...r,
      inventory_value: round2(r.inventory_value),
      retail_value: round2(r.retail_value),
      stock_status,
      is_expiring: daysToExpiry !== null && daysToExpiry <= t.expiryWarningDays,
      days_to_nearest_expiry: daysToExpiry,
      sales_velocity: Math.round(velocity * 100) / 100,
      stock_coverage_days: coverage,
      days_since_last_sale: daysSinceSale,
      needs_reorder: r.current_stock <= r.reorder_level * t.lowStockThresholdMultiplier,
    };
  });
}

export function getInventory(windowDays?: number): InventoryItem[] {
  return enrichInventory(getStockAggregate(windowDays), windowDays);
}

export interface InventoryQuery {
  search?: string;
  category?: string;
  status?: StockStatus | 'ALL';
  supplierId?: number;
  prescriptionOnly?: boolean;
  productStatus?: 'ACTIVE' | 'INACTIVE' | 'ALL';
  sortBy?: keyof InventoryItem;
  sortDir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export interface Paged<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export function queryInventory(q: InventoryQuery): Paged<InventoryItem> {
  let items = getInventory();

  if (q.productStatus && q.productStatus !== 'ALL') {
    items = items.filter((i) => i.status === q.productStatus);
  }
  if (q.search) {
    const needle = q.search.toLowerCase().trim();
    items = items.filter((i) =>
      [i.product_name, i.generic_name, i.brand_name, i.product_code, i.category, i.manufacturer]
        .filter(Boolean)
        .some((f) => String(f).toLowerCase().includes(needle)),
    );
  }
  if (q.category && q.category !== 'ALL') items = items.filter((i) => i.category === q.category);
  if (q.status && q.status !== 'ALL') items = items.filter((i) => i.stock_status === q.status);
  if (q.prescriptionOnly) items = items.filter((i) => i.prescription_flag === 1);

  if (q.supplierId) {
    const ids = getDb()
      .prepare('SELECT DISTINCT product_id AS id FROM product_batches WHERE supplier_id = ?')
      .all(q.supplierId) as { id: number }[];
    const allowed = new Set(ids.map((r) => r.id));
    items = items.filter((i) => allowed.has(i.id));
  }

  const sortBy = q.sortBy ?? 'product_name';
  const dir = q.sortDir === 'desc' ? -1 : 1;
  items.sort((a, b) => {
    const av = a[sortBy] as unknown;
    const bv = b[sortBy] as unknown;
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });

  return paginate(items, q.page, q.pageSize);
}

export function paginate<T>(items: T[], page = 1, pageSize = 25): Paged<T> {
  const total = items.length;
  const size = Math.max(1, Math.min(pageSize, 500));
  const totalPages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, page), totalPages);
  return {
    data: items.slice((current - 1) * size, current * size),
    page: current,
    pageSize: size,
    total,
    totalPages,
  };
}

/** Sellable stock for a single product. */
export function getProductStock(productId: number): number {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(quantity), 0) AS qty FROM product_batches
       WHERE product_id = ? AND status = 'ACTIVE' AND expiry_date >= ?`,
    )
    .get(productId, today()) as { qty: number };
  return row.qty;
}

/**
 * FEFO - First Expiry, First Out.
 *
 * Returns sellable batches for a product ordered by earliest expiry first, so
 * the batch closest to expiry is consumed before newer stock. Expired batches
 * are excluded entirely: they must never be offered for sale.
 *
 * This is an inventory-rotation rule, not a clinical recommendation.
 */
export function getFefoBatches(productId: number, db: Db = getDb()): BatchRow[] {
  return db
    .prepare(
      `SELECT * FROM product_batches
       WHERE product_id = ? AND status = 'ACTIVE' AND quantity > 0 AND expiry_date >= ?
       ORDER BY expiry_date ASC, id ASC`,
    )
    .all(productId, today()) as BatchRow[];
}

/**
 * Allocates `quantity` units across batches following FEFO.
 * Throws a user-facing error when sellable stock is insufficient.
 */
export function allocateFefo(
  productId: number,
  quantity: number,
  db: Db = getDb(),
): { batch: BatchRow; quantity: number }[] {
  if (quantity <= 0) throw badRequest('Quantity must be at least 1.');

  const batches = getFefoBatches(productId, db);
  const available = batches.reduce((sum, b) => sum + b.quantity, 0);
  if (available < quantity) {
    const product = db.prepare('SELECT product_name FROM products WHERE id = ?').get(productId) as
      | { product_name: string }
      | undefined;
    throw badRequest(
      `Only ${available} sellable unit(s) of ${product?.product_name ?? 'this product'} are in stock. ` +
        `Expired batches are excluded from sale.`,
    );
  }

  const allocation: { batch: BatchRow; quantity: number }[] = [];
  let remaining = quantity;
  for (const batch of batches) {
    if (remaining <= 0) break;
    const take = Math.min(batch.quantity, remaining);
    allocation.push({ batch, quantity: take });
    remaining -= take;
  }
  return allocation;
}

/** Appends a row to the inventory audit log. `quantity` is signed. */
export function recordTransaction(
  db: Db,
  entry: {
    productId: number;
    batchId: number | null;
    type: TransactionType;
    quantity: number;
    referenceId?: number | null;
    referenceType?: string | null;
    notes?: string | null;
    date?: string;
  },
): void {
  db.prepare(
    `INSERT INTO inventory_transactions
       (product_id, batch_id, transaction_type, quantity, reference_id, reference_type, notes, transaction_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
  ).run(
    entry.productId,
    entry.batchId,
    entry.type,
    entry.quantity,
    entry.referenceId ?? null,
    entry.referenceType ?? null,
    entry.notes ?? null,
    entry.date ?? null,
  );
}

/**
 * Applies a signed change to a batch's quantity.
 * The CHECK constraint on `quantity >= 0` is the final guard, but we check here
 * too so the user sees a readable message instead of a SQLite error.
 */
export function changeBatchQuantity(db: Db, batchId: number, delta: number): BatchRow {
  const batch = db.prepare('SELECT * FROM product_batches WHERE id = ?').get(batchId) as
    | BatchRow
    | undefined;
  if (!batch) throw notFound('Batch');

  const next = batch.quantity + delta;
  if (next < 0) {
    throw badRequest(
      `Batch ${batch.batch_number} holds only ${batch.quantity} unit(s); stock cannot go negative.`,
    );
  }
  db.prepare(`UPDATE product_batches SET quantity = ?, updated_at = datetime('now') WHERE id = ?`).run(
    next,
    batchId,
  );
  return { ...batch, quantity: next };
}

/** Manual stock adjustment (damage, write-off, count correction). */
export function adjustStock(input: {
  batchId: number;
  quantity: number;
  type: Extract<TransactionType, 'ADJUSTMENT' | 'DAMAGED' | 'EXPIRED'>;
  notes?: string;
}): BatchRow {
  const db = getDb();
  return db.transaction(() => {
    const batch = db.prepare('SELECT * FROM product_batches WHERE id = ?').get(input.batchId) as
      | BatchRow
      | undefined;
    if (!batch) throw notFound('Batch');

    const updated = changeBatchQuantity(db, input.batchId, input.quantity);
    recordTransaction(db, {
      productId: batch.product_id,
      batchId: batch.id,
      type: input.type,
      quantity: input.quantity,
      referenceType: 'MANUAL',
      notes: input.notes ?? null,
    });
    return updated;
  })();
}

export function getTransactions(filters: {
  productId?: number;
  type?: TransactionType;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}): Paged<Record<string, unknown>> {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (filters.productId) {
    where.push('t.product_id = @productId');
    params.productId = filters.productId;
  }
  if (filters.type) {
    where.push('t.transaction_type = @type');
    params.type = filters.type;
  }
  if (filters.from) {
    where.push('date(t.transaction_date) >= @from');
    params.from = filters.from;
  }
  if (filters.to) {
    where.push('date(t.transaction_date) <= @to');
    params.to = filters.to;
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = (
    getDb()
      .prepare(`SELECT COUNT(*) AS n FROM inventory_transactions t ${clause}`)
      .get(params) as { n: number }
  ).n;

  const pageSize = Math.max(1, Math.min(filters.pageSize ?? 50, 500));
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, filters.page ?? 1), totalPages);

  const data = getDb()
    .prepare(
      `SELECT t.*, p.product_name, p.product_code, b.batch_number
       FROM inventory_transactions t
       JOIN products p ON p.id = t.product_id
       LEFT JOIN product_batches b ON b.id = t.batch_id
       ${clause}
       ORDER BY t.transaction_date DESC, t.id DESC
       LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit: pageSize, offset: (page - 1) * pageSize }) as Record<string, unknown>[];

  return { data, page, pageSize, total, totalPages };
}
