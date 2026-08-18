import { Router } from 'express';
import { z } from 'zod';
import { idParam, query, validateBody, validateQuery } from '../middleware/validate';
import { wrap } from '../middleware/error';
import { anyRole, operational } from '../middleware/auth';
import * as products from '../services/productService';
import * as suppliers from '../services/supplierService';
import * as customers from '../services/customerService';

/**
 * Master data: products, suppliers and customers.
 *
 * Read access is open to every signed-in role. Anything that WRITES requires
 * Admin or Pharmacist - a Staff user can bill a sale but cannot change the
 * catalogue or the prices behind it.
 */

const router = Router();

// ------------------------------------------------------------------ shared
const pageSchema = {
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(500).optional(),
};

// ---------------------------------------------------------------- products
const productBodySchema = z.object({
  product_code: z.string().min(1, 'Product code is required').max(40),
  product_name: z.string().min(1, 'Product name is required').max(160),
  generic_name: z.string().max(160).nullish(),
  brand_name: z.string().max(160).nullish(),
  category: z.string().min(1, 'Category is required').max(80),
  dosage_form: z.string().max(60).nullish(),
  strength: z.string().max(60).nullish(),
  pack_size: z.string().max(60).nullish(),
  manufacturer: z.string().max(160).nullish(),
  batch_tracking_enabled: z.boolean().optional(),
  prescription_flag: z.boolean().optional(),
  purchase_price: z.coerce.number().min(0, 'Purchase price cannot be negative'),
  selling_price: z.coerce.number().min(0, 'Selling price cannot be negative'),
  tax_rate: z.coerce.number().min(0).max(100),
  reorder_level: z.coerce.number().int().min(0),
  minimum_stock: z.coerce.number().int().min(0),
  maximum_stock: z.coerce.number().int().min(0),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
});

router.get(
  '/products/categories',
  anyRole,
  wrap((_req, res) => res.json({ data: products.listCategories() })),
);

router.get(
  '/products/manufacturers',
  anyRole,
  wrap((_req, res) => res.json({ data: products.listManufacturers() })),
);

/** Type-ahead used by the POS and purchase screens. */
const searchSchema = z.object({
  q: z.string().default(''),
  limit: z.coerce.number().int().positive().max(50).optional(),
});

router.get(
  '/products/search',
  anyRole,
  validateQuery(searchSchema),
  wrap((req, res) => {
    const q = query<z.infer<typeof searchSchema>>(req);
    res.json({ data: products.searchProducts(q.q, q.limit) });
  }),
);

router.get(
  '/products/:id',
  anyRole,
  wrap((req, res) => res.json(products.getProductDetail(idParam(req)))),
);

router.post(
  '/products',
  operational,
  validateBody(productBodySchema),
  wrap((req, res) => res.status(201).json(products.createProduct(req.body))),
);

router.put(
  '/products/:id',
  operational,
  validateBody(productBodySchema),
  wrap((req, res) => res.json(products.updateProduct(idParam(req), req.body))),
);

router.delete(
  '/products/:id',
  operational,
  wrap((req, res) => {
    const result = products.deleteProduct(idParam(req));
    res.json({
      ...result,
      // Deleting a product with history would orphan sales, so the service
      // deactivates it instead. Say so plainly rather than silently differing.
      message: result.deleted
        ? 'Product deleted.'
        : 'This product has transaction history, so it was deactivated instead of deleted. It will no longer appear in new sales.',
    });
  }),
);

// --------------------------------------------------------------- suppliers
const supplierBodySchema = z.object({
  supplier_name: z.string().min(1, 'Supplier name is required').max(160),
  contact_person: z.string().max(120).nullish(),
  phone: z.string().max(30).nullish(),
  email: z.string().email('Enter a valid email address').max(160).nullish().or(z.literal('')),
  address: z.string().max(400).nullish(),
  payment_terms: z.string().max(80).nullish(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
});

const supplierQuerySchema = z.object({
  search: z.string().optional(),
  status: z.string().optional(),
  ...pageSchema,
});

router.get(
  '/suppliers',
  anyRole,
  validateQuery(supplierQuerySchema),
  wrap((req, res) => res.json(suppliers.listSuppliers(query(req)))),
);

router.get(
  '/suppliers/:id',
  anyRole,
  wrap((req, res) => res.json(suppliers.getSupplier(idParam(req)))),
);

router.post(
  '/suppliers',
  operational,
  validateBody(supplierBodySchema),
  wrap((req, res) => res.status(201).json(suppliers.createSupplier(req.body))),
);

router.put(
  '/suppliers/:id',
  operational,
  validateBody(supplierBodySchema),
  wrap((req, res) => res.json(suppliers.updateSupplier(idParam(req), req.body))),
);

router.delete(
  '/suppliers/:id',
  operational,
  wrap((req, res) => {
    const result = suppliers.deleteSupplier(idParam(req));
    res.json({
      ...result,
      message: result.deleted
        ? 'Supplier deleted.'
        : 'This supplier has purchase history, so it was deactivated instead of deleted.',
    });
  }),
);

// --------------------------------------------------------------- customers
const customerBodySchema = z.object({
  name: z.string().min(1, 'Customer name is required').max(120),
  phone: z.string().max(30).nullish(),
  customer_type: z.enum(['WALK_IN', 'REGULAR', 'INSTITUTIONAL']).optional(),
  customer_code: z.string().max(40).optional(),
});

const customerQuerySchema = z.object({
  search: z.string().optional(),
  type: z.string().optional(),
  ...pageSchema,
});

router.get(
  '/customers',
  anyRole,
  validateQuery(customerQuerySchema),
  wrap((req, res) => res.json(customers.listCustomers(query(req)))),
);

router.get(
  '/customers/:id',
  anyRole,
  wrap((req, res) => res.json(customers.getCustomerHistory(idParam(req)))),
);

router.post(
  '/customers',
  anyRole, // a cashier must be able to register a walk-in at the counter
  validateBody(customerBodySchema),
  wrap((req, res) => res.status(201).json(customers.createCustomer(req.body))),
);

router.put(
  '/customers/:id',
  operational,
  validateBody(customerBodySchema),
  wrap((req, res) => res.json(customers.updateCustomer(idParam(req), req.body))),
);

router.delete(
  '/customers/:id',
  operational,
  wrap((req, res) => {
    customers.deleteCustomer(idParam(req));
    res.json({ ok: true, message: 'Customer deleted.' });
  }),
);

export default router;
