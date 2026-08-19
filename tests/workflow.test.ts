import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openDatabase, setDb, closeDb, getDb } from '../server/src/database/connection';
import { runMigrations } from '../server/src/database/migrate';
import * as products from '../server/src/services/productService';
import * as batches from '../server/src/services/batchService';
import * as inventory from '../server/src/services/inventoryService';
import * as sales from '../server/src/services/saleService';
import * as distributors from '../server/src/services/distributorService';
import * as procurement from '../server/src/services/procurementService';
import * as outstanding from '../server/src/services/outstandingService';
import { getReplenishmentPlan } from '../server/src/services/replenishmentService';
import { calculateScheme, optimiseOrderQty } from '../server/src/services/schemeService';
import { runAnalysis } from '../server/src/analytics/miniAnalyst';
import { generateReport } from '../server/src/reports';
import { listActivity } from '../server/src/services/activityService';
import { addDays, today } from '../server/src/utils/dates';

/**
 * END-TO-END PHARMACY WORKFLOW
 * ============================
 *
 * Walks the complete operating cycle on a fresh in-memory database:
 *
 *   product -> batch -> distributor -> catalogue -> scheme -> opening stock
 *   -> sell -> stock falls -> replenishment detects -> distributor recommended
 *   -> purchase order -> goods receipt -> new batch -> stock rises
 *   -> supplier invoice -> payment -> reports -> Mini Analyst
 *
 * Every step asserts the state it produced, so a regression anywhere in the
 * chain fails here rather than being discovered in the UI.
 */

let productId: number;
let distributorId: number;
let supplierId: number;
let poId: number;

beforeAll(() => {
  // Isolated in-memory database - never touches the real pharmapulse.db.
  const db = openDatabase(':memory:');
  setDb(db);
  runMigrations(db);
});

afterAll(() => closeDb());

describe('scheme engine', () => {
  it('computes the effective cost of a 10+1 scheme exactly', () => {
    const result = calculateScheme({ quantity: 100, rate: 41, schemeBuyQty: 10, schemeFreeQty: 1 });
    expect(result.freeQty).toBe(10);
    expect(result.totalUnits).toBe(110);
    expect(result.netAmount).toBe(4100);
    // 4100 / 110 = 37.2727... -> 37.27
    expect(result.effectiveCost).toBe(37.27);
  });

  it('ranks a higher rate with a scheme below a lower flat rate', () => {
    const withScheme = calculateScheme({ quantity: 100, rate: 41, schemeBuyQty: 10, schemeFreeQty: 1 });
    const flat = calculateScheme({ quantity: 100, rate: 39 });
    expect(withScheme.effectiveCost).toBeLessThan(flat.effectiveCost);
  });

  it('only pays free goods on completed scheme blocks', () => {
    // 15 units under 10+1 earns 1 free, not 1.5.
    expect(calculateScheme({ quantity: 15, rate: 10, schemeBuyQty: 10, schemeFreeQty: 1 }).freeQty).toBe(1);
  });

  it('nudges an order up to a scheme boundary only when the stretch is small', () => {
    const worthIt = optimiseOrderQty(47, 10, 1);
    expect(worthIt.adjusted).toBe(true);
    expect(worthIt.quantity).toBe(50);

    // 41 -> 50 needs 9 more units on a 10-block: too much extra stock.
    const notWorthIt = optimiseOrderQty(41, 10, 1);
    expect(notWorthIt.adjusted).toBe(false);
    expect(notWorthIt.quantity).toBe(41);
  });

  it('applies a percentage discount before computing effective cost', () => {
    const result = calculateScheme({ quantity: 100, rate: 100, discountPct: 10 });
    expect(result.discountAmount).toBe(1000);
    expect(result.effectiveCost).toBe(90);
  });
});

