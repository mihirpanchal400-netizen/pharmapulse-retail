import { Router } from 'express';
import { z } from 'zod';
import { idParam, query, validateBody, validateQuery } from '../middleware/validate';
import { wrap } from '../middleware/error';
import { anyRole, operational, adminOnly } from '../middleware/auth';
import * as distributors from '../services/distributorService';
import * as procurement from '../services/procurementService';
import * as outstanding from '../services/outstandingService';
import { getReplenishmentPlan, getReplenishmentFor } from '../services/replenishmentService';
import { calculateScheme, optimiseOrderQty } from '../services/schemeService';
import { listActivity } from '../services/activityService';

/**
 * Procurement API: distributor network, catalogues, comparison, purchase
 * orders, goods receipt and outstanding.
 *
 * Every distributor figure served here is SYNTHETIC DEMO DATA held in the local
 * database. No route in this file contacts an external platform, and creating a
 * purchase order writes a local row - it does not transmit an order anywhere.
 */

const router = Router();

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');
const paging = {
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(500).optional(),
};

/* -------------------------------------------------------------------------- */
/* Distributors                                                                */
/* -------------------------------------------------------------------------- */

const distributorQuerySchema = z.object({
  search: z.string().optional(),
  city: z.string().optional(),
  pinCode: z.string().optional(),
  area: z.string().optional(),
  type: z.string().optional(),
  status: z.string().optional(),
  maxDistanceKm: z.coerce.number().positive().optional(),
  productId: z.coerce.number().int().positive().optional(),
  sortBy: z.enum(['distance', 'rating', 'name', 'outstanding', 'catalogue']).optional(),
  ...paging,
});

router.get(
  '/distributors',
  anyRole,
  validateQuery(distributorQuerySchema),
  wrap((req, res) => {
    const result = distributors.listDistributors(query(req));
    res.json({
      ...result,
      pharmacyLocation: distributors.getPharmacyLocation(),
      // Surfaced so the UI can label the network honestly on every screen.
      dataSource: 'DEMO',
      disclaimer:
        'Demo distributor network. All distributors, prices, schemes and availability are synthetic data generated locally.',
    });
  }),
);

const distributorBodySchema = z.object({
  name: z.string().min(1, 'Distributor name is required').max(160),
  distributor_code: z.string().max(40).optional(),
  type: z.enum(['DISTRIBUTOR', 'STOCKIST', 'SUPER_STOCKIST', 'MANUFACTURER']).optional(),
  contact_person: z.string().max(120).nullish(),
  phone: z.string().max(30).nullish(),
  email: z.string().max(160).nullish(),
  address: z.string().max(400).nullish(),
  area: z.string().max(120).nullish(),
  city: z.string().max(120).nullish(),
  pin_code: z.string().max(12).nullish(),
  state: z.string().max(120).nullish(),
  gstin: z.string().max(20).nullish(),
  drug_license_no: z.string().max(40).nullish(),
  payment_terms: z.string().max(60).optional(),
  credit_days: z.coerce.number().int().min(0).max(365).optional(),
  credit_limit: z.coerce.number().min(0).optional(),
  delivery_days: z.coerce.number().int().min(0).max(60).optional(),
  min_order_value: z.coerce.number().min(0).optional(),
  distance_km: z.coerce.number().min(0).optional(),
  rating: z.coerce.number().min(0).max(5).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
});

router.get(
  '/distributors/:id',
  anyRole,
  wrap((req, res) => res.json(distributors.getDistributor(idParam(req)))),
);

router.post(
  '/distributors',
  operational,
  validateBody(distributorBodySchema),
  wrap((req, res) => res.status(201).json(distributors.createDistributor(req.body))),
);

router.put(
  '/distributors/:id',
  operational,
  validateBody(distributorBodySchema),
  wrap((req, res) => res.json(distributors.updateDistributor(idParam(req), req.body))),
);

