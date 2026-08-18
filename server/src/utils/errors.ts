/**
 * Application errors.
 *
 * `AppError` carries a user-facing message that is safe to display in the UI.
 * Anything that is NOT an AppError is treated as unexpected: the technical
 * detail is logged server-side and the client receives a generic message.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(message: string, statusCode = 400, code = 'BAD_REQUEST', details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(message, 400, 'BAD_REQUEST', details);

export const unauthorized = (message = 'Please sign in to continue.') =>
  new AppError(message, 401, 'UNAUTHORIZED');

export const forbidden = (message = 'Your role does not have access to this action.') =>
  new AppError(message, 403, 'FORBIDDEN');

export const notFound = (what = 'Record') => new AppError(`${what} not found.`, 404, 'NOT_FOUND');

export const conflict = (message: string) => new AppError(message, 409, 'CONFLICT');

/**
 * Translates raw SQLite errors into messages a pharmacy user can act on.
 * The original error is preserved for the server log by the error middleware.
 */
export function humanizeSqliteError(err: unknown): string | null {
  const message = err instanceof Error ? err.message : String(err);

  if (message.includes('FOREIGN KEY constraint failed')) {
    return 'This record is linked to other records (batches, sales or purchases) and cannot be changed or removed.';
  }
  if (message.includes('UNIQUE constraint failed: products.product_code')) {
    return 'A product with this product code already exists. Use a different code.';
  }
  if (message.includes('UNIQUE constraint failed: product_batches.product_id, product_batches.batch_number')) {
    return 'This batch number already exists for the selected product.';
  }
  if (message.includes('UNIQUE constraint failed: customers.customer_code')) {
    return 'A customer with this code already exists.';
  }
  if (message.includes('UNIQUE constraint failed: users.username')) {
    return 'That username is already taken.';
  }
  if (message.includes('UNIQUE constraint failed')) {
    return 'A record with these details already exists.';
  }
  if (message.includes('CHECK constraint failed: quantity')) {
    return 'Stock cannot go below zero. Check the quantity entered.';
  }
  if (message.includes('CHECK constraint failed')) {
    return 'One of the values entered is outside the allowed range.';
  }
  if (message.includes('NOT NULL constraint failed')) {
    return 'A required field is missing.';
  }
  return null;
}
