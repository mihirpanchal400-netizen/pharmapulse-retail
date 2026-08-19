import { getDb } from '../database/connection';
import { badRequest, notFound } from '../utils/errors';
import { round2 } from '../utils/money';
import { addDays, daysBetween, today } from '../utils/dates';
import { paginate, type Paged } from './inventoryService';
import { logActivity } from './activityService';

/**
 * OUTSTANDING & PAYMENTS
 * ======================
 *
 * Credit is how Indian pharmacy trade actually works in both directions:
 *
 *   SUPPLIER SIDE - goods received on Net 30 create a payable
 *   CUSTOMER SIDE - institutional buyers and regulars settle later
 *
 * Ageing buckets follow standard receivables practice (current / 1-30 / 31-60 /
 * 60+ days past due), because that is the shape a pharmacy owner already reads
 * on a distributor statement.
 */

function ageBucket(daysOverdue: number): 'CURRENT' | 'D1_30' | 'D31_60' | 'D60_PLUS' {
  if (daysOverdue <= 0) return 'CURRENT';
  if (daysOverdue <= 30) return 'D1_30';
  if (daysOverdue <= 60) return 'D31_60';
  return 'D60_PLUS';
}

function nextPaymentNumber(table: string, prefix: string): string {
  const year = new Date().getFullYear();
  const row = getDb()
    .prepare(`SELECT payment_number AS num FROM ${table} WHERE payment_number LIKE ? ORDER BY id DESC LIMIT 1`)
    .get(`${prefix}-${year}-%`) as { num: string } | undefined;

  let next = 1;
  if (row?.num) {
    const tail = Number(row.num.split('-').pop());
    if (Number.isFinite(tail)) next = tail + 1;
  }
  return `${prefix}-${year}-${String(next).padStart(5, '0')}`;
}

/* -------------------------------------------------------------------------- */
/* Supplier outstanding                                                        */
/* -------------------------------------------------------------------------- */

export interface SupplierInvoiceRow {
  id: number;
  invoice_number: string;
  distributor_id: number;
  distributor_name: string;
  po_id: number | null;
  po_number: string | null;
  invoice_date: string;
  due_date: string;
  invoice_amount: number;
  paid_amount: number;
  outstanding: number;
  status: string;
  days_overdue: number;
  age_bucket: string;
}

export function listSupplierInvoices(query: {
  status?: string;
  distributorId?: number;
  overdueOnly?: boolean;
  search?: string;
  page?: number;
  pageSize?: number;
}): Paged<SupplierInvoiceRow> & { summary: Record<string, number> } {
  const rows = getDb()
    .prepare(
      `SELECT si.*, d.name AS distributor_name, po.po_number
       FROM supplier_invoices si
       JOIN distributors d ON d.id = si.distributor_id
       LEFT JOIN purchase_orders po ON po.id = si.po_id
       ORDER BY si.due_date ASC, si.id DESC`,
    )
    .all() as (SupplierInvoiceRow & { invoice_amount: number; paid_amount: number })[];

  let items: SupplierInvoiceRow[] = rows.map((row) => {
    const outstanding = round2(row.invoice_amount - row.paid_amount);
    const daysOverdue = outstanding > 0 ? daysBetween(row.due_date, today()) : 0;
    return {
      ...row,
      invoice_amount: round2(row.invoice_amount),
      paid_amount: round2(row.paid_amount),
      outstanding,
      days_overdue: Math.max(0, daysOverdue),
      age_bucket: ageBucket(daysOverdue),
    };
  });

  if (query.status && query.status !== 'ALL') items = items.filter((i) => i.status === query.status);
  if (query.distributorId) items = items.filter((i) => i.distributor_id === query.distributorId);
  if (query.overdueOnly) items = items.filter((i) => i.days_overdue > 0 && i.outstanding > 0);
  if (query.search) {
    const needle = query.search.toLowerCase().trim();
    items = items.filter((i) =>
      [i.invoice_number, i.distributor_name, i.po_number]
        .filter(Boolean)
        .some((f) => String(f).toLowerCase().includes(needle)),
    );
  }

  const open = items.filter((i) => i.outstanding > 0);
  const summary = {
    invoices: items.length,
    openInvoices: open.length,
    totalOutstanding: round2(open.reduce((s, i) => s + i.outstanding, 0)),
    overdue: round2(open.filter((i) => i.days_overdue > 0).reduce((s, i) => s + i.outstanding, 0)),
    current: round2(open.filter((i) => i.age_bucket === 'CURRENT').reduce((s, i) => s + i.outstanding, 0)),
    d1_30: round2(open.filter((i) => i.age_bucket === 'D1_30').reduce((s, i) => s + i.outstanding, 0)),
    d31_60: round2(open.filter((i) => i.age_bucket === 'D31_60').reduce((s, i) => s + i.outstanding, 0)),
    d60_plus: round2(open.filter((i) => i.age_bucket === 'D60_PLUS').reduce((s, i) => s + i.outstanding, 0)),
  };

  return { ...paginate(items, query.page, query.pageSize), summary };
}

