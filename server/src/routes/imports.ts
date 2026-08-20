import { Router } from 'express';
import express from 'express';
import { z } from 'zod';
import { idParam, query, validateBody, validateQuery } from '../middleware/validate';
import { wrap } from '../middleware/error';
import { adminOnly, anyRole, operational } from '../middleware/auth';
import { badRequest } from '../utils/errors';
import { getDb } from '../database/connection';
import { toCsv } from '../utils/csv';
import { IMPORT_TYPES, type ColumnMapping, type ImportType } from '../import/types';
import { importDef, importTypeSummaries } from '../import/fields';
import {
  MAX_UPLOAD_BYTES,
  cancelImport,
  commitImport,
  createImportJob,
  getJob,
  importStats,
  listImportErrors,
  listImportJobs,
  previewImport,
  publicJob,
  suggestForSheet,
} from '../import/service';
import { buildTemplateWorkbook, templateFileName } from '../import/templates';

/**
 * Import Center API.
 *
 * The wizard is four calls: upload, suggest, preview, commit. Nothing is
 * written to the operational tables until commit, and commit re-validates from
 * the file rather than trusting anything the browser sends back.
 *
 * Permissions: Admin and Pharmacist may run an import, because an import
 * rewrites the product master and the shelf. Everyone may read the history,
 * since "where did this data come from?" is a question counter staff also need
 * answered.
 */

const router = Router();

const importTypeSchema = z.enum(IMPORT_TYPES as [ImportType, ...ImportType[]]);

/**
 * The raw-body parser used for uploads.
 *
 * A spreadsheet is posted as `application/octet-stream` with the file name in a
 * header, rather than as multipart form data. That avoids a multipart
 * dependency for a single-file upload, and keeps the byte cap in one obvious
 * place.
 */