describe('master data', () => {
  it('creates a product with Indian pharma pricing fields', () => {
    const product = products.createProduct({
      product_code: 'TEST-0001',
      product_name: 'Pantosafe 40 mg',
      generic_name: 'Pantoprazole',
      brand_name: 'Pantosafe',
      category: 'Gastro',
      dosage_form: 'Tablet',
      strength: '40 mg',
      pack_size: '15 tablets',
      manufacturer: 'Aurex Laboratories',
      prescription_flag: true,
      purchase_price: 41,
      selling_price: 95,
      tax_rate: 12,
      reorder_level: 20,
      minimum_stock: 10,
      maximum_stock: 200,
    });
    productId = product.id;
    expect(product.product_code).toBe('TEST-0001');
    expect(product.prescription_flag).toBe(1);
  });

  it('refuses a selling price below cost', () => {
    expect(() =>
      products.createProduct({
        product_code: 'TEST-BAD',
        product_name: 'Loss Maker',
        category: 'Gastro',
        purchase_price: 100,
        selling_price: 50,
        tax_rate: 12,
        reorder_level: 5,
        minimum_stock: 1,
        maximum_stock: 50,
      }),
    ).toThrow(/below purchase price/i);
  });

  it('creates a supplier and a distributor', () => {
    const supplier = getDb()
      .prepare("INSERT INTO suppliers (supplier_name, status) VALUES ('Test Pharma Supply', 'ACTIVE')")
      .run();
    supplierId = Number(supplier.lastInsertRowid);

    const distributor = distributors.createDistributor({
      name: 'ABC Pharma Distributors',
      city: 'Pune',
      area: 'MG Road',
      pin_code: '411001',
      payment_terms: 'Net 30',
      credit_days: 30,
      delivery_days: 1,
      min_order_value: 0,
      distance_km: 4.2,
      rating: 4.5,
    });
    distributorId = distributor.id;
    expect(distributor.distributor_code).toMatch(/^DIST-/);

    getDb().prepare('UPDATE distributors SET supplier_id = ? WHERE id = ?').run(supplierId, distributorId);
  });

  it('adds the product to the distributor catalogue with a 10+1 scheme', () => {
    const entry = distributors.upsertCatalogueEntry({
      distributor_id: distributorId,
      product_id: productId,
      ptr: 41,
      pts: 38,
      mrp: 95,
      scheme_buy_qty: 10,
      scheme_free_qty: 1,
      available_qty: 500,
      min_order_qty: 10,
    });
    expect(entry.scheme_label).toBe('10+1');
    expect(entry.effective_cost).toBe(37.27);
  });
});

