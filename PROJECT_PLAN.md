# Project Plan — PharmaPulse Retail

**Retail Pharmacy Management & Mini Business Analytics Platform**

Author: Mihir Panchal · MBA (Pharmaceutical Management)
Repository: https://github.com/mihirpanchal400-netizen/pharmapulse-retail

---

## 1. Problem statement

A retail pharmacy generates a large amount of transactional data — every sale, every
purchase, every batch — and almost none of it is converted into a decision. The
pharmacist knows what was sold today but usually cannot answer:

- Which products will run out this week, and what revenue does that put at risk?
- How much stock will expire in 90 days, and what is it worth?
- How much working capital is trapped in stock that has not sold in three months?
- Is gross margin improving or eroding, and in which categories?

Commercial pharmacy software addresses billing well but treats analytics as reporting —
tables of numbers the user must interpret. The gap this project targets is the step
**after** reporting: turning measurement into a ranked, explained list of actions.

## 2. Objective

Build a working, offline-first retail pharmacy management system with a real relational
database, and add a **Mini Analyst** — a deterministic rule engine that reads the live
transactional data and produces prioritised, fully explained business insights.

## 3. Scope

### In scope
- Product catalogue and batch-level inventory
- Supplier management and purchase (goods-inward) workflow
- Point of sale with FEFO batch allocation, discount, GST and invoicing
- Customer returns with restocking
- Sales / product / inventory / profit analytics
- Mini Analyst rule engine with priority scoring and explainability
- CSV report exports
- Role-based access (Admin / Pharmacist / Staff)
- Local database backup

### Out of scope (stated deliberately)
- Prescription capture, patient records, any medical data
- Payment gateway integration (payment method is *recorded*, not processed)
- Statutory GST return filing or e-invoicing compliance
- Multi-branch / multi-location operation
- Demand forecasting with confidence intervals
- Production-grade security hardening

## 4. Technology stack and rationale

| Layer | Choice | Why |
|---|---|---|
| Frontend | React 18 + TypeScript + Vite | Industry standard; Vite gives instant dev startup on Windows |
| Styling | Tailwind CSS | Consistent spacing/typography without hand-written CSS drift |
| Charts | Recharts | MIT, React-native API, no licence cost |
| Icons | Lucide | ISC licensed, clean line style |
| API | Node.js + Express + TypeScript | Same language across the stack; one skill to learn |
| Database | SQLite via better-sqlite3 | Embedded, offline, zero setup, real ACID transactions |
| Validation | Zod | Runtime validation that also produces TypeScript types |
| Tests | Vitest + Supertest | Fast, TypeScript-native |

Every dependency is MIT / ISC / Apache-2.0 / BSD-2-Clause. No paid service, no AI API,
no cloud account, no Docker, no WSL. See [THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md).

## 5. Architecture summary

A **modular monolith**: React client, Express API, SQLite file. Business logic lives in
`services/`, read-only measurement in `analytics/`, HTTP concerns only in `routes/`.
Full detail in [ARCHITECTURE.md](./ARCHITECTURE.md).

## 6. Development phases

| Phase | Deliverable | Status |
|---|---|---|
| 0 | Environment audit, architecture, schema and methodology documents | Complete |
| 1 | Application foundation — Express API, React shell, routing, layout | Complete |
| 2 | Database — schema, migrations, synthetic seed generator | Complete |
| 3 | Products, batches, inventory, low stock, expiry | Complete |
| 4 | Suppliers and purchases (goods inward) | Complete |
| 5 | Point of sale with FEFO, invoicing, returns | Complete |
| 6 | Sales / product / inventory / profit analytics | Complete |
| 7 | **Mini Analyst rule engine** | Complete |
| 8 | CSV report exports | Complete |
| 9 | UI polish — loading, empty and error states, responsive layout | Complete |
| 10 | Testing — unit and integration, build verification | Complete |
| 11 | GitHub finalisation — README, licences, documentation | Complete |

## 7. Success criteria

The project is complete when all of the following are demonstrably true:

1. `npm install` then `npm run seed` then `npm run dev` starts the whole application on
   a clean Windows machine with no manual configuration.
2. A sale deducts stock from the correct batch by **earliest expiry**, and an expired
   batch is never sold.
3. A sale that exceeds available stock is rejected **and leaves the database unchanged**.
4. Gross profit is computed against the **actual batch cost**, not an average.
5. The Mini Analyst produces insights from live data, each carrying the arithmetic that
   triggered it.
6. Changing a threshold in Settings changes the analytics output with no code change.
7. Data persists across an application restart.
8. `npm run check` passes: type-check, and full test suite.
9. No secret, `.env` file, or real pharmacy data is committed to the repository.

## 8. Demonstration data

The seed generator creates a synthetic dataset with **deliberately planted business
conditions**, so the Mini Analyst has something real to find:

| Condition | Planted |
|---|---|
| Products | 120 across 10 therapeutic categories |
| Suppliers | 16 |
| Customers | 60 |
| Sales | ~1,200 over 180 days |
| Purchases | ~210 |
| Batches | ~330 |
| Fast movers | ~12 products with high daily velocity |
| Dead stock | ~14 products with no sale for 90+ days |
| Low stock | ~18 products below reorder level |
| Out of stock | ~6 products with active demand and zero stock |
| Expiring | ~20 batches inside the 90-day window |
| Already expired | ~5 batches |
| Growing / declining | Trends built into the last 60 days |

All of it is generated programmatically. **No real product, supplier, customer,
prescription or patient data is used anywhere in this project.**

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| `better-sqlite3` native build fails on Windows | Prebuilt binaries ship for current Node LTS; README documents the Node version and the fallback |
| Floating-point drift in money | Every computed amount passes through `round2()`; asserted in tests |
| Analytics figures disagreeing between screens | All revenue/COGS SQL composed from one shared module |
| Stock going negative through a race | Single-process synchronous transactions + `CHECK (quantity >= 0)` |
| Seed data too clean to produce insights | Conditions are planted explicitly, then asserted in tests |

## 10. What this project demonstrates

**Pharmaceutical management knowledge:** batch-level traceability, FEFO expiry-driven
rotation, Rx flagging, GST handling, reorder-level planning, expiry write-off exposure,
inventory turnover and working-capital efficiency.

**Technology and analytics capability:** relational schema design, transactional
integrity, layered application architecture, TypeScript across the stack, a documented
deterministic analytics engine with an auditable priority model, and automated testing.
