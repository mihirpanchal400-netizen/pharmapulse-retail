import type { ImportType, ImportTypeDef, TargetField } from './types';

/**
 * Import Center - the target field catalogue.
 *
 * This file is the importer's domain knowledge. The synonym lists come from the
 * header names that actually turn up in Indian retail pharmacy exports: tally
 * dumps, distributor price lists, stock statements printed from legacy billing
 * software, and hand-maintained spreadsheets.
 *
 * Two rules kept the lists honest:
 *   1. Only add a synonym that has a single unambiguous meaning. "Rate" appears
 *      under purchase price, never under MRP, because a column called "Rate" in
 *      a purchase document is what the pharmacy paid.
 *   2. Synonyms are matched on a normalised form (see detect.ts), so there is no
 *      need to list "Exp Date", "EXP_DATE" and "exp.date" separately.
 */

/* -------------------------------------------------------------------------- */
/* Reusable field definitions                                                  */
/* -------------------------------------------------------------------------- */

const productName: TargetField = {
  key: 'product_name',
  label: 'Product Name',
  type: 'string',
  synonyms: [
    'product', 'product name', 'productname', 'medicine', 'medicine name', 'item',
    'item name', 'itemname', 'drug', 'drug name', 'description', 'item description',
    'particulars', 'name',
  ],
  example: 'Pantoprazole 40mg Tablet',
};

const productCode: TargetField = {
  key: 'product_code',
  label: 'Product Code',
  type: 'string',
  synonyms: [
    'code', 'product code', 'item code', 'sku', 'product id', 'item id', 'itemcode',
    'article code', 'ref', 'reference', 'product no', 'item no',
  ],
  example: 'PP-0001',
  note: 'Left blank, a code is generated from the product name.',
};

const brandName: TargetField = {
  key: 'brand_name',
  label: 'Brand Name',
  type: 'string',
  synonyms: ['brand', 'brand name', 'brandname', 'trade name', 'tradename'],
  example: 'Pantocid',
};

const genericName: TargetField = {
  key: 'generic_name',
  label: 'Generic Name',
  type: 'string',
  synonyms: [
    'generic', 'generic name', 'genericname', 'salt', 'salt name', 'molecule',
    'active ingredient', 'ingredient',
  ],
  example: 'Pantoprazole',
};

const composition: TargetField = {
  key: 'composition',
  label: 'Composition',
  type: 'string',
  synonyms: ['composition', 'formulation', 'contents', 'combination', 'salt composition'],
  example: 'Pantoprazole Sodium 40mg',
};

const manufacturerName: TargetField = {
  key: 'manufacturer',
  label: 'Manufacturer',
  type: 'string',
  synonyms: [
    'manufacturer', 'manufacturer name', 'company', 'company name', 'mfg', 'mfr',
    'mfg company', 'marketed by', 'maker', 'pharma company',
  ],
  example: 'Sun Pharmaceutical',
};

const category: TargetField = {
  key: 'category',
  label: 'Therapeutic Category',
  type: 'string',
  synonyms: [
    'category', 'therapeutic category', 'segment', 'group', 'product group',
    'therapy', 'therapeutic area', 'class', 'drug category', 'type',
  ],
  example: 'Gastro',
  note: 'Defaults to General when blank.',
};

const dosageForm: TargetField = {
  key: 'dosage_form',
  label: 'Dosage Form',
  type: 'string',
  synonyms: ['dosage form', 'form', 'dosageform', 'presentation', 'dosage'],
  example: 'Tablet',
};

const strength: TargetField = {
  key: 'strength',
  label: 'Strength',
  type: 'string',
  synonyms: ['strength', 'potency', 'dose', 'mg', 'power'],
  example: '40mg',
};

const packSize: TargetField = {
  key: 'pack_size',
  label: 'Pack Size',
  type: 'string',
  synonyms: ['pack', 'pack size', 'packing', 'packsize', 'packaging', 'conversion'],
  example: '10 Tablets',
};

