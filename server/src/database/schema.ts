/**
 * PharmaPulse Retail - relational schema (SQLite).
 *
 * Exported as a string (rather than a .sql file) so the compiled `dist/` build
 * needs no extra asset-copy step.
 *
 * Money is stored as REAL (rupees). All monetary results are rounded to 2 dp by
 * `utils/money.ts` before being persisted or returned.
 *
 * Stock model:
 *   - `product_batches.quantity` is the single source of truth for on-hand stock.
 *   - `inventory_transactions` is an append-only audit log explaining every change.
 */
export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- users / auth
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('ADMIN','PHARMACIST','STAFF')),
  status        TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------------------------------- key/value app settings
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- -------------------------------------------------------------------- suppliers
CREATE TABLE IF NOT EXISTS suppliers (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_name  TEXT NOT NULL,
  contact_person TEXT,
  phone          TEXT,
  email          TEXT,
  address        TEXT,
  payment_terms  TEXT,
  status         TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- --------------------------------------------------------------------- products
CREATE TABLE IF NOT EXISTS products (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  product_code            TEXT NOT NULL UNIQUE,
  product_name            TEXT NOT NULL,
  generic_name            TEXT,
  brand_name              TEXT,
  category                TEXT NOT NULL,
  dosage_form             TEXT,
  strength                TEXT,
  pack_size               TEXT,
  manufacturer            TEXT,
  batch_tracking_enabled  INTEGER NOT NULL DEFAULT 1 CHECK (batch_tracking_enabled IN (0,1)),
  prescription_flag       INTEGER NOT NULL DEFAULT 0 CHECK (prescription_flag IN (0,1)),
  purchase_price          REAL NOT NULL DEFAULT 0 CHECK (purchase_price >= 0),
  selling_price           REAL NOT NULL DEFAULT 0 CHECK (selling_price >= 0),
  tax_rate                REAL NOT NULL DEFAULT 12 CHECK (tax_rate >= 0),
  reorder_level           INTEGER NOT NULL DEFAULT 10 CHECK (reorder_level >= 0),
  minimum_stock           INTEGER NOT NULL DEFAULT 5 CHECK (minimum_stock >= 0),
  maximum_stock           INTEGER NOT NULL DEFAULT 200 CHECK (maximum_stock >= 0),
  status                  TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_name     ON products(product_name);
CREATE INDEX IF NOT EXISTS idx_products_status   ON products(status);

-- -------------------------------------------------------------- product batches
CREATE TABLE IF NOT EXISTS product_batches (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id         INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  batch_number       TEXT NOT NULL,
  manufacturing_date TEXT,
  expiry_date        TEXT NOT NULL,
  quantity           INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  purchase_price     REAL NOT NULL DEFAULT 0 CHECK (purchase_price >= 0),
  selling_price      REAL NOT NULL DEFAULT 0 CHECK (selling_price >= 0),
  supplier_id        INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  status             TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','QUARANTINED','WRITTEN_OFF')),
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (product_id, batch_number)
);
CREATE INDEX IF NOT EXISTS idx_batches_product ON product_batches(product_id);
CREATE INDEX IF NOT EXISTS idx_batches_expiry  ON product_batches(expiry_date);

-- -------------------------------------------------------------------- customers
-- Intentionally minimal. No diagnosis, medical history or prescription records
-- are stored anywhere in this application.
CREATE TABLE IF NOT EXISTS customers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_code TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  phone         TEXT,
  customer_type TEXT NOT NULL DEFAULT 'WALK_IN' CHECK (customer_type IN ('WALK_IN','REGULAR','INSTITUTIONAL')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------------------ sales
CREATE TABLE IF NOT EXISTS sales (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_number TEXT NOT NULL UNIQUE,
  customer_id    INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  sale_date      TEXT NOT NULL,
  subtotal       REAL NOT NULL DEFAULT 0,
  discount       REAL NOT NULL DEFAULT 0,
  tax            REAL NOT NULL DEFAULT 0,
  total          REAL NOT NULL DEFAULT 0,
  cogs           REAL NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL DEFAULT 'CASH' CHECK (payment_method IN ('CASH','UPI','CARD','OTHER')),
  status         TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('COMPLETED','RETURNED','PARTIALLY_RETURNED','CANCELLED')),
  notes          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(sale_date);

CREATE TABLE IF NOT EXISTS sale_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id           INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id        INTEGER NOT NULL REFERENCES products(id),
  batch_id          INTEGER REFERENCES product_batches(id),
  quantity          INTEGER NOT NULL CHECK (quantity > 0),
  returned_quantity INTEGER NOT NULL DEFAULT 0 CHECK (returned_quantity >= 0),
  selling_price     REAL NOT NULL CHECK (selling_price >= 0),
  purchase_price    REAL NOT NULL DEFAULT 0 CHECK (purchase_price >= 0),
  discount          REAL NOT NULL DEFAULT 0,
  tax               REAL NOT NULL DEFAULT 0,
  line_total        REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale    ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_product ON sale_items(product_id);

-- -------------------------------------------------------------------- purchases
CREATE TABLE IF NOT EXISTS purchases (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_number TEXT NOT NULL UNIQUE,
  supplier_id     INTEGER NOT NULL REFERENCES suppliers(id),
  user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  purchase_date   TEXT NOT NULL,
  subtotal        REAL NOT NULL DEFAULT 0,
  tax             REAL NOT NULL DEFAULT 0,
  total           REAL NOT NULL DEFAULT 0,
  payment_status  TEXT NOT NULL DEFAULT 'PAID' CHECK (payment_status IN ('PAID','PARTIAL','UNPAID')),
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_purchases_date     ON purchases(purchase_date);
CREATE INDEX IF NOT EXISTS idx_purchases_supplier ON purchases(supplier_id);

CREATE TABLE IF NOT EXISTS purchase_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id    INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  product_id     INTEGER NOT NULL REFERENCES products(id),
  batch_id       INTEGER REFERENCES product_batches(id),
  batch_number   TEXT NOT NULL,
  quantity       INTEGER NOT NULL CHECK (quantity > 0),
  purchase_price REAL NOT NULL CHECK (purchase_price >= 0),
  selling_price  REAL NOT NULL DEFAULT 0,
  expiry_date    TEXT NOT NULL,
  tax_rate       REAL NOT NULL DEFAULT 0,
  line_total     REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase ON purchase_items(purchase_id);
CREATE INDEX IF NOT EXISTS idx_purchase_items_product  ON purchase_items(product_id);

-- --------------------------------------------------------------------- returns
CREATE TABLE IF NOT EXISTS sale_returns (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  return_number TEXT NOT NULL UNIQUE,
  sale_id       INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  return_date   TEXT NOT NULL,
  reason        TEXT NOT NULL CHECK (reason IN ('CUSTOMER_RETURN','DAMAGED','WRONG_ITEM','OTHER')),
  refund_amount REAL NOT NULL DEFAULT 0,
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sale_return_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  return_id     INTEGER NOT NULL REFERENCES sale_returns(id) ON DELETE CASCADE,
  sale_item_id  INTEGER NOT NULL REFERENCES sale_items(id),
  product_id    INTEGER NOT NULL REFERENCES products(id),
  batch_id      INTEGER REFERENCES product_batches(id),
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  refund_amount REAL NOT NULL DEFAULT 0,
  restock       INTEGER NOT NULL DEFAULT 1 CHECK (restock IN (0,1))
);

-- --------------------------------------------------------- inventory audit log
CREATE TABLE IF NOT EXISTS inventory_transactions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id       INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  batch_id         INTEGER REFERENCES product_batches(id) ON DELETE SET NULL,
  transaction_type TEXT NOT NULL CHECK (transaction_type IN
                     ('STOCK_RECEIVED','SALE','RETURN','ADJUSTMENT','DAMAGED','EXPIRED')),
  quantity         INTEGER NOT NULL,
  reference_id     INTEGER,
  reference_type   TEXT,
  notes            TEXT,
  transaction_date TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_invtx_product ON inventory_transactions(product_id);
CREATE INDEX IF NOT EXISTS idx_invtx_date    ON inventory_transactions(transaction_date);
CREATE INDEX IF NOT EXISTS idx_invtx_type    ON inventory_transactions(transaction_type);
`;
