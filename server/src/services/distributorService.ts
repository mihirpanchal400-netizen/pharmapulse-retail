import { getDb } from '../database/connection';
import { badRequest, conflict, notFound } from '../utils/errors';
import { round2, safeDiv } from '../utils/money';
import { paginate, type Paged } from './inventoryService';
import { getSetting } from './settingsService';
import { calculateScheme, schemeLabel, optimiseOrderQty } from './schemeService';

/**
 * DISTRIBUTOR NETWORK
 * ===================
 *
 * Models the tier of the Indian pharma supply chain the retail pharmacy buys
 * from:
 *
 *   MANUFACTURER -> SUPER STOCKIST -> DISTRIBUTOR / STOCKIST -> PHARMACY
 *
 * IMPORTANT - THIS IS A DEMO NETWORK.
 *
 * Every distributor, catalogue price, scheme and availability figure in this
 * system is SYNTHETIC and generated locally by the seed. Nothing is scraped
 * from, or connected to, Retailio, Pharmarack or any commercial distributor
 * platform, and no real-time market data is represented.
 *
 * The data is read exclusively through this service, so a legitimate,
 * authorised distributor API could later replace the local queries without any
 * change to the routes or the user interface.
 */

export interface DistributorRow {
  id: number;
  distributor_code: string;
  name: string;
  type: 'DISTRIBUTOR' | 'STOCKIST' | 'SUPER_STOCKIST' | 'MANUFACTURER';
  contact_person: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  area: string | null;
  city: string | null;
  pin_code: string | null;
  state: string | null;
  gstin: string | null;
  drug_license_no: string | null;
  payment_terms: string;
  credit_days: number;
  credit_limit: number;
  delivery_days: number;
  min_order_value: number;
  distance_km: number;
  rating: number;
  supplier_id: number | null;
  status: 'ACTIVE' | 'INACTIVE';
  created_at: string;
  updated_at: string;
}

export interface DistributorWithStats extends DistributorRow {
  catalogue_size: number;
  /** Distinct products this distributor currently shows as available. */
  in_stock_items: number;
  open_orders: number;
  outstanding: number;
  last_order_date: string | null;
}

export interface DistributorInput {
  name: string;
  distributor_code?: string;
  type?: DistributorRow['type'];
  contact_person?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  area?: string | null;
  city?: string | null;
  pin_code?: string | null;
  state?: string | null;
  gstin?: string | null;
  drug_license_no?: string | null;
  payment_terms?: string;
  credit_days?: number;
  credit_limit?: number;
  delivery_days?: number;
  min_order_value?: number;
  distance_km?: number;
  rating?: number;
  status?: 'ACTIVE' | 'INACTIVE';
}

const STATS_SELECT = `
  SELECT d.*,
    (SELECT COUNT(*) FROM distributor_products dp
      WHERE dp.distributor_id = d.id AND dp.status = 'ACTIVE')                    AS catalogue_size,
    (SELECT COUNT(*) FROM distributor_products dp
      WHERE dp.distributor_id = d.id AND dp.available_qty > 0)                    AS in_stock_items,
    (SELECT COUNT(*) FROM purchase_orders po
      WHERE po.distributor_id = d.id
        AND po.status IN ('DRAFT','SENT','CONFIRMED','PARTIALLY_RECEIVED'))       AS open_orders,
    (SELECT COALESCE(SUM(si.invoice_amount - si.paid_amount), 0) FROM supplier_invoices si
      WHERE si.distributor_id = d.id AND si.status <> 'PAID')                     AS outstanding,
    (SELECT MAX(po.po_date) FROM purchase_orders po WHERE po.distributor_id = d.id) AS last_order_date
  FROM distributors d
`;

/** Next sequential distributor code, e.g. DIST-0007. */
function nextDistributorCode(): string {
  const row = getDb()
    .prepare("SELECT distributor_code FROM distributors ORDER BY id DESC LIMIT 1")
    .get() as { distributor_code: string } | undefined;
  const tail = row ? Number(row.distributor_code.split('-').pop()) : 0;
  const next = Number.isFinite(tail) ? tail + 1 : 1;
  return `DIST-${String(next).padStart(4, '0')}`;
}

