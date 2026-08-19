import { getDb, type Db } from '../database/connection';
import { badRequest, notFound } from '../utils/errors';
import { round2, safeDiv } from '../utils/money';
import { addDays, today } from '../utils/dates';
import { recordTransaction } from './inventoryService';
import { calculateScheme } from './schemeService';
import { getDistributor } from './distributorService';
import { logActivity } from './activityService';
import { paginate, type Paged } from './inventoryService';
import type { ProductRow } from '../types';

/**
 * PROCUREMENT
 * ===========
 *
 * The buying half of the pharmacy:
 *
 *   Replenishment need
 *        -> Supplier comparison (distributorService)
 *        -> Purchase Order      DRAFT -> SENT -> CONFIRMED
 *        -> Goods Receipt       creates batches, moves stock
 *        -> Supplier Invoice    creates the outstanding balance
 *        -> Payment             settles it
 *
 * IMPORTANT: "Sending" a purchase order changes a status column in this local
 * database and nothing else. No order is transmitted to any distributor,
 * platform or external service. The UI labels every order a SIMULATED PURCHASE
 * ORDER for exactly this reason.
 */

/* -------------------------------------------------------------------------- */
/* Document numbering                                                          */
/* -------------------------------------------------------------------------- */

function nextNumber(db: Db, table: string, column: string, prefix: string): string {
  const year = new Date().getFullYear();
  const row = db
    .prepare(`SELECT ${column} AS num FROM ${table} WHERE ${column} LIKE ? ORDER BY id DESC LIMIT 1`)
    .get(`${prefix}-${year}-%`) as { num: string } | undefined;

  let next = 1;
  if (row?.num) {
    const tail = Number(row.num.split('-').pop());
    if (Number.isFinite(tail)) next = tail + 1;
  }
  return `${prefix}-${year}-${String(next).padStart(5, '0')}`;
}

/* -------------------------------------------------------------------------- */
/* Purchase orders                                                             */
/* -------------------------------------------------------------------------- */

export interface PoLineInput {
  product_id: number;
  quantity: number;
  /** Overrides the catalogue rate when the buyer negotiates. */
  ptr?: number;
  scheme_buy_qty?: number;
  scheme_free_qty?: number;
  discount_pct?: number;
}

export interface PurchaseOrderInput {
  distributor_id: number;
  items: PoLineInput[];
  po_date?: string;
  expected_delivery?: string | null;
  payment_terms?: string | null;
  notes?: string | null;
  user_id?: number | null;
  username?: string | null;
  /** DRAFT keeps it editable; SENT marks it as issued to the distributor. */
  status?: 'DRAFT' | 'SENT';
}

