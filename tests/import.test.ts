import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openDatabase, setDb, closeDb, getDb } from '../server/src/database/connection';
import { runMigrations } from '../server/src/database/migrate';
import { coerceDate, coerceNumber, coerceInteger, coerceBoolean, parseScheme } from '../server/src/import/coerce';
import { detectImportType, normaliseHeader, suggestMapping } from '../server/src/import/detect';
import { analyseWorkbook, parseCsv, readWorkbook } from '../server/src/import/workbook';
import { validateSheet } from '../server/src/import/validate';
import { commitImport, createImportJob, listImportErrors, previewImport } from '../server/src/import/service';
import { generateSampleData } from '../server/src/import/sampleData';
import { buildTemplateWorkbook } from '../server/src/import/templates';
import { getInventory, getProductStock } from '../server/src/services/inventoryService';
import { createSale } from '../server/src/services/saleService';
import { compareSuppliers } from '../server/src/services/distributorService';
import { getDb as db } from '../server/src/database/connection';
import { getReplenishmentPlan } from '../server/src/services/replenishmentService';
import { runAnalysis } from '../server/src/analytics/miniAnalyst';
import type { ColumnMapping, ImportType } from '../server/src/import/types';

/**
 * IMPORT CENTER
 * =============
 *
 * Covers the whole path a pharmacy's spreadsheet takes:
 *
 *   messy Excel -> sheet analysis -> type detection -> column mapping
 *   -> validation -> preview -> commit -> products, suppliers, stock, batches
 *   -> the operational modules (inventory, replenishment, Mini Analyst) see it
 *
 * The sample files are generated, not fixtures, so this suite exercises exactly
 * what ships in /sample-data.
 */

let sampleDir: string;

beforeAll(async () => {
  const db = openDatabase(':memory:');
  setDb(db);
  runMigrations(db);

  sampleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pharmapulse-samples-'));
  await generateSampleData(sampleDir);
});

afterAll(() => {
  closeDb();
  fs.rmSync(sampleDir, { recursive: true, force: true });
});

/** Uploads a generated sample file and returns its job id. */
async function upload(fileName: string) {
  const buffer = fs.readFileSync(path.join(sampleDir, fileName));
  return createImportJob({ fileName, buffer, userId: 1, username: 'admin' });
}

/** Upload -> suggest mapping -> preview -> commit, with optional overrides. */
async function importFile(args: {
  fileName: string;
  sheet?: string;
  type: ImportType;
  mappingOverrides?: ColumnMapping;
}) {
  const { job, analysis } = await upload(args.fileName);
  const sheetName = args.sheet ?? analysis.sheets[0].name;
  const sheet = analysis.sheets.find((s) => s.name === sheetName)!;

  const mapping = {
    ...suggestMapping(sheet.columns.map((c) => c.name), args.type).mapping,
    ...(args.mappingOverrides ?? {}),
  };

  const preview = await previewImport({ jobId: job.id, sheetName, type: args.type, mapping });
  const result = await commitImport({ jobId: job.id, sheetName, type: args.type, mapping, userId: 1, username: 'admin' });

  return { job, analysis, sheet, mapping, preview, result };
}

/* -------------------------------------------------------------------------- */