export interface DistributorQuery {
  search?: string;
  city?: string;
  pinCode?: string;
  area?: string;
  type?: string;
  status?: string;
  /** Only distributors within this many km of the configured pharmacy. */
  maxDistanceKm?: number;
  /** Only distributors that stock this product. */
  productId?: number;
  sortBy?: 'distance' | 'rating' | 'name' | 'outstanding' | 'catalogue';
  page?: number;
  pageSize?: number;
}

export function listDistributors(query: DistributorQuery): Paged<DistributorWithStats> {
  let rows = getDb().prepare(STATS_SELECT).all() as DistributorWithStats[];

  if (query.productId) {
    const stocking = getDb()
      .prepare('SELECT DISTINCT distributor_id AS id FROM distributor_products WHERE product_id = ?')
      .all(query.productId) as { id: number }[];
    const allowed = new Set(stocking.map((r) => r.id));
    rows = rows.filter((d) => allowed.has(d.id));
  }
  if (query.status && query.status !== 'ALL') rows = rows.filter((d) => d.status === query.status);
  if (query.type && query.type !== 'ALL') rows = rows.filter((d) => d.type === query.type);
  if (query.city) {
    const needle = query.city.toLowerCase().trim();
    rows = rows.filter((d) => (d.city ?? '').toLowerCase().includes(needle));
  }
  if (query.area) {
    const needle = query.area.toLowerCase().trim();
    rows = rows.filter((d) => (d.area ?? '').toLowerCase().includes(needle));
  }
  if (query.pinCode) {
    const needle = query.pinCode.trim();
    rows = rows.filter((d) => (d.pin_code ?? '').startsWith(needle));
  }
  if (query.maxDistanceKm !== undefined) {
    rows = rows.filter((d) => d.distance_km <= query.maxDistanceKm!);
  }
  if (query.search) {
    const needle = query.search.toLowerCase().trim();
    rows = rows.filter((d) =>
      [d.name, d.distributor_code, d.city, d.area, d.contact_person, d.phone]
        .filter(Boolean)
        .some((f) => String(f).toLowerCase().includes(needle)),
    );
  }

  const sorters: Record<string, (a: DistributorWithStats, b: DistributorWithStats) => number> = {
    distance: (a, b) => a.distance_km - b.distance_km,
    rating: (a, b) => b.rating - a.rating,
    name: (a, b) => a.name.localeCompare(b.name),
    outstanding: (a, b) => b.outstanding - a.outstanding,
    catalogue: (a, b) => b.catalogue_size - a.catalogue_size,
  };
  rows.sort(sorters[query.sortBy ?? 'distance'] ?? sorters.distance);
  rows = rows.map((d) => ({ ...d, outstanding: round2(d.outstanding) }));

  return paginate(rows, query.page, query.pageSize);
}

export function getDistributor(id: number): DistributorWithStats {
  const row = getDb().prepare(`${STATS_SELECT} WHERE d.id = ?`).get(id) as
    | DistributorWithStats
    | undefined;
  if (!row) throw notFound('Distributor');
  return { ...row, outstanding: round2(row.outstanding) };
}

