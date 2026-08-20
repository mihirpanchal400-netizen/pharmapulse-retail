# Import System

How PharmaPulse Retail takes a pharmacy's own spreadsheets and turns them into
operational data: products, suppliers, distributors, batches, stock, purchases
and sales.

This is the feature that decides whether the software is usable. A pharmacy
already has its catalogue, its supplier list and its stock position somewhere -
in a Tally export, a distributor's price list, or a spreadsheet someone has
maintained by hand for years. Software that cannot read those files is a demo.

---

## 1. What it handles

- **Excel** `.xlsx`, `.xlsm` and **CSV** (comma, semicolon, tab or pipe separated)
- **Multi-sheet workbooks** — every sheet is read and typed independently
- **Trade column names** — "Medicine Name", "Company", "Qty", "Exp.", "MRP Rs."
- **A title row above the headers** — the header row is found, not assumed
- **Indian formats** — `DD/MM/YYYY` dates, `MM/YY` expiries, `₹ 1,20,000.50`, `10+1` schemes
- **Files up to 25 MB**

---

## 2. The four steps

```
   UPLOAD              SHEET & TYPE            MAP COLUMNS           REVIEW & IMPORT
   ------              ------------            -----------           ---------------
   file stored    ->   every sheet        ->   suggested        ->   validate all rows
   on disk             analysed:               mapping, fully        show first 20 as
                       rows, columns,          editable              they will be stored
                       types, duplicates,                            list every problem
                       suggested import                              THEN write, in one
                       type                                          transaction
```

Nothing reaches the operational tables until the last step, and the last step
re-validates from the file rather than trusting anything the browser sends back.

**API:** `POST /api/imports/upload` → `GET /api/imports/:id/suggest` →
`POST /api/imports/:id/preview` → `POST /api/imports/:id/commit`

---

## 3. Import types

| Type | What it is | Writes to |
|---|---|---|
| Product Master | The medicines sold: names, packs, GST, MRP, PTR | `products`, `manufacturers` |
| Manufacturer Master | Pharmaceutical companies | `manufacturers` |
| Supplier Master | Parties named on purchase documents | `suppliers` |
| Distributor / Stockist Master | The buying network with terms, MOQ, delivery | `distributors` (+ a mirrored supplier) |
| Opening Stock | What is on the shelf now, batch by batch — **sets** quantities | `product_batches`, `inventory_transactions`, `stock_adjustments` |
| Batch Master | Goods inward — **adds** quantities | `product_batches`, `inventory_transactions` |
| Distributor Price List | A catalogue: PTR/PTS, schemes, availability | `distributor_products` |
| Purchase History | Past goods-inward documents, one row per line | `purchases`, `purchase_items`, `product_batches` |
| Sales History | Past bills, one row per line | `sales`, `sale_items`, `customers` |

**Suggested order:** Product Master → Distributor Master → Opening Stock →
Price List → Purchase History → Sales History. Each later import matches
against what the earlier ones created.

Every type has a downloadable `.xlsx` template with an example row and a field
guide. Templates are **generated from the same field catalogue the importer
matches against**, so a template can never drift out of step with what the
importer accepts.

---

## 4. Smart column detection

Headers are reduced to a comparable token before matching: lower case,
punctuation and spaces removed, and noise words (`Rs`, `Amount`, `No`, `Value`)
stripped. `Exp. Date`, `EXP_DATE` and `exp.date` all collapse to `expdate`.

Each candidate header is scored against every target field:

| Score | Meaning |
|---|---|
| 1.00 | The header is exactly one of the field's known names |
| 0.80–0.90 | The header contains a known name as a substring |
| > 0.86 fuzzy | Character similarity, for typos and abbreviations |
| < 0.70 | **Discarded** — the column is left unmapped for the user to place |

Assignment is greedy on the best score across the whole grid, and **each column
and each field is used at most once**. That matters for the common case of a
file carrying both "Rate" and "MRP": whichever pairing scores highest is fixed
first, so the second field cannot also claim the same column.

A weak match is returned as *no* match. Leaving a column unmapped and visible is
always better than confidently writing MRP into the purchase-price field.

### Some of the variations recognised

