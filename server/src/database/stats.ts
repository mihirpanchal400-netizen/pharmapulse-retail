import { getDb, closeDb } from './connection';
import { config } from '../config';
import { getInventorySummary, getInventoryTurnover, getInventoryHealthScore } from '../analytics/inventoryAnalyzer';
import { getSalesGrowth } from '../analytics/salesAnalyzer';
import { getExpiringBatches, getExpiredBatches } from '../services/batchService';
import { runAnalysis } from '../analytics/miniAnalyst';
import { getPharmacyProfile } from '../services/settingsService';

/**
 * Database inspection: `npm run db:stats`.
 *
 * Prints row counts, the headline business figures, and the conditions the Mini
 * Analyst is meant to detect. Useful as a health check after seeding and as a
 * quick way to show, in a demo, that the insights come from real data.
 */

function money(value: number): string {
  return `${getPharmacyProfile().currency_symbol}${Math.round(value).toLocaleString('en-IN')}`;
}

function row(label: string, value: string | number): void {
  console.log(`  ${label.padEnd(26)} ${value}`);
}

function stats(): void {
  const db = getDb();

  const tables = [
    'users', 'settings', 'suppliers', 'products', 'product_batches', 'customers',
    'sales', 'sale_items', 'purchases', 'purchase_items', 'sale_returns',
    'sale_return_items', 'inventory_transactions',
  ];

  console.log('');
  console.log('  PharmaPulse Retail - database statistics');
  console.log(`  ${config.databasePath}`);
  console.log('  ================================================');
  console.log('');
  console.log('  TABLE ROW COUNTS');
  for (const table of tables) {
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    row(table, n.toLocaleString('en-IN'));
  }

  const period = db
    .prepare('SELECT MIN(date(sale_date)) AS from_date, MAX(date(sale_date)) AS to_date FROM sales')
    .get() as { from_date: string | null; to_date: string | null };

  if (!period.from_date) {
    console.log('');
    console.log('  No sales recorded. Run  npm run seed  to load demo data.');
    console.log('');
    closeDb();
    return;
  }

  const growth = getSalesGrowth(30);
  const inventory = getInventorySummary();
  const turnover = getInventoryTurnover(90);
  const health = getInventoryHealthScore();

  console.log('');
  console.log('  TRADING PERIOD');
  row('First sale', period.from_date);
  row('Last sale', period.to_date ?? '-');

  console.log('');
  console.log('  LAST 30 DAYS');
  row('Revenue (net of tax)', money(growth.current.revenue));
  row('Gross profit', money(growth.current.grossProfit));
  row('Gross margin', `${growth.current.grossMarginPct}%`);
  row('Transactions', growth.current.transactions.toLocaleString('en-IN'));
  row('Average bill value', money(growth.current.averageBillValue));
  row('Units sold', growth.current.unitsSold.toLocaleString('en-IN'));
  row('Revenue vs previous 30d', `${growth.revenueGrowthPct > 0 ? '+' : ''}${growth.revenueGrowthPct}%`);

  console.log('');
  console.log('  INVENTORY');
  row('Active SKUs', inventory.activeSkus);
  row('Units on hand', inventory.totalUnits.toLocaleString('en-IN'));
  row('Value at cost', money(inventory.inventoryValueAtCost));
  row('Value at retail', money(inventory.inventoryValueAtRetail));
  row('Annualised turnover', `${turnover.annualisedTurnover}x`);
  row('Health score', `${health.score}/100 (${health.grade})`);

  console.log('');
  console.log('  PLANTED CONDITIONS  (what the Mini Analyst should find)');
  row('Out of stock', inventory.outOfStock);
  row('Low stock', inventory.lowStock);
  row('Overstocked', inventory.overstock);
  row('Healthy', inventory.healthy);
  row('Dead stock products', `${inventory.deadStockCount} (${money(inventory.deadStockValue)})`);
  row('Batches expiring <= 90d', getExpiringBatches(90).length);
  row('Batches already expired', getExpiredBatches().length);

  const report = runAnalysis();
  console.log('');
  console.log('  MINI ANALYST');
  row('Insights generated', report.insights.length);
  row('Critical / High', `${report.counts.CRITICAL} / ${report.counts.HIGH}`);
  row('Medium / Low', `${report.counts.MEDIUM} / ${report.counts.LOW}`);
  row('Impact anchor', money(report.impactAnchor));
  console.log('');
  console.log(`  "${report.headline}"`);
  console.log('');
  console.log('  Ranked insights:');
  for (const insight of report.insights) {
    console.log(
      `   ${String(insight.priorityScore).padStart(5)}  ${insight.severity.padEnd(8)} ${insight.title}`,
    );
  }
  console.log('');

  closeDb();
}

if (require.main === module) {
  try {
    stats();
  } catch (err) {
    console.error('  Stats failed:', err instanceof Error ? err.message : err);
    closeDb();
    process.exit(1);
  }
}
