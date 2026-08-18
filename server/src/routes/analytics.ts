import { Router, type Request } from 'express';
import { z } from 'zod';
import { idParam, query, validateQuery } from '../middleware/validate';
import { wrap } from '../middleware/error';
import { anyRole, operational } from '../middleware/auth';
import * as salesAnalytics from '../analytics/salesAnalyzer';
import * as productAnalytics from '../analytics/productAnalyzer';
import * as inventoryAnalytics from '../analytics/inventoryAnalyzer';
import * as profitAnalytics from '../analytics/profitAnalyzer';
import { runAnalysis, getTopInsights, getInsight } from '../analytics/miniAnalyst';
import { getThresholds } from '../services/settingsService';
import { notFound } from '../utils/errors';

/**
 * Analytics endpoints. Every handler here is READ-ONLY.
 *
 * `days` is validated against a fixed set rather than accepted freely, so a URL
 * cannot ask for a 100,000-day window and stall the process.
 */

const router = Router();

const windowSchema = z.object({
  days: z.coerce.number().int().refine((d) => [7, 14, 30, 60, 90, 180, 365].includes(d), {
    message: 'days must be one of 7, 14, 30, 60, 90, 180, 365',
  }).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

type WindowQuery = z.infer<typeof windowSchema>;

const windowDays = (req: Request, fallback = 30): number =>
  query<WindowQuery>(req)?.days ?? fallback;

// -------------------------------------------------------------- dashboard
/**
 * One call powering the whole dashboard. Bundled deliberately: eight separate
 * requests on page load would each re-read the same inventory aggregate.
 */
router.get(
  '/dashboard',
  anyRole,
  validateQuery(windowSchema),
  wrap((req, res) => {
    const days = windowDays(req);
    const inventorySummary = inventoryAnalytics.getInventorySummary();

    res.json({
      today: salesAnalytics.getTodaySummary(),
      growth: salesAnalytics.getSalesGrowth(days),
      trend: salesAnalytics.getSalesTrend(days),
      categories: salesAnalytics.getCategorySales(days),
      topProducts: productAnalytics.getTopProducts(days, 8),
      fastMoving: productAnalytics.getFastMoving(days, 5),
      inventory: inventorySummary,
      health: inventoryAnalytics.getInventoryHealthScore(),
      paymentMix: salesAnalytics.getPaymentMix(days),
      insights: getTopInsights(5),
      thresholds: getThresholds(),
    });
  }),
);

// ------------------------------------------------------------------ sales
router.get(
  '/sales',
  anyRole,
  validateQuery(windowSchema),
  wrap((req, res) => {
    const days = windowDays(req);
    const t = getThresholds();
    res.json({
      windowDays: days,
      growth: salesAnalytics.getSalesGrowth(days),
      trend: salesAnalytics.getSalesTrend(days),
      monthly: salesAnalytics.getMonthlySales(12),
      categories: salesAnalytics.getCategorySales(days),
      weekday: salesAnalytics.getWeekdayPattern(Math.max(days, 90)),
      paymentMix: salesAnalytics.getPaymentMix(days),
      concentration: {
        top5: salesAnalytics.getRevenueConcentration(days, 5),
        top10: salesAnalytics.getRevenueConcentration(days, 10),
        top20: salesAnalytics.getRevenueConcentration(days, 20),
        configured: salesAnalytics.getRevenueConcentration(days, t.revenueConcentrationTopN),
      },
    });
  }),
);

// ---------------------------------------------------------------- products
router.get(
  '/products',
  anyRole,
  validateQuery(windowSchema),
  wrap((req, res) => {
    const days = windowDays(req);
    res.json({
      windowDays: days,
      performance: productAnalytics.getProductPerformance(days),
      fastMoving: productAnalytics.getFastMoving(days, 10),
      slowMoving: productAnalytics.getSlowMoving(days, 10),
      deadStock: productAnalytics.getDeadStock(),
      topProducts: productAnalytics.getTopProducts(days, 10),
    });
  }),
);

/** Daily sales series for one product - the drill-down from the product table. */
router.get(
  '/products/:id/trend',
  anyRole,
  validateQuery(windowSchema),
  wrap((req, res) => {
    const days = windowDays(req, 90);
    res.json({ data: productAnalytics.getProductTrend(idParam(req), days) });
  }),
);

// --------------------------------------------------------------- inventory
router.get(
  '/inventory',
  anyRole,
  validateQuery(windowSchema),
  wrap((req, res) => {
    const t = getThresholds();
    res.json({
      summary: inventoryAnalytics.getInventorySummary(),
      health: inventoryAnalytics.getInventoryHealthScore(),
      turnover: inventoryAnalytics.getInventoryTurnover(windowDays(req, 90)),
      byCategory: inventoryAnalytics.getInventoryByCategory(),
      valueConcentration: inventoryAnalytics.getValueConcentration(t.revenueConcentrationTopN),
      reorderList: inventoryAnalytics.getReorderList(),
    });
  }),
);

// ------------------------------------------------------------------ profit
router.get(
  '/profit',
  anyRole,
  validateQuery(windowSchema),
  wrap((req, res) => {
    const days = windowDays(req);
    res.json({
      windowDays: days,
      comparison: profitAnalytics.getProfitComparison(days),
      trend: profitAnalytics.getProfitTrend(days),
      byCategory: profitAnalytics.getProfitByCategory(days),
      byProduct: profitAnalytics.getProfitByProduct(days, 25),
      marginDistribution: profitAnalytics.getMarginDistribution(days),
    });
  }),
);

// ------------------------------------------------------------ mini analyst
/**
 * The full Mini Analyst run: every insight, ranked, with its evidence and the
 * impact anchor the scores were measured against.
 */
router.get(
  '/mini-analyst',
  anyRole,
  wrap((_req, res) => res.json(runAnalysis())),
);

router.get(
  '/mini-analyst/:id',
  anyRole,
  wrap((req, res) => {
    const insight = getInsight(req.params.id);
    if (!insight) throw notFound('Insight');
    res.json(insight);
  }),
);

/**
 * Exposes the scoring model itself, so the UI can show the methodology next to
 * the results rather than asking the reader to take the ranking on trust.
 */
router.get(
  '/mini-analyst-methodology',
  operational,
  wrap((_req, res) => {
    const report = runAnalysis();
    res.json({
      priorityFormula: 'Priority Score = Impact x Urgency (each 0-10, product 0-100)',
      impactFormula:
        'Impact = clamp(10 x value_at_stake / impact_anchor, 1, 10), where impact_anchor = max(1000, trailing 30-day revenue x 2%)',
      urgencyFormula: 'Urgency = clamp(10 x (1 - days_until_consequence / 90), 1, 10)',
      severityBands: { CRITICAL: '>= 70', HIGH: '45 - 69', MEDIUM: '25 - 44', LOW: '< 25' },
      impactAnchor: report.impactAnchor,
      thresholds: getThresholds(),
      rulesEvaluated: 14,
      rulesFired: report.insights.length,
    });
  }),
);

export default router;
