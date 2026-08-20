import type { Db } from '../database/connection';
import { recordTransaction } from '../services/inventoryService';
import { round2 } from '../utils/money';
import { now, today } from '../utils/dates';
import { derivedProductCode, parseScheme } from './coerce';
import type { ImportOptions, ImportOutcome, ImportType, RowIssue, ValidatedRow } from './types';

/**
 * Import Center - writing validated rows into the operational tables.
 *
 * Design decisions worth stating, because they are what make this safe to point
 * at a real pharmacy's file:
 *
 *   1. NORMALISED, NOT DUMPED. A spreadsheet row is spread across products,
 *      manufacturers, batches, suppliers and the inventory ledger. Nothing is
 *      written to a wide "imported_data" table.
 *
 *   2. ONE TRANSACTION. The caller wraps a commit in a single SQLite
 *      transaction, so an import either lands completely or not at all. There
 *      is no half-imported stock file to unpick.
 *
 *   3. REUSE, DON'T DUPLICATE. Products, suppliers, distributors and
 *      manufacturers are matched against what is already there before anything
 *      is created. Re-importing last month's file updates rows; it does not
 *      produce a second copy of the catalogue.
 *
 *   4. THE LEDGER IS ALWAYS WRITTEN. Every quantity change goes through
 *      `recordTransaction`, so imported stock is as traceable as stock that
 *      arrived through a purchase order.
 *
 *   5. BULK PATH, NOT THE CRUD SERVICES. The per-record services validate and
 *      re-query on every call, which is right for a form and wrong for 10,000
 *      rows. This module uses prepared statements against the same tables and
 *      the same ledger helper, so the invariants match while the throughput is
 *      an order of magnitude better.
 */

/* -------------------------------------------------------------------------- */
/* Shared context                                                              */
/* -------------------------------------------------------------------------- */

interface Ctx {
  db: Db;
  jobId: number;
  userId: number | null;
  options: Required<ImportOptions>;
  issues: RowIssue[];
  notes: string[];
  /** lower(name) -> id caches, filled lazily and kept warm across rows. */
  products: Map<string, number>;
  productsByCode: Map<string, number>;
  manufacturers: Map<string, number>;
  suppliers: Map<string, number>;
  distributors: Map<string, number>;
  distributorsByCode: Map<string, number>;
  customers: Map<string, number>;
  created: { manufacturers: number; suppliers: number; products: number; distributors: number; customers: number };
  /** Next document number per table, so numbering is O(1) per imported document. */
  counters: Map<string, number>;
}

const key = (value: unknown): string => String(value ?? '').trim().toLowerCase();

