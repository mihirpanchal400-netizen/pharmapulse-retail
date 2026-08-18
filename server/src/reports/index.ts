import { toCsv, csvFilename, type CsvColumn } from '../utils/csv';
import { windowEndingToday } from '../utils/dates';
import { round2 } from '../utils/money';
import { getInventory } from '../services/inventoryService';
import { allBatches, getExpiringBatches } from '../services/batchService';
import { listSales } from '../services/saleService';
import { listPurchases, supplierPurchaseSummary } from '../services/purchaseService';
import { getThresholds } from '../services/settingsService';
import { getSalesTrend, getMonthlySales } from '../analytics/salesAnalyzer';
import { getProductPerformance } from '../analytics/productAnalyzer';
import { getProfitByProduct, getProfitByCategory } from '../analytics/profitAnalyzer';
import { badRequest } from '../utils/errors';

/**
 * CSV report exports.
 *
 * Every report is a projection of the SAME analytics functions the screens use,
 * so an exported file can never disagree with what the user just looked at.
 * Reports are defined declaratively (id, title, columns, rows) so adding one is
 * a data change, not a code change.
 */

export interface ReportParams {
  from?: string;
  to?: string;
  days?: number;
}

interface ReportDefinition<T = Record<string, unknown>> {
  id: string;
  title: string;
  description: string;
  /** Whether the report honours a date range. */
  dated: boolean;
  columns: CsvColumn<T>[];
  rows: (params: ReportParams) => T[];
}

/** Resolves a from/to range, defaulting to the trailing `days` window. */
function resolveRange(params: ReportParams, defaultDays = 30): { from: string; to: string } {
  if (params.from && params.to) return { from: params.from, to: params.to };
  return windowEndingToday(params.days ?? defaultDays);
}

