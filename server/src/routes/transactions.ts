import { Router } from 'express';
import { z } from 'zod';
import { idParam, query, validateBody, validateQuery } from '../middleware/validate';
import { wrap } from '../middleware/error';
import { anyRole, operational } from '../middleware/auth';
import * as sales from '../services/saleService';
import * as purchases from '../services/purchaseService';

/**
 * Transactional endpoints: sales, returns and purchases.
 *
 * The signed-in user id is taken from `req.user`, never from the request body -
 * otherwise a client could attribute a sale to somebody else.
 */

const router = Router();

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

// ------------------------------------------------------------------- sales
const saleItemSchema = z.object({
  product_id: z.coerce.number().int().positive(),
  quantity: z.coerce.number().int().positive('Quantity must be at least 1'),
  batch_id: z.coerce.number().int().positive().nullish(),
  discount: z.coerce.number().min(0).optional(),
  selling_price: z.coerce.number().min(0).optional(),
});

const saleSchema = z.object({
  items: z.array(saleItemSchema).min(1, 'Add at least one product to the sale'),
  customer_id: z.coerce.number().int().positive().nullish(),
  payment_method: z.enum(['CASH', 'UPI', 'CARD', 'OTHER']).optional(),
  bill_discount: z.coerce.number().min(0).optional(),
  notes: z.string().max(400).nullish(),
  sale_date: z.string().optional(),
});

const saleQuerySchema = z.object({
  search: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  paymentMethod: z.string().optional(),
  status: z.string().optional(),
  customerId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(500).optional(),
});

router.get(
  '/sales',
  anyRole,
  validateQuery(saleQuerySchema),
  wrap((req, res) => res.json(sales.listSales(query(req) as sales.SaleQuery))),
);

router.post(
  '/sales',
  anyRole, // billing is the one write every role can perform
  validateBody(saleSchema),
  wrap((req, res) => {
    const body = req.body as z.infer<typeof saleSchema>;
    res.status(201).json(sales.createSale({ ...body, user_id: req.user!.id } as sales.SaleInput));
  }),
);

/** Full invoice: sale, items, customer, cashier, pharmacy header and returns. */
router.get(
  '/sales/:id/invoice',
  anyRole,
  wrap((req, res) => res.json(sales.getInvoice(idParam(req)))),
);

router.get(
  '/sales/:id',
  anyRole,
  wrap((req, res) => res.json(sales.getSale(idParam(req)))),
);

/** Entry point of the returns flow: find a sale by the number on the printed bill. */
router.get(
  '/sales/by-invoice/:invoiceNumber',
  anyRole,
  wrap((req, res) => res.json(sales.findByInvoice(req.params.invoiceNumber))),
);

// ----------------------------------------------------------------- returns
const returnSchema = z.object({
  sale_id: z.coerce.number().int().positive(),
  reason: z.enum(['CUSTOMER_RETURN', 'DAMAGED', 'WRONG_ITEM', 'OTHER']),
  items: z
    .array(
      z.object({
        sale_item_id: z.coerce.number().int().positive(),
        quantity: z.coerce.number().int().positive(),
      }),
    )
    .min(1, 'Select at least one item to return'),
  restock: z.boolean().optional(),
  notes: z.string().max(400).nullish(),
});

const returnQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(500).optional(),
});

router.get(
  '/returns',
  anyRole,
  validateQuery(returnQuerySchema),
  wrap((req, res) => res.json(sales.listReturns(query(req)))),
);

router.post(
  '/returns',
  operational, // a return moves money and stock - not a Staff-level action
  validateBody(returnSchema),
  wrap((req, res) => {
    const body = req.body as z.infer<typeof returnSchema>;
    res.status(201).json(sales.createReturn({ ...body, user_id: req.user!.id } as sales.ReturnInput));
  }),
);

// --------------------------------------------------------------- purchases
const purchaseItemSchema = z.object({
  product_id: z.coerce.number().int().positive(),
  batch_number: z.string().min(1, 'Batch number is required').max(60),
  quantity: z.coerce.number().int().positive('Quantity must be at least 1'),
  purchase_price: z.coerce.number().min(0),
  selling_price: z.coerce.number().min(0).optional(),
  expiry_date: dateString,
  manufacturing_date: dateString.nullish(),
  tax_rate: z.coerce.number().min(0).max(100).optional(),
  update_product_price: z.boolean().optional(),
});

const purchaseSchema = z.object({
  supplier_id: z.coerce.number().int().positive(),
  items: z.array(purchaseItemSchema).min(1, 'Add at least one product to the purchase'),
  purchase_date: z.string().optional(),
  payment_status: z.enum(['PAID', 'PARTIAL', 'UNPAID']).optional(),
  notes: z.string().max(400).nullish(),
});

const purchaseQuerySchema = z.object({
  search: z.string().optional(),
  supplierId: z.coerce.number().int().positive().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  paymentStatus: z.string().optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(500).optional(),
});

router.get(
  '/purchases',
  anyRole,
  validateQuery(purchaseQuerySchema),
  wrap((req, res) => res.json(purchases.listPurchases(query(req)))),
);

router.post(
  '/purchases',
  operational,
  validateBody(purchaseSchema),
  wrap((req, res) => {
    const body = req.body as z.infer<typeof purchaseSchema>;
    res
      .status(201)
      .json(purchases.createPurchase({ ...body, user_id: req.user!.id } as purchases.PurchaseInput));
  }),
);

router.get(
  '/purchases/:id',
  anyRole,
  wrap((req, res) => res.json(purchases.getPurchase(idParam(req)))),
);

const paymentSchema = z.object({ payment_status: z.enum(['PAID', 'PARTIAL', 'UNPAID']) });

router.patch(
  '/purchases/:id/payment',
  operational,
  validateBody(paymentSchema),
  wrap((req, res) => {
    const { payment_status } = req.body as z.infer<typeof paymentSchema>;
    res.json(purchases.updatePaymentStatus(idParam(req), payment_status));
  }),
);

export default router;
