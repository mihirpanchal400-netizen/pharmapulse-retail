import { getDb } from '../database/connection';
import { badRequest, conflict, notFound } from '../utils/errors';
import { getProductStock, getFefoBatches } from './inventoryService';
import type { BatchRow, ProductRow } from '../types';

export interface ProductInput {
  product_code: string;
  product_name: string;
  generic_name?: string | null;
  brand_name?: string | null;
  category: string;
  dosage_form?: string | null;
  strength?: string | null;
  pack_size?: string | null;
  manufacturer?: string | null;
  batch_tracking_enabled?: boolean;
  prescription_flag?: boolean;
  purchase_price: number;
  selling_price: number;
  tax_rate: number;
  reorder_level: number;
  minimum_stock: number;
  maximum_stock: number;
  status?: 'ACTIVE' | 'INACTIVE';
}

export function getProduct(id: number): ProductRow {
  const row = getDb().prepare('SELECT * FROM products WHERE id = ?').get(id) as
    | ProductRow
    | undefined;
  if (!row) throw notFound('Product');
  return row;
}

/** Product detail with live stock and its FEFO-ordered batch list. */
export function getProductDetail(id: number): ProductRow & {
  current_stock: number;
  batches: BatchRow[];
  all_batches: (BatchRow & { supplier_name: string | null })[];
} {
  const product = getProduct(id);
  const all = getDb()
    .prepare(
      `SELECT b.*, s.supplier_name
       FROM product_batches b
       LEFT JOIN suppliers s ON s.id = b.supplier_id
       WHERE b.product_id = ?
       ORDER BY b.expiry_date ASC`,
    )
    .all(id) as (BatchRow & { supplier_name: string | null })[];

  return {
    ...product,
    current_stock: getProductStock(id),
    batches: getFefoBatches(id),
    all_batches: all,
  };
}

export function createProduct(input: ProductInput): ProductRow {
  validatePricing(input);
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO products
        (product_code, product_name, generic_name, brand_name, category, dosage_form, strength,
         pack_size, manufacturer, batch_tracking_enabled, prescription_flag, purchase_price,
         selling_price, tax_rate, reorder_level, minimum_stock, maximum_stock, status)
       VALUES
        (@product_code, @product_name, @generic_name, @brand_name, @category, @dosage_form, @strength,
         @pack_size, @manufacturer, @batch_tracking_enabled, @prescription_flag, @purchase_price,
         @selling_price, @tax_rate, @reorder_level, @minimum_stock, @maximum_stock, @status)`,
    )
    .run(toRowParams(input));
  return getProduct(Number(result.lastInsertRowid));
}

export function updateProduct(id: number, input: ProductInput): ProductRow {
  getProduct(id);
  validatePricing(input);
  getDb()
    .prepare(
      `UPDATE products SET
         product_code = @product_code, product_name = @product_name, generic_name = @generic_name,
         brand_name = @brand_name, category = @category, dosage_form = @dosage_form,
         strength = @strength, pack_size = @pack_size, manufacturer = @manufacturer,
         batch_tracking_enabled = @batch_tracking_enabled, prescription_flag = @prescription_flag,
         purchase_price = @purchase_price, selling_price = @selling_price, tax_rate = @tax_rate,
         reorder_level = @reorder_level, minimum_stock = @minimum_stock,
         maximum_stock = @maximum_stock, status = @status, updated_at = datetime('now')
       WHERE id = @id`,
    )
    .run({ ...toRowParams(input), id });
  return getProduct(id);
}

/**
 * Products are only hard-deleted when nothing references them. Once a product
 * appears on a sale or purchase it is deactivated instead, so historical
 * invoices and analytics stay intact.
 */
export function deleteProduct(id: number): { deleted: boolean; deactivated: boolean } {
  const db = getDb();
  getProduct(id);

  const refs = db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM sale_items WHERE product_id = @id)     AS sales,
        (SELECT COUNT(*) FROM purchase_items WHERE product_id = @id) AS purchases,
        (SELECT COALESCE(SUM(quantity),0) FROM product_batches WHERE product_id = @id) AS stock`,
    )
    .get({ id }) as { sales: number; purchases: number; stock: number };

  if (refs.sales > 0 || refs.purchases > 0) {
    db.prepare(`UPDATE products SET status = 'INACTIVE', updated_at = datetime('now') WHERE id = ?`).run(id);
    return { deleted: false, deactivated: true };
  }
  if (refs.stock > 0) {
    throw conflict(
      'This product still has stock on hand. Adjust the stock to zero before removing it.',
    );
  }
  db.prepare('DELETE FROM products WHERE id = ?').run(id);
  return { deleted: true, deactivated: false };
}

export function listCategories(): string[] {
  const rows = getDb()
    .prepare('SELECT DISTINCT category FROM products ORDER BY category')
    .all() as { category: string }[];
  return rows.map((r) => r.category);
}

export function listManufacturers(): string[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT manufacturer FROM products WHERE manufacturer IS NOT NULL AND manufacturer <> ''
       ORDER BY manufacturer`,
    )
    .all() as { manufacturer: string }[];
  return rows.map((r) => r.manufacturer);
}

/** Type-ahead search used by the POS and purchase screens. */
export function searchProducts(term: string, limit = 20) {
  const like = `%${term.trim()}%`;
  return getDb()
    .prepare(
      `SELECT p.id, p.product_code, p.product_name, p.generic_name, p.brand_name, p.category,
              p.strength, p.pack_size, p.selling_price, p.purchase_price, p.tax_rate,
              p.prescription_flag, p.reorder_level,
              COALESCE((SELECT SUM(quantity) FROM product_batches b
                        WHERE b.product_id = p.id AND b.status = 'ACTIVE'
                          AND b.quantity > 0 AND b.expiry_date >= date('now')), 0) AS current_stock
       FROM products p
       WHERE p.status = 'ACTIVE'
         AND (p.product_name LIKE @like OR p.generic_name LIKE @like OR p.brand_name LIKE @like
              OR p.product_code LIKE @like OR p.manufacturer LIKE @like)
       ORDER BY p.product_name
       LIMIT @limit`,
    )
    .all({ like, limit });
}

function validatePricing(input: ProductInput): void {
  if (input.selling_price < input.purchase_price) {
    // Warn-level rule expressed as a hard validation: selling below cost would
    // silently produce negative margins in every downstream analytic.
    throw badRequest(
      `Selling price (${input.selling_price}) is below purchase price (${input.purchase_price}). ` +
        `This would record a loss on every sale.`,
    );
  }
  if (input.maximum_stock > 0 && input.maximum_stock < input.reorder_level) {
    throw badRequest('Maximum stock must be greater than or equal to the reorder level.');
  }
}

function toRowParams(input: ProductInput) {
  return {
    product_code: input.product_code.trim(),
    product_name: input.product_name.trim(),
    generic_name: input.generic_name ?? null,
    brand_name: input.brand_name ?? null,
    category: input.category,
    dosage_form: input.dosage_form ?? null,
    strength: input.strength ?? null,
    pack_size: input.pack_size ?? null,
    manufacturer: input.manufacturer ?? null,
    batch_tracking_enabled: input.batch_tracking_enabled === false ? 0 : 1,
    prescription_flag: input.prescription_flag ? 1 : 0,
    purchase_price: input.purchase_price,
    selling_price: input.selling_price,
    tax_rate: input.tax_rate,
    reorder_level: input.reorder_level,
    minimum_stock: input.minimum_stock,
    maximum_stock: input.maximum_stock,
    status: input.status ?? 'ACTIVE',
  };
}
