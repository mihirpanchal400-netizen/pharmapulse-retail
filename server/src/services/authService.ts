import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { getDb } from '../database/connection';
import { config } from '../config';
import { badRequest, conflict, notFound, unauthorized } from '../utils/errors';
import type { Role, UserRow } from '../types';

/**
 * Authentication.
 *
 * Scope note: this is coursework-grade auth. Passwords are bcrypt-hashed and
 * sessions are signed JWTs, which is enough to demonstrate role-based access
 * control honestly. It is NOT hardened for production - there is no refresh
 * token rotation, no rate limiting and no MFA. See README "Limitations".
 */

export interface SessionUser {
  id: number;
  username: string;
  full_name: string;
  role: Role;
}

export interface TokenPayload extends SessionUser {
  iat?: number;
  exp?: number;
}

/** Strips the password hash before a user object ever leaves this module. */
function toSessionUser(row: UserRow): SessionUser {
  return { id: row.id, username: row.username, full_name: row.full_name, role: row.role };
}

export function signToken(user: SessionUser): string {
  return jwt.sign(user, config.jwtSecret, { expiresIn: config.jwtExpiresIn } as jwt.SignOptions);
}

export function verifyToken(token: string): TokenPayload {
  try {
    return jwt.verify(token, config.jwtSecret) as TokenPayload;
  } catch {
    // Expired and malformed tokens are deliberately indistinguishable to the client.
    throw unauthorized('Your session has expired. Please sign in again.');
  }
}

export function login(username: string, password: string): { token: string; user: SessionUser } {
  const row = getDb()
    .prepare('SELECT * FROM users WHERE username = ?')
    .get(String(username ?? '').trim().toLowerCase()) as UserRow | undefined;

  // Same message for "no such user" and "wrong password" so the endpoint cannot
  // be used to discover which usernames exist.
  if (!row) throw unauthorized('Incorrect username or password.');
  if (row.status !== 'ACTIVE') throw unauthorized('This account has been deactivated.');
  if (!bcrypt.compareSync(String(password ?? ''), row.password_hash)) {
    throw unauthorized('Incorrect username or password.');
  }

  const user = toSessionUser(row);
  return { token: signToken(user), user };
}

export function getUserById(id: number): SessionUser {
  const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  if (!row) throw notFound('User');
  return toSessionUser(row);
}

export function listUsers(): (SessionUser & { status: string; created_at: string })[] {
  const rows = getDb()
    .prepare('SELECT * FROM users ORDER BY id')
    .all() as UserRow[];
  return rows.map((r) => ({ ...toSessionUser(r), status: r.status, created_at: r.created_at }));
}

export interface CreateUserInput {
  username: string;
  password: string;
  full_name: string;
  role: Role;
}

export function createUser(input: CreateUserInput): SessionUser {
  const username = input.username.trim().toLowerCase();
  if (username.length < 3) throw badRequest('Username must be at least 3 characters.');
  if (input.password.length < 6) throw badRequest('Password must be at least 6 characters.');

  const existing = getDb().prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) throw conflict('That username is already taken.');

  const info = getDb()
    .prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?, ?, ?, ?)')
    .run(username, bcrypt.hashSync(input.password, 10), input.full_name.trim(), input.role);

  return getUserById(Number(info.lastInsertRowid));
}

export function changePassword(userId: number, currentPassword: string, newPassword: string): void {
  const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined;
  if (!row) throw notFound('User');
  if (!bcrypt.compareSync(currentPassword, row.password_hash)) {
    throw badRequest('Your current password is incorrect.');
  }
  if (newPassword.length < 6) throw badRequest('New password must be at least 6 characters.');

  getDb()
    .prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(bcrypt.hashSync(newPassword, 10), userId);
}

export function setUserStatus(userId: number, status: 'ACTIVE' | 'INACTIVE'): SessionUser {
  const admins = getDb()
    .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE'")
    .get() as { n: number };
  const target = getDb().prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined;
  if (!target) throw notFound('User');

  // Locking everyone out of the application is not a recoverable state.
  if (status === 'INACTIVE' && target.role === 'ADMIN' && admins.n <= 1) {
    throw badRequest('This is the last active administrator and cannot be deactivated.');
  }

  getDb().prepare('UPDATE users SET status = ? WHERE id = ?').run(status, userId);
  return getUserById(userId);
}
