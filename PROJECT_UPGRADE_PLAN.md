# Project Upgrade Plan — PharmaPulse Retail v2

**From:** a working pharmacy backend with an analytics dashboard on top
**To:** a small but real Indian retail pharmacy management **and procurement** platform

---

## 1. Audit of what already exists

Inspected before any change was made.

| Area | State | Verdict |
|---|---|---|
| Framework | React 18 + TS + Vite 6 + Tailwind 3; Express 4 + TS; SQLite via better-sqlite3 | **Keep** |
| Database | 13 business tables, FK on, WAL, CHECK constraints | **Extend, do not replace** |
| Services | product, batch, inventory (FEFO), sale, purchase, supplier, customer, settings | **Reuse** |
| Analytics | sales, product, inventory, profit analyzers | **Reuse** |
| Mini Analyst | 14-rule deterministic engine, Impact × Urgency scoring, evidence trail | **Keep and extend — do not discard** |
| API | 40+ routes, JWT auth, role gates, Zod validation, central error handler | **Reuse** |
| Client | Login, Dashboard, Mini Analyst built. 15 screens are placeholders | **Build out** |
| Data | 126 products, 1,155 batches, 12,250 sales, 669 purchases | **Extend** |
| Git | 4 commits, pushed to `mihirpanchal400-netizen/pharmapulse-retail` (public) | **Continue** |

**Conclusion:** the operational spine (products, batches, FEFO, sales, purchases) is sound and
stays. What is genuinely missing is (a) the **procurement side** — distributors, catalogues,
prices, schemes, purchase orders, outstanding — and (b) **most of the user interface**.

## 2. Honest gap analysis

### Missing — procurement domain (the biggest gap)
- No distributor/stockist entity distinct from `suppliers`
- No distributor catalogue, no per-distributor price or stock
- No scheme engine (`10+1`) and therefore no **effective cost**
- No supplier comparison
- No procurement cart, no purchase orders (only immediate goods-inward)
- No supplier or customer outstanding tracking
- No purchase returns

### Missing — Indian pharma realism
- Products lack `barcode`, `composition`, `PTR`, `PTS`, `hsn_code`, `schedule_category`,
  `lead_time_days`, `storage_condition`, `unit`
- No manufacturer master, no scheme master, no payment-terms master
- No activity log / audit trail

### Missing — inventory rigour
- `inventory_transactions` exists but is not the reconstruction source for stock
- No explicit opening-stock entry workflow
- No stock adjustment screen

### Missing — interface
13 of 15 screens unbuilt: Products, Product Detail, Stock, Batches, Low Stock, Expiry,
POS, Sales History, Returns, Purchases, Suppliers, Customers, Analytics ×4, Reports, Settings

## 3. What this upgrade adds

### 3.1 Schema v2 — 15 new tables
```
manufacturers          distributors            distributor_products
supplier_prices        supplier_schemes        purchase_orders
purchase_order_items   purchase_receipts       supplier_invoices
supplier_payments      customer_payments       purchase_returns
purchase_return_items  stock_adjustments       activity_log
```
Plus 11 new columns on `products` (barcode, composition, PTR, PTS, HSN, schedule, unit,
lead time, storage, preferred distributor, pack units).

Migrations are **additive and idempotent** — `ALTER TABLE ADD COLUMN` guarded by a
`PRAGMA table_info` check, so an existing database upgrades in place without data loss.

### 3.2 The scheme engine
The single most important piece of pharma-procurement realism.

```
Scheme 10+1 on PTS ₹41:
  invoice_qty 10, free_qty 1, total received 11
  gross          = 10 × 41            = ₹410
  discount       = 410 × disc%        = ₹0
  net payable    = ₹410
  EFFECTIVE COST = 410 / 11           = ₹37.27  ← what the pharmacy actually paid per unit
```
Supported forms: `N+M` free goods, percentage discount, flat amount off, and combinations.
Effective cost is what supplier comparison ranks on — comparing on PTS alone is the classic
purchasing error this module exists to prevent.

### 3.3 Procurement workflow
```
Replenishment Center  →  Supplier Comparison  →  Procurement Cart
        →  Purchase Order (DRAFT → SENT → CONFIRMED → RECEIVED)
        →  Goods Receipt  →  Batch created  →  Inventory movement
        →  Supplier Invoice  →  Outstanding  →  Payment
```

### 3.4 Mini Analyst upgrade
Insights become **actionable procurement recommendations**, not observations. A reorder
insight now carries suggested quantity, the best distributor by effective cost, the scheme,
and an **Add to Procurement Cart** action.

## 4. Boundaries — stated explicitly

| Rule | How it is honoured |
|---|---|
| No proprietary code copied | Every line is written for this project. Retailio/Pharmarack were used only as *workflow* references from public marketing descriptions — no code, assets, APIs or data. |
| No scraped distributor data | All 28 distributors and their catalogues are generated synthetically by the seed. |
| No real order placement | "Place Order" creates a local `purchase_orders` row. The UI labels it **Simulated Purchase Order**. Nothing leaves the machine. |
| No claimed live integrations | Distributor stock/price/scheme are labelled **Demo** throughout the UI. |
| Future-proofed | Distributor data is read through a service boundary, so a legitimate distributor API could replace the local source later without touching the UI. |
| Licensing | No third-party code introduced. Dependency set unchanged — all MIT/ISC/Apache-2.0/BSD-2-Clause. |

## 5. Build order

| # | Deliverable |
|---|---|
| 1 | Schema v2 migration + product master extension |
| 2 | Scheme engine + effective-cost calculator |
| 3 | Distributor, catalogue, comparison, procurement-cart, PO, outstanding, activity-log services |
| 4 | API routes for all of the above |
| 5 | Seed v2: manufacturers, distributors, catalogues, prices, schemes, POs, invoices, payments |
| 6 | Mini Analyst: procurement-aware recommendations |
| 7 | Client: Products, Product Detail, Stock, Batches, Low Stock/Replenishment, Expiry |
| 8 | Client: POS, Sales History, Returns |
| 9 | Client: Distributor Network, Catalogue, Comparison, Cart, Purchase Orders, Suppliers, Outstanding |
| 10 | Client: Analytics ×4, Reports, Settings, Customers |
| 11 | Dashboard rebuilt as a Pharmacy Operations dashboard |
| 12 | Full-workflow test, then documentation and screenshots |

## 6. Definition of done

The end-to-end workflow in section 53 of the brief runs against the real application:
add product → batch → distributor → catalogue price → scheme → opening stock → sell →
stock falls → Replenishment Center detects → distributor recommended → cart → PO →
receive → batch created → outstanding raised → payment recorded → reports and Mini
Analyst reflect all of it.
