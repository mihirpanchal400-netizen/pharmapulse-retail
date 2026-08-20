/** Shapes returned by the API, mirrored on the client. */

export type Role = 'ADMIN' | 'PHARMACIST' | 'STAFF';

export type StockStatus = 'OUT_OF_STOCK' | 'LOW_STOCK' | 'HEALTHY' | 'OVERSTOCKED' | 'EXPIRING';

export type InsightSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export type PaymentMethod = 'CASH' | 'UPI' | 'CARD' | 'OTHER';

export interface SessionUser {
  id: number;
  username: string;
  full_name: string;
  role: Role;
}

export interface Insight {
  id: string;
  type: string;
  severity: InsightSeverity;
  title: string;
  description: string;
  metric: number;
  metricLabel: string;
  recommendation: string;
  reason: string;
  evidence: { label: string; value: string }[];
  priorityScore: number;
  impact: number;
  urgency: number;
  link: string | null;
  linkLabel: string | null;
}

export interface AnalystReport {
  generatedAt: string;
  impactAnchor: number;
  insights: Insight[];
  counts: Record<InsightSeverity, number>;
  headline: string;
  context: {
    healthScore: number;
    healthGrade: string;
    inventoryValue: number;
    revenue30d: number;
    grossMargin30d: number;
    skus: number;
  };
}

export interface SalesSummary {
  revenue: number;
  grossRevenueWithTax: number;
  tax: number;
  discount: number;
  cogs: number;
  grossProfit: number;
  grossMarginPct: number;
  transactions: number;
  unitsSold: number;
  averageBillValue: number;
  averageUnitsPerBill: number;
}

export interface GrowthComparison {
  windowDays: number;
  current: SalesSummary;
  previous: SalesSummary;
  revenueGrowthPct: number;
  profitGrowthPct: number;
  transactionGrowthPct: number;
  currentRange: { from: string; to: string };
  previousRange: { from: string; to: string };
}

export interface TrendPoint {
  date: string;
  revenue: number;
  grossProfit: number;
  transactions: number;
  units: number;
}

export interface CategorySales {
  category: string;
  revenue: number;
  cogs: number;
  grossProfit: number;
  marginPct: number;
  units: number;
  revenueSharePct: number;
  previousRevenue: number;
  growthPct: number;
}

export interface ProductPerformance {
  id: number;
  product_code: string;
  product_name: string;
  category: string;
  manufacturer: string | null;
  revenue: number;
  previousRevenue: number;
  revenueGrowthPct: number;
  unitsSold: number;
  cogs: number;
  grossProfit: number;
  marginPct: number;
  revenueSharePct: number;
  salesVelocity: number;
  currentStock: number;
  inventoryValue: number;
  stockCoverageDays: number | null;
  daysSinceLastSale: number | null;
  lastSaleDate: string | null;
  stockStatus: StockStatus;
  isDeadStock: boolean;
  performanceScore: number;
  abcClass: 'A' | 'B' | 'C';
}

export interface InventorySummary {
  totalSkus: number;
  activeSkus: number;
  totalUnits: number;
  inventoryValueAtCost: number;
  inventoryValueAtRetail: number;
  potentialMargin: number;
  statusCounts: Record<StockStatus, number>;
  outOfStock: number;
  lowStock: number;
  overstock: number;
  expiring: number;
  healthy: number;
  deadStockCount: number;
  deadStockValue: number;
  expiredUnits: number;
}

export interface HealthScore {
  score: number;
  grade: 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR';
  penalties: { reason: string; points: number; detail: string }[];
  formula: string;
}

export interface InventoryItem {
  id: number;
  product_code: string;
  product_name: string;
  generic_name: string | null;
  brand_name: string | null;
  category: string;
  dosage_form: string | null;
  strength: string | null;
  pack_size: string | null;
  manufacturer: string | null;
  prescription_flag: number;
  purchase_price: number;
  selling_price: number;
  tax_rate: number;
  reorder_level: number;
  minimum_stock: number;
  maximum_stock: number;
  status: string;
  current_stock: number;
  batch_count: number;
  inventory_value: number;
  retail_value: number;
  expired_stock: number;
  nearest_expiry: string | null;
  last_sale_date: string | null;
  units_sold_window: number;
  stock_status: StockStatus;
  is_expiring: boolean;
  days_to_nearest_expiry: number | null;
  sales_velocity: number;
  stock_coverage_days: number | null;
  days_since_last_sale: number | null;
  needs_reorder: boolean;
  suggestedOrderQty?: number;
  isCritical?: boolean;
}

