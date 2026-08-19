import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, RotateCcw, Save, ShieldCheck, UserPlus } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useAuth } from '../hooks/useAuth';
import { Card, ErrorState, LoadingBlock, PageHeader, Pill, SegmentedControl } from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { date } from '../utils/format';
import { api, ApiError } from '../services/api';

/**
 * SETTINGS
 * ========
 *
 * Pharmacy profile, analytics thresholds and users.
 *
 * The thresholds matter more than they look: the analytics engine and the Mini
 * Analyst read them at request time, so changing one here changes what the
 * system reports on the next page load — with no code change and no restart.
 * That is the claim the Analytics Methodology makes, and this screen is where
 * it becomes true.
 */

interface SettingsPayload {
  settings: Record<string, string>;
  profile: Record<string, string>;
  thresholds: Record<string, number>;
  defaults: Record<string, number>;
}

interface UserRow {
  id: number;
  username: string;
  full_name: string;
  role: string;
  status: string;
  created_at: string;
}

const PROFILE_FIELDS: { key: string; label: string; hint?: string }[] = [
  { key: 'pharmacy_name', label: 'Pharmacy name' },
  { key: 'pharmacy_address', label: 'Address' },
  { key: 'pharmacy_phone', label: 'Phone' },
  { key: 'pharmacy_email', label: 'Email' },
  { key: 'pharmacy_tax_id', label: 'GSTIN', hint: 'Printed on invoices' },
  { key: 'pharmacy_city', label: 'City', hint: 'Used to rank nearby distributors' },
  { key: 'pharmacy_area', label: 'Area' },
  { key: 'pharmacy_pin', label: 'PIN code' },
  { key: 'currency_symbol', label: 'Currency symbol' },
  { key: 'invoice_prefix', label: 'Invoice prefix' },
  { key: 'purchase_prefix', label: 'Purchase prefix' },
  { key: 'return_prefix', label: 'Return prefix' },
];

const THRESHOLD_FIELDS: { key: string; label: string; hint: string; unit?: string }[] = [
  { key: 'expiryWarningDays', label: 'Expiry warning window', hint: 'A batch is "expiring soon" inside this many days.', unit: 'days' },
  { key: 'expiryCriticalDays', label: 'Expiry critical window', hint: 'Drives the urgent expiry alert.', unit: 'days' },
  { key: 'deadStockDays', label: 'Dead stock threshold', hint: 'Stock with no sale for this long counts as dead.', unit: 'days' },
  { key: 'analysisWindowDays', label: 'Analysis window', hint: 'Default period for velocity and growth.', unit: 'days' },
  { key: 'criticalCoverageDays', label: 'Critical stock coverage', hint: 'Coverage below this is treated as a stock-out risk.', unit: 'days' },
  { key: 'lowStockThresholdMultiplier', label: 'Low stock multiplier', hint: 'Scales the reorder level. 1 means exactly at reorder level.' },
  { key: 'overstockMultiplier', label: 'Overstock multiplier', hint: 'Scales maximum stock for the overstock test.' },
  { key: 'salesGrowthThresholdPct', label: 'Sales trend threshold', hint: 'Movement needed before a trend is reported.', unit: '%' },
  { key: 'revenueConcentrationTopN', label: 'Concentration top N', hint: 'N for the headline revenue-concentration figure.' },
  { key: 'healthPenaltyStockoutPerPct', label: 'Health penalty — stock-outs', hint: 'Points deducted per percent of SKUs out of stock.' },
  { key: 'healthPenaltyExpiryPerPct', label: 'Health penalty — expiring', hint: 'Points deducted per percent expiring.' },
  { key: 'healthPenaltyDeadStockPerPct', label: 'Health penalty — dead stock', hint: 'Points deducted per percent dead.' },
  { key: 'healthPenaltyOverstockPerPct', label: 'Health penalty — overstock', hint: 'Points deducted per percent overstocked.' },
];

const TABS = [
  { label: 'Pharmacy profile', value: 'profile' },
  { label: 'Analytics thresholds', value: 'thresholds' },
  { label: 'Users', value: 'users' },
];

