import { getDb } from '../database/connection';
import { badRequest, notFound } from '../utils/errors';
import { round2 } from '../utils/money';
import { today } from '../utils/dates';
import { recordTransaction, paginate, type Paged } from './inventoryService';
import { nextDocumentNumber, getPharmacyProfile } from './settingsService';
import type { BatchRow, ProductRow, PurchaseItemRow, PurchaseRow } from '../types';

/**
 * Purchases (goods inward).
 *
 * Receiving stock is the only routine way inventory increases. Each purchase line
 * either creates a new batch or tops up an existing batch with the same
 * (product, batch_number) pair, then writes a STOCK_RECEIVED audit row.
 */

export interface PurchaseItemInput {
  product_id: number;
  batch_number: string;
  quantity: number;
  purchase_price: number;
  selling_price?: number;
  expiry_date: string;
  manufacturing_date?: string | null;
  tax_rate?: number;
  /** Refresh the product master's default prices from this purchase. Default: true. */
  update_product_price?: boolean;
}

export interface PurchaseInput {
  supplier_id: number;
  items: PurchaseItemInput[];
  purchase_date?: string;
  payment_status?: 'PAID' | 'PARTIAL' | 'UNPAID';
  notes?: string | null;
  user_id?: number | null;
}

export function createPurchase(input: PurchaseInput): PurchaseRow & { items: PurchaseItemRow[] } {
  const db = getDb();

  return db.transaction(() => {
    if (!input.items?.length) throw badRequest('Add at least one product to the purchase.');

    const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(input.supplier_id);
    if (!supplier) throw notFound('Supplier');

    const purchaseDate = input.purchase_date ?? today();
    const purchaseNumber = nextDocumentNumber(
      'purchases',
      'purchase_number',
      getPharmacyProfile().purchase_prefix,
    );

    const purchaseResult = db
      .prepare(
        `INSERT INTO purchases
           (purchase_number, supplier_id, user_id, purchase_date, subtotal, tax, total, payment_status, notes)
         VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?)`,
      )
      .run(
        purchaseNumber,
        input.supplier_id,
        input.user_id ?? null,
        purchaseDate,
        input.payment_status ?? 'PAID',
        input.notes ?? null,
      );
    const purchaseId = Number(purchaseResult.lastInsertRowid);

    let subtotal = 0;
    let taxTotal = 0;

    for (const item of input.items) {
      if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
        throw badRequest('Purchase quantity must be a whole number of at least 1.');
      }
      if (item.purchase_price < 0) throw badRequest('Purchase price cannot be negative.');
      if (!item.batch_number?.trim()) throw badRequest('Every purchase line needs a batch number.');
      if (item.expiry_date <= purchaseDate) {
        throw badRequest(
          `Batch ${item.batch_number} expires on ${item.expiry_date}, which is not after the purchase date.`,
        );
      }

      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id) as
        | ProductRow
        | undefined;
      if (!product) throw notFound('Product');

      const sellingPrice = item.selling_price ?? product.selling_price;
      if (sellingPrice < item.purchase_price) {
        throw badRequest(
          `Selling price for ${product.product_name} (${sellingPrice}) is below its purchase price (${item.purchase_price}).`,
        );
      }
      const taxRate = item.tax_rate ?? product.tax_rate;
      const batchNumber = item.batch_number.trim();

      // Top up an existing batch, or open a new one.
      const existing = db
        .prepare('SELECT * FROM product_batches WHERE product_id = ? AND batch_number = ?')
        .get(item.product_id, batchNumber) as BatchRow | undefined;

      let batchId: number;
      if (existing) {
        db.prepare(
          `UPDATE product_batches
             SET quantity = quantity + ?, purchase_price = ?, selling_price = ?,
                 expiry_date = ?, supplier_id = ?, status = 'ACTIVE', updated_at = datetime('now')
           WHERE id = ?`,
        ).run(
          item.quantity,
          item.purchase_price,
          sellingPrice,
          item.expiry_date,
          input.supplier_id,
          existing.id,
        );
        batchId = existing.id;
      } else {
        const batchResult = db
          .prepare(
            `INSERT INTO product_batches
              (product_id, batch_number, manufacturing_date, expiry_date, quantity,
               purchase_price, selling_price, supplier_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            item.product_id,
            batchNumber,
            item.manufacturing_date ?? null,
            item.expiry_date,
            item.quantity,
            item.purchase_price,
            sellingPrice,
            input.supplier_id,
          );
        batchId = Number(batchResult.lastInsertRowid);
      }

      const lineNet = round2(item.purchase_price * item.quantity);
      const lineTax = round2(lineNet * (taxRate / 100));
      subtotal += lineNet;
      taxTotal += lineTax;

      db.prepare(
        `INSERT INTO purchase_items
          (purchase_id, product_id, batch_id, batch_number, quantity, purchase_price,
           selling_price, expiry_date, tax_rate, line_total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        purchaseId,
        item.product_id,
        batchId,
        batchNumber,
        item.quantity,
        item.purchase_price,
        sellingPrice,
        item.expiry_date,
        taxRate,
        round2(lineNet + lineTax),
      );

      recordTransaction(db, {
        productId: item.product_id,
        batchId,
        type: 'STOCK_RECEIVED',
        quantity: item.quantity,
        referenceId: purchaseId,
        referenceType: 'PURCHASE',
        notes: purchaseNumber,
        date: `${purchaseDate} 10:00:00`,
      });

      if (item.update_product_price !== false) {
        db.prepare(
          `UPDATE products SET purchase_price = ?, selling_price = ?, updated_at = datetime('now')
           WHERE id = ?`,
        ).run(item.purchase_price, sellingPrice, item.product_id);
      }
    }

    db.prepare('UPDATE purchases SET subtotal = ?, tax = ?, total = ? WHERE id = ?').run(
      round2(subtotal),
      round2(taxTotal),
      round2(subtotal + taxTotal),
      purchaseId,
    );

    return getPurchase(purchaseId);
  })();
}

