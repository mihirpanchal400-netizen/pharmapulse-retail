import { getDb } from '../database/connection';
import { conflict, notFound } from '../utils/errors';
import { paginate, type Paged } from './inventoryService';
import { round2 } from '../utils/money';
import type { SupplierRow } from '../types';

export interface SupplierInput {
  supplier_name: string;
  contact_person?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  payment_terms?: string | null;
  status?: 'ACTIVE' | 'INACTIVE';
}

export interface SupplierWithStats extends SupplierRow {
  purchase_count: number;
  total_purchased: number;
  last_purchase_date: string | null;
  products_supplied: number;
}

export function listSuppliers(query: {
  search?: string;
  status?: 'ACTIVE' | 'INACTIVE' | 'ALL';
  page?: number;
  pageSize?: number;
}): Paged<SupplierWithStats> {
  const rows = getDb()
    .prepare(
      `SELECT s.*,
              COALESCE(p.n, 0)      AS purchase_count,
              COALESCE(p.total, 0)  AS total_purchased,
              p.last_date           AS last_purchase_date,
              COALESCE(b.products, 0) AS products_supplied
       FROM suppliers s
       LEFT JOIN (
         SELECT supplier_id, COUNT(*) AS n, SUM(total) AS total, MAX(purchase_date) AS last_date
         FROM purchases GROUP BY supplier_id
       ) p ON p.supplier_id = s.id
       LEFT JOIN (
         SELECT supplier_id, COUNT(DISTINCT product_id) AS products
         FROM product_batches WHERE supplier_id IS NOT NULL GROUP BY supplier_id
       ) b ON b.supplier_id = s.id
       ORDER BY s.supplier_name`,
    )
    .all() as SupplierWithStats[];

  let items = rows.map((r) => ({ ...r, total_purchased: round2(r.total_purchased) }));

  if (query.status && query.status !== 'ALL') {
    items = items.filter((s) => s.status === query.status);
  }
  if (query.search) {
    const needle = query.search.toLowerCase().trim();
    items = items.filter((s) =>
      [s.supplier_name, s.contact_person, s.phone, s.email]
        .filter(Boolean)
        .some((f) => String(f).toLowerCase().includes(needle)),
    );
  }
  return paginate(items, query.page, query.pageSize);
}

export function getSupplier(id: number): SupplierRow {
  const row = getDb().prepare('SELECT * FROM suppliers WHERE id = ?').get(id) as
    | SupplierRow
    | undefined;
  if (!row) throw notFound('Supplier');
  return row;
}

export function createSupplier(input: SupplierInput): SupplierRow {
  const result = getDb()
    .prepare(
      `INSERT INTO suppliers (supplier_name, contact_person, phone, email, address, payment_terms, status)
       VALUES (@supplier_name, @contact_person, @phone, @email, @address, @payment_terms, @status)`,
    )
    .run(normalize(input));
  return getSupplier(Number(result.lastInsertRowid));
}

export function updateSupplier(id: number, input: SupplierInput): SupplierRow {
  getSupplier(id);
  getDb()
    .prepare(
      `UPDATE suppliers SET supplier_name = @supplier_name, contact_person = @contact_person,
         phone = @phone, email = @email, address = @address, payment_terms = @payment_terms,
         status = @status, updated_at = datetime('now')
       WHERE id = @id`,
    )
    .run({ ...normalize(input), id });
  return getSupplier(id);
}

export function deleteSupplier(id: number): { deleted: boolean; deactivated: boolean } {
  const db = getDb();
  getSupplier(id);
  const refs = db.prepare('SELECT COUNT(*) AS n FROM purchases WHERE supplier_id = ?').get(id) as {
    n: number;
  };
  if (refs.n > 0) {
    db.prepare(`UPDATE suppliers SET status = 'INACTIVE', updated_at = datetime('now') WHERE id = ?`).run(id);
    return { deleted: false, deactivated: true };
  }
  db.prepare('DELETE FROM suppliers WHERE id = ?').run(id);
  return { deleted: true, deactivated: false };
}

function normalize(input: SupplierInput) {
  return {
    supplier_name: input.supplier_name.trim(),
    contact_person: input.contact_person ?? null,
    phone: input.phone ?? null,
    email: input.email ?? null,
    address: input.address ?? null,
    payment_terms: input.payment_terms ?? null,
    status: input.status ?? 'ACTIVE',
  };
}