export default function Settings() {
  const { user, refreshProfile } = useAuth();
  const [tab, setTab] = useState('profile');
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const { data, error, loading, reload } = useApi<SettingsPayload>('/settings');
  const { data: users, reload: reloadUsers } = useApi<{ data: UserRow[] }>(
    user?.role === 'ADMIN' ? '/auth/users' : null,
  );

  // Seed the draft once the server values arrive, without clobbering edits.
  useEffect(() => {
    if (data) setDraft({});
  }, [data]);

  const isAdmin = user?.role === 'ADMIN';
  const value = (key: string): string =>
    draft[key] ?? String(data?.settings[key] ?? data?.thresholds[key] ?? '');
  const set = (key: string, v: string) => setDraft((d) => ({ ...d, [key]: v }));
  const dirty = Object.keys(draft).length > 0;

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      await api.put('/settings', draft);
      setMessage({
        tone: 'ok',
        text: 'Settings saved. Analytics and the Mini Analyst will use the new values on the next page load.',
      });
      setDraft({});
      reload();
      void refreshProfile();
    } catch (err) {
      setMessage({ tone: 'error', text: err instanceof ApiError ? err.message : 'Could not save settings.' });
    } finally {
      setBusy(false);
    }
  }

  function resetThresholds() {
    if (!data) return;
    const restored: Record<string, string> = {};
    for (const [key, v] of Object.entries(data.defaults)) restored[key] = String(v);
    setDraft((d) => ({ ...d, ...restored }));
  }

  if (error) {
    return (
      <>
        <PageHeader title="Settings" />
        <Card>
          <ErrorState message={error} onRetry={reload} />
        </Card>
      </>
    );
  }

  if (!data || loading) {
    return (
      <>
        <PageHeader title="Settings" />
        <Card>
          <LoadingBlock rows={8} />
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Pharmacy profile, analytics thresholds and user accounts"
        actions={
          <>
            <SegmentedControl options={TABS} value={tab} onChange={setTab} />
            {isAdmin && tab !== 'users' && (
              <button type="button" className="btn-primary" onClick={save} disabled={busy || !dirty}>
                <Save className="h-4 w-4" aria-hidden />
                {busy ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
              </button>
            )}
          </>
        }
      />

      {!isAdmin && (
        <div className="card mb-4 flex items-start gap-2.5 border-amber-200 bg-amber-50/60 p-3">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
          <p className="text-xs leading-relaxed text-amber-900">
            You are signed in as <strong>{user?.role.toLowerCase()}</strong>. Settings are read-only
            for your role — only an administrator can change them. The API enforces this
            independently of what this screen shows.
          </p>
        </div>
      )}

      {message && (
        <div className={`card mb-4 border-l-4 p-4 ${message.tone === 'ok' ? 'border-l-emerald-500' : 'border-l-rose-500'}`}>
          <div className="flex items-start gap-2.5 text-sm text-slate-700">
            {message.tone === 'ok' ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
            ) : (
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" aria-hidden />
            )}
            {message.text}
          </div>
        </div>
      )}

      {/* ----------------------------------------------------------- profile */}
      {tab === 'profile' && (
        <Card title="Pharmacy profile" subtitle="Appears on invoices and drives distributor distance ranking" bodyClassName="p-4">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {PROFILE_FIELDS.map((field) => (
              <div key={field.key}>
                <label className="label" htmlFor={field.key}>
                  {field.label}
                </label>
                <input
                  id={field.key}
                  className="input"
                  disabled={!isAdmin}
                  value={value(field.key)}
                  onChange={(e) => set(field.key, e.target.value)}
                />
                {field.hint && <p className="mt-1 text-xs text-slate-500">{field.hint}</p>}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* -------------------------------------------------------- thresholds */}
      {tab === 'thresholds' && (
        <Card
          title="Analytics thresholds"
          subtitle="Read at request time by the analytics engine and the Mini Analyst"
          bodyClassName="p-4"
          actions={
            isAdmin && (
              <button type="button" className="btn-ghost text-xs" onClick={resetThresholds}>
                <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                Restore defaults
              </button>
            )
          }
        >
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {THRESHOLD_FIELDS.map((field) => {
              const current = value(field.key);
              const defaultValue = data.defaults[field.key];
              const changed = defaultValue !== undefined && Number(current) !== Number(defaultValue);
              return (
                <div key={field.key}>
                  <label className="label flex items-center justify-between" htmlFor={field.key}>
                    <span>{field.label}</span>
                    {changed && <Pill tone="amber">changed</Pill>}
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      id={field.key}
                      type="number"
                      step="any"
                      min={0}
                      className="input"
                      disabled={!isAdmin}
                      value={current}
                      onChange={(e) => set(field.key, e.target.value)}
                    />
                    {field.unit && <span className="shrink-0 text-xs text-slate-500">{field.unit}</span>}
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-slate-500">
                    {field.hint}
                    {defaultValue !== undefined && (
                      <span className="text-slate-400"> Default {defaultValue}.</span>
                    )}
                  </p>
                </div>
              );
            })}
          </div>

          <p className="mt-5 border-t border-slate-100 pt-4 text-xs leading-relaxed text-slate-500">
            These values are stored in the database, not compiled into the code. Raising the dead
            stock threshold from 90 to 120 days, for example, immediately changes which products the
            Mini Analyst flags — no rebuild, no restart. That is what makes the analytics engine
            genuinely configurable rather than merely parameterised.
          </p>
        </Card>
      )}

      {/* ------------------------------------------------------------- users */}
      {tab === 'users' && (
        <UserManagement users={users?.data ?? []} isAdmin={isAdmin} onChange={reloadUsers} />
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */

const ROLE_TONE: Record<string, string> = { ADMIN: 'rose', PHARMACIST: 'brand', STAFF: 'slate' };

function UserManagement({
  users,
  isAdmin,
  onChange,
}: {
  users: UserRow[];
  isAdmin: boolean;
  onChange: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ username: '', password: '', full_name: '', role: 'STAFF' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  async function create() {
    setBusy(true);
    setMessage(null);
    try {
      await api.post('/auth/users', form);
      setMessage({ tone: 'ok', text: `${form.full_name} added as ${form.role.toLowerCase()}.` });
      setForm({ username: '', password: '', full_name: '', role: 'STAFF' });
      setAdding(false);
      onChange();
    } catch (err) {
      setMessage({ tone: 'error', text: err instanceof ApiError ? err.message : 'Could not create the user.' });
    } finally {
      setBusy(false);
    }
  }

  async function toggle(row: UserRow) {
    setBusy(true);
    setMessage(null);
    try {
      await api.patch(`/auth/users/${row.id}/status`, {
        status: row.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
      });
      onChange();
    } catch (err) {
      setMessage({ tone: 'error', text: err instanceof ApiError ? err.message : 'Could not update the account.' });
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<UserRow>[] = [
    { key: 'name', header: 'Name', render: (r) => <span className="font-medium text-slate-800">{r.full_name}</span> },
    { key: 'username', header: 'Username', render: (r) => <span className="font-mono text-xs">{r.username}</span> },
    { key: 'role', header: 'Role', render: (r) => <Pill tone={ROLE_TONE[r.role] ?? 'slate'}>{r.role.toLowerCase()}</Pill> },
    {
      key: 'status',
      header: 'Status',
      render: (r) => <Pill tone={r.status === 'ACTIVE' ? 'emerald' : 'slate'}>{r.status.toLowerCase()}</Pill>,
    },
    { key: 'created', header: 'Created', secondary: true, render: (r) => date(r.created_at) },
    {
      key: 'action',
      header: '',
      align: 'right',
      render: (r) =>
        isAdmin ? (
          <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => toggle(r)} disabled={busy}>
            {r.status === 'ACTIVE' ? 'Deactivate' : 'Reactivate'}
          </button>
        ) : null,
    },
  ];

  return (
    <>
      {message && (
        <div className={`card mb-4 border-l-4 p-4 ${message.tone === 'ok' ? 'border-l-emerald-500' : 'border-l-rose-500'}`}>
          <p className="text-sm text-slate-700">{message.text}</p>
        </div>
      )}

      {adding && (
        <Card className="mb-4" title="New user" bodyClassName="p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-48">
              <label className="label" htmlFor="u-name">Full name</label>
              <input id="u-name" className="input" value={form.full_name} onChange={(e) => setForm((f) => ({ ...f, full_name: e.target.value }))} />
            </div>
            <div className="w-40">
              <label className="label" htmlFor="u-username">Username</label>
              <input id="u-username" className="input" value={form.username} onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} />
            </div>
            <div className="w-44">
              <label className="label" htmlFor="u-password">Password</label>
              <input id="u-password" type="password" className="input" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} />
            </div>
            <div className="w-40">
              <label className="label" htmlFor="u-role">Role</label>
              <select id="u-role" className="input" value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}>
                <option value="STAFF">Counter staff</option>
                <option value="PHARMACIST">Pharmacist</option>
                <option value="ADMIN">Admin</option>
              </select>
            </div>
            <button
              type="button"
              className="btn-primary"
              onClick={create}
              disabled={busy || !form.full_name.trim() || form.username.trim().length < 3 || form.password.length < 6}
            >
              Create user
            </button>
            <button type="button" className="btn-secondary" onClick={() => setAdding(false)} disabled={busy}>
              Cancel
            </button>
            <p className="w-full text-xs text-slate-500">
              Username must be at least 3 characters and the password at least 6. Passwords are
              bcrypt-hashed — they are never stored in readable form.
            </p>
          </div>
        </Card>
      )}

      <Card
        title="User accounts"
        subtitle="Admin sees everything · Pharmacist covers sales, inventory and purchasing · Staff bills and reads stock"
        bodyClassName="p-0"
        actions={
          isAdmin && (
            <button type="button" className="btn-secondary text-xs" onClick={() => setAdding((v) => !v)}>
              <UserPlus className="h-3.5 w-3.5" aria-hidden />
              Add user
            </button>
          )
        }
      >
        <DataTable columns={columns} rows={users} rowKey={(row) => row.id} emptyTitle="No users" />
      </Card>

      <p className="mt-4 text-xs leading-relaxed text-slate-400">
        The last active administrator cannot be deactivated — locking everyone out of the
        application is not a recoverable state. Role restrictions are enforced by the API on every
        request, not by hiding buttons here.
      </p>
    </>
  );
}