describe('opening stock and selling', () => {
  it('enters opening stock as a batch', () => {
    const batch = batches.createBatch({
      product_id: productId,
      batch_number: 'OPEN-001',
      expiry_date: addDays(today(), 400),
      quantity: 60,
      purchase_price: 41,
      selling_price: 95,
      supplier_id: supplierId,
    });
    expect(batch.quantity).toBe(60);
    expect(inventory.getProductStock(productId)).toBe(60);
  });

  it('dispenses by FEFO from the earliest-expiring batch', () => {
    // A second batch expiring sooner must be consumed first.
    batches.createBatch({
      product_id: productId,
      batch_number: 'NEAR-001',
      expiry_date: addDays(today(), 45),
      quantity: 10,
      purchase_price: 39,
      selling_price: 95,
      supplier_id: supplierId,
    });
    expect(inventory.getProductStock(productId)).toBe(70);

    const sale = sales.createSale({
      items: [{ product_id: productId, quantity: 6 }],
      payment_method: 'CASH',
    });

    const near = getDb()
      .prepare("SELECT quantity FROM product_batches WHERE batch_number = 'NEAR-001'")
      .get() as { quantity: number };
    const open = getDb()
      .prepare("SELECT quantity FROM product_batches WHERE batch_number = 'OPEN-001'")
      .get() as { quantity: number };

    // FEFO took all 6 from the nearer-expiry batch, none from the later one.
    expect(near.quantity).toBe(4);
    expect(open.quantity).toBe(60);
    expect(sale.items.length).toBe(1);
    expect(inventory.getProductStock(productId)).toBe(64);
  });

  it('splits a sale across batches when one cannot cover it', () => {
    const sale = sales.createSale({
      items: [{ product_id: productId, quantity: 10 }],
      payment_method: 'UPI',
    });
    // 4 remaining in NEAR-001, then 6 from OPEN-001 -> two batch lines.
    expect(sale.items.length).toBe(2);
    expect(inventory.getProductStock(productId)).toBe(54);
  });

  it('never dispenses an expired batch', () => {
    // Backdate the near batch past its expiry.
    getDb()
      .prepare("UPDATE product_batches SET expiry_date = ? WHERE batch_number = 'NEAR-001'")
      .run(addDays(today(), -1));

    const sellable = inventory.getFefoBatches(productId);
    expect(sellable.every((b) => b.batch_number !== 'NEAR-001')).toBe(true);
  });

  it('rejects a sale beyond available stock and changes nothing', () => {
    const before = inventory.getProductStock(productId);
    expect(() =>
      sales.createSale({ items: [{ product_id: productId, quantity: before + 500 }] }),
    ).toThrow();
    // The whole transaction rolled back.
    expect(inventory.getProductStock(productId)).toBe(before);
  });

  it('computes gross profit against the actual batch cost', () => {
    const rows = getDb()
      .prepare('SELECT purchase_price, selling_price, quantity FROM sale_items ORDER BY id')
      .all() as { purchase_price: number; selling_price: number; quantity: number }[];
    // Each line carries the cost of the specific batch it came from, not an average.
    expect(rows.some((r) => r.purchase_price === 39)).toBe(true);
    expect(rows.some((r) => r.purchase_price === 41)).toBe(true);
  });
});

describe('replenishment and supplier comparison', () => {
  it('detects the product once stock falls below the reorder level', () => {
    // Drain stock to just under the reorder level of 20.
    const stock = inventory.getProductStock(productId);
    sales.createSale({ items: [{ product_id: productId, quantity: stock - 15 }] });
    expect(inventory.getProductStock(productId)).toBe(15);

    const plan = getReplenishmentPlan();
    const line = plan.lines.find((l) => l.productId === productId);
    expect(line).toBeDefined();
    expect(line!.currentStock).toBe(15);
    expect(line!.suggestedQty).toBeGreaterThan(0);
  });

  it('recommends the distributor and prices it on effective cost', () => {
    const line = getReplenishmentPlan().lines.find((l) => l.productId === productId);
    expect(line!.supplier).not.toBeNull();
    expect(line!.supplier!.name).toBe('ABC Pharma Distributors');
    expect(line!.supplier!.schemeLabel).toBe('10+1');
    expect(line!.supplier!.effectiveCost).toBeLessThan(41);
  });

  it('ranks suppliers by effective cost, not headline rate', () => {
    // A second distributor: cheaper rate, no scheme. It should LOSE.
    const rival = distributors.createDistributor({ name: 'Cheap Rate Traders', city: 'Pune', delivery_days: 2 });
    distributors.upsertCatalogueEntry({
      distributor_id: rival.id,
      product_id: productId,
      ptr: 39,
      mrp: 95,
      available_qty: 500,
    });

    const comparison = distributors.compareSuppliers(productId, 100);
    expect(comparison.options.length).toBe(2);
    expect(comparison.bestOption!.distributor_name).toBe('ABC Pharma Distributors');
    // Confirms the whole point: the lower quoted rate is not the cheaper option.
    const cheapRate = comparison.options.find((o) => o.distributor_name === 'Cheap Rate Traders')!;
    expect(cheapRate.ptr).toBeLessThan(comparison.bestOption!.ptr);
    expect(cheapRate.effective_cost).toBeGreaterThan(comparison.bestOption!.effective_cost);
  });
});