| Target field | Recognised as |
|---|---|
| Product Name | Product, Medicine, Medicine Name, Item, Item Name, Drug, Particulars, Description |
| Manufacturer | Company, Mfg, Mfr, Marketed By, Manufacturer Name |
| Quantity | Qty, Stock, Closing Stock, Balance, Available Qty, On Hand, Stock in Hand |
| MRP | MRP, Maximum Retail Price, Retail Price, M R P |
| PTR / Purchase Price | PTR, Purchase Rate, Rate, Cost, Net Rate, Trade Rate, Landing Cost |
| Supplier | Supplier, Vendor, Party, Stockist, Distributor, Firm Name |
| Expiry | Expiry, Exp, Exp Date, Expiring On, Best Before |
| Batch | Batch, Batch No, Lot, Lot No, B No |

### Remembered mappings

When an import succeeds, its mapping is saved against a **signature** of the
sheet's headers (normalised, sorted, order-independent). The next upload of the
same monthly file opens with that mapping already applied. A user's correction
from last month is better evidence than this month's fuzzy match.

---

## 5. Reading values

Spreadsheets are not databases. `import/coerce.ts` is the single place that
knows how to read what people actually type.

| Written as | Read as |
|---|---|
| `Rs. 1,20,000.50`, `₹108.15` | `120000.5`, `108.15` |
| `(150)` | `-150` (accounting negative) |
| `12.4` in a quantity column | **rejected** — not silently truncated |
| `03/04/2027` | `2027-04-03` — **day first** |
| `06/2027`, `Jun-27` as an expiry | `2027-06-30` — end of that month |
| `06/2027` as a manufacturing date | `2027-06-01` — start of that month |
| `45000` (Excel serial) | `2023-03-15` |
| `Yes`, `Y`, `1`, `Rx` | `true` |
| `10+1`, `Buy 10 Get 1` | buy 10, free 1 |

**Day-first is deliberate.** Indian pharmacy files are written `DD/MM/YYYY`.
Reading `03/04/2027` as 4 March would silently corrupt expiry tracking, which is
the one thing this software must not get wrong.

---

## 6. Validation

Runs before anything is written. Its contract:

- every problem is attributed to a **row number the user can find in Excel**
- a bad row is **rejected**, never silently repaired
- a suspicious but usable value is a **warning** and still imports
- the **whole file** is checked, so all 17 problems appear at once rather than
  the user fixing one and re-uploading seventeen times

### Rejected (ERROR)

- A required field is blank or unreadable
- A number that is not a number, or outside its allowed range (negative stock, GST above 100)
- A date the importer cannot read
- An expiry more than 15 years away — that is a mistyped year
- An expiry on or before its manufacturing date
- A selling price above MRP, which is not permitted
- A free quantity with no buy quantity (a scheme needs both)

### Warned, and still imported (WARNING)

- A batch that has already expired — a real stock statement contains these, and blocking the import would strand the pharmacy
- A purchase price above MRP — sells at a loss, but that is the pharmacy's business
- PTS above PTR — these two may be swapped
- GST outside the standard Indian slabs (0 / 5 / 12 / 18 / 28)
- A product master row with a code but no name
- The same record appearing twice in one file

### Error report

Every finding is **stored**, not just returned, and is downloadable as CSV from
the Import History long after the import ran — because a pharmacy fixes its 27
rejected rows over the following days, in its own spreadsheet.

```
Row, Severity, Column, Field, Value, Problem
24,  ERROR,    MRP Rs., mrp, not priced, MRP "not priced" is not a number
38,  ERROR,    Qty,     quantity, -8,    Quantity cannot be below 0 (found -8)
44,  WARNING,  Exp.,    expiry_date, 06/2026, This batch expired on 2026-06-30 …
```

---

## 7. What happens on commit

1. The sheet is **re-validated from the file**, not from anything the browser sent.
2. Required fields still unmapped → the import is refused with a message naming them.
3. Valid rows are written **inside one SQLite transaction**. An import lands completely or not at all; there is never a half-imported stock file to unpick.
4. Row counts, the mapping and every finding are recorded on the job.
5. The mapping is remembered for next time.
6. **The uploaded spreadsheet is deleted.** The job row and the error list are the durable record; keeping a pharmacy's raw files on disk indefinitely is a liability, not a feature. Abandoned uploads are swept on server start.
7. An entry is written to the audit log.

### Design rules in the importers

- **Normalised, not dumped.** A row is spread across products, manufacturers, batches, suppliers and the inventory ledger. There is no wide `imported_data` table.
- **Reuse, don't duplicate.** Products, suppliers, distributors and manufacturers are matched before anything is created. Re-importing last month's file *updates*; it does not produce a second catalogue.
- **The ledger is always written.** Every quantity change goes through `recordTransaction`, so imported stock is exactly as traceable as stock received against a purchase order.
- **Blank means "leave alone".** On an update, a column the file does not carry keeps its existing value — a price list must not wipe the reorder levels a pharmacy has tuned by hand.
- **Every imported record is traceable.** `source_import_job_id` on products, batches, suppliers, distributors and manufacturers answers "which upload created this?".