const num = (v: unknown): number => round2(Number(v ?? 0));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const REPORTS: ReportDefinition<any>[] = [
  // ------------------------------------------------------------------ sales
  {
    id: 'daily-sales',
    title: 'Daily Sales',
    description: 'Revenue, gross profit, transactions and units for each day in the range.',
    dated: true,
    columns: [
      { header: 'Date', value: (r) => r.date },
      { header: 'Revenue (net of tax)', value: (r) => r.revenue },
      { header: 'Gross Profit', value: (r) => r.grossProfit },
      { header: 'Gross Margin %', value: (r) => (r.revenue ? round2((r.grossProfit / r.revenue) * 100) : 0) },
      { header: 'Transactions', value: (r) => r.transactions },
      { header: 'Units Sold', value: (r) => r.units },
      { header: 'Average Bill Value', value: (r) => (r.transactions ? round2(r.revenue / r.transactions) : 0) },
    ],
    rows: (p) => getSalesTrend(p.days ?? 30),
  },
  {
    id: 'monthly-sales',
    title: 'Monthly Sales',
    description: 'Month-by-month revenue, gross profit, transactions and units.',
    dated: false,
    columns: [
      { header: 'Month', value: (r) => r.month },
      { header: 'Revenue (net of tax)', value: (r) => r.revenue },
      { header: 'Gross Profit', value: (r) => r.grossProfit },
      { header: 'Gross Margin %', value: (r) => (r.revenue ? round2((r.grossProfit / r.revenue) * 100) : 0) },
      { header: 'Transactions', value: (r) => r.transactions },
      { header: 'Units Sold', value: (r) => r.units },
    ],
    rows: () => getMonthlySales(24) as Record<string, unknown>[],
  },
  {
    id: 'sales-register',
    title: 'Sales Register',
    description: 'Every invoice in the range, with customer, payment method and totals.',
    dated: true,
    columns: [
      { header: 'Invoice Number', value: (r) => r.invoice_number },
      { header: 'Date', value: (r) => r.sale_date },
      { header: 'Customer', value: (r) => r.customer_name ?? 'Walk-in' },
      { header: 'Phone', value: (r) => r.customer_phone },
      { header: 'Cashier', value: (r) => r.cashier },
      { header: 'Items', value: (r) => r.item_count },
      { header: 'Subtotal', value: (r) => num(r.subtotal) },
      { header: 'Discount', value: (r) => num(r.discount) },
      { header: 'Tax', value: (r) => num(r.tax) },
      { header: 'Total', value: (r) => num(r.total) },
      { header: 'COGS', value: (r) => num(r.cogs) },
      { header: 'Gross Profit', value: (r) => round2(Number(r.total ?? 0) - Number(r.tax ?? 0) - Number(r.cogs ?? 0)) },
      { header: 'Payment Method', value: (r) => r.payment_method },
      { header: 'Status', value: (r) => r.status },
    ],
    rows: (p) => {
      const range = resolveRange(p);
      // pageSize is capped at 500 by the service; page through for a full export.
      const out: Record<string, unknown>[] = [];
      let page = 1;
      for (;;) {
        const result = listSales({ from: range.from, to: range.to, page, pageSize: 500 });
        out.push(...result.data);
        if (page >= result.totalPages) break;
        page += 1;
      }
      return out;
    },
  },

  // -------------------------------------------------------------- inventory
  {
    id: 'inventory',
    title: 'Inventory Valuation',
    description: 'Every product with current stock, value at cost and at retail, and stock status.',
    dated: false,
    columns: [
      { header: 'Product Code', value: (r) => r.product_code },
      { header: 'Product Name', value: (r) => r.product_name },
      { header: 'Generic Name', value: (r) => r.generic_name },
      { header: 'Category', value: (r) => r.category },
      { header: 'Manufacturer', value: (r) => r.manufacturer },
      { header: 'Rx Only', value: (r) => (r.prescription_flag ? 'Yes' : 'No') },
      { header: 'Current Stock', value: (r) => r.current_stock },
      { header: 'Batches', value: (r) => r.batch_count },
      { header: 'Reorder Level', value: (r) => r.reorder_level },
      { header: 'Maximum Stock', value: (r) => r.maximum_stock },
      { header: 'Purchase Price', value: (r) => r.purchase_price },
      { header: 'Selling Price', value: (r) => r.selling_price },
      { header: 'Value at Cost', value: (r) => r.inventory_value },
      { header: 'Value at Retail', value: (r) => r.retail_value },
      { header: 'Stock Status', value: (r) => r.stock_status },
      { header: 'Sales Velocity (units/day)', value: (r) => r.sales_velocity },
      { header: 'Stock Coverage (days)', value: (r) => r.stock_coverage_days },
      { header: 'Nearest Expiry', value: (r) => r.nearest_expiry },
      { header: 'Last Sale', value: (r) => r.last_sale_date },
    ],
    rows: () => getInventory(),
  },
  {
    id: 'low-stock',
    title: 'Low Stock / Reorder',
    description: 'Products at or below reorder level, with a suggested order quantity.',
    dated: false,
    columns: [
      { header: 'Product Code', value: (r) => r.product_code },
      { header: 'Product Name', value: (r) => r.product_name },
      { header: 'Category', value: (r) => r.category },
      { header: 'Current Stock', value: (r) => r.current_stock },
      { header: 'Reorder Level', value: (r) => r.reorder_level },
      { header: 'Minimum Stock', value: (r) => r.minimum_stock },
      { header: 'Maximum Stock', value: (r) => r.maximum_stock },
      { header: 'Sales Velocity (units/day)', value: (r) => r.sales_velocity },
      { header: 'Stock Coverage (days)', value: (r) => r.stock_coverage_days },
      { header: 'Suggested Order Qty', value: (r) => r.suggestedOrderQty },
      { header: 'Stock Status', value: (r) => r.stock_status },
      { header: 'Purchase Price', value: (r) => r.purchase_price },
      { header: 'Estimated Order Value', value: (r) => round2(r.suggestedOrderQty * r.purchase_price) },
    ],
    rows: () => {
      const t = getThresholds();
      return getInventory()
        .filter((i) => i.status === 'ACTIVE' && i.needs_reorder)
        .map((i) => {
          const target = i.maximum_stock > 0 ? i.maximum_stock : Math.ceil(i.sales_velocity * 30);
          return { ...i, suggestedOrderQty: Math.max(0, target - i.current_stock) };
        })
        .sort((a, b) => (a.stock_coverage_days ?? 9999) - (b.stock_coverage_days ?? 9999))
        .map((i) => ({ ...i, criticalCoverageDays: t.criticalCoverageDays }));
    },
  },
  {
    id: 'expiry',
    title: 'Expiry Risk',
    description: 'Batches expiring within the configured warning window, soonest first.',
    dated: false,
    columns: [
      { header: 'Product Code', value: (r) => r.product_code },
      { header: 'Product Name', value: (r) => r.product_name },
      { header: 'Category', value: (r) => r.category },
      { header: 'Batch Number', value: (r) => r.batch_number },
      { header: 'Supplier', value: (r) => r.supplier_name },
      { header: 'Manufacturing Date', value: (r) => r.manufacturing_date },
      { header: 'Expiry Date', value: (r) => r.expiry_date },
      { header: 'Days to Expiry', value: (r) => r.days_to_expiry },
      { header: 'Expiry Bucket', value: (r) => r.expiry_bucket },
      { header: 'Quantity', value: (r) => r.quantity },
      { header: 'Purchase Price', value: (r) => r.purchase_price },
      { header: 'Value at Risk', value: (r) => r.stock_value },
    ],
    rows: () => {
      // Expired batches first (already a loss), then the warning window.
      const expired = allBatches().filter((b) => b.quantity > 0 && b.days_to_expiry < 0);
      return [...expired, ...getExpiringBatches()];
    },
  },
  {
    id: 'batch-register',
    title: 'Batch Register',
    description: 'Every batch on record, including exhausted ones — the full traceability trail.',
    dated: false,
    columns: [
      { header: 'Product Code', value: (r) => r.product_code },
      { header: 'Product Name', value: (r) => r.product_name },
      { header: 'Batch Number', value: (r) => r.batch_number },
      { header: 'Supplier', value: (r) => r.supplier_name },
      { header: 'Manufacturing Date', value: (r) => r.manufacturing_date },
      { header: 'Expiry Date', value: (r) => r.expiry_date },
      { header: 'Days to Expiry', value: (r) => r.days_to_expiry },
      { header: 'Quantity Remaining', value: (r) => r.quantity },
      { header: 'Purchase Price', value: (r) => r.purchase_price },
      { header: 'Selling Price', value: (r) => r.selling_price },
      { header: 'Stock Value', value: (r) => r.stock_value },
      { header: 'Status', value: (r) => r.status },
    ],
    rows: () => allBatches(),
  },

  // ---------------------------------------------------------------- product
  {
    id: 'product-performance',
    title: 'Product Performance',
    description: 'Revenue, profit, margin, velocity and ABC class per product for the period.',
    dated: true,
    columns: [
      { header: 'Product Code', value: (r) => r.product_code },
      { header: 'Product Name', value: (r) => r.product_name },
      { header: 'Category', value: (r) => r.category },
      { header: 'Manufacturer', value: (r) => r.manufacturer },
      { header: 'Units Sold', value: (r) => r.unitsSold },
      { header: 'Revenue', value: (r) => r.revenue },
      { header: 'Previous Revenue', value: (r) => r.previousRevenue },
      { header: 'Revenue Growth %', value: (r) => r.revenueGrowthPct },
      { header: 'COGS', value: (r) => r.cogs },
      { header: 'Gross Profit', value: (r) => r.grossProfit },
      { header: 'Margin %', value: (r) => r.marginPct },
      { header: 'Revenue Share %', value: (r) => r.revenueSharePct },
      { header: 'ABC Class', value: (r) => r.abcClass },
      { header: 'Sales Velocity (units/day)', value: (r) => r.salesVelocity },
      { header: 'Current Stock', value: (r) => r.currentStock },
      { header: 'Stock Coverage (days)', value: (r) => r.stockCoverageDays },
      { header: 'Days Since Last Sale', value: (r) => r.daysSinceLastSale },
      { header: 'Dead Stock', value: (r) => (r.isDeadStock ? 'Yes' : 'No') },
      { header: 'Stock Status', value: (r) => r.stockStatus },
      { header: 'Performance Score', value: (r) => r.performanceScore },
    ],
    rows: (p) => getProductPerformance(p.days ?? 30),
  },

  // ----------------------------------------------------------- profitability
  {
    id: 'profitability',
    title: 'Profitability by Product',
    description: 'Revenue, COGS, gross profit and margin per product for the period.',
    dated: true,
    columns: [
      { header: 'Product Code', value: (r) => r.product_code },
      { header: 'Product Name', value: (r) => r.product_name },
      { header: 'Category', value: (r) => r.category },
      { header: 'Units Sold', value: (r) => r.units },
      { header: 'Revenue (net of tax)', value: (r) => r.revenue },
      { header: 'COGS', value: (r) => r.cogs },
      { header: 'Gross Profit', value: (r) => r.grossProfit },
      { header: 'Gross Margin %', value: (r) => r.marginPct },
      { header: 'Share of Total Profit %', value: (r) => r.profitSharePct },
    ],
    rows: (p) => getProfitByProduct(p.days ?? 30, 0),
  },
  {
    id: 'category-profitability',
    title: 'Profitability by Category',
    description: 'Revenue and profit contribution per therapeutic category.',
    dated: true,
    columns: [
      { header: 'Category', value: (r) => r.category },
      { header: 'Units Sold', value: (r) => r.units },
      { header: 'Revenue (net of tax)', value: (r) => r.revenue },
      { header: 'COGS', value: (r) => r.cogs },
      { header: 'Gross Profit', value: (r) => r.grossProfit },
      { header: 'Gross Margin %', value: (r) => r.marginPct },
      { header: 'Share of Revenue %', value: (r) => r.revenueSharePct },
      { header: 'Share of Profit %', value: (r) => r.profitSharePct },
      { header: 'Previous Profit', value: (r) => r.previousProfit },
      { header: 'Profit Growth %', value: (r) => r.profitGrowthPct },
    ],
    rows: (p) => getProfitByCategory(p.days ?? 30),
  },

  // -------------------------------------------------------------- purchases
  {
    id: 'purchases',
    title: 'Purchase Register',
    description: 'Every goods-inward document in the range, with supplier and payment status.',
    dated: true,
    columns: [
      { header: 'Purchase Number', value: (r) => r.purchase_number },
      { header: 'Date', value: (r) => r.purchase_date },
      { header: 'Supplier', value: (r) => r.supplier_name },
      { header: 'Items', value: (r) => r.item_count },
      { header: 'Subtotal', value: (r) => num(r.subtotal) },
      { header: 'Tax', value: (r) => num(r.tax) },
      { header: 'Total', value: (r) => num(r.total) },
      { header: 'Payment Status', value: (r) => r.payment_status },
    ],
    rows: (p) => {
      const range = resolveRange(p, 90);
      const out: Record<string, unknown>[] = [];
      let page = 1;
      for (;;) {
        const result = listPurchases({ from: range.from, to: range.to, page, pageSize: 500 });
        out.push(...result.data);
        if (page >= result.totalPages) break;
        page += 1;
      }
      return out;
    },
  },
  {
    id: 'supplier-summary',
    title: 'Supplier Summary',
    description: 'Purchase value, order count and outstanding payment per supplier.',
    dated: true,
    columns: [
      { header: 'Supplier', value: (r) => r.supplier_name },
      { header: 'Contact Person', value: (r) => r.contact_person },
      { header: 'Phone', value: (r) => r.phone },
      { header: 'Payment Terms', value: (r) => r.payment_terms },
      { header: 'Purchase Orders', value: (r) => r.purchase_count },
      { header: 'Total Purchase Value', value: (r) => r.total_value },
      { header: 'Outstanding', value: (r) => r.outstanding },
      { header: 'Last Purchase', value: (r) => r.last_purchase },
    ],
    rows: (p) => {
      const range = resolveRange(p, 365);
      return supplierPurchaseSummary(range.from, range.to);
    },
  },
];

