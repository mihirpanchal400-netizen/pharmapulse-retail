# Analytics Methodology — PharmaPulse Retail

This document defines **every formula** used by the dashboard, the Analytics pages, the
CSV reports and the Mini Analyst. Nothing in the application computes a number that is
not specified here.

Two principles govern the whole engine:

1. **One definition, one implementation.** Revenue, COGS and units are defined once as
   SQL fragments in `server/src/analytics/shared.ts` and composed everywhere else. The
   dashboard and a CSV export physically cannot disagree.
2. **No hidden judgement.** Every threshold is a named, user-editable setting. Every
   insight carries the numbers that triggered it.

---

## Part 1 — Base measurement definitions

### 1.1 Net units

```
net_units = quantity - returned_quantity
```

A unit that was sold and then returned was not really sold. Every volume figure in this
application is net of returns.

### 1.2 Net revenue (the definition of "sales")

```
net_revenue = (selling_price × quantity - discount) × net_units / quantity
```

Revenue is measured **net of tax** and **net of returns**.

- *Net of tax*, because GST collected on behalf of the government is not the pharmacy's
  income. Including it would inflate revenue and understate margin.
- *Net of returns*, for the reason in 1.1.
- The `× net_units / quantity` factor pro-rates the line's discount across the units the
  customer actually kept.

### 1.3 Net COGS (Cost of Goods Sold)

```
net_cogs = batch_purchase_price × net_units
```

The critical detail: `purchase_price` is copied onto `sale_items` **from the specific
batch consumed**, at the moment of sale. It is not the product's current purchase price.

This matters because a pharmacy buys the same product repeatedly at different prices. If
Paracetamol was bought at ₹1.80 in March and ₹2.10 in June, a sale from the March batch
must cost ₹1.80. Using a product-level average would misstate profit on every line.

### 1.4 Cancelled sales

```
WHERE sales.status <> 'CANCELLED'
```

Cancelled sales are excluded from every figure, everywhere.

---

## Part 2 — Core business formulas

### 2.1 Gross Profit

```
Gross Profit = Net Revenue - Net COGS
```

### 2.2 Gross Margin

```
Gross Margin % = (Gross Profit / Net Revenue) × 100
```

Returns 0 when revenue is 0 (no division by zero anywhere — see `utils/money.ts`
`safeDiv()`).

### 2.3 Average Bill Value (ABV)

```
ABV = Net Revenue / Number of Sales
```

### 2.4 Sales Growth

```
Growth % = (Current Period - Previous Period) / |Previous Period| × 100
```

The previous period is the **immediately preceding window of equal length**. For a
30-day view: current is days `[T-29 … T]`, previous is days `[T-59 … T-30]`.

Equal-length adjacent windows are used rather than "same period last year" because a
demo dataset spans months, not years, and because week-on-week comparison of unequal
windows is a common source of misleading growth figures.

When the previous period is 0, growth is reported as `+100%` if there are current sales,
otherwise `0%` — never infinity.

### 2.5 Inventory Turnover

```
Inventory Turnover = COGS over period / Average Inventory Value at cost
Average Inventory Value = (Opening Inventory + Closing Inventory) / 2
```

Reported over a 90-day window by default, and also **annualised** for interpretability:

```
Annualised Turnover = Turnover × (365 / period_days)
```

A pharmacy typically targets 8–12 annualised turns. Below ~6 suggests over-buying;
above ~15 suggests stock-outs are likely.

Because the demo database has a finite history, opening inventory is reconstructed from
the `inventory_transactions` log by rolling the current position backwards.

### 2.6 Sales Velocity

```
Sales Velocity = Net Units Sold in window / window_days
```

Units per day. This is the basis of stock coverage and of fast/slow classification.

### 2.7 Stock Coverage (Days of Supply)

```
Stock Coverage Days = Current Stock / Sales Velocity
```

"At the current rate of sale, this stock lasts N days." Reported as `null` (displayed as
"—") when velocity is 0, because dividing by zero demand is meaningless — that product
is dead stock, and a different rule handles it.

