/**
 * Schema v2 - procurement, distributor network and audit.
 *
 * Kept in a separate file from schema.ts so the original operational core stays
 * readable and the additions are reviewable as one unit.
 *
 * Everything here is ADDITIVE and IDEMPOTENT:
 *   - tables use CREATE TABLE IF NOT EXISTS
 *   - new columns on existing tables go through addColumnIfMissing()
 * An existing database therefore upgrades in place with no data loss and no
 * separate migration tool.
 *
 * Indian pharma pricing vocabulary used throughout:
 *   MRP - Maximum Retail Price, the ceiling the customer can be charged
 *   PTR - Price To Retailer, what the pharmacy pays the distributor
 *   PTS - Price To Stockist, what the distributor pays upstream
 *   HSN - tax classification code used on GST invoices
 */

export const SCHEMA_V2_SQL = `
-- ------------------------------------------------------------ manufacturers
CREATE TABLE IF NOT EXISTS manufacturers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE,
  code          TEXT,
  contact_person TEXT,
  phone         TEXT,
  email         TEXT,
  address       TEXT,
  status        TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- -------------------------------------------------------------- distributors
-- A distributor/stockist is a trading partner the pharmacy BUYS from. It is
-- kept separate from "suppliers" (the legacy goods-inward counterparty) because
-- a distributor carries a catalogue, prices, schemes and delivery terms, while
-- a supplier record is only a name on a purchase document. Existing supplier
-- rows are linked across via distributors.supplier_id.
CREATE TABLE IF NOT EXISTS distributors (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  distributor_code    TEXT NOT NULL UNIQUE,
  name                TEXT NOT NULL,
  type                TEXT NOT NULL DEFAULT 'DISTRIBUTOR'
                        CHECK (type IN ('DISTRIBUTOR','STOCKIST','SUPER_STOCKIST','MANUFACTURER')),
  contact_person      TEXT,
  phone               TEXT,
  email               TEXT,
  address             TEXT,
  area                TEXT,
  city                TEXT,
  pin_code            TEXT,
  state               TEXT,
  -- Demonstration fields. These are synthetic strings, not validated or
  -- verified registrations, and are labelled as demo data in the UI.
  gstin               TEXT,
  drug_license_no     TEXT,
  payment_terms       TEXT NOT NULL DEFAULT 'Net 30',
  credit_days         INTEGER NOT NULL DEFAULT 30 CHECK (credit_days >= 0),
  credit_limit        REAL NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
  delivery_days       INTEGER NOT NULL DEFAULT 1 CHECK (delivery_days >= 0),
  min_order_value     REAL NOT NULL DEFAULT 0 CHECK (min_order_value >= 0),
  -- Straight-line distance in km from the configured pharmacy location.
  -- Synthetic; there is no geolocation in this application.
  distance_km         REAL NOT NULL DEFAULT 0 CHECK (distance_km >= 0),
  rating              REAL NOT NULL DEFAULT 0 CHECK (rating >= 0 AND rating <= 5),
  supplier_id         INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  status              TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_distributors_city ON distributors(city);
CREATE INDEX IF NOT EXISTS idx_distributors_pin  ON distributors(pin_code);

-- --------------------------------------------------- distributor catalogues
-- What a distributor sells, at what price, with what scheme and what stock.
-- DEMO DATA: availability and price are generated locally. Nothing here comes
-- from a live distributor feed.
CREATE TABLE IF NOT EXISTS distributor_products (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  distributor_id    INTEGER NOT NULL REFERENCES distributors(id) ON DELETE CASCADE,
  product_id        INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  ptr               REAL NOT NULL DEFAULT 0 CHECK (ptr >= 0),
  pts               REAL NOT NULL DEFAULT 0 CHECK (pts >= 0),
  mrp               REAL NOT NULL DEFAULT 0 CHECK (mrp >= 0),
  -- Free-goods scheme, e.g. 10 buy / 1 free.
  scheme_buy_qty    INTEGER NOT NULL DEFAULT 0 CHECK (scheme_buy_qty >= 0),
  scheme_free_qty   INTEGER NOT NULL DEFAULT 0 CHECK (scheme_free_qty >= 0),
  discount_pct      REAL NOT NULL DEFAULT 0 CHECK (discount_pct >= 0 AND discount_pct <= 100),
  available_qty     INTEGER NOT NULL DEFAULT 0 CHECK (available_qty >= 0),
  min_order_qty     INTEGER NOT NULL DEFAULT 1 CHECK (min_order_qty >= 1),
  status            TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (distributor_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_distprod_product ON distributor_products(product_id);
CREATE INDEX IF NOT EXISTS idx_distprod_dist    ON distributor_products(distributor_id);

-- ------------------------------------------------------- purchase order head
CREATE TABLE IF NOT EXISTS purchase_orders (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  po_number          TEXT NOT NULL UNIQUE,
  distributor_id     INTEGER NOT NULL REFERENCES distributors(id),
  user_id            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  po_date            TEXT NOT NULL,
  expected_delivery  TEXT,
  payment_terms      TEXT,
  gross_amount       REAL NOT NULL DEFAULT 0,
  discount_amount    REAL NOT NULL DEFAULT 0,
  tax_amount         REAL NOT NULL DEFAULT 0,
  total_amount       REAL NOT NULL DEFAULT 0,
  free_units         INTEGER NOT NULL DEFAULT 0,
  savings_amount     REAL NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'DRAFT'
                       CHECK (status IN ('DRAFT','SENT','CONFIRMED','PARTIALLY_RECEIVED','RECEIVED','CANCELLED')),
  notes              TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_po_status ON purchase_orders(status);
CREATE INDEX IF NOT EXISTS idx_po_date   ON purchase_orders(po_date);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  po_id              INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id         INTEGER NOT NULL REFERENCES products(id),
  ordered_qty        INTEGER NOT NULL CHECK (ordered_qty > 0),
  free_qty           INTEGER NOT NULL DEFAULT 0 CHECK (free_qty >= 0),
  received_qty       INTEGER NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
  pts                REAL NOT NULL DEFAULT 0 CHECK (pts >= 0),
  ptr                REAL NOT NULL DEFAULT 0 CHECK (ptr >= 0),
  mrp                REAL NOT NULL DEFAULT 0 CHECK (mrp >= 0),
  scheme_buy_qty     INTEGER NOT NULL DEFAULT 0,
  scheme_free_qty    INTEGER NOT NULL DEFAULT 0,
  discount_pct       REAL NOT NULL DEFAULT 0,
  gst_rate           REAL NOT NULL DEFAULT 0,
  line_gross         REAL NOT NULL DEFAULT 0,
  line_discount      REAL NOT NULL DEFAULT 0,
  line_tax           REAL NOT NULL DEFAULT 0,
  line_total         REAL NOT NULL DEFAULT 0,
  -- Total paid divided by total units received, free goods included.
  effective_cost     REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_poitems_po ON purchase_order_items(po_id);

-- ---------------------------------------------------------- goods receipts
CREATE TABLE IF NOT EXISTS purchase_receipts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_number TEXT NOT NULL UNIQUE,
  po_id          INTEGER REFERENCES purchase_orders(id) ON DELETE SET NULL,
  purchase_id    INTEGER REFERENCES purchases(id) ON DELETE SET NULL,
  distributor_id INTEGER REFERENCES distributors(id),
  user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  receipt_date   TEXT NOT NULL,
  notes          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------------------------------- supplier invoices
CREATE TABLE IF NOT EXISTS supplier_invoices (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_number  TEXT NOT NULL,
  distributor_id  INTEGER NOT NULL REFERENCES distributors(id),
  po_id           INTEGER REFERENCES purchase_orders(id) ON DELETE SET NULL,
  purchase_id     INTEGER REFERENCES purchases(id) ON DELETE SET NULL,
  invoice_date    TEXT NOT NULL,
  due_date        TEXT NOT NULL,
  invoice_amount  REAL NOT NULL DEFAULT 0 CHECK (invoice_amount >= 0),
  paid_amount     REAL NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  status          TEXT NOT NULL DEFAULT 'UNPAID' CHECK (status IN ('UNPAID','PARTIAL','PAID')),
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (distributor_id, invoice_number)
);
CREATE INDEX IF NOT EXISTS idx_supinv_status ON supplier_invoices(status);
CREATE INDEX IF NOT EXISTS idx_supinv_due    ON supplier_invoices(due_date);

CREATE TABLE IF NOT EXISTS supplier_payments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_number  TEXT NOT NULL UNIQUE,
  distributor_id  INTEGER NOT NULL REFERENCES distributors(id),
  invoice_id      INTEGER REFERENCES supplier_invoices(id) ON DELETE SET NULL,
  user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  payment_date    TEXT NOT NULL,
  amount          REAL NOT NULL CHECK (amount > 0),
  method          TEXT NOT NULL DEFAULT 'BANK'
                    CHECK (method IN ('CASH','UPI','CARD','BANK','CHEQUE','OTHER')),
  reference       TEXT,
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------------------------------- customer payments
-- Credit sales create an outstanding balance; payments settle it.
CREATE TABLE IF NOT EXISTS customer_payments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_number  TEXT NOT NULL UNIQUE,
  customer_id     INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  sale_id         INTEGER REFERENCES sales(id) ON DELETE SET NULL,
  user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  payment_date    TEXT NOT NULL,
  amount          REAL NOT NULL CHECK (amount > 0),
  method          TEXT NOT NULL DEFAULT 'CASH'
                    CHECK (method IN ('CASH','UPI','CARD','BANK','CHEQUE','OTHER')),
  reference       TEXT,
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_custpay_customer ON customer_payments(customer_id);

-- --------------------------------------------------------- purchase returns
CREATE TABLE IF NOT EXISTS purchase_returns (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  return_number  TEXT NOT NULL UNIQUE,
  distributor_id INTEGER REFERENCES distributors(id),
  purchase_id    INTEGER REFERENCES purchases(id) ON DELETE SET NULL,
  user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  return_date    TEXT NOT NULL,
  reason         TEXT NOT NULL CHECK (reason IN ('EXPIRED','DAMAGED','WRONG_ITEM','EXCESS','OTHER')),
  credit_amount  REAL NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'RAISED' CHECK (status IN ('RAISED','CREDITED','REJECTED')),
  notes          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS purchase_return_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  return_id     INTEGER NOT NULL REFERENCES purchase_returns(id) ON DELETE CASCADE,
  product_id    INTEGER NOT NULL REFERENCES products(id),
  batch_id      INTEGER REFERENCES product_batches(id),
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  purchase_price REAL NOT NULL DEFAULT 0,
  credit_amount REAL NOT NULL DEFAULT 0
);

-- -------------------------------------------------------- stock adjustments
CREATE TABLE IF NOT EXISTS stock_adjustments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  adjustment_number TEXT NOT NULL UNIQUE,
  product_id      INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  batch_id        INTEGER REFERENCES product_batches(id) ON DELETE SET NULL,
  user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  adjustment_date TEXT NOT NULL,
  quantity        INTEGER NOT NULL,
  reason          TEXT NOT NULL CHECK (reason IN
                    ('OPENING_STOCK','DAMAGE','EXPIRY','THEFT','COUNT_CORRECTION','OTHER')),
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- --------------------------------------------------------------- audit trail
CREATE TABLE IF NOT EXISTS activity_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username    TEXT,
  action      TEXT NOT NULL,
  module      TEXT NOT NULL,
  record_type TEXT,
  record_id   INTEGER,
  summary     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_date   ON activity_log(created_at);
CREATE INDEX IF NOT EXISTS idx_activity_module ON activity_log(module);
`;

