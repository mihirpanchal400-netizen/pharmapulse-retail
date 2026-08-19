# Architecture — PharmaPulse Retail

## 1. Architectural style: Modular Monolith

PharmaPulse Retail is a **modular monolith**. One repository, one Node.js process for
the API, one React application for the UI, one SQLite file for the data.

This was a deliberate choice, not a limitation:

| Concern | Modular monolith | Microservices |
|---|---|---|
| Setup on a student laptop | `npm install` then `npm run dev` | Service discovery, containers, orchestration |
| Transactional integrity of a sale | One local ACID transaction | Distributed transactions / sagas |
| Explaining it in a viva | One diagram | Many moving parts, little added insight |
| Cost | Zero | Cloud hosting per service |

A retail pharmacy is a single-location business processing a few hundred transactions a
day. Distributed architecture would add operational complexity without solving any real
problem here. Modularity is enforced by **layering inside the process**, not by network
boundaries.

## 2. High-level diagram

```
+--------------------------------------------------------------+
|  BROWSER  -  http://localhost:5173                           |
|  React 18 + TypeScript + Vite + Tailwind CSS                 |
|  Pages -> Components -> api client (fetch) -> JWT            |
+---------------------------+----------------------------------+
                            |  JSON over HTTP (Vite proxies /api)
+---------------------------v----------------------------------+
|  API  -  http://localhost:4000  -  Express 4 + TypeScript    |
|                                                              |
|  routes/       HTTP shape only: parse, authorise, delegate   |
|  middleware/   auth (JWT), role guard, validation, errors    |
|  services/     BUSINESS LOGIC                                |
|                FEFO allocation, invoice totals, stock        |
|                movement, returns, purchases                  |
|  analytics/    READ-ONLY measurement                         |
|                sales / product / inventory / profit          |
|                + miniAnalyst rule engine                     |
|  reports/      CSV projections of analytics                  |
|  database/     connection, schema, migrations, seed          |
+---------------------------+----------------------------------+
                            |  better-sqlite3 (synchronous, in-process)
+---------------------------v----------------------------------+
|  SQLite  -  database/pharmapulse.db  -  WAL mode             |
|  14 tables - foreign keys ON - CHECK constraints             |
+--------------------------------------------------------------+
```

## 3. Layer rules

The layering is enforced by a single import rule:

> **A layer may import downward, never upward.**

```
routes     ->  services   ->  database
routes     ->  analytics  ->  database
analytics  -/->  services      (analytics never mutates state)
services   -/->  routes        (business logic knows nothing about HTTP)
```

Consequences that matter:

- **`services/` never touches `req` or `res`.** Every service function is a plain
  TypeScript function. That is why the same `createSale()` used by the POS screen is
  also callable directly from the seed generator and from the test suite.
- **`analytics/` is strictly read-only.** It issues `SELECT` statements only. An
  analytics bug can produce a wrong number; it can never corrupt inventory.
- **`routes/` contains no arithmetic.** If a route file computes a total, that logic is
  in the wrong place.

## 4. Where the money is calculated

All monetary and margin arithmetic lives in exactly two places, and everything else
reads from them:

| Concern | Single source of truth |
|---|---|
| Rounding, safe division, margin % | `server/src/utils/money.ts` |
| Net revenue / net COGS / net units SQL | `server/src/analytics/shared.ts` |

Because the dashboard, the Analytics pages, the CSV reports and the Mini Analyst all
compose the same SQL fragments from `shared.ts`, **they cannot disagree with each
other**. If the definition of revenue changes, it changes in one file.

## 5. Stock model

Two tables cooperate, with clearly separated responsibilities:

- **`product_batches.quantity` is the only source of truth for on-hand stock.**
  Current stock of a product is `SUM(quantity)` over its active, unexpired batches.
- **`inventory_transactions` is an append-only audit log.** Every movement writes a row
  explaining *why* stock changed (`STOCK_RECEIVED`, `SALE`, `RETURN`, `ADJUSTMENT`,
  `DAMAGED`, `EXPIRED`) and what document caused it.

There is no denormalised `products.stock` column. Denormalised stock is the single most
common source of drift in inventory systems: it can be updated on one code path and
forgotten on another. Summing batches is slightly more expensive and always correct.

## 6. Transaction boundaries

`better-sqlite3` is **synchronous**, which makes transactions genuinely safe: no `await`
can interleave inside a transaction and leave it half-applied.

A sale is one atomic unit of work:

```
transaction {
  allocate batches by FEFO         <- fails if insufficient / expired stock
  insert sale
  insert sale_items (one per batch consumed)
  decrement product_batches.quantity
  insert inventory_transactions
}
```