### 2.8 Inventory Value

```
Inventory Value (at cost)   = Σ (batch.quantity × batch.purchase_price)
Inventory Value (at retail) = Σ (batch.quantity × batch.selling_price)
```

Cost value is used for turnover and for "value at risk" figures. Retail value is shown
for context only.

### 2.9 Revenue Concentration

```
Concentration(top N) = Revenue from top N products / Total Revenue × 100
```

Computed for N = 5, 10 and 20. High concentration means the business depends on few
products — a stock-out in any of them is disproportionately damaging.

---

## Part 3 — Classification rules

### 3.1 Stock status

Evaluated in this order; the first match wins:

| Status | Condition |
|---|---|
| `OUT_OF_STOCK` | `current_stock = 0` |
| `LOW_STOCK` | `current_stock <= reorder_level × lowStockThresholdMultiplier` |
| `OVERSTOCKED` | `current_stock > maximum_stock × overstockMultiplier` |
| `HEALTHY` | none of the above |

`EXPIRING` is tracked as a **separate flag**, not a stock status, because a product can
be simultaneously healthy on quantity and at risk on expiry.

### 3.2 Expiry buckets

Based on `days_to_expiry = expiry_date - today`:

| Bucket | Condition |
|---|---|
| `EXPIRED` | `days_to_expiry <= 0` |
| `DAYS_30` | `1 … 30` |
| `DAYS_60` | `31 … 60` |
| `DAYS_90` | `61 … 90` |
| `SAFE` | `> 90` |

Expired batches are **excluded from sellable stock by the FEFO allocator** but remain
visible in inventory reporting until they are written off, because they still represent
a real financial loss the pharmacist must account for.

### 3.3 Movement classification

Over the analysis window (default 30 days):

| Class | Condition |
|---|---|
| Fast-moving | Velocity in the **top 20%** of products that sold at all |
| Slow-moving | Sold at least once, but not fast-moving |
| Dead stock | `current_stock > 0` **and** no sale for `deadStockDays` (default 90) |
| Never sold | `current_stock > 0` and zero lifetime sales |

Fast-moving uses a **percentile within this pharmacy's own catalogue**, not an absolute
units-per-day cut-off. An absolute threshold would be meaningless across categories: 5
units/day is fast for a cardiac drug and slow for paracetamol.

### 3.4 Inventory Health Score

A single 0–100 indicator, starting at 100 with penalties deducted:

```
Health = 100
       - (stockout_pct   × 1.5)
       - (expiring_pct   × 1.0)
       - (dead_stock_pct × 0.8)
       - (overstock_pct  × 0.5)
clamped to [0, 100]
```

Where each `_pct` is that category's share of total SKUs. The weights encode a stated
business judgement, editable in Settings:

- **Stock-outs are weighted highest (1.5)** — they are lost revenue *and* lost customer
  trust, and the loss is immediate and unrecoverable.
- **Expiry (1.0)** — a certain, quantifiable write-off, but usually still preventable.
- **Dead stock (0.8)** — capital is trapped, but the goods can still be sold or returned.
- **Overstock (0.5)** — inefficient, but the least damaging; it is a timing problem.

| Band | Interpretation |
|---|---|
| 85–100 | Healthy |
| 70–84 | Minor attention needed |
| 50–69 | Action required |
| 0–49 | Critical |

---

## Part 4 — The Mini Analyst

### 4.1 What it is

A **deterministic rule engine** that reads the live database, evaluates a fixed set of
business rules, and emits ranked, explained insights.

It is not a language model. It calls no external API. Given the same database, it
produces exactly the same output every time.

### 4.2 Why rule-based rather than an LLM

| Property | Rule engine | LLM |
|---|---|---|
| Cost | Zero | Per-token, requires paid API key |
| Works offline | Yes | No |
| Reproducible | Identical output for identical data | Varies between runs |
| Auditable | Every number traceable to a SQL query | Reasoning not verifiable |
| Can invent a fact | No | Yes |
| Speed | Milliseconds | Seconds |