/**
 * Columns added to existing tables. Each is applied only when absent, so the
 * upgrade is safe to run against a populated production-shaped database.
 *
 * `defaultSql` is used to backfill sensible values for existing rows - for
 * example PTR/PTS are derived from the price data already present rather than
 * left at zero, which would otherwise make every legacy product look free.
 */
export const V2_COLUMNS: {
  table: string;
  column: string;
  definition: string;
  backfill?: string;
}[] = [
  // --- product master extensions -------------------------------------------
  { table: 'products', column: 'barcode', definition: 'TEXT' },
  { table: 'products', column: 'composition', definition: 'TEXT' },
  { table: 'products', column: 'unit', definition: "TEXT NOT NULL DEFAULT 'Strip'" },
  { table: 'products', column: 'units_per_pack', definition: 'INTEGER NOT NULL DEFAULT 1' },
  { table: 'products', column: 'mrp', definition: 'REAL NOT NULL DEFAULT 0',
    backfill: 'UPDATE products SET mrp = selling_price WHERE mrp = 0' },
  // PTR is what the pharmacy pays; the legacy purchase_price is exactly that.
  { table: 'products', column: 'ptr', definition: 'REAL NOT NULL DEFAULT 0',
    backfill: 'UPDATE products SET ptr = purchase_price WHERE ptr = 0' },
  // PTS sits below PTR - the distributor's own buying price. ~8% below PTR is a
  // plausible trade margin and gives the comparison screen something to show.
  { table: 'products', column: 'pts', definition: 'REAL NOT NULL DEFAULT 0',
    backfill: 'UPDATE products SET pts = ROUND(purchase_price * 0.92, 2) WHERE pts = 0' },
  { table: 'products', column: 'hsn_code', definition: 'TEXT',
    backfill: "UPDATE products SET hsn_code = '3004' WHERE hsn_code IS NULL" },
  { table: 'products', column: 'schedule_category', definition: "TEXT NOT NULL DEFAULT 'OTC'",
    backfill: "UPDATE products SET schedule_category = 'H' WHERE prescription_flag = 1 AND schedule_category = 'OTC'" },
  { table: 'products', column: 'lead_time_days', definition: 'INTEGER NOT NULL DEFAULT 2' },
  { table: 'products', column: 'storage_condition', definition: "TEXT NOT NULL DEFAULT 'Below 25C'" },
  { table: 'products', column: 'manufacturer_id', definition: 'INTEGER REFERENCES manufacturers(id)' },
  { table: 'products', column: 'preferred_distributor_id', definition: 'INTEGER REFERENCES distributors(id)' },

  // --- batch: carry the pricing the goods actually arrived with -------------
  { table: 'product_batches', column: 'mrp', definition: 'REAL NOT NULL DEFAULT 0',
    backfill: 'UPDATE product_batches SET mrp = selling_price WHERE mrp = 0' },
  { table: 'product_batches', column: 'ptr', definition: 'REAL NOT NULL DEFAULT 0',
    backfill: 'UPDATE product_batches SET ptr = purchase_price WHERE ptr = 0' },
  { table: 'product_batches', column: 'pts', definition: 'REAL NOT NULL DEFAULT 0' },
  { table: 'product_batches', column: 'free_qty', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'product_batches', column: 'purchase_invoice', definition: 'TEXT' },

  // --- sales: credit terms -------------------------------------------------
  { table: 'sales', column: 'paid_amount', definition: 'REAL NOT NULL DEFAULT 0',
    // Everything historic was settled at the counter; only CREDIT sales carry a balance.
    backfill: "UPDATE sales SET paid_amount = total WHERE paid_amount = 0 AND payment_method <> 'CREDIT'" },
  { table: 'sales', column: 'due_date', definition: 'TEXT' },

  // --- purchases: link to the procurement chain ----------------------------
  { table: 'purchases', column: 'distributor_id', definition: 'INTEGER REFERENCES distributors(id)' },
  { table: 'purchases', column: 'po_id', definition: 'INTEGER REFERENCES purchase_orders(id)' },
  { table: 'purchases', column: 'invoice_number', definition: 'TEXT' },
  { table: 'purchases', column: 'free_units', definition: 'INTEGER NOT NULL DEFAULT 0' },

  { table: 'purchase_items', column: 'free_qty', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'purchase_items', column: 'mrp', definition: 'REAL NOT NULL DEFAULT 0' },
  { table: 'purchase_items', column: 'pts', definition: 'REAL NOT NULL DEFAULT 0' },
  { table: 'purchase_items', column: 'scheme_buy_qty', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'purchase_items', column: 'scheme_free_qty', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'purchase_items', column: 'effective_cost', definition: 'REAL NOT NULL DEFAULT 0' },

  // --- customers: credit ---------------------------------------------------
  { table: 'customers', column: 'credit_limit', definition: 'REAL NOT NULL DEFAULT 0' },
  { table: 'customers', column: 'address', definition: 'TEXT' },
  { table: 'customers', column: 'gstin', definition: 'TEXT' },
];