describe('purchase order and goods receipt', () => {
  it('creates a purchase order priced through the scheme engine', () => {
    const po = procurement.createPurchaseOrder({
      distributor_id: distributorId,
      items: [{ product_id: productId, quantity: 100 }],
      status: 'SENT',
    });
    poId = po.id;

    expect(po.po_number).toMatch(/^PO-/);
    expect(po.status).toBe('SENT');
    expect(po.free_units).toBe(10);
    expect(Number(po.items[0].effective_cost)).toBe(37.27);
  });

  it('refuses an invalid status transition', () => {
    expect(() => procurement.updatePoStatus(poId, 'RECEIVED')).toThrow(/cannot move to/i);
  });

  it('receives goods, creating a batch and raising stock', () => {
    const before = inventory.getProductStock(productId);
    const po = procurement.getPurchaseOrder(poId);

    const receipt = procurement.receivePurchaseOrder({
      po_id: poId,
      invoice_number: 'INV/TEST/001',
      items: [
        {
          po_item_id: Number(po.items[0].id),
          received_qty: 100,
          batch_number: 'GRN-001',
          expiry_date: addDays(today(), 600),
        },
      ],
    });

    expect(receipt.status).toBe('RECEIVED');
    // 100 invoiced + 10 free under the scheme.
    expect(receipt.freeUnits).toBe(10);
    expect(inventory.getProductStock(productId)).toBe(before + 110);

    const batch = getDb()
      .prepare("SELECT quantity, purchase_price, free_qty FROM product_batches WHERE batch_number = 'GRN-001'")
      .get() as { quantity: number; purchase_price: number; free_qty: number };
    expect(batch.quantity).toBe(110);
    expect(batch.free_qty).toBe(10);
    // Free goods dilute the unit cost to the effective cost, not the invoiced rate.
    expect(batch.purchase_price).toBe(37.27);
  });

  it('records the stock movement in the audit log', () => {
    const movement = getDb()
      .prepare("SELECT * FROM inventory_transactions WHERE reference_type = 'GOODS_RECEIPT' ORDER BY id DESC LIMIT 1")
      .get() as { quantity: number; transaction_type: string };
    expect(movement.transaction_type).toBe('STOCK_RECEIVED');
    expect(movement.quantity).toBe(110);
  });
});

describe('outstanding and payment', () => {
  it('raises a supplier invoice on receipt', () => {
    const invoices = outstanding.listSupplierInvoices({});
    expect(invoices.data.length).toBe(1);
    expect(invoices.summary.totalOutstanding).toBeGreaterThan(0);
    expect(invoices.data[0].status).toBe('UNPAID');
  });

  it('applies a partial payment and leaves the invoice PARTIAL', () => {
    const invoice = outstanding.listSupplierInvoices({}).data[0];
    outstanding.recordSupplierPayment({
      distributor_id: distributorId,
      invoice_id: invoice.id,
      amount: 1000,
    });

    const after = outstanding.listSupplierInvoices({}).data[0];
    expect(after.status).toBe('PARTIAL');
    expect(after.paid_amount).toBe(1000);
    expect(after.outstanding).toBeCloseTo(invoice.invoice_amount - 1000, 2);
  });

  it('refuses a payment larger than the balance', () => {
    const invoice = outstanding.listSupplierInvoices({}).data[0];
    expect(() =>
      outstanding.recordSupplierPayment({
        distributor_id: distributorId,
        invoice_id: invoice.id,
        amount: invoice.outstanding + 5000,
      }),
    ).toThrow(/exceeds/i);
  });

  it('settles the invoice in full', () => {
    const invoice = outstanding.listSupplierInvoices({}).data[0];
    outstanding.recordSupplierPayment({
      distributor_id: distributorId,
      invoice_id: invoice.id,
      amount: invoice.outstanding,
    });
    expect(outstanding.listSupplierInvoices({}).data[0].status).toBe('PAID');
    expect(outstanding.listSupplierInvoices({}).summary.totalOutstanding).toBe(0);
  });

  it('tracks customer credit as receivable', () => {
    const customerId = Number(
      getDb()
        .prepare("INSERT INTO customers (customer_code, name, customer_type) VALUES ('C-1', 'Test Clinic', 'INSTITUTIONAL')")
        .run().lastInsertRowid,
    );

    const sale = sales.createSale({
      items: [{ product_id: productId, quantity: 5 }],
      customer_id: customerId,
      payment_method: 'CREDIT',
    });
    getDb().prepare('UPDATE sales SET paid_amount = 0, due_date = ? WHERE id = ?').run(addDays(today(), 30), sale.id);

    const dues = outstanding.listCustomerDues({});
    expect(dues.summary.totalOutstanding).toBeGreaterThan(0);

    outstanding.recordCustomerPayment({ customer_id: customerId, sale_id: sale.id, amount: sale.total });
    expect(outstanding.listCustomerDues({}).summary.totalOutstanding).toBe(0);
  });
});

