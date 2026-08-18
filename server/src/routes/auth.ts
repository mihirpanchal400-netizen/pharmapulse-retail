import { Router } from 'express';
import { z } from 'zod';
import { validateBody } from '../middleware/validate';
import { wrap } from '../middleware/error';
import { adminOnly, requireAuth } from '../middleware/auth';
import * as auth from '../services/authService';
import type { Role } from '../types';

const router = Router();

const loginSchema = z.object({
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
});

router.post(
  '/login',
  validateBody(loginSchema),
  wrap((req, res) => {
    const { username, password } = req.body as z.infer<typeof loginSchema>;
    res.json(auth.login(username, password));
  }),
);

/** Lets the client confirm a stored token is still valid on page load. */
router.get(
  '/me',
  requireAuth,
  wrap((req, res) => {
    res.json({ user: auth.getUserById(req.user!.id) });
  }),
);

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6, 'New password must be at least 6 characters'),
});

router.post(
  '/change-password',
  requireAuth,
  validateBody(changePasswordSchema),
  wrap((req, res) => {
    const { currentPassword, newPassword } = req.body as z.infer<typeof changePasswordSchema>;
    auth.changePassword(req.user!.id, currentPassword, newPassword);
    res.json({ ok: true, message: 'Password updated.' });
  }),
);

// ------------------------------------------------------------ user admin
router.get(
  '/users',
  requireAuth,
  adminOnly,
  wrap((_req, res) => res.json({ data: auth.listUsers() })),
);

const createUserSchema = z.object({
  username: z.string().min(3, 'Username must be at least 3 characters'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  full_name: z.string().min(1, 'Full name is required'),
  role: z.enum(['ADMIN', 'PHARMACIST', 'STAFF']),
});

router.post(
  '/users',
  requireAuth,
  adminOnly,
  validateBody(createUserSchema),
  wrap((req, res) => {
    const body = req.body as z.infer<typeof createUserSchema>;
    res.status(201).json(auth.createUser({ ...body, role: body.role as Role }));
  }),
);

const statusSchema = z.object({ status: z.enum(['ACTIVE', 'INACTIVE']) });

router.patch(
  '/users/:id/status',
  requireAuth,
  adminOnly,
  validateBody(statusSchema),
  wrap((req, res) => {
    const { status } = req.body as z.infer<typeof statusSchema>;
    res.json(auth.setUserStatus(Number(req.params.id), status));
  }),
);

export default router;
