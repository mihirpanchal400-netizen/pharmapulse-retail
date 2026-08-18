import { getDb } from '../database/connection';
import { notFound } from '../utils/errors';
import { paginate, type Paged } from './inventoryService';
import { round2 } from '../utils/money';
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

export function getCustomerHistory(id: number) {
  getCustomer(id);
  return getDb()
    .prepare(
      `SELECT id, invoice_number, sale_date, total, payment_method, status
       FROM sales WHERE customer_id = ? ORDER BY sale_date DESC LIMIT 100`,
    )
    .all(id);
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