const batchNumber: TargetField = {
  key: 'batch_number',
  label: 'Batch Number',
  type: 'string',
  synonyms: ['batch', 'batch no', 'batch number', 'batchno', 'lot', 'lot no', 'lot number', 'b no'],
  example: 'PT24A017',
};

const expiryDate: TargetField = {
  key: 'expiry_date',
  label: 'Expiry Date',
  type: 'date',
  synonyms: [
    'expiry', 'expiry date', 'exp', 'exp date', 'expdate', 'expiring on',
    'date of expiry', 'expires', 'expiry dt', 'best before',
  ],
  example: '2027-06-30',
  note: 'Accepts DD/MM/YYYY, MM/YYYY, MM-YY and Excel date cells. A month-only value means the last day of that month.',
};

const manufacturingDate: TargetField = {
  key: 'manufacturing_date',
  label: 'Manufacturing Date',
  type: 'date',
  synonyms: ['mfg date', 'manufacturing date', 'mfgdate', 'mfd', 'date of manufacture', 'mfg dt'],
  example: '2025-06-01',
};

const quantity: TargetField = {
  key: 'quantity',
  label: 'Quantity',
  type: 'integer',
  min: 0,
  synonyms: [
    'qty', 'quantity', 'stock', 'closing stock', 'closing qty', 'balance',
    'balance qty', 'available qty', 'available', 'current stock', 'opening stock',
    'stock qty', 'on hand', 'stock in hand', 'units',
  ],
  example: 120,
};

const freeQty: TargetField = {
  key: 'free_qty',
  label: 'Free Quantity',
  type: 'integer',
  min: 0,
  synonyms: ['free', 'free qty', 'free quantity', 'scheme qty', 'bonus', 'bonus qty'],
  example: 1,
};

const mrp: TargetField = {
  key: 'mrp',
  label: 'MRP',
  type: 'number',
  min: 0,
  synonyms: ['mrp', 'maximum retail price', 'retail price', 'max retail price', 'm r p', 'mrp rs'],
  example: 154.5,
};

const ptr: TargetField = {
  key: 'ptr',
  label: 'PTR / Purchase Price',
  type: 'number',
  min: 0,
  synonyms: [
    'ptr', 'purchase price', 'purchase rate', 'cost', 'cost price', 'rate',
    'buying price', 'net rate', 'trade rate', 'price to retailer', 'landing cost',
    'purchase value', 'pur rate',
  ],
  example: 108.15,
};

const pts: TargetField = {
  key: 'pts',
  label: 'PTS',
  type: 'number',
  min: 0,
  synonyms: ['pts', 'price to stockist', 'stockist rate', 'stockist price'],
  example: 99.5,
};

const sellingPrice: TargetField = {
  key: 'selling_price',
  label: 'Selling Price',
  type: 'number',
  min: 0,
  synonyms: ['selling price', 'sale price', 'sales rate', 'sp', 'selling rate', 'counter price'],
  example: 154.5,
  note: 'Defaults to MRP when blank.',
};

const taxRate: TargetField = {
  key: 'tax_rate',
  label: 'GST %',
  type: 'number',
  min: 0,
  max: 100,
  synonyms: ['gst', 'gst %', 'gst rate', 'tax', 'tax rate', 'tax %', 'vat', 'igst', 'gst percent'],
  example: 12,
  note: 'Indian pharma GST is normally 5% or 12%. Defaults to 12 when blank.',
};

const hsnCode: TargetField = {
  key: 'hsn_code',
  label: 'HSN Code',
  type: 'string',
  synonyms: ['hsn', 'hsn code', 'hsncode', 'hsn no', 'sac'],
  example: '3004',
};

const barcode: TargetField = {
  key: 'barcode',
  label: 'Barcode',
  type: 'string',
  synonyms: ['barcode', 'bar code', 'ean', 'ean code', 'upc', 'scan code'],
  example: '8901234567890',
};

