import type { ReactNode } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Inbox,
  Loader2,
  Minus,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { percentSigned } from '../utils/format';
import type { InsightSeverity, StockStatus } from '../types';

/* -------------------------------------------------------------------------- */
/* Layout primitives                                                           */
/* -------------------------------------------------------------------------- */

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({
  title,
  subtitle,
  actions,
  children,
  className = '',
  bodyClassName = 'p-5',
}: {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-header">
          <div>
            {title && <h2 className="card-title">{title}</h2>}
            {subtitle && <p className="card-subtitle">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* State placeholders                                                          */
/* -------------------------------------------------------------------------- */

export function Spinner({ className = 'h-5 w-5' }: { className?: string }) {
  return <Loader2 className={`${className} animate-spin text-brand-600`} aria-hidden />;
}

export function LoadingBlock({ label = 'Loading…', rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div className="space-y-3" role="status" aria-label={label}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-4 animate-pulse rounded bg-slate-100" style={{ width: `${92 - i * 14}%` }} />
      ))}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-4 py-10 text-center">
      <AlertCircle className="h-8 w-8 text-rose-500" aria-hidden />
      <p className="max-w-md text-sm text-slate-600">{message}</p>
      {onRetry && (
        <button type="button" className="btn-secondary" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  message,
  icon: Icon = Inbox,
  action,
}: {
  title: string;
  message?: string;
  icon?: typeof Inbox;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-center">
      <Icon className="h-8 w-8 text-slate-300" aria-hidden />
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {message && <p className="max-w-sm text-sm text-slate-500">{message}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* KPI tile                                                                    */
/* -------------------------------------------------------------------------- */

export function KpiCard({
  label,
  value,
  sub,
  change,
  /** Some metrics are better when they fall (stock-outs, expiry). */
  invertChange = false,
  icon: Icon,
  tone = 'default',
  to,
}: {
  label: string;
  value: string;
  sub?: string;
  change?: number | null;
  invertChange?: boolean;
  icon?: typeof Inbox;
  tone?: 'default' | 'warning' | 'danger' | 'success';
  to?: string;
}) {
  const toneRing: Record<string, string> = {
    default: 'border-slate-200',
    warning: 'border-amber-200 bg-amber-50/40',
    danger: 'border-rose-200 bg-rose-50/40',
    success: 'border-emerald-200 bg-emerald-50/40',
  };
  const toneIcon: Record<string, string> = {
    default: 'bg-slate-100 text-slate-500',
    warning: 'bg-amber-100 text-amber-600',
    danger: 'bg-rose-100 text-rose-600',
    success: 'bg-emerald-100 text-emerald-600',
  };

  const improving = change === null || change === undefined ? null : invertChange ? change < 0 : change > 0;
  const flat = change !== null && change !== undefined && Math.abs(change) < 0.05;

  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
        {Icon && (
          <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${toneIcon[tone]}`}>
            <Icon className="h-4 w-4" aria-hidden />
          </span>
        )}
      </div>
      <p className="mt-3 text-2xl font-semibold tracking-tight text-slate-900 tnum">{value}</p>
      <div className="mt-1 flex items-center gap-2 text-xs">
        {change !== null && change !== undefined && (
          <span
            className={`inline-flex items-center gap-0.5 font-medium ${
              flat ? 'text-slate-500' : improving ? 'text-emerald-600' : 'text-rose-600'
            }`}
          >
            {flat ? (
              <Minus className="h-3 w-3" aria-hidden />
            ) : change > 0 ? (
              <ArrowUpRight className="h-3 w-3" aria-hidden />
            ) : (
              <ArrowDownRight className="h-3 w-3" aria-hidden />
            )}
            {percentSigned(change)}
          </span>
        )}
        {sub && <span className="text-slate-500">{sub}</span>}
      </div>
    </>
  );

  const className = `card ${toneRing[tone]} p-4 transition-shadow ${to ? 'hover:shadow-pop' : ''}`;

  return to ? (
    <Link to={to} className={`${className} block`}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}

/* -------------------------------------------------------------------------- */
/* Badges                                                                      */
/* -------------------------------------------------------------------------- */

const STOCK_STYLES: Record<StockStatus, { label: string; className: string }> = {
  OUT_OF_STOCK: { label: 'Out of stock', className: 'bg-rose-100 text-rose-700' },
  LOW_STOCK: { label: 'Low stock', className: 'bg-amber-100 text-amber-700' },
  EXPIRING: { label: 'Expiring', className: 'bg-orange-100 text-orange-700' },
  OVERSTOCKED: { label: 'Overstocked', className: 'bg-sky-100 text-sky-700' },
  HEALTHY: { label: 'Healthy', className: 'bg-emerald-100 text-emerald-700' },
};

export function StockBadge({ status }: { status: StockStatus }) {
  const style = STOCK_STYLES[status] ?? STOCK_STYLES.HEALTHY;
  return <span className={`badge ${style.className}`}>{style.label}</span>;
}

export const SEVERITY_STYLES: Record<
  InsightSeverity,
  { label: string; dot: string; chip: string; border: string; text: string }
> = {
  CRITICAL: {
    label: 'Action required',
    dot: 'bg-rose-500',
    chip: 'bg-rose-100 text-rose-700',
    border: 'border-l-rose-500',
    text: 'text-rose-700',
  },
  HIGH: {
    label: 'High priority',
    dot: 'bg-orange-500',
    chip: 'bg-orange-100 text-orange-700',
    border: 'border-l-orange-500',
    text: 'text-orange-700',
  },
  MEDIUM: {
    label: 'Worth reviewing',
    dot: 'bg-amber-500',
    chip: 'bg-amber-100 text-amber-700',
    border: 'border-l-amber-500',
    text: 'text-amber-700',
  },
  LOW: {
    label: 'Informational',
    dot: 'bg-sky-500',
    chip: 'bg-sky-100 text-sky-700',
    border: 'border-l-sky-500',
    text: 'text-sky-700',
  },
};

export function SeverityBadge({ severity }: { severity: InsightSeverity }) {
  const style = SEVERITY_STYLES[severity];
  return (
    <span className={`badge ${style.chip}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} aria-hidden />
      {severity}
    </span>
  );
}

export function Pill({ children, tone = 'slate' }: { children: ReactNode; tone?: string }) {
  const tones: Record<string, string> = {
    slate: 'bg-slate-100 text-slate-600',
    brand: 'bg-brand-50 text-brand-700',
    rose: 'bg-rose-100 text-rose-700',
    amber: 'bg-amber-100 text-amber-700',
    emerald: 'bg-emerald-100 text-emerald-700',
  };
  return <span className={`badge ${tones[tone] ?? tones.slate}`}>{children}</span>;
}

/* -------------------------------------------------------------------------- */
/* Misc                                                                        */
/* -------------------------------------------------------------------------- */

export function SegmentedControl<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: { label: string; value: T }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5" role="tablist">
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          onClick={() => onChange(option.value)}
          className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
            option.value === value
              ? 'bg-white text-slate-900 shadow-sm'
              : 'text-slate-500 hover:text-slate-700'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function ViewLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:text-brand-800"
    >
      {children}
      <ArrowRight className="h-3.5 w-3.5" aria-hidden />
    </Link>
  );
}

/** Small inline warning used where a figure needs a caveat next to it. */
export function Caveat({ children }: { children: ReactNode }) {
  return (
    <p className="mt-2 flex items-start gap-1.5 text-xs text-slate-500">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden />
      <span>{children}</span>
    </p>
  );
}