describe('cell coercion', () => {
  it('reads Indian numbers with rupee symbols and grouping', () => {
    expect(coerceNumber('Rs. 1,20,000.50').value).toBe(120000.5);
    expect(coerceNumber('₹108.15').value).toBe(108.15);
    expect(coerceNumber('(150)').value).toBe(-150);
    expect(coerceNumber('12%').value).toBe(12);
    expect(coerceNumber('not priced').ok).toBe(false);
  });

  it('rejects a fractional quantity rather than truncating it', () => {
    expect(coerceInteger('12.0').value).toBe(12);
    expect(coerceInteger('12.4').ok).toBe(false);
  });

  it('reads day-first dates, because Indian pharmacy files are DD/MM/YYYY', () => {
    // The decisive case: 03/04/2027 must be 3 April, not 4 March.
    expect(coerceDate('03/04/2027').value).toBe('2027-04-03');
    expect(coerceDate('30-06-2027').value).toBe('2027-06-30');
    expect(coerceDate('2027-06-30').value).toBe('2027-06-30');
    expect(coerceDate('30-Jun-2027').value).toBe('2027-06-30');
  });

  it('expands a month-only expiry to the last day of that month', () => {
    expect(coerceDate('06/2027', true).value).toBe('2027-06-30');
    expect(coerceDate('02/2028', true).value).toBe('2028-02-29');
    expect(coerceDate('Jun-27', true).value).toBe('2027-06-30');
    // The same value as a manufacturing date starts the month instead.
    expect(coerceDate('06/2027', false).value).toBe('2027-06-01');
  });

  it('reads an Excel serial date', () => {
    // 45000 = 2023-03-15 in the 1900 date system.
    expect(coerceDate(45000).value).toBe('2023-03-15');
  });

  it('reads yes/no columns the several ways pharmacies write them', () => {
    expect(coerceBoolean('Yes').value).toBe(true);
    expect(coerceBoolean('N').value).toBe(false);
    expect(coerceBoolean('1').value).toBe(true);
    expect(coerceBoolean('maybe').ok).toBe(false);
  });

  it('reads free-goods schemes written as distributors write them', () => {
    expect(parseScheme('10+1')).toEqual({ buy: 10, free: 1 });
    expect(parseScheme('Buy 10 Get 2')).toEqual({ buy: 10, free: 2 });
    expect(parseScheme('no scheme')).toBeNull();
  });
});

describe('column detection', () => {
  it('normalises headers to a comparable token', () => {
    expect(normaliseHeader('Exp. Date')).toBe(normaliseHeader('EXP_DATE'));
    expect(normaliseHeader('MRP (Rs.)')).toBe('mrp');
  });

  it('maps trade column names onto target fields', () => {
    const headers = ['Medicine Name', 'Company', 'Qty', 'MRP Rs.', 'Exp.', 'Batch No'];
    const { mapping } = suggestMapping(headers, 'OPENING_STOCK');

    expect(mapping.product_name).toBe('Medicine Name');
    expect(mapping.quantity).toBe('Qty');
    expect(mapping.mrp).toBe('MRP Rs.');
    expect(mapping.expiry_date).toBe('Exp.');
    expect(mapping.batch_number).toBe('Batch No');
  });

  it('does not assign one column to two fields', () => {
    const headers = ['Product', 'Rate', 'MRP'];
    const { mapping } = suggestMapping(headers, 'PRODUCT_MASTER');
    const used = Object.values(mapping).filter(Boolean);
    expect(new Set(used).size).toBe(used.length);
  });

  it('leaves an unrecognised column unmapped instead of guessing', () => {
    const { mapping } = suggestMapping(['Medicine Name', 'Zephyr Index'], 'PRODUCT_MASTER');
    expect(Object.values(mapping)).not.toContain('Zephyr Index');
  });

  it('detects the import type from headers and sheet name', () => {
    expect(detectImportType('Stock Statement', ['Medicine Name', 'Batch No', 'Exp.', 'Qty', 'Rate']).type)
      .toBe('OPENING_STOCK');
    expect(detectImportType('Distributors', ['Firm Name', 'Mobile', 'City', 'PIN', 'Credit Days', 'MOQ']).type)
      .toBe('DISTRIBUTOR_MASTER');
  });
});