export function getPurchase(id: number): PurchaseRow & { items: PurchaseItemRow[] } {
  const db = getDb();
  const purchase = db.prepare(
    `SELECT p.*, s.supplier_name, s.contact_person, s.phone AS supplier_phone
     FROM purchases p JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = ?`,
  ).get(id) as PurchaseRow | undefined;
  if (!purchase) throw notFound('Purchase');

  const items = db
    .prepare(
      `SELECT pi.*, pr.product_name, pr.product_code, pr.strength, pr.pack_size
       FROM purchase_items pi
       JOIN products pr ON pr.id = pi.product_id
       WHERE pi.purchase_id = ?
       ORDER BY pi.id`,
    )
    .all(id) as PurchaseItemRow[];

  return { ...purchase, items };
}

export function listPurchases(q: {
  search?: string;
  supplierId?: number;
  from?: string;
  to?: string;
  paymentStatus?: string;
  page?: number;
  pageSize?: number;
}): Paged<Record<string, unknown>> & { summary: Record<string, number> } {
  const where: string[] = [];
  const params: Record<string, unknown> = {};

  if (q.supplierId) {
    where.push('p.supplier_id = @supplierId');
    params.supplierId = q.supplierId;
  }
  if (q.from) {
    where.push('p.purchase_date >= @from');
    params.from = q.from;
  }
  if (q.to) {
    where.push('p.purchase_date <= @to');
    params.to = q.to;
  }
  if (q.paymentStatus && q.paymentStatus !== 'ALL') {
    where.push('p.payment_status = @paymentStatus');
    params.paymentStatus = q.paymentStatus;
  }
  if (q.search) {
    where.push('(p.purchase_number LIKE @like OR s.supplier_name LIKE @like)');
    params.like = `%${q.search.trim()}%`;
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const db = getDb();

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(p.total),0) AS value
       FROM purchases p JOIN suppliers s ON s.id = p.supplier_id ${clause}`,
    )
    .get(params) as { n: number; value: number };

  const pageSize = Math.max(1, Math.min(q.pageSize ?? 25, 500));
  const totalPages = Math.max(1, Math.ceil(totals.n / pageSize));
  const page = Math.min(Math.max(1, q.page ?? 1), totalPages);

  const data = db
    .prepare(
      `SELECT p.*, s.supplier_name,
              (SELECT COUNT(*) FROM purchase_items pi WHERE pi.purchase_id = p.id) AS item_count,
              (SELECT COALESCE(SUM(quantity),0) FROM purchase_items pi WHERE pi.purchase_id = p.id) AS units
       FROM purchases p JOIN suppliers s ON s.id = p.supplier_id
       ${clause}
       ORDER BY p.purchase_date DESC, p.id DESC
       LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit: pageSize, offset: (page - 1) * pageSize }) as Record<string, unknown>[];

  return {
    data,
    page,
    pageSize,
    total: totals.n,
    totalPages,
    summary: { purchases: totals.n, value: round2(totals.value) },
  };
}

export function updatePaymentStatus(id: number, status: 'PAID' | 'PARTIAL' | 'UNPAID') {
  getPurchase(id);
  getDb().prepare('UPDATE purchases SET payment_status = ? WHERE id = ?').run(status, id);
  return getPurchase(id);
}

/** Supplier-wise purchase summary used by the Reports screen. */
export function supplierPurchaseSummary(from?: string, to?: string) {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (from) {
    where.push('p.purchase_date >= @from');
    params.from = from;
  }
  if (to) {
    where.push('p.purchase_date <= @to');
    params.to = to;
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = getDb()
    .prepare(
      `SELECT s.id, s.supplier_name, s.contact_person, s.phone, s.payment_terms,
              COUNT(p.id) AS purchase_count,
              COALESCE(SUM(p.total), 0) AS total_value,
              COALESCE(SUM(CASE WHEN p.payment_status <> 'PAID' THEN p.total ELSE 0 END), 0) AS outstanding,
              MAX(p.purchase_date) AS last_purchase
       FROM suppliers s
       LEFT JOIN purchases p ON p.supplier_id = s.id ${clause ? clause.replace('WHERE', 'AND') : ''}
       GROUP BY s.id
       ORDER BY total_value DESC`,
    )
    .all(params) as Record<string, number | string>[];

  return rows.map((r) => ({
    ...r,
    total_value: round2(Number(r.total_value)),
    outstanding: round2(Number(r.outstanding)),
  }));
}
