import { round2, safeDiv } from '../utils/money';

/**
 * THE SCHEME ENGINE
 * =================
 *
 * Indian pharmaceutical distribution runs on free-goods schemes, not just
 * headline prices. A distributor quoting a HIGHER rate with a better scheme can
 * be the cheaper option, and buying on quoted rate alone is the single most
 * common purchasing mistake this module exists to prevent.
 *
 * The number that matters is EFFECTIVE COST:
 *
 *     Effective Cost = Net Amount Payable / Total Units Received
 *
 * where total units received includes the free goods.
 *
 * Worked example - the case in the brief:
 *
 *     PTS ₹41, scheme 10+1, order 100 units
 *       free units      = floor(100 / 10) x 1        = 10
 *       units received  = 100 + 10                   = 110
 *       gross           = 100 x 41                   = ₹4,100
 *       discount        = 0
 *       net payable     = ₹4,100
 *       EFFECTIVE COST  = 4,100 / 110                = ₹37.27
 *
 * Against a competitor at a flat ₹39 with no scheme, the ₹41 quote is cheaper
 * per unit actually received. That is the insight the comparison screen exists
 * to surface.
 *
 * Note on the free-goods convention: "10+1" is read as *buy 10, get 1 free*, so
 * the buyer pays for 10 and receives 11. Free units are computed on completed
 * multiples of the buy quantity only - ordering 15 under a 10+1 scheme yields 1
 * free unit, not 1.5.
 */

export interface SchemeInput {
  /** Units the pharmacy is paying for (invoice quantity). */
  quantity: number;
  /** Rate per unit charged on the invoice - normally PTS or PTR. */
  rate: number;
  /** Free-goods scheme: buy this many... */
  schemeBuyQty?: number;
  /** ...and receive this many free. */
  schemeFreeQty?: number;
  /** Percentage discount applied to the gross value. */
  discountPct?: number;
  /** Flat amount off, applied after the percentage discount. */
  flatDiscount?: number;
  /** GST rate for the line, applied to the discounted taxable value. */
  gstRate?: number;
}

export interface SchemeResult {
  /** Units invoiced (paid for). */
  invoiceQty: number;
  /** Units received free under the scheme. */
  freeQty: number;
  /** invoiceQty + freeQty - what actually arrives on the shelf. */
  totalUnits: number;
  rate: number;
  /** quantity x rate, before any discount. */
  grossAmount: number;
  /** Percentage discount in rupees. */
  discountAmount: number;
  /** Flat discount in rupees. */
  flatDiscount: number;
  /** Amount tax is charged on. */
  taxableAmount: number;
  gstRate: number;
  taxAmount: number;
  /** taxableAmount + taxAmount - the invoice total for this line. */
  netAmount: number;
  /**
   * Net amount payable divided by total units received.
   *
   * Computed EXCLUDING GST, because GST is recoverable input credit for a
   * registered pharmacy - including it would overstate the true cost of goods
   * and make the comparison against a differently-taxed product meaningless.
   */
  effectiveCost: number;
  /** Effective cost including tax, shown where cash outflow is the question. */
  effectiveCostWithTax: number;
  /** Rupee value of what the scheme and discounts saved against a plain buy. */
  savings: number;
  /** Savings as a percentage of the undiscounted, scheme-free cost. */
  savingsPct: number;
  /** Human-readable scheme label, e.g. '10+1' or '5% off' or 'No scheme'. */
  schemeLabel: string;
}

/** Renders a scheme as the label a pharmacist would recognise on an invoice. */
export function schemeLabel(
  buyQty?: number | null,
  freeQty?: number | null,
  discountPct?: number | null,
): string {
  const parts: string[] = [];
  if (buyQty && freeQty && buyQty > 0 && freeQty > 0) parts.push(`${buyQty}+${freeQty}`);
  if (discountPct && discountPct > 0) parts.push(`${round2(discountPct)}% off`);
  return parts.length > 0 ? parts.join(' · ') : 'No scheme';
}

/**
 * Free units earned on `quantity` under a buy/free scheme.
 * Only completed multiples of the buy quantity qualify.
 */
