# Database Schema — PharmaPulse Retail

**Engine:** SQLite 3 (via `better-sqlite3`)
**File:** `database/pharmapulse.db` (created by `npm run seed`, git-ignored)
**Pragmas:** `foreign_keys = ON`, `journal_mode = WAL`, `busy_timeout = 5000`
**Definition:** `server/src/database/schema.ts`

---

## Entity relationship overview

```
suppliers ──< purchases ──< purchase_items >── products
    │                            │                 │
    └──────< product_batches >───┘                 │
                  │  ^                             │
                  │  └─────────────────────────────┘
                  │
customers ──< sales ──< sale_items >──┘
                │           │
                │           └──< sale_return_items >── sale_returns
                └──────────────────────────────────────────┘

users ──< sales, purchases, sale_returns   (who performed the action)

inventory_transactions  ──>  products, product_batches   (append-only audit log)
```

Read as: one supplier has many purchases; one purchase has many purchase items; each
purchase item creates or tops up one product batch; each sale item consumes one batch.

---

## Tables

### `users`
Application accounts. Three demo accounts are created on first run.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `username` | TEXT | UNIQUE |
| `password_hash` | TEXT | bcrypt, cost 10 — never plaintext |
| `full_name` | TEXT | |
| `role` | TEXT | CHECK: `ADMIN` \| `PHARMACIST` \| `STAFF` |
| `status` | TEXT | CHECK: `ACTIVE` \| `INACTIVE` |
| `created_at` | TEXT | |

### `settings`
Key/value store for pharmacy profile, document prefixes and every analytics threshold.
Editing a row here changes analytics behaviour with no code change and no restart.

| Column | Type | Notes |
|---|---|---|
| `key` | TEXT PK | e.g. `deadStockDays` |
| `value` | TEXT | stored as text, coerced on read |
| `updated_at` | TEXT | |

### `suppliers`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `supplier_name` | TEXT | NOT NULL |
| `contact_person`, `phone`, `email`, `address` | TEXT | nullable |
| `payment_terms` | TEXT | e.g. "Net 30" |
| `status` | TEXT | CHECK: `ACTIVE` \| `INACTIVE` |
| `created_at`, `updated_at` | TEXT | |

### `products`
The catalogue. **Contains no stock quantity column** — see the note on stock below.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `product_code` | TEXT | UNIQUE — the pharmacy's own SKU code |
| `product_name` | TEXT | NOT NULL, indexed |
| `generic_name` | TEXT | INN name, e.g. "Paracetamol" |
| `brand_name` | TEXT | |
| `category` | TEXT | NOT NULL, indexed |
| `dosage_form` | TEXT | Tablet, Syrup, Capsule, Injection, Cream, Drops |
| `strength` | TEXT | e.g. "500 mg" |
| `pack_size` | TEXT | e.g. "10 tablets" |
| `manufacturer` | TEXT | |
| `batch_tracking_enabled` | INTEGER | 0/1 |
| `prescription_flag` | INTEGER | 0/1 — 1 means Rx-only |
| `purchase_price` | REAL | CHECK >= 0 — current/reference cost |
| `selling_price` | REAL | CHECK >= 0 — MRP |
| `tax_rate` | REAL | GST %, default 12 |
| `reorder_level` | INTEGER | triggers the reorder rule |
| `minimum_stock` | INTEGER | safety stock |
| `maximum_stock` | INTEGER | triggers the overstock rule |
| `status` | TEXT | CHECK: `ACTIVE` \| `INACTIVE` |
| `created_at`, `updated_at` | TEXT | |

Indexes: `category`, `product_name`, `status`.

### `product_batches`
**The single source of truth for on-hand stock.**

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `product_id` | INTEGER FK → products | ON DELETE CASCADE |
| `batch_number` | TEXT | UNIQUE per product |
| `manufacturing_date` | TEXT | `YYYY-MM-DD`, nullable |
| `expiry_date` | TEXT | `YYYY-MM-DD`, NOT NULL, indexed — drives FEFO |
| `quantity` | INTEGER | **CHECK >= 0** — stock can never go negative |
| `purchase_price` | REAL | what *this* batch cost — the basis of COGS |
| `selling_price` | REAL | |
| `supplier_id` | INTEGER FK → suppliers | ON DELETE SET NULL |
| `status` | TEXT | CHECK: `ACTIVE` \| `QUARANTINED` \| `WRITTEN_OFF` |

Constraint: `UNIQUE (product_id, batch_number)`.

> **Why per-batch prices?** A pharmacy buys the same product repeatedly at different
> costs. Storing the cost on the batch — and copying it onto the sale line — is what
> makes gross profit accurate rather than approximate.

### `customers`
**Deliberately minimal. No medical information is stored anywhere in this system** — no
diagnosis, no prescription, no medical history, no insurance data.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `customer_code` | TEXT | UNIQUE |
| `name` | TEXT | NOT NULL |
| `phone` | TEXT | |
| `customer_type` | TEXT | CHECK: `WALK_IN` \| `REGULAR` \| `INSTITUTIONAL` |
| `created_at` | TEXT | |

