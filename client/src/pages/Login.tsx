import { useState, type FormEvent } from 'react';
import { AlertCircle, Loader2, Package } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { ApiError } from '../services/api';

/**
 * Sign-in screen.
 *
 * The demo credentials are printed on the page on purpose: this is a portfolio
 * project meant to be opened and explored by someone who has never seen it. The
 * README says the same thing, and the accounts only exist in a local synthetic
 * database.
 */

const DEMO_ACCOUNTS = [
  { username: 'admin', password: 'admin123', role: 'Admin', access: 'Everything, including Settings' },
  { username: 'pharmacist', password: 'pharma123', role: 'Pharmacist', access: 'Sales, inventory, purchases, analytics' },
  { username: 'staff', password: 'staff123', role: 'Staff', access: 'Billing and read-only stock' },
];

export default function Login() {
  const { login } = useAuth();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('admin123');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign-in failed. Please try again.');
      setBusy(false);
    }
  }

  function useAccount(account: (typeof DEMO_ACCOUNTS)[number]) {
    setUsername(account.username);
    setPassword(account.password);
    setError(null);
  }

  return (
    <div className="grid min-h-full lg:grid-cols-2">
      {/* Left: the pitch. Hidden on small screens where it would just push the
          form below the fold. */}
      <div className="hidden flex-col justify-between bg-slate-900 p-10 text-white lg:flex">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-brand-500">
            <Package className="h-5 w-5" aria-hidden />
          </span>
          <span className="text-base font-semibold">PharmaPulse Retail</span>
        </div>

        <div className="max-w-md">
          <h1 className="text-3xl font-semibold leading-tight tracking-tight">
            Retail pharmacy management, with an analyst built in.
          </h1>
          <p className="mt-4 text-sm leading-relaxed text-slate-300">
            Batch-level inventory with FEFO dispensing, point-of-sale billing, goods inward and
            returns — and a rule-based Mini Analyst that turns the transaction history into ranked,
            explained actions.
          </p>

          <dl className="mt-8 grid grid-cols-3 gap-4 border-t border-slate-800 pt-6">
            <div>
              <dt className="text-[11px] uppercase tracking-wide text-slate-500">Analytics</dt>
              <dd className="mt-1 text-sm font-medium">Rule-based</dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wide text-slate-500">Data</dt>
              <dd className="mt-1 text-sm font-medium">Local SQLite</dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wide text-slate-500">Network</dt>
              <dd className="mt-1 text-sm font-medium">Offline-first</dd>
            </div>
          </dl>
        </div>

        <p className="text-xs leading-relaxed text-slate-500">
          Demonstration software. All data is synthetic — no patient records, prescriptions or real
          pharmacy data are stored anywhere in this system.
        </p>
      </div>

      {/* Right: the form */}
      <div className="flex items-center justify-center bg-slate-100 p-6">
        <div className="w-full max-w-sm">
          <div className="mb-6 flex items-center gap-2.5 lg:hidden">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-brand-600 text-white">
              <Package className="h-5 w-5" aria-hidden />
            </span>
            <span className="text-base font-semibold text-slate-900">PharmaPulse Retail</span>
          </div>

          <div className="card p-6">
            <h2 className="text-lg font-semibold text-slate-900">Sign in</h2>
            <p className="mt-1 text-sm text-slate-500">Use a demo account to explore the system.</p>

            <form onSubmit={handleSubmit} className="mt-5 space-y-4">
              <div>
                <label className="label" htmlFor="username">
                  Username
                </label>
                <input
                  id="username"
                  className="input"
                  value={username}
                  autoComplete="username"
                  onChange={(e) => setUsername(e.target.value)}
                  required
                />
              </div>

              <div>
                <label className="label" htmlFor="password">
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  className="input"
                  value={password}
                  autoComplete="current-password"
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>

              {error && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-lg bg-rose-50 p-3 text-sm text-rose-700"
                >
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  <span>{error}</span>
                </div>
              )}

              <button type="submit" className="btn-primary w-full" disabled={busy}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
          </div>

          <div className="mt-4 card p-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Demo accounts
            </p>
            <ul className="space-y-1.5">
              {DEMO_ACCOUNTS.map((account) => (
                <li key={account.username}>
                  <button
                    type="button"
                    onClick={() => useAccount(account)}
                    className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-slate-50"
                  >
                    <span>
                      <span className="block text-sm font-medium text-slate-800">{account.role}</span>
                      <span className="block text-xs text-slate-500">{account.access}</span>
                    </span>
                    <code className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600">
                      {account.username} / {account.password}
                    </code>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
