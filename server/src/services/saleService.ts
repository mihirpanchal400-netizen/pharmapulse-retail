import { getDb, type Db } from '../database/connection';
import { badRequest, notFound } from '../utils/errors';
import { round2, safeDiv } from '../utils/money';
import { now, today } from '../utils/dates';
import { allocateFefo, changeBatchQuantity, recordTransaction, paginate, type Paged } from './inventoryService';
import { nextDocumentNumber, getPharmacyProfile } from './settingsService';
import type { BatchRow, PaymentMethod, ProductRow, SaleItemRow, SaleRow } from '../types';

/**
 * Sales / POS service.
 *
 * Pricing convention
 * ------------------
 * `selling_price` is treated as NET of tax. For every line:
 *
 *   gross    = selling_price x quantity
 *   taxable  = gross - discount          <- this is the revenue figure analytics use
 *   tax      = taxable x tax_rate / 100
 *   total    = taxable + tax
 *
 * Sale-level (bill) discount is distributed across lines in proportion to their
 * gross amount, so tax is always charged on the actually-discounted value.
 *
 * Batch traceability
 * ------------------
 * One `sale_items` row is written per BATCH consumed. Selling 10 units that span
 * two batches produces two rows, each carrying the batch's own purchase price.
 * That is what makes COGS - and therefore gross profit - accurate per batch.
 */

export interface SaleItemInput {
  product_id: number;
  quantity: number;
  /** Optional explicit batch. When omitted, FEFO picks the batch(es). */
  batch_id?: number | null;
  /** Absolute discount amount for this line (not a percentage). */
  discount?: number;
  /** Overrides the product's selling price when the cashier edits the rate. */
  selling_price?: number;
}

export interface SaleInput {
  items: SaleItemInput[];
  customer_id?: number | null;
  payment_method?: PaymentMethod;
  /** Absolute discount applied to the whole bill, distributed across lines. */
  bill_discount?: number;
  notes?: string | null;
  sale_date?: string;
  user_id?: number | null;
}

interface ResolvedLine {
  product: ProductRow;
  batch: BatchRow;
  quantity: number;
  sellingPrice: number;
  gross: number;
  discount: number;
  taxable: number;
  tax: number;
  total: number;
  cogs: number;
}

/** Resolves cart lines into concrete batch allocations with all money computed. */
function resolveLines(db: Db, input: SaleInput): ResolvedLine[] {
  if (!input.items?.length) throw badRequest('Add at least one product to the sale.');

  const draft: {
    product: ProductRow;
    batch: BatchRow;
    quantity: number;
    sellingPrice: number;
    lineDiscount: number;
  }[] = [];

  // Aggregate requested quantity per product so FEFO sees the true demand even
  // when the same product is added to the cart twice.
  for (const item of input.items) {
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      throw badRequest('Quantity must be a whole number of at least 1.');
    }

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id) as
      | ProductRow
      | undefined;
    if (!product) throw notFound('Product');
    if (product.status !== 'ACTIVE') {
      throw badRequest(`${product.product_name} is inactive and cannot be sold.`);
    }

    const unitPrice = item.selling_price ?? product.selling_price;
    if (unitPrice < 0) throw badRequest('Selling price cannot be negative.');

    let allocation: { batch: BatchRow; quantity: number }[];

    if (item.batch_id) {
      const batch = db.prepare('SELECT * FROM product_batches WHERE id = ?').get(item.batch_id) as
        | BatchRow
        | undefined;
      if (!batch) throw notFound('Batch');
      if (batch.product_id !== product.id) {
        throw badRequest(`Batch ${batch.batch_number} does not belong to ${product.product_name}.`);
      }
      if (batch.status !== 'ACTIVE') {
        throw badRequest(`Batch ${batch.batch_number} is ${batch.status.toLowerCase()} and cannot be sold.`);
      }
      if (batch.expiry_date < today()) {
        throw badRequest(
          `Batch ${batch.batch_number} of ${product.product_name} expired on ${batch.expiry_date} and cannot be sold.`,
        );
      }
      if (batch.quantity < item.quantity) {
        throw badRequest(
          `Batch ${batch.batch_number} has only ${batch.quantity} unit(s) available.`,
        );
      }
      allocation = [{ batch, quantity: item.quantity }];
    } else {
      allocation = allocateFefo(product.id, item.quantity, db);
    }

    const perUnitDiscount = safeDiv(item.discount ?? 0, item.quantity);
    for (const part of allocation) {
      draft.push({
        product,
        batch: part.batch,
        quantity: part.quantity,
        sellingPrice: unitPrice,
        lineDiscount: round2(perUnitDiscount * part.quantity),
      });
    }
  }

  // Distribute the bill-level discount proportionally to line gross value.
  const totalGross = draft.reduce((sum, l) => sum + l.sellingPrice * l.quantity, 0);
  const billDiscount = Math.max(0, input.bill_discount ?? 0);
  if (billDiscount > totalGross) {
    throw badRequest('Bill discount cannot be greater than the bill value.');
  }

  return draft.map((l) => {
    const gross = round2(l.sellingPrice * l.quantity);
    const share = totalGross > 0 ? gross / totalGross : 0;
    const discount = round2(Math.min(gross, l.lineDiscount + billDiscount * share));
    const taxable = round2(gross - discount);
    const tax = round2(taxable * (l.product.tax_rate / 100));
    return {
      product: l.product,
      batch: l.batch,
      quantity: l.quantity,
      sellingPrice: l.sellingPrice,
      gross,
      discount,
      taxable,
      tax,
      total: round2(taxable + tax),
      cogs: round2(l.batch.purchase_price * l.quantity),
    };
  });
}