export interface Paged<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface DashboardData {
  today: SalesSummary;
  growth: GrowthComparison;
  trend: TrendPoint[];
  categories: CategorySales[];
  topProducts: ProductPerformance[];
  fastMoving: ProductPerformance[];
  inventory: InventorySummary;
  health: HealthScore;
  paymentMix: { method: string; transactions: number; value: number; sharePct: number }[];
  insights: Insight[];
  thresholds: Record<string, number>;
}

export interface PharmacyProfile {
  pharmacy_name: string;
  pharmacy_address: string;
  pharmacy_phone: string;
  pharmacy_email: string;
  pharmacy_tax_id: string;
  invoice_prefix: string;
  purchase_prefix: string;
  return_prefix: string;
  currency_symbol: string;
}

/* -------------------------------------------------------------------------- */
/* Import Center                                                               */
/* -------------------------------------------------------------------------- */

export type ImportType =
  | 'PRODUCT_MASTER'
  | 'MANUFACTURER_MASTER'
  | 'SUPPLIER_MASTER'
  | 'DISTRIBUTOR_MASTER'
  | 'OPENING_STOCK'
  | 'BATCH_MASTER'
  | 'PRICE_LIST'
  | 'PURCHASE_HISTORY'
  | 'SALES_HISTORY';

export interface ImportTypeSummary {
  type: ImportType;
  label: string;
  description: string;
  affects: string;
  fieldCount: number;
  requiredFields: string[];
  requireAnyOf: { label: string; keys: string[] }[];
}

export interface ImportField {
  key: string;
  label: string;
  type: string;
  required: boolean;
  note?: string;
  values?: string[];
  example?: string | number;
}

export interface SheetColumn {
  name: string;
  index: number;
  fillRate: number;
  detectedType: 'text' | 'number' | 'date' | 'empty';
  samples: string[];
}

export interface SheetAnalysis {
  name: string;
  rowCount: number;
  headerRow: number;
  columns: SheetColumn[];
  emptyColumns: string[];
  suggestedType: ImportType | null;
  confidence: number;
  duplicateRowCount: number;
  problem?: string;
}

export interface WorkbookAnalysis {
  fileName: string;
  fileType: 'XLSX' | 'XLS' | 'CSV';
  fileSize: number;
  sheets: SheetAnalysis[];
}

export interface ImportJob {
  id: number;
  file_name: string;
  file_size: number;
  file_type: string;
  import_type: ImportType | null;
  sheet_name: string | null;
  status: 'UPLOADED' | 'MAPPED' | 'PREVIEWED' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  total_rows: number;
  valid_rows: number;
  invalid_rows: number;
  duplicate_rows: number;
  imported_rows: number;
  rejected_rows: number;
  created_count: number;
  updated_count: number;
  skipped_count: number;
  username: string | null;
  error_message: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface RowIssue {
  rowNumber: number;
  field?: string;
  columnName?: string;
  value?: string;
  severity: 'ERROR' | 'WARNING';
  message: string;
}

export interface ImportPreview {
  job: ImportJob;
  summary: {
    totalRows: number;
    validRows: number;
    invalidRows: number;
    duplicateRows: number;
    missingRequired: string[];
    warnings: number;
    errors: number;
  };
  columns: { key: string; label: string }[];
  rows: {
    rowNumber: number;
    valid: boolean;
    duplicate: boolean;
    values: Record<string, string | number | boolean | null>;
    issues: RowIssue[];
  }[];
  issues: RowIssue[];
  issuesTruncated: boolean;
}

export interface ImportCommitResult {
  job: ImportJob;
  outcome: {
    created: number;
    updated: number;
    skipped: number;
    imported: number;
    rejected: number;
    notes: string[];
  };
}

export interface ImportUploadResult {
  job: ImportJob;
  analysis: WorkbookAnalysis;
  suggestions: Record<string, Record<string, string | null>>;
}

export interface ImportErrorRow {
  id: number;
  job_id: number;
  row_number: number;
  column_name: string | null;
  field: string | null;
  value: string | null;
  severity: string;
  message: string;
}