const rawUpload = express.raw({
  type: ['application/octet-stream', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel', 'text/csv'],
  limit: MAX_UPLOAD_BYTES,
});

/* -------------------------------------------------------------------------- */
/* Catalogue and templates                                                     */
/* -------------------------------------------------------------------------- */

/** The predefined import types, for the Import Center landing screen. */
router.get(
  '/types',
  anyRole,
  wrap((_req, res) => res.json({ data: importTypeSummaries() })),
);

/** Full field list for one import type, used by the mapping screen. */
router.get(
  '/types/:type',
  anyRole,
  wrap((req, res) => {
    const parsed = importTypeSchema.safeParse(req.params.type);
    if (!parsed.success) throw badRequest(`"${req.params.type}" is not an import type.`);

    const def = importDef(parsed.data);
    res.json({
      data: {
        ...def,
        fields: def.fields.map((field) => ({
          key: field.key,
          label: field.label,
          type: field.type,
          required: Boolean(field.required),
          note: field.note,
          values: field.values,
          example: field.example,
        })),
      },
    });
  }),
);

/** Blank .xlsx template with an example row and a field guide. */
router.get(
  '/types/:type/template',
  anyRole,
  wrap(async (req, res) => {
    const parsed = importTypeSchema.safeParse(req.params.type);
    if (!parsed.success) throw badRequest(`"${req.params.type}" is not an import type.`);

    const buffer = await buildTemplateWorkbook(parsed.data);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${templateFileName(parsed.data)}"`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.send(buffer);
  }),
);

/* -------------------------------------------------------------------------- */
/* Upload and wizard                                                           */
/* -------------------------------------------------------------------------- */

router.post(
  '/upload',
  operational,
  rawUpload,
  wrap(async (req, res) => {
    const fileName = String(req.headers['x-file-name'] ?? '').trim();
    if (!fileName) throw badRequest('The upload is missing its file name.');

    const buffer = req.body as Buffer;
    if (!Buffer.isBuffer(buffer)) {
      throw badRequest('The upload did not arrive as a file. Try selecting it again.');
    }

    const result = await createImportJob({
      fileName,
      buffer,
      userId: req.user?.id ?? null,
      username: req.user?.username ?? null,
    });
    res.status(201).json({ data: result });
  }),
);

const suggestSchema = z.object({
  sheet: z.string().min(1),
  type: importTypeSchema,
});

/** Mapping suggestion for a sheet under a chosen import type. */
router.get(
  '/:id/suggest',
  operational,
  validateQuery(suggestSchema),
  wrap(async (req, res) => {
    const q = query<z.infer<typeof suggestSchema>>(req);
    res.json({ data: await suggestForSheet(idParam(req), q.sheet, q.type) });
  }),
);

const optionsSchema = z
  .object({
    updateExisting: z.boolean().optional(),
    skipInvalid: z.boolean().optional(),
    createMissingReferences: z.boolean().optional(),
  })
  .optional();

const previewSchema = z.object({
  sheet: z.string().min(1),
  type: importTypeSchema,
  // Target field -> column name. `null` means "not mapped".
  mapping: z.record(z.string(), z.string().nullable()),
  options: optionsSchema,
});

router.post(
  '/:id/preview',
  operational,
  validateBody(previewSchema),
  wrap(async (req, res) => {
    const body = req.body as z.infer<typeof previewSchema>;
    res.json({
      data: await previewImport({
        jobId: idParam(req),
        sheetName: body.sheet,
        type: body.type,
        mapping: body.mapping as ColumnMapping,
        options: body.options,
      }),
    });
  }),
);

const commitSchema = z.object({
  sheet: z.string().min(1).optional(),
  type: importTypeSchema.optional(),
  mapping: z.record(z.string(), z.string().nullable()).optional(),
  options: optionsSchema,
});

router.post(
  '/:id/commit',
  operational,
  validateBody(commitSchema),
  wrap(async (req, res) => {
    const body = req.body as z.infer<typeof commitSchema>;
    res.json({
      data: await commitImport({
        jobId: idParam(req),
        sheetName: body.sheet,
        type: body.type,
        mapping: body.mapping as ColumnMapping | undefined,
        options: body.options,
        userId: req.user?.id ?? null,
        username: req.user?.username ?? null,
      }),
    });
  }),
);

router.post(
  '/:id/cancel',
  operational,
  wrap((req, res) => res.json({ data: cancelImport(idParam(req)) })),
);

/* -------------------------------------------------------------------------- */
/* History and error report                                                    */
/* -------------------------------------------------------------------------- */

const historySchema = z.object({
  status: z.string().optional(),
  type: z.string().optional(),
  search: z.string().optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(200).optional(),
});

router.get(
  '/',
  anyRole,
  validateQuery(historySchema),
  wrap((req, res) => {
    const q = query<z.infer<typeof historySchema>>(req);
    res.json({ ...listImportJobs(q), stats: importStats() });
  }),
);

router.get(
  '/:id',
  anyRole,
  wrap((req, res) => {
    const job = getJob(idParam(req));
    res.json({
      data: {
        ...publicJob(job),
        analysis: job.analysis_json ? JSON.parse(job.analysis_json) : null,
        mapping: job.mapping_json ? JSON.parse(job.mapping_json) : null,
      },
    });
  }),
);

const errorQuerySchema = z.object({ severity: z.enum(['ALL', 'ERROR', 'WARNING']).optional() });

router.get(
  '/:id/errors',
  anyRole,
  validateQuery(errorQuerySchema),
  wrap((req, res) => {
    const q = query<z.infer<typeof errorQuerySchema>>(req);
    res.json({ data: listImportErrors(idParam(req), q.severity) });
  }),
);

/**
 * The error report as CSV.
 *
 * Downloadable long after the import, which is the point: a pharmacy fixes the
 * 27 rejected rows in their own spreadsheet over the following days.
 */
router.get(
  '/:id/errors/download',
  anyRole,
  wrap((req, res) => {
    const id = idParam(req);
    const job = getJob(id);
    const rows = listImportErrors(id);

    const csv = toCsv(rows, [
      { header: 'Row', value: (r) => r.row_number },
      { header: 'Severity', value: (r) => r.severity },
      { header: 'Column', value: (r) => r.column_name ?? '' },
      { header: 'Field', value: (r) => r.field ?? '' },
      { header: 'Value', value: (r) => r.value ?? '' },
      { header: 'Problem', value: (r) => r.message },
    ]);

    const base = job.file_name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]+/g, '-').toLowerCase();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="import-${id}-${base}-errors.csv"`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Row-Count');
    res.setHeader('X-Row-Count', String(rows.length));
    res.send(csv);
  }),
);

/**
 * Saved mappings. Admin-only: a bad remembered mapping quietly misdirects every
 * future upload of that file, which is worth restricting.
 */
router.get(
  '/mappings/saved',
  adminOnly,
  wrap((_req, res) => {
    const rows = getDb()
      .prepare('SELECT id, import_type, name, use_count, updated_at FROM import_mappings ORDER BY updated_at DESC')
      .all();
    res.json({ data: rows });
  }),
);

router.delete(
  '/mappings/saved/:id',
  adminOnly,
  wrap((req, res) => {
    getDb().prepare('DELETE FROM import_mappings WHERE id = ?').run(idParam(req));
    res.status(204).end();
  }),
);

export default router;