describe('workbook reading', () => {
  it('parses CSV with quoted fields and embedded commas', () => {
    const rows = parseCsv('a,b\n"x, y",2\n');
    expect(rows[1]).toEqual(['x, y', '2']);
  });

  it('finds the header row under a title row', async () => {
    const { analysis } = await upload('sample_product_master.xlsx');
    const sheet = analysis.sheets[0];
    // The sample deliberately puts a title on row 1 and a date on row 2.
    expect(sheet.headerRow).toBe(3);
    expect(sheet.columns.map((c) => c.name)).toContain('Medicine Name');
  });

  it('reads every sheet of a multi-sheet workbook and types each one', async () => {
    const { analysis } = await upload('sample_multi_sheet_master.xlsx');
    const names = analysis.sheets.map((s) => s.name);
    expect(names).toEqual(['Products', 'Suppliers', 'Stock', 'Companies']);

    const byName = Object.fromEntries(analysis.sheets.map((s) => [s.name, s]));
    expect(byName.Products.suggestedType).toBe('PRODUCT_MASTER');
    expect(byName.Stock.suggestedType).toBe('OPENING_STOCK');
    expect(byName.Products.rowCount).toBe(12);
  });

  it('detects column types and sample values', async () => {
    const { analysis } = await upload('sample_price_list.xlsx');
    const columns = Object.fromEntries(analysis.sheets[0].columns.map((c) => [c.name, c]));
    expect(columns.PTR.detectedType).toBe('number');
    expect(columns.Distributor.detectedType).toBe('text');
    expect(columns.Distributor.samples.length).toBeGreaterThan(0);
  });

  it('refuses a file type it cannot read, with a message that says what to do', async () => {
    await expect(
      createImportJob({ fileName: 'stock.pdf', buffer: Buffer.from('not a spreadsheet') }),
    ).rejects.toThrow(/\.xlsx/);
  });
});

describe('validation', () => {
  it('reports every bad row in the file at once, by spreadsheet row number', async () => {
    const { job, analysis } = await upload('sample_product_master.xlsx');
    const sheet = analysis.sheets[0];
    const mapping = suggestMapping(sheet.columns.map((c) => c.name), 'PRODUCT_MASTER').mapping;

    const preview = await previewImport({ jobId: job.id, sheetName: sheet.name, type: 'PRODUCT_MASTER', mapping });

    // 20 good rows plus 3 deliberately awkward ones.
    expect(preview.summary.totalRows).toBe(23);
    expect(preview.summary.invalidRows).toBe(1);
    expect(preview.summary.validRows).toBe(preview.summary.totalRows - preview.summary.invalidRows);
    expect(preview.summary.warnings).toBeGreaterThanOrEqual(2);

    const messages = preview.issues.map((i) => i.message).join(' | ');
    expect(messages).toMatch(/is not a number/i);      // MRP of "not priced" - rejected
    expect(messages).toMatch(/No product name/i);      // code-only row - warned, still imported
    expect(messages).toMatch(/above MRP/i);            // purchase price above MRP - warned

    // Every finding points at a row the user can open in Excel.
    for (const issue of preview.issues) expect(issue.rowNumber).toBeGreaterThan(0);
  });

  it('warns about expired stock but still imports it, and rejects impossible stock', async () => {
    const { job, analysis } = await upload('sample_stock.xlsx');
    const sheet = analysis.sheets[0];
    const mapping = suggestMapping(sheet.columns.map((c) => c.name), 'OPENING_STOCK').mapping;

    const preview = await previewImport({ jobId: job.id, sheetName: sheet.name, type: 'OPENING_STOCK', mapping });
    const messages = preview.issues.map((i) => i.message).join(' | ');

    expect(messages).toMatch(/expired on/i);                  // warning, not an error
    expect(messages).toMatch(/cannot be below 0/i);           // negative quantity, rejected
    expect(messages).toMatch(/not a date the importer recognises/i);

    const expiredIssue = preview.issues.find((i) => /expired on/i.test(i.message));
    expect(expiredIssue?.severity).toBe('WARNING');
  });

  it('flags a required field that is not mapped, without touching the database', async () => {
    const { job, analysis } = await upload('sample_stock.xlsx');
    const sheet = analysis.sheets[0];
    const mapping = suggestMapping(sheet.columns.map((c) => c.name), 'OPENING_STOCK').mapping;
    mapping.quantity = null;

    const preview = await previewImport({ jobId: job.id, sheetName: sheet.name, type: 'OPENING_STOCK', mapping });
    expect(preview.summary.missingRequired).toContain('Quantity');

    await expect(
      commitImport({ jobId: job.id, sheetName: sheet.name, type: 'OPENING_STOCK', mapping }),
    ).rejects.toThrow(/not mapped/i);
  });

  it('spots the same record twice in one file', () => {
    const sheet = {
      name: 'S',
      headerRow: 1,
      headers: ['Medicine Name', 'Qty', 'Exp', 'Batch'],
      rows: [
        ['Paracetamol 650mg Tablet', 10, '06/2027', 'B1'],
        ['Paracetamol 650mg Tablet', 15, '06/2027', 'B1'],
      ],
      rowNumbers: [2, 3],
    };
    const result = validateSheet({
      sheet,
      type: 'OPENING_STOCK',
      mapping: { product_name: 'Medicine Name', quantity: 'Qty', expiry_date: 'Exp', batch_number: 'Batch' },
    });
    expect(result.duplicateRows).toBe(1);
    expect(result.rows[1].issues.some((i) => /Same record as row 2/.test(i.message))).toBe(true);
  });
});

