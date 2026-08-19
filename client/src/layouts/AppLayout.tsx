import { useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  Activity,
  BarChart3,
  Boxes,
  ChevronDown,
  FileText,
  LayoutDashboard,
  LogOut,
  Menu,
  Package,
  Settings,
  ShoppingCart,
  Truck,
  Users,
  X,
} from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { initials } from '../utils/format';
import type { Role } from '../types';

/**
 * Application shell: fixed sidebar on desktop, slide-over drawer on tablet.
 *
 * Navigation items declare which roles may see them. Hiding a link is a
 * usability measure, not a security one - the API enforces the same matrix
 * independently, so a hidden route is still refused if called directly.
 */

interface NavItem {
  label: string;
  to: string;
  icon: typeof LayoutDashboard;
  roles?: Role[];
  children?: { label: string; to: string; roles?: Role[] }[];
}

const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: 'Overview',
    items: [
      { label: 'Dashboard', to: '/', icon: LayoutDashboard },
      { label: 'Mini Analyst', to: '/mini-analyst', icon: Activity },
    ],
  },
  {
    section: 'Operations',
    items: [
      {
        label: 'Sales',
        to: '/sales',
        icon: ShoppingCart,
        children: [
          { label: 'New Sale', to: '/sales/new' },
          { label: 'Sales History', to: '/sales' },
          { label: 'Returns', to: '/sales/returns', roles: ['ADMIN', 'PHARMACIST'] },
        ],
      },
      {
        label: 'Inventory',
        to: '/inventory',
        icon: Boxes,
        children: [
          { label: 'Products', to: '/inventory/products' },
          { label: 'Current Stock', to: '/inventory' },
          { label: 'Batches', to: '/inventory/batches' },
          { label: 'Low Stock', to: '/inventory/low-stock' },
          { label: 'Expiry', to: '/inventory/expiry' },
        ],
      },
      {
        label: 'Purchases',
        to: '/purchases',
        icon: Truck,
        roles: ['ADMIN', 'PHARMACIST'],
        children: [
          { label: 'New Purchase', to: '/purchases/new' },
          { label: 'Purchase History', to: '/purchases' },
          { label: 'Suppliers', to: '/purchases/suppliers' },
        ],
      },
      { label: 'Customers', to: '/customers', icon: Users },
    ],
  },
  {
    section: 'Intelligence',
    items: [
      {
        label: 'Analytics',
        to: '/analytics/sales',
        icon: BarChart3,
        roles: ['ADMIN', 'PHARMACIST'],
        children: [
          { label: 'Sales Analytics', to: '/analytics/sales' },
          { label: 'Product Analytics', to: '/analytics/products' },
          { label: 'Inventory Analytics', to: '/analytics/inventory' },
          { label: 'Profit Analytics', to: '/analytics/profit' },
        ],
      },
      { label: 'Reports', to: '/reports', icon: FileText, roles: ['ADMIN', 'PHARMACIST'] },
    ],
  },
  {
    section: 'System',
    items: [{ label: 'Settings', to: '/settings', icon: Settings, roles: ['ADMIN'] }],
  },
];

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const { user, profile, logout, can } = useAuth();
  const location = useLocation();
  const [open, setOpen] = useState<string | null>(() => {
    const match = NAV.flatMap((s) => s.items).find(
      (item) => item.children && location.pathname.startsWith(item.to.split('/').slice(0, 2).join('/')),
    );
    return match?.label ?? null;
  });

  const visible = (roles?: Role[]) => !roles || (user ? roles.includes(user.role) : false);

  return (
    <div className="flex h-full flex-col bg-slate-900 text-slate-300">
      {/* brand */}
      <div className="flex items-center gap-2.5 px-5 py-5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-500 text-white">
          <Package className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-white">PharmaPulse</p>
          <p className="truncate text-[11px] text-slate-400">
            {profile?.pharmacy_name ?? 'Retail'}
          </p>
        </div>
      </div>

      {/* navigation */}
      <nav className="flex-1 overflow-y-auto px-3 pb-4">
        {NAV.map((section) => {
          const items = section.items.filter((item) => visible(item.roles));
          if (items.length === 0) return null;

          return (
            <div key={section.section} className="mb-5">
              <p className="px-2 pb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                {section.section}
              </p>
              <ul className="space-y-0.5">
                {items.map((item) => {
                  const Icon = item.icon;
                  const expanded = open === item.label;

                  if (!item.children) {
                    return (
                      <li key={item.to}>
                        <NavLink
                          to={item.to}
                          end={item.to === '/'}
                          onClick={onNavigate}
                          className={({ isActive }) =>
                            `flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors ${
                              isActive
                                ? 'bg-brand-600 font-medium text-white'
                                : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                            }`
                          }
                        >
                          <Icon className="h-4 w-4 shrink-0" aria-hidden />
                          {item.label}
                        </NavLink>
                      </li>
                    );
                  }

                  const childItems = item.children.filter((child) => visible(child.roles));
                  return (
                    <li key={item.label}>
                      <button
                        type="button"
                        onClick={() => setOpen(expanded ? null : item.label)}
                        aria-expanded={expanded}
                        className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-slate-300 transition-colors hover:bg-slate-800 hover:text-white"
                      >
                        <Icon className="h-4 w-4 shrink-0" aria-hidden />
                        <span className="flex-1 text-left">{item.label}</span>
                        <ChevronDown
                          className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`}
                          aria-hidden
                        />
                      </button>
                      {expanded && (
                        <ul className="ml-6 mt-0.5 space-y-0.5 border-l border-slate-700 pl-3">
                          {childItems.map((child) => (
                            <li key={child.to}>
                              <NavLink
                                to={child.to}
                                end
                                onClick={onNavigate}
                                className={({ isActive }) =>
                                  `block rounded-md px-2.5 py-1.5 text-[13px] transition-colors ${
                                    isActive
                                      ? 'bg-slate-800 font-medium text-white'
                                      : 'text-slate-400 hover:text-white'
                                  }`
                                }
                              >
                                {child.label}
                              </NavLink>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>

      {/* user */}
      <div className="border-t border-slate-800 p-3">
        <div className="flex items-center gap-2.5 rounded-lg px-2 py-2">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-slate-700 text-xs font-semibold text-white">
            {user ? initials(user.full_name) : '?'}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-white">{user?.full_name}</p>
            <p className="text-[11px] capitalize text-slate-400">{user?.role.toLowerCase()}</p>
          </div>
          <button
            type="button"
            onClick={logout}
            title="Sign out"
            aria-label="Sign out"
            className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
          >
            <LogOut className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}

export function AppLayout({ children }: { children?: ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="flex h-full">
      {/* desktop sidebar */}
      <aside className="hidden w-60 shrink-0 lg:block">
        <div className="fixed inset-y-0 left-0 w-60">
          <SidebarContent />
        </div>
      </aside>

      {/* tablet / mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            className="absolute inset-0 bg-slate-900/50"
            onClick={() => setDrawerOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 w-64 animate-fade-in shadow-pop">
            <SidebarContent onNavigate={() => setDrawerOpen(false)} />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* mobile top bar */}
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 lg:hidden">
          <button
            type="button"
            onClick={() => setDrawerOpen((v) => !v)}
            aria-label="Toggle navigation"
            className="rounded-md p-1.5 text-slate-600 hover:bg-slate-100"
          >
            {drawerOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
          <span className="text-sm font-semibold text-slate-900">PharmaPulse Retail</span>
        </header>

        <main className="flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-[1400px] animate-fade-in">{children ?? <Outlet />}</div>
        </main>
      </div>
    </div>
  );
}
