import fs from 'fs';
import path from 'path';
import { getDb, closeDb } from './connection';
import { runMigrations } from './migrate';
import { config } from '../config';
import { addDays, today } from '../utils/dates';
import { round2 } from '../utils/money';
import { createPurchase, type PurchaseItemInput } from '../services/purchaseService';
import { createSale, createReturn, type SaleItemInput } from '../services/saleService';
import { getProductStock } from '../services/inventoryService';
import type { PaymentMethod, ProductRow } from '../types';

/**
 * SYNTHETIC DEMO DATA GENERATOR
 * =============================
 *
 * Generates a realistic 180-day trading history for a single retail pharmacy.
 *
 * Two design decisions matter here:
 *
 * 1. IT GOES THROUGH THE REAL SERVICES.
 *    Purchases use createPurchase(), sales use createSale(). Nothing writes to
 *    sales or batch tables directly. That means the generated history exercises
 *    real FEFO allocation, real invoice arithmetic and real inventory movements
 *    - so the demo database is guaranteed to be internally consistent, and the
 *    seed doubles as an end-to-end exercise of the business logic.
 *
 * 2. THE BUSINESS CONDITIONS ARE PLANTED, NOT HOPED FOR.
 *    A purely random dataset produces a boring, uniformly healthy pharmacy and
 *    the Mini Analyst finds nothing. Products are therefore assigned explicit
 *    roles - fast mover, dead stock, about to run out, expiring - so every rule
 *    in the engine has something real to detect.
 *
 * The generator is DETERMINISTIC: a fixed PRNG seed means `npm run seed`
 * produces the same database every time, so a demo can be rehearsed and the
 * numbers in a presentation will still be there on the day.
 *
 * NO REAL PHARMACY, PATIENT OR PRESCRIPTION DATA IS USED. See seed/catalog.json.
 */

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32)
// ---------------------------------------------------------------------------

const SEED = 20260819;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function random(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(SEED);

const between = (min: number, max: number): number => min + rand() * (max - min);
const intBetween = (min: number, max: number): number => Math.floor(between(min, max + 1));
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)];