const supplierName: TargetField = {
  key: 'supplier_name',
  label: 'Supplier',
  type: 'string',
  synonyms: [
    'supplier', 'supplier name', 'vendor', 'vendor name', 'party', 'party name',
    'stockist', 'distributor', 'distributor name', 'firm', 'firm name', 'seller',
  ],
  example: 'Sai Pharma Distributors',
};

const phone: TargetField = {
  key: 'phone',
  label: 'Phone',
  type: 'string',
  synonyms: ['phone', 'mobile', 'contact', 'contact no', 'phone no', 'mobile no', 'telephone', 'cell'],
  example: '+91 98200 11223',
};

const email: TargetField = {
  key: 'email',
  label: 'Email',
  type: 'string',
  synonyms: ['email', 'e mail', 'email id', 'mail', 'email address'],
  example: 'orders@saipharma.example',
};

const address: TargetField = {
  key: 'address',
  label: 'Address',
  type: 'string',
  synonyms: ['address', 'addr', 'street', 'location', 'full address', 'address line'],
  example: '12 Station Road',
};

const contactPerson: TargetField = {
  key: 'contact_person',
  label: 'Contact Person',
  type: 'string',
  synonyms: ['contact person', 'contact name', 'person', 'owner', 'representative', 'rep', 'sales rep'],
  example: 'Mahesh Rao',
};

const gstin: TargetField = {
  key: 'gstin',
  label: 'GSTIN',
  type: 'string',
  synonyms: ['gstin', 'gst no', 'gst number', 'gstin no', 'tax id', 'gst registration'],
  example: '27ABCDE1234F1Z5',
  note: 'Stored as entered. The software does not verify registrations.',
};

const statusField: TargetField = {
  key: 'status',
  label: 'Status',
  type: 'enum',
  values: ['ACTIVE', 'INACTIVE'],
  synonyms: ['status', 'active', 'state', 'is active'],
  example: 'ACTIVE',
};

const paymentTerms: TargetField = {
  key: 'payment_terms',
  label: 'Payment Terms',
  type: 'string',
  synonyms: ['payment terms', 'terms', 'credit terms', 'payment', 'payment term'],
  example: 'Net 30',
};

/* -------------------------------------------------------------------------- */
/* Import type definitions                                                     */
/* -------------------------------------------------------------------------- */