export function createDistributor(input: DistributorInput): DistributorRow {
  if (!input.name?.trim()) throw badRequest('Distributor name is required.');
  const db = getDb();

  const code = input.distributor_code?.trim() || nextDistributorCode();
  const exists = db.prepare('SELECT id FROM distributors WHERE distributor_code = ?').get(code);
  if (exists) throw conflict(`Distributor code ${code} is already in use.`);

  const info = db
    .prepare(
      `INSERT INTO distributors
         (distributor_code, name, type, contact_person, phone, email, address, area, city,
          pin_code, state, gstin, drug_license_no, payment_terms, credit_days, credit_limit,
          delivery_days, min_order_value, distance_km, rating, status)
       VALUES (@distributor_code, @name, @type, @contact_person, @phone, @email, @address, @area,
               @city, @pin_code, @state, @gstin, @drug_license_no, @payment_terms, @credit_days,
               @credit_limit, @delivery_days, @min_order_value, @distance_km, @rating, @status)`,
    )
    .run({
      distributor_code: code,
      name: input.name.trim(),
      type: input.type ?? 'DISTRIBUTOR',
      contact_person: input.contact_person ?? null,
      phone: input.phone ?? null,
      email: input.email ?? null,
      address: input.address ?? null,
      area: input.area ?? null,
      city: input.city ?? null,
      pin_code: input.pin_code ?? null,
      state: input.state ?? null,
      gstin: input.gstin ?? null,
      drug_license_no: input.drug_license_no ?? null,
      payment_terms: input.payment_terms ?? 'Net 30',
      credit_days: input.credit_days ?? 30,
      credit_limit: input.credit_limit ?? 0,
      delivery_days: input.delivery_days ?? 1,
      min_order_value: input.min_order_value ?? 0,
      distance_km: input.distance_km ?? 0,
      rating: input.rating ?? 0,
      status: input.status ?? 'ACTIVE',
    });

  return getDb()
    .prepare('SELECT * FROM distributors WHERE id = ?')
    .get(Number(info.lastInsertRowid)) as DistributorRow;
}

export function updateDistributor(id: number, input: DistributorInput): DistributorRow {
  const current = getDb().prepare('SELECT * FROM distributors WHERE id = ?').get(id) as
    | DistributorRow
    | undefined;
  if (!current) throw notFound('Distributor');

  getDb()
    .prepare(
      `UPDATE distributors SET
         name = @name, type = @type, contact_person = @contact_person, phone = @phone,
         email = @email, address = @address, area = @area, city = @city, pin_code = @pin_code,
         state = @state, gstin = @gstin, drug_license_no = @drug_license_no,
         payment_terms = @payment_terms, credit_days = @credit_days, credit_limit = @credit_limit,
         delivery_days = @delivery_days, min_order_value = @min_order_value,
         distance_km = @distance_km, rating = @rating, status = @status,
         updated_at = datetime('now')
       WHERE id = @id`,
    )
    .run({
      id,
      name: input.name?.trim() ?? current.name,
      type: input.type ?? current.type,
      contact_person: input.contact_person ?? current.contact_person,
      phone: input.phone ?? current.phone,
      email: input.email ?? current.email,
      address: input.address ?? current.address,
      area: input.area ?? current.area,
      city: input.city ?? current.city,
      pin_code: input.pin_code ?? current.pin_code,
      state: input.state ?? current.state,
      gstin: input.gstin ?? current.gstin,
      drug_license_no: input.drug_license_no ?? current.drug_license_no,
      payment_terms: input.payment_terms ?? current.payment_terms,
      credit_days: input.credit_days ?? current.credit_days,
      credit_limit: input.credit_limit ?? current.credit_limit,
      delivery_days: input.delivery_days ?? current.delivery_days,
      min_order_value: input.min_order_value ?? current.min_order_value,
      distance_km: input.distance_km ?? current.distance_km,
      rating: input.rating ?? current.rating,
      status: input.status ?? current.status,
    });

  return getDb().prepare('SELECT * FROM distributors WHERE id = ?').get(id) as DistributorRow;
}

export function deleteDistributor(id: number): { deleted: boolean; deactivated: boolean } {
  const db = getDb();
  const hasOrders = db
    .prepare('SELECT id FROM purchase_orders WHERE distributor_id = ? LIMIT 1')
    .get(id);

  // Deleting a distributor with order history would orphan those orders, so it
  // is deactivated instead - the same rule the product and supplier services use.
  if (hasOrders) {
    db.prepare("UPDATE distributors SET status = 'INACTIVE', updated_at = datetime('now') WHERE id = ?").run(id);
    return { deleted: false, deactivated: true };
  }

  db.prepare('DELETE FROM distributor_products WHERE distributor_id = ?').run(id);
  const info = db.prepare('DELETE FROM distributors WHERE id = ?').run(id);
  if (info.changes === 0) throw notFound('Distributor');
  return { deleted: true, deactivated: false };
}

