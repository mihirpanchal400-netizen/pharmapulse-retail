import { getDb } from '../database/connection';
import { notFound } from '../utils/errors';
import { paginate, type Paged } from './inventoryService';
import { round2, safeDiv } from '../utils/money';
import type { CustomerRow } from '../types';

/**
 * Customers are deliberately minimal: a code, a name, an optional phone and a
 * type. No diagnosis, medical history, prescription image or any other health
 * information is collected or stored anywhere in this application.
 */
export interface CustomerInput {
  name: string;
  phone?: string | null;
  customer_type?: 'WALK_IN' | 'REGULAR' | 'INSTITUTIONAL';
  customer_code?: string;
}

export interface CustomerWithStats extends CustomerRow {
  purchase_count: number;
  total_spent: number;
  last_visit: string | null;
}

export function listCustomers(query: {
  search?: string;
  type?: string;
  page?: number;
  pageSize?: number;
}): Paged<CustomerWithStats> {
  const rows = getDb()
    .prepare(
      `SELECT c.*, COALESCE(s.n, 0) AS purchase_count, COALESCE(s.total, 0) AS total_spent,
              s.last_visit
       FROM customers c
       LEFT JOIN (
         SELECT customer_id, COUNT(*) AS n, SUM(total) AS total, MAX(sale_date) AS last_visit
         FROM sales WHERE status <> 'CANCELLED' AND customer_id IS NOT NULL
         GROUP BY customer_id
       ) s ON s.customer_id = c.id
       ORDER BY c.name`,
    )
    .all() as CustomerWithStats[];

  let items = rows.map((r) => ({ ...r, total_spent: round2(r.total_spent) }));

  if (query.type && query.type !== 'ALL') items = items.filter((c) => c.customer_type === query.type);
  if (query.search) {
    const needle = query.search.toLowerCase().trim();
    items = items.filter((c) =>
      [c.name, c.phone, c.customer_code].filter(Boolean).some((f) =>
        String(f).toLowerCase().includes(needle),
      ),
    );
  }
  return paginate(items, query.page, query.pageSize);
}

export function getCustomer(id: number): CustomerRow {
  const row = getDb().prepare('SELECT * FROM customers WHERE id = ?').get(id) as
    | CustomerRow
    | undefined;
  if (!row) throw notFound('Customer');
  return row;
}

export function createCustomer(input: CustomerInput): CustomerRow {
  const db = getDb();
  const code = input.customer_code?.trim() || nextCustomerCode();
  const result = db
    .prepare(
      `INSERT INTO customers (customer_code, name, phone, customer_type) VALUES (?, ?, ?, ?)`,
    )
    .run(code, input.name.trim(), input.phone ?? null, input.customer_type ?? 'WALK_IN');
  return getCustomer(Number(result.lastInsertRowid));
}

export function updateCustomer(id: number, input: CustomerInput): CustomerRow {
  getCustomer(id);
  getDb()
    .prepare('UPDATE customers SET name = ?, phone = ?, customer_type = ? WHERE id = ?')
    .run(input.name.trim(), input.phone ?? null, input.customer_type ?? 'WALK_IN', id);
  return getCustomer(id);
}

export function deleteCustomer(id: number): void {
  getCustomer(id);
  // sales.customer_id is ON DELETE SET NULL, so invoice history survives.
  getDb().prepare('DELETE FROM customers WHERE id = ?').run(id);
}

/**
 * A customer with their purchase history and headline figures.
 *
 * Returns the customer alongside the sales rather than a bare array, because
 * every caller needs both and a second round-trip to fetch the name is waste.
 * `paid_amount` is included so the caller can show an outstanding balance
 * without recomputing it from the payments table.
 */
export function getCustomerHistory(id: number) {
  const customer = getCustomer(id);

  const sales = getDb()
    .prepare(
      `SELECT s.id, s.invoice_number, s.sale_date, s.total, s.paid_amount,
              s.payment_method, s.status, s.due_date,
              (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) AS item_count
       FROM sales s
       WHERE s.customer_id = ?
       ORDER BY s.sale_date DESC
       LIMIT 200`,
    )
    .all(id) as {
    id: number;
    total: number;
    paid_amount: number;
    status: string;
  }[];

  // Cancelled bills are excluded from the money figures but stay in the list,
  // because the pharmacist still needs to see that they happened.
  const live = sales.filter((sale) => sale.status !== 'CANCELLED');
  const totalSpent = live.reduce((sum, sale) => sum + sale.total, 0);
  const outstanding = live.reduce((sum, sale) => sum + Math.max(0, sale.total - sale.paid_amount), 0);

  return {
    customer,
    sales,
    summary: {
      purchases: live.length,
      totalSpent: round2(totalSpent),
      outstanding: round2(outstanding),
      averageBill: round2(safeDiv(totalSpent, live.length)),
    },
  };
}

function nextCustomerCode(): string {
  const row = getDb()
    .prepare(`SELECT customer_code FROM customers ORDER BY id DESC LIMIT 1`)
    .get() as { customer_code: string } | undefined;
  let next = 1;
  if (row?.customer_code) {
    const tail = Number(row.customer_code.replace(/\D/g, ''));
    if (Number.isFinite(tail)) next = tail + 1;
  }
  return `CUST-${String(next).padStart(5, '0')}`;
}
