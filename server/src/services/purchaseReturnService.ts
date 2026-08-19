import { getDb } from '../database/connection';
import { badRequest, notFound } from '../utils/errors';
import { round2 } from '../utils/money';
import { today } from '../utils/dates';
import { changeBatchQuantity, recordTransaction, paginate, type Paged } from './inventoryService';
import { logActivity } from './activityService';
import type { TransactionType } from '../types';

/**
 * PURCHASE RETURNS
 * ================
 *
 * Sending stock back up the chain: expired, damaged, wrongly supplied or
 * over-supplied goods returned to the distributor for credit.
 *
 * The mirror image of a sales return, with one important difference — a
 * purchase return always REMOVES stock. There is no "restock" option, because
 * the goods are physically leaving the pharmacy.
 *
 * Credit is valued at what the pharmacy actually paid for those units (the
 * batch's purchase price, which already reflects any free-goods scheme), not at
 * the current list rate. Crediting at list would overstate the recovery.
 */

export type PurchaseReturnReason = 'EXPIRED' | 'DAMAGED' | 'WRONG_ITEM' | 'EXCESS' | 'OTHER';

export interface PurchaseReturnItemInput {
  batch_id: number;
  quantity: number;
}

export interface PurchaseReturnInput {
  distributor_id?: number | null;
  purchase_id?: number | null;
  reason: PurchaseReturnReason;
  items: PurchaseReturnItemInput[];
  return_date?: string;
  notes?: string | null;
  user_id?: number | null;
  username?: string | null;
}

/**
 * The stock movement type that best explains why the units left.
 *
 * `inventory_transactions` constrains its type column to a fixed set, so a
 * purchase return is recorded under the closest matching movement with
 * `reference_type = 'PURCHASE_RETURN'` carrying the real meaning. That keeps
 * the ledger honest without a second table rebuild.
 */
function movementTypeFor(reason: PurchaseReturnReason): TransactionType {
  if (reason === 'EXPIRED') return 'EXPIRED';
  if (reason === 'DAMAGED') return 'DAMAGED';
  return 'ADJUSTMENT';
}

function nextReturnNumber(): string {
  const year = new Date().getFullYear();
  const row = getDb()
    .prepare("SELECT return_number AS num FROM purchase_returns WHERE return_number LIKE ? ORDER BY id DESC LIMIT 1")
    .get(`PRET-${year}-%`) as { num: string } | undefined;

  let next = 1;
  if (row?.num) {
    const tail = Number(row.num.split('-').pop());
    if (Number.isFinite(tail)) next = tail + 1;
  }
  return `PRET-${year}-${String(next).padStart(5, '0')}`;
}