/* -------------------------------------------------------------------------- */
/* Catalogue                                                                   */
/* -------------------------------------------------------------------------- */

export interface CatalogueItem {
  id: number;
  distributor_id: number;
  product_id: number;
  product_code: string;
  product_name: string;
  generic_name: string | null;
  brand_name: string | null;
  category: string;
  pack_size: string | null;
  manufacturer: string | null;
  hsn_code: string | null;
  gst_rate: number;
  ptr: number;
  pts: number;
  mrp: number;
  scheme_buy_qty: number;
  scheme_free_qty: number;
  discount_pct: number;
  available_qty: number;
  min_order_qty: number;
  status: string;
  /** Rendered scheme, e.g. '10+1'. */
  scheme_label: string;
  /** Cost per unit actually received at the distributor's minimum order. */
  effective_cost: number;
  /** Pharmacy's own current stock, so the buyer sees need alongside offer. */
  current_stock: number;
}

const CATALOGUE_SELECT = `
  SELECT dp.*, p.product_code, p.product_name, p.generic_name, p.brand_name, p.category,
         p.pack_size, p.manufacturer, p.hsn_code, p.tax_rate AS gst_rate,
         COALESCE((SELECT SUM(b.quantity) FROM product_batches b
                    WHERE b.product_id = p.id AND b.status = 'ACTIVE'
                      AND date(b.expiry_date) > date('now')), 0) AS current_stock
  FROM distributor_products dp
  JOIN products p ON p.id = dp.product_id
`;

function decorate(row: CatalogueItem): CatalogueItem {
  // Effective cost is quoted at one scheme block, which is the smallest
  // quantity at which the scheme actually pays out.
  const referenceQty = Math.max(row.min_order_qty, row.scheme_buy_qty || row.min_order_qty);
  const priced = calculateScheme({
    quantity: referenceQty,
    rate: row.ptr,
    schemeBuyQty: row.scheme_buy_qty,
    schemeFreeQty: row.scheme_free_qty,
    discountPct: row.discount_pct,
  });

  return {
    ...row,
    scheme_label: schemeLabel(row.scheme_buy_qty, row.scheme_free_qty, row.discount_pct),
    effective_cost: priced.effectiveCost,
  };
}

export function getDistributorCatalogue(
  distributorId: number,
  query: { search?: string; category?: string; inStockOnly?: boolean; page?: number; pageSize?: number },
): Paged<CatalogueItem> {
  getDistributor(distributorId); // 404s if the distributor does not exist

  let rows = (
    getDb().prepare(`${CATALOGUE_SELECT} WHERE dp.distributor_id = ?`).all(distributorId) as CatalogueItem[]
  ).map(decorate);

  if (query.inStockOnly) rows = rows.filter((r) => r.available_qty > 0);
  if (query.category && query.category !== 'ALL') {
    rows = rows.filter((r) => r.category === query.category);
  }
  if (query.search) {
    const needle = query.search.toLowerCase().trim();
    rows = rows.filter((r) =>
      [r.product_name, r.generic_name, r.brand_name, r.product_code, r.manufacturer]
        .filter(Boolean)
        .some((f) => String(f).toLowerCase().includes(needle)),
    );
  }

  rows.sort((a, b) => a.product_name.localeCompare(b.product_name));
  return paginate(rows, query.page, query.pageSize);
}

/* -------------------------------------------------------------------------- */
/* Supplier comparison                                                         */
/* -------------------------------------------------------------------------- */

export interface SupplierOption extends CatalogueItem {
  distributor_name: string;
  distributor_code: string;
  delivery_days: number;
  distance_km: number;
  rating: number;
  payment_terms: string;
  min_order_value: number;
  /** Costing at the quantity the buyer actually asked for. */
  quotedQty: number;
  freeQty: number;
  totalUnits: number;
  grossAmount: number;
  discountAmount: number;
  netAmount: number;
  savings: number;
  savingsPct: number;
  /** Can this distributor actually supply the requested quantity today? */
  canFulfil: boolean;
  /** Rank 1 = cheapest per unit received. */
  rank: number;
  /** Percentage more expensive than the best option. */
  premiumPct: number;
  isBest: boolean;
}