### Two decisions worth knowing about

**Sales history does not deduct stock.** A sales-history file describes trade
that has already happened; the opening stock imported alongside it is the
position *after* those sales. Deducting again would drive the shelf negative and
make every reorder suggestion wrong. The bills are recorded so that analytics,
margins and the Mini Analyst have history to work with.

**A price list never invents products.** A typo in a distributor's file would
otherwise create a phantom medicine that then appears in the Replenishment
Center. Unmatched rows are reported and skipped. Every other import type *may*
create the products it names, because a stock or purchase file blocked by a
catalogue gap is useless in practice — this is controlled by the
*Create manufacturers, suppliers and products named in the file* option.

---

## 8. Import history

`/import/history` lists every file ever brought in: name, sheet, type, date,
user, rows imported, rows rejected and status. Opening a row shows its findings
and offers the error report.

```
sample_product_master.xlsx   Product Master   20 Aug 2026   admin   22 imported   1 rejected   COMPLETED
```

---

## 9. Sample data

`npm run sample:data` writes seven workbooks and a CSV into `/sample-data`.
They are **generated, not committed as binaries**, so they always match the
current field catalogue and the repository stays free of opaque blobs.

They are deliberately untidy in the way real pharmacy exports are: trade column
names, rupee symbols in price cells, three different date styles, a title row
above the headers, and a handful of rows with genuine mistakes so the error
report has something to show.

| File | Demonstrates |
|---|---|
| `sample_product_master.xlsx` | Title row, trade headers, 3 problem rows |
| `sample_supplier_master.xlsx` | Distributor network with terms and MOQ |
| `sample_stock.xlsx` | Rupee-formatted prices, mixed date styles, an expired batch |
| `sample_price_list.xlsx` | Distributor rate list with `10+1` schemes |
| `sample_purchase_history.xlsx` | Multiple lines per bill |
| `sample_sales_history.xlsx` | Multiple lines per bill |
| `sample_multi_sheet_master.xlsx` | Products, Suppliers, Stock and Companies in one workbook |
| `sample_product_master.csv` | The CSV path |

All companies, distributors, licence numbers and customer names are invented.
No real personal, patient or commercial data appears anywhere.

---

## 10. Database

Three tables, added by schema v3 (`server/src/database/schemaV3.ts`), all
additive and idempotent like v1 and v2:

| Table | Holds |
|---|---|
| `import_jobs` | One row per uploaded file, surviving the whole wizard and remaining as the history |
| `import_errors` | Per-row findings, stored so the report is downloadable later |
| `import_mappings` | Remembered mappings, keyed by a header signature |

Plus `source_import_job_id` on `products`, `suppliers`, `distributors`,
`product_batches` and `manufacturers`.

---

## 11. Security

| Concern | Handling |
|---|---|
| Who may import | Admin and Pharmacist only — an import rewrites the product master and the shelf. Everyone may read the history. |
| Upload size | Capped at 25 MB, enforced by the body parser and again in the service |
| File name | Only the basename is kept, and only `[A-Za-z0-9._-]` survives, so a crafted name cannot escape the upload directory |
| File type | Extension checked before anything is written to disk |
| Server paths | `stored_path` never leaves the server; responses carry only a `file_available` flag |
| Retention | The spreadsheet is deleted on commit; abandoned uploads are swept after 24 hours |
| Injection | Every write uses a prepared statement with bound parameters |
| Audit | Upload and import are both written to `activity_log` |

---

## 12. Performance

- One `readWorkbook` pass per request; sheets are analysed from a 200-row sample
- Reference lookups are cached in memory for the whole commit rather than queried per row
- Prepared statements are created once and reused across rows
- Document numbering is O(1) per document, not a `SELECT MAX` per row
- The history listing omits the stored JSON blobs

---

## 13. Tests

`tests/import.test.ts` — 43 tests over the generated sample files, so the suite
exercises exactly what ships in `/sample-data`: coercion, detection, multi-sheet
reading, validation severity, every import type, duplicate suppression on
re-import, the CSV path, history, the error report, remembered mappings,
templates, and the imported data arriving in inventory, the Replenishment Center
and the Mini Analyst.
