import { Router } from 'express';
import { z } from 'zod';
import { idParam, query, validateBody, validateQuery } from '../middleware/validate';
import { wrap } from '../middleware/error';
import { anyRole, operational } from '../middleware/auth';
import * as inventory from '../services/inventoryService';
import * as batches from '../services/batchService';
import { getReorderList } from '../analytics/inventoryAnalyzer';

const router = Router();

const stockQuerySchema = z.object({
  search: z.string().optional(),
  category: z.string().optional(),
  status: z.string().optional(),
  supplierId: z.coerce.number().int().positive().optional(),
  prescriptionOnly: z.coerce.boolean().optional(),
  productStatus: z.enum(['ACTIVE', 'INACTIVE', 'ALL']).optional(),
  sortBy: z.string().optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(500).optional(),
});

/** The Current Stock screen: every product with live stock and classification. */
router.get(
  '/stock',
  anyRole,
  validateQuery(stockQuerySchema),
  wrap((req, res) => {
    const q = query<z.infer<typeof stockQuerySchema>>(req);
    res.json(inventory.queryInventory(q as Parameters<typeof inventory.queryInventory>[0]));
  }),
);

/** Products at or below reorder level, with suggested order quantities. */
router.get(
  '/low-stock',
  anyRole,
  wrap((_req, res) => res.json({ data: getReorderList() })),
);

/** Sellable stock for one product - used by the POS before adding to the cart. */
router.get(
  '/stock/:id',
  anyRole,
  wrap((req, res) => {
    const id = idParam(req);
    res.json({
      productId: id,
      currentStock: inventory.getProductStock(id),
      // Ordered earliest-expiry-first: this is exactly what FEFO will consume.
      batches: inventory.getFefoBatches(id),
    });
  }),
);

// ----------------------------------------------------------------- batches
const batchQuerySchema = z.object({
  search: z.string().optional(),
  productId: z.coerce.number().int().positive().optional(),
  supplierId: z.coerce.number().int().positive().optional(),
  bucket: z.enum(['EXPIRED', 'DAYS_30', 'DAYS_60', 'DAYS_90', 'SAFE', 'ALL']).optional(),
  inStockOnly: z.coerce.boolean().optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(500).optional(),
});

router.get(
  '/batches',
  anyRole,
  validateQuery(batchQuerySchema),
  wrap((req, res) => res.json(batches.queryBatches(query(req)))),
);

const expirySchema = z.object({ days: z.coerce.number().int().positive().max(3650).optional() });

router.get(
  '/expiry',
  anyRole,
  validateQuery(expirySchema),
  wrap((req, res) => {
    const q = query<z.infer<typeof expirySchema>>(req);
    const expiring = batches.getExpiringBatches(q.days);
    const expired = batches.getExpiredBatches();
    res.json({
      expired,
      expiring,
      buckets: {
        EXPIRED: expired.length,
        DAYS_30: expiring.filter((b) => b.expiry_bucket === 'DAYS_30').length,
        DAYS_60: expiring.filter((b) => b.expiry_bucket === 'DAYS_60').length,
        DAYS_90: expiring.filter((b) => b.expiry_bucket === 'DAYS_90').length,
      },
      valueAtRisk: {
        expired: expired.reduce((s, b) => s + b.stock_value, 0),
        expiring: expiring.reduce((s, b) => s + b.stock_value, 0),
      },
    });
  }),
);

const batchBodySchema = z.object({
  product_id: z.coerce.number().int().positive(),
  batch_number: z.string().min(1, 'Batch number is required').max(60),
  expiry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expiry date must be YYYY-MM-DD'),
  manufacturing_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Manufacturing date must be YYYY-MM-DD')
    .nullish(),
  quantity: z.coerce.number().int().min(0),
  purchase_price: z.coerce.number().min(0),
  selling_price: z.coerce.number().min(0),
  supplier_id: z.coerce.number().int().positive().nullish(),
});

router.post(
  '/batches',
  operational,
  validateBody(batchBodySchema),
  wrap((req, res) => res.status(201).json(batches.createBatch(req.body))),
);

const batchUpdateSchema = z.object({
  expiry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  manufacturing_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  selling_price: z.coerce.number().min(0).optional(),
  purchase_price: z.coerce.number().min(0).optional(),
  status: z.enum(['ACTIVE', 'QUARANTINED', 'WRITTEN_OFF']).optional(),
});

router.patch(
  '/batches/:id',
  operational,
  validateBody(batchUpdateSchema),
  wrap((req, res) => res.json(batches.updateBatch(idParam(req), req.body))),
);

/**
 * Writes every expired batch down to zero in one operation, recording an
 * EXPIRED inventory transaction for each so the loss stays auditable.
 */
router.post(
  '/write-off-expired',
  operational,
  wrap((_req, res) => {
    const result = batches.writeOffExpired();
    res.json({
      ...result,
      message:
        result.batches === 0
          ? 'No expired stock to write off.'
          : `Wrote off ${result.units} units across ${result.batches} batches.`,
    });
  }),
);

// ------------------------------------------------------------- adjustments
const adjustSchema = z.object({
  batchId: z.coerce.number().int().positive(),
  /** Signed: negative removes stock, positive adds it back. */
  quantity: z.coerce.number().int().refine((n) => n !== 0, 'Adjustment quantity cannot be zero'),
  type: z.enum(['ADJUSTMENT', 'DAMAGED', 'EXPIRED']),
  notes: z.string().max(400).optional(),
});

router.post(
  '/adjust',
  operational,
  validateBody(adjustSchema),
  wrap((req, res) => res.json(inventory.adjustStock(req.body))),
);

// ------------------------------------------------------- transaction ledger
const txQuerySchema = z.object({
  productId: z.coerce.number().int().positive().optional(),
  type: z.enum(['STOCK_RECEIVED', 'SALE', 'RETURN', 'ADJUSTMENT', 'DAMAGED', 'EXPIRED']).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(500).optional(),
});

router.get(
  '/transactions',
  anyRole,
  validateQuery(txQuerySchema),
  wrap((req, res) => res.json(inventory.getTransactions(query(req)))),
);

export default router;