For a system whose recommendations trigger real purchase orders, **reproducibility and
auditability are worth more than fluent prose**. A pharmacist must be able to ask "why
are you telling me to reorder this?" and get an arithmetic answer.

The trade-off is honest: the Mini Analyst answers only the questions it has rules for.
It cannot handle an open-ended question. That is an accepted limitation.

### 4.3 Priority scoring

Every insight is scored on a common scale so that a reorder alert and an expiry alert
can be ranked against each other:

```
Priority Score = Impact × Urgency          (each 0–10, so score is 0–100)
```

**Impact** — the money at stake, normalised against the pharmacy's own scale:

```
impact_anchor = max(1000, trailing_30_day_revenue × 0.02)
Impact = clamp(10 × value_at_stake / impact_anchor, 1, 10)
```

The anchor self-calibrates: an issue worth 2% of a month's revenue scores a full 10 in
any size of pharmacy. A ₹5,000 problem is critical for a small pharmacy and routine for
a large one, and the score reflects that.

`value_at_stake` per rule:

| Rule | value_at_stake |
|---|---|
| Reorder / stock-out | Revenue expected to be lost before restocking = `velocity × 7 days × selling_price` |
| Expiry | `batch.quantity × batch.purchase_price` (the write-off) |
| Dead stock | `stock × purchase_price` (the trapped capital) |
| Overstock | `excess_units × purchase_price` |
| Sales decline | Absolute revenue change vs previous period |
| Margin erosion | `revenue × margin_gap_pct / 100` |

**Urgency** — time pressure, on a 90-day horizon:

```
Urgency = clamp(10 × (1 - days_until_consequence / 90), 1, 10)
```

| Rule | days_until_consequence |
|---|---|
| Out of stock now | 0 (Urgency 10) |
| Reorder needed | Stock coverage days remaining |
| Expiry | Days until the batch expires |
| Dead stock | 90 (Urgency 1) — capital is trapped but nothing worsens tomorrow |
| Sales trend | 30 (Urgency ~6.7) — a trend is actionable this month |

**Severity** is derived from the score, so it is never assigned by hand:

| Severity | Score |
|---|---|
| `CRITICAL` | >= 70 |
| `HIGH` | 45 – 69 |
| `MEDIUM` | 25 – 44 |
| `LOW` | < 25 |

**Worked example.** Paracetamol 500mg: stock 12, reorder level 25, velocity 3.2/day,
selling price ₹22. Trailing 30-day revenue ₹340,000.

```
value_at_stake = 3.2 × 7 × 22            = ₹492.80
impact_anchor  = max(1000, 340000 × 0.02) = ₹6,800
Impact         = clamp(10 × 492.8 / 6800, 1, 10) = 1.0  (rounded from 0.72, floored at 1)
coverage       = 12 / 3.2                 = 3.75 days
Urgency        = clamp(10 × (1 - 3.75/90), 1, 10) = 9.6
Priority Score = 1.0 × 9.6                = 9.6  -> LOW individually
```

Individually a single fast-moving cheap product is low priority. The engine therefore
**aggregates same-type insights**: all 17 reorder-needed products are combined into one
insight whose `value_at_stake` is the sum, which lifts it into `CRITICAL`. This is
correct behaviour — the reorder *decision* is made once for the whole basket.

### 4.4 The rule set