function str(row: ValidatedRow, field: string): string | null {
  const value = row.values[field];
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function num(row: ValidatedRow, field: string): number | null {
  const value = row.values[field];
  return typeof value === 'number' ? value : null;
}

function bool(row: ValidatedRow, field: string): boolean | null {
  const value = row.values[field];
  return typeof value === 'boolean' ? value : null;
}

function addIssue(ctx: Ctx, row: ValidatedRow, message: string, severity: 'ERROR' | 'WARNING' = 'ERROR'): void {
  ctx.issues.push({ rowNumber: row.rowNumber, severity, message });
}

/* -------------------------------------------------------------------------- */
/* Reference resolution                                                        */
/* -------------------------------------------------------------------------- */

function loadCaches(ctx: Ctx): void {
  for (const r of ctx.db.prepare('SELECT id, product_name, product_code FROM products').all() as {
    id: number; product_name: string; product_code: string;
  }[]) {
    if (!ctx.products.has(key(r.product_name))) ctx.products.set(key(r.product_name), r.id);
    ctx.productsByCode.set(key(r.product_code), r.id);
  }
  for (const r of ctx.db.prepare('SELECT id, name FROM manufacturers').all() as { id: number; name: string }[]) {
    ctx.manufacturers.set(key(r.name), r.id);
  }
  for (const r of ctx.db.prepare('SELECT id, supplier_name FROM suppliers').all() as { id: number; supplier_name: string }[]) {
    ctx.suppliers.set(key(r.supplier_name), r.id);
  }
  for (const r of ctx.db.prepare('SELECT id, name, distributor_code FROM distributors').all() as {
    id: number; name: string; distributor_code: string;
  }[]) {
    ctx.distributors.set(key(r.name), r.id);
    ctx.distributorsByCode.set(key(r.distributor_code), r.id);
  }
  for (const r of ctx.db.prepare('SELECT id, name, phone FROM customers').all() as {
    id: number; name: string; phone: string | null;
  }[]) {
    ctx.customers.set(key(`${r.name}|${r.phone ?? ''}`), r.id);
  }
}

function resolveManufacturer(ctx: Ctx, name: string | null): number | null {
  if (!name) return null;
  const existing = ctx.manufacturers.get(key(name));
  if (existing) return existing;
  if (!ctx.options.createMissingReferences) return null;

  const result = ctx.db
    .prepare('INSERT INTO manufacturers (name, source_import_job_id) VALUES (?, ?)')
    .run(name, ctx.jobId);
  const id = Number(result.lastInsertRowid);
  ctx.manufacturers.set(key(name), id);
  ctx.created.manufacturers += 1;
  return id;
}

function resolveSupplier(ctx: Ctx, name: string | null): number | null {
  if (!name) return null;
  const existing = ctx.suppliers.get(key(name));
  if (existing) return existing;
  if (!ctx.options.createMissingReferences) return null;

  const result = ctx.db
    .prepare('INSERT INTO suppliers (supplier_name, source_import_job_id) VALUES (?, ?)')
    .run(name, ctx.jobId);
  const id = Number(result.lastInsertRowid);
  ctx.suppliers.set(key(name), id);
  ctx.created.suppliers += 1;
  return id;
}

/**
 * Finds the product a row refers to.
 *
 * Code wins over name: a file carrying both is authoritative on the code, and
 * two products can legitimately share a display name across pack sizes.
 * When neither matches and the row names a product, a minimal product record is
 * created so a stock or purchase file is not blocked by a catalogue gap.
 */
function resolveProduct(ctx: Ctx, row: ValidatedRow, allowCreate: boolean): number | null {
  const code = str(row, 'product_code');
  const name = str(row, 'product_name');

  if (code) {
    const byCode = ctx.productsByCode.get(key(code));
    if (byCode) return byCode;
  }
  if (name) {
    const byName = ctx.products.get(key(name));
    if (byName) return byName;
  }

  if (!allowCreate || !ctx.options.createMissingReferences) return null;
  if (!name) {
    addIssue(ctx, row, `No product matches code "${code}", and the row has no product name to create one from`);
    return null;
  }

  const productCode = code ?? derivedProductCode(name);
  const mrp = num(row, 'mrp') ?? num(row, 'selling_price') ?? 0;
  const ptr = num(row, 'ptr') ?? 0;

  const result = ctx.db
    .prepare(
      `INSERT INTO products
         (product_code, product_name, category, manufacturer, manufacturer_id, purchase_price,
          selling_price, mrp, ptr, pts, tax_rate, reorder_level, minimum_stock, maximum_stock,
          source_import_job_id)
       VALUES (?, ?, 'General', ?, ?, ?, ?, ?, ?, ?, ?, 10, 5, 200, ?)`,
    )
    .run(
      productCode,
      name,
      str(row, 'manufacturer'),
      resolveManufacturer(ctx, str(row, 'manufacturer')),
      ptr,
      mrp,
      mrp,
      ptr,
      num(row, 'pts') ?? round2(ptr * 0.92),
      num(row, 'tax_rate') ?? 12,
      ctx.jobId,
    );

  const id = Number(result.lastInsertRowid);
  ctx.products.set(key(name), id);
  ctx.productsByCode.set(key(productCode), id);
  ctx.created.products += 1;
  return id;
}

function resolveDistributor(ctx: Ctx, row: ValidatedRow, allowCreate: boolean): number | null {
  const code = str(row, 'distributor_code');
  const name = str(row, 'distributor_name') ?? str(row, 'supplier_name') ?? str(row, 'name');

  if (code) {
    const byCode = ctx.distributorsByCode.get(key(code));
    if (byCode) return byCode;
  }
  if (name) {
    const byName = ctx.distributors.get(key(name));
    if (byName) return byName;
  }
  if (!allowCreate || !ctx.options.createMissingReferences || !name) return null;

  const distributorCode = code ?? `IMP-${String(ctx.distributors.size + 1).padStart(4, '0')}`;
  const supplierId = resolveSupplier(ctx, name);

  const result = ctx.db
    .prepare(
      `INSERT INTO distributors (distributor_code, name, supplier_id, source_import_job_id)
       VALUES (?, ?, ?, ?)`,
    )
    .run(distributorCode, name, supplierId, ctx.jobId);

  const id = Number(result.lastInsertRowid);
  ctx.distributors.set(key(name), id);
  ctx.distributorsByCode.set(key(distributorCode), id);
  ctx.created.distributors += 1;
  return id;
}

/* -------------------------------------------------------------------------- */
/* Product master                                                              */
/* -------------------------------------------------------------------------- */

function importProducts(ctx: Ctx, rows: ValidatedRow[]): { created: number; updated: number; skipped: number } {
  let created = 0;
  let updated = 0;
  let skipped = 0;

  const insert = ctx.db.prepare(
    `INSERT INTO products
       (product_code, product_name, generic_name, brand_name, composition, category, dosage_form,
        strength, pack_size, unit, units_per_pack, manufacturer, manufacturer_id, barcode, hsn_code,
        tax_rate, mrp, ptr, pts, purchase_price, selling_price, reorder_level, minimum_stock,
        maximum_stock, lead_time_days, schedule_category, prescription_flag, storage_condition,
        status, source_import_job_id)
     VALUES
       (@product_code, @product_name, @generic_name, @brand_name, @composition, @category, @dosage_form,
        @strength, @pack_size, @unit, @units_per_pack, @manufacturer, @manufacturer_id, @barcode, @hsn_code,
        @tax_rate, @mrp, @ptr, @pts, @purchase_price, @selling_price, @reorder_level, @minimum_stock,
        @maximum_stock, @lead_time_days, @schedule_category, @prescription_flag, @storage_condition,
        @status, @job_id)`,
  );

  const update = ctx.db.prepare(
    `UPDATE products SET
       product_name = @product_name, generic_name = @generic_name, brand_name = @brand_name,
       composition = @composition, category = @category, dosage_form = @dosage_form,
       strength = @strength, pack_size = @pack_size, unit = @unit, units_per_pack = @units_per_pack,
       manufacturer = @manufacturer, manufacturer_id = @manufacturer_id, barcode = @barcode,
       hsn_code = @hsn_code, tax_rate = @tax_rate, mrp = @mrp, ptr = @ptr, pts = @pts,
       purchase_price = @purchase_price, selling_price = @selling_price,
       reorder_level = @reorder_level, minimum_stock = @minimum_stock, maximum_stock = @maximum_stock,
       lead_time_days = @lead_time_days, schedule_category = @schedule_category,
       prescription_flag = @prescription_flag, storage_condition = @storage_condition,
       status = @status, source_import_job_id = @job_id, updated_at = datetime('now')
     WHERE id = @id`,
  );

  for (const row of rows) {
    const name = str(row, 'product_name');
    const code = str(row, 'product_code');
    if (!name && !code) {
      skipped += 1;
      continue;
    }

    const existingId =
      (code ? ctx.productsByCode.get(key(code)) : undefined) ??
      (name ? ctx.products.get(key(name)) : undefined) ??
      null;

    if (existingId && !ctx.options.updateExisting) {
      skipped += 1;
      continue;
    }

    // Existing values matter on update: a price list that carries only MRP must
    // not wipe the reorder levels the pharmacy has tuned by hand.
    const current = existingId
      ? (ctx.db.prepare('SELECT * FROM products WHERE id = ?').get(existingId) as Record<string, unknown>)
      : null;

    const keep = <T>(value: T | null, fallback: T): T => (value === null || value === undefined ? fallback : value);

    const schedule = str(row, 'schedule_category') ?? (current?.schedule_category as string | undefined) ?? 'OTC';
    const prescriptionFromSchedule = /^(h1|h|x)$/i.test(schedule.trim());
    const mrp = keep(num(row, 'mrp'), (current?.mrp as number) ?? 0);
    const ptr = keep(num(row, 'ptr'), (current?.ptr as number) ?? 0);
    const productName = name ?? (current?.product_name as string) ?? code!;

    const params = {
      id: existingId,
      job_id: ctx.jobId,
      product_code: code ?? (current?.product_code as string) ?? derivedProductCode(productName),
      product_name: productName,
      generic_name: keep(str(row, 'generic_name'), (current?.generic_name as string) ?? null),
      brand_name: keep(str(row, 'brand_name'), (current?.brand_name as string) ?? null),
      composition: keep(str(row, 'composition'), (current?.composition as string) ?? null),
      category: keep(str(row, 'category'), (current?.category as string) ?? 'General'),
      dosage_form: keep(str(row, 'dosage_form'), (current?.dosage_form as string) ?? null),
      strength: keep(str(row, 'strength'), (current?.strength as string) ?? null),
      pack_size: keep(str(row, 'pack_size'), (current?.pack_size as string) ?? null),
      unit: keep(str(row, 'unit'), (current?.unit as string) ?? 'Strip'),
      units_per_pack: keep(num(row, 'units_per_pack'), (current?.units_per_pack as number) ?? 1),
      manufacturer: keep(str(row, 'manufacturer'), (current?.manufacturer as string) ?? null),
      manufacturer_id:
        resolveManufacturer(ctx, str(row, 'manufacturer')) ?? (current?.manufacturer_id as number) ?? null,
      barcode: keep(str(row, 'barcode'), (current?.barcode as string) ?? null),
      hsn_code: keep(str(row, 'hsn_code'), (current?.hsn_code as string) ?? '3004'),
      tax_rate: keep(num(row, 'tax_rate'), (current?.tax_rate as number) ?? 12),
      mrp,
      ptr,
      pts: keep(num(row, 'pts'), (current?.pts as number) ?? round2(ptr * 0.92)),
      purchase_price: ptr || ((current?.purchase_price as number) ?? 0),
      selling_price: keep(num(row, 'selling_price'), mrp || ((current?.selling_price as number) ?? 0)),
      reorder_level: keep(num(row, 'reorder_level'), (current?.reorder_level as number) ?? 10),
      minimum_stock: keep(num(row, 'minimum_stock'), (current?.minimum_stock as number) ?? 5),
      maximum_stock: keep(num(row, 'maximum_stock'), (current?.maximum_stock as number) ?? 200),
      lead_time_days: keep(num(row, 'lead_time_days'), (current?.lead_time_days as number) ?? 2),
      schedule_category: schedule,
      prescription_flag:
        (bool(row, 'prescription_flag') ?? (current?.prescription_flag === 1 || prescriptionFromSchedule)) ? 1 : 0,
      storage_condition: keep(str(row, 'storage_condition'), (current?.storage_condition as string) ?? 'Below 25C'),
      status: keep(str(row, 'status'), (current?.status as string) ?? 'ACTIVE'),
    };

    try {
      if (existingId) {
        update.run(params);
        updated += 1;
      } else {
        const result = insert.run(params);
        const id = Number(result.lastInsertRowid);
        ctx.products.set(key(params.product_name), id);
        ctx.productsByCode.set(key(params.product_code), id);
        created += 1;
      }
    } catch (err) {
      addIssue(ctx, row, `Could not save "${params.product_name}": ${(err as Error).message}`);
      skipped += 1;
    }
  }

  return { created, updated, skipped };
}

/* -------------------------------------------------------------------------- */
/* Manufacturer / supplier / distributor masters                               */
/* -------------------------------------------------------------------------- */

function importManufacturers(ctx: Ctx, rows: ValidatedRow[]) {
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    const name = str(row, 'name');
    if (!name) {
      skipped += 1;
      continue;
    }

    const existing = ctx.manufacturers.get(key(name));
    const params = {
      name,
      code: str(row, 'code'),
      contact_person: str(row, 'contact_person'),
      phone: str(row, 'phone'),
      email: str(row, 'email'),
      address: str(row, 'address'),
      status: str(row, 'status') ?? 'ACTIVE',
      job_id: ctx.jobId,
    };

    try {
      if (existing) {
        if (!ctx.options.updateExisting) {
          skipped += 1;
          continue;
        }
        ctx.db
          .prepare(
            `UPDATE manufacturers SET code = COALESCE(@code, code), contact_person = COALESCE(@contact_person, contact_person),
               phone = COALESCE(@phone, phone), email = COALESCE(@email, email),
               address = COALESCE(@address, address), status = @status, source_import_job_id = @job_id
             WHERE id = ${existing}`,
          )
          .run(params);
        updated += 1;
      } else {
        const result = ctx.db
          .prepare(
            `INSERT INTO manufacturers (name, code, contact_person, phone, email, address, status, source_import_job_id)
             VALUES (@name, @code, @contact_person, @phone, @email, @address, @status, @job_id)`,
          )
          .run(params);
        ctx.manufacturers.set(key(name), Number(result.lastInsertRowid));
        created += 1;
      }
    } catch (err) {
      addIssue(ctx, row, `Could not save manufacturer "${name}": ${(err as Error).message}`);
      skipped += 1;
    }
  }
  return { created, updated, skipped };
}

