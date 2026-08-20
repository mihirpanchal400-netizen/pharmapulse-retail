# PharmaPulse Retail

**Retail Pharmacy Management & Procurement Platform, with a rule-based Mini Analyst**

An offline-first pharmacy management system built as an MBA Pharmaceutical Management
technology project. It runs entirely on a Windows laptop with no paid API, no cloud
account, no Docker and no internet connection after install.

> **Demonstration software.** All data is synthetic. No patient records, prescriptions,
> medical histories or real pharmacy data are stored, processed or generated anywhere in
> this system. The distributor network is a local demo — it is not connected to any
> commercial platform. See [Legal and scope](#legal-and-scope).

---

## What it does

| Area | Capability |
|---|---|
| **Excel / CSV import** | Multi-sheet workbooks, smart column detection, editable mapping, full validation, preview, error report and import history — bring your own product master, suppliers, stock and trading history |
| **Product master** | 126 products with MRP, PTR, PTS, GST, HSN, schedule category, barcode, composition, lead time, storage condition |
| **Inventory** | Batch-level stock, append-only movement ledger, expiry buckets, stock valuation at cost and retail |
| **FEFO dispensing** | Earliest-expiring batch always leaves first; expired stock can never be sold; one sale line can split across batches |
| **Point of sale** | Barcode/keyboard-wedge search, cart, discount, GST, four payment methods including credit, invoice |
| **Distributor network** | 28 demo distributors with catalogues, prices, free-goods schemes, availability, delivery terms |
| **Scheme engine** | `10+1`, `20+2`, percentage and flat discounts → **effective cost** per unit received |
| **Supplier comparison** | Ranks every distributor by effective cost, not headline rate |
| **Procurement** | Replenishment Center → cart → purchase order → goods receipt → batch → stock |
| **Outstanding** | Supplier payable and customer receivable, aged (current / 1-30 / 31-60 / 60+) |
| **Mini Analyst** | 18 deterministic rules producing ranked, fully explained, actionable insights |
| **Reports** | 11 CSV exports covering sales, inventory, expiry, purchasing and profitability |
| **Audit trail** | Who did what, in which module, to which record |

### The idea behind it

A pharmacy generates a lot of transactional data and converts almost none of it into a
decision. This project closes that gap in two places:

1. **Effective cost, not quoted rate.** Indian pharma distribution runs on free-goods
   schemes. A distributor quoting ₹41 with `10+1` costs **₹37.27** per unit received and
   beats a rival quoting a flat ₹39. Buying on the headline rate is the most common
   purchasing error in retail pharmacy, and the comparison screen exists to prevent it.

2. **Insights that carry an action.** The Mini Analyst does not say "stock is low". It
   says *order 142 units of this product from Trinity Pharma Traders at an effective
   ₹10.24, which earns 14 free under their scheme* — with an **Add to Cart** button and
   the full arithmetic behind the recommendation.

3. **Your data, not demo data.** A pharmacy already has its catalogue, supplier list and
   stock position in a spreadsheet somewhere. The Import Center reads those files as
   they actually are — "Medicine Name", "Qty", "Exp.", `₹ 1,20,000`, `06/27`, a title
   row above the headers — and turns them into normalised operational records. Software
   that cannot read a pharmacy's existing files is a demo; this is the feature that
   makes the rest of it usable.

---

## Requirements

```text
Windows 10 or 11
Node.js 20 LTS or newer   (developed on Node 24)
Git
PowerShell
```

Check what you have:

```powershell
node --version
npm --version
git --version
```

If Node.js is missing, install the LTS build from <https://nodejs.org>. Nothing else
needs installing — no database server, no Docker, no WSL.

---

## Setup

### 1. Clone

```powershell
git clone https://github.com/mihirpanchal400-netizen/pharmapulse-retail.git
cd pharmapulse-retail
```

### 2. Install dependencies

```powershell
npm install
```

Downloads the packages into `node_modules`. This is the only step that needs internet.

### 3. Create the demo database

```powershell
npm run seed:all
```

Builds `database/pharmapulse.db` and fills it with a synthetic 180-day trading history
plus the demo distributor network. Takes about a minute. Deterministic — you get the same
database every time, so a rehearsed demo shows the same numbers on the day.

### 4. Run

```powershell
npm run dev
```

Starts the API on **http://localhost:4000** and the app on **http://localhost:5173**.
Open the second URL in your browser.

### 5. Sign in

| Role | Username | Password | Access |
|---|---|---|---|
| Admin | `admin` | `admin123` | Everything, including Settings |
| Pharmacist | `pharmacist` | `pharma123` | Sales, inventory, purchases, analytics |
| Counter staff | `staff` | `staff123` | Billing and read-only stock |

These are demonstration credentials for a local synthetic database, documented
deliberately. They are not production security.

---

## All commands

| Command | What it does |
|---|---|
| `npm run dev` | Starts API and client together |
| `npm run seed` | Regenerates the base trading history (products, sales, batches) |
| `npm run seed:procurement` | Regenerates the distributor network and purchase orders |
| `npm run seed:all` | Both, in the right order |
| `npm run sample:data` | Regenerates the demonstration Excel files in `sample-data/` |
| `npm run db:stats` | Prints row counts, business figures and the ranked Mini Analyst output |
| `npm run db:upgrade` | Applies schema migrations to an existing database |
| `npm run backup` | Timestamped copy of the database into `database/backups/` |
| `npm run db:reset` | Rebuilds an empty schema (old file is copied aside first) |
| `npm run test` | Runs the end-to-end workflow test suite |
| `npm run typecheck` | Type-checks server and client |
| `npm run check` | Type-check + tests |
| `npm run build` | Production build of both halves |

### Backup and restore

```powershell
npm run backup
```

Uses SQLite's online backup API rather than a file copy, which matters in WAL mode — a
plain copy can silently miss pages still sitting in the `-wal` sidecar. Keeps the ten most
recent backups.

To restore, stop the app and overwrite the live file:

```powershell
Copy-Item database\backups\pharmapulse-2026-08-19-1430.db database\pharmapulse.db -Force
```

---

## Working with Git

```powershell
git status                              # what has changed
git add .                               # stage everything
git commit -m "Describe your change"    # save a checkpoint
git push                                # send it to GitHub
```

`git pull` brings down changes made elsewhere. The database, `node_modules` and any `.env`
file are git-ignored and never leave your machine.

---

## Architecture

A **modular monolith** — one repository, one API process, one React app, one SQLite file.

```
Browser  ·  React 18 + TypeScript + Vite + Tailwind        :5173
                    |  JSON over HTTP (Vite proxies /api)
API      ·  Express 4 + TypeScript                          :4000
              routes/      HTTP shape only
              middleware/  JWT auth, role gates, validation, errors
              services/    business logic (FEFO, invoicing, schemes, procurement)
              analytics/   read-only measurement + Mini Analyst
              reports/     CSV projections
                    |  better-sqlite3 (synchronous, in-process)
SQLite   ·  database/pharmapulse.db · WAL · 28 tables · FK on
```

The layering rule: **a layer may import downward, never upward.** Services never touch
`req`/`res`; analytics never mutates state; routes contain no arithmetic.

Full detail in [ARCHITECTURE.md](./ARCHITECTURE.md),
[DATABASE_SCHEMA.md](./DATABASE_SCHEMA.md),
[ANALYTICS_METHODOLOGY.md](./ANALYTICS_METHODOLOGY.md) and
[PROJECT_UPGRADE_PLAN.md](./PROJECT_UPGRADE_PLAN.md).

---

## How the scheme engine works

```
PTS ₹41, scheme 10+1, order 100 units

  free units      = floor(100 / 10) × 1   = 10
  units received  = 100 + 10              = 110
  gross           = 100 × 41              = ₹4,100
  net payable                             = ₹4,100
  EFFECTIVE COST  = 4,100 / 110           = ₹37.27
```

Against a competitor at a flat ₹39, the ₹41 quote is **cheaper per unit received**. Every
procurement screen ranks on this figure. Effective cost excludes GST, which a registered
pharmacy recovers as input credit — including it would overstate the true cost of goods.

Free goods enter stock at zero cost, so the batch's weighted cost — and therefore gross
margin on those units — reflects the scheme correctly.

---

## The Mini Analyst

A **deterministic rule engine**, not a language model. It reads the live database,
evaluates 18 business rules, and emits ranked insights each carrying the arithmetic that
produced it.

```
Priority Score = Impact × Urgency          (each 0–10, product 0–100)

Impact  = clamp(10 × value_at_stake / anchor, 1, 10)
          anchor = max(₹1,000, trailing 30-day revenue × 2%)
Urgency = clamp(10 × (1 − days_until_consequence / 90), 1, 10)

CRITICAL ≥ 70  ·  HIGH 45–69  ·  MEDIUM 25–44  ·  LOW < 25
```

Severity is *derived* from the score, never assigned by hand. The impact anchor
self-calibrates, so the same rules behave sensibly in a small pharmacy or a large one.

**Why rule-based rather than an LLM:** zero cost, works offline, reproducible, auditable,
and it cannot invent a fact. For recommendations that trigger real purchase orders, those
properties are worth more than fluent prose. The accepted trade-off is that it only
answers the questions it has rules for.

Full specification in [ANALYTICS_METHODOLOGY.md](./ANALYTICS_METHODOLOGY.md).

---

## The Import Center

The feature that turns this from a demo into something a pharmacy could actually
start using: it reads the files they already have.

```
UPLOAD  →  SHEET & TYPE  →  MAP COLUMNS  →  REVIEW & IMPORT
```

Open **Import Center** in the sidebar, or go to `/import`.

- **Excel** (`.xlsx`, `.xlsm`) and **CSV**, up to 25 MB
- **Multi-sheet workbooks** — every tab is read and typed separately, so one
  "master file" holding Products, Suppliers and Stock needs no splitting by hand
- **Column names do not have to match.** "Medicine Name", "Company", "Qty",
  "Exp.", "MRP Rs." are all recognised, and anything the detector is unsure about
  is left for you to map rather than guessed at
- **Indian formats read correctly** — `DD/MM/YYYY`, `06/27` expiries, `Jun-27`,
  Excel serial dates, `₹ 1,20,000.50`, `10+1` schemes
- **Nothing is written until you have seen it.** The review step shows the first
  20 rows exactly as they will be stored, plus every problem in the file, by
  spreadsheet row number
- **Rejected rows come back as a CSV** you can fix in your own spreadsheet
- **Import history** keeps the record: file, sheet, type, user, rows imported,
  rows rejected — and the findings stay downloadable afterwards

Nine import types, each with a downloadable template:

| Product Master | Manufacturer Master | Supplier Master |
|---|---|---|
| **Distributor / Stockist Master** | **Opening Stock** | **Batch Master** |
| **Distributor Price List** | **Purchase History** | **Sales History** |

Try it with the demonstration files. They are **generated**, not committed as
binaries, so they always match the current field catalogue — run this once after
cloning:

```powershell
npm run sample:data
```

That writes seven workbooks and a CSV into `sample-data/`.

They are deliberately untidy in the way real exports are — trade column names, a
title row above the headers, rupee symbols in price cells, three date styles, and
a few genuinely broken rows so you can see the error report work.

Full detail in [IMPORT_SYSTEM.md](./IMPORT_SYSTEM.md).

---

## Testing

```powershell
npm run test
```

**77 tests** across two suites, both on a fresh in-memory database.

`tests/workflow.test.ts` — 34 tests walking the complete operating cycle:

```
product → batch → distributor → catalogue → scheme → opening stock
  → sell → FEFO verified → stock falls → replenishment detects
  → distributor recommended → purchase order → goods receipt
  → new batch → stock rises → supplier invoice → payment
  → reports → Mini Analyst
```

Alongside the happy path it asserts the things that matter when they go wrong: a sale
beyond available stock is rejected **and leaves the database unchanged**; an expired batch
is never dispensed; gross profit uses the actual batch cost rather than an average; batch
quantities always reconcile with the movement ledger; stock can never go negative; and the
Mini Analyst returns identical output for identical data.

`tests/import.test.ts` — 43 tests running the real sample workbooks through the
Import Center:

```
messy Excel → sheet analysis → type detection → column mapping
  → validation → preview → commit → products, suppliers, stock, batches
  → inventory, Replenishment Center and Mini Analyst all see the imported data
```

The sample files are **generated by the suite**, not checked-in fixtures, so the
tests exercise exactly what ships in `sample-data/`. They pin the behaviour that
would otherwise silently corrupt data: `03/04/2027` is read as 3 April and never
4 March; `06/2027` as an expiry means the last day of June; a fractional quantity
is rejected rather than truncated; an expired batch warns but still imports;
re-importing a file updates rather than duplicating; and a price list never
invents a product that is not in the master.

---

## Legal and scope

### Data

Everything in the demo database is **synthetic**, generated by `seed/catalog.json` and the
seed scripts. Generic drug names are non-proprietary INN names. Brand names, distributors,
suppliers and customers are **invented** — any resemblance to a real company is
coincidental. GSTIN and drug-licence fields hold format-shaped placeholder strings, not
valid registrations.

**No patient data of any kind** — no records, prescriptions, diagnoses, medical histories
or insurance claims — is stored, processed or generated. The customer table deliberately
holds only a name, phone and type.

The demonstration Excel files in `sample-data/` are generated the same way, from the same
invented companies and distributors. If you import **your own** files, that data is yours
and stays on your machine — the uploaded spreadsheet is deleted once the import completes,
and nothing is transmitted anywhere.

### The distributor network is a demo

The 28 distributors, their catalogues, prices, schemes and stock figures are generated
locally and labelled **Demo** throughout the interface. They are **not** connected to
Retailio, Pharmarack, or any other commercial platform, and represent no live market data.

Public descriptions of B2B pharmacy ordering platforms informed the *workflow design*
only. No code, asset, API or dataset was copied from any of them; every line here was
written for this project.

**Purchase orders are simulated.** Creating or "sending" one writes a row to your local
database. Nothing is transmitted anywhere. The architecture routes all distributor data
through one service boundary, so a legitimate authorised API could replace the local
source later without touching the interface.

### Licensing

This project is [MIT licensed](./LICENSE). Every dependency is permissively licensed
(MIT / ISC / Apache-2.0 / BSD-2-Clause) and documented in
[THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md). No paid service, AI API, cloud
account or commercial dataset is required to build, run or demonstrate it.

### Limitations, stated plainly

- **Authentication is coursework-grade.** Bcrypt hashing and signed JWTs demonstrate
  role-based access honestly, but there is no refresh-token rotation, rate limiting or MFA.
- **Gross profit only.** Rent, salaries, electricity and shrinkage are not modelled, so
  nothing here is net profit.
- **No demand forecasting.** Stock coverage extrapolates a recent average forward. It is a
  projection, not a forecast, and carries no confidence interval.
- **No seasonality adjustment.** Velocity is a flat average over the window.
- **Single location.** No multi-branch operation or inter-branch transfer.
- **Not a compliance system.** No statutory GST return filing, no e-invoicing, no
  narcotics register. Schedule categories are recorded but not enforced against a
  prescription.
- **Analytics is descriptive, not predictive.** Every screen reports what happened;
  none forecasts what will.
- **Imported registration numbers are not verified.** GSTIN and drug-licence values from a
  spreadsheet are stored exactly as given; the software checks no registry.
- **Opening Stock overwrites quantities.** It is meant to be run once, at go-live. Take a
  backup (`npm run backup`) before a large import — the import itself is transactional and
  cannot land half-done, but a successful import of the *wrong file* is still wrong.

Before deploying this in a working pharmacy, read
[COMMERCIALIZATION_CONSIDERATIONS.md](./COMMERCIALIZATION_CONSIDERATIONS.md) — it maps the
licensing, GST, data-protection and electronic-records ground this software does **not**
cover.

---

## Project structure

```
pharmapulse-retail/
├── client/src/          React app — pages, components, charts, hooks
├── server/src/
│   ├── routes/          HTTP endpoints
│   ├── middleware/      auth, validation, error handling
│   ├── services/        business logic incl. scheme, procurement, replenishment
│   ├── import/          Import Center — workbook reader, column detection,
│   │                    validation, importers, templates, sample generator
│   ├── analytics/       measurement + Mini Analyst
│   ├── reports/         CSV exports
│   └── database/        schema, migrations, seed, backup
├── seed/catalog.json    synthetic product and supplier catalogue
├── sample-data/         demonstration Excel/CSV files (npm run sample:data)
├── tests/               workflow suite + Import Center suite
├── database/            SQLite file, uploads and backups (all git-ignored)
└── docs at root         ARCHITECTURE · DATABASE_SCHEMA · IMPORT_SYSTEM
                         ANALYTICS_METHODOLOGY · PROJECT_AUDIT
                         COMMERCIALIZATION_CONSIDERATIONS · THIRD_PARTY_LICENSES
```

---

## Troubleshooting

**`npm run dev` says port 4000 is in use**

```powershell
Get-NetTCPConnection -LocalPort 4000 -State Listen | Select-Object OwningProcess
Stop-Process -Id <PID>
```

**The dashboard is empty** — the database has no data. Run `npm run seed:all`.

**"Cannot reach the PharmaPulse API"** — the API process is not running. `npm run dev`
starts both halves; check the terminal for an error from the `server` side.

**`better-sqlite3` fails to build during install** — you are likely on a Node version
without a prebuilt binary. Install Node 20 or 22 LTS and delete `node_modules` before
retrying.

---

Built by **Mihir Panchal** · MBA (Pharmaceutical Management)