/** Catalogue shown on the Reports screen. */
export function listReports() {
  return REPORTS.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    dated: r.dated,
    columns: r.columns.length,
  }));
}

export interface GeneratedReport {
  filename: string;
  csv: string;
  rowCount: number;
}

export function generateReport(id: string, params: ReportParams): GeneratedReport {
  const definition = REPORTS.find((r) => r.id === id);
  if (!definition) {
    throw badRequest(`Unknown report '${id}'. Available: ${REPORTS.map((r) => r.id).join(', ')}`);
  }

  const rows = definition.rows(params);
  return {
    filename: csvFilename(definition.id),
    csv: toCsv(rows, definition.columns),
    rowCount: rows.length,
  };
}

/** JSON preview of the first `limit` rows, so the UI can show the data before download. */
export function previewReport(id: string, params: ReportParams, limit = 20) {
  const definition = REPORTS.find((r) => r.id === id);
  if (!definition) throw badRequest(`Unknown report '${id}'.`);

  const rows = definition.rows(params);
  return {
    id: definition.id,
    title: definition.title,
    description: definition.description,
    headers: definition.columns.map((c) => c.header),
    rows: rows.slice(0, limit).map((row) => definition.columns.map((c) => c.value(row) ?? '')),
    totalRows: rows.length,
  };
}