If any step throws — insufficient stock, an expired batch, a constraint violation — the
whole transaction rolls back. A sale can never partially deduct inventory.

The same pattern wraps purchases (creates batches, increments stock) and returns
(restocks batches, increments `returned_quantity`).

## 7. FEFO — First Expiry, First Out

Pharmacy stock rotation is driven by expiry, not by arrival date. The allocator in
`services/inventoryService.ts` (`allocateFefo()`):

1. Selects batches for the product with `quantity > 0` and `status = 'ACTIVE'`.
2. **Excludes any batch whose `expiry_date` is on or before today.** Expired stock is
   not sellable and is never offered by the system.
3. Sorts ascending by `expiry_date`, tie-broken by batch id.
4. Consumes greedily from the earliest expiry, splitting the line across batches when
   one batch cannot cover the quantity.
5. Throws if the requested quantity exceeds available non-expired stock.

Because one sale line may consume two or three batches, `sale_items` stores **one row
per batch consumed**, each carrying that batch's own `purchase_price`. This is what
makes COGS accurate: profit is computed against what the pharmacy actually paid for
those specific units, not against a product-level average.

## 8. Authentication and roles

- Passwords are hashed with **bcrypt** (cost 10). Plaintext passwords are never stored.
- Login returns a **JWT** signed with `JWT_SECRET` from the environment.
- The client holds the token and sends it as `Authorization: Bearer <token>`.
- `requireRole()` middleware gates routes:

| Role | Access |
|---|---|
| `ADMIN` | Everything, including Settings and user management |
| `PHARMACIST` | Sales, Inventory, Purchases, Analytics, Reports |
| `STAFF` | Sales and read-only Inventory |

**This is coursework-grade authentication, not enterprise security.** It is honest about
its scope: there is no refresh-token rotation, no rate limiting, no MFA. See the
Limitations section of the README.

## 9. Error handling

`utils/errors.ts` defines `AppError`, carrying a status code and a message that is safe
to show a pharmacist. The central error middleware then applies one rule:

- **`AppError`** — its own status code and message are returned to the client.
- **Anything else** — the technical detail is logged to the server console, and the
  client receives a generic `500` message.

Raw SQLite errors are translated by `humanizeSqliteError()`, so a
`UNIQUE constraint failed: products.product_code` becomes *"A product with this product
code already exists. Use a different code."* Stack traces and SQL text never reach the
browser.

## 10. Why SQLite

| Requirement | How SQLite satisfies it |
|---|---|
| Runs offline on a Windows laptop | Embedded — the database is a single file, no server process |
| Zero setup cost | No install, no credentials, no port |
| Real relational integrity | Foreign keys, CHECK constraints, transactions, indexes |
| Portable for demonstration | Copy `pharmapulse.db` to a USB stick; the data goes with it |
| Backup | `npm run backup` copies one file |

SQLite is genuinely suitable for a single-location retail pharmacy. If the business grew
to multiple branches needing concurrent writes from several machines, the migration path
is PostgreSQL — and because all SQL is confined to `services/` and `analytics/`, that
migration touches those folders and nothing else.

## 11. Frontend structure

```
client/src/
  services/     typed fetch wrapper; attaches JWT; unwraps errors
  components/   presentational (ui, DataTable, InsightCard)
  charts/       Recharts wrappers sharing one axis/tooltip treatment
  hooks/        useAuth (context), useCart (context), useApi, useDebounced
  layouts/      AppLayout - sidebar, drawer, top bar
  pages/        one file per screen; multi-screen areas export several
  types/        API response shapes mirrored on the client
  utils/        formatting (currency, dates, percentages)
```

State is deliberately kept simple: React Context for auth and toasts, local component
state elsewhere, and `fetch` on mount via a small `useApi` hook. No Redux, no React
Query. The data volumes here do not justify a client-side cache layer, and every extra
abstraction is one more thing to explain in a viva.

## 12. Request lifecycle — a worked example

`POST /api/sales` with two line items:

1. **`middleware/auth.ts`** verifies the JWT, attaches `req.user`.
2. **`middleware/validate.ts`** parses the body with a Zod schema. Malformed input is
   rejected with `400` before any business code runs.
3. **`routes/sales.ts`** calls `saleService.createSale(input)`.
4. **`services/saleService.ts`** opens a transaction, runs FEFO allocation, computes
   line totals / discount / tax / COGS via `utils/money.ts`, writes the sale, the items,
   the batch decrements and the inventory transactions.
5. The transaction commits; the created sale is returned.
6. **`middleware/error.ts`** would have converted any thrown `AppError` into a clean
   JSON error response.

At no point does the route file perform arithmetic, and at no point does the service
know that HTTP exists.
