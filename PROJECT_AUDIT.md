# PROJECT AUDIT — PharmaPulse Retail

**Audit date:** 20 August 2026
**Repository:** `mihirpanchal400-netizen/pharmapulse-retail` (branch `main`, clean working tree)
**Audited commit:** `931e80f` — *Build out the remaining screens; no placeholders left*

This document records what the project contained **before** the Import Center
work, so later changes can be judged against a known starting point. It is a
snapshot first and a plan second.

---

## 1. Current architecture

| Layer | Technology | Notes |
|---|---|---|
| Runtime | Node.js >= 20 | npm workspaces monorepo (`server`, `client`) |
| API | Express 4 + TypeScript (CommonJS) | `server/src/app.ts` builds the app; `index.ts` binds the port |
| Database | SQLite via `better-sqlite3` | Single local file `database/pharmapulse.db`, WAL mode |
| Validation | Zod at the route boundary | `middleware/validate.ts` — services can trust their inputs |
| Auth | JWT bearer + bcryptjs | `requireAuth` mounted once for everything under `/api` |
| Client | React 18 + Vite 6 + TypeScript | Tailwind 3, `lucide-react` icons, `recharts` charts |
| Routing | react-router-dom 6 | A single authentication gate in `App.tsx` |
| Tests | Vitest + Supertest | `tests/workflow.test.ts`, 34 tests |

Nothing in the stack requires Docker, WSL, a cloud service or a paid API. The
whole application runs from `npm run dev` on Windows.

**Baseline health at audit time:** `npm run typecheck` clean, `npm test` 34/34
passing, `npm run build` produces `server/dist` and `client/dist`.

---

## 2. Current features — what already exists and works

### Operational core

- **Product master** — CRUD, categories, manufacturers, search, detail page with batches.
- **Batches** — batch numbers, manufacturing/expiry dates, per-batch price and quantity, expiry bucketing (expired, 30/60/90 days, safe), write-off of expired stock.
- **Inventory** — stock aggregation per product, stock-status classification, movement ledger (`inventory_transactions`), manual adjustments with reasons.
- **FEFO allocation** — `inventoryService.allocateFefo()` sorts valid batches by earliest expiry and skips expired stock; used by the POS sale path.
- **POS / sales** — product search, cart, batch-aware selling, discount, tax, cash/UPI/card/credit, invoice numbering, invoice view.
- **Sales returns and purchase returns** — batch-level, with inventory and ledger effects.
- **Purchases and purchase orders** — lifecycle `DRAFT -> SENT -> CONFIRMED -> PARTIALLY_RECEIVED -> RECEIVED -> CANCELLED`, goods receipt creating batches.
- **Distributor network** — distributors with area/city/PIN, credit terms, delivery days, MOQ, synthetic distance; catalogues with PTR/PTS/MRP, schemes and availability, labelled as demo data.
- **Supplier comparison** — effective-cost maths including free-goods schemes.
- **Procurement cart** — cross-supplier cart with scheme, discount, GST and savings calculations.
- **Replenishment Center** — coverage-days driven reorder suggestions with a preferred supplier and price.
- **Ledgers** — supplier outstanding and customer outstanding, with payments.
- **Reports** — CSV export of the major registers via `/api/reports`.
- **Settings** — pharmacy profile, tax, inventory, reorder and expiry configuration.
- **Audit trail** — `activity_log` plus `activityService.logActivity()`, which never throws.
- **Backup** — `npm run backup` writes a timestamped copy into `database/backups/`.

### Mini Analyst — present, kept, not rewritten

`server/src/analytics/miniAnalyst.ts` with four analyzers (`salesAnalyzer`,
`productAnalyzer`, `inventoryAnalyzer`, `profitAnalyzer`) and a shared helper
module, surfaced by `client/src/pages/MiniAnalyst.tsx` and the four
`/analytics/*` screens. It is a deterministic rule engine over the operational
tables — no external AI service, no paid API.

**This module is treated as protected: not rebuilt, only fed more data.**

---

## 3. Existing routes

### API (`server/src/routes/`)

| Mount | File | Covers |
|---|---|---|
| `/api/health`, `/api/public/profile` | `app.ts` | liveness, login branding (unauthenticated) |
| `/api/auth` | `auth.ts` | login, session |
| `/api` | `catalog.ts` | products, suppliers, customers, categories |
| `/api/inventory` | `inventory.ts` | stock, batches, expiry, adjustments, transactions |
| `/api` | `transactions.ts` | sales, returns, purchases |
| `/api/analytics` | `analytics.ts` | Mini Analyst and the four analytics views |
| `/api/reports` | `reports.ts` | report list, JSON and CSV download |
| `/api/settings` | `settings.ts` | pharmacy profile and configuration |
| `/api/procurement` | `procurement.ts` | distributors, catalogues, comparison, cart, POs, outstanding, purchase returns |

### Client (`client/src/App.tsx`)

Dashboard, Mini Analyst, `/sales` (plus new sale, returns, invoice),
`/inventory` (stock, products, batches, expiry), `/procurement`
(replenishment, compare, cart, distributors, orders, outstanding, returns),
`/customers`, `/analytics` (sales, products, inventory, profit), `/reports`,
`/settings`. Legacy `/purchases*` paths redirect into the procurement section.

---

## 4. Existing database

**Schema v1** (`database/schema.ts`) — `users`, `settings`, `suppliers`,
`products`, `product_batches`, `customers`, `sales`, `sale_items`, `purchases`,
`purchase_items`, `sale_returns`, `sale_return_items`,
`inventory_transactions`.