export function createPurchaseReturn(input: PurchaseReturnInput) {
  const db = getDb();

  return db.transaction(() => {
    if (!input.items?.length) throw badRequest('Select at least one batch to return.');

    const returnDate = input.return_date ?? today();
    const returnNumber = nextReturnNumber();

    let distributorId = input.distributor_id ?? null;
    if (input.purchase_id) {
      const purchase = db
        .prepare('SELECT distributor_id FROM purchases WHERE id = ?')
        .get(input.purchase_id) as { distributor_id: number | null } | undefined;
      if (!purchase) throw notFound('Purchase');
      distributorId = distributorId ?? purchase.distributor_id;
    }

    const returnId = Number(
      db
        .prepare(
          `INSERT INTO purchase_returns
             (return_number, distributor_id, purchase_id, user_id, return_date, reason, credit_amount, status, notes)
           VALUES (?, ?, ?, ?, ?, ?, 0, 'RAISED', ?)`,
        )
        .run(
          returnNumber,
          distributorId,
          input.purchase_id ?? null,
          input.user_id ?? null,
          returnDate,
          input.reason,
          input.notes ?? null,
        ).lastInsertRowid,
    );

    const insertItem = db.prepare(
      `INSERT INTO purchase_return_items
         (return_id, product_id, batch_id, quantity, purchase_price, credit_amount)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    let creditTotal = 0;
    let unitsTotal = 0;
    const movementType = movementTypeFor(input.reason);

    for (const item of input.items) {
      if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
        throw badRequest('Return quantity must be a whole number of at least 1.');
      }

      const batch = db
        .prepare(
          `SELECT b.*, p.product_name
           FROM product_batches b JOIN products p ON p.id = b.product_id
           WHERE b.id = ?`,
        )
        .get(item.batch_id) as
        | { id: number; product_id: number; product_name: string; batch_number: string; quantity: number; purchase_price: number }
        | undefined;
      if (!batch) throw notFound('Batch');

      if (item.quantity > batch.quantity) {
        throw badRequest(
          `Batch ${batch.batch_number} of ${batch.product_name} holds ${batch.quantity} units; cannot return ${item.quantity}.`,
        );
      }

      // Credit at what was actually paid for these units.
      const credit = round2(item.quantity * batch.purchase_price);

      insertItem.run(returnId, batch.product_id, batch.id, item.quantity, batch.purchase_price, credit);

      // Stock leaves the pharmacy. The CHECK constraint on quantity guarantees
      // this can never take a batch negative.
      changeBatchQuantity(db, batch.id, -item.quantity);

      recordTransaction(db, {
        productId: batch.product_id,
        batchId: batch.id,
        type: movementType,
        quantity: -item.quantity,
        referenceId: returnId,
        referenceType: 'PURCHASE_RETURN',
        notes: `${returnNumber}: returned to distributor (${input.reason.toLowerCase().replace('_', ' ')})`,
      });

      creditTotal += credit;
      unitsTotal += item.quantity;
    }

    db.prepare('UPDATE purchase_returns SET credit_amount = ? WHERE id = ?').run(
      round2(creditTotal),
      returnId,
    );

    logActivity(
      {
        userId: input.user_id,
        username: input.username,
        action: 'CREATE',
        module: 'PURCHASE',
        recordType: 'purchase_returns',
        recordId: returnId,
        summary: `${returnNumber}: returned ${unitsTotal} unit(s) for ${round2(creditTotal)} credit (${input.reason})`,
      },
      db,
    );

    return getPurchaseReturn(returnId);
  })();
}

export function getPurchaseReturn(id: number) {
  const db = getDb();
  const header = db
    .prepare(
      `SELECT pr.*, d.name AS distributor_name, u.full_name AS created_by
       FROM purchase_returns pr
       LEFT JOIN distributors d ON d.id = pr.distributor_id
       LEFT JOIN users u ON u.id = pr.user_id
       WHERE pr.id = ?`,
    )
    .get(id) as Record<string, unknown> | undefined;
  if (!header) throw notFound('Purchase return');

  const items = db
    .prepare(
      `SELECT pri.*, p.product_name, p.product_code, b.batch_number, b.expiry_date
       FROM purchase_return_items pri
       JOIN products p ON p.id = pri.product_id
       LEFT JOIN product_batches b ON b.id = pri.batch_id
       WHERE pri.return_id = ?
       ORDER BY pri.id`,
    )
    .all(id) as Record<string, unknown>[];

  return { ...header, items };
}

export function listPurchaseReturns(query: {
  search?: string;
  reason?: string;
  status?: string;
  distributorId?: number;
  page?: number;
  pageSize?: number;
}): Paged<Record<string, unknown>> & { summary: Record<string, number> } {
  const rows = getDb()
    .prepare(
      `SELECT pr.*, d.name AS distributor_name,
              (SELECT COALESCE(SUM(quantity), 0) FROM purchase_return_items i WHERE i.return_id = pr.id) AS units,
              (SELECT COUNT(*) FROM purchase_return_items i WHERE i.return_id = pr.id) AS line_count
       FROM purchase_returns pr
       LEFT JOIN distributors d ON d.id = pr.distributor_id
       ORDER BY pr.return_date DESC, pr.id DESC`,
    )
    .all() as Record<string, unknown>[];

  let items = rows;
  if (query.reason && query.reason !== 'ALL') items = items.filter((r) => r.reason === query.reason);
  if (query.status && query.status !== 'ALL') items = items.filter((r) => r.status === query.status);
  if (query.distributorId) items = items.filter((r) => r.distributor_id === query.distributorId);
  if (query.search) {
    const needle = query.search.toLowerCase().trim();
    items = items.filter((r) =>
      [r.return_number, r.distributor_name, r.notes]
        .filter(Boolean)
        .some((f) => String(f).toLowerCase().includes(needle)),
    );
  }

  return {
    ...paginate(items, query.page, query.pageSize),
    summary: {
      returns: items.length,
      units: items.reduce((s, r) => s + Number(r.units ?? 0), 0),
      creditRaised: round2(items.reduce((s, r) => s + Number(r.credit_amount ?? 0), 0)),
      creditPending: round2(
        items.filter((r) => r.status === 'RAISED').reduce((s, r) => s + Number(r.credit_amount ?? 0), 0),
      ),
    },
  };
}

/**
 * Marks a return as credited by the distributor, or rejected.
 *
 * Stock already left when the return was raised, so settling only changes the
 * financial status - no inventory movement is involved either way.
 */
export function updatePurchaseReturnStatus(
  id: number,
  status: 'CREDITED' | 'REJECTED',
  context: { user_id?: number | null; username?: string | null } = {},
) {
  const db = getDb();
  const current = db.prepare('SELECT * FROM purchase_returns WHERE id = ?').get(id) as
    | { return_number: string; status: string }
    | undefined;
  if (!current) throw notFound('Purchase return');
  if (current.status !== 'RAISED') {
    throw badRequest(`This return is already ${current.status.toLowerCase()} and cannot be changed.`);
  }

  db.prepare('UPDATE purchase_returns SET status = ? WHERE id = ?').run(status, id);

  logActivity({
    userId: context.user_id,
    username: context.username,
    action: 'STATUS_CHANGE',
    module: 'PURCHASE',
    recordType: 'purchase_returns',
    recordId: id,
    summary: `${current.return_number}: RAISED → ${status}`,
  });

  return getPurchaseReturn(id);
}

/** Batches available to return, newest received first. */
export function returnableBatches(query: { search?: string; productId?: number; expiredOnly?: boolean }) {
  const rows = getDb()
    .prepare(
      `SELECT b.id AS batch_id, b.batch_number, b.expiry_date, b.quantity, b.purchase_price,
              b.purchase_invoice, p.id AS product_id, p.product_name, p.product_code, p.pack_size,
              s.supplier_name,
              CAST(julianday(b.expiry_date) - julianday('now') AS INTEGER) AS days_to_expiry
       FROM product_batches b
       JOIN products p ON p.id = b.product_id
       LEFT JOIN suppliers s ON s.id = b.supplier_id
       WHERE b.quantity > 0 AND b.status = 'ACTIVE'
       ORDER BY b.expiry_date ASC`,
    )
    .all() as Record<string, unknown>[];

  let items = rows;
  if (query.productId) items = items.filter((r) => r.product_id === query.productId);
  if (query.expiredOnly) items = items.filter((r) => Number(r.days_to_expiry) < 0);
  if (query.search) {
    const needle = query.search.toLowerCase().trim();
    items = items.filter((r) =>
      [r.product_name, r.product_code, r.batch_number, r.supplier_name]
        .filter(Boolean)
        .some((f) => String(f).toLowerCase().includes(needle)),
    );
  }

  return items.slice(0, 200);
}
