/** Row shapes returned by the database, shared across services and analytics. */

export type Role = 'ADMIN' | 'PHARMACIST' | 'STAFF';
export type StockStatus = 'OUT_OF_STOCK' | 'LOW_STOCK' | 'HEALTHY' | 'OVERSTOCKED' | 'EXPIRING';
export type PaymentMethod = 'CASH' | 'UPI' | 'CARD' | 'OTHER';
export type TransactionType =
  | 'STOCK_RECEIVED'
  | 'SALE'
  | 'RETURN'
  | 'ADJUSTMENT'
  | 'DAMAGED'
  | 'EXPIRED';

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  full_name: string;
  role: Role;
  status: 'ACTIVE' | 'INACTIVE';
  created_at: string;
}

export interface ProductRow {
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
  batch_tracking_enabled: number;
  prescription_flag: number;
  purchase_price: number;
  selling_price: number;
  tax_rate: number;
  reorder_level: number;
  minimum_stock: number;
  maximum_stock: number;
  status: 'ACTIVE' | 'INACTIVE';
  created_at: string;
  updated_at: string;
}

/** A product joined with its aggregated batch stock. */
export interface ProductWithStock extends ProductRow {
  current_stock: number;
  batch_count: number;
  inventory_value: number;
  nearest_expiry: string | null;
  stock_status: StockStatus;
}

export interface BatchRow {
  id: number;
  product_id: number;
  batch_number: string;
  manufacturing_date: string | null;
  expiry_date: string;
  quantity: number;
  purchase_price: number;
  selling_price: number;
  supplier_id: number | null;
  status: 'ACTIVE' | 'QUARANTINED' | 'WRITTEN_OFF';
  created_at: string;
  updated_at: string;
}

export interface SupplierRow {
  id: number;
  supplier_name: string;
  contact_person: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  payment_terms: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  created_at: string;
  updated_at: string;
}

export interface CustomerRow {
  id: number;
  customer_code: string;
  name: string;
  phone: string | null;
  customer_type: 'WALK_IN' | 'REGULAR' | 'INSTITUTIONAL';
  created_at: string;
}

export interface SaleRow {
  id: number;
  invoice_number: string;
  customer_id: number | null;
  user_id: number | null;
  sale_date: string;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  cogs: number;
  payment_method: PaymentMethod;
  status: 'COMPLETED' | 'RETURNED' | 'PARTIALLY_RETURNED' | 'CANCELLED';
  notes: string | null;
  created_at: string;
}

export interface SaleItemRow {
  id: number;
  sale_id: number;
  product_id: number;
  batch_id: number | null;
  quantity: number;
  returned_quantity: number;
  selling_price: number;
  purchase_price: number;
  discount: number;
  tax: number;
  line_total: number;
}

export interface PurchaseRow {
  id: number;
  purchase_number: string;
  supplier_id: number;
  user_id: number | null;
  purchase_date: string;
  subtotal: number;
  tax: number;
  total: number;
  payment_status: 'PAID' | 'PARTIAL' | 'UNPAID';
  notes: string | null;
  created_at: string;
}

export interface PurchaseItemRow {
  id: number;
  purchase_id: number;
  product_id: number;
  batch_id: number | null;
  batch_number: string;
  quantity: number;
  purchase_price: number;
  selling_price: number;
  expiry_date: string;
  tax_rate: number;
  line_total: number;
}

export interface InventoryTransactionRow {
  id: number;
  product_id: number;
  batch_id: number | null;
  transaction_type: TransactionType;
  quantity: number;
  reference_id: number | null;
  reference_type: string | null;
  notes: string | null;
  transaction_date: string;
}

/** Severity ladder used by the Mini Analyst. */
export type InsightSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface Insight {
  id: string;
  type: string;
  severity: InsightSeverity;
  title: string;
  description: string;
  metric: number;
  metricLabel: string;
  recommendation: string;
  /** Human-readable justification: the numbers the rule actually fired on. */
  reason: string;
  /** Supporting evidence rows shown in the "why" panel. */
  evidence: { label: string; value: string }[];
  priorityScore: number;
  impact: number;
  urgency: number;
  /** Client route the "view" button navigates to. */
  link: string | null;
  linkLabel: string | null;
  /**
   * Optional costed procurement action attached to replenishment insights, so
   * the recommendation can be acted on directly instead of merely read.
   */
  action?: {
    type: 'ADD_TO_CART';
    productId: number;
    productName: string;
    suggestedQty: number;
    freeQty: number;
    distributorId: number;
    distributorName: string;
    ptr: number;
    schemeLabel: string;
    effectiveCost: number;
    estimatedCost: number;
  } | null;
}
