import { getDb, type Db } from '../database/connection';
import { paginate, type Paged } from './inventoryService';

/**
 * AUDIT TRAIL
 * ===========
 *
 * Append-only log of who did what. Business software is expected to answer
 * "who changed this?" months later, and a pharmacy handling scheduled drugs has
 * a particular reason to care.
 *
 * Logging never throws. An audit write failing must not roll back the business
 * transaction that succeeded - losing the log line is bad, losing the sale is
 * worse. Failures are reported to the server console instead.
 */

export type ActivityModule =
  | 'AUTH'
  | 'PRODUCT'
  | 'INVENTORY'
  | 'BATCH'
  | 'SALE'
  | 'RETURN'
  | 'PURCHASE'
  | 'PURCHASE_ORDER'
  | 'DISTRIBUTOR'
  | 'SUPPLIER'
  | 'CUSTOMER'
  | 'PAYMENT'
  | 'SETTINGS'
  | 'USER';

export interface ActivityInput {
  userId?: number | null;
  username?: string | null;
  action: string;
  module: ActivityModule;
  recordType?: string | null;
  recordId?: number | null;
  summary?: string | null;
}

export function logActivity(input: ActivityInput, db: Db = getDb()): void {
  try {
    db.prepare(
      `INSERT INTO activity_log (user_id, username, action, module, record_type, record_id, summary)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.userId ?? null,
      input.username ?? null,
      input.action,
      input.module,
      input.recordType ?? null,
      input.recordId ?? null,
      input.summary ?? null,
    );
  } catch (err) {
    console.error('[activity-log]', err instanceof Error ? err.message : err);
  }
}

export interface ActivityRow {
  id: number;
  user_id: number | null;
  username: string | null;
  action: string;
  module: string;
  record_type: string | null;
  record_id: number | null;
  summary: string | null;
  created_at: string;
  full_name: string | null;
}

export function listActivity(query: {
  module?: string;
  userId?: number;
  from?: string;
  to?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}): Paged<ActivityRow> {
  const where: string[] = [];
  const params: Record<string, unknown> = {};

  if (query.module && query.module !== 'ALL') {
    where.push('a.module = @module');
    params.module = query.module;
  }
  if (query.userId) {
    where.push('a.user_id = @userId');
    params.userId = query.userId;
  }
  if (query.from) {
    where.push('date(a.created_at) >= @from');
    params.from = query.from;
  }
  if (query.to) {
    where.push('date(a.created_at) <= @to');
    params.to = query.to;
  }
  if (query.search) {
    where.push('(a.summary LIKE @like OR a.action LIKE @like OR a.username LIKE @like)');
    params.like = `%${query.search.trim()}%`;
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = getDb()
    .prepare(
      `SELECT a.*, u.full_name
       FROM activity_log a
       LEFT JOIN users u ON u.id = a.user_id
       ${clause}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT 2000`,
    )
    .all(params) as ActivityRow[];

  return paginate(rows, query.page, query.pageSize);
}
