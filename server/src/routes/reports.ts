import { Router } from 'express';
import { z } from 'zod';
import { query, validateQuery } from '../middleware/validate';
import { wrap } from '../middleware/error';
import { anyRole, operational } from '../middleware/auth';
import { listReports, generateReport, previewReport } from '../reports';

const router = Router();

const reportQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  days: z.coerce.number().int().positive().max(1825).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

type ReportQuery = z.infer<typeof reportQuerySchema>;

/** Catalogue of available reports, for the Reports screen. */
router.get(
  '/',
  anyRole,
  wrap((_req, res) => res.json({ data: listReports() })),
);

/** JSON preview so the user can see the data before committing to a download. */
router.get(
  '/:id/preview',
  anyRole,
  validateQuery(reportQuerySchema),
  wrap((req, res) => {
    const q = query<ReportQuery>(req);
    res.json(previewReport(req.params.id, q, q.limit ?? 20));
  }),
);

/**
 * CSV download.
 *
 * Restricted to Admin and Pharmacist: an export is a complete copy of the
 * pharmacy's commercial position, which is a different thing from being able to
 * read one screen of it.
 */
router.get(
  '/:id/download',
  operational,
  validateQuery(reportQuerySchema),
  wrap((req, res) => {
    const report = generateReport(req.params.id, query<ReportQuery>(req));

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${report.filename}"`);
    // Lets the browser fetch layer read the filename on a cross-origin dev request.
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Row-Count');
    res.setHeader('X-Row-Count', String(report.rowCount));
    res.send(report.csv);
  }),
);

export default router;