**Schema v2** (`database/schemaV2.ts`) — `manufacturers`, `distributors`,
`distributor_products`, `purchase_orders`, `purchase_order_items`,
`purchase_receipts`, `supplier_invoices`, `supplier_payments`,
`customer_payments`, `purchase_returns`, `purchase_return_items`,
`stock_adjustments`, `activity_log`, plus 33 additive columns on v1 tables
(MRP/PTR/PTS, HSN, schedule category, composition, barcode, credit fields).

Migrations run on every server start and are idempotent and additive
(`CREATE TABLE IF NOT EXISTS` plus `addColumnIfMissing`), so a populated
database upgrades in place. One guarded table rebuild widens the
`sales.payment_method` CHECK constraint to allow `CREDIT`.

`product_batches.quantity` is the single source of truth for stock;
`inventory_transactions` is the append-only explanation of every change.

---

## 5. Existing components

`components/ui.tsx` (PageHeader, Card, KpiCard, badges, empty/error/loading
states, SegmentedControl), `components/DataTable.tsx` (table shell plus
SearchInput, Select and Pagination), `components/InsightCard.tsx`,
`charts/index.tsx`, `layouts/AppLayout.tsx` (role-aware sidebar), hooks
`useApi`, `useAuth`, `useCart`, `services/api.ts` (typed fetch and CSV
download), `utils/format.ts` (rupee, date and percent formatting for `en-IN`).

---

## 6. Existing Excel functionality

**None.** This is the single largest gap in the project.

- No spreadsheet dependency in either workspace.
- No upload endpoint anywhere in the API.
- No import tables, no job tracking, no error reporting.
- No `/sample-data` directory.
- Data movement exists in one direction only: `utils/csv.ts` writes CSV for reports.

Everything currently in the database arrives through the synthetic seed
generators (`seed.ts`, `seedV2.ts`) or the UI forms. A pharmacy cannot bring
its own product master, supplier list or opening stock into the system at all.

---

## 7. Existing dependencies

**Server:** `bcryptjs`, `better-sqlite3`, `cors`, `dotenv`, `express`,
`jsonwebtoken`, `zod`. Dev: `tsx`, `typescript`, `vitest`, `supertest`, types.

**Client:** `react`, `react-dom`, `react-router-dom`, `recharts`,
`lucide-react`. Dev: `vite`, `@vitejs/plugin-react`, `tailwindcss`, `postcss`,
`autoprefixer`, `typescript`, types.

**Root:** `concurrently`.

All are MIT or Apache-2.0 and already recorded in `THIRD_PARTY_LICENSES.md`.

---

## 8. Existing bugs and defects found

| # | Severity | Finding |
|---|---|---|
| 1 | Low | `client/src/pages/ComingSoon.tsx` is dead code — exported but referenced by nothing since every screen was built out. |
| 2 | Informational | `PROJECT_PLAN.md` and `PROJECT_UPGRADE_PLAN.md` both describe completed phases and are now historical rather than current. |

Checked and found clean: `client/dist/`, `server/dist/`, the working database
and `database/backups/` all exist on disk but are already covered by
`.gitignore` and none of them is tracked.

No functional defects were found: the API, the workflow test and the build all
pass at the audited commit.

---

## 9. Duplicate features

Actively checked for, and the codebase is clean on this point:

- **One** product module (`productService` plus `Products.tsx`).
- **One** inventory module; low-stock deliberately redirects to the Replenishment Center rather than duplicating it.
- **One** dashboard; **one** Mini Analyst.
- `suppliers` and `distributors` are **not** duplicates. A supplier is the counterparty named on a goods-inward document; a distributor carries a catalogue, prices, schemes and delivery terms. They are joined through `distributors.supplier_id`.
- `schema.ts` and `schemaV2.ts` are a base plus an additive migration, not two competing schemas.

**Conclusion: no consolidation work is required.** The only deletion warranted
is the unused `ComingSoon.tsx`.

---

## 10. Missing features

Ranked by value to a real Indian retail pharmacy:

1. **Excel / CSV Import Center** — multi-sheet inspection, smart column detection, manual mapping, preview, validation, error report, import history, predefined import types. *Nothing exists today.*
2. **Sample Excel files** demonstrating the importer (`/sample-data`).
3. **Import history surfaced as a report**, and audit-log entries for every import.
4. **Mini Analyst fed by imported data** rather than only by the seed.

---

## 11. Recommended upgrade path

| Phase | Work | Status after this pass |
|---|---|---|
| 0 | Audit the existing project | this document |
| 1 | Resolve duplication | none found; remove dead `ComingSoon.tsx` |
| 2 | **Import Center** — schema v3 (`import_jobs`, `import_errors`, `import_mappings`), ExcelJS reader, smart detection, mapping, preview, validation, commit, history, error report, templates | the main build |
| 3-12 | Product master, suppliers/distributors, inventory/batch, purchase, POS, procurement cart, comparison, replenishment, returns, ledgers, reports | **already implemented — reused, not rebuilt** |
| 13 | Connect Mini Analyst | already reads the operational tables; imported data flows in with no analyst changes |
| 14 | Testing | extend `tests/` with an import suite and an import-to-reorder workflow test |
| 15 | UI polish | Import Center screens built in the existing dense-table idiom |
| 16 | Documentation | `IMPORT_SYSTEM.md`, `COMMERCIALIZATION_CONSIDERATIONS.md`, README and licence updates |

The decisive finding of this audit is that phases 3-12 of the original plan are
**already done and working**. Effort belongs almost entirely in phase 2.