router.delete(
  '/distributors/:id',
  operational,
  wrap((req, res) => {
    const result = distributors.deleteDistributor(idParam(req));
    res.json({
      ...result,
      message: result.deleted
        ? 'Distributor deleted.'
        : 'This distributor has order history, so it was deactivated instead of deleted.',
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Catalogue                                                                   */
/* -------------------------------------------------------------------------- */

const catalogueQuerySchema = z.object({
  search: z.string().optional(),
  category: z.string().optional(),
  inStockOnly: z.coerce.boolean().optional(),
  ...paging,
});

router.get(
  '/distributors/:id/catalogue',
  anyRole,
  validateQuery(catalogueQuerySchema),
  wrap((req, res) => {
    const id = idParam(req);
    res.json({
      distributor: distributors.getDistributor(id),
      ...distributors.getDistributorCatalogue(id, query(req)),
      dataSource: 'DEMO',
    });
  }),
);

const catalogueEntrySchema = z.object({
  distributor_id: z.coerce.number().int().positive(),
  product_id: z.coerce.number().int().positive(),
  ptr: z.coerce.number().min(0),
  pts: z.coerce.number().min(0).optional(),
  mrp: z.coerce.number().min(0).optional(),
  scheme_buy_qty: z.coerce.number().int().min(0).optional(),
  scheme_free_qty: z.coerce.number().int().min(0).optional(),
  discount_pct: z.coerce.number().min(0).max(100).optional(),
  available_qty: z.coerce.number().int().min(0).optional(),
  min_order_qty: z.coerce.number().int().min(1).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
});

router.post(
  '/catalogue',
  operational,
  validateBody(catalogueEntrySchema),
  wrap((req, res) => res.status(201).json(distributors.upsertCatalogueEntry(req.body))),
);

router.delete(
  '/catalogue/:distributorId/:productId',
  operational,
  wrap((req, res) => {
    distributors.removeCatalogueEntry(
      Number(req.params.distributorId),
      Number(req.params.productId),
    );
    res.json({ ok: true, message: 'Catalogue entry removed.' });
  }),
);

/* -------------------------------------------------------------------------- */
/* Supplier comparison                                                         */
/* -------------------------------------------------------------------------- */

const compareSchema = z.object({
  productId: z.coerce.number().int().positive(),
  quantity: z.coerce.number().int().positive().max(100000).optional(),
});

/**
 * Ranks every distributor listing a product by EFFECTIVE COST - what the
 * pharmacy actually pays per unit received once free goods are counted.
 */
router.get(
  '/compare',
  anyRole,
  validateQuery(compareSchema),
  wrap((req, res) => {
    const q = query<z.infer<typeof compareSchema>>(req);
    res.json({
      ...distributors.compareSuppliers(q.productId, q.quantity ?? 100),
      dataSource: 'DEMO',
      methodology:
        'Ranked by effective cost = net payable / total units received (free goods included). ' +
        'Distributors who cannot fulfil the requested quantity are ranked below those who can.',
    });
  }),
);

router.get(
  '/products/:id/suppliers',
  anyRole,
  wrap((req, res) =>
    res.json({ data: distributors.suppliersForProduct(idParam(req)), dataSource: 'DEMO' }),
  ),
);

/** Scheme calculator, exposed so the UI can price a line before committing. */
const schemeSchema = z.object({
  quantity: z.coerce.number().int().positive(),
  rate: z.coerce.number().min(0),
  schemeBuyQty: z.coerce.number().int().min(0).optional(),
  schemeFreeQty: z.coerce.number().int().min(0).optional(),
  discountPct: z.coerce.number().min(0).max(100).optional(),
  gstRate: z.coerce.number().min(0).max(100).optional(),
});

router.get(
  '/scheme-preview',
  anyRole,
  validateQuery(schemeSchema),
  wrap((req, res) => {
    const q = query<z.infer<typeof schemeSchema>>(req);
    res.json({
      ...calculateScheme(q),
      optimisation: optimiseOrderQty(q.quantity, q.schemeBuyQty, q.schemeFreeQty),
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Replenishment                                                               */
/* -------------------------------------------------------------------------- */

const replenishmentQuerySchema = z.object({
  search: z.string().optional(),
  category: z.string().optional(),
  urgency: z.string().optional(),
  includeAll: z.coerce.boolean().optional(),
});

router.get(
  '/replenishment',
  anyRole,
  validateQuery(replenishmentQuerySchema),
  wrap((req, res) => res.json(getReplenishmentPlan(query(req)))),
);

router.get(
  '/replenishment/:id',
  anyRole,
  wrap((req, res) => res.json({ data: getReplenishmentFor(idParam(req)) })),
);

/* -------------------------------------------------------------------------- */
/* Purchase orders                                                             */
/* -------------------------------------------------------------------------- */

const poItemSchema = z.object({
  product_id: z.coerce.number().int().positive(),
  quantity: z.coerce.number().int().positive('Quantity must be at least 1'),
  ptr: z.coerce.number().min(0).optional(),
  scheme_buy_qty: z.coerce.number().int().min(0).optional(),
  scheme_free_qty: z.coerce.number().int().min(0).optional(),
  discount_pct: z.coerce.number().min(0).max(100).optional(),
});

const poSchema = z.object({
  distributor_id: z.coerce.number().int().positive(),
  items: z.array(poItemSchema).min(1, 'Add at least one product to the purchase order'),
  po_date: dateString.optional(),
  expected_delivery: dateString.nullish(),
  payment_terms: z.string().max(60).nullish(),
  notes: z.string().max(400).nullish(),
  status: z.enum(['DRAFT', 'SENT']).optional(),
});

const poQuerySchema = z.object({
  status: z.string().optional(),
  distributorId: z.coerce.number().int().positive().optional(),
  search: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  ...paging,
});

router.get(
  '/purchase-orders',
  anyRole,
  validateQuery(poQuerySchema),
  wrap((req, res) => res.json(procurement.listPurchaseOrders(query(req)))),
);

router.post(
  '/purchase-orders',
  operational,
  validateBody(poSchema),
  wrap((req, res) => {
    const body = req.body as z.infer<typeof poSchema>;
    const po = procurement.createPurchaseOrder({
      ...body,
      user_id: req.user!.id,
      username: req.user!.username,
    });
    res.status(201).json({
      ...po,
      // Stated on the response, not only in the UI, so the boundary is explicit
      // at the API level too.
      simulated: true,
      notice:
        'Simulated purchase order. This order exists only in the local database and has not been transmitted to any distributor or external platform.',
    });
  }),
);

router.get(
  '/purchase-orders/:id',
  anyRole,
  wrap((req, res) => res.json(procurement.getPurchaseOrder(idParam(req)))),
);

const poStatusSchema = z.object({
  status: z.enum(['DRAFT', 'SENT', 'CONFIRMED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED']),
});

router.patch(
  '/purchase-orders/:id/status',
  operational,
  validateBody(poStatusSchema),
  wrap((req, res) => {
    const { status } = req.body as z.infer<typeof poStatusSchema>;
    res.json(
      procurement.updatePoStatus(idParam(req), status, {
        user_id: req.user!.id,
        username: req.user!.username,
      }),
    );
  }),
);

const receiptSchema = z.object({
  items: z
    .array(
      z.object({
        po_item_id: z.coerce.number().int().positive(),
        received_qty: z.coerce.number().int().positive(),
        free_qty: z.coerce.number().int().min(0).optional(),
        batch_number: z.string().min(1, 'Batch number is required').max(60),
        expiry_date: dateString,
        manufacturing_date: dateString.nullish(),
        ptr: z.coerce.number().min(0).optional(),
        mrp: z.coerce.number().min(0).optional(),
      }),
    )
    .min(1, 'Add at least one line to the goods receipt'),
  receipt_date: dateString.optional(),
  invoice_number: z.string().max(60).nullish(),
  notes: z.string().max(400).nullish(),
});

/** Goods receipt: creates batches, moves stock and raises the supplier invoice. */
router.post(
  '/purchase-orders/:id/receive',
  operational,
  validateBody(receiptSchema),
  wrap((req, res) => {
    const body = req.body as z.infer<typeof receiptSchema>;
    res.status(201).json(
      procurement.receivePurchaseOrder({
        ...body,
        po_id: idParam(req),
        user_id: req.user!.id,
        username: req.user!.username,
      }),
    );
  }),
);

router.get(
  '/summary',
  anyRole,
  wrap((_req, res) => res.json(procurement.getProcurementSummary())),
);

/* -------------------------------------------------------------------------- */
/* Outstanding                                                                 */
/* -------------------------------------------------------------------------- */

const supplierInvoiceQuerySchema = z.object({
  status: z.string().optional(),
  distributorId: z.coerce.number().int().positive().optional(),
  overdueOnly: z.coerce.boolean().optional(),
  search: z.string().optional(),
  ...paging,
});

router.get(
  '/supplier-invoices',
  anyRole,
  validateQuery(supplierInvoiceQuerySchema),
  wrap((req, res) => res.json(outstanding.listSupplierInvoices(query(req)))),
);

const supplierPaymentSchema = z.object({
  distributor_id: z.coerce.number().int().positive(),
  invoice_id: z.coerce.number().int().positive().nullish(),
  amount: z.coerce.number().positive('Payment amount must be greater than zero'),
  method: z.enum(['CASH', 'UPI', 'CARD', 'BANK', 'CHEQUE', 'OTHER']).optional(),
  payment_date: dateString.optional(),
  reference: z.string().max(80).nullish(),
  notes: z.string().max(400).nullish(),
});

router.post(
  '/supplier-payments',
  operational,
  validateBody(supplierPaymentSchema),
  wrap((req, res) => {
    const body = req.body as z.infer<typeof supplierPaymentSchema>;
    res.status(201).json(
      outstanding.recordSupplierPayment({
        ...body,
        user_id: req.user!.id,
        username: req.user!.username,
      }),
    );
  }),
);

router.get(
  '/supplier-payments',
  anyRole,
  validateQuery(z.object({ distributorId: z.coerce.number().int().positive().optional(), ...paging })),
  wrap((req, res) => res.json(outstanding.listSupplierPayments(query(req)))),
);

const customerDueQuerySchema = z.object({
  customerId: z.coerce.number().int().positive().optional(),
  overdueOnly: z.coerce.boolean().optional(),
  search: z.string().optional(),
  ...paging,
});

router.get(
  '/customer-dues',
  anyRole,
  validateQuery(customerDueQuerySchema),
  wrap((req, res) => res.json(outstanding.listCustomerDues(query(req)))),
);

const customerPaymentSchema = z.object({
  customer_id: z.coerce.number().int().positive(),
  sale_id: z.coerce.number().int().positive().nullish(),
  amount: z.coerce.number().positive('Payment amount must be greater than zero'),
  method: z.enum(['CASH', 'UPI', 'CARD', 'BANK', 'CHEQUE', 'OTHER']).optional(),
  payment_date: dateString.optional(),
  reference: z.string().max(80).nullish(),
  notes: z.string().max(400).nullish(),
});

router.post(
  '/customer-payments',
  anyRole, // a counter cashier can take a payment against an outstanding bill
  validateBody(customerPaymentSchema),
  wrap((req, res) => {
    const body = req.body as z.infer<typeof customerPaymentSchema>;
    res.status(201).json(
      outstanding.recordCustomerPayment({
        ...body,
        user_id: req.user!.id,
        username: req.user!.username,
      }),
    );
  }),
);

/* -------------------------------------------------------------------------- */
/* Audit trail                                                                 */
/* -------------------------------------------------------------------------- */

const activityQuerySchema = z.object({
  module: z.string().optional(),
  userId: z.coerce.number().int().positive().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  search: z.string().optional(),
  ...paging,
});

router.get(
  '/activity',
  adminOnly,
  validateQuery(activityQuerySchema),
  wrap((req, res) => res.json(listActivity(query(req)))),
);

export default router;