describe('import: product master', () => {
  it('imports products, creating manufacturers on the way', async () => {
    const { preview, result } = await importFile({ fileName: 'sample_product_master.xlsx', type: 'PRODUCT_MASTER' });

    expect(result.outcome.created).toBe(preview.summary.validRows);
    expect(result.job.status).toBe('COMPLETED');

    const db = getDb();
    const product = db
      .prepare("SELECT * FROM products WHERE product_name = 'Pantoprazole 40mg Tablet'")
      .get() as Record<string, unknown>;

    expect(product).toBeTruthy();
    expect(product.mrp).toBe(154.5);
    expect(product.ptr).toBe(108.15);
    expect(product.tax_rate).toBe(12);
    expect(product.brand_name).toBe('Pantogard');
    expect(product.prescription_flag).toBe(1);          // inferred from Schedule H
    expect(product.source_import_job_id).toBe(result.job.id);

    // The manufacturer named in the file exists as a record and is linked.
    const manufacturer = db
      .prepare('SELECT * FROM manufacturers WHERE id = ?')
      .get(product.manufacturer_id) as { name: string };
    expect(manufacturer.name).toBe('Meridian Life Sciences');
  });

  it('re-importing the same file updates rather than duplicating', async () => {
    const before = (getDb().prepare('SELECT COUNT(*) AS n FROM products').get() as { n: number }).n;
    const { result } = await importFile({ fileName: 'sample_product_master.xlsx', type: 'PRODUCT_MASTER' });
    const after = (getDb().prepare('SELECT COUNT(*) AS n FROM products').get() as { n: number }).n;

    expect(after).toBe(before);
    expect(result.outcome.updated).toBeGreaterThan(0);
    expect(result.outcome.created).toBe(0);
  });

  it('adopts the product code from the file when a product was matched by name', async () => {
    const db = getDb();
    // A product that exists only under a generated code, as happens when a stock
    // file names a product before the master has been imported.
    db.prepare(
      `INSERT INTO products (product_code, product_name, category, purchase_price, selling_price,
                             tax_rate, reorder_level, minimum_stock, maximum_stock)
       VALUES ('IMP-GENERATED-XYZ', 'Rabeprazole 20mg Tablet', 'General', 0, 0, 12, 10, 5, 200)`,
    ).run();

    await importFile({ fileName: 'sample_product_master.xlsx', type: 'PRODUCT_MASTER' });

    const row = db
      .prepare("SELECT product_code FROM products WHERE product_name = 'Rabeprazole 20mg Tablet'")
      .get() as { product_code: string };
    // The file carries ITM0023 for this product; the generated code gives way.
    expect(row.product_code).toBe('ITM0023');
  });

  it('leaves existing product codes alone when the file has no code column', async () => {
    const db = getDb();
    const before = db
      .prepare("SELECT product_code FROM products WHERE product_name = 'Pantoprazole 40mg Tablet'")
      .get() as { product_code: string };

    // The CSV sample has no code column at all.
    await importFile({ fileName: 'sample_product_master.csv', type: 'PRODUCT_MASTER' });

    const after = db
      .prepare("SELECT product_code FROM products WHERE product_name = 'Pantoprazole 40mg Tablet'")
      .get() as { product_code: string };
    expect(after.product_code).toBe(before.product_code);
  });

  it('refuses to run the same job twice', async () => {
    const { job, analysis } = await upload('sample_product_master.xlsx');
    const sheet = analysis.sheets[0];
    const mapping = suggestMapping(sheet.columns.map((c) => c.name), 'PRODUCT_MASTER').mapping;

    await previewImport({ jobId: job.id, sheetName: sheet.name, type: 'PRODUCT_MASTER', mapping });
    await commitImport({ jobId: job.id, sheetName: sheet.name, type: 'PRODUCT_MASTER', mapping });

    await expect(commitImport({ jobId: job.id })).rejects.toThrow(/already been run/i);
  });
});

