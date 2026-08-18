import type { NextFunction, Request, Response } from 'express';
import { AppError, humanizeSqliteError } from '../utils/errors';
import { config } from '../config';

/**
 * Central error handler.
 *
 * The rule is deliberately strict:
 *   - AppError            -> its own status and message go to the client.
 *   - SQLite constraint   -> translated into a message a pharmacist can act on.
 *   - anything else       -> logged in full server-side, generic 500 to client.
 *
 * Stack traces, SQL text and file paths never reach the browser. Leaking them
 * would tell an attacker the schema and the framework versions.
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  // Express identifies an error handler by its four-parameter signature, so
  // `next` must stay even though it is unused.
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: { code: err.code, message: err.message, details: err.details ?? undefined },
    });
    return;
  }

  const humanized = humanizeSqliteError(err);
  if (humanized) {
    console.error('[db-constraint]', err instanceof Error ? err.message : err);
    res.status(409).json({ error: { code: 'CONSTRAINT', message: humanized } });
    return;
  }

  console.error('[unhandled]', err);
  res.status(500).json({
    error: {
      code: 'INTERNAL',
      message: 'Something went wrong on the server. Check the API console for details.',
      // Only in development, and only the message - never the stack.
      details: config.env === 'development' && err instanceof Error ? err.message : undefined,
    },
  });
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `No API route matches ${req.method} ${req.originalUrl}` },
  });
}

/**
 * Wraps a handler so a thrown error reaches `errorHandler` instead of crashing
 * the process. Every service call in this codebase is synchronous
 * (better-sqlite3), but route handlers are still written defensively.
 */
export function wrap(
  handler: (req: Request, res: Response) => unknown | Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const result = handler(req, res);
      if (result instanceof Promise) result.catch(next);
    } catch (err) {
      next(err);
    }
  };
}