function importSuppliers(ctx: Ctx, rows: ValidatedRow[]) {
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    const name = str(row, 'supplier_name');
    if (!name) {
      skipped += 1;
      continue;
    }

    const existing = ctx.suppliers.get(key(name));
    const params = {
      supplier_name: name,
      contact_person: str(row, 'contact_person'),
      phone: str(row, 'phone'),
      email: str(row, 'email'),
      address: str(row, 'address'),
      payment_terms: str(row, 'payment_terms'),
      status: str(row, 'status') ?? 'ACTIVE',
      job_id: ctx.jobId,
    };

    try {
      if (existing) {
        if (!ctx.options.updateExisting) {
          skipped += 1;
          continue;
        }
        ctx.db
          .prepare(
            `UPDATE suppliers SET contact_person = COALESCE(@contact_person, contact_person),
               phone = COALESCE(@phone, phone), email = COALESCE(@email, email),
               address = COALESCE(@address, address), payment_terms = COALESCE(@payment_terms, payment_terms),
               status = @status, source_import_job_id = @job_id, updated_at = datetime('now')
             WHERE id = ${existing}`,
          )
          .run(params);
        updated += 1;
      } else {
        const result = ctx.db
          .prepare(
            `INSERT INTO suppliers (supplier_name, contact_person, phone, email, address, payment_terms, status, source_import_job_id)
             VALUES (@supplier_name, @contact_person, @phone, @email, @address, @payment_terms, @status, @job_id)`,
          )
          .run(params);
        ctx.suppliers.set(key(name), Number(result.lastInsertRowid));
        created += 1;
      }
    } catch (err) {
      addIssue(ctx, row, `Could not save supplier "${name}": ${(err as Error).message}`);
      skipped += 1;
    }
  }
  return { created, updated, skipped };
}