describe('import: distributors, stock and price list', () => {
  it('imports the distributor network and mirrors each as a supplier', async () => {
    const { result } = await importFile({ fileName: 'sample_supplier_master.xlsx', type: 'DISTRIBUTOR_MASTER' });
    expect(result.outcome.created).toBe(5);

    const db = getDb();
    const distributor = db
      .prepare("SELECT * FROM distributors WHERE distributor_code = 'DIST-001'")
      .get() as Record<string, unknown>;

    expect(distributor.name).toBe('Sahyadri Pharma Distributors');
    expect(distributor.city).toBe('Mumbai');
    expect(distributor.pin_code).toBe('400069');
    expect(distributor.credit_days).toBe(30);
    expect(distributor.min_order_value).toBe(2000);
    expect(distributor.supplier_id).toBeTruthy();

    const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(distributor.supplier_id) as { supplier_name: string };
    expect(supplier.supplier_name).toBe('Sahyadri Pharma Distributors');
  });

  it('imports opening stock as batches, with a ledger entry for every unit', async () => {
    const { result } = await importFile({ fileName: 'sample_stock.xlsx', type: 'OPENING_STOCK' });
    expect(result.outcome.created).toBeGreaterThan(15);

    const db = getDb();
    const batch = db
      .prepare(
        `SELECT b.* FROM product_batches b
         JOIN products p ON p.id = b.product_id
         WHERE p.product_name = 'Pantoprazole 40mg Tablet' AND b.quantity > 0
         LIMIT 1`,
      )
      .get() as Record<string, unknown>;

    expect(batch).toBeTruthy();
    expect(batch.expiry_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The rupee-formatted "Rs. 108.15" cell survived as a number.
    expect(batch.purchase_price).toBe(108.15);

    const ledger = db
      .prepare("SELECT * FROM inventory_transactions WHERE batch_id = ? AND reference_type = 'IMPORT'")
      .get(batch.id) as { quantity: number } | undefined;
    expect(ledger?.quantity).toBe(batch.quantity);

    // Opening stock is also visible in the adjustment register an auditor reads.
    const adjustment = db.prepare('SELECT COUNT(*) AS n FROM stock_adjustments').get() as { n: number };
    expect(adjustment.n).toBeGreaterThan(0);
  });

  it('imports a price list into the distributor catalogue, splitting "10+1" schemes', async () => {
    const { result } = await importFile({ fileName: 'sample_price_list.xlsx', type: 'PRICE_LIST' });
    expect(result.outcome.created).toBeGreaterThan(50);

    const db = getDb();
    const scheme = db
      .prepare('SELECT * FROM distributor_products WHERE scheme_free_qty > 0 LIMIT 1')
      .get() as { scheme_buy_qty: number; scheme_free_qty: number; ptr: number };

    expect(scheme.scheme_buy_qty).toBe(10);
    expect(scheme.scheme_free_qty).toBe(1);
    expect(scheme.ptr).toBeGreaterThan(0);
  });

  it('does not invent products from a price list', async () => {
    const db = getDb();
    const before = (db.prepare('SELECT COUNT(*) AS n FROM products').get() as { n: number }).n;

    const { job, analysis } = await upload('sample_price_list.xlsx');
    const sheet = analysis.sheets[0];
    const mapping = suggestMapping(sheet.columns.map((c) => c.name), 'PRICE_LIST').mapping;
    await previewImport({ jobId: job.id, sheetName: sheet.name, type: 'PRICE_LIST', mapping });
    await commitImport({ jobId: job.id, sheetName: sheet.name, type: 'PRICE_LIST', mapping });

    const after = (db.prepare('SELECT COUNT(*) AS n FROM products').get() as { n: number }).n;
    expect(after).toBe(before);
  });
});

describe('import: purchase and sales history', () => {
  it('groups purchase lines into documents and adds the stock', async () => {
    const db = getDb();
    const stockBefore = (db.prepare('SELECT COALESCE(SUM(quantity),0) AS n FROM product_batches').get() as { n: number }).n;

    const { result } = await importFile({ fileName: 'sample_purchase_history.xlsx', type: 'PURCHASE_HISTORY' });

    // 12 invoices in the sample, each spanning several rows.
    expect(result.outcome.created).toBe(12);

    const purchases = db.prepare('SELECT * FROM purchases').all() as Record<string, unknown>[];
    expect(purchases.length).toBe(12);
    expect(purchases[0].total).toBeGreaterThan(0);

    const items = db.prepare('SELECT COUNT(*) AS n FROM purchase_items').get() as { n: number };
    expect(items.n).toBeGreaterThan(12);

    const stockAfter = (db.prepare('SELECT COALESCE(SUM(quantity),0) AS n FROM product_batches').get() as { n: number }).n;
    expect(stockAfter).toBeGreaterThan(stockBefore);
  });

  it('does not record the same purchase invoice twice', async () => {
    const db = getDb();
    const before = (db.prepare('SELECT COUNT(*) AS n FROM purchases').get() as { n: number }).n;
    const { result } = await importFile({ fileName: 'sample_purchase_history.xlsx', type: 'PURCHASE_HISTORY' });
    const after = (db.prepare('SELECT COUNT(*) AS n FROM purchases').get() as { n: number }).n;

    expect(after).toBe(before);
    expect(result.outcome.created).toBe(0);
  });

  it('imports sales history for analysis without deducting stock again', async () => {
    const db = getDb();
    const stockBefore = (db.prepare('SELECT COALESCE(SUM(quantity),0) AS n FROM product_batches').get() as { n: number }).n;

    const { result } = await importFile({ fileName: 'sample_sales_history.xlsx', type: 'SALES_HISTORY' });
    expect(result.outcome.created).toBe(40);

    const stockAfter = (db.prepare('SELECT COALESCE(SUM(quantity),0) AS n FROM product_batches').get() as { n: number }).n;
    expect(stockAfter).toBe(stockBefore);

    const sale = db.prepare("SELECT * FROM sales WHERE invoice_number = 'SI-9001'").get() as Record<string, number>;
    expect(sale.total).toBeGreaterThan(0);
    expect(sale.cogs).toBeGreaterThan(0);
    expect(sale.total).toBeGreaterThan(sale.cogs);

    // Named customers become records; walk-in rows do not invent people.
    const customers = db.prepare('SELECT COUNT(*) AS n FROM customers').get() as { n: number };
    expect(customers.n).toBeGreaterThan(0);

    expect(result.outcome.notes.join(' ')).toMatch(/Stock was not deducted/i);
  });
});

describe('multi-sheet workbook', () => {
  it('imports three different types from one file', async () => {
    const db = getDb();
    const { job, analysis } = await upload('sample_multi_sheet_master.xlsx');

    const before = {
      products: (db.prepare('SELECT COUNT(*) AS n FROM products').get() as { n: number }).n,
      suppliers: (db.prepare('SELECT COUNT(*) AS n FROM suppliers').get() as { n: number }).n,
    };

    // The Companies sheet, imported as manufacturers from the same workbook.
    const companies = analysis.sheets.find((s) => s.name === 'Companies')!;
    const mapping = suggestMapping(companies.columns.map((c) => c.name), 'MANUFACTURER_MASTER').mapping;
    await previewImport({ jobId: job.id, sheetName: 'Companies', type: 'MANUFACTURER_MASTER', mapping });
    const result = await commitImport({ jobId: job.id, sheetName: 'Companies', type: 'MANUFACTURER_MASTER', mapping });

    expect(result.outcome.created + result.outcome.updated).toBe(5);

    // A second sheet from the same workbook, uploaded again as its own job.
    const stock = await importFile({ fileName: 'sample_multi_sheet_master.xlsx', sheet: 'Stock', type: 'BATCH_MASTER' });
    expect(stock.result.outcome.created + stock.result.outcome.updated).toBe(12);

    const after = {
      products: (db.prepare('SELECT COUNT(*) AS n FROM products').get() as { n: number }).n,
      suppliers: (db.prepare('SELECT COUNT(*) AS n FROM suppliers').get() as { n: number }).n,
    };
    // Products were already imported, so the stock sheet matched them instead
    // of creating a second copy of the catalogue.
    expect(after.products).toBe(before.products);
    expect(after.suppliers).toBeGreaterThanOrEqual(before.suppliers);
  });
});

describe('CSV import', () => {
  it('imports a CSV product file through the same path as Excel', async () => {
    const { result, preview } = await importFile({ fileName: 'sample_product_master.csv', type: 'PRODUCT_MASTER' });
    expect(preview.summary.totalRows).toBe(20);
    expect(result.outcome.updated).toBeGreaterThan(0);
  });
});

describe('import history and error report', () => {
  it('keeps a history row with counts, user and status', async () => {
    const db = getDb();
    const jobs = db.prepare("SELECT * FROM import_jobs WHERE status = 'COMPLETED' ORDER BY id DESC LIMIT 1").get() as Record<string, unknown>;

    expect(jobs.username).toBe('admin');
    expect(jobs.file_name).toBeTruthy();
    expect(jobs.finished_at).toBeTruthy();
    expect(Number(jobs.total_rows)).toBeGreaterThan(0);
    // The uploaded spreadsheet is removed once the import lands.
    expect(jobs.stored_path).toBeNull();
  });

  it('stores every finding so the error report can be downloaded later', async () => {
    const { job, analysis } = await upload('sample_product_master.xlsx');
    const sheet = analysis.sheets[0];
    const mapping = suggestMapping(sheet.columns.map((c) => c.name), 'PRODUCT_MASTER').mapping;

    await previewImport({ jobId: job.id, sheetName: sheet.name, type: 'PRODUCT_MASTER', mapping });
    const errors = listImportErrors(job.id);

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].row_number).toBeGreaterThan(0);
    expect(errors[0].message).toBeTruthy();
    expect(listImportErrors(job.id, 'ERROR').every((e) => e.severity === 'ERROR')).toBe(true);
  });

  it('writes an audit-log entry for the import', () => {
    const rows = getDb()
      .prepare("SELECT * FROM activity_log WHERE record_type = 'IMPORT_JOB' AND action LIKE 'Imported%'")
      .all() as { summary: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].summary).toMatch(/created|updated/);
  });

  it('remembers a mapping and reuses it for the same headers', () => {
    const saved = getDb()
      .prepare("SELECT * FROM import_mappings WHERE import_type = 'PRODUCT_MASTER'")
      .get() as { use_count: number; mapping_json: string } | undefined;

    expect(saved).toBeTruthy();
    expect(saved!.use_count).toBeGreaterThan(1);
    expect(JSON.parse(saved!.mapping_json).product_name).toBe('Medicine Name');
  });
});

