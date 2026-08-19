import { round1, round2, safeDiv } from '../utils/money';
import { getThresholds, getPharmacyProfile } from '../services/settingsService';
import { getInventory, type InventoryItem } from '../services/inventoryService';
import { getExpiringBatches, getExpiredBatches, type BatchWithContext } from '../services/batchService';
import { getSalesGrowth, getCategorySales, getRevenueConcentration } from './salesAnalyzer';
import { getProductPerformance } from './productAnalyzer';
import { getInventoryTurnover, getInventorySummary, getInventoryHealthScore } from './inventoryAnalyzer';
import { getProfitComparison } from './profitAnalyzer';
import type { Insight, InsightSeverity } from '../types';

/**
 * THE MINI ANALYST
 * ================
 *
 * A deterministic rule engine. It reads the live database, evaluates a fixed set
 * of business rules, and emits ranked insights - each one carrying the exact
 * arithmetic that produced it.
 *
 * It is not a language model. It calls no external API, needs no key, works
 * offline, and returns identical output for identical data.
 *
 * Every formula in this file is specified in docs form in
 * ANALYTICS_METHODOLOGY.md, Part 4. If the two ever disagree, the document is
 * the specification and this file is the bug.
 */

// --------------------------------------------------------------------------
// Scoring primitives
// --------------------------------------------------------------------------

const URGENCY_HORIZON_DAYS = 90;
const IMPACT_ANCHOR_FLOOR = 1000;
const IMPACT_ANCHOR_REVENUE_SHARE = 0.02;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Impact: the money at stake, normalised against the pharmacy's own scale.
 *
 *   anchor = max(1000, trailing 30-day revenue x 2%)
 *   Impact = clamp(10 x value_at_stake / anchor, 1, 10)
 *
 * The anchor self-calibrates. A problem worth 2% of a month's revenue scores a
 * full 10 whether the pharmacy turns over 3 lakh or 30 lakh a month, so the same
 * rule set behaves sensibly at any size. The floor stops a brand-new database
 * with almost no sales from scoring every trivial issue as critical.
 */
function impactScore(valueAtStake: number, anchor: number): number {
  return round1(clamp(10 * safeDiv(Math.abs(valueAtStake), anchor), 1, 10));
}

/**
 * Urgency: time pressure on a 90-day horizon.
 *
 *   Urgency = clamp(10 x (1 - days_until_consequence / 90), 1, 10)
 *
 * Something that hurts today scores 10. Something 90 days away scores 1. The
 * relationship is linear because a defensible straight line is easier to argue
 * in a viva than an unjustified exponential curve.
 */
function urgencyScore(daysUntilConsequence: number): number {
  return round1(clamp(10 * (1 - clamp(daysUntilConsequence, 0, URGENCY_HORIZON_DAYS) / URGENCY_HORIZON_DAYS), 1, 10));
}

/** Severity is DERIVED from the score - it is never assigned by hand. */
function severityFor(score: number): InsightSeverity {
  if (score >= 70) return 'CRITICAL';
  if (score >= 45) return 'HIGH';
  if (score >= 25) return 'MEDIUM';
  return 'LOW';
}

// --------------------------------------------------------------------------
// Formatting
// --------------------------------------------------------------------------

function currency(value: number): string {
  const symbol = getPharmacyProfile().currency_symbol || '₹';
  return `${symbol}${Math.round(value).toLocaleString('en-IN')}`;
}