### `sales`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `invoice_number` | TEXT | UNIQUE, e.g. `INV-000123` |
| `customer_id` | INTEGER FK → customers | nullable (walk-in) |
| `user_id` | INTEGER FK → users | who billed it |
| `sale_date` | TEXT | indexed |
| `subtotal`, `discount`, `tax`, `total` | REAL | |
| `cogs` | REAL | cost of goods on this invoice — stored, not recomputed |
| `payment_method` | TEXT | CHECK: `CASH` \| `UPI` \| `CARD` \| `OTHER` |
| `status` | TEXT | CHECK: `COMPLETED` \| `RETURNED` \| `PARTIALLY_RETURNED` \| `CANCELLED` |

### `sale_items`
**One row per batch consumed.** A single line of 30 tablets split across two batches
produces two rows.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `sale_id` | INTEGER FK → sales | ON DELETE CASCADE |
| `product_id` | INTEGER FK → products | indexed |
| `batch_id` | INTEGER FK → product_batches | the batch FEFO selected |
| `quantity` | INTEGER | CHECK > 0 |
| `returned_quantity` | INTEGER | CHECK >= 0 — incremented by returns |
| `selling_price` | REAL | price at time of sale |
| `purchase_price` | REAL | **snapshot of the batch cost** |
| `discount`, `tax`, `line_total` | REAL | |

### `purchases` / `purchase_items`
Goods received from suppliers. Completing a purchase creates batches and increments
stock inside one transaction.

`purchases`: `purchase_number` (UNIQUE), `supplier_id`, `user_id`, `purchase_date`,
`subtotal`, `tax`, `total`, `payment_status` (`PAID`/`PARTIAL`/`UNPAID`).

`purchase_items`: `purchase_id`, `product_id`, `batch_id`, `batch_number`, `quantity`,
`purchase_price`, `selling_price`, `expiry_date`, `tax_rate`, `line_total`.

### `sale_returns` / `sale_return_items`
Customer returns against an existing invoice.

`sale_returns`: `return_number` (UNIQUE), `sale_id`, `user_id`, `return_date`,
`reason` (CHECK: `CUSTOMER_RETURN`/`DAMAGED`/`WRONG_ITEM`/`OTHER`), `refund_amount`.

`sale_return_items`: `return_id`, `sale_item_id`, `product_id`, `batch_id`, `quantity`,
`refund_amount`, `restock` (0/1).

`restock = 1` returns units to the original batch; `restock = 0` (damaged goods) does
not. Either way `sale_items.returned_quantity` increases, so the unit stops counting as
revenue.

### `inventory_transactions`
Append-only audit log. Every stock movement in the system writes exactly one row.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `product_id` | INTEGER FK → products | indexed |
| `batch_id` | INTEGER FK → product_batches | ON DELETE SET NULL |
| `transaction_type` | TEXT | CHECK: `STOCK_RECEIVED` \| `SALE` \| `RETURN` \| `ADJUSTMENT` \| `DAMAGED` \| `EXPIRED` |
| `quantity` | INTEGER | **signed** — positive in, negative out |
| `reference_id` | INTEGER | id of the sale / purchase / return |
| `reference_type` | TEXT | which table `reference_id` points at |
| `notes` | TEXT | |
| `transaction_date` | TEXT | indexed |

This log is what makes the system auditable: the current quantity of any batch should
equal the sum of its transactions, and that invariant is asserted in the test suite.

---

## Design decisions

### No `products.stock` column
Current stock is always `SUM(product_batches.quantity)`. A denormalised stock column is
the most common source of drift in inventory systems — it gets updated on one code path
and missed on another, and the error is silent. Summing batches costs one indexed query
and cannot be wrong.

### Money stored as REAL
Rupee amounts are stored as `REAL` and every computed amount passes through `round2()`
before it is persisted. Integer paise would be more rigorous; REAL plus disciplined
rounding is simpler to read and adequate at this scale. This is a conscious trade-off,
recorded here rather than hidden.

### Dates as ISO text
Date-only columns use `YYYY-MM-DD`, timestamps use `YYYY-MM-DD HH:MM:SS`. ISO strings
sort and compare lexicographically in SQLite, so `BETWEEN` and `>=` work correctly on
plain text with no timezone conversion anywhere.

### CHECK constraints as the last line of defence
Validation happens at the API boundary with Zod, but the database enforces it again:
`quantity >= 0`, prices `>= 0`, enums constrained. If a bug ever bypasses the service
layer, the database refuses the write rather than silently corrupting stock.

---

## Inspecting the database

```powershell
# Row counts for every table
npm run db:stats
```

Or with any SQLite browser (e.g. DB Browser for SQLite, MIT-licensed), open
`database/pharmapulse.db`.

## Backup and restore

```powershell
# Create a timestamped copy in database/backups/
npm run backup

# Restore: stop the app, then copy the backup over the live file
Copy-Item database\backups\pharmapulse-2026-08-19-1430.db database\pharmapulse.db -Force
```

WAL mode creates `pharmapulse.db-wal` and `pharmapulse.db-shm` alongside the database.
`npm run backup` uses SQLite's own online backup API, so the copy is consistent even if
the server is running.