/**
 * Compares every distributor that lists a product, ranked by EFFECTIVE COST.
 *
 * Ranking on effective cost rather than headline PTR is the entire point: a
 * higher rate with a 10+1 scheme frequently beats a lower rate with none, and
 * comparing on the quoted rate alone is the mistake this screen prevents.
 */
export function compareSuppliers(productId: number, quantity: number): {
  product: Record<string, unknown>;
  quantity: number;
  options: SupplierOption[];
  bestOption: SupplierOption | null;
  potentialSaving: number;
} {
  const db = getDb();
  const product = db
    .prepare('SELECT id, product_code, product_name, generic_name, pack_size, mrp, ptr, tax_rate FROM products WHERE id = ?')
    .get(productId) as Record<string, unknown> | undefined;
  if (!product) throw notFound('Product');

  const qty = Math.max(1, Math.floor(quantity));

  const rows = db
    .prepare(
      `${CATALOGUE_SELECT}
       JOIN distributors d ON d.id = dp.distributor_id
       WHERE dp.product_id = ? AND dp.status = 'ACTIVE' AND d.status = 'ACTIVE'`,
    )
    .all(productId) as CatalogueItem[];

  const enriched = rows.map((row) => {
    const distributor = db
      .prepare(
        'SELECT name, distributor_code, delivery_days, distance_km, rating, payment_terms, min_order_value FROM distributors WHERE id = ?',
      )
      .get(row.distributor_id) as {
      name: string;
      distributor_code: string;
      delivery_days: number;
      distance_km: number;
      rating: number;
      payment_terms: string;
      min_order_value: number;
    };

    const priced = calculateScheme({
      quantity: qty,
      rate: row.ptr,
      schemeBuyQty: row.scheme_buy_qty,
      schemeFreeQty: row.scheme_free_qty,
      discountPct: row.discount_pct,
      gstRate: row.gst_rate,
    });

    return {
      ...decorate(row),
      distributor_name: distributor.name,
      distributor_code: distributor.distributor_code,
      delivery_days: distributor.delivery_days,
      distance_km: distributor.distance_km,
      rating: distributor.rating,
      payment_terms: distributor.payment_terms,
      min_order_value: distributor.min_order_value,
      quotedQty: qty,
      freeQty: priced.freeQty,
      totalUnits: priced.totalUnits,
      grossAmount: priced.grossAmount,
      discountAmount: round2(priced.discountAmount + priced.flatDiscount),
      netAmount: priced.taxableAmount,
      effective_cost: priced.effectiveCost,
      savings: priced.savings,
      savingsPct: priced.savingsPct,
      canFulfil: row.available_qty >= qty,
      rank: 0,
      premiumPct: 0,
      isBest: false,
    } as SupplierOption;
  });

  // Rank by effective cost, but push distributors who cannot supply the
  // quantity below those who can - an unbeatable price you cannot get is not
  // actually the best option.
  enriched.sort((a, b) => {
    if (a.canFulfil !== b.canFulfil) return a.canFulfil ? -1 : 1;
    return a.effective_cost - b.effective_cost;
  });

  const best = enriched.find((o) => o.canFulfil) ?? enriched[0] ?? null;
  enriched.forEach((option, index) => {
    option.rank = index + 1;
    option.isBest = best !== null && option === best;
    option.premiumPct = best
      ? round2(safeDiv(option.effective_cost - best.effective_cost, best.effective_cost) * 100)
      : 0;
  });

  // What choosing the best option saves against the worst quote that could
  // still fulfil the order.
  const fulfillable = enriched.filter((o) => o.canFulfil);
  const worst = fulfillable[fulfillable.length - 1];
  const potentialSaving =
    best && worst && worst !== best ? round2((worst.effective_cost - best.effective_cost) * qty) : 0;

  return { product, quantity: qty, options: enriched, bestOption: best, potentialSaving };
}