function importDistributors(ctx: Ctx, rows: ValidatedRow[]) {
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    const name = str(row, 'name');
    const code = str(row, 'distributor_code');
    if (!name && !code) {
      skipped += 1;
      continue;
    }

    const existing =
      (code ? ctx.distributorsByCode.get(key(code)) : undefined) ??
      (name ? ctx.distributors.get(key(name)) : undefined) ??
      null;

    if (existing && !ctx.options.updateExisting) {
      skipped += 1;
      continue;
    }

    const current = existing
      ? (ctx.db.prepare('SELECT * FROM distributors WHERE id = ?').get(existing) as Record<string, unknown>)
      : null;
    const distributorName = name ?? (current?.name as string) ?? code!;

    // Every distributor is mirrored as a supplier, because goods-inward
    // documents reference suppliers. Keeping the pair in step here is what lets
    // an imported distributor receive a purchase order later.
    const supplierId = (current?.supplier_id as number) ?? resolveSupplier(ctx, distributorName);

    const params = {
      distributor_code: code ?? (current?.distributor_code as string) ?? `IMP-${String(ctx.distributors.size + 1).padStart(4, '0')}`,
      name: distributorName,
      type: str(row, 'type') ?? (current?.type as string) ?? 'DISTRIBUTOR',
      contact_person: str(row, 'contact_person') ?? (current?.contact_person as string) ?? null,
      phone: str(row, 'phone') ?? (current?.phone as string) ?? null,
      email: str(row, 'email') ?? (current?.email as string) ?? null,
      address: str(row, 'address') ?? (current?.address as string) ?? null,
      area: str(row, 'area') ?? (current?.area as string) ?? null,
      city: str(row, 'city') ?? (current?.city as string) ?? null,
      pin_code: str(row, 'pin_code') ?? (current?.pin_code as string) ?? null,
      state: str(row, 'state') ?? (current?.state as string) ?? null,
      gstin: str(row, 'gstin') ?? (current?.gstin as string) ?? null,
      drug_license_no: str(row, 'drug_license_no') ?? (current?.drug_license_no as string) ?? null,
      payment_terms: str(row, 'payment_terms') ?? (current?.payment_terms as string) ?? 'Net 30',
      credit_days: num(row, 'credit_days') ?? (current?.credit_days as number) ?? 30,
      credit_limit: num(row, 'credit_limit') ?? (current?.credit_limit as number) ?? 0,
      delivery_days: num(row, 'delivery_days') ?? (current?.delivery_days as number) ?? 1,
      min_order_value: num(row, 'min_order_value') ?? (current?.min_order_value as number) ?? 0,
      distance_km: num(row, 'distance_km') ?? (current?.distance_km as number) ?? 0,
      rating: num(row, 'rating') ?? (current?.rating as number) ?? 0,
      status: str(row, 'status') ?? (current?.status as string) ?? 'ACTIVE',
      supplier_id: supplierId,
      job_id: ctx.jobId,
    };

    try {
      if (existing) {
        ctx.db
          .prepare(
            `UPDATE distributors SET
               distributor_code = @distributor_code, name = @name, type = @type,
               contact_person = @contact_person, phone = @phone, email = @email, address = @address,
               area = @area, city = @city, pin_code = @pin_code, state = @state, gstin = @gstin,
               drug_license_no = @drug_license_no, payment_terms = @payment_terms,
               credit_days = @credit_days, credit_limit = @credit_limit, delivery_days = @delivery_days,
               min_order_value = @min_order_value, distance_km = @distance_km, rating = @rating,
               status = @status, supplier_id = @supplier_id, source_import_job_id = @job_id,
               updated_at = datetime('now')
             WHERE id = ${existing}`,
          )
          .run(params);
        updated += 1;
      } else {
        const result = ctx.db
          .prepare(
            `INSERT INTO distributors
               (distributor_code, name, type, contact_person, phone, email, address, area, city,
                pin_code, state, gstin, drug_license_no, payment_terms, credit_days, credit_limit,
                delivery_days, min_order_value, distance_km, rating, status, supplier_id, source_import_job_id)
             VALUES
               (@distributor_code, @name, @type, @contact_person, @phone, @email, @address, @area, @city,
                @pin_code, @state, @gstin, @drug_license_no, @payment_terms, @credit_days, @credit_limit,
                @delivery_days, @min_order_value, @distance_km, @rating, @status, @supplier_id, @job_id)`,
          )
          .run(params);
        const id = Number(result.lastInsertRowid);
        ctx.distributors.set(key(params.name), id);
        ctx.distributorsByCode.set(key(params.distributor_code), id);
        created += 1;
      }
    } catch (err) {
      addIssue(ctx, row, `Could not save distributor "${distributorName}": ${(err as Error).message}`);
      skipped += 1;
    }
  }
  return { created, updated, skipped };
}

/* -------------------------------------------------------------------------- */
/* Stock: opening stock and batch master                                       */
/* -------------------------------------------------------------------------- */

/**
 * Writes batches and their quantities.
 *
 * `mode` is the only difference between the two stock imports, which is why
 * they share one implementation rather than existing as two near-identical
 * copies:
 *   SET  (Opening Stock) - the file states what is on the shelf. The batch is
 *        moved to that quantity and the difference is logged as an adjustment.
 *   ADD  (Batch Master)  - the file states what arrived. The quantity is added
 *        and logged as stock received.
 */