| # | Rule | Fires when | Severity driver |
|---|---|---|---|
| 1 | `STOCK_OUT` | Products with velocity > 0 and stock = 0 | Lost revenue |
| 2 | `REORDER` | `stock <= reorder_level`, stock > 0 | Lost revenue at 7-day horizon |
| 3 | `EXPIRY_CRITICAL` | Batches expiring within 30 days | Write-off value |
| 4 | `EXPIRY_WARNING` | Batches expiring in 31–90 days | Write-off value |
| 5 | `EXPIRED_STOCK` | Batches already expired, quantity > 0 | Realised loss |
| 6 | `DEAD_STOCK` | Stock > 0, no sale in `deadStockDays` | Trapped capital |
| 7 | `SALES_GROWTH` | Revenue up more than `salesGrowthThresholdPct` | Revenue delta |
| 8 | `SALES_DECLINE` | Revenue down more than `salesGrowthThresholdPct` | Revenue delta |
| 9 | `CATEGORY_TREND` | A category moved more than 15% vs previous period | Category revenue delta |
| 10 | `MARGIN_EROSION` | Gross margin fell more than 2 percentage points | Revenue × margin gap |
| 11 | `REVENUE_CONCENTRATION` | Top 5 products exceed 40% of revenue | Revenue at risk |
| 12 | `LOW_TURNOVER` | Annualised turnover below 6 | Excess capital |
| 13 | `OVERSTOCK` | `stock > maximum_stock` | Excess capital |
| 14 | `FAST_MOVER_OPPORTUNITY` | Top-velocity product with coverage < 14 days | Revenue at risk |

Rules 7–10 are **positive or negative**: the engine reports growth as an opportunity, not
only problems as threats.

### 4.5 Explainability contract

Every insight object carries:

- `reason` — the rule condition stated in plain English with the actual numbers
- `evidence[]` — the individual metric values the rule read
- `recommendation` — the specific action to take
- `impact`, `urgency`, `priorityScore` — the score components, shown in the UI

An insight that cannot populate all of these is a bug, not a feature. **No insight is
ever displayed without the arithmetic that produced it.**

---

## Part 5 — Configurable thresholds

Every threshold below lives in the `settings` table and is editable from the Settings
screen. The analytics engine reads them at request time, so a change takes effect on the
next page load with no restart.

| Setting | Default | Meaning |
|---|---|---|
| `expiryWarningDays` | 90 | Horizon for "expiring soon" |
| `expiryCriticalDays` | 30 | Horizon for urgent expiry alerts |
| `deadStockDays` | 90 | Days without a sale before stock is "dead" |
| `lowStockThresholdMultiplier` | 1 | Scales `reorder_level` for the low-stock test |
| `salesGrowthThresholdPct` | 10 | Movement needed before a trend is reported |
| `analysisWindowDays` | 30 | Default window for velocity and growth |
| `criticalCoverageDays` | 7 | Coverage below this is a stock-out risk |
| `overstockMultiplier` | 1 | Scales `maximum_stock` for the overstock test |
| `revenueConcentrationTopN` | 10 | N for the headline concentration figure |
| `healthPenaltyStockoutPerPct` | 1.5 | Health score weight |
| `healthPenaltyExpiryPerPct` | 1.0 | Health score weight |
| `healthPenaltyDeadStockPerPct` | 0.8 | Health score weight |
| `healthPenaltyOverstockPerPct` | 0.5 | Health score weight |

---

## Part 6 — Known limitations

Stated explicitly, because a methodology that claims no limitations is not credible:

1. **No seasonality adjustment.** Sales velocity is a flat average over the window. A
   real pharmacy sees strong seasonality (antibiotics in monsoon, antihistamines in
   spring). Adjacent-window comparison partially controls for this, but does not model it.
2. **No demand forecasting.** Stock coverage extrapolates the recent average forward. It
   is a projection, not a forecast — there is no confidence interval.
3. **Turnover uses reconstructed opening inventory.** With a short data history this is
   approximate; the figure stabilises as history accumulates.
4. **Fast-moving is relative to this catalogue only.** There is no external benchmark,
   because that would require a commercial market-data subscription.
5. **Rules cannot answer unanticipated questions.** This is the accepted cost of
   choosing determinism over a language model.
6. **Margin ignores operating costs.** Gross margin is revenue minus cost of goods. Rent,
   salaries, electricity and shrinkage are not modelled, so this is *not* net profit.