export interface PurchaseOrderRow {
  id: number;
  po_number: string;
  distributor_id: number;
  user_id: number | null;
  po_date: string;
  expected_delivery: string | null;
  payment_terms: string | null;
  gross_amount: number;
  discount_amount: number;
  tax_amount: number;
  total_amount: number;
  free_units: number;
  savings_amount: number;
  status: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Creates a purchase order, pricing every line through the scheme engine.
 *
 * Catalogue terms are read from the distributor's own listing unless the caller
 * overrides them, so a PO always reflects what that distributor actually quotes.
 */
export function createPurchaseOrder(
  input: PurchaseOrderInput,
): PurchaseOrderRow & { items: Record<string, unknown>[] } {
  const db = getDb();

  return db.transaction(() => {
    if (!input.items?.length) throw badRequest('Add at least one product to the purchase order.');

    const distributor = getDistributor(input.distributor_id);
    const poDate = input.po_date ?? today();
    const poNumber = nextNumber(db, 'purchase_orders', 'po_number', 'PO');

    const poId = Number(
      db
        .prepare(
          `INSERT INTO purchase_orders
             (po_number, distributor_id, user_id, po_date, expected_delivery, payment_terms, status, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          poNumber,
          input.distributor_id,
          input.user_id ?? null,
          poDate,
          input.expected_delivery ?? addDays(poDate, distributor.delivery_days || 1),
          input.payment_terms ?? distributor.payment_terms,
          input.status ?? 'DRAFT',
          input.notes ?? null,
        ).lastInsertRowid,
    );

    let gross = 0;
    let discount = 0;
    let tax = 0;
    let total = 0;
    let freeUnits = 0;
    let savings = 0;

    const insertItem = db.prepare(
      `INSERT INTO purchase_order_items
         (po_id, product_id, ordered_qty, free_qty, pts, ptr, mrp, scheme_buy_qty, scheme_free_qty,
          discount_pct, gst_rate, line_gross, line_discount, line_tax, line_total, effective_cost)
       VALUES (@po_id, @product_id, @ordered_qty, @free_qty, @pts, @ptr, @mrp, @scheme_buy_qty,
               @scheme_free_qty, @discount_pct, @gst_rate, @line_gross, @line_discount, @line_tax,
               @line_total, @effective_cost)`,
    );

    for (const line of input.items) {
      if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
        throw badRequest('Purchase order quantity must be a whole number of at least 1.');
      }

      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(line.product_id) as
        | ProductRow
        | undefined;
      if (!product) throw notFound('Product');

      const catalogue = db
        .prepare(
          'SELECT * FROM distributor_products WHERE distributor_id = ? AND product_id = ?',
        )
        .get(input.distributor_id, line.product_id) as
        | {
            ptr: number;
            pts: number;
            mrp: number;
            scheme_buy_qty: number;
            scheme_free_qty: number;
            discount_pct: number;
            available_qty: number;
            min_order_qty: number;
          }
        | undefined;

      // A distributor can be asked for something outside its listed catalogue -
      // that happens in real trade. Fall back to the product master's own terms.
      const ptr = line.ptr ?? catalogue?.ptr ?? (product as ProductRow & { ptr: number }).ptr ?? product.purchase_price;
      const pts = catalogue?.pts ?? round2(ptr * 0.92);
      const mrp = catalogue?.mrp ?? (product as ProductRow & { mrp: number }).mrp ?? product.selling_price;
      const schemeBuy = line.scheme_buy_qty ?? catalogue?.scheme_buy_qty ?? 0;
      const schemeFree = line.scheme_free_qty ?? catalogue?.scheme_free_qty ?? 0;
      const discountPct = line.discount_pct ?? catalogue?.discount_pct ?? 0;

      if (catalogue && catalogue.min_order_qty > line.quantity) {
        throw badRequest(
          `${product.product_name}: ${distributor.name} has a minimum order quantity of ${catalogue.min_order_qty}.`,
        );
      }

      const priced = calculateScheme({
        quantity: line.quantity,
        rate: ptr,
        schemeBuyQty: schemeBuy,
        schemeFreeQty: schemeFree,
        discountPct,
        gstRate: product.tax_rate,
      });

      insertItem.run({
        po_id: poId,
        product_id: line.product_id,
        ordered_qty: priced.invoiceQty,
        free_qty: priced.freeQty,
        pts,
        ptr,
        mrp,
        scheme_buy_qty: schemeBuy,
        scheme_free_qty: schemeFree,
        discount_pct: discountPct,
        gst_rate: product.tax_rate,
        line_gross: priced.grossAmount,
        line_discount: round2(priced.discountAmount + priced.flatDiscount),
        line_tax: priced.taxAmount,
        line_total: priced.netAmount,
        effective_cost: priced.effectiveCost,
      });

      gross += priced.grossAmount;
      discount += priced.discountAmount + priced.flatDiscount;
      tax += priced.taxAmount;
      total += priced.netAmount;
      freeUnits += priced.freeQty;
      savings += priced.savings;
    }

    if (distributor.min_order_value > 0 && total < distributor.min_order_value) {
      throw badRequest(
        `Order total ${round2(total)} is below ${distributor.name}'s minimum order value of ${distributor.min_order_value}.`,
      );
    }

    db.prepare(
      `UPDATE purchase_orders SET gross_amount = ?, discount_amount = ?, tax_amount = ?,
         total_amount = ?, free_units = ?, savings_amount = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(round2(gross), round2(discount), round2(tax), round2(total), freeUnits, round2(savings), poId);

    logActivity(
      {
        userId: input.user_id,
        username: input.username,
        action: 'CREATE',
        module: 'PURCHASE_ORDER',
        recordType: 'purchase_orders',
        recordId: poId,
        summary: `Created ${poNumber} for ${distributor.name} — ${input.items.length} line(s), ${round2(total)}`,
      },
      db,
    );

    return getPurchaseOrder(poId);
  })();
}

export function getPurchaseOrder(id: number): PurchaseOrderRow & { items: Record<string, unknown>[] } {
  const db = getDb();
  const po = db
    .prepare(
      `SELECT po.*, d.name AS distributor_name, d.distributor_code, d.phone AS distributor_phone,
              d.city AS distributor_city, d.delivery_days, u.full_name AS created_by
       FROM purchase_orders po
       JOIN distributors d ON d.id = po.distributor_id
       LEFT JOIN users u ON u.id = po.user_id
       WHERE po.id = ?`,
    )
    .get(id) as (PurchaseOrderRow & Record<string, unknown>) | undefined;
  if (!po) throw notFound('Purchase order');

  const items = db
    .prepare(
      `SELECT poi.*, p.product_name, p.product_code, p.pack_size, p.category,
              (poi.ordered_qty - poi.received_qty) AS pending_qty
       FROM purchase_order_items poi
       JOIN products p ON p.id = poi.product_id
       WHERE poi.po_id = ?
       ORDER BY poi.id`,
    )
    .all(id) as Record<string, unknown>[];

  return { ...po, items };
}

export function listPurchaseOrders(query: {
  status?: string;
  distributorId?: number;
  search?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}): Paged<Record<string, unknown>> & { summary: Record<string, number> } {
  const where: string[] = [];
  const params: Record<string, unknown> = {};

  if (query.status && query.status !== 'ALL') {
    where.push('po.status = @status');
    params.status = query.status;
  }
  if (query.distributorId) {
    where.push('po.distributor_id = @distributorId');
    params.distributorId = query.distributorId;
  }
  if (query.from) {
    where.push('po.po_date >= @from');
    params.from = query.from;
  }
  if (query.to) {
    where.push('po.po_date <= @to');
    params.to = query.to;
  }
  if (query.search) {
    where.push('(po.po_number LIKE @like OR d.name LIKE @like)');
    params.like = `%${query.search.trim()}%`;
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = getDb()
    .prepare(
      `SELECT po.*, d.name AS distributor_name, d.city AS distributor_city,
              (SELECT COUNT(*) FROM purchase_order_items i WHERE i.po_id = po.id) AS item_count
       FROM purchase_orders po
       JOIN distributors d ON d.id = po.distributor_id
       ${clause}
       ORDER BY po.po_date DESC, po.id DESC
       LIMIT 1000`,
    )
    .all(params) as Record<string, unknown>[];

  const open = rows.filter((r) =>
    ['DRAFT', 'SENT', 'CONFIRMED', 'PARTIALLY_RECEIVED'].includes(String(r.status)),
  );

  return {
    ...paginate(rows, query.page, query.pageSize),
    summary: {
      orders: rows.length,
      openOrders: open.length,
      openValue: round2(open.reduce((s, r) => s + Number(r.total_amount ?? 0), 0)),
      totalValue: round2(rows.reduce((s, r) => s + Number(r.total_amount ?? 0), 0)),
      totalSavings: round2(rows.reduce((s, r) => s + Number(r.savings_amount ?? 0), 0)),
    },
  };
}

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['SENT', 'CANCELLED'],
  SENT: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'],
  PARTIALLY_RECEIVED: ['RECEIVED', 'CANCELLED'],
  RECEIVED: [],
  CANCELLED: [],
};

export function updatePoStatus(
  id: number,
  status: string,
  context: { user_id?: number | null; username?: string | null } = {},
) {
  const db = getDb();
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(id) as
    | PurchaseOrderRow
    | undefined;
  if (!po) throw notFound('Purchase order');

  const allowed = ALLOWED_TRANSITIONS[po.status] ?? [];
  if (!allowed.includes(status)) {
    throw badRequest(
      `A ${po.status} order cannot move to ${status}. Allowed from here: ${allowed.join(', ') || 'nothing — this order is closed'}.`,
    );
  }

  db.prepare("UPDATE purchase_orders SET status = ?, updated_at = datetime('now') WHERE id = ?").run(
    status,
    id,
  );

  logActivity({
    userId: context.user_id,
    username: context.username,
    action: status === 'SENT' ? 'SEND' : 'STATUS_CHANGE',
    module: 'PURCHASE_ORDER',
    recordType: 'purchase_orders',
    recordId: id,
    summary: `${po.po_number}: ${po.status} → ${status}`,
  });

  return getPurchaseOrder(id);
}

/* -------------------------------------------------------------------------- */
/* Goods receipt                                                               */
/* -------------------------------------------------------------------------- */

export interface ReceiptLineInput {
  po_item_id: number;
  /** Units invoiced that actually arrived. */
  received_qty: number;
  /** Free units that arrived; defaults to the scheme entitlement. */
  free_qty?: number;
  batch_number: string;
  expiry_date: string;
  manufacturing_date?: string | null;
  /** Overrides the ordered rate if the invoice differs. */
  ptr?: number;
  mrp?: number;
}

export interface ReceiptInput {
  po_id: number;
  items: ReceiptLineInput[];
  receipt_date?: string;
  invoice_number?: string | null;
  notes?: string | null;
  user_id?: number | null;
  username?: string | null;
}

/**
 * Receives goods against a purchase order.
 *
 * One atomic unit of work: batches are created or topped up, stock moves,
 * the audit log records every movement, a supplier invoice is raised, and the
 * order status advances to PARTIALLY_RECEIVED or RECEIVED. Any failure rolls
 * the whole receipt back rather than leaving half the delivery booked in.
 *
 * Free goods enter stock at ZERO cost, which is what makes the weighted batch
 * cost - and therefore gross profit - reflect the scheme correctly.
 */
export function receivePurchaseOrder(input: ReceiptInput) {
  const db = getDb();

  return db.transaction(() => {
    const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(input.po_id) as
      | PurchaseOrderRow
      | undefined;
    if (!po) throw notFound('Purchase order');
    if (['RECEIVED', 'CANCELLED'].includes(po.status)) {
      throw badRequest(`This order is already ${po.status.toLowerCase()} and cannot receive stock.`);
    }
    if (!input.items?.length) throw badRequest('Add at least one line to the goods receipt.');

    const receiptDate = input.receipt_date ?? today();
    const receiptNumber = nextNumber(db, 'purchase_receipts', 'receipt_number', 'GRN');
    const distributor = getDistributor(po.distributor_id);

    // A goods receipt is also a purchase in the legacy sense, so the existing
    // purchase register, reports and COGS keep working unchanged.
    const purchaseNumber = nextNumber(db, 'purchases', 'purchase_number', 'PUR');
    const purchaseId = Number(
      db
        .prepare(
          `INSERT INTO purchases
             (purchase_number, supplier_id, user_id, purchase_date, subtotal, tax, total,
              payment_status, notes, distributor_id, po_id, invoice_number)
           VALUES (?, ?, ?, ?, 0, 0, 0, 'UNPAID', ?, ?, ?, ?)`,
        )
        .run(
          purchaseNumber,
          distributor.supplier_id ?? null,
          input.user_id ?? null,
          receiptDate,
          input.notes ?? `Goods receipt against ${po.po_number}`,
          po.distributor_id,
          po.id,
          input.invoice_number ?? null,
        ).lastInsertRowid,
    );

    let subtotal = 0;
    let taxTotal = 0;
    let freeTotal = 0;

    for (const line of input.items) {
      if (!Number.isInteger(line.received_qty) || line.received_qty <= 0) {
        throw badRequest('Received quantity must be a whole number of at least 1.');
      }
      if (line.expiry_date <= receiptDate) {
        throw badRequest(
          `Batch ${line.batch_number} expires on ${line.expiry_date}, which is not after the receipt date.`,
        );
      }
      if (!line.batch_number?.trim()) throw badRequest('Every received line needs a batch number.');

      const poItem = db
        .prepare('SELECT * FROM purchase_order_items WHERE id = ? AND po_id = ?')
        .get(line.po_item_id, input.po_id) as Record<string, number> | undefined;
      if (!poItem) throw notFound('Purchase order line');

      const outstanding = Number(poItem.ordered_qty) - Number(poItem.received_qty);
      if (line.received_qty > outstanding) {
        throw badRequest(
          `Line already has ${poItem.received_qty} of ${poItem.ordered_qty} received; only ${outstanding} remain.`,
        );
      }

      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(poItem.product_id) as ProductRow;
      const ptr = line.ptr ?? Number(poItem.ptr);
      const mrp = line.mrp ?? Number(poItem.mrp);
      // Default the free quantity to what the scheme entitles on this receipt.
      const freeQty =
        line.free_qty ??
        calculateScheme({
          quantity: line.received_qty,
          rate: ptr,
          schemeBuyQty: Number(poItem.scheme_buy_qty),
          schemeFreeQty: Number(poItem.scheme_free_qty),
        }).freeQty;

      const priced = calculateScheme({
        quantity: line.received_qty,
        rate: ptr,
        schemeBuyQty: Number(poItem.scheme_buy_qty),
        schemeFreeQty: Number(poItem.scheme_free_qty),
        discountPct: Number(poItem.discount_pct),
        gstRate: Number(poItem.gst_rate),
      });

      const unitsIn = line.received_qty + freeQty;
      // Free goods dilute the unit cost. Booking the batch at effective cost is
      // what makes gross profit on these units honest.
      const batchCost = round2(safeDiv(priced.taxableAmount, unitsIn));
      const batchNumber = line.batch_number.trim();

      const existing = db
        .prepare('SELECT * FROM product_batches WHERE product_id = ? AND batch_number = ?')
        .get(poItem.product_id, batchNumber) as { id: number; quantity: number } | undefined;

      let batchId: number;
      if (existing) {
        db.prepare(
          `UPDATE product_batches
             SET quantity = quantity + ?, purchase_price = ?, selling_price = ?, mrp = ?, ptr = ?,
                 pts = ?, free_qty = free_qty + ?, expiry_date = ?, supplier_id = ?,
                 purchase_invoice = ?, status = 'ACTIVE', updated_at = datetime('now')
           WHERE id = ?`,
        ).run(
          unitsIn,
          batchCost,
          mrp,
          mrp,
          ptr,
          Number(poItem.pts),
          freeQty,
          line.expiry_date,
          distributor.supplier_id ?? null,
          input.invoice_number ?? null,
          existing.id,
        );
        batchId = existing.id;
      } else {
        batchId = Number(
          db
            .prepare(
              `INSERT INTO product_batches
                 (product_id, batch_number, manufacturing_date, expiry_date, quantity,
                  purchase_price, selling_price, supplier_id, mrp, ptr, pts, free_qty, purchase_invoice)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              poItem.product_id,
              batchNumber,
              line.manufacturing_date ?? null,
              line.expiry_date,
              unitsIn,
              batchCost,
              mrp,
              distributor.supplier_id ?? null,
              mrp,
              ptr,
              Number(poItem.pts),
              freeQty,
              input.invoice_number ?? null,
            ).lastInsertRowid,
        );
      }

      recordTransaction(db, {
        productId: Number(poItem.product_id),
        batchId,
        type: 'STOCK_RECEIVED',
        quantity: unitsIn,
        referenceId: purchaseId,
        referenceType: 'GOODS_RECEIPT',
        notes: `${receiptNumber} against ${po.po_number}${freeQty ? ` (incl. ${freeQty} free)` : ''}`,
      });

      db.prepare(
        `INSERT INTO purchase_items
           (purchase_id, product_id, batch_id, batch_number, quantity, purchase_price,
            selling_price, expiry_date, tax_rate, line_total, free_qty, mrp, pts,
            scheme_buy_qty, scheme_free_qty, effective_cost)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        purchaseId,
        poItem.product_id,
        batchId,
        batchNumber,
        line.received_qty,
        ptr,
        mrp,
        line.expiry_date,
        product.tax_rate,
        priced.netAmount,
        freeQty,
        mrp,
        Number(poItem.pts),
        Number(poItem.scheme_buy_qty),
        Number(poItem.scheme_free_qty),
        batchCost,
      );

      db.prepare(
        'UPDATE purchase_order_items SET received_qty = received_qty + ? WHERE id = ?',
      ).run(line.received_qty, line.po_item_id);

      subtotal += priced.taxableAmount;
      taxTotal += priced.taxAmount;
      freeTotal += freeQty;
    }

    const total = round2(subtotal + taxTotal);
    db.prepare(
      'UPDATE purchases SET subtotal = ?, tax = ?, total = ?, free_units = ? WHERE id = ?',
    ).run(round2(subtotal), round2(taxTotal), total, freeTotal, purchaseId);

    db.prepare(
      `INSERT INTO purchase_receipts
         (receipt_number, po_id, purchase_id, distributor_id, user_id, receipt_date, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      receiptNumber,
      po.id,
      purchaseId,
      po.distributor_id,
      input.user_id ?? null,
      receiptDate,
      input.notes ?? null,
    );

    // Raise the supplier invoice - this is what creates the outstanding balance.
    const invoiceNumber = input.invoice_number?.trim() || `${receiptNumber}-INV`;
    db.prepare(
      `INSERT INTO supplier_invoices
         (invoice_number, distributor_id, po_id, purchase_id, invoice_date, due_date,
          invoice_amount, paid_amount, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'UNPAID')`,
    ).run(
      invoiceNumber,
      po.distributor_id,
      po.id,
      purchaseId,
      receiptDate,
      addDays(receiptDate, distributor.credit_days || 30),
      total,
    );

    // Advance the order: fully received only when every line is complete.
    const pending = db
      .prepare(
        'SELECT COALESCE(SUM(ordered_qty - received_qty), 0) AS n FROM purchase_order_items WHERE po_id = ?',
      )
      .get(po.id) as { n: number };
    const nextStatus = pending.n <= 0 ? 'RECEIVED' : 'PARTIALLY_RECEIVED';
    db.prepare("UPDATE purchase_orders SET status = ?, updated_at = datetime('now') WHERE id = ?").run(
      nextStatus,
      po.id,
    );

    logActivity(
      {
        userId: input.user_id,
        username: input.username,
        action: 'RECEIVE',
        module: 'PURCHASE_ORDER',
        recordType: 'purchase_receipts',
        recordId: purchaseId,
        summary: `${receiptNumber}: received ${input.items.length} line(s) against ${po.po_number} — ${total}`,
      },
      db,
    );

    return {
      receiptNumber,
      purchaseId,
      invoiceNumber,
      total,
      freeUnits: freeTotal,
      status: nextStatus,
      purchaseOrder: getPurchaseOrder(po.id),
    };
  })();
}

