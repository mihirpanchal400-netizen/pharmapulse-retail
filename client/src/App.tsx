import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { AppLayout } from './layouts/AppLayout';
import { Spinner } from './components/ui';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import MiniAnalyst from './pages/MiniAnalyst';
import ComingSoon from './pages/ComingSoon';

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

        {/* Sales */}
        <Route
          path="/sales"
          element={<ComingSoon title="Sales History" subtitle="Every invoice, searchable and filterable" />}
        />
        <Route
          path="/sales/new"
          element={<ComingSoon title="New Sale" subtitle="Point of sale with FEFO batch allocation" />}
        />
        <Route
          path="/sales/returns"
          element={<ComingSoon title="Returns" subtitle="Return against an existing invoice" />}
        />

        {/* Inventory */}
        <Route
          path="/inventory"
          element={<ComingSoon title="Current Stock" subtitle="Live stock across every product" />}
        />
        <Route
          path="/inventory/products"
          element={<ComingSoon title="Products" subtitle="Product catalogue and pricing" />}
        />
        <Route
          path="/inventory/batches"
          element={<ComingSoon title="Batches" subtitle="Batch register and traceability" />}
        />
        <Route
          path="/inventory/low-stock"
          element={<ComingSoon title="Low Stock" subtitle="Products at or below reorder level" />}
        />
        <Route
          path="/inventory/expiry"
          element={<ComingSoon title="Expiry" subtitle="Batches by remaining shelf life" />}
        />

        {/* Purchases */}
        <Route
          path="/purchases"
          element={<ComingSoon title="Purchase History" subtitle="Goods inward documents" />}
        />
        <Route
          path="/purchases/new"
          element={<ComingSoon title="New Purchase" subtitle="Receive stock and create batches" />}
        />
        <Route
          path="/purchases/suppliers"
          element={<ComingSoon title="Suppliers" subtitle="Supplier directory and purchase summary" />}
        />

        <Route
          path="/customers"
          element={<ComingSoon title="Customers" subtitle="Customer directory and purchase history" />}
        />

        {/* Analytics */}
        <Route
          path="/analytics/sales"
          element={<ComingSoon title="Sales Analytics" subtitle="Revenue, growth, categories and concentration" />}
        />
        <Route
          path="/analytics/products"
          element={<ComingSoon title="Product Analytics" subtitle="Performance, velocity, ABC class and dead stock" />}
        />
        <Route
          path="/analytics/inventory"
          element={<ComingSoon title="Inventory Analytics" subtitle="Turnover, coverage and health" />}
        />
        <Route
          path="/analytics/profit"
          element={<ComingSoon title="Profit Analytics" subtitle="Margin by category and product" />}
        />

        <Route
          path="/reports"
          element={<ComingSoon title="Reports" subtitle="CSV exports for every dataset" />}
        />
        <Route
          path="/settings"
          element={<ComingSoon title="Settings" subtitle="Pharmacy profile and analytics thresholds" />}
        />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppLayout>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </BrowserRouter>
  );
}
