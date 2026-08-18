import type { NextFunction, Request, Response } from 'express';
import { verifyToken, type SessionUser } from '../services/authService';
import { forbidden, unauthorized } from '../utils/errors';
import type { Role } from '../types';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

/**
 * Rejects the request unless it carries a valid `Authorization: Bearer <token>`.
 * On success the decoded user is attached to `req.user` for downstream handlers.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return next(unauthorized('Please sign in to continue.'));
  }

  try {
    const payload = verifyToken(token);
    req.user = {
      id: payload.id,
      username: payload.username,
      full_name: payload.full_name,
      role: payload.role,
    };
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Role gate. Usage: `router.post('/', requireRole('ADMIN', 'PHARMACIST'), handler)`.
 *
 * Roles are not hierarchical in the code - each route lists exactly who may call
 * it. That is more verbose than a rank comparison but it makes the permission
 * matrix in ARCHITECTURE.md readable directly from the route files.
 */
export function requireRole(...allowed: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) return next(unauthorized());
    if (!allowed.includes(req.user.role)) {
      return next(
        forbidden(
          `This action is restricted to ${allowed.join(' or ')}. You are signed in as ${req.user.role}.`,
        ),
      );
    }
    next();
  };
}

/** Everyone who can sign in. Convenience alias used by read-only routes. */
export const anyRole = requireRole('ADMIN', 'PHARMACIST', 'STAFF');

/** Admin + Pharmacist: full operational access. */
export const operational = requireRole('ADMIN', 'PHARMACIST');

/** Admin only: settings and user management. */
export const adminOnly = requireRole('ADMIN');