/* -------------------------------------------------------------------------- */
/* Procurement dashboard                                                       */
/* -------------------------------------------------------------------------- */

export function getProcurementSummary() {
  const db = getDb();
  const day = today();

  const orders = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN po_date = @day THEN total_amount ELSE 0 END), 0) AS todayValue,
         COALESCE(SUM(CASE WHEN po_date = @day THEN 1 ELSE 0 END), 0)            AS todayOrders,
         COALESCE(SUM(CASE WHEN status = 'DRAFT' THEN 1 ELSE 0 END), 0)          AS draft,
         COALESCE(SUM(CASE WHEN status = 'SENT' THEN 1 ELSE 0 END), 0)           AS sent,
         COALESCE(SUM(CASE WHEN status = 'CONFIRMED' THEN 1 ELSE 0 END), 0)      AS confirmed,
         COALESCE(SUM(CASE WHEN status = 'PARTIALLY_RECEIVED' THEN 1 ELSE 0 END), 0) AS partial,
         COALESCE(SUM(CASE WHEN status = 'RECEIVED' THEN 1 ELSE 0 END), 0)       AS received,
         COALESCE(SUM(CASE WHEN status IN ('DRAFT','SENT','CONFIRMED','PARTIALLY_RECEIVED')
                           THEN total_amount ELSE 0 END), 0)                      AS openValue,
         COALESCE(SUM(savings_amount), 0)                                         AS lifetimeSavings
       FROM purchase_orders`,
    )
    .get({ day }) as Record<string, number>;

  const outstanding = db
    .prepare(
      `SELECT COALESCE(SUM(invoice_amount - paid_amount), 0) AS total,
              COUNT(*) AS invoices,
              COALESCE(SUM(CASE WHEN date(due_date) < date('now')
                                THEN invoice_amount - paid_amount ELSE 0 END), 0) AS overdue
       FROM supplier_invoices WHERE status <> 'PAID'`,
    )
    .get() as { total: number; invoices: number; overdue: number };

  const topDistributors = db
    .prepare(
      `SELECT d.id, d.name, COUNT(po.id) AS orders,
              COALESCE(SUM(po.total_amount), 0) AS value
       FROM distributors d
       JOIN purchase_orders po ON po.distributor_id = d.id
       GROUP BY d.id
       ORDER BY value DESC
       LIMIT 5`,
    )
    .all() as Record<string, unknown>[];

  const distributorCount = db
    .prepare("SELECT COUNT(*) AS n FROM distributors WHERE status = 'ACTIVE'")
    .get() as { n: number };

  return {
    todayValue: round2(orders.todayValue),
    todayOrders: orders.todayOrders,
    statusCounts: {
      DRAFT: orders.draft,
      SENT: orders.sent,
      CONFIRMED: orders.confirmed,
      PARTIALLY_RECEIVED: orders.partial,
      RECEIVED: orders.received,
    },
    openOrders: orders.draft + orders.sent + orders.confirmed + orders.partial,
    openValue: round2(orders.openValue),
    lifetimeSavings: round2(orders.lifetimeSavings),
    supplierOutstanding: round2(outstanding.total),
    overdueOutstanding: round2(outstanding.overdue),
    openInvoices: outstanding.invoices,
    activeDistributors: distributorCount.n,
    topDistributors,
  };
}