function importStock(ctx: Ctx, rows: ValidatedRow[], mode: 'SET' | 'ADD') {
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    const productId = resolveProduct(ctx, row, true);
    if (!productId) {
      skipped += 1;
      continue;
    }

    const expiry = str(row, 'expiry_date');
    if (!expiry) {
      addIssue(ctx, row, 'Expiry date is required to create a batch');
      skipped += 1;
      continue;
    }

    // A stock statement without batch numbers still has to land somewhere; one
    // OPENING batch per product per expiry keeps FEFO working.
    const batchNumber = str(row, 'batch_number') ?? `OPENING-${expiry.replace(/-/g, '')}`;
    const quantity = num(row, 'quantity') ?? 0;
    const freeQty = num(row, 'free_qty') ?? 0;
    const totalQty = quantity + freeQty;

    const product = ctx.db.prepare('SELECT * FROM products WHERE id = ?').get(productId) as Record<string, unknown>;
    const ptr = num(row, 'ptr') ?? (product.ptr as number) ?? 0;
    const mrp = num(row, 'mrp') ?? (product.mrp as number) ?? 0;
    const selling = num(row, 'selling_price') ?? mrp ?? (product.selling_price as number) ?? 0;
    const supplierId = resolveSupplier(ctx, str(row, 'supplier_name'));

    const existing = ctx.db
      .prepare('SELECT * FROM product_batches WHERE product_id = ? AND batch_number = ?')
      .get(productId, batchNumber) as { id: number; quantity: number } | undefined;

    try {
      if (existing) {
        if (!ctx.options.updateExisting && mode === 'SET') {
          skipped += 1;
          continue;
        }

        const nextQty = mode === 'SET' ? totalQty : existing.quantity + totalQty;
        const delta = nextQty - existing.quantity;

        ctx.db
          .prepare(
            `UPDATE product_batches SET quantity = ?, expiry_date = ?, manufacturing_date = COALESCE(?, manufacturing_date),
               purchase_price = ?, selling_price = ?, mrp = ?, ptr = ?, pts = COALESCE(?, pts),
               supplier_id = COALESCE(?, supplier_id), purchase_invoice = COALESCE(?, purchase_invoice),
               source_import_job_id = ?, updated_at = datetime('now')
             WHERE id = ?`,
          )
          .run(
            nextQty, expiry, str(row, 'manufacturing_date'), ptr, selling, mrp, ptr,
            num(row, 'pts'), supplierId, str(row, 'purchase_invoice'), ctx.jobId, existing.id,
          );

        if (delta !== 0) {
          recordTransaction(ctx.db, {
            productId,
            batchId: existing.id,
            type: mode === 'SET' ? 'ADJUSTMENT' : 'STOCK_RECEIVED',
            quantity: delta,
            referenceId: ctx.jobId,
            referenceType: 'IMPORT',
            notes: mode === 'SET' ? `Opening stock set by import #${ctx.jobId}` : `Batch import #${ctx.jobId}`,
          });
        }
        updated += 1;
      } else {
        const result = ctx.db
          .prepare(
            `INSERT INTO product_batches
               (product_id, batch_number, manufacturing_date, expiry_date, quantity, purchase_price,
                selling_price, mrp, ptr, pts, free_qty, purchase_invoice, supplier_id, source_import_job_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            productId, batchNumber, str(row, 'manufacturing_date'), expiry, totalQty, ptr,
            selling, mrp, ptr, num(row, 'pts') ?? 0, freeQty, str(row, 'purchase_invoice'),
            supplierId, ctx.jobId,
          );

        const batchId = Number(result.lastInsertRowid);
        if (totalQty > 0) {
          recordTransaction(ctx.db, {
            productId,
            batchId,
            type: 'STOCK_RECEIVED',
            quantity: totalQty,
            referenceId: ctx.jobId,
            referenceType: 'IMPORT',
            notes: mode === 'SET' ? `Opening stock from import #${ctx.jobId}` : `Batch import #${ctx.jobId}`,
          });
        }

        // The stock-adjustment register is what an auditor reads, so opening
        // stock is recorded there too rather than only in the movement ledger.
        if (mode === 'SET' && totalQty > 0) {
          ctx.db
            .prepare(
              `INSERT INTO stock_adjustments
                 (adjustment_number, product_id, batch_id, user_id, adjustment_date, quantity, reason, notes)
               VALUES (?, ?, ?, ?, ?, ?, 'OPENING_STOCK', ?)`,
            )
            .run(
              nextImportDocumentNumber(ctx, 'stock_adjustments', 'adjustment_number', 'ADJ-IMP'),
              productId, batchId, ctx.userId, today(), totalQty, `Import #${ctx.jobId}`,
            );
        }
        created += 1;
      }
    } catch (err) {
      addIssue(ctx, row, `Could not save batch "${batchNumber}": ${(err as Error).message}`);
      skipped += 1;
    }
  }

  return { created, updated, skipped };
}

/* -------------------------------------------------------------------------- */
/* Distributor price list                                                      */
/* -------------------------------------------------------------------------- */