function pct(value: number): string {
  return `${value > 0 ? '+' : ''}${round1(value)}%`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

// --------------------------------------------------------------------------
// Insight builder
// --------------------------------------------------------------------------

interface RuleOutput {
  id: string;
  type: string;
  title: string;
  description: string;
  metric: number;
  metricLabel: string;
  recommendation: string;
  reason: string;
  evidence: { label: string; value: string }[];
  valueAtStake: number;
  daysUntilConsequence: number;
  link?: string | null;
  linkLabel?: string | null;
}

function build(out: RuleOutput, anchor: number): Insight {
  const impact = impactScore(out.valueAtStake, anchor);
  const urgency = urgencyScore(out.daysUntilConsequence);
  const priorityScore = round1(impact * urgency);

  return {
    id: out.id,
    type: out.type,
    severity: severityFor(priorityScore),
    title: out.title,
    description: out.description,
    metric: out.metric,
    metricLabel: out.metricLabel,
    recommendation: out.recommendation,
    reason: out.reason,
    // The score components are appended to every insight's evidence so the
    // ranking itself is auditable, not just the finding.
    evidence: [
      ...out.evidence,
      { label: 'Value at stake', value: currency(out.valueAtStake) },
      { label: 'Impact score', value: `${impact} / 10` },
      { label: 'Urgency score', value: `${urgency} / 10` },
      { label: 'Priority (Impact x Urgency)', value: `${priorityScore} / 100` },
    ],
    priorityScore,
    impact,
    urgency,
    link: out.link ?? null,
    linkLabel: out.linkLabel ?? null,
  };
}

// --------------------------------------------------------------------------
// Rules
// --------------------------------------------------------------------------

/**
 * Rules 1 & 2 - STOCK_OUT and REORDER.
 *
 * Both are aggregated across products rather than emitted per product. The
 * reorder DECISION is made once for the whole basket, so one insight covering
 * 17 products models the real workflow better than 17 low-priority cards. The
 * value at stake is the sum, which is what lifts a basket of individually
 * cheap items into CRITICAL - correctly.
 */
function stockRules(items: InventoryItem[], anchor: number): Insight[] {
  const out: Insight[] = [];
  const active = items.filter((i) => i.status === 'ACTIVE');

  // --- Rule 1: out of stock, with demonstrated demand -----------------------
  const stockedOut = active.filter((i) => i.current_stock === 0 && i.sales_velocity > 0);
  if (stockedOut.length > 0) {
    // Lost revenue while the shelf is empty, over a 7-day replenishment horizon.
    const lostPerWeek = stockedOut.reduce(
      (s, i) => s + i.sales_velocity * 7 * i.selling_price,
      0,
    );
    const worst = [...stockedOut].sort((a, b) => b.sales_velocity - a.sales_velocity).slice(0, 3);

    out.push(
      build(
        {
          id: 'stock-out',
          type: 'STOCK_OUT',
          title: 'Products out of stock with active demand',
          description: `${plural(stockedOut.length, 'product')} sold recently but now have zero sellable stock. Every day they stay empty is revenue walking out of the door.`,
          metric: stockedOut.length,
          metricLabel: 'products out of stock',
          recommendation: `Raise a purchase order today for these ${stockedOut.length} products. Start with ${worst.map((w) => w.product_name).join(', ')} - they have the highest daily demand.`,
          reason: `${stockedOut.length} active products have current_stock = 0 while still showing sales velocity above 0 over the last ${getThresholds().analysisWindowDays} days. At their recent rate of sale they would have sold roughly ${currency(lostPerWeek)} in the next 7 days.`,
          evidence: [
            { label: 'Products affected', value: String(stockedOut.length) },
            { label: 'Combined daily demand', value: `${round1(stockedOut.reduce((s, i) => s + i.sales_velocity, 0))} units/day` },
            { label: 'Estimated 7-day revenue lost', value: currency(lostPerWeek) },
            { label: 'Highest demand', value: `${worst[0].product_name} (${round1(worst[0].sales_velocity)} units/day)` },
          ],
          valueAtStake: lostPerWeek,
          daysUntilConsequence: 0, // already happening
          link: '/inventory/low-stock',
          linkLabel: 'View low stock',
        },
        anchor,
      ),
    );
  }

  // --- Rule 2: at or below reorder level, still holding stock ---------------
  const reorder = active.filter((i) => i.needs_reorder && i.current_stock > 0);
  if (reorder.length > 0) {
    const lostPerWeek = reorder.reduce((s, i) => s + i.sales_velocity * 7 * i.selling_price, 0);
    // Urgency is driven by the product that runs out soonest.
    const coverages = reorder
      .map((i) => i.stock_coverage_days)
      .filter((d): d is number => d !== null);
    const soonest = coverages.length ? Math.min(...coverages) : 30;
    const critical = reorder.filter(
      (i) => i.stock_coverage_days !== null && i.stock_coverage_days <= getThresholds().criticalCoverageDays,
    );

    out.push(
      build(
        {
          id: 'reorder',
          type: 'REORDER',
          title: 'Products below reorder level',
          description: `${plural(reorder.length, 'product')} have fallen to or below their configured reorder level. ${critical.length} of them will run out within ${getThresholds().criticalCoverageDays} days.`,
          metric: reorder.length,
          metricLabel: 'products need replenishment',
          recommendation: `Create a purchase order covering these ${reorder.length} products. The suggested order quantity for each is shown on the Low Stock screen, calculated to top stock back up to its maximum level.`,
          reason: `Each of these ${reorder.length} products satisfies current_stock <= reorder_level. The shortest stock coverage in the group is ${round1(soonest)} days, calculated as current_stock / sales_velocity.`,
          evidence: [
            { label: 'Products below reorder level', value: String(reorder.length) },
            { label: 'Running out within 7 days', value: String(critical.length) },
            { label: 'Shortest stock coverage', value: `${round1(soonest)} days` },
            { label: 'Revenue at risk over 7 days', value: currency(lostPerWeek) },
          ],
          valueAtStake: lostPerWeek,
          daysUntilConsequence: soonest,
          link: '/inventory/low-stock',
          linkLabel: 'View low stock',
        },
        anchor,
      ),
    );
  }

  // --- Rule 13: overstock ---------------------------------------------------
  const overstocked = active.filter(
    (i) => i.maximum_stock > 0 && i.current_stock > i.maximum_stock * getThresholds().overstockMultiplier,
  );
  if (overstocked.length > 0) {
    const excessValue = overstocked.reduce(
      (s, i) => s + (i.current_stock - i.maximum_stock) * i.purchase_price,
      0,
    );
    out.push(
      build(
        {
          id: 'overstock',
          type: 'OVERSTOCK',
          title: 'Capital tied up in overstocked lines',
          description: `${plural(overstocked.length, 'product')} are holding more stock than their configured maximum. That is working capital sitting on a shelf.`,
          metric: round2(excessValue),
          metricLabel: 'excess stock value',
          recommendation: 'Pause reordering these lines until stock normalises. Review whether the maximum stock levels are set correctly, or whether demand has fallen since they were set.',
          reason: `${overstocked.length} products have current_stock above maximum_stock. The excess above maximum, valued at purchase cost, is ${currency(excessValue)}.`,
          evidence: [
            { label: 'Overstocked products', value: String(overstocked.length) },
            { label: 'Excess units', value: String(overstocked.reduce((s, i) => s + (i.current_stock - i.maximum_stock), 0)) },
            { label: 'Excess value at cost', value: currency(excessValue) },
          ],
          valueAtStake: excessValue,
          daysUntilConsequence: 60, // inefficient, but nothing worsens tomorrow
          link: '/inventory/stock',
          linkLabel: 'Review stock',
        },
        anchor,
      ),
    );
  }

  return out;
}

/**
 * Rules 3, 4 & 5 - expiry exposure.
 *
 * Split into three separate insights rather than one, because the actions are
 * genuinely different: expired stock must be written off, 30-day stock needs a
 * clearance decision now, 90-day stock needs a purchasing decision.
 */
function expiryRules(anchor: number): Insight[] {
  const out: Insight[] = [];
  const t = getThresholds();

  const valueOf = (batches: BatchWithContext[]) =>
    batches.reduce((s, b) => s + b.quantity * b.purchase_price, 0);

  // --- Rule 5: already expired, still on the shelf --------------------------
  const expired = getExpiredBatches();
  if (expired.length > 0) {
    const value = valueOf(expired);
    out.push(
      build(
        {
          id: 'expired-stock',
          type: 'EXPIRED_STOCK',
          title: 'Expired stock still recorded in inventory',
          description: `${plural(expired.length, 'batch', 'batches')} have passed their expiry date but still show quantity on hand. This stock is already a loss and must not be dispensed.`,
          metric: round2(value),
          metricLabel: 'expired stock value',
          recommendation: 'Physically quarantine these batches and write them off from the Expiry screen. The system already blocks them from being sold, but they are still inflating your reported inventory value.',
          reason: `${expired.length} batches have expiry_date earlier than today with quantity > 0. Valued at purchase cost, the write-off is ${currency(value)}. FEFO allocation already excludes them from sale.`,
          evidence: [
            { label: 'Expired batches', value: String(expired.length) },
            { label: 'Units affected', value: String(expired.reduce((s, b) => s + b.quantity, 0)) },
            { label: 'Write-off value at cost', value: currency(value) },
            { label: 'Longest expired', value: `${Math.abs(Math.min(...expired.map((b) => b.days_to_expiry)))} days ago` },
          ],
          valueAtStake: value,
          daysUntilConsequence: 0,
          link: '/inventory/expiry',
          linkLabel: 'Review expiry',
        },
        anchor,
      ),
    );
  }

  const expiring = getExpiringBatches(t.expiryWarningDays);

  // --- Rule 3: expiring within the critical window --------------------------
  const critical = expiring.filter((b) => b.days_to_expiry <= t.expiryCriticalDays);
  if (critical.length > 0) {
    const value = valueOf(critical);
    const soonest = Math.min(...critical.map((b) => b.days_to_expiry));
    out.push(
      build(
        {
          id: 'expiry-critical',
          type: 'EXPIRY_CRITICAL',
          title: `Batches expiring within ${t.expiryCriticalDays} days`,
          description: `${plural(critical.length, 'batch', 'batches')} expire within ${t.expiryCriticalDays} days. Without action this becomes a certain write-off.`,
          metric: round2(value),
          metricLabel: 'value at risk',
          recommendation: 'Decide now: push these batches through a promotion, return them to the supplier if the terms allow, or accept the write-off. FEFO is already dispensing them first.',
          reason: `${critical.length} batches with stock on hand have expiry_date within ${t.expiryCriticalDays} days. The earliest expires in ${soonest} days. Combined value at purchase cost is ${currency(value)}.`,
          evidence: [
            { label: 'Batches expiring', value: String(critical.length) },
            { label: 'Earliest expiry', value: `${soonest} days` },
            { label: 'Units at risk', value: String(critical.reduce((s, b) => s + b.quantity, 0)) },
            { label: 'Value at cost', value: currency(value) },
          ],
          valueAtStake: value,
          daysUntilConsequence: soonest,
          link: '/inventory/expiry',
          linkLabel: 'Review expiry',
        },
        anchor,
      ),
    );
  }

  // --- Rule 4: expiring in the warning window -------------------------------
  const warning = expiring.filter((b) => b.days_to_expiry > t.expiryCriticalDays);
  if (warning.length > 0) {
    const value = valueOf(warning);
    const soonest = Math.min(...warning.map((b) => b.days_to_expiry));
    out.push(
      build(
        {
          id: 'expiry-warning',
          type: 'EXPIRY_WARNING',
          title: `Batches expiring within ${t.expiryWarningDays} days`,
          description: `${plural(warning.length, 'batch', 'batches')} expire in ${t.expiryCriticalDays + 1}-${t.expiryWarningDays} days. There is still time to sell through them.`,
          metric: round2(value),
          metricLabel: 'value at risk',
          recommendation: 'Stop reordering these products until the existing batches clear. Check that FEFO is not being bypassed by manual batch selection at the counter.',
          reason: `${warning.length} batches with stock on hand expire between ${t.expiryCriticalDays + 1} and ${t.expiryWarningDays} days from today. Combined value at purchase cost is ${currency(value)}.`,
          evidence: [
            { label: 'Batches in window', value: String(warning.length) },
            { label: 'Earliest expiry', value: `${soonest} days` },
            { label: 'Units at risk', value: String(warning.reduce((s, b) => s + b.quantity, 0)) },
            { label: 'Value at cost', value: currency(value) },
          ],
          valueAtStake: value,
          daysUntilConsequence: soonest,
          link: '/inventory/expiry',
          linkLabel: 'Review expiry',
        },
        anchor,
      ),
    );
  }

  return out;
}

/** Rule 6 - dead stock: capital trapped in products nothing is buying. */
function deadStockRule(items: InventoryItem[], anchor: number): Insight[] {
  const t = getThresholds();
  const dead = items.filter(
    (i) =>
      i.status === 'ACTIVE' &&
      i.current_stock > 0 &&
      (i.days_since_last_sale === null || i.days_since_last_sale >= t.deadStockDays),
  );
  if (dead.length === 0) return [];

  const value = dead.reduce((s, i) => s + i.inventory_value, 0);
  const neverSold = dead.filter((i) => i.days_since_last_sale === null);
  const worst = [...dead].sort((a, b) => b.inventory_value - a.inventory_value).slice(0, 3);

  return [
    build(
      {
        id: 'dead-stock',
        type: 'DEAD_STOCK',
        title: 'Dead stock is holding working capital',
        description: `${plural(dead.length, 'product')} have stock on hand but no sale in ${t.deadStockDays}+ days. ${currency(value)} of capital is not turning.`,
        metric: round2(value),
        metricLabel: 'capital trapped',
        recommendation: `Clear these lines: bundle them with fast movers, discount them, or negotiate a return with the supplier. Then reduce or remove their reorder levels so they do not get bought again. Start with ${worst.map((w) => w.product_name).join(', ')} - they hold the most value.`,
        reason: `${dead.length} active products have current_stock > 0 and no sale within the last ${t.deadStockDays} days (${neverSold.length} have never sold at all). Their combined inventory value at purchase cost is ${currency(value)}.`,
        evidence: [
          { label: 'Dead stock products', value: String(dead.length) },
          { label: 'Never sold', value: String(neverSold.length) },
          { label: 'Units held', value: String(dead.reduce((s, i) => s + i.current_stock, 0)) },
          { label: 'Capital at cost', value: currency(value) },
          { label: 'Largest single holding', value: `${worst[0].product_name} (${currency(worst[0].inventory_value)})` },
        ],
        valueAtStake: value,
        // Capital is trapped, but nothing gets worse tomorrow - lowest urgency.
        daysUntilConsequence: URGENCY_HORIZON_DAYS,
        link: '/analytics/products',
        linkLabel: 'Review dead stock',
      },
      anchor,
    ),
  ];
}

/** Rules 7 & 8 - overall sales trend, reported in both directions. */
function salesTrendRules(anchor: number): Insight[] {
  const t = getThresholds();
  const days = t.analysisWindowDays;
  const growth = getSalesGrowth(days);
  const change = growth.revenueGrowthPct;

  // No previous period to compare against - stay silent rather than report noise.
  if (growth.previous.revenue === 0 && growth.current.revenue === 0) return [];
  if (Math.abs(change) < t.salesGrowthThresholdPct) return [];

  const delta = growth.current.revenue - growth.previous.revenue;
  const rising = change > 0;

  return [
    build(
      {
        id: rising ? 'sales-growth' : 'sales-decline',
        type: rising ? 'SALES_GROWTH' : 'SALES_DECLINE',
        title: rising
          ? `Sales grew ${pct(change)} over the last ${days} days`
          : `Sales fell ${pct(change)} over the last ${days} days`,
        description: rising
          ? `Revenue rose from ${currency(growth.previous.revenue)} to ${currency(growth.current.revenue)} against the previous ${days}-day period. Transactions moved ${pct(growth.transactionGrowthPct)}.`
          : `Revenue fell from ${currency(growth.previous.revenue)} to ${currency(growth.current.revenue)} against the previous ${days}-day period. Transactions moved ${pct(growth.transactionGrowthPct)}.`,
        metric: change,
        metricLabel: 'revenue growth',
        recommendation: rising
          ? 'Identify which categories drove the increase and make sure those lines stay in stock - growth is easiest to lose to a stock-out. Check the Category Sales breakdown.'
          : 'Check whether the fall is demand or availability. If stock-outs rose over the same period, the decline is self-inflicted and fixable through purchasing.',
        reason: `Net revenue for ${growth.currentRange.from} to ${growth.currentRange.to} was ${currency(growth.current.revenue)}, against ${currency(growth.previous.revenue)} for the equal-length preceding window ${growth.previousRange.from} to ${growth.previousRange.to}. That is a change of ${pct(change)}, beyond the ${t.salesGrowthThresholdPct}% reporting threshold.`,
        evidence: [
          { label: 'Current period revenue', value: currency(growth.current.revenue) },
          { label: 'Previous period revenue', value: currency(growth.previous.revenue) },
          { label: 'Change', value: `${pct(change)} (${currency(delta)})` },
          { label: 'Transactions', value: `${growth.current.transactions} vs ${growth.previous.transactions} (${pct(growth.transactionGrowthPct)})` },
          { label: 'Average bill value', value: `${currency(growth.current.averageBillValue)} vs ${currency(growth.previous.averageBillValue)}` },
        ],
        valueAtStake: Math.abs(delta),
        daysUntilConsequence: 30, // a trend is a decision for this month
        link: '/analytics/sales',
        linkLabel: 'View sales analytics',
      },
      anchor,
    ),
  ];
}

/** Rule 9 - category-level movement, reported for the single biggest mover each way. */
function categoryTrendRules(anchor: number): Insight[] {
  const CATEGORY_THRESHOLD_PCT = 15;
  const days = getThresholds().analysisWindowDays;
  const categories = getCategorySales(days).filter((c) => c.previousRevenue > 0 || c.revenue > 0);
  if (categories.length === 0) return [];

  const out: Insight[] = [];
  const movers = categories.filter((c) => Math.abs(c.growthPct) >= CATEGORY_THRESHOLD_PCT);

  const emit = (c: (typeof categories)[number], rising: boolean) => {
    const delta = c.revenue - c.previousRevenue;
    out.push(
      build(
        {
          id: `category-${rising ? 'growth' : 'decline'}-${c.category.toLowerCase().replace(/\W+/g, '-')}`,
          type: 'CATEGORY_TREND',
          title: rising
            ? `${c.category} sales up ${pct(c.growthPct)}`
            : `${c.category} sales down ${pct(c.growthPct)}`,
          description: `${c.category} moved from ${currency(c.previousRevenue)} to ${currency(c.revenue)} over the last ${days} days, at a ${c.marginPct}% gross margin. It is ${c.revenueSharePct}% of total revenue.`,
          metric: c.growthPct,
          metricLabel: 'category growth',
          recommendation: rising
            ? `Protect this momentum: check that the fast-moving lines in ${c.category} have enough stock coverage to hold the growth through the next purchase cycle.`
            : `Investigate ${c.category}. Compare it against stock availability for the period - a category rarely declines while it is fully in stock and competitively priced.`,
          reason: `${c.category} net revenue over the trailing ${days} days was ${currency(c.revenue)} against ${currency(c.previousRevenue)} in the preceding ${days} days, a change of ${pct(c.growthPct)}. That exceeds the ${CATEGORY_THRESHOLD_PCT}% category reporting threshold.`,
          evidence: [
            { label: 'Category', value: c.category },
            { label: 'Current revenue', value: currency(c.revenue) },
            { label: 'Previous revenue', value: currency(c.previousRevenue) },
            { label: 'Change', value: `${pct(c.growthPct)} (${currency(delta)})` },
            { label: 'Gross margin', value: `${c.marginPct}%` },
            { label: 'Share of total revenue', value: `${c.revenueSharePct}%` },
          ],
          valueAtStake: Math.abs(delta),
          daysUntilConsequence: 30,
          link: '/analytics/sales',
          linkLabel: 'View category',
        },
        anchor,
      ),
    );
  };

  // Only the biggest mover in each direction, so one noisy month cannot flood
  // the dashboard with ten category cards.
  const gainers = movers.filter((c) => c.growthPct > 0).sort((a, b) => b.revenue - a.revenue);
  const losers = movers.filter((c) => c.growthPct < 0).sort((a, b) => b.previousRevenue - a.previousRevenue);
  if (gainers[0]) emit(gainers[0], true);
  if (losers[0]) emit(losers[0], false);

  return out;
}

/** Rule 10 - margin erosion, measured in percentage points. */
function marginRule(anchor: number): Insight[] {
  const MARGIN_POINT_THRESHOLD = 2;
  const days = getThresholds().analysisWindowDays;
  const comparison = getProfitComparison(days);
  const drop = comparison.marginChangePoints;

  if (comparison.previous.revenue === 0) return [];
  if (drop > -MARGIN_POINT_THRESHOLD) return [];

  // Money lost purely to the margin move, holding revenue constant.
  const valueAtStake = comparison.current.revenue * (Math.abs(drop) / 100);

  return [
    build(
      {
        id: 'margin-erosion',
        type: 'MARGIN_EROSION',
        title: `Gross margin fell ${round1(Math.abs(drop))} percentage points`,
        description: `Margin moved from ${comparison.previous.grossMarginPct}% to ${comparison.current.grossMarginPct}% over the last ${days} days. At current revenue that is roughly ${currency(valueAtStake)} of gross profit.`,
        metric: drop,
        metricLabel: 'margin change (points)',
        recommendation: 'Check three things in order: purchase prices that rose without a matching selling price update, discounting at the counter, and a shift in mix towards lower-margin categories. The Profit Analytics page separates all three.',
        reason: `Gross margin over the trailing ${days} days is ${comparison.current.grossMarginPct}%, against ${comparison.previous.grossMarginPct}% in the preceding window - a fall of ${round1(Math.abs(drop))} percentage points, beyond the ${MARGIN_POINT_THRESHOLD}-point reporting threshold. Applied to current revenue of ${currency(comparison.current.revenue)}, that is ${currency(valueAtStake)} of gross profit.`,
        evidence: [
          { label: 'Current margin', value: `${comparison.current.grossMarginPct}%` },
          { label: 'Previous margin', value: `${comparison.previous.grossMarginPct}%` },
          { label: 'Change', value: `${round1(drop)} points` },
          { label: 'Current revenue', value: currency(comparison.current.revenue) },
          { label: 'Current gross profit', value: currency(comparison.current.grossProfit) },
          { label: 'Previous gross profit', value: currency(comparison.previous.grossProfit) },
        ],
        valueAtStake,
        daysUntilConsequence: 30,
        link: '/analytics/profit',
        linkLabel: 'View profit analytics',
      },
      anchor,
    ),
  ];
}

/** Rule 11 - revenue concentration: dependence on very few products. */
function concentrationRule(anchor: number): Insight[] {
  const CONCENTRATION_THRESHOLD_PCT = 40;
  const days = getThresholds().analysisWindowDays;
  const top5 = getRevenueConcentration(days, 5);

  if (top5.totalRevenue === 0) return [];
  if (top5.concentrationPct < CONCENTRATION_THRESHOLD_PCT) return [];

  return [
    build(
      {
        id: 'revenue-concentration',
        type: 'REVENUE_CONCENTRATION',
        title: `Top 5 products carry ${top5.concentrationPct}% of revenue`,
        description: `${currency(top5.topRevenue)} of ${currency(top5.totalRevenue)} in the last ${days} days came from just 5 products. A stock-out in any one of them hits revenue disproportionately.`,
        metric: top5.concentrationPct,
        metricLabel: 'top-5 revenue share',
        recommendation: 'Treat these five as never-out-of-stock lines: give them higher reorder levels and a second supplier where possible. Separately, work on broadening the range so the business is less exposed to five SKUs.',
        reason: `Over the trailing ${days} days the top 5 products by revenue produced ${currency(top5.topRevenue)} of ${currency(top5.totalRevenue)} total, or ${top5.concentrationPct}%. That is above the ${CONCENTRATION_THRESHOLD_PCT}% concentration threshold.`,
        evidence: [
          { label: 'Top 5 share', value: `${top5.concentrationPct}%` },
          { label: 'Top 5 revenue', value: currency(top5.topRevenue) },
          { label: 'Total revenue', value: currency(top5.totalRevenue) },
          ...top5.products.slice(0, 5).map((p, i) => ({
            label: `#${i + 1}`,
            value: `${p.product_name} - ${currency(p.revenue)} (${p.sharePct}%)`,
          })),
        ],
        // Exposure is measured as one week of the concentrated revenue.
        valueAtStake: safeDiv(top5.topRevenue, days) * 7,
        daysUntilConsequence: 45,
        link: '/analytics/products',
        linkLabel: 'View product analytics',
      },
      anchor,
    ),
  ];
}

/** Rule 12 - low inventory turnover: the business is over-invested in stock. */
function turnoverRule(anchor: number): Insight[] {
  const TURNOVER_FLOOR = 6;
  const turnover = getInventoryTurnover(90);

  if (turnover.cogs === 0 || turnover.averageInventory === 0) return [];
  if (turnover.annualisedTurnover >= TURNOVER_FLOOR) return [];

  // Capital that would be released by reaching the target turn rate.
  const targetInventory = safeDiv(turnover.cogs * (365 / turnover.windowDays), TURNOVER_FLOOR);
  const excessCapital = Math.max(0, turnover.averageInventory - targetInventory);

  return [
    build(
      {
        id: 'low-turnover',
        type: 'LOW_TURNOVER',
        title: `Inventory turns only ${turnover.annualisedTurnover} times a year`,
        description: `A retail pharmacy typically targets 8-12 annual turns. At ${turnover.annualisedTurnover}, stock is sitting for around ${turnover.daysOfInventory ?? '-'} days before it sells.`,
        metric: turnover.annualisedTurnover,
        metricLabel: 'annualised turnover',
        recommendation: `Reaching ${TURNOVER_FLOOR} turns would release roughly ${currency(excessCapital)} of working capital. Start with the dead stock and overstocked lines - they are where the excess actually sits.`,
        reason: `Over the last ${turnover.windowDays} days, COGS was ${currency(turnover.cogs)} against average inventory of ${currency(turnover.averageInventory)}, giving ${turnover.turnover} turns for the period and ${turnover.annualisedTurnover} annualised. That is below the ${TURNOVER_FLOOR}-turn floor. Method: ${turnover.method}`,
        evidence: [
          { label: 'Annualised turnover', value: `${turnover.annualisedTurnover}x` },
          { label: 'Period turnover', value: `${turnover.turnover}x over ${turnover.windowDays} days` },
          { label: 'COGS in period', value: currency(turnover.cogs) },
          { label: 'Average inventory', value: currency(turnover.averageInventory) },
          { label: 'Days of inventory', value: turnover.daysOfInventory !== null ? `${turnover.daysOfInventory} days` : '-' },
          { label: 'Capital released at 6 turns', value: currency(excessCapital) },
        ],
        valueAtStake: excessCapital,
        daysUntilConsequence: 75, // structural, not urgent
        link: '/analytics/inventory',
        linkLabel: 'View inventory analytics',
      },
      anchor,
    ),
  ];
}

/** Rule 14 - a top-velocity product whose coverage is about to run out. */
function fastMoverRule(anchor: number): Insight[] {
  const COVERAGE_FLOOR_DAYS = 14;
  const days = getThresholds().analysisWindowDays;
  const performance = getProductPerformance(days);

  const atRisk = performance
    .filter(
      (p) =>
        p.salesVelocity > 0 &&
        p.currentStock > 0 &&
        p.stockCoverageDays !== null &&
        p.stockCoverageDays < COVERAGE_FLOOR_DAYS,
    )
    // Rank by the revenue actually exposed, not by velocity alone.
    .sort((a, b) => b.revenue - a.revenue);

  if (atRisk.length === 0) return [];

  const top = atRisk[0];
  const exposure = atRisk.reduce((s, p) => s + p.salesVelocity * 14 * safeDiv(p.revenue, Math.max(1, p.unitsSold)), 0);

  return [
    build(
      {
        id: 'fast-mover-coverage',
        type: 'FAST_MOVER_OPPORTUNITY',
        title: 'Fast movers running low on coverage',
        description: `${plural(atRisk.length, 'high-velocity product')} have under ${COVERAGE_FLOOR_DAYS} days of stock coverage. These are the lines that actually earn the revenue.`,
        metric: atRisk.length,
        metricLabel: 'fast movers at risk',
        recommendation: `Prioritise these on the next purchase order ahead of slower lines. ${top.product_name} is the largest exposure at ${currency(top.revenue)} of revenue over ${days} days with only ${round1(top.stockCoverageDays ?? 0)} days of cover.`,
        reason: `${atRisk.length} products with sales velocity above 0 have stock_coverage_days (current_stock / sales_velocity) below ${COVERAGE_FLOOR_DAYS}. Combined, they produced ${currency(atRisk.reduce((s, p) => s + p.revenue, 0))} over the last ${days} days.`,
        evidence: [
          { label: 'Products at risk', value: String(atRisk.length) },
          { label: 'Largest exposure', value: top.product_name },
          { label: 'Its velocity', value: `${round1(top.salesVelocity)} units/day` },
          { label: 'Its coverage', value: `${round1(top.stockCoverageDays ?? 0)} days` },
          { label: 'Its stock', value: `${top.currentStock} units` },
          { label: `Revenue from these lines (${days} days)`, value: currency(atRisk.reduce((s, p) => s + p.revenue, 0)) },
        ],
        valueAtStake: exposure,
        daysUntilConsequence: Math.min(...atRisk.map((p) => p.stockCoverageDays ?? COVERAGE_FLOOR_DAYS)),
        link: '/analytics/products',
        linkLabel: 'View product analytics',
      },
      anchor,
    ),
  ];
}

// --------------------------------------------------------------------------
// Engine
// --------------------------------------------------------------------------

export interface AnalystReport {
  generatedAt: string;
  /** The self-calibrating scale used by every Impact score in this run. */
  impactAnchor: number;
  insights: Insight[];
  counts: Record<InsightSeverity, number>;
  headline: string;
  /** Context figures the dashboard shows alongside the insights. */
  context: {
    healthScore: number;
    healthGrade: string;
    inventoryValue: number;
    revenue30d: number;
    grossMargin30d: number;
    skus: number;
  };
}

/**
 * Runs every rule and returns insights ranked by priority score.
 *
 * Rules are independent and side-effect free: each reads the database and either
 * emits an insight or stays silent. Adding a rule means adding one function and
 * one line here - nothing else in the system needs to know about it.
 */
export function runAnalysis(): AnalystReport {
  const t = getThresholds();
  const growth = getSalesGrowth(t.analysisWindowDays);
  const revenue30d = growth.current.revenue;

  // The scale against which every Impact score in this run is measured.
  const anchor = Math.max(IMPACT_ANCHOR_FLOOR, revenue30d * IMPACT_ANCHOR_REVENUE_SHARE);

  // Fetched once and shared - getInventory() is the most expensive read here.
  const items = getInventory();

  const insights = [
    ...stockRules(items, anchor),
    ...expiryRules(anchor),
    ...deadStockRule(items, anchor),
    ...salesTrendRules(anchor),
    ...categoryTrendRules(anchor),
    ...marginRule(anchor),
    ...concentrationRule(anchor),
    ...turnoverRule(anchor),
    ...fastMoverRule(anchor),
  ].sort((a, b) => b.priorityScore - a.priorityScore);

  const counts: Record<InsightSeverity, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const i of insights) counts[i.severity] += 1;

  const health = getInventoryHealthScore();
  const summary = getInventorySummary();

  return {
    generatedAt: new Date().toISOString(),
    impactAnchor: round2(anchor),
    insights,
    counts,
    headline: buildHeadline(insights, counts),
    context: {
      healthScore: health.score,
      healthGrade: health.grade,
      inventoryValue: summary.inventoryValueAtCost,
      revenue30d: round2(revenue30d),
      grossMargin30d: growth.current.grossMarginPct,
      skus: summary.activeSkus,
    },
  };
}

function buildHeadline(insights: Insight[], counts: Record<InsightSeverity, number>): string {
  if (insights.length === 0) {
    return 'No issues detected. Stock levels, expiry exposure and margin are all within their configured thresholds.';
  }
  if (counts.CRITICAL > 0) {
    const verb = counts.CRITICAL === 1 ? 'needs' : 'need';
    return `${plural(counts.CRITICAL, 'critical issue')} ${verb} attention today. Highest priority: ${insights[0].title.toLowerCase()}.`;
  }
  if (counts.HIGH > 0) {
    return `${plural(counts.HIGH, 'high-priority item')} to review this week. Start with: ${insights[0].title.toLowerCase()}.`;
  }
  return `${plural(insights.length, 'observation')} worth reviewing. Nothing is urgent.`;
}

/** The top N insights, for the dashboard panel. */
export function getTopInsights(limit = 5): Insight[] {
  return runAnalysis().insights.slice(0, limit);
}

/** One insight by id, for the detail drawer. */
export function getInsight(id: string): Insight | null {
  return runAnalysis().insights.find((i) => i.id === id) ?? null;
}
