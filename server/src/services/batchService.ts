import { getDb } from '../database/connection';
import { badRequest, notFound } from '../utils/errors';
import { daysUntil, today } from '../utils/dates';
import { round2 } from '../utils/money';
import { getThresholds } from './settingsService';
import { paginate, recordTransaction, type Paged } from './inventoryService';
import type { BatchRow } from '../types';

export type ExpiryBucket = 'EXPIRED' | 'DAYS_30' | 'DAYS_60' | 'DAYS_90' | 'SAFE';

export interface BatchWithContext extends BatchRow {
  product_name: string;
  product_code: string;
  category: string;
  supplier_name: string | null;
  days_to_expiry: number;
  expiry_bucket: ExpiryBucket;
  stock_value: number;
}

/** Buckets a batch by remaining shelf life. Used by the expiry screen and analyst. */
export function bucketExpiry(daysToExpiry: number, warningDays: number): ExpiryBucket {
  if (daysToExpiry < 0) return 'EXPIRED';
  if (daysToExpiry <= 30) return 'DAYS_30';
  if (daysToExpiry <= 60) return 'DAYS_60';
  if (daysToExpiry <= Math.max(90, warningDays)) return 'DAYS_90';
  return 'SAFE';
}

export function allBatches(): BatchWithContext[] {
  const t = getThresholds();
  const rows = getDb()
    .prepare(
      `SELECT b.*, p.product_name, p.product_code, p.category, s.supplier_name
       FROM product_batches b
       JOIN products p ON p.id = b.product_id
       LEFT JOIN suppliers s ON s.id = b.supplier_id
       ORDER BY b.expiry_date ASC`,
    )
    .all() as (BatchRow & {
    product_name: string;
    product_code: string;
    category: string;
    supplier_name: string | null;
  })[];

  return rows.map((b) => {
    const days = daysUntil(b.expiry_date);
    return {
      ...b,
      days_to_expiry: days,
      expiry_bucket: bucketExpiry(days, t.expiryWarningDays),
      stock_value: round2(b.quantity * b.purchase_price),
    };
  });
}

export function queryBatches(query: {
  search?: string;
  productId?: number;
  supplierId?: number;
  bucket?: ExpiryBucket | 'ALL';
  inStockOnly?: boolean;
  page?: number;
  pageSize?: number;
}): Paged<BatchWithContext> {
  let items = allBatches();

  if (query.productId) items = items.filter((b) => b.product_id === query.productId);
  if (query.supplierId) items = items.filter((b) => b.supplier_id === query.supplierId);
  if (query.bucket && query.bucket !== 'ALL') items = items.filter((b) => b.expiry_bucket === query.bucket);
  if (query.inStockOnly) items = items.filter((b) => b.quantity > 0);
  if (query.search) {
    const needle = query.search.toLowerCase().trim();
    items = items.filter((b) =>
      [b.product_name, b.product_code, b.batch_number, b.supplier_name]
        .filter(Boolean)
        .some((f) => String(f).toLowerCase().includes(needle)),
    );
  }
  return paginate(items, query.page, query.pageSize);
}

/** Batches expiring within `days`, with stock, ordered soonest-first (FEFO view). */
export function getExpiringBatches(days?: number): BatchWithContext[] {
  const t = getThresholds();
  const horizon = days ?? t.expiryWarningDays;
  return allBatches()
    .filter((b) => b.quantity > 0 && b.days_to_expiry >= 0 && b.days_to_expiry <= horizon)
    .sort((a, b) => a.days_to_expiry - b.days_to_expiry);
}

export function getExpiredBatches(): BatchWithContext[] {
  return allBatches().filter((b) => b.quantity > 0 && b.days_to_expiry < 0);
}

export function getBatch(id: number): BatchRow {
  const row = getDb().prepare('SELECT * FROM product_batches WHERE id = ?').get(id) as
    | BatchRow
    | undefined;
  if (!row) throw notFound('Batch');
  return row;
}