export function createSale(input: SaleInput): SaleRow & { items: SaleItemRow[] } {
  const db = getDb();

  return db.transaction(() => {
    const lines = resolveLines(db, input);

    const subtotal = round2(lines.reduce((s, l) => s + l.gross, 0));
    const discount = round2(lines.reduce((s, l) => s + l.discount, 0));
    const tax = round2(lines.reduce((s, l) => s + l.tax, 0));
    const total = round2(lines.reduce((s, l) => s + l.total, 0));
    const cogs = round2(lines.reduce((s, l) => s + l.cogs, 0));

    if (input.customer_id) {
      const customer = db.prepare('SELECT id FROM customers WHERE id = ?').get(input.customer_id);
      if (!customer) throw notFound('Customer');
    }

    const invoiceNumber = nextDocumentNumber(
      'sales',
      'invoice_number',
      getPharmacyProfile().invoice_prefix,
    );
    const saleDate = input.sale_date ?? now();

    const saleResult = db
      .prepare(
        `INSERT INTO sales
          (invoice_number, customer_id, user_id, sale_date, subtotal, discount, tax, total, cogs,
           payment_method, status, notes)
         VALUES (@invoice_number, @customer_id, @user_id, @sale_date, @subtotal, @discount, @tax,
                 @total, @cogs, @payment_method, 'COMPLETED', @notes)`,
      )
      .run({
        invoice_number: invoiceNumber,
        customer_id: input.customer_id ?? null,
        user_id: input.user_id ?? null,
        sale_date: saleDate,
        subtotal,
        discount,
        tax,
        total,
        cogs,
        payment_method: input.payment_method ?? 'CASH',
        notes: input.notes ?? null,
      });

    const saleId = Number(saleResult.lastInsertRowid);
    const insertItem = db.prepare(
      `INSERT INTO sale_items
        (sale_id, product_id, batch_id, quantity, selling_price, purchase_price, discount, tax, line_total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const line of lines) {
      insertItem.run(
        saleId,
        line.product.id,
        line.batch.id,
        line.quantity,
        line.sellingPrice,
        line.batch.purchase_price,
        line.discount,
        line.tax,
        line.total,
      );
      // Deduct stock and log the movement.
      changeBatchQuantity(db, line.batch.id, -line.quantity);
      recordTransaction(db, {
        productId: line.product.id,
        batchId: line.batch.id,
        type: 'SALE',
        quantity: -line.quantity,
        referenceId: saleId,
        referenceType: 'SALE',
        notes: invoiceNumber,
        date: saleDate,
      });
    }

    return getSale(saleId);
  })();
}

export function getSale(id: number): SaleRow & { items: SaleItemRow[] } {
  const db = getDb();
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(id) as SaleRow | undefined;
  if (!sale) throw notFound('Sale');

  const items = db
    .prepare(
      `SELECT si.*, p.product_name, p.product_code, p.strength, p.pack_size, p.tax_rate,
              b.batch_number, b.expiry_date
       FROM sale_items si
       JOIN products p ON p.id = si.product_id
       LEFT JOIN product_batches b ON b.id = si.batch_id
       WHERE si.sale_id = ?
       ORDER BY si.id`,
    )
    .all(id) as SaleItemRow[];

  return { ...sale, items };
}

/** Full invoice payload used by the printable receipt view. */
export function getInvoice(id: number) {
  const sale = getSale(id);
  const db = getDb();
  const customer = sale.customer_id
    ? db.prepare('SELECT * FROM customers WHERE id = ?').get(sale.customer_id)
    : null;
  const cashier = sale.user_id
    ? db.prepare('SELECT full_name, role FROM users WHERE id = ?').get(sale.user_id)
    : null;
  const returns = db
    .prepare('SELECT * FROM sale_returns WHERE sale_id = ? ORDER BY id')
    .all(id);

  return { sale, customer, cashier, pharmacy: getPharmacyProfile(), returns };
}

export interface SaleQuery {
  search?: string;
  from?: string;
  to?: string;
  paymentMethod?: PaymentMethod | 'ALL';
  status?: string;
  customerId?: number;
  page?: number;
  pageSize?: number;
}

export function listSales(q: SaleQuery): Paged<Record<string, unknown>> & { summary: Record<string, number> } {
  const where: string[] = [];
  const params: Record<string, unknown> = {};

  if (q.from) {
    where.push('date(s.sale_date) >= @from');
    params.from = q.from;
  }
  if (q.to) {
    where.push('date(s.sale_date) <= @to');
    params.to = q.to;
  }
  if (q.paymentMethod && q.paymentMethod !== 'ALL') {
    where.push('s.payment_method = @paymentMethod');
    params.paymentMethod = q.paymentMethod;
  }
  if (q.status && q.status !== 'ALL') {
    where.push('s.status = @status');
    params.status = q.status;
  }
  if (q.customerId) {
    where.push('s.customer_id = @customerId');
    params.customerId = q.customerId;
  }
  if (q.search) {
    where.push('(s.invoice_number LIKE @like OR c.name LIKE @like OR c.phone LIKE @like)');
    params.like = `%${q.search.trim()}%`;
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const db = getDb();

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(s.total),0) AS revenue,
              COALESCE(SUM(s.total - s.tax),0) AS net_revenue,
              COALESCE(SUM(s.cogs),0) AS cogs
       FROM sales s LEFT JOIN customers c ON c.id = s.customer_id ${clause}`,
    )
    .get(params) as { n: number; revenue: number; net_revenue: number; cogs: number };

  const pageSize = Math.max(1, Math.min(q.pageSize ?? 25, 500));
  const totalPages = Math.max(1, Math.ceil(totals.n / pageSize));
  const page = Math.min(Math.max(1, q.page ?? 1), totalPages);

  const data = db
    .prepare(
      `SELECT s.*, c.name AS customer_name, c.phone AS customer_phone, u.full_name AS cashier,
              (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) AS item_count
       FROM sales s
       LEFT JOIN customers c ON c.id = s.customer_id
       LEFT JOIN users u ON u.id = s.user_id
       ${clause}
       ORDER BY s.sale_date DESC, s.id DESC
       LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit: pageSize, offset: (page - 1) * pageSize }) as Record<string, unknown>[];

  return {
    data,
    page,
    pageSize,
    total: totals.n,
    totalPages,
    summary: {
      transactions: totals.n,
      revenue: round2(totals.revenue),
      grossProfit: round2(totals.net_revenue - totals.cogs),
      averageBill: round2(safeDiv(totals.revenue, totals.n)),
    },
  };
}

/** Looks a sale up by invoice number - the entry point of the returns flow. */
export function findByInvoice(invoiceNumber: string) {
  const row = getDb()
    .prepare('SELECT id FROM sales WHERE invoice_number = ?')
    .get(invoiceNumber.trim()) as { id: number } | undefined;
  if (!row) throw notFound(`Invoice ${invoiceNumber}`);
  return getInvoice(row.id);
}

export type ReturnReason = 'CUSTOMER_RETURN' | 'DAMAGED' | 'WRONG_ITEM' | 'OTHER';

export interface ReturnInput {
  sale_id: number;
  reason: ReturnReason;
  items: { sale_item_id: number; quantity: number }[];
  /** Damaged goods normally do not go back on the shelf. */
  restock?: boolean;
  notes?: string | null;
  user_id?: number | null;
}

/**
 * Processes a sales return.
 *
 * The original invoice is never rewritten - returns are recorded separately and
 * `sale_items.returned_quantity` is incremented, so analytics can net returns out
 * of revenue while the printed invoice stays historically accurate.
 */
export function createReturn(input: ReturnInput) {
  const db = getDb();

  return db.transaction(() => {
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(input.sale_id) as
      | SaleRow
      | undefined;
    if (!sale) throw notFound('Sale');
    if (sale.status === 'CANCELLED') throw badRequest('This sale has been cancelled.');
    if (!input.items?.length) throw badRequest('Select at least one item to return.');

    const restock = input.reason === 'DAMAGED' ? (input.restock ?? false) : (input.restock ?? true);
    const returnNumber = nextDocumentNumber(
      'sale_returns',
      'return_number',
      getPharmacyProfile().return_prefix,
    );

    const returnResult = db
      .prepare(
        `INSERT INTO sale_returns (return_number, sale_id, user_id, return_date, reason, refund_amount, notes)
         VALUES (?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(returnNumber, sale.id, input.user_id ?? null, now(), input.reason, input.notes ?? null);
    const returnId = Number(returnResult.lastInsertRowid);

    let refundTotal = 0;

    for (const line of input.items) {
      if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
        throw badRequest('Return quantity must be a whole number of at least 1.');
      }
      const item = db.prepare('SELECT * FROM sale_items WHERE id = ?').get(line.sale_item_id) as
        | SaleItemRow
        | undefined;
      if (!item || item.sale_id !== sale.id) {
        throw badRequest('One of the selected items does not belong to this invoice.');
      }

      const returnable = item.quantity - item.returned_quantity;
      if (line.quantity > returnable) {
        throw badRequest(
          `Only ${returnable} unit(s) of this line remain returnable (${item.returned_quantity} already returned).`,
        );
      }

      // Refund the customer exactly what they paid per unit, tax included.
      const refund = round2(safeDiv(item.line_total, item.quantity) * line.quantity);
      refundTotal += refund;

      db.prepare('UPDATE sale_items SET returned_quantity = returned_quantity + ? WHERE id = ?').run(
        line.quantity,
        item.id,
      );
      db.prepare(
        `INSERT INTO sale_return_items (return_id, sale_item_id, product_id, batch_id, quantity, refund_amount, restock)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(returnId, item.id, item.product_id, item.batch_id, line.quantity, refund, restock ? 1 : 0);

      if (restock && item.batch_id) {
        changeBatchQuantity(db, item.batch_id, line.quantity);
        recordTransaction(db, {
          productId: item.product_id,
          batchId: item.batch_id,
          type: 'RETURN',
          quantity: line.quantity,
          referenceId: returnId,
          referenceType: 'RETURN',
          notes: `${returnNumber} against ${sale.invoice_number}`,
        });
      } else {
        // Not restocked (damaged / destroyed): the units never re-enter sellable
        // stock, so they are logged as a loss rather than a stock increase.
        recordTransaction(db, {
          productId: item.product_id,
          batchId: item.batch_id,
          type: 'DAMAGED',
          quantity: 0,
          referenceId: returnId,
          referenceType: 'RETURN',
          notes: `${returnNumber}: returned but not restocked (${input.reason})`,
        });
      }
    }

    db.prepare('UPDATE sale_returns SET refund_amount = ? WHERE id = ?').run(
      round2(refundTotal),
      returnId,
    );

    const remaining = db
      .prepare(
        'SELECT COALESCE(SUM(quantity - returned_quantity), 0) AS n FROM sale_items WHERE sale_id = ?',
      )
      .get(sale.id) as { n: number };
    db.prepare('UPDATE sales SET status = ? WHERE id = ?').run(
      remaining.n === 0 ? 'RETURNED' : 'PARTIALLY_RETURNED',
      sale.id,
    );

    return {
      id: returnId,
      return_number: returnNumber,
      refund_amount: round2(refundTotal),
      restocked: restock,
      sale_id: sale.id,
    };
  })();
}

export function listReturns(q: { page?: number; pageSize?: number; from?: string; to?: string }) {
  const rows = getDb()
    .prepare(
      `SELECT r.*, s.invoice_number, c.name AS customer_name,
              (SELECT COALESCE(SUM(quantity),0) FROM sale_return_items ri WHERE ri.return_id = r.id) AS units
       FROM sale_returns r
       JOIN sales s ON s.id = r.sale_id
       LEFT JOIN customers c ON c.id = s.customer_id
       ORDER BY r.return_date DESC, r.id DESC`,
    )
    .all() as Record<string, unknown>[];

  let items = rows;
  if (q.from) items = items.filter((r) => String(r.return_date) >= q.from!);
  if (q.to) items = items.filter((r) => String(r.return_date).slice(0, 10) <= q.to!);
  return paginate(items, q.page, q.pageSize);
}