function shuffled<T>(arr: readonly T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * Poisson-ish integer draw around `mean`. Real daily demand for one SKU is
 * lumpy - some days zero, occasionally several - and a flat rounded average
 * would produce implausibly smooth charts.
 */
function demandDraw(mean: number): number {
  if (mean <= 0) return 0;
  const l = Math.exp(-mean);
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= rand();
  } while (p > l && k < 60);
  return k - 1;
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

interface CatalogProduct {
  generic: string;
  brand: string;
  category: string;
  form: string;
  strength: string;
  pack: string;
  rx: number;
  cost: number;
  mrp: number;
  tax: number;
}

interface Catalog {
  manufacturers: string[];
  suppliers: {
    supplier_name: string;
    contact_person: string;
    phone: string;
    email: string;
    address: string;
    payment_terms: string;
  }[];
  customerFirstNames: string[];
  customerLastNames: string[];
  institutionalCustomers: string[];
  products: CatalogProduct[];
}

function loadCatalog(): Catalog {
  // Read at runtime rather than imported, so the compiled dist/ build does not
  // need an asset-copy step and the JSON stays editable without a rebuild.
  const file = path.resolve(config.repoRoot, 'seed', 'catalog.json');
  if (!fs.existsSync(file)) {
    throw new Error(`Catalogue not found at ${file}. It ships with the repository.`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Catalog;
}

// ---------------------------------------------------------------------------
// Product roles - the planted business conditions
// ---------------------------------------------------------------------------

type ProductRole =
  | 'FAST'        // high velocity, the lines that carry the shop
  | 'NORMAL'      // steady, unremarkable
  | 'DEAD'        // sold once, then stopped - stock still on the shelf
  | 'NEVER_SOLD'  // bought and never sold at all
  | 'LOW'         // replenishment stops late, ends below reorder level
  | 'OUT'         // replenishment stops earlier, ends at zero stock
  | 'OVERSTOCK';  // over-bought relative to its slow demand

interface ProductPlan {
  id: number;
  row: ProductRow;
  role: ProductRole;
  /** Units per day at the start of the window. */
  baseVelocity: number;
  /** Multiplier applied linearly across the window: >1 growing, <1 declining. */
  trend: number;
  /** Day index after which this product stops selling (dead stock). */
  sellsUntilDay: number;
  /** Day index after which this product is no longer replenished. */
  replenishUntilDay: number;
  supplierId: number;
  /** Days of shelf life given to new batches of this product. */
  shelfLifeDays: number;
}

const WINDOW_DAYS = 180;

/** Day index 0 = 180 days ago, day index 179 = today. */
const dayToDate = (dayIndex: number): string => addDays(today(), -(WINDOW_DAYS - 1 - dayIndex));

// ---------------------------------------------------------------------------
// Seeding steps
// ---------------------------------------------------------------------------

function clearBusinessData(): void {
  const db = getDb();
  // Users and settings survive: the demo logins and configured thresholds are
  // part of the application, not part of the generated trading history.
  db.exec(`
    PRAGMA foreign_keys = OFF;
    DELETE FROM sale_return_items;
    DELETE FROM sale_returns;
    DELETE FROM sale_items;
    DELETE FROM sales;
    DELETE FROM purchase_items;
    DELETE FROM purchases;
    DELETE FROM inventory_transactions;
    DELETE FROM product_batches;
    DELETE FROM products;
    DELETE FROM customers;
    DELETE FROM suppliers;
    DELETE FROM sqlite_sequence WHERE name IN
      ('sale_return_items','sale_returns','sale_items','sales','purchase_items','purchases',
       'inventory_transactions','product_batches','products','customers','suppliers');
    PRAGMA foreign_keys = ON;
  `);
}

function seedSuppliers(catalog: Catalog): number[] {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO suppliers (supplier_name, contact_person, phone, email, address, payment_terms)
     VALUES (@supplier_name, @contact_person, @phone, @email, @address, @payment_terms)`,
  );
  const ids: number[] = [];
  db.transaction(() => {
    for (const s of catalog.suppliers) ids.push(Number(stmt.run(s).lastInsertRowid));
  })();
  return ids;
}

function seedCustomers(catalog: Catalog): number[] {
  const db = getDb();
  const stmt = db.prepare(
    'INSERT INTO customers (customer_code, name, phone, customer_type) VALUES (?, ?, ?, ?)',
  );
  const ids: number[] = [];

  db.transaction(() => {
    let n = 0;
    // Regular retail customers.
    for (let i = 0; i < 54; i += 1) {
      n += 1;
      const name = `${pick(catalog.customerFirstNames)} ${pick(catalog.customerLastNames)}`;
      const phone = `+91 9${intBetween(100000000, 999999999)}`;
      // A minority are registered walk-ins; most named customers are regulars.
      const type = rand() < 0.72 ? 'REGULAR' : 'WALK_IN';
      ids.push(Number(stmt.run(`CUST-${String(n).padStart(4, '0')}`, name, phone, type).lastInsertRowid));
    }
    // Institutional accounts - clinics and care homes buying in larger volumes.
    for (const name of catalog.institutionalCustomers) {
      n += 1;
      const phone = `+91 20 ${intBetween(40000000, 49999999)}`;
      ids.push(
        Number(stmt.run(`CUST-${String(n).padStart(4, '0')}`, name, phone, 'INSTITUTIONAL').lastInsertRowid),
      );
    }
  })();

  return ids;
}

function seedProducts(catalog: Catalog, supplierIds: number[]): ProductPlan[] {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO products
       (product_code, product_name, generic_name, brand_name, category, dosage_form, strength,
        pack_size, manufacturer, prescription_flag, purchase_price, selling_price, tax_rate,
        reorder_level, minimum_stock, maximum_stock)
     VALUES (@product_code, @product_name, @generic_name, @brand_name, @category, @dosage_form,
             @strength, @pack_size, @manufacturer, @prescription_flag, @purchase_price,
             @selling_price, @tax_rate, @reorder_level, @minimum_stock, @maximum_stock)`,
  );

  const inserted: { id: number; source: CatalogProduct }[] = [];

  db.transaction(() => {
    catalog.products.forEach((p, i) => {
      const productName = `${p.brand} ${p.strength !== '-' ? p.strength : ''}`.trim();
      const info = stmt.run({
        product_code: `PP-${String(i + 1).padStart(4, '0')}`,
        product_name: productName,
        generic_name: p.generic,
        brand_name: p.brand,
        category: p.category,
        dosage_form: p.form,
        strength: p.strength,
        pack_size: p.pack,
        manufacturer: catalog.manufacturers[i % catalog.manufacturers.length],
        prescription_flag: p.rx,
        purchase_price: p.cost,
        selling_price: p.mrp,
        tax_rate: p.tax,
        // Placeholders - overwritten below once each product has a velocity,
        // because a sensible reorder level depends on how fast a line moves.
        reorder_level: 10,
        minimum_stock: 5,
        maximum_stock: 100,
      });
      inserted.push({ id: Number(info.lastInsertRowid), source: p });
    });
  })();

  // ---- assign roles -------------------------------------------------------
  const order = shuffled(inserted.map((_, i) => i));
  const roleOf = new Map<number, ProductRole>();
  const assign = (indices: number[], role: ProductRole) => indices.forEach((i) => roleOf.set(i, role));

  assign(order.slice(0, 12), 'FAST');
  assign(order.slice(12, 24), 'DEAD');
  assign(order.slice(24, 27), 'NEVER_SOLD');
  assign(order.slice(27, 51), 'LOW');
  assign(order.slice(51, 57), 'OUT');
  assign(order.slice(57, 65), 'OVERSTOCK');
  // Everything else stays NORMAL.

  // ---- build the plans ----------------------------------------------------
  const plans: ProductPlan[] = inserted.map((entry, i) => {
    const role = roleOf.get(i) ?? 'NORMAL';
    const price = entry.source.mrp;

    // Cheap OTC lines move in far higher volume than expensive specialities.
    // Deriving base velocity from price keeps the dataset commercially plausible.
    const priceFactor = price < 60 ? 2.2 : price < 150 ? 1.3 : price < 400 ? 0.7 : 0.35;

    let baseVelocity: number;
    switch (role) {
      case 'FAST':
        baseVelocity = between(3.5, 9) * Math.max(1, priceFactor);
        break;
      case 'DEAD':
        baseVelocity = between(0.3, 1.2) * priceFactor;
        break;
      case 'NEVER_SOLD':
        baseVelocity = 0;
        break;
      case 'OVERSTOCK':
        baseVelocity = between(0.1, 0.5) * priceFactor;
        break;
      case 'OUT':
      case 'LOW':
        baseVelocity = between(1.0, 3.0) * priceFactor;
        break;
      default:
        baseVelocity = between(0.25, 2.0) * priceFactor;
    }

    // A minority of lines are visibly growing or declining, so the trend rules
    // have something to report beyond statistical noise.
    let trend = 1;
    const roll = rand();
    if (role === 'FAST' && roll < 0.5) trend = between(1.35, 1.8);
    else if (roll < 0.22) trend = between(1.3, 1.7);
    else if (roll < 0.32) trend = between(0.45, 0.7);
    // Dermatology is deliberately given a growth bias so the category rule has
    // a clear, explainable signal to find.
    if (entry.source.category === 'Dermatology') trend *= between(1.15, 1.35);

    const sellsUntilDay =
      role === 'DEAD' ? WINDOW_DAYS - 1 - intBetween(95, 140) : WINDOW_DAYS - 1;

    let replenishUntilDay = WINDOW_DAYS - 1;
    if (role === 'OUT') replenishUntilDay = WINDOW_DAYS - 1 - intBetween(22, 38);
    else if (role === 'LOW') replenishUntilDay = WINDOW_DAYS - 1 - intBetween(6, 14);
    else if (role === 'DEAD' || role === 'NEVER_SOLD') replenishUntilDay = 0;
    else if (role === 'OVERSTOCK') replenishUntilDay = WINDOW_DAYS - 1;

    return {
      id: entry.id,
      row: null as unknown as ProductRow, // filled in after the stock levels update
      role,
      baseVelocity: round2(baseVelocity),
      trend,
      sellsUntilDay,
      replenishUntilDay,
      supplierId: supplierIds[i % supplierIds.length],
      // Devices and dressings carry long shelf lives; medicines do not.
      shelfLifeDays: entry.source.form === 'Device' || entry.source.form === 'Dressing'
        ? intBetween(900, 1400)
        : intBetween(400, 900),
    };
  });

  // ---- set stock levels from velocity -------------------------------------
  const update = db.prepare(
    'UPDATE products SET reorder_level = ?, minimum_stock = ?, maximum_stock = ? WHERE id = ?',
  );
  db.transaction(() => {
    for (const plan of plans) {
      // Reorder at roughly 10 days of demand, hold at most ~45 days.
      const reorder = Math.max(8, Math.ceil(plan.baseVelocity * 10));
      const minimum = Math.max(4, Math.ceil(plan.baseVelocity * 5));
      let maximum = Math.max(30, Math.ceil(plan.baseVelocity * 45));
      // Overstocked lines get a deliberately tight ceiling, which the oversized
      // opening purchase below then breaches - that is the planted condition.
      if (plan.role === 'OVERSTOCK') maximum = Math.max(20, Math.ceil(plan.baseVelocity * 20));
      update.run(reorder, minimum, maximum, plan.id);
    }
  })();

  const rows = db.prepare('SELECT * FROM products').all() as ProductRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const plan of plans) plan.row = byId.get(plan.id)!;

  return plans;
}

// ---------------------------------------------------------------------------
// Purchasing
// ---------------------------------------------------------------------------

let batchCounter = 0;

function nextBatchNumber(dayIndex: number): string {
  batchCounter += 1;
  const date = dayToDate(dayIndex).replace(/-/g, '').slice(2);
  return `B${date}-${String(batchCounter).padStart(4, '0')}`;
}

/**
 * Places purchase orders, grouped by supplier so each one is a realistic
 * multi-line goods-inward document rather than a single-item order.
 */
function placePurchases(
  lines: { plan: ProductPlan; quantity: number; expiryDate?: string }[],
  dayIndex: number,
  userId: number,
): number {
  if (lines.length === 0) return 0;

  const bySupplier = new Map<number, PurchaseItemInput[]>();
  const purchaseDate = dayToDate(dayIndex);

  for (const line of lines) {
    if (line.quantity <= 0) continue;
    const { plan } = line;

    // Suppliers change their prices over time; +/-6% keeps batch costs varied,
    // which is what makes per-batch COGS meaningful rather than decorative.
    const cost = round2(plan.row.purchase_price * between(0.94, 1.06));
    const expiry = line.expiryDate ?? addDays(purchaseDate, plan.shelfLifeDays);

    const items = bySupplier.get(plan.supplierId) ?? [];
    items.push({
      product_id: plan.id,
      batch_number: nextBatchNumber(dayIndex),
      quantity: line.quantity,
      purchase_price: cost,
      selling_price: plan.row.selling_price,
      expiry_date: expiry,
      manufacturing_date: addDays(purchaseDate, -intBetween(20, 120)),
      tax_rate: plan.row.tax_rate,
      // The seed sets master prices once; letting every purchase rewrite them
      // would mask the per-batch cost variation this dataset is meant to show.
      update_product_price: false,
    });
    bySupplier.set(plan.supplierId, items);
  }

  let created = 0;
  for (const [supplierId, items] of bySupplier) {
    createPurchase({
      supplier_id: supplierId,
      items,
      purchase_date: purchaseDate,
      payment_status: rand() < 0.82 ? 'PAID' : rand() < 0.6 ? 'PARTIAL' : 'UNPAID',
      user_id: userId,
    });
    created += 1;
  }
  return created;
}

// ---------------------------------------------------------------------------
// Sales simulation
// ---------------------------------------------------------------------------

/** Weekday demand shape: Sunday is quiet, Saturday busy. */
function weekdayFactor(dateIso: string): number {
  const dow = new Date(dateIso).getDay();
  return [0.62, 1.0, 0.96, 0.98, 1.02, 1.12, 1.18][dow];
}

/**
 * Velocity for a product on a given day: its base rate, moved linearly towards
 * its trend multiplier across the window, then shaped by the weekday.
 */
function velocityOn(plan: ProductPlan, dayIndex: number, dateIso: string): number {
  if (dayIndex > plan.sellsUntilDay) return 0;
  const progress = dayIndex / (WINDOW_DAYS - 1);
  const trended = plan.baseVelocity * (1 + (plan.trend - 1) * progress);
  // Overall uplift so the business is visibly growing period on period. The
  // trend rule compares the last 30 days with the 30 before, so this has to be
  // large enough to clear the salesGrowthThresholdPct reporting floor.
  const businessGrowth = 1 + 0.55 * progress;
  return trended * businessGrowth * weekdayFactor(dateIso);
}

const PAYMENT_METHODS: PaymentMethod[] = ['CASH', 'UPI', 'CARD', 'OTHER'];

function paymentMethod(): PaymentMethod {
  const r = rand();
  if (r < 0.42) return 'CASH';
  if (r < 0.78) return 'UPI';
  if (r < 0.96) return 'CARD';
  return PAYMENT_METHODS[3];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function seed(): void {
  const started = Date.now();
  const db = getDb();

  runMigrations(db);

  const users = db.prepare("SELECT id, role FROM users ORDER BY id").all() as {
    id: number;
    role: string;
  }[];
  const adminId = users.find((u) => u.role === 'ADMIN')?.id ?? 1;
  const cashierIds = users.map((u) => u.id);

  console.log('  Clearing existing business data...');
  clearBusinessData();

  const catalog = loadCatalog();

  console.log(`  Creating ${catalog.suppliers.length} suppliers...`);
  const supplierIds = seedSuppliers(catalog);

  console.log(`  Creating ${catalog.products.length} products...`);
  const plans = seedProducts(catalog, supplierIds);
  const planById = new Map(plans.map((p) => [p.id, p]));

  console.log('  Creating customers...');
  const customerIds = seedCustomers(catalog);

  // ---- opening stock ------------------------------------------------------
  console.log('  Placing opening stock purchases...');
  let purchaseCount = 0;

  purchaseCount += placePurchases(
    plans.map((plan) => {
      // Roughly 40 days of demand, or a token quantity for lines with no demand.
      let quantity = Math.max(12, Math.ceil(plan.baseVelocity * 40));
      // Over-buy the overstock group on purpose - this is the planted condition.
      if (plan.role === 'OVERSTOCK') quantity = Math.max(60, Math.ceil(plan.row.maximum_stock * 2.4));
      // Dead stock needs enough left over to still be sitting there today.
      if (plan.role === 'DEAD') quantity = Math.max(40, Math.ceil(plan.baseVelocity * 90));
      if (plan.role === 'NEVER_SOLD') quantity = intBetween(25, 70);
      return { plan, quantity };
    }),
    0,
    adminId,
  );

  // ---- planted expiry exposure -------------------------------------------
  // Chosen from the slowest-moving lines: a near-expiry batch on a fast mover
  // would simply sell through and the condition would never materialise.
  const slowest = [...plans]
    .filter((p) => p.role !== 'OUT' && p.role !== 'LOW')
    .sort((a, b) => a.baseVelocity - b.baseVelocity);

  const expiredGroup = slowest.slice(0, 6);
  const expiringGroup = slowest.slice(6, 34);

  console.log('  Planting expiry exposure...');
  // Bought ~5 months ago with a short remaining shelf life; already lapsed.
  purchaseCount += placePurchases(
    expiredGroup.map((plan) => ({
      plan,
      quantity: intBetween(25, 70),
      expiryDate: addDays(today(), -intBetween(4, 40)),
    })),
    WINDOW_DAYS - 155,
    adminId,
  );

  // Bought recently, short-dated stock that has not cleared.
  purchaseCount += placePurchases(
    expiringGroup.map((plan) => ({
      plan,
      quantity: intBetween(45, 120),
      expiryDate: addDays(today(), intBetween(6, 88)),
    })),
    WINDOW_DAYS - 16,
    adminId,
  );

  // ---- day-by-day trading -------------------------------------------------
  console.log(`  Simulating ${WINDOW_DAYS} days of trading...`);

  let saleCount = 0;
  let failedLines = 0;
  const saleIds: number[] = [];

  for (let day = 1; day < WINDOW_DAYS; day += 1) {
    const dateIso = dayToDate(day);

    // -- replenishment, every third day --------------------------------------
    if (day % 3 === 0) {
      const lines: { plan: ProductPlan; quantity: number }[] = [];
      for (const plan of plans) {
        if (day > plan.replenishUntilDay) continue;
        if (plan.role === 'NEVER_SOLD' || plan.role === 'DEAD') continue;

        const stock = getProductStock(plan.id);
        // Order when stock falls under ~1.6x the reorder level, so replenishment
        // arrives before the reorder alarm rather than after it.
        if (stock > plan.row.reorder_level * 1.6) continue;

        // Lines destined to end up low are topped up only partially, so their
        // final replenishment leaves them under the reorder level instead of
        // restoring them to maximum.
        const factor = plan.role === 'LOW' ? 0.45 : 1;
        const target = Math.ceil(Math.max(plan.row.maximum_stock, plan.baseVelocity * 30) * factor);
        const quantity = Math.max(0, target - stock);
        if (quantity > 0) lines.push({ plan, quantity });
      }
      // Not every eligible line is ordered every cycle - real buying is lumpier.
      purchaseCount += placePurchases(
        lines.filter(() => rand() < 0.85),
        day,
        adminId,
      );
    }

    // -- demand for the day ---------------------------------------------------
    const basket: { productId: number; quantity: number }[] = [];
    for (const plan of plans) {
      const units = demandDraw(velocityOn(plan, day, dateIso));
      if (units > 0) basket.push({ productId: plan.id, quantity: units });
    }
    if (basket.length === 0) continue;

    // -- split the day's demand into individual transactions ------------------
    const shuffledBasket = shuffled(basket);
    const transactions: { productId: number; quantity: number }[][] = [];
    let current: { productId: number; quantity: number }[] = [];
    // Most bills are 1-3 lines; a few institutional orders are much larger.
    let targetLines = intBetween(1, 3);

    for (const entry of shuffledBasket) {
      // Split a large per-product day total across several bills rather than
      // selling 30 units of one product on a single invoice.
      let remaining = entry.quantity;
      while (remaining > 0) {
        const take = Math.min(remaining, intBetween(1, 4));
        current.push({ productId: entry.productId, quantity: take });
        remaining -= take;

        if (current.length >= targetLines) {
          transactions.push(current);
          current = [];
          targetLines = rand() < 0.08 ? intBetween(5, 9) : intBetween(1, 3);
        }
      }
    }
    if (current.length > 0) transactions.push(current);

    // -- write the sales ------------------------------------------------------
    for (const lines of transactions) {
      const items: SaleItemInput[] = lines.map((l) => {
        const plan = planById.get(l.productId)!;
        // Occasional counter discount, capped so margin stays plausible.
        const discount =
          rand() < 0.18 ? round2(plan.row.selling_price * l.quantity * between(0.02, 0.09)) : 0;
        return { product_id: l.productId, quantity: l.quantity, discount };
      });

      const hour = intBetween(9, 20);
      const saleDate = `${dateIso} ${String(hour).padStart(2, '0')}:${String(intBetween(0, 59)).padStart(2, '0')}:00`;

      try {
        const sale = createSale({
          items,
          // Roughly half of bills are attached to a known customer.
          customer_id: rand() < 0.52 ? pick(customerIds) : null,
          payment_method: paymentMethod(),
          bill_discount: rand() < 0.06 ? round2(between(5, 40)) : 0,
          sale_date: saleDate,
          user_id: pick(cashierIds),
        });
        saleIds.push(sale.id);
        saleCount += 1;
      } catch {
        // Insufficient stock on the day - exactly what happens in a real shop
        // when a line runs out. The sale simply does not occur.
        failedLines += 1;
      }
    }
  }

  // ---- returns ------------------------------------------------------------
  console.log('  Recording customer returns...');
  let returnCount = 0;
  const returnable = saleIds.slice(-Math.floor(saleIds.length * 0.5));

  for (let i = 0; i < 30; i += 1) {
    const saleId = pick(returnable);
    const items = db
      .prepare('SELECT id, quantity, returned_quantity FROM sale_items WHERE sale_id = ?')
      .all(saleId) as { id: number; quantity: number; returned_quantity: number }[];
    const candidate = items.find((it) => it.quantity - it.returned_quantity > 0);
    if (!candidate) continue;

    const reason = pick(['CUSTOMER_RETURN', 'CUSTOMER_RETURN', 'WRONG_ITEM', 'DAMAGED'] as const);
    try {
      createReturn({
        sale_id: saleId,
        reason,
        items: [
          {
            sale_item_id: candidate.id,
            quantity: Math.min(candidate.quantity - candidate.returned_quantity, intBetween(1, 2)),
          },
        ],
        // Damaged goods do not go back on the shelf.
        restock: reason !== 'DAMAGED',
        user_id: adminId,
      });
      returnCount += 1;
    } catch {
      // A sale already fully returned - skip it.
    }
  }

  // ---- report -------------------------------------------------------------
  const stats = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM products)               AS products,
              (SELECT COUNT(*) FROM suppliers)              AS suppliers,
              (SELECT COUNT(*) FROM customers)              AS customers,
              (SELECT COUNT(*) FROM product_batches)        AS batches,
              (SELECT COUNT(*) FROM purchases)              AS purchases,
              (SELECT COUNT(*) FROM sales)                  AS sales,
              (SELECT COUNT(*) FROM sale_items)             AS saleItems,
              (SELECT COUNT(*) FROM sale_returns)           AS returns,
              (SELECT COUNT(*) FROM inventory_transactions) AS transactions`,
    )
    .get() as Record<string, number>;

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log('');
  console.log('  Demo database created');
  console.log('  ------------------------------------------------');
  console.log(`  Products      ${stats.products}`);
  console.log(`  Suppliers     ${stats.suppliers}`);
  console.log(`  Customers     ${stats.customers}`);
  console.log(`  Batches       ${stats.batches}`);
  console.log(`  Purchases     ${stats.purchases}`);
  console.log(`  Sales         ${stats.sales}  (${stats.saleItems} line items)`);
  console.log(`  Returns       ${stats.returns}`);
  console.log(`  Stock moves   ${stats.transactions}`);
  console.log(`  Period        ${dayToDate(0)} to ${today()}`);
  console.log(`  Generated in  ${elapsed}s  (seed ${SEED}, reproducible)`);
  if (failedLines > 0) {
    console.log(`  Note          ${failedLines} bills could not be filled from stock on the day.`);
  }
  console.log('');
}

// Run when invoked directly (npm run seed), not when imported by a test.
if (require.main === module) {
  try {
    seed();
    closeDb();
  } catch (err) {
    console.error('\n  Seeding failed:', err instanceof Error ? err.message : err);
    closeDb();
    process.exit(1);
  }
}
