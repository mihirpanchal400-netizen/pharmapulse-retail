import type { ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { EmptyState, ErrorState, LoadingBlock } from './ui';

/**
 * Shared table shell.
 *
 * Handles the four states every list screen needs - loading, error, empty and
 * populated - in one place, so no screen can accidentally ship with a blank
 * area where a message should be. Columns are declared as data rather than
 * markup so a table definition stays readable.
 */

export interface Column<T> {
  key: string;
  header: string;
  /** Cell renderer. Receives the whole row. */
  render: (row: T) => ReactNode;
  align?: 'left' | 'right' | 'center';
  /** Hidden below the lg breakpoint - use for secondary detail. */
  secondary?: boolean;
  width?: string;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  emptyTitle?: string;
  emptyMessage?: string;
  onRowClick?: (row: T) => void;
  /** Rendered under the last row - totals, notes. */
  footer?: ReactNode;
}

const ALIGN: Record<string, string> = {
  left: 'text-left',
  right: 'text-right',
  center: 'text-center',
};

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading,
  error,
  onRetry,
  emptyTitle = 'Nothing to show',
  emptyMessage,
  onRowClick,
  footer,
}: DataTableProps<T>) {
  if (error) return <ErrorState message={error} onRetry={onRetry} />;

  if (loading && rows.length === 0) {
    return (
      <div className="p-5">
        <LoadingBlock rows={6} />
      </div>
    );
  }

  if (rows.length === 0) return <EmptyState title={emptyTitle} message={emptyMessage} />;

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="bg-slate-50/70">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                style={column.width ? { width: column.width } : undefined}
                className={`th ${ALIGN[column.align ?? 'left']} ${column.secondary ? 'hidden lg:table-cell' : ''}`}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              className={`table-row ${onRowClick ? 'cursor-pointer' : ''}`}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
            >
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={`td ${ALIGN[column.align ?? 'left']} ${column.secondary ? 'hidden lg:table-cell' : ''}`}
                >
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {footer && (
          <tfoot>
            <tr className="border-t-2 border-slate-200 bg-slate-50/70 font-medium">
              <td colSpan={columns.length} className="td">
                {footer}
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

/** Search input with a leading icon, used above most tables. */
export function SearchInput({
  value,
  onChange,
  placeholder = 'Search…',
  className = '',
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className={`relative ${className}`}>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
      <input
        type="search"
        className="input pl-9"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

export function Select({
  value,
  onChange,
  options,
  label,
  className = '',
}: {
  value: string;
  onChange: (value: string) => void;
  options: { label: string; value: string }[];
  label?: string;
  className?: string;
}) {
  return (
    <select
      aria-label={label}
      className={`input ${className}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function Pagination({
  page,
  totalPages,
  total,
  onChange,
}: {
  page: number;
  totalPages: number;
  total: number;
  onChange: (page: number) => void;
}) {
  if (totalPages <= 1) {
    return <p className="px-5 py-3 text-xs text-slate-500">{total.toLocaleString('en-IN')} record(s)</p>;
  }

  return (
    <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-5 py-3">
      <p className="text-xs text-slate-500">
        Page {page} of {totalPages} · {total.toLocaleString('en-IN')} record(s)
      </p>
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="btn-secondary px-2 py-1.5"
          disabled={page <= 1}
          onClick={() => onChange(page - 1)}
          aria-label="Previous page"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          className="btn-secondary px-2 py-1.5"
          disabled={page >= totalPages}
          onClick={() => onChange(page + 1)}
          aria-label="Next page"
        >
          <ChevronRight className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