export const IMPORT_DEFS: Record<ImportType, ImportTypeDef> = {
  /* ---------------------------------------------------------- product master */
  PRODUCT_MASTER: {
    type: 'PRODUCT_MASTER',
    label: 'Product Master',
    description:
      'The medicines the pharmacy sells: names, packs, GST, MRP and purchase price. Start here - every other import refers to products by name or code.',
    affects: 'products (and manufacturers, created on demand)',
    identity: ['product_code', 'product_name'],
    requireAnyOf: [{ label: 'Product name or product code', keys: ['product_name', 'product_code'] }],
    nameHints: ['product', 'item', 'medicine', 'master', 'catalogue', 'catalog', 'drug'],
    fields: [
      { ...productName, required: false },
      productCode,
      brandName,
      genericName,
      composition,
      manufacturerName,
      category,
      dosageForm,
      strength,
      packSize,
      { key: 'unit', label: 'Unit', type: 'string', synonyms: ['unit', 'uom', 'unit of measure', 'base unit'], example: 'Strip' },
      { key: 'units_per_pack', label: 'Units per Pack', type: 'integer', min: 1, synonyms: ['units per pack', 'unitsperpack', 'pack qty', 'no of units', 'conversion factor'], example: 10 },
      barcode,
      hsnCode,
      taxRate,
      mrp,
      ptr,
      pts,
      sellingPrice,
      { key: 'reorder_level', label: 'Reorder Level', type: 'integer', min: 0, synonyms: ['reorder level', 'reorder', 'reorder qty', 'min level', 'reorder point', 'rol'], example: 30 },
      { key: 'minimum_stock', label: 'Minimum Stock', type: 'integer', min: 0, synonyms: ['minimum stock', 'min stock', 'safety stock', 'minimum qty'], example: 15 },
      { key: 'maximum_stock', label: 'Maximum Stock', type: 'integer', min: 0, synonyms: ['maximum stock', 'max stock', 'max qty', 'maximum qty'], example: 200 },
      { key: 'lead_time_days', label: 'Lead Time (days)', type: 'integer', min: 0, synonyms: ['lead time', 'lead time days', 'delivery days', 'supply days'], example: 2 },
      {
        key: 'schedule_category',
        label: 'Schedule',
        type: 'string',
        synonyms: ['schedule', 'drug schedule', 'schedule category', 'sch'],
        example: 'H',
        note: 'Free text, e.g. H, H1, X, OTC. Defaults to OTC.',
      },
      {
        key: 'prescription_flag',
        label: 'Prescription Required',
        type: 'boolean',
        synonyms: ['prescription', 'rx', 'prescription required', 'is prescription', 'rx required', 'prescription flag'],
        example: 'Yes',
        note: 'Yes/No, Y/N, True/False or 1/0. Inferred from the schedule when blank.',
      },
      { key: 'storage_condition', label: 'Storage', type: 'string', synonyms: ['storage', 'storage condition', 'store', 'storage instructions'], example: 'Below 25C' },
      statusField,
    ],
  },

  /* ----------------------------------------------------- manufacturer master */
  MANUFACTURER_MASTER: {
    type: 'MANUFACTURER_MASTER',
    label: 'Manufacturer Master',
    description: 'Pharmaceutical companies whose products the pharmacy stocks.',
    affects: 'manufacturers',
    identity: ['name'],
    requireAnyOf: [{ label: 'Manufacturer name', keys: ['name'] }],
    nameHints: ['manufacturer', 'company', 'mfg', 'pharma company', 'brand'],
    fields: [
      { key: 'name', label: 'Manufacturer Name', type: 'string', required: true, synonyms: manufacturerName.synonyms.concat(['name']), example: 'Sun Pharmaceutical' },
      { key: 'code', label: 'Code', type: 'string', synonyms: ['code', 'manufacturer code', 'company code', 'short code'], example: 'SUN' },
      contactPerson,
      phone,
      email,
      address,
      statusField,
    ],
  },

  /* --------------------------------------------------------- supplier master */
  SUPPLIER_MASTER: {
    type: 'SUPPLIER_MASTER',
    label: 'Supplier Master',
    description:
      'Parties the pharmacy buys from, as they appear on purchase documents. Use Distributor Master instead when the party has a catalogue and prices.',
    affects: 'suppliers',
    identity: ['supplier_name'],
    requireAnyOf: [{ label: 'Supplier name', keys: ['supplier_name'] }],
    nameHints: ['supplier', 'vendor', 'party'],
    fields: [
      { ...supplierName, required: true, label: 'Supplier Name' },
      contactPerson,
      phone,
      email,
      address,
      paymentTerms,
      statusField,
    ],
  },

  /* ------------------------------------------------------ distributor master */
  DISTRIBUTOR_MASTER: {
    type: 'DISTRIBUTOR_MASTER',
    label: 'Distributor / Stockist Master',
    description:
      'The buying network: distributors and stockists with area, credit terms, delivery days and minimum order value.',
    affects: 'distributors (and a matching supplier record)',
    identity: ['distributor_code', 'name'],
    requireAnyOf: [{ label: 'Distributor name or code', keys: ['name', 'distributor_code'] }],
    nameHints: ['distributor', 'stockist', 'network', 'supplier'],
    fields: [
      { key: 'name', label: 'Distributor Name', type: 'string', synonyms: supplierName.synonyms.concat(['name']), example: 'Sai Pharma Distributors' },
      { key: 'distributor_code', label: 'Distributor Code', type: 'string', synonyms: ['code', 'distributor code', 'dist code', 'party code', 'supplier code'], example: 'DIST-014' },
      {
        key: 'type',
        label: 'Type',
        type: 'enum',
        values: ['DISTRIBUTOR', 'STOCKIST', 'SUPER_STOCKIST', 'MANUFACTURER'],
        synonyms: ['type', 'party type', 'category', 'distributor type'],
        example: 'DISTRIBUTOR',
      },
      contactPerson,
      phone,
      email,
      address,
      { key: 'area', label: 'Area', type: 'string', synonyms: ['area', 'locality', 'zone', 'region', 'sector'], example: 'Andheri' },
      { key: 'city', label: 'City', type: 'string', synonyms: ['city', 'town', 'district', 'place'], example: 'Mumbai' },
      { key: 'pin_code', label: 'PIN Code', type: 'string', synonyms: ['pin', 'pin code', 'pincode', 'postal code', 'zip', 'zip code'], example: '400053' },
      { key: 'state', label: 'State', type: 'string', synonyms: ['state', 'province'], example: 'Maharashtra' },
      gstin,
      { key: 'drug_license_no', label: 'Drug Licence No.', type: 'string', synonyms: ['drug licence', 'drug license', 'dl no', 'licence no', 'license no', 'drug licence no', 'dl'], example: 'MH-ZONE-20B-1234', note: 'Stored as entered; not verified.' },
      paymentTerms,
      { key: 'credit_days', label: 'Credit Days', type: 'integer', min: 0, synonyms: ['credit days', 'credit period', 'days credit', 'credit'], example: 30 },
      { key: 'credit_limit', label: 'Credit Limit', type: 'number', min: 0, synonyms: ['credit limit', 'limit', 'max credit'], example: 200000 },
      { key: 'delivery_days', label: 'Delivery Days', type: 'integer', min: 0, synonyms: ['delivery days', 'delivery time', 'lead time', 'delivery'], example: 1 },
      { key: 'min_order_value', label: 'Minimum Order Value', type: 'number', min: 0, synonyms: ['moq', 'min order value', 'minimum order', 'minimum order value', 'mov'], example: 2000 },
      { key: 'distance_km', label: 'Distance (km)', type: 'number', min: 0, synonyms: ['distance', 'distance km', 'km', 'distance in km'], example: 4.2 },
      { key: 'rating', label: 'Rating', type: 'number', min: 0, max: 5, synonyms: ['rating', 'score', 'stars'], example: 4.3 },
      statusField,
    ],
  },

  /* ----------------------------------------------------------- opening stock */
  OPENING_STOCK: {
    type: 'OPENING_STOCK',
    label: 'Opening Stock',
    description:
      'What is physically on the shelf right now, batch by batch. Sets each batch to the quantity in the file - use this once, when going live.',
    affects: 'product_batches, inventory_transactions',
    identity: ['product_code', 'product_name', 'batch_number'],
    requireAnyOf: [{ label: 'Product name or product code', keys: ['product_name', 'product_code'] }],
    nameHints: ['opening', 'stock', 'inventory', 'balance', 'stock statement'],
    fields: [
      productName,
      productCode,
      { ...batchNumber, note: 'Blank batches are grouped under a single OPENING batch per product.' },
      { ...expiryDate, required: true },
      manufacturingDate,
      { ...quantity, required: true },
      { ...ptr, label: 'Purchase Price' },
      mrp,
      sellingPrice,
      supplierName,
    ],
  },

  /* ------------------------------------------------------------ batch master */
  BATCH_MASTER: {
    type: 'BATCH_MASTER',
    label: 'Batch Master',
    description:
      'Adds batches and their quantities to existing stock. Same columns as Opening Stock, but quantities are added rather than set - use it for a goods-inward file.',
    affects: 'product_batches, inventory_transactions',
    identity: ['product_code', 'product_name', 'batch_number'],
    requireAnyOf: [{ label: 'Product name or product code', keys: ['product_name', 'product_code'] }],
    nameHints: ['batch', 'lot', 'batches'],
    fields: [
      productName,
      productCode,
      { ...batchNumber, required: true },
      { ...expiryDate, required: true },
      manufacturingDate,
      { ...quantity, required: true },
      freeQty,
      { ...ptr, label: 'Purchase Price' },
      mrp,
      sellingPrice,
      supplierName,
      { key: 'purchase_invoice', label: 'Purchase Invoice', type: 'string', synonyms: ['invoice', 'invoice no', 'bill no', 'purchase invoice', 'bill number', 'invoice number'], example: 'SPD/24-25/1180' },
    ],
  },

  /* --------------------------------------------------------------- price list */
  PRICE_LIST: {
    type: 'PRICE_LIST',
    label: 'Distributor Price List',
    description:
      'A distributor catalogue: what they sell, at what PTR/PTS, with what scheme and availability. Feeds Supplier Comparison and the Replenishment Center.',
    affects: 'distributor_products',
    identity: ['distributor_name', 'product_code', 'product_name'],
    requireAnyOf: [
      { label: 'Product name or product code', keys: ['product_name', 'product_code'] },
      { label: 'Distributor name or code', keys: ['distributor_name', 'distributor_code'] },
    ],
    nameHints: ['price', 'price list', 'rate list', 'catalogue', 'catalog', 'scheme', 'offer'],
    fields: [
      { key: 'distributor_name', label: 'Distributor', type: 'string', synonyms: supplierName.synonyms, example: 'Sai Pharma Distributors' },
      { key: 'distributor_code', label: 'Distributor Code', type: 'string', synonyms: ['distributor code', 'dist code', 'party code', 'supplier code'], example: 'DIST-014' },
      productName,
      productCode,
      ptr,
      pts,
      mrp,
      { key: 'scheme_buy_qty', label: 'Scheme - Buy Qty', type: 'integer', min: 0, synonyms: ['scheme buy', 'buy qty', 'scheme qty', 'buy', 'scheme buy qty'], example: 10, note: 'A "10+1" scheme is buy 10, free 1.' },
      { key: 'scheme_free_qty', label: 'Scheme - Free Qty', type: 'integer', min: 0, synonyms: ['scheme free', 'free qty', 'free', 'scheme free qty', 'bonus qty'], example: 1 },
      { key: 'scheme', label: 'Scheme (combined)', type: 'string', synonyms: ['scheme', 'offer', 'deal', 'trade scheme'], example: '10+1', note: 'A "10+1" style value is split into buy and free quantities.' },
      { key: 'discount_pct', label: 'Discount %', type: 'number', min: 0, max: 100, synonyms: ['discount', 'discount %', 'disc', 'disc %', 'trade discount', 'cash discount'], example: 5 },
      { key: 'available_qty', label: 'Available Qty', type: 'integer', min: 0, synonyms: ['available', 'available qty', 'stock', 'qty', 'availability', 'stock available'], example: 240 },
      { key: 'min_order_qty', label: 'Minimum Order Qty', type: 'integer', min: 1, synonyms: ['moq', 'min order qty', 'minimum order qty', 'min qty'], example: 10 },
    ],
  },

  /* --------------------------------------------------------- purchase history */
  PURCHASE_HISTORY: {
    type: 'PURCHASE_HISTORY',
    label: 'Purchase History',
    description:
      'Past goods-inward documents, one row per line item. Rows sharing an invoice number become one purchase. Creates batches and adds the stock.',
    affects: 'purchases, purchase_items, product_batches, inventory_transactions',
    identity: ['invoice_number', 'product_code', 'product_name', 'batch_number'],
    requireAnyOf: [
      { label: 'Product name or product code', keys: ['product_name', 'product_code'] },
      { label: 'Supplier or distributor name', keys: ['supplier_name'] },
    ],
    nameHints: ['purchase', 'inward', 'grn', 'goods', 'buying', 'purchases'],
    fields: [
      { key: 'invoice_number', label: 'Invoice Number', type: 'string', synonyms: ['invoice', 'invoice no', 'bill no', 'bill number', 'invoice number', 'purchase invoice', 'doc no'], example: 'SPD/24-25/1180', note: 'Rows sharing an invoice number are grouped into one purchase.' },
      { key: 'purchase_date', label: 'Purchase Date', type: 'date', synonyms: ['date', 'purchase date', 'bill date', 'invoice date', 'grn date', 'inward date'], example: '2026-07-14' },
      { ...supplierName, required: true },
      productName,
      productCode,
      { ...batchNumber, required: true },
      { ...expiryDate, required: true },
      manufacturingDate,
      { ...quantity, required: true },
      freeQty,
      { ...ptr, label: 'Purchase Rate', required: true },
      mrp,
      taxRate,
    ],
  },

  /* ------------------------------------------------------------ sales history */
  SALES_HISTORY: {
    type: 'SALES_HISTORY',
    label: 'Sales History',
    description:
      'Past counter sales, one row per line item. Rows sharing an invoice number become one bill. Imported for analysis - stock is NOT deducted again.',
    affects: 'sales, sale_items, customers',
    identity: ['invoice_number', 'product_code', 'product_name'],
    requireAnyOf: [
      { label: 'Product name or product code', keys: ['product_name', 'product_code'] },
      { label: 'Invoice number', keys: ['invoice_number'] },
    ],
    nameHints: ['sale', 'sales', 'billing', 'bills', 'invoice', 'counter'],
    fields: [
      { key: 'invoice_number', label: 'Invoice Number', type: 'string', required: true, synonyms: ['invoice', 'invoice no', 'bill no', 'bill number', 'invoice number', 'receipt no'], example: 'INV-004821' },
      { key: 'sale_date', label: 'Sale Date', type: 'date', synonyms: ['date', 'sale date', 'bill date', 'invoice date', 'transaction date'], example: '2026-08-02' },
      { key: 'customer_name', label: 'Customer', type: 'string', synonyms: ['customer', 'customer name', 'party', 'patient', 'buyer', 'client'], example: 'Walk-in' },
      { key: 'customer_phone', label: 'Customer Phone', type: 'string', synonyms: phone.synonyms, example: '+91 98765 43210' },
      productName,
      productCode,
      batchNumber,
      { ...quantity, required: true },
      { ...sellingPrice, required: true, label: 'Rate' },
      { key: 'discount', label: 'Discount Amount', type: 'number', min: 0, synonyms: ['discount', 'disc', 'discount amount', 'less'], example: 0 },
      taxRate,
      {
        key: 'payment_method',
        label: 'Payment Method',
        type: 'enum',
        values: ['CASH', 'UPI', 'CARD', 'CREDIT', 'OTHER'],
        synonyms: ['payment', 'payment mode', 'mode', 'payment method', 'paid by', 'tender'],
        example: 'CASH',
      },
    ],
  },
};

/** Definition lookup that fails loudly on an unknown type. */
export function importDef(type: ImportType): ImportTypeDef {
  const def = IMPORT_DEFS[type];
  if (!def) throw new Error(`Unknown import type: ${type}`);
  return def;
}

/** Summary list for the Import Center landing screen. */
export function importTypeSummaries() {
  return Object.values(IMPORT_DEFS).map((def) => ({
    type: def.type,
    label: def.label,
    description: def.description,
    affects: def.affects,
    fieldCount: def.fields.length,
    requiredFields: def.fields.filter((f) => f.required).map((f) => f.label),
    requireAnyOf: def.requireAnyOf ?? [],
  }));
}