function importPriceList(ctx: Ctx, rows: ValidatedRow[]) {
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    const distributorId = resolveDistributor(ctx, row, true);
    if (!distributorId) {
      addIssue(ctx, row, 'No distributor named in this row, so the price cannot be filed against anyone');
      skipped += 1;
      continue;
    }

    // A price list must not invent products: a typo would create a phantom
    // medicine that then appears in the Replenishment Center.
    const productId = resolveProduct(ctx, row, false);
    if (!productId) {
      addIssue(
        ctx, row,
        `"${str(row, 'product_name') ?? str(row, 'product_code')}" is not in the product master - import the Product Master first`,
        'WARNING',
      );
      skipped += 1;
      continue;
    }

    // "10+1" in a single Scheme column, or separate buy/free columns.
    const combined = parseScheme(str(row, 'scheme'));
    const buyQty = num(row, 'scheme_buy_qty') ?? combined?.buy ?? 0;
    const freeQty = num(row, 'scheme_free_qty') ?? combined?.free ?? 0;

    const product = ctx.db.prepare('SELECT mrp, ptr, pts FROM products WHERE id = ?').get(productId) as {
      mrp: number; ptr: number; pts: number;
    };

    const params = {
      distributor_id: distributorId,
      product_id: productId,
      ptr: num(row, 'ptr') ?? product.ptr ?? 0,
      pts: num(row, 'pts') ?? product.pts ?? 0,
      mrp: num(row, 'mrp') ?? product.mrp ?? 0,
      scheme_buy_qty: buyQty,
      scheme_free_qty: freeQty,
      discount_pct: num(row, 'discount_pct') ?? 0,
      available_qty: num(row, 'available_qty') ?? 0,
      min_order_qty: num(row, 'min_order_qty') ?? 1,
    };

    const existing = ctx.db
      .prepare('SELECT id FROM distributor_products WHERE distributor_id = ? AND product_id = ?')
      .get(distributorId, productId) as { id: number } | undefined;

    if (existing && !ctx.options.updateExisting) {
      skipped += 1;
      continue;
    }

    try {
      ctx.db
        .prepare(
          `INSERT INTO distributor_products
             (distributor_id, product_id, ptr, pts, mrp, scheme_buy_qty, scheme_free_qty,
              discount_pct, available_qty, min_order_qty, updated_at)
           VALUES
             (@distributor_id, @product_id, @ptr, @pts, @mrp, @scheme_buy_qty, @scheme_free_qty,
              @discount_pct, @available_qty, @min_order_qty, datetime('now'))
           ON CONFLICT (distributor_id, product_id) DO UPDATE SET
             ptr = excluded.ptr, pts = excluded.pts, mrp = excluded.mrp,
             scheme_buy_qty = excluded.scheme_buy_qty, scheme_free_qty = excluded.scheme_free_qty,
             discount_pct = excluded.discount_pct, available_qty = excluded.available_qty,
             min_order_qty = excluded.min_order_qty, updated_at = datetime('now')`,
        )
        .run(params);

      if (existing) updated += 1;
      else created += 1;
    } catch (err) {
      addIssue(ctx, row, `Could not save catalogue line: ${(err as Error).message}`);
      skipped += 1;
    }
  }

  return { created, updated, skipped };
}

/* -------------------------------------------------------------------------- */
/* Purchase history                                                            */
/* -------------------------------------------------------------------------- */

/** Groups line rows into documents, preserving file order. */
function groupBy(rows: ValidatedRow[], keyOf: (row: ValidatedRow) => string): Map<string, ValidatedRow[]> {
  const groups = new Map<string, ValidatedRow[]>();
  rows.forEach((row, index) => {
    const groupKey = keyOf(row) || `__row_${index}`;
    const list = groups.get(groupKey);
    if (list) list.push(row);
    else groups.set(groupKey, [row]);
  });
  return groups;
}

