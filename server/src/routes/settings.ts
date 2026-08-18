import { Router } from 'express';
import { z } from 'zod';
import { validateBody } from '../middleware/validate';
import { wrap } from '../middleware/error';
import { adminOnly, anyRole } from '../middleware/auth';
import * as settings from '../services/settingsService';
import { defaultThresholds } from '../config';

const router = Router();

/**
 * Every signed-in user can READ settings - the client needs the currency symbol
 * and pharmacy name to render an invoice. Only an Admin can change them.
 */
router.get(
  '/',
  anyRole,
  wrap((_req, res) => {
    res.json({
      settings: settings.getAllSettings(),
      profile: settings.getPharmacyProfile(),
      thresholds: settings.getThresholds(),
      // Sent alongside so the Settings screen can offer "reset to default"
      // without hardcoding the numbers in the client.
      defaults: defaultThresholds,
    });
  }),
);

/**
 * Partial update: only the keys sent are changed.
 *
 * Values arrive as strings because the settings table is a key/value store.
 * Threshold keys are additionally checked to be finite non-negative numbers, so
 * a typo cannot put the analytics engine into an undefined state.
 */
const updateSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
  .refine((obj) => Object.keys(obj).length > 0, 'Send at least one setting to update')
  .superRefine((obj, ctx) => {
    for (const key of Object.keys(obj)) {
      if (!(key in defaultThresholds)) continue;
      const value = Number(obj[key]);
      if (!Number.isFinite(value) || value < 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: 'must be a number of zero or more',
        });
      }
    }
  });

router.put(
  '/',
  adminOnly,
  validateBody(updateSchema),
  wrap((req, res) => {
    const body = req.body as Record<string, string | number | boolean>;
    const updates = Object.fromEntries(
      Object.entries(body).map(([k, v]) => [k, String(v)]),
    );

    const updated = settings.updateSettings(updates);
    res.json({
      settings: updated,
      profile: settings.getPharmacyProfile(),
      thresholds: settings.getThresholds(),
      message: 'Settings saved. Analytics will use the new thresholds immediately.',
    });
  }),
);

export default router;
