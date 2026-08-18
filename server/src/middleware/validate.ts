import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodSchema } from 'zod';
import { badRequest } from '../utils/errors';

/**
 * Request validation at the API boundary.
 *
 * Nothing reaches a service until Zod has confirmed its shape, so services can
 * trust their inputs and are free of defensive type checks. Zod's issue list is
 * flattened into a message a user can act on, e.g.
 *   "quantity: must be a positive whole number; expiry_date: required"
 */

function formatZodError(err: ZodError): string {
  return err.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

export function validateBody<T>(schema: ZodSchema<T>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return next(badRequest(formatZodError(result.error), result.error.issues));
    }
    req.body = result.data;
    next();
  };
}

export function validateQuery<T>(schema: ZodSchema<T>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      return next(badRequest(formatZodError(result.error), result.error.issues));
    }
    // Express 4 allows req.query to be replaced; the parsed value carries the
    // coerced types (numbers, booleans) the handlers expect.
    (req as Request & { validatedQuery?: unknown }).validatedQuery = result.data;
    next();
  };
}

/** Reads the output of `validateQuery` in a typed way. */
export function query<T>(req: Request): T {
  return (req as Request & { validatedQuery?: T }).validatedQuery as T;
}

/**
 * Parses `:id` from the URL. Rejects anything that is not a positive integer
 * before it can reach a SQL parameter.
 */
export function idParam(req: Request, name = 'id'): number {
  const raw = req.params[name];
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw badRequest(`'${raw}' is not a valid ${name}.`);
  }
  return value;
}