function importPurchaseHistory(ctx: Ctx, rows: ValidatedRow[]) {
  let created = 0;
  let updated = 0;
  let skipped = 0;

  const groups = groupBy(rows, (row) => `${key(str(row, 'invoice_number'))}|${key(str(row, 'supplier_name'))}`);

  for (const [, lines] of groups) {
    const head = lines[0];
    const invoiceNumber = str(head, 'invoice_number');
    const supplierId = resolveSupplier(ctx, str(head, 'supplier_name'));

    if (!supplierId) {
      addIssue(ctx, head, 'No supplier named on this purchase, so it cannot be filed');
      skipped += lines.length;
      continue;
    }

    // Re-importing the same purchase file must not double the stock.
    if (invoiceNumber) {
      const seen = ctx.db
        .prepare('SELECT id FROM purchases WHERE invoice_number = ? AND supplier_id = ?')
        .get(invoiceNumber, supplierId) as { id: number } | undefined;
      if (seen) {
        addIssue(ctx, head, `Purchase invoice ${invoiceNumber} is already recorded - skipped`, 'WARNING');
        skipped += lines.length;
        continue;
      }
    }

    const purchaseDate = str(head, 'purchase_date') ?? today();

    try {
      const purchaseNumber = nextImportDocumentNumber(ctx, 'purchases', 'purchase_number', 'PUR-IMP');
      const purchaseResult = ctx.db
        .prepare(
          `INSERT INTO purchases
             (purchase_number, supplier_id, user_id, purchase_date, subtotal, tax, total,
              payment_status, notes, invoice_number, free_units)
           VALUES (?, ?, ?, ?, 0, 0, 0, 'PAID', ?, ?, 0)`,
        )
        .run(purchaseNumber, supplierId, ctx.userId, purchaseDate, `Imported from file (job #${ctx.jobId})`, invoiceNumber);

      const purchaseId = Number(purchaseResult.lastInsertRowid);
      let subtotal = 0;
      let taxTotal = 0;
      let freeUnits = 0;
      let lineCount = 0;

      for (const row of lines) {
        const productId = resolveProduct(ctx, row, true);
        if (!productId) {
          skipped += 1;
          continue;
        }

        const quantity = num(row, 'quantity') ?? 0;
        if (quantity <= 0) {
          addIssue(ctx, row, 'Purchase line has no quantity');
          skipped += 1;
          continue;
        }

        const expiry = str(row, 'expiry_date');
        const batchNumber = str(row, 'batch_number');
        if (!expiry || !batchNumber) {
          addIssue(ctx, row, 'Purchase line needs both a batch number and an expiry date');
          skipped += 1;
          continue;
        }

        const free = num(row, 'free_qty') ?? 0;
        const ptr = num(row, 'ptr') ?? 0;
        const mrp = num(row, 'mrp') ?? 0;
        const taxRate = num(row, 'tax_rate') ?? 12;
        const lineTotal = round2(quantity * ptr);
        const lineTax = round2((lineTotal * taxRate) / 100);

        // Received goods land in the batch they arrived in; an existing batch
        // is topped up rather than duplicated.
        const existingBatch = ctx.db
          .prepare('SELECT id, quantity FROM product_batches WHERE product_id = ? AND batch_number = ?')
          .get(productId, batchNumber) as { id: number; quantity: number } | undefined;

        let batchId: number;
        if (existingBatch) {
          batchId = existingBatch.id;
          ctx.db
            .prepare(
              `UPDATE product_batches SET quantity = quantity + ?, expiry_date = ?, purchase_price = ?,
                 mrp = CASE WHEN ? > 0 THEN ? ELSE mrp END, ptr = ?, supplier_id = COALESCE(supplier_id, ?),
                 purchase_invoice = COALESCE(?, purchase_invoice), updated_at = datetime('now')
               WHERE id = ?`,
            )
            .run(quantity + free, expiry, ptr, mrp, mrp, ptr, supplierId, invoiceNumber, batchId);
        } else {
          const batchResult = ctx.db
            .prepare(
              `INSERT INTO product_batches
                 (product_id, batch_number, manufacturing_date, expiry_date, quantity, purchase_price,
                  selling_price, mrp, ptr, free_qty, purchase_invoice, supplier_id, source_import_job_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              productId, batchNumber, str(row, 'manufacturing_date'), expiry, quantity + free, ptr,
              mrp || ptr, mrp, ptr, free, invoiceNumber, supplierId, ctx.jobId,
            );
          batchId = Number(batchResult.lastInsertRowid);
        }

        ctx.db
          .prepare(
            `INSERT INTO purchase_items
               (purchase_id, product_id, batch_id, batch_number, quantity, purchase_price,
                selling_price, expiry_date, tax_rate, line_total, free_qty, mrp, effective_cost)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            purchaseId, productId, batchId, batchNumber, quantity, ptr, mrp || ptr, expiry,
            taxRate, lineTotal, free, mrp,
            free > 0 ? round2((quantity * ptr) / (quantity + free)) : ptr,
          );

        recordTransaction(ctx.db, {
          productId,
          batchId,
          type: 'STOCK_RECEIVED',
          quantity: quantity + free,
          referenceId: purchaseId,
          referenceType: 'PURCHASE',
          notes: `Imported purchase ${invoiceNumber ?? purchaseNumber}`,
          date: purchaseDate,
        });

        subtotal += lineTotal;
        taxTotal += lineTax;
        freeUnits += free;
        lineCount += 1;
      }

      if (lineCount === 0) {
        // Nothing usable on the document - remove the empty head so the
        // purchase register does not fill with blank invoices.
        ctx.db.prepare('DELETE FROM purchases WHERE id = ?').run(purchaseId);
        continue;
      }

      ctx.db
        .prepare('UPDATE purchases SET subtotal = ?, tax = ?, total = ?, free_units = ? WHERE id = ?')
        .run(round2(subtotal), round2(taxTotal), round2(subtotal + taxTotal), freeUnits, purchaseId);

      created += 1;
    } catch (err) {
      addIssue(ctx, head, `Could not import purchase ${invoiceNumber ?? ''}: ${(err as Error).message}`);
      skipped += lines.length;
    }
  }

  ctx.notes.push(`${created} purchase document(s) created from ${rows.length} line(s)`);
  return { created, updated, skipped };
}

/* -------------------------------------------------------------------------- */
/* Sales history                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Imports past bills.
 *
 * Stock is deliberately NOT deducted. A sales-history file describes trade that
 * has already happened; the opening stock the pharmacy imports alongside it is
 * the position *after* those sales. Deducting again would drive the shelf
 * negative and make every reorder suggestion wrong. The bills are recorded so
 * the analytics, margins and Mini Analyst have history to work with.
 */
function importSalesHistory(ctx: Ctx, rows: ValidatedRow[]) {
  let created = 0;
  let updated = 0;
  let skipped = 0;

  const groups = groupBy(rows, (row) => key(str(row, 'invoice_number')));

  for (const [, lines] of groups) {
    const head = lines[0];
    const invoiceNumber = str(head, 'invoice_number');
    if (!invoiceNumber) {
      addIssue(ctx, head, 'Sales line has no invoice number to group it under');
      skipped += lines.length;
      continue;
    }

    const existing = ctx.db.prepare('SELECT id FROM sales WHERE invoice_number = ?').get(invoiceNumber);
    if (existing) {
      addIssue(ctx, head, `Invoice ${invoiceNumber} is already recorded - skipped`, 'WARNING');
      skipped += lines.length;
      continue;
    }

    const customerId = resolveCustomer(ctx, str(head, 'customer_name'), str(head, 'customer_phone'));
    const saleDate = str(head, 'sale_date') ?? today();
    const paymentMethod = str(head, 'payment_method') ?? 'CASH';

    try {
      const saleResult = ctx.db
        .prepare(
          `INSERT INTO sales
             (invoice_number, customer_id, user_id, sale_date, subtotal, discount, tax, total, cogs,
              payment_method, status, notes, paid_amount)
           VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0, ?, 'COMPLETED', ?, 0)`,
        )
        .run(invoiceNumber, customerId, ctx.userId, saleDate, paymentMethod, `Imported history (job #${ctx.jobId})`);

      const saleId = Number(saleResult.lastInsertRowid);
      let subtotal = 0;
      let discountTotal = 0;
      let taxTotal = 0;
      let cogsTotal = 0;
      let lineCount = 0;

      for (const row of lines) {
        const productId = resolveProduct(ctx, row, true);
        if (!productId) {
          skipped += 1;
          continue;
        }

        const quantity = num(row, 'quantity') ?? 0;
        const price = num(row, 'selling_price') ?? 0;
        if (quantity <= 0) {
          addIssue(ctx, row, 'Sales line has no quantity');
          skipped += 1;
          continue;
        }

        const product = ctx.db.prepare('SELECT ptr, purchase_price, tax_rate FROM products WHERE id = ?').get(productId) as {
          ptr: number; purchase_price: number; tax_rate: number;
        };

        const discount = num(row, 'discount') ?? 0;
        const taxRate = num(row, 'tax_rate') ?? product.tax_rate ?? 12;
        const gross = round2(quantity * price);
        const net = round2(gross - discount);
        const tax = round2((net * taxRate) / 100);
        const cost = round2(quantity * (product.ptr || product.purchase_price || 0));

        // A historical line may name a batch that no longer exists; the link is
        // recorded when it resolves and left null when it does not, rather than
        // failing the row.
        const batchNumber = str(row, 'batch_number');
        const batch = batchNumber
          ? (ctx.db
              .prepare('SELECT id FROM product_batches WHERE product_id = ? AND batch_number = ?')
              .get(productId, batchNumber) as { id: number } | undefined)
          : undefined;

        ctx.db
          .prepare(
            `INSERT INTO sale_items
               (sale_id, product_id, batch_id, quantity, selling_price, purchase_price, discount, tax, line_total)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(saleId, productId, batch?.id ?? null, quantity, price,
               product.ptr || product.purchase_price || 0, discount, tax, round2(net + tax));

        subtotal += gross;
        discountTotal += discount;
        taxTotal += tax;
        cogsTotal += cost;
        lineCount += 1;
      }

      if (lineCount === 0) {
        ctx.db.prepare('DELETE FROM sales WHERE id = ?').run(saleId);
        continue;
      }

      const total = round2(subtotal - discountTotal + taxTotal);
      ctx.db
        .prepare(
          `UPDATE sales SET subtotal = ?, discount = ?, tax = ?, total = ?, cogs = ?,
             paid_amount = CASE WHEN payment_method = 'CREDIT' THEN 0 ELSE ? END
           WHERE id = ?`,
        )
        .run(round2(subtotal), round2(discountTotal), round2(taxTotal), total, round2(cogsTotal), total, saleId);

      created += 1;
    } catch (err) {
      addIssue(ctx, head, `Could not import invoice ${invoiceNumber}: ${(err as Error).message}`);
      skipped += lines.length;
    }
  }

  ctx.notes.push(`${created} bill(s) created from ${rows.length} line(s). Stock was not deducted - see IMPORT_SYSTEM.md.`);
  return { created, updated, skipped };
}

function resolveCustomer(ctx: Ctx, name: string | null, phone: string | null): number | null {
  if (!name && !phone) return null;
  const customerName = name ?? 'Walk-in';
  const cacheKey = key(`${customerName}|${phone ?? ''}`);

  const existing = ctx.customers.get(cacheKey);
  if (existing) return existing;
  if (!ctx.options.createMissingReferences) return null;

  const code = `IMP-C${String(ctx.customers.size + 1).padStart(5, '0')}`;
  const result = ctx.db
    .prepare('INSERT INTO customers (customer_code, name, phone, customer_type) VALUES (?, ?, ?, ?)')
    .run(code, customerName, phone, phone ? 'REGULAR' : 'WALK_IN');

  const id = Number(result.lastInsertRowid);
  ctx.customers.set(cacheKey, id);
  ctx.created.customers += 1;
  return id;
}

/**
 * Document numbering for imported records.
 *
 * Deliberately not `settingsService.nextDocumentNumber`: that reads the last
 * row per call, which is O(n) writes for an import, and imported documents are
 * given their own prefix so they are distinguishable from documents the
 * pharmacy raised at the counter.
 */
function nextImportDocumentNumber(ctx: Ctx, table: string, column: string, prefix: string): string {
  const cacheKey = `${table}.${column}`;
  const counter = ctx.counters.get(cacheKey);

  if (counter === undefined) {
    const row = ctx.db
      .prepare(`SELECT ${column} AS num FROM ${table} WHERE ${column} LIKE ? ORDER BY id DESC LIMIT 1`)
      .get(`${prefix}-%`) as { num: string } | undefined;
    const last = row?.num ? Number(row.num.split('-').pop()) : 0;
    ctx.counters.set(cacheKey, Number.isFinite(last) ? last + 1 : 1);
  } else {
    ctx.counters.set(cacheKey, counter + 1);
  }

  return `${prefix}-${String(ctx.counters.get(cacheKey)).padStart(6, '0')}`;
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

export function runImport(args: {
  db: Db;
  jobId: number;
  type: ImportType;
  rows: ValidatedRow[];
  options?: ImportOptions;
  userId?: number | null;
}): ImportOutcome {
  const ctx: Ctx = {
    db: args.db,
    jobId: args.jobId,
    userId: args.userId ?? null,
    options: {
      updateExisting: args.options?.updateExisting ?? true,
      skipInvalid: args.options?.skipInvalid ?? true,
      createMissingReferences: args.options?.createMissingReferences ?? true,
    },
    issues: [],
    notes: [],
    products: new Map(),
    productsByCode: new Map(),
    manufacturers: new Map(),
    suppliers: new Map(),
    distributors: new Map(),
    distributorsByCode: new Map(),
    customers: new Map(),
    created: { manufacturers: 0, suppliers: 0, products: 0, distributors: 0, customers: 0 },
    counters: new Map(),
  };

  loadCaches(ctx);

  const importable = ctx.options.skipInvalid ? args.rows.filter((row) => row.valid) : args.rows;

  let result: { created: number; updated: number; skipped: number };
  switch (args.type) {
    case 'PRODUCT_MASTER':
      result = importProducts(ctx, importable);
      break;
    case 'MANUFACTURER_MASTER':
      result = importManufacturers(ctx, importable);
      break;
    case 'SUPPLIER_MASTER':
      result = importSuppliers(ctx, importable);
      break;
    case 'DISTRIBUTOR_MASTER':
      result = importDistributors(ctx, importable);
      break;
    case 'OPENING_STOCK':
      result = importStock(ctx, importable, 'SET');
      break;
    case 'BATCH_MASTER':
      result = importStock(ctx, importable, 'ADD');
      break;
    case 'PRICE_LIST':
      result = importPriceList(ctx, importable);
      break;
    case 'PURCHASE_HISTORY':
      result = importPurchaseHistory(ctx, importable);
      break;
    case 'SALES_HISTORY':
      result = importSalesHistory(ctx, importable);
      break;
    default:
      throw new Error(`No importer for ${args.type}`);
  }

  // Records created on the way (a manufacturer named in a product row) are
  // reported separately, so "412 created" always means 412 of the thing the
  // user chose to import.
  const side = ctx.created;
  if (args.type !== 'PRODUCT_MASTER' && side.products > 0) ctx.notes.push(`${side.products} product(s) created from names in the file`);
  if (args.type !== 'MANUFACTURER_MASTER' && side.manufacturers > 0) ctx.notes.push(`${side.manufacturers} manufacturer(s) created`);
  if (args.type !== 'SUPPLIER_MASTER' && side.suppliers > 0) ctx.notes.push(`${side.suppliers} supplier(s) created`);
  if (args.type !== 'DISTRIBUTOR_MASTER' && side.distributors > 0) ctx.notes.push(`${side.distributors} distributor(s) created`);
  if (side.customers > 0) ctx.notes.push(`${side.customers} customer(s) created`);

  return {
    created: result.created,
    updated: result.updated,
    skipped: result.skipped,
    failed: ctx.issues.filter((i) => i.severity === 'ERROR').length,
    issues: ctx.issues,
    notes: ctx.notes,
  };
}

/** Exported for the tests; `now()` keeps the import timestamp consistent. */
export const importedAt = now;