describe('reporting and analytics', () => {
  it('exports a CSV with a header row', () => {
    const report = generateReport('inventory', {});
    expect(report.filename).toMatch(/^inventory-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(report.csv).toContain('Product Code');
    expect(report.rowCount).toBeGreaterThan(0);
  });

  it('runs the Mini Analyst and produces explained insights', () => {
    const report = runAnalysis();
    expect(report.insights.length).toBeGreaterThan(0);

    for (const insight of report.insights) {
      // The explainability contract: nothing is displayed without its arithmetic.
      expect(insight.reason.length).toBeGreaterThan(0);
      expect(insight.recommendation.length).toBeGreaterThan(0);
      expect(insight.evidence.length).toBeGreaterThan(0);
      expect(insight.priorityScore).toBe(Math.round(insight.impact * insight.urgency * 10) / 10);
      expect(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).toContain(insight.severity);
    }

    // Severity must be derived from the score, never assigned by hand.
    for (const insight of report.insights) {
      const expected =
        insight.priorityScore >= 70 ? 'CRITICAL'
        : insight.priorityScore >= 45 ? 'HIGH'
        : insight.priorityScore >= 25 ? 'MEDIUM'
        : 'LOW';
      expect(insight.severity).toBe(expected);
    }
  });

  it('returns identical output for identical data', () => {
    const a = runAnalysis();
    const b = runAnalysis();
    expect(a.insights.map((i) => i.id)).toEqual(b.insights.map((i) => i.id));
    expect(a.insights.map((i) => i.priorityScore)).toEqual(b.insights.map((i) => i.priorityScore));
  });

  it('writes an audit trail of the procurement actions', () => {
    const log = listActivity({ module: 'PURCHASE_ORDER' });
    expect(log.data.length).toBeGreaterThan(0);
    expect(log.data.some((row) => row.action === 'CREATE')).toBe(true);
    expect(log.data.some((row) => row.action === 'RECEIVE')).toBe(true);
  });
});

describe('data integrity', () => {
  it('has no foreign key violations after the full workflow', () => {
    const violations = getDb().prepare('PRAGMA foreign_key_check').all();
    expect(violations).toHaveLength(0);
  });

  it('keeps batch quantities consistent with the movement log', () => {
    const rows = getDb()
      .prepare(
        `SELECT b.id, b.quantity,
                COALESCE((SELECT SUM(t.quantity) FROM inventory_transactions t WHERE t.batch_id = b.id), 0) AS movement
         FROM product_batches b`,
      )
      .all() as { id: number; quantity: number; movement: number }[];

    // Current stock must equal the sum of every movement recorded against it.
    for (const row of rows) {
      expect(row.quantity).toBe(row.movement);
    }
  });

  it('never allows negative stock', () => {
    const negative = getDb().prepare('SELECT COUNT(*) AS n FROM product_batches WHERE quantity < 0').get() as { n: number };
    expect(negative.n).toBe(0);
  });
});