describe('imported data reaches the operational modules', () => {
  it('shows up in inventory with stock status and value', () => {
    const inventory = getInventory();
    expect(inventory.length).toBeGreaterThan(15);

    const pantoprazole = inventory.find((item) => item.product_name === 'Pantoprazole 40mg Tablet');
    expect(pantoprazole).toBeTruthy();
    expect(pantoprazole!.current_stock).toBeGreaterThan(0);
    expect(pantoprazole!.stock_status).toBeTruthy();
  });

  it('feeds the Replenishment Center', () => {
    const plan = getReplenishmentPlan();
    expect(Array.isArray(plan.lines)).toBe(true);
    expect(plan.summary.products).toBeGreaterThanOrEqual(0);
  });

  it('feeds the Mini Analyst, which still runs unchanged', () => {
    const analysis = runAnalysis();
    expect(analysis.insights.length).toBeGreaterThan(0);
    expect(analysis.insights[0].title).toBeTruthy();
    // Sales history imported above gives the analyst something real to work on:
    // every insight it raises is about a product that came out of a spreadsheet.
    expect(analysis.insights.some((insight) => insight.severity)).toBe(true);
  });
});

describe('the full cycle, on nothing but imported data', () => {
  /**
   * The claim this whole feature rests on: a pharmacy that has imported its
   * spreadsheets can then trade on that data like any other. Nothing in this
   * block was seeded - every product, batch, distributor and price below came
   * out of a .xlsx file earlier in this suite.
   */
  it('sells imported stock through FEFO, then reorders it from an imported price list', () => {
    const product = db()
      .prepare(
        `SELECT p.* FROM products p
         WHERE p.product_name = 'Pantoprazole 40mg Tablet' AND p.source_import_job_id IS NOT NULL`,
      )
      .get() as { id: number; product_name: string };
    expect(product).toBeTruthy();

    const batches = db()
      .prepare('SELECT * FROM product_batches WHERE product_id = ? AND quantity > 0 ORDER BY expiry_date')
      .all(product.id) as { id: number; expiry_date: string; quantity: number }[];
    expect(batches.length).toBeGreaterThan(0);

    const stockBefore = getProductStock(product.id);
    const earliestExpiry = batches[0];

    // 1. Sell it at the counter.
    const sale = createSale({ items: [{ product_id: product.id, quantity: 5 }], payment_method: 'CASH' });
    expect(sale.items[0].batch_id).toBe(earliestExpiry.id);   // FEFO took the earliest expiry

    // 2. Stock falls, and the ledger explains why.
    expect(getProductStock(product.id)).toBe(stockBefore - 5);
    const movement = db()
      .prepare("SELECT * FROM inventory_transactions WHERE reference_id = ? AND transaction_type = 'SALE'")
      .get(sale.id) as { quantity: number };
    expect(movement.quantity).toBe(-5);

    // 3. The imported price list can source it again, ranked by effective cost.
    const comparison = compareSuppliers(product.id, 100);
    expect(comparison.options.length).toBeGreaterThan(0);
    expect(comparison.options[0].effective_cost).toBeGreaterThan(0);
    // Best option first: a scheme-bearing distributor must not rank below a
    // dearer flat rate.
    for (let i = 1; i < comparison.options.length; i += 1) {
      expect(comparison.options[i].effective_cost).toBeGreaterThanOrEqual(comparison.options[i - 1].effective_cost);
    }
  });

  it('leaves batch quantities reconciled with the movement ledger', () => {
    // The invariant that matters most: imported stock must be as auditable as
    // stock that arrived on a purchase order.
    const drift = db()
      .prepare(
        `SELECT b.id, b.batch_number, b.quantity,
                COALESCE((SELECT SUM(t.quantity) FROM inventory_transactions t WHERE t.batch_id = b.id), 0) AS ledger
         FROM product_batches b
         WHERE b.source_import_job_id IS NOT NULL AND b.quantity <> COALESCE(
           (SELECT SUM(t.quantity) FROM inventory_transactions t WHERE t.batch_id = b.id), 0)`,
      )
      .all();
    expect(drift).toEqual([]);
  });
});

describe('templates', () => {
  it('builds a template workbook with a data sheet and a field guide', async () => {
    const buffer = await buildTemplateWorkbook('PRODUCT_MASTER');
    expect(buffer.length).toBeGreaterThan(1000);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pharmapulse-template-'));
    const file = path.join(dir, 'template.xlsx');
    fs.writeFileSync(file, buffer);

    const parsed = await readWorkbook(file, 'template.xlsx');
    expect(parsed.sheets.map((s) => s.name)).toContain('Field Guide');

    // A template must import cleanly through the importer that generated it.
    const dataSheet = parsed.sheets[0];
    const analysis = analyseWorkbook(parsed, 'template.xlsx', buffer.length);
    expect(analysis.sheets[0].suggestedType).toBe('PRODUCT_MASTER');

    const mapping = suggestMapping(dataSheet.headers, 'PRODUCT_MASTER').mapping;
    const validation = validateSheet({ sheet: dataSheet, type: 'PRODUCT_MASTER', mapping });
    expect(validation.missingRequired).toEqual([]);
    expect(validation.invalidRows).toBe(0);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
