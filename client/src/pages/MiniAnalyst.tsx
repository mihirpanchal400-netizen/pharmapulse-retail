import { useState } from 'react';
import { Info, RefreshCw, Zap } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { Card, ErrorState, LoadingBlock, PageHeader, SegmentedControl } from '../components/ui';
import { InsightCard } from '../components/InsightCard';
import { currency, dateTime, number, percent } from '../utils/format';
import type { AnalystReport, InsightSeverity } from '../types';

/**
 * The full Mini Analyst report.
 *
 * The methodology panel is shown alongside the results rather than hidden in
 * documentation, because the central claim of this feature is that the ranking
 * is auditable. Putting the formula next to the output is what makes that claim
 * checkable by the person reading it.
 */

const FILTERS: { label: string; value: InsightSeverity | 'ALL' }[] = [
  { label: 'All', value: 'ALL' },
  { label: 'Critical', value: 'CRITICAL' },
  { label: 'High', value: 'HIGH' },
  { label: 'Medium', value: 'MEDIUM' },
  { label: 'Low', value: 'LOW' },
];

export default function MiniAnalyst() {
  const [filter, setFilter] = useState<InsightSeverity | 'ALL'>('ALL');
  const { data, error, loading, reload } = useApi<AnalystReport>('/analytics/mini-analyst');

  if (error) {
    return (
      <>
        <PageHeader title="Mini Analyst" />
        <Card>
          <ErrorState message={error} onRetry={reload} />
        </Card>
      </>
    );
  }

  if (loading && !data) {
    return (
      <>
        <PageHeader title="Mini Analyst" subtitle="Analysing your transaction history…" />
        <div className="grid gap-4 lg:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="card p-4">
              <LoadingBlock rows={4} />
            </div>
          ))}
        </div>
      </>
    );
  }

  if (!data) return null;

  const visible =
    filter === 'ALL' ? data.insights : data.insights.filter((i) => i.severity === filter);

  return (
    <>
      <PageHeader
        title="Mini Analyst"
        subtitle="Your pharmacy's business intelligence assistant"
        actions={
          <button type="button" className="btn-secondary" onClick={reload} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden />
            Re-run analysis
          </button>
        }
      />

      {/* headline */}
      <div className="card mb-5 overflow-hidden">
        <div className="flex items-start gap-3 bg-slate-900 p-5 text-white">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-500">
            <Zap className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium leading-relaxed">{data.headline}</p>
            <p className="mt-1 text-xs text-slate-400">
              14 rules evaluated · {data.insights.length} fired · generated{' '}
              {dateTime(data.generatedAt.replace('T', ' ').slice(0, 16))}
            </p>
          </div>
        </div>

        <dl className="grid grid-cols-2 divide-x divide-slate-100 border-t border-slate-100 sm:grid-cols-3 lg:grid-cols-6">
          {[
            { label: 'Critical', value: number(data.counts.CRITICAL), tone: 'text-rose-600' },
            { label: 'High', value: number(data.counts.HIGH), tone: 'text-orange-600' },
            { label: 'Medium', value: number(data.counts.MEDIUM), tone: 'text-amber-600' },
            { label: 'Low', value: number(data.counts.LOW), tone: 'text-sky-600' },
            { label: 'Revenue (30d)', value: currency(data.context.revenue30d), tone: 'text-slate-900' },
            {
              label: 'Health score',
              value: `${number(data.context.healthScore, 1)}/100`,
              tone: 'text-slate-900',
            },
          ].map((stat) => (
            <div key={stat.label} className="px-4 py-3">
              <dt className="text-[11px] uppercase tracking-wide text-slate-500">{stat.label}</dt>
              <dd className={`mt-0.5 text-lg font-semibold tnum ${stat.tone}`}>{stat.value}</dd>
            </div>
          ))}
        </dl>
      </div>

      {/* methodology */}
      <div className="card mb-5 flex items-start gap-3 border-slate-200 bg-slate-50/60 p-4">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden />
        <div className="text-xs leading-relaxed text-slate-600">
          <p>
            <strong className="text-slate-800">How the ranking works.</strong>{' '}
            <code className="rounded bg-white px-1 py-0.5 font-mono text-[11px]">
              Priority = Impact × Urgency
            </code>
            , each scored 0–10. <strong>Impact</strong> scales the money at stake against an anchor of{' '}
            {currency(data.impactAnchor)} (2% of trailing 30-day revenue, floored at ₹1,000), so the
            same rules behave sensibly at any pharmacy size. <strong>Urgency</strong> scales the time
            until consequence against a 90-day horizon. Severity is derived from the score — Critical
            ≥ 70, High 45–69, Medium 25–44, Low below 25 — never assigned by hand.
          </p>
          <p className="mt-2">
            This is a <strong>deterministic rule engine</strong>, not a language model. It calls no
            external API, works offline, and returns identical output for identical data. Every
            insight below carries the arithmetic that produced it.
          </p>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl options={FILTERS} value={filter} onChange={setFilter} />
        <p className="text-xs text-slate-500">
          Showing {visible.length} of {data.insights.length} insights · inventory{' '}
          {currency(data.context.inventoryValue)} at cost · margin{' '}
          {percent(data.context.grossMargin30d)}
        </p>
      </div>

      {visible.length === 0 ? (
        <Card>
          <p className="py-10 text-center text-sm text-slate-500">
            {data.insights.length === 0
              ? 'No issues detected. Stock levels, expiry exposure and margin are all within their configured thresholds.'
              : `No ${filter.toLowerCase()} insights. Try a different severity.`}
          </p>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {visible.map((insight, index) => (
            <InsightCard key={insight.id} insight={insight} defaultOpen={index === 0} />
          ))}
        </div>
      )}

      <p className="mt-6 text-xs leading-relaxed text-slate-400">
        Thresholds behind these rules (expiry windows, dead-stock days, reorder multipliers) are
        configurable in Settings, and the engine reads them at request time — changing one changes
        this page on the next run, with no code change.
      </p>
    </>
  );
}