/**
 * The best available option for a product, used by the Replenishment Center and
 * by the Mini Analyst to name a specific distributor in a recommendation.
 */
export function bestSupplierFor(productId: number, quantity: number): SupplierOption | null {
  try {
    return compareSuppliers(productId, quantity).bestOption;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Catalogue maintenance                                                       */
/* -------------------------------------------------------------------------- */

export interface CatalogueEntryInput {
  distributor_id: number;
  product_id: number;
  ptr: number;
  pts?: number;
  mrp?: number;
  scheme_buy_qty?: number;
  scheme_free_qty?: number;
  discount_pct?: number;
  available_qty?: number;
  min_order_qty?: number;
  status?: 'ACTIVE' | 'INACTIVE';
}

/** Adds or updates one product in a distributor's catalogue. */
export function upsertCatalogueEntry(input: CatalogueEntryInput): CatalogueItem {
  const db = getDb();
  getDistributor(input.distributor_id);

  const product = db.prepare('SELECT id, mrp, pts FROM products WHERE id = ?').get(input.product_id) as
    | { id: number; mrp: number; pts: number }
    | undefined;
  if (!product) throw notFound('Product');

  const mrp = input.mrp ?? product.mrp;
  if (input.ptr > mrp && mrp > 0) {
    throw badRequest(`PTR (${input.ptr}) cannot exceed MRP (${mrp}).`);
  }

  db.prepare(
    `INSERT INTO distributor_products
       (distributor_id, product_id, ptr, pts, mrp, scheme_buy_qty, scheme_free_qty,
        discount_pct, available_qty, min_order_qty, status, updated_at)
     VALUES (@distributor_id, @product_id, @ptr, @pts, @mrp, @scheme_buy_qty, @scheme_free_qty,
             @discount_pct, @available_qty, @min_order_qty, @status, datetime('now'))
     ON CONFLICT (distributor_id, product_id) DO UPDATE SET
       ptr = excluded.ptr, pts = excluded.pts, mrp = excluded.mrp,
       scheme_buy_qty = excluded.scheme_buy_qty, scheme_free_qty = excluded.scheme_free_qty,
       discount_pct = excluded.discount_pct, available_qty = excluded.available_qty,
       min_order_qty = excluded.min_order_qty, status = excluded.status,
       updated_at = datetime('now')`,
  ).run({
    distributor_id: input.distributor_id,
    product_id: input.product_id,
    ptr: input.ptr,
    pts: input.pts ?? round2(input.ptr * 0.92),
    mrp,
    scheme_buy_qty: input.scheme_buy_qty ?? 0,
    scheme_free_qty: input.scheme_free_qty ?? 0,
    discount_pct: input.discount_pct ?? 0,
    available_qty: input.available_qty ?? 0,
    min_order_qty: input.min_order_qty ?? 1,
    status: input.status ?? 'ACTIVE',
  });

  const row = db
    .prepare(`${CATALOGUE_SELECT} WHERE dp.distributor_id = ? AND dp.product_id = ?`)
    .get(input.distributor_id, input.product_id) as CatalogueItem;
  return decorate(row);
}

export function removeCatalogueEntry(distributorId: number, productId: number): void {
  const info = getDb()
    .prepare('DELETE FROM distributor_products WHERE distributor_id = ? AND product_id = ?')
    .run(distributorId, productId);
  if (info.changes === 0) throw notFound('Catalogue entry');
}

/** Every distributor option for one product - shown on the Product Detail page. */
export function suppliersForProduct(productId: number): SupplierOption[] {
  return compareSuppliers(productId, 10).options;
}

/**
 * The pharmacy's own location, used to frame distance in the discovery screen.
 * Configurable from Settings; there is no geolocation anywhere in this system.
 */
export function getPharmacyLocation(): { city: string; area: string; pinCode: string; state: string } {
  return {
    city: getSetting('pharmacy_city', 'Pune'),
    area: getSetting('pharmacy_area', 'MG Road'),
    pinCode: getSetting('pharmacy_pin', '411001'),
    state: getSetting('pharmacy_state', 'Maharashtra'),
  };
}

export { optimiseOrderQty };