export interface BatchInput {
  product_id: number;
  batch_number: string;
  manufacturing_date?: string | null;
  expiry_date: string;
  quantity: number;
  purchase_price: number;
  selling_price: number;
  supplier_id?: number | null;
}

/** Creates a batch directly (opening stock / stock-take), logging the movement. */
export function createBatch(input: BatchInput): BatchRow {
  const db = getDb();
  if (input.manufacturing_date && input.manufacturing_date >= input.expiry_date) {
    throw badRequest('Expiry date must be after the manufacturing date.');
  }
  return db.transaction(() => {
    const exists = db.prepare('SELECT id FROM products WHERE id = ?').get(input.product_id);
    if (!exists) throw notFound('Product');

    const result = db
      .prepare(
        `INSERT INTO product_batches
          (product_id, batch_number, manufacturing_date, expiry_date, quantity,
           purchase_price, selling_price, supplier_id)
         VALUES (@product_id, @batch_number, @manufacturing_date, @expiry_date, @quantity,
                 @purchase_price, @selling_price, @supplier_id)`,
      )
      .run({
        product_id: input.product_id,
        batch_number: input.batch_number.trim(),
        manufacturing_date: input.manufacturing_date ?? null,
        expiry_date: input.expiry_date,
        quantity: input.quantity,
        purchase_price: input.purchase_price,
        selling_price: input.selling_price,
        supplier_id: input.supplier_id ?? null,
      });

    const batchId = Number(result.lastInsertRowid);
    if (input.quantity > 0) {
      recordTransaction(db, {
        productId: input.product_id,
        batchId,
        type: 'STOCK_RECEIVED',
        quantity: input.quantity,
        referenceType: 'MANUAL',
        notes: 'Batch created directly',
      });
    }
    return getBatch(batchId);
  })();
}

export function updateBatch(
  id: number,
  input: Partial<Pick<BatchInput, 'expiry_date' | 'manufacturing_date' | 'selling_price' | 'purchase_price' | 'supplier_id'>> & {
    status?: BatchRow['status'];
  },
): BatchRow {
  const batch = getBatch(id);
  getDb()
    .prepare(
      `UPDATE product_batches SET
         expiry_date = @expiry_date, manufacturing_date = @manufacturing_date,
         selling_price = @selling_price, purchase_price = @purchase_price,
         supplier_id = @supplier_id, status = @status, updated_at = datetime('now')
       WHERE id = @id`,
    )
    .run({
      id,
      expiry_date: input.expiry_date ?? batch.expiry_date,
      manufacturing_date: input.manufacturing_date ?? batch.manufacturing_date,
      selling_price: input.selling_price ?? batch.selling_price,
      purchase_price: input.purchase_price ?? batch.purchase_price,
      supplier_id: input.supplier_id === undefined ? batch.supplier_id : input.supplier_id,
      status: input.status ?? batch.status,
    });
  return getBatch(id);
}

/**
 * Writes off every expired batch that still carries stock, recording an EXPIRED
 * inventory transaction per batch so the loss is auditable.
 */
export function writeOffExpired(): { batches: number; units: number; value: number } {
  const db = getDb();
  return db.transaction(() => {
    const expired = db
      .prepare(
        `SELECT * FROM product_batches
         WHERE quantity > 0 AND status = 'ACTIVE' AND expiry_date < ?`,
      )
      .all(today()) as BatchRow[];

    let units = 0;
    let value = 0;
    for (const b of expired) {
      recordTransaction(db, {
        productId: b.product_id,
        batchId: b.id,
        type: 'EXPIRED',
        quantity: -b.quantity,
        referenceType: 'MANUAL',
        notes: `Expired on ${b.expiry_date}`,
      });
      db.prepare(
        `UPDATE product_batches SET quantity = 0, status = 'WRITTEN_OFF', updated_at = datetime('now')
         WHERE id = ?`,
      ).run(b.id);
      units += b.quantity;
      value += b.quantity * b.purchase_price;
    }
    return { batches: expired.length, units, value: round2(value) };
  })();
}