export function freeUnitsFor(quantity: number, buyQty?: number | null, freeQty?: number | null): number {
  if (!buyQty || !freeQty || buyQty <= 0 || freeQty <= 0 || quantity <= 0) return 0;
  return Math.floor(quantity / buyQty) * freeQty;
}

/** Full costing for one purchase line. */
export function calculateScheme(input: SchemeInput): SchemeResult {
  const invoiceQty = Math.max(0, Math.floor(input.quantity));
  const rate = Math.max(0, input.rate);
  const buyQty = input.schemeBuyQty ?? 0;
  const schemeFree = input.schemeFreeQty ?? 0;
  const discountPct = Math.min(100, Math.max(0, input.discountPct ?? 0));
  const flat = Math.max(0, input.flatDiscount ?? 0);
  const gstRate = Math.max(0, input.gstRate ?? 0);

  const freeQty = freeUnitsFor(invoiceQty, buyQty, schemeFree);
  const totalUnits = invoiceQty + freeQty;

  const grossAmount = round2(invoiceQty * rate);
  const discountAmount = round2(grossAmount * (discountPct / 100));
  // A flat discount can never take the line below zero.
  const flatDiscount = round2(Math.min(flat, grossAmount - discountAmount));

  const taxableAmount = round2(grossAmount - discountAmount - flatDiscount);
  const taxAmount = round2(taxableAmount * (gstRate / 100));
  const netAmount = round2(taxableAmount + taxAmount);

  // The comparison baseline: what these units would have cost at list rate with
  // no scheme and no discount. Free goods are the main contributor.
  const baselineCost = round2(totalUnits * rate);
  const savings = round2(baselineCost - taxableAmount);

  return {
    invoiceQty,
    freeQty,
    totalUnits,
    rate: round2(rate),
    grossAmount,
    discountAmount,
    flatDiscount,
    taxableAmount,
    gstRate,
    taxAmount,
    netAmount,
    effectiveCost: round2(safeDiv(taxableAmount, totalUnits)),
    effectiveCostWithTax: round2(safeDiv(netAmount, totalUnits)),
    savings,
    savingsPct: round2(safeDiv(savings, baselineCost) * 100),
    schemeLabel: schemeLabel(buyQty, schemeFree, discountPct),
  };
}

/** Alias kept for call-site readability where a "line" is being priced. */
export const priceLine = calculateScheme;

/**
 * Suggested order quantity that lands exactly on a scheme boundary.
 *
 * A pharmacy needing 47 units under a 10+1 scheme is usually better off
 * ordering 50: it pays for 3 more units and receives 5 free. This rounds UP to
 * the next multiple, but only when the stretch is modest (within one buy block),
 * so it never inflates an order just to chase a scheme.
 */
export function optimiseOrderQty(
  requiredQty: number,
  buyQty?: number | null,
  freeQty?: number | null,
): { quantity: number; freeQty: number; adjusted: boolean; reason: string } {
  const base = Math.max(0, Math.ceil(requiredQty));
  if (!buyQty || !freeQty || buyQty <= 0 || freeQty <= 0) {
    return { quantity: base, freeQty: 0, adjusted: false, reason: 'No scheme available.' };
  }

  const remainder = base % buyQty;
  if (remainder === 0) {
    return {
      quantity: base,
      freeQty: freeUnitsFor(base, buyQty, freeQty),
      adjusted: false,
      reason: `Order already lands on the ${buyQty}+${freeQty} scheme boundary.`,
    };
  }

  const topUp = buyQty - remainder;
  // Only stretch when the extra is less than half a block - otherwise the
  // pharmacy is buying stock it does not need to chase free goods.
  if (topUp > buyQty / 2) {
    return {
      quantity: base,
      freeQty: freeUnitsFor(base, buyQty, freeQty),
      adjusted: false,
      reason: `Reaching the next ${buyQty}+${freeQty} slab needs ${topUp} more units - too much extra stock to justify.`,
    };
  }

  const optimised = base + topUp;
  return {
    quantity: optimised,
    freeQty: freeUnitsFor(optimised, buyQty, freeQty),
    adjusted: true,
    reason: `Ordering ${topUp} more unit(s) (${optimised} total) earns ${freeUnitsFor(optimised, buyQty, freeQty)} free under the ${buyQty}+${freeQty} scheme.`,
  };
}
