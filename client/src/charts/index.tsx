import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { currencyCompact, dateShort, number, percent } from '../utils/format';

/**
 * Chart wrappers.
 *
 * All charts share one axis/grid/tooltip treatment so the dashboard reads as a
 * single system rather than a collection of defaults. Grid lines are faint and
 * horizontal only; axes carry no lines; the tooltip is a plain card.
 */

const AXIS = {
  stroke: '#94a3b8',
  fontSize: 11,
  tickLine: false,
  axisLine: false,
} as const;

const GRID = { stroke: '#e2e8f0', strokeDasharray: '3 3', vertical: false } as const;

/** A sequential-but-distinguishable set, ordered so adjacent slices contrast. */
export const CHART_COLORS = [
  '#279492', '#3b82f6', '#8b5cf6', '#f59e0b', '#ef4444',
  '#10b981', '#ec4899', '#06b6d4', '#84cc16', '#f97316',
  '#6366f1', '#14b8a6',
];

interface TooltipEntry {
  name?: string;
  value?: number | string;
  color?: string;
  dataKey?: string | number;
}

function ChartTooltip({
  active,
  payload,
  label,
  formatter,
  labelFormatter,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string | number;
  formatter?: (value: number, key: string) => string;
  labelFormatter?: (label: string) => string;
}) {
  if (!active || !payload?.length) return null;

  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-pop">
      {label !== undefined && (
        <p className="mb-1 text-xs font-medium text-slate-900">
          {labelFormatter ? labelFormatter(String(label)) : String(label)}
        </p>
      )}
      <ul className="space-y-0.5">
        {payload.map((entry, i) => (
          <li key={i} className="flex items-center gap-2 text-xs">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: entry.color }}
              aria-hidden
            />
            <span className="text-slate-500">{entry.name}</span>
            <span className="ml-auto font-medium text-slate-900 tnum">
              {formatter && typeof entry.value === 'number'
                ? formatter(entry.value, String(entry.dataKey ?? ''))
                : String(entry.value)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

export function SalesTrendChart({
  data,
  height = 280,
}: {
  data: { date: string; revenue: number; grossProfit: number }[];
  height?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="revenueFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#279492" stopOpacity={0.28} />
            <stop offset="100%" stopColor="#279492" stopOpacity={0.02} />
          </linearGradient>
          <linearGradient id="profitFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.2} />
            <stop offset="100%" stopColor="#3b82f6" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid {...GRID} />
        <XAxis dataKey="date" {...AXIS} tickFormatter={dateShort} minTickGap={28} />
        <YAxis {...AXIS} tickFormatter={(v) => currencyCompact(Number(v))} width={62} />
        <Tooltip
          content={
            <ChartTooltip
              labelFormatter={(l) => dateShort(l)}
              formatter={(v) => currencyCompact(v)}
            />
          }
        />
        <Area
          type="monotone"
          dataKey="revenue"
          name="Revenue"
          stroke="#279492"
          strokeWidth={2}
          fill="url(#revenueFill)"
        />
        <Area
          type="monotone"
          dataKey="grossProfit"
          name="Gross profit"
          stroke="#3b82f6"
          strokeWidth={2}
          fill="url(#profitFill)"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function CategoryBarChart({
  data,
  height = 300,
}: {
  data: { category: string; revenue: number; grossProfit: number }[];
  height?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 4 }}>
        <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" horizontal={false} />
        <XAxis type="number" {...AXIS} tickFormatter={(v) => currencyCompact(Number(v))} />
        <YAxis type="category" dataKey="category" {...AXIS} width={116} />
        <Tooltip
          cursor={{ fill: '#f1f5f9' }}
          content={<ChartTooltip formatter={(v) => currencyCompact(v)} />}
        />
        <Bar dataKey="revenue" name="Revenue" fill="#279492" radius={[0, 4, 4, 0]} barSize={14} />
        <Bar dataKey="grossProfit" name="Gross profit" fill="#93c5fd" radius={[0, 4, 4, 0]} barSize={14} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function InventoryHealthChart({
  data,
  height = 240,
}: {
  data: { name: string; value: number; color: string }[];
  height?: number;
}) {
  const total = data.reduce((sum, d) => sum + d.value, 0);
  if (total === 0) return null;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie
          data={data}
          dataKey="value"
          nameKey="name"
          innerRadius="58%"
          outerRadius="82%"
          paddingAngle={2}
          strokeWidth={0}
        >
          {data.map((entry) => (
            <Cell key={entry.name} fill={entry.color} />
          ))}
        </Pie>
        <Tooltip
          content={<ChartTooltip formatter={(v) => `${number(v)} SKUs (${percent((v / total) * 100)})`} />}
        />
        <Legend
          verticalAlign="bottom"
          iconType="circle"
          iconSize={8}
          formatter={(value) => <span className="text-xs text-slate-600">{value}</span>}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}

export function PaymentMixChart({
  data,
  height = 240,
}: {
  data: { method: string; value: number }[];
  height?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie data={data} dataKey="value" nameKey="method" outerRadius="78%" strokeWidth={0}>
          {data.map((entry, i) => (
            <Cell key={entry.method} fill={CHART_COLORS[i % CHART_COLORS.length]} />
          ))}
        </Pie>
        <Tooltip content={<ChartTooltip formatter={(v) => currencyCompact(v)} />} />
        <Legend
          verticalAlign="bottom"
          iconType="circle"
          iconSize={8}
          formatter={(value) => <span className="text-xs text-slate-600">{value}</span>}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}

export function MarginTrendChart({
  data,
  height = 260,
}: {
  data: { date: string; marginPct: number }[];
  height?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid {...GRID} />
        <XAxis dataKey="date" {...AXIS} tickFormatter={dateShort} minTickGap={28} />
        <YAxis {...AXIS} tickFormatter={(v) => `${v}%`} width={44} />
        <Tooltip
          content={
            <ChartTooltip labelFormatter={(l) => dateShort(l)} formatter={(v) => percent(v)} />
          }
        />
        <Line
          type="monotone"
          dataKey="marginPct"
          name="Gross margin"
          stroke="#8b5cf6"
          strokeWidth={2}
          dot={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function SimpleBarChart({
  data,
  xKey,
  bars,
  height = 260,
  currency: asCurrency = true,
}: {
  data: Record<string, unknown>[];
  xKey: string;
  bars: { key: string; name: string; color: string }[];
  height?: number;
  currency?: boolean;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid {...GRID} />
        <XAxis dataKey={xKey} {...AXIS} />
        <YAxis
          {...AXIS}
          width={asCurrency ? 62 : 40}
          tickFormatter={(v) => (asCurrency ? currencyCompact(Number(v)) : number(Number(v)))}
        />
        <Tooltip
          cursor={{ fill: '#f1f5f9' }}
          content={
            <ChartTooltip formatter={(v) => (asCurrency ? currencyCompact(v) : number(v))} />
          }
        />
        {bars.map((bar) => (
          <Bar key={bar.key} dataKey={bar.key} name={bar.name} fill={bar.color} radius={[4, 4, 0, 0]} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