export interface SupplierPaymentInput {
  distributor_id: number;
  invoice_id?: number | null;
  amount: number;
  method?: 'CASH' | 'UPI' | 'CARD' | 'BANK' | 'CHEQUE' | 'OTHER';
  payment_date?: string;
  reference?: string | null;
  notes?: string | null;
  user_id?: number | null;
  username?: string | null;
}

/**
 * Records a payment to a distributor.
 *
 * When an invoice is named the payment settles that invoice and cannot exceed
 * its balance. With no invoice the payment is applied oldest-first across open
 * invoices, which is how a distributor allocates an on-account payment.
 */
export function recordSupplierPayment(input: SupplierPaymentInput) {
  const db = getDb();

  return db.transaction(() => {
    if (input.amount <= 0) throw badRequest('Payment amount must be greater than zero.');

    const distributor = db
      .prepare('SELECT id, name FROM distributors WHERE id = ?')
      .get(input.distributor_id) as { id: number; name: string } | undefined;
    if (!distributor) throw notFound('Distributor');

    const paymentDate = input.payment_date ?? today();
    const paymentNumber = nextPaymentNumber('supplier_payments', 'SPAY');

    let remaining = round2(input.amount);
    const settled: string[] = [];

    const applyTo = (invoice: { id: number; invoice_number: string; invoice_amount: number; paid_amount: number }) => {
      const balance = round2(invoice.invoice_amount - invoice.paid_amount);
      if (balance <= 0) return;
      const applied = round2(Math.min(balance, remaining));
      const newPaid = round2(invoice.paid_amount + applied);
      const status = newPaid >= round2(invoice.invoice_amount) ? 'PAID' : 'PARTIAL';

      db.prepare('UPDATE supplier_invoices SET paid_amount = ?, status = ? WHERE id = ?').run(
        newPaid,
        status,
        invoice.id,
      );
      remaining = round2(remaining - applied);
      settled.push(`${invoice.invoice_number} (${applied})`);
    };

    if (input.invoice_id) {
      const invoice = db
        .prepare('SELECT id, invoice_number, invoice_amount, paid_amount FROM supplier_invoices WHERE id = ?')
        .get(input.invoice_id) as
        | { id: number; invoice_number: string; invoice_amount: number; paid_amount: number }
        | undefined;
      if (!invoice) throw notFound('Supplier invoice');

      const balance = round2(invoice.invoice_amount - invoice.paid_amount);
      if (input.amount > balance) {
        throw badRequest(
          `Payment of ${input.amount} exceeds the outstanding balance of ${balance} on invoice ${invoice.invoice_number}.`,
        );
      }
      applyTo(invoice);
    } else {
      const openInvoices = db
        .prepare(
          `SELECT id, invoice_number, invoice_amount, paid_amount
           FROM supplier_invoices
           WHERE distributor_id = ? AND status <> 'PAID'
           ORDER BY due_date ASC, id ASC`,
        )
        .all(input.distributor_id) as {
        id: number;
        invoice_number: string;
        invoice_amount: number;
        paid_amount: number;
      }[];

      for (const invoice of openInvoices) {
        if (remaining <= 0) break;
        applyTo(invoice);
      }
      if (remaining > 0) {
        throw badRequest(
          `Payment of ${input.amount} exceeds the total outstanding for ${distributor.name}. Unapplied: ${remaining}.`,
        );
      }
    }

    const paymentId = Number(
      db
        .prepare(
          `INSERT INTO supplier_payments
             (payment_number, distributor_id, invoice_id, user_id, payment_date, amount, method, reference, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          paymentNumber,
          input.distributor_id,
          input.invoice_id ?? null,
          input.user_id ?? null,
          paymentDate,
          round2(input.amount),
          input.method ?? 'BANK',
          input.reference ?? null,
          input.notes ?? null,
        ).lastInsertRowid,
    );

    logActivity(
      {
        userId: input.user_id,
        username: input.username,
        action: 'PAYMENT',
        module: 'PAYMENT',
        recordType: 'supplier_payments',
        recordId: paymentId,
        summary: `${paymentNumber}: paid ${round2(input.amount)} to ${distributor.name} — settled ${settled.join(', ')}`,
      },
      db,
    );

    return { paymentNumber, paymentId, applied: settled, amount: round2(input.amount) };
  })();
}

export function listSupplierPayments(query: { distributorId?: number; page?: number; pageSize?: number }) {
  const where = query.distributorId ? 'WHERE sp.distributor_id = @distributorId' : '';
  const rows = getDb()
    .prepare(
      `SELECT sp.*, d.name AS distributor_name, si.invoice_number, u.full_name AS recorded_by
       FROM supplier_payments sp
       JOIN distributors d ON d.id = sp.distributor_id
       LEFT JOIN supplier_invoices si ON si.id = sp.invoice_id
       LEFT JOIN users u ON u.id = sp.user_id
       ${where}
       ORDER BY sp.payment_date DESC, sp.id DESC
       LIMIT 500`,
    )
    .all(query.distributorId ? { distributorId: query.distributorId } : {}) as Record<string, unknown>[];

  return paginate(rows, query.page, query.pageSize);
}

/* -------------------------------------------------------------------------- */
/* Customer outstanding                                                        */
/* -------------------------------------------------------------------------- */

export interface CustomerDueRow {
  sale_id: number;
  invoice_number: string;
  customer_id: number;
  customer_name: string;
  phone: string | null;
  sale_date: string;
  due_date: string | null;
  total: number;
  paid_amount: number;
  outstanding: number;
  days_overdue: number;
  age_bucket: string;
}

/** Credit sales that are not yet fully settled. */
export function listCustomerDues(query: {
  customerId?: number;
  overdueOnly?: boolean;
  search?: string;
  page?: number;
  pageSize?: number;
}): Paged<CustomerDueRow> & { summary: Record<string, number> } {
  const rows = getDb()
    .prepare(
      `SELECT s.id AS sale_id, s.invoice_number, s.customer_id, s.sale_date, s.due_date,
              s.total, s.paid_amount, c.name AS customer_name, c.phone
       FROM sales s
       JOIN customers c ON c.id = s.customer_id
       WHERE s.status <> 'CANCELLED' AND s.total > s.paid_amount
       ORDER BY s.sale_date ASC`,
    )
    .all() as (CustomerDueRow & { total: number; paid_amount: number })[];

  let items: CustomerDueRow[] = rows.map((row) => {
    const outstanding = round2(row.total - row.paid_amount);
    const due = row.due_date ?? addDays(row.sale_date.slice(0, 10), 30);
    const daysOverdue = daysBetween(due, today());
    return {
      ...row,
      total: round2(row.total),
      paid_amount: round2(row.paid_amount),
      outstanding,
      due_date: due,
      days_overdue: Math.max(0, daysOverdue),
      age_bucket: ageBucket(daysOverdue),
    };
  });

  if (query.customerId) items = items.filter((i) => i.customer_id === query.customerId);
  if (query.overdueOnly) items = items.filter((i) => i.days_overdue > 0);
  if (query.search) {
    const needle = query.search.toLowerCase().trim();
    items = items.filter((i) =>
      [i.customer_name, i.invoice_number, i.phone]
        .filter(Boolean)
        .some((f) => String(f).toLowerCase().includes(needle)),
    );
  }

  const summary = {
    invoices: items.length,
    totalOutstanding: round2(items.reduce((s, i) => s + i.outstanding, 0)),
    overdue: round2(items.filter((i) => i.days_overdue > 0).reduce((s, i) => s + i.outstanding, 0)),
    current: round2(items.filter((i) => i.age_bucket === 'CURRENT').reduce((s, i) => s + i.outstanding, 0)),
    d1_30: round2(items.filter((i) => i.age_bucket === 'D1_30').reduce((s, i) => s + i.outstanding, 0)),
    d31_60: round2(items.filter((i) => i.age_bucket === 'D31_60').reduce((s, i) => s + i.outstanding, 0)),
    d60_plus: round2(items.filter((i) => i.age_bucket === 'D60_PLUS').reduce((s, i) => s + i.outstanding, 0)),
  };

  return { ...paginate(items, query.page, query.pageSize), summary };
}

export interface CustomerPaymentInput {
  customer_id: number;
  sale_id?: number | null;
  amount: number;
  method?: 'CASH' | 'UPI' | 'CARD' | 'BANK' | 'CHEQUE' | 'OTHER';
  payment_date?: string;
  reference?: string | null;
  notes?: string | null;
  user_id?: number | null;
  username?: string | null;
}

export function recordCustomerPayment(input: CustomerPaymentInput) {
  const db = getDb();

  return db.transaction(() => {
    if (input.amount <= 0) throw badRequest('Payment amount must be greater than zero.');

    const customer = db.prepare('SELECT id, name FROM customers WHERE id = ?').get(input.customer_id) as
      | { id: number; name: string }
      | undefined;
    if (!customer) throw notFound('Customer');

    const paymentDate = input.payment_date ?? today();
    const paymentNumber = nextPaymentNumber('customer_payments', 'CPAY');

    let remaining = round2(input.amount);
    const settled: string[] = [];

    const applyTo = (sale: { id: number; invoice_number: string; total: number; paid_amount: number }) => {
      const balance = round2(sale.total - sale.paid_amount);
      if (balance <= 0) return;
      const applied = round2(Math.min(balance, remaining));
      db.prepare('UPDATE sales SET paid_amount = ? WHERE id = ?').run(
        round2(sale.paid_amount + applied),
        sale.id,
      );
      remaining = round2(remaining - applied);
      settled.push(`${sale.invoice_number} (${applied})`);
    };

    if (input.sale_id) {
      const sale = db
        .prepare('SELECT id, invoice_number, total, paid_amount FROM sales WHERE id = ?')
        .get(input.sale_id) as
        | { id: number; invoice_number: string; total: number; paid_amount: number }
        | undefined;
      if (!sale) throw notFound('Sale');
      const balance = round2(sale.total - sale.paid_amount);
      if (input.amount > balance) {
        throw badRequest(
          `Payment of ${input.amount} exceeds the outstanding balance of ${balance} on invoice ${sale.invoice_number}.`,
        );
      }
      applyTo(sale);
    } else {
      const open = db
        .prepare(
          `SELECT id, invoice_number, total, paid_amount FROM sales
           WHERE customer_id = ? AND status <> 'CANCELLED' AND total > paid_amount
           ORDER BY sale_date ASC`,
        )
        .all(input.customer_id) as {
        id: number;
        invoice_number: string;
        total: number;
        paid_amount: number;
      }[];

      for (const sale of open) {
        if (remaining <= 0) break;
        applyTo(sale);
      }
      if (remaining > 0) {
        throw badRequest(
          `Payment of ${input.amount} exceeds the total outstanding for ${customer.name}. Unapplied: ${remaining}.`,
        );
      }
    }

    const paymentId = Number(
      db
        .prepare(
          `INSERT INTO customer_payments
             (payment_number, customer_id, sale_id, user_id, payment_date, amount, method, reference, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          paymentNumber,
          input.customer_id,
          input.sale_id ?? null,
          input.user_id ?? null,
          paymentDate,
          round2(input.amount),
          input.method ?? 'CASH',
          input.reference ?? null,
          input.notes ?? null,
        ).lastInsertRowid,
    );

    logActivity(
      {
        userId: input.user_id,
        username: input.username,
        action: 'PAYMENT',
        module: 'PAYMENT',
        recordType: 'customer_payments',
        recordId: paymentId,
        summary: `${paymentNumber}: received ${round2(input.amount)} from ${customer.name} — settled ${settled.join(', ')}`,
      },
      db,
    );

    return { paymentNumber, paymentId, applied: settled, amount: round2(input.amount) };
  })();
}
