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
