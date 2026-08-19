import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ChevronDown, Lightbulb, Scale } from 'lucide-react';
import { SEVERITY_STYLES } from './ui';
import { number } from '../utils/format';
import type { Insight } from '../types';

/**
 * A single Mini Analyst insight.
 *
 * The explainability contract from ANALYTICS_METHODOLOGY.md is enforced here in
 * the UI: no insight is ever shown without the reasoning and the numbers that
 * triggered it. The "Why this fired" panel is collapsed by default so the card
 * stays scannable, but it is always present and always populated - it is never
 * conditional on the data being interesting.
 */

export function InsightCard({ insight, defaultOpen = false }: { insight: Insight; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const style = SEVERITY_STYLES[insight.severity];

  return (
    <article className={`card border-l-4 ${style.border} overflow-hidden`}>
      <div className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`badge ${style.chip}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} aria-hidden />
            {style.label}
          </span>
          <span className="badge bg-slate-100 text-slate-600">
            Priority {number(insight.priorityScore, 1)}
          </span>
          <span className="ml-auto font-mono text-[11px] text-slate-400">{insight.type}</span>
        </div>

        <h3 className="mt-2.5 text-sm font-semibold text-slate-900">{insight.title}</h3>
        <p className="mt-1 text-sm leading-relaxed text-slate-600">{insight.description}</p>

        {/* Recommendation - the action, visually separated from the finding. */}
        <div className="mt-3 flex gap-2 rounded-lg bg-brand-50/70 p-3">
          <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" aria-hidden />
          <p className="text-[13px] leading-relaxed text-brand-900">{insight.recommendation}</p>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-slate-900"
          >
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
            {open ? 'Hide reasoning' : 'Why this fired'}
          </button>

          {insight.link && (
            <Link
              to={insight.link}
              className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:text-brand-800"
            >
              {insight.linkLabel ?? 'View'}
              <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </Link>
          )}
        </div>
      </div>

      {open && (
        <div className="animate-fade-in border-t border-slate-100 bg-slate-50/60 p-4">
          <p className="mb-3 text-[13px] leading-relaxed text-slate-700">{insight.reason}</p>

          <dl className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
            {insight.evidence.map((item, i) => (
              <div key={i} className="flex items-baseline justify-between gap-3 border-b border-slate-200/70 py-1">
                <dt className="text-xs text-slate-500">{item.label}</dt>
                <dd className="text-xs font-medium text-slate-900 tnum">{item.value}</dd>
              </div>
            ))}
          </dl>

          <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-slate-500">
            <Scale className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              Priority = Impact ({number(insight.impact, 1)}) × Urgency ({number(insight.urgency, 1)}) ={' '}
              {number(insight.priorityScore, 1)}. Impact scales the money at stake against 2% of
              trailing 30-day revenue; urgency scales the time remaining against a 90-day horizon.
            </span>
          </p>
        </div>
      )}
    </article>
  );
}

/** Condensed row used where several insights are listed together. */
export function InsightRow({ insight }: { insight: Insight }) {
  const style = SEVERITY_STYLES[insight.severity];
  return (
    <div className="flex items-start gap-3 py-2.5">
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${style.dot}`} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-slate-800">{insight.title}</p>
        <p className="text-xs text-slate-500">
          {insight.severity} · priority {number(insight.priorityScore, 1)}
        </p>
      </div>
      {insight.link && (
        <Link
          to={insight.link}
          className="shrink-0 text-xs font-medium text-brand-700 hover:text-brand-800"
        >
          View
        </Link>
      )}
    </div>
  );
}
