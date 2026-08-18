/**
 * Shared SQL fragments for revenue accounting.
 *
 * Every analytic in this folder measures the same thing the same way, so the
 * dashboard, the Analytics pages, the Reports and the Mini Analyst can never
 * disagree with each other.
 *
 * Definitions (see docs/ANALYTICS_METHODOLOGY.md):
 *
 *   net_units    = quantity - returned_quantity
 *   NET_REVENUE  = (selling_price x quantity - discount) x net_units / quantity
 *                  i.e. the discounted, pre-tax value of units the customer kept
 *   NET_COGS     = purchase_price(batch) x net_units
 *   Gross Profit = NET_REVENUE - NET_COGS
 *
 * Revenue is measured NET OF TAX because tax collected is not the pharmacy's
 * income, and NET OF RETURNS because returned units were not really sold.
 */

export const NET_UNITS = '(si.quantity - si.returned_quantity)';

export const NET_REVENUE =
  '((si.selling_price * si.quantity - si.discount) * (si.quantity - si.returned_quantity) / CAST(si.quantity AS REAL))';

export const NET_COGS = '(si.purchase_price * (si.quantity - si.returned_quantity))';

export const NET_TAX =
  '(si.tax * (si.quantity - si.returned_quantity) / CAST(si.quantity AS REAL))';

/** Cancelled sales never count towards any figure. */
export const LIVE_SALE = "s.status <> 'CANCELLED'";

export interface DateRange {
  from: string;
  to: string;
}
