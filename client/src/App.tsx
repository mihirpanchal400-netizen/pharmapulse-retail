import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { CartProvider } from './hooks/useCart';
import { AppLayout } from './layouts/AppLayout';
import { Spinner } from './components/ui';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import MiniAnalyst from './pages/MiniAnalyst';
import Pos from './pages/Pos';
import Reports from './pages/Reports';
import Returns from './pages/Returns';
import PurchaseReturns from './pages/PurchaseReturns';
import Settings from './pages/Settings';
import ImportCenter from './pages/ImportCenter';
import ImportHistory from './pages/ImportHistory';
import Replenishment from './pages/Replenishment';
import SupplierComparison from './pages/SupplierComparison';
import ProcurementCart from './pages/ProcurementCart';
import { ProductList, ProductDetail } from './pages/Products';
import { SalesHistory, InvoiceView } from './pages/Sales';
import { CurrentStock, Batches, Expiry } from './pages/Inventory';
import { DistributorNetwork, DistributorDetail } from './pages/Distributors';
import { PurchaseOrderList, PurchaseOrderDetail } from './pages/PurchaseOrders';
import { SupplierOutstanding, CustomerOutstanding } from './pages/Outstanding';
import { CustomerList, CustomerDetail } from './pages/Customers';
import {
  SalesAnalytics,
  ProductAnalytics,
  InventoryAnalytics,
  ProfitAnalytics,
} from './pages/Analytics';

/**
 * Routing.
 *
 * A single gate: unauthenticated users see the login screen and nothing else.
 * Per-route role restrictions are handled by hiding navigation and, decisively,
 * by the API refusing the request — the client is not the security boundary.
 */

function Gate() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="grid h-full place-items-center">
        <div className="flex flex-col items-center gap-3">
          <Spinner className="h-6 w-6" />
          <p className="text-sm text-slate-500">Restoring your session…</p>
        </div>
      </div>
    );
  }

  if (!user) return <Login />;

  return (
    <AppLayout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/mini-analyst" element={<MiniAnalyst />} />

        {/* ------------------------------------------------------------ Sales */}
        <Route path="/sales" element={<SalesHistory />} />
        <Route path="/sales/new" element={<Pos />} />
        <Route path="/sales/returns" element={<Returns />} />
        {/* Kept last: a bare :id must not shadow /new or /returns. */}
        <Route path="/sales/:id" element={<InvoiceView />} />

        {/* -------------------------------------------------------- Inventory */}
        <Route path="/inventory" element={<CurrentStock />} />
        <Route path="/inventory/stock" element={<CurrentStock />} />
        <Route path="/inventory/products" element={<ProductList />} />
        <Route path="/inventory/products/:id" element={<ProductDetail />} />
        <Route path="/inventory/batches" element={<Batches />} />
        <Route path="/inventory/expiry" element={<Expiry />} />
        {/* Low stock is the Replenishment Center — the same question, answered
            with a supplier and a price rather than just a list. */}
        <Route path="/inventory/low-stock" element={<Navigate to="/procurement/replenishment" replace />} />

        {/* ------------------------------------------------------ Procurement */}
        <Route path="/procurement/replenishment" element={<Replenishment />} />
        <Route path="/procurement/compare" element={<SupplierComparison />} />
        <Route path="/procurement/cart" element={<ProcurementCart />} />
        <Route path="/procurement/distributors" element={<DistributorNetwork />} />
        <Route path="/procurement/distributors/:id" element={<DistributorDetail />} />
        <Route path="/procurement/orders" element={<PurchaseOrderList />} />
        <Route path="/procurement/orders/:id" element={<PurchaseOrderDetail />} />
        <Route path="/procurement/outstanding" element={<SupplierOutstanding />} />
        <Route path="/procurement/returns" element={<PurchaseReturns />} />
        {/* Legacy paths from the pre-procurement build. */}
        <Route path="/purchases" element={<Navigate to="/procurement/orders" replace />} />
        <Route path="/purchases/new" element={<Navigate to="/procurement/replenishment" replace />} />
        <Route path="/purchases/suppliers" element={<Navigate to="/procurement/distributors" replace />} />

        {/* --------------------------------------------------------- Customers */}
        <Route path="/customers" element={<CustomerList />} />
        <Route path="/customers/outstanding" element={<CustomerOutstanding />} />
        {/* Kept last so a bare :id cannot shadow /outstanding. */}
        <Route path="/customers/:id" element={<CustomerDetail />} />

        {/* --------------------------------------------------------- Analytics */}
        <Route path="/analytics/sales" element={<SalesAnalytics />} />
        <Route path="/analytics/products" element={<ProductAnalytics />} />
        <Route path="/analytics/inventory" element={<InventoryAnalytics />} />
        <Route path="/analytics/profit" element={<ProfitAnalytics />} />

        {/* ------------------------------------------------------------- Data */}
        <Route path="/import" element={<ImportCenter />} />
        <Route path="/import/history" element={<ImportHistory />} />

        <Route path="/reports" element={<Reports />} />
        <Route path="/settings" element={<Settings />} />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppLayout>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <CartProvider>
          <Gate />
        </CartProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
