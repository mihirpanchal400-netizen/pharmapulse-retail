import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import { config } from '../config';

/**
 * Sample Excel files for the Import Center.
 *
 * Generated rather than committed as binaries, so the samples always match the
 * current field catalogue and the repository stays free of opaque blobs.
 *
 * Every file is deliberately *messy* in a way real pharmacy exports are messy,
 * because a demo that only handles clean data proves nothing:
 *
 *   - headers use trade vocabulary, not the software's field names
 *     ("Medicine Name", "Company", "Qty", "Exp.", "MRP Rs.")
 *   - dates appear as DD/MM/YYYY, MM/YY and Excel date cells in the same file
 *   - prices carry rupee symbols and thousands separators
 *   - one workbook has a title row above the headers
 *   - a handful of rows carry deliberate mistakes so the error report has
 *     something to show
 *   - one workbook is multi-sheet, which is how a pharmacy's "master file"
 *     usually arrives
 *
 * All names, companies and licence numbers are invented. No real distributor,
 * customer or patient data appears anywhere.
 */

export const SAMPLE_DIR = path.resolve(config.repoRoot, 'sample-data');

/* -------------------------------------------------------------------------- */
/* Source data                                                                 */
/* -------------------------------------------------------------------------- */

interface SampleProduct {
  name: string;
  brand: string;
  generic: string;
  company: string;
  category: string;
  form: string;
  strength: string;
  pack: string;
  gst: number;
  mrp: number;
  ptr: number;
  schedule: string;
}

const PRODUCTS: SampleProduct[] = [
  { name: 'Pantoprazole 40mg Tablet', brand: 'Pantogard', generic: 'Pantoprazole', company: 'Meridian Life Sciences', category: 'Gastro', form: 'Tablet', strength: '40mg', pack: '10 Tablets', gst: 12, mrp: 154.5, ptr: 108.15, schedule: 'H' },
  { name: 'Amoxicillin 500mg Capsule', brand: 'Amoxifine', generic: 'Amoxicillin', company: 'Kaveri Pharma', category: 'Antibiotic', form: 'Capsule', strength: '500mg', pack: '10 Capsules', gst: 12, mrp: 96.0, ptr: 67.2, schedule: 'H' },
  { name: 'Metformin 500mg Tablet', brand: 'Glucomet', generic: 'Metformin HCl', company: 'Deccan Remedies', category: 'Diabetes', form: 'Tablet', strength: '500mg', pack: '15 Tablets', gst: 12, mrp: 62.4, ptr: 43.68, schedule: 'H' },
  { name: 'Amlodipine 5mg Tablet', brand: 'Amlokind', generic: 'Amlodipine Besylate', company: 'Nilgiri Healthcare', category: 'Cardiac', form: 'Tablet', strength: '5mg', pack: '10 Tablets', gst: 12, mrp: 48.0, ptr: 33.6, schedule: 'H' },
  { name: 'Paracetamol 650mg Tablet', brand: 'Febrinil', generic: 'Paracetamol', company: 'Kaveri Pharma', category: 'Analgesic', form: 'Tablet', strength: '650mg', pack: '15 Tablets', gst: 12, mrp: 32.5, ptr: 21.45, schedule: 'OTC' },
  { name: 'Cetirizine 10mg Tablet', brand: 'Alergon', generic: 'Cetirizine', company: 'Meridian Life Sciences', category: 'Antihistamine', form: 'Tablet', strength: '10mg', pack: '10 Tablets', gst: 12, mrp: 28.0, ptr: 18.2, schedule: 'OTC' },
  { name: 'Atorvastatin 10mg Tablet', brand: 'Lipistat', generic: 'Atorvastatin', company: 'Deccan Remedies', category: 'Cardiac', form: 'Tablet', strength: '10mg', pack: '10 Tablets', gst: 12, mrp: 118.0, ptr: 82.6, schedule: 'H' },
  { name: 'Azithromycin 500mg Tablet', brand: 'Azirok', generic: 'Azithromycin', company: 'Konkan Biotech', category: 'Antibiotic', form: 'Tablet', strength: '500mg', pack: '3 Tablets', gst: 12, mrp: 143.0, ptr: 100.1, schedule: 'H' },
  { name: 'Omeprazole 20mg Capsule', brand: 'Omezol', generic: 'Omeprazole', company: 'Nilgiri Healthcare', category: 'Gastro', form: 'Capsule', strength: '20mg', pack: '15 Capsules', gst: 12, mrp: 88.5, ptr: 61.95, schedule: 'H' },
  { name: 'Levocetirizine 5mg Tablet', brand: 'Levorest', generic: 'Levocetirizine', company: 'Konkan Biotech', category: 'Antihistamine', form: 'Tablet', strength: '5mg', pack: '10 Tablets', gst: 12, mrp: 54.0, ptr: 37.8, schedule: 'OTC' },
  { name: 'Telmisartan 40mg Tablet', brand: 'Telmikind', generic: 'Telmisartan', company: 'Deccan Remedies', category: 'Cardiac', form: 'Tablet', strength: '40mg', pack: '15 Tablets', gst: 12, mrp: 176.0, ptr: 123.2, schedule: 'H' },
  { name: 'Glimepiride 2mg Tablet', brand: 'Glimestar', generic: 'Glimepiride', company: 'Meridian Life Sciences', category: 'Diabetes', form: 'Tablet', strength: '2mg', pack: '10 Tablets', gst: 12, mrp: 92.0, ptr: 64.4, schedule: 'H' },
  { name: 'Ibuprofen 400mg Tablet', brand: 'Brufast', generic: 'Ibuprofen', company: 'Kaveri Pharma', category: 'Analgesic', form: 'Tablet', strength: '400mg', pack: '15 Tablets', gst: 12, mrp: 44.0, ptr: 29.04, schedule: 'OTC' },
  { name: 'Ranitidine 150mg Tablet', brand: 'Rantac Plus', generic: 'Ranitidine', company: 'Konkan Biotech', category: 'Gastro', form: 'Tablet', strength: '150mg', pack: '20 Tablets', gst: 12, mrp: 38.5, ptr: 26.95, schedule: 'H' },
  { name: 'Cefixime 200mg Tablet', brand: 'Cefiban', generic: 'Cefixime', company: 'Nilgiri Healthcare', category: 'Antibiotic', form: 'Tablet', strength: '200mg', pack: '10 Tablets', gst: 12, mrp: 198.0, ptr: 138.6, schedule: 'H' },
  { name: 'Vitamin D3 60000 IU Sachet', brand: 'Sunboost', generic: 'Cholecalciferol', company: 'Kaveri Pharma', category: 'Supplement', form: 'Sachet', strength: '60000 IU', pack: '4 Sachets', gst: 5, mrp: 120.0, ptr: 84.0, schedule: 'OTC' },
  { name: 'Ondansetron 4mg Tablet', brand: 'Emeset', generic: 'Ondansetron', company: 'Deccan Remedies', category: 'Gastro', form: 'Tablet', strength: '4mg', pack: '10 Tablets', gst: 12, mrp: 72.0, ptr: 50.4, schedule: 'H' },
  { name: 'Montelukast 10mg Tablet', brand: 'Montair', generic: 'Montelukast', company: 'Meridian Life Sciences', category: 'Respiratory', form: 'Tablet', strength: '10mg', pack: '10 Tablets', gst: 12, mrp: 210.0, ptr: 147.0, schedule: 'H' },
  { name: 'Salbutamol Inhaler 100mcg', brand: 'Asthalin', generic: 'Salbutamol', company: 'Konkan Biotech', category: 'Respiratory', form: 'Inhaler', strength: '100mcg', pack: '1 Unit', gst: 12, mrp: 168.0, ptr: 117.6, schedule: 'H' },
  { name: 'ORS Powder Sachet', brand: 'Rehydra', generic: 'Oral Rehydration Salts', company: 'Kaveri Pharma', category: 'Supplement', form: 'Sachet', strength: '21.8g', pack: '1 Sachet', gst: 5, mrp: 22.0, ptr: 15.4, schedule: 'OTC' },
];

const DISTRIBUTORS = [
  { code: 'DIST-001', name: 'Sahyadri Pharma Distributors', person: 'Mahesh Rao', phone: '+91 98200 11223', area: 'Andheri East', city: 'Mumbai', pin: '400069', state: 'Maharashtra', terms: 'Net 30', creditDays: 30, delivery: 1, moq: 2000, distance: 4.2, rating: 4.4 },
  { code: 'DIST-002', name: 'Konkan Medical Agencies', person: 'Sunita Kamat', phone: '+91 98201 44556', area: 'Dadar West', city: 'Mumbai', pin: '400028', state: 'Maharashtra', terms: 'Net 21', creditDays: 21, delivery: 2, moq: 1500, distance: 9.8, rating: 4.1 },
  { code: 'DIST-003', name: 'Deccan Healthcare Supplies', person: 'Anil Joshi', phone: '+91 98202 77889', area: 'Kurla', city: 'Mumbai', pin: '400070', state: 'Maharashtra', terms: 'Net 45', creditDays: 45, delivery: 1, moq: 3000, distance: 6.5, rating: 4.6 },
  { code: 'DIST-004', name: 'Western Drug House', person: 'Farida Shaikh', phone: '+91 98203 33221', area: 'Bandra', city: 'Mumbai', pin: '400050', state: 'Maharashtra', terms: 'Cash', creditDays: 0, delivery: 1, moq: 1000, distance: 3.1, rating: 3.9 },
  { code: 'DIST-005', name: 'Prime Stockist Network', person: 'Rajesh Menon', phone: '+91 98204 66554', area: 'Thane West', city: 'Thane', pin: '400601', state: 'Maharashtra', terms: 'Net 30', creditDays: 30, delivery: 3, moq: 2500, distance: 18.4, rating: 4.0 },
];

/** Deterministic pseudo-random, so regenerating the samples gives the same files. */
function makeRandom(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

const rupees = (value: number) => `Rs. ${value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Expiry a given number of months out, written the way pharma files write it. */
function expiryText(monthsAhead: number, style: 'mm/yyyy' | 'dd/mm/yyyy' | 'mon-yy'): string {
  const date = new Date();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + monthsAhead);
  const month = date.getUTCMonth() + 1;
  const year = date.getUTCFullYear();
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();

  if (style === 'mm/yyyy') return `${String(month).padStart(2, '0')}/${year}`;
  if (style === 'dd/mm/yyyy') return `${lastDay}/${String(month).padStart(2, '0')}/${year}`;
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${names[month - 1]}-${String(year).slice(2)}`;
}

function pastDate(daysAgo: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return `${String(date.getUTCDate()).padStart(2, '0')}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${date.getUTCFullYear()}`;
}

function styleHeader(sheet: ExcelJS.Worksheet, rowNumber = 1): void {
  const row = sheet.getRow(rowNumber);
  row.font = { bold: true };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
  sheet.columns.forEach((column) => {
    column.width = Math.max(14, Math.min(30, (column.header?.length ?? 14) + 4));
  });
}

/* -------------------------------------------------------------------------- */
/* Individual sample files                                                     */
/* -------------------------------------------------------------------------- */

function buildProductMaster(workbook: ExcelJS.Workbook): void {
  const sheet = workbook.addWorksheet('Item Master');

  // A title row above the headers - the header detector has to find row 3.
  sheet.addRow(['SHREE MEDICAL STORES - ITEM MASTER']);
  sheet.addRow([`Generated ${new Date().toLocaleDateString('en-IN')}`]);
  sheet.addRow([
    'Item Code', 'Medicine Name', 'Brand', 'Salt', 'Company', 'Segment', 'Form',
    'Strength', 'Packing', 'HSN', 'GST %', 'MRP Rs.', 'Purchase Rate', 'Schedule', 'Reorder Level',
  ]);

  PRODUCTS.forEach((product, index) => {
    sheet.addRow([
      `ITM${String(index + 1).padStart(4, '0')}`,
      product.name,
      product.brand,
      product.generic,
      product.company,
      product.category,
      product.form,
      product.strength,
      product.pack,
      product.gst === 5 ? '3004' : '3004',
      product.gst,
      product.mrp,
      product.ptr,
      product.schedule,
      20 + (index % 4) * 10,
    ]);
  });

  // Deliberate problems, so the validation and error report have work to do.
  sheet.addRow(['ITM0021', '', 'Nomed', 'Unknown', 'Kaveri Pharma', 'Analgesic', 'Tablet', '100mg', '10 Tablets', '3004', 12, 45, 31.5, 'OTC', 20]);
  sheet.addRow(['ITM0022', 'Diclofenac 50mg Tablet', 'Dicloran', 'Diclofenac', 'Kaveri Pharma', 'Analgesic', 'Tablet', '50mg', '10 Tablets', '3004', 12, 'not priced', 28.0, 'H', 20]);
  sheet.addRow(['ITM0023', 'Rabeprazole 20mg Tablet', 'Rabifast', 'Rabeprazole', 'Nilgiri Healthcare', 'Gastro', 'Tablet', '20mg', '10 Tablets', '3004', 12, 110, 145.0, 'H', 20]);

  sheet.getRow(1).font = { bold: true, size: 14 };
  styleHeader(sheet, 3);
}

function buildSupplierMaster(workbook: ExcelJS.Workbook): void {
  const sheet = workbook.addWorksheet('Distributors');
  sheet.addRow(['Party Code', 'Firm Name', 'Contact Person', 'Mobile', 'Area', 'City', 'PIN', 'State', 'GST No', 'Drug Licence No', 'Terms', 'Credit Days', 'Delivery Days', 'MOQ', 'Distance in KM', 'Rating']);

  DISTRIBUTORS.forEach((distributor, index) => {
    sheet.addRow([
      distributor.code,
      distributor.name,
      distributor.person,
      distributor.phone,
      distributor.area,
      distributor.city,
      distributor.pin,
      distributor.state,
      `27DEMO${String(1000 + index)}F1Z${index}`,
      `MH-DEMO-20B-${2000 + index}`,
      distributor.terms,
      distributor.creditDays,
      distributor.delivery,
      distributor.moq,
      distributor.distance,
      distributor.rating,
    ]);
  });

  styleHeader(sheet);
}

function buildOpeningStock(workbook: ExcelJS.Workbook): void {
  const sheet = workbook.addWorksheet('Stock Statement');
  sheet.addRow(['Item Code', 'Medicine Name', 'Batch No', 'Exp.', 'Qty', 'Rate', 'MRP', 'Supplier']);

  const random = makeRandom(4207);
  PRODUCTS.forEach((product, index) => {
    const batches = 1 + Math.floor(random() * 2);
    for (let b = 0; b < batches; b += 1) {
      const style = b === 0 ? 'mm/yyyy' : 'mon-yy';
      sheet.addRow([
        `ITM${String(index + 1).padStart(4, '0')}`,
        product.name,
        `${product.brand.slice(0, 3).toUpperCase()}${24 + b}${String.fromCharCode(65 + index % 26)}${String(100 + index)}`,
        expiryText(4 + Math.floor(random() * 26), style as 'mm/yyyy' | 'mon-yy'),
        20 + Math.floor(random() * 140),
        rupees(product.ptr),
        rupees(product.mrp),
        DISTRIBUTORS[index % DISTRIBUTORS.length].name,
      ]);
    }
  });

  // A batch that expired last month: a real stock statement contains these, and
  // the importer must warn rather than reject.
  sheet.addRow(['ITM0005', PRODUCTS[4].name, 'FEB23EXP', expiryText(-2, 'mm/yyyy'), 12, rupees(PRODUCTS[4].ptr), rupees(PRODUCTS[4].mrp), DISTRIBUTORS[0].name]);
  // A negative quantity: rejected.
  sheet.addRow(['ITM0006', PRODUCTS[5].name, 'NEG001', expiryText(10, 'mm/yyyy'), -8, rupees(PRODUCTS[5].ptr), rupees(PRODUCTS[5].mrp), DISTRIBUTORS[1].name]);
  // An unreadable expiry: rejected.
  sheet.addRow(['ITM0007', PRODUCTS[6].name, 'BAD001', 'expired soon', 40, rupees(PRODUCTS[6].ptr), rupees(PRODUCTS[6].mrp), DISTRIBUTORS[2].name]);

  styleHeader(sheet);
}

function buildPriceList(workbook: ExcelJS.Workbook): void {
  const sheet = workbook.addWorksheet('Rate List');
  sheet.addRow(['Distributor', 'Product', 'PTR', 'PTS', 'MRP', 'Scheme', 'Discount %', 'Available Qty', 'Min Qty']);

  const random = makeRandom(9931);
  for (const distributor of DISTRIBUTORS) {
    for (const product of PRODUCTS) {
      // Not every distributor carries everything.
      if (random() < 0.25) continue;

      const swing = 0.94 + random() * 0.1;
      const ptr = Math.round(product.ptr * swing * 100) / 100;
      const hasScheme = random() < 0.35;

      sheet.addRow([
        distributor.name,
        product.name,
        ptr,
        Math.round(ptr * 0.92 * 100) / 100,
        product.mrp,
        hasScheme ? `${10}+${1}` : '',
        hasScheme ? 0 : Math.round(random() * 5),
        Math.floor(random() * 400),
        10,
      ]);
    }
  }

  styleHeader(sheet);
}

function buildPurchaseHistory(workbook: ExcelJS.Workbook): void {
  const sheet = workbook.addWorksheet('Purchase Register');
  sheet.addRow(['Bill No', 'Bill Date', 'Party Name', 'Medicine Name', 'Batch No', 'Exp Date', 'Qty', 'Free', 'Rate', 'MRP', 'GST %']);

  const random = makeRandom(1777);
  for (let invoice = 0; invoice < 12; invoice += 1) {
    const distributor = DISTRIBUTORS[invoice % DISTRIBUTORS.length];
    const billNo = `${distributor.code.replace('DIST-', 'INV')}/25-26/${1100 + invoice}`;
    const billDate = pastDate(90 - invoice * 6);
    const lines = 2 + Math.floor(random() * 3);

    for (let line = 0; line < lines; line += 1) {
      const product = PRODUCTS[Math.floor(random() * PRODUCTS.length)];
      const quantity = 10 * (1 + Math.floor(random() * 5));
      const free = random() < 0.3 ? Math.floor(quantity / 10) : 0;

      sheet.addRow([
        billNo,
        billDate,
        distributor.name,
        product.name,
        `${product.brand.slice(0, 3).toUpperCase()}P${invoice}${line}`,
        expiryText(8 + Math.floor(random() * 20), 'dd/mm/yyyy'),
        quantity,
        free,
        product.ptr,
        product.mrp,
        product.gst,
      ]);
    }
  }

  styleHeader(sheet);
}

function buildSalesHistory(workbook: ExcelJS.Workbook): void {
  const sheet = workbook.addWorksheet('Sales Register');
  sheet.addRow(['Bill No', 'Bill Date', 'Customer', 'Mobile', 'Medicine Name', 'Qty', 'Rate', 'Discount', 'GST %', 'Payment Mode']);

  const random = makeRandom(5501);
  const customers = [
    ['Walk-in', ''],
    ['R. Kulkarni', '+91 90000 10001'],
    ['S. Iyer', '+91 90000 10002'],
    ['M. Bhosale', '+91 90000 10003'],
    ['Walk-in', ''],
  ];
  const modes = ['CASH', 'UPI', 'CARD', 'CASH', 'UPI'];

  for (let bill = 0; bill < 40; bill += 1) {
    const customer = customers[Math.floor(random() * customers.length)];
    const billNo = `SI-${String(9001 + bill)}`;
    const billDate = pastDate(60 - Math.floor(bill * 1.4));
    const lines = 1 + Math.floor(random() * 3);

    for (let line = 0; line < lines; line += 1) {
      const product = PRODUCTS[Math.floor(random() * PRODUCTS.length)];
      const quantity = 1 + Math.floor(random() * 3);

      sheet.addRow([
        billNo,
        billDate,
        customer[0],
        customer[1],
        product.name,
        quantity,
        product.mrp,
        random() < 0.2 ? Math.round(product.mrp * quantity * 0.05 * 100) / 100 : 0,
        product.gst,
        modes[Math.floor(random() * modes.length)],
      ]);
    }
  }

  styleHeader(sheet);
}

/**
 * The multi-sheet workbook: one file holding products, distributors and stock,
 * which is how a pharmacy's data usually arrives in practice.
 */
function buildCombinedWorkbook(workbook: ExcelJS.Workbook): void {
  const products = workbook.addWorksheet('Products');
  products.addRow(['Item Name', 'Company', 'Pack', 'GST', 'MRP', 'PTR']);
  for (const product of PRODUCTS.slice(0, 12)) {
    products.addRow([product.name, product.company, product.pack, product.gst, product.mrp, product.ptr]);
  }
  styleHeader(products);

  const suppliers = workbook.addWorksheet('Suppliers');
  suppliers.addRow(['Firm Name', 'Contact Person', 'Mobile', 'City', 'Terms']);
  for (const distributor of DISTRIBUTORS) {
    suppliers.addRow([distributor.name, distributor.person, distributor.phone, distributor.city, distributor.terms]);
  }
  styleHeader(suppliers);

  const stock = workbook.addWorksheet('Stock');
  stock.addRow(['Item Name', 'Batch', 'Expiry', 'Qty', 'Rate']);
  const random = makeRandom(88123);
  for (const product of PRODUCTS.slice(0, 12)) {
    stock.addRow([
      product.name,
      `${product.brand.slice(0, 3).toUpperCase()}C${Math.floor(random() * 900) + 100}`,
      expiryText(6 + Math.floor(random() * 20), 'mm/yyyy'),
      15 + Math.floor(random() * 90),
      product.ptr,
    ]);
  }
  styleHeader(stock);

  const manufacturers = workbook.addWorksheet('Companies');
  manufacturers.addRow(['Company Name', 'Code', 'Contact Person', 'Phone']);
  const companies = Array.from(new Set(PRODUCTS.map((p) => p.company)));
  companies.forEach((company, index) => {
    manufacturers.addRow([company, company.slice(0, 3).toUpperCase(), `Sales Desk ${index + 1}`, `+91 22 4000 ${1000 + index}`]);
  });
  styleHeader(manufacturers);
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

const FILES: { file: string; build: (wb: ExcelJS.Workbook) => void; description: string }[] = [
  { file: 'sample_product_master.xlsx', build: buildProductMaster, description: 'Product master with a title row, trade headers and 3 bad rows' },
  { file: 'sample_supplier_master.xlsx', build: buildSupplierMaster, description: 'Distributor / stockist network' },
  { file: 'sample_stock.xlsx', build: buildOpeningStock, description: 'Opening stock with rupee-formatted prices and mixed date styles' },
  { file: 'sample_price_list.xlsx', build: buildPriceList, description: 'Distributor rate list with 10+1 schemes' },
  { file: 'sample_purchase_history.xlsx', build: buildPurchaseHistory, description: 'Purchase register, multiple lines per bill' },
  { file: 'sample_sales_history.xlsx', build: buildSalesHistory, description: 'Sales register, multiple lines per bill' },
  { file: 'sample_multi_sheet_master.xlsx', build: buildCombinedWorkbook, description: 'One workbook holding Products, Suppliers, Stock and Companies' },
];

export async function generateSampleData(targetDir = SAMPLE_DIR): Promise<string[]> {
  fs.mkdirSync(targetDir, { recursive: true });
  const written: string[] = [];

  for (const entry of FILES) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'PharmaPulse Retail sample generator';
    workbook.created = new Date();
    entry.build(workbook);

    const full = path.join(targetDir, entry.file);
    await workbook.xlsx.writeFile(full);
    written.push(full);
  }

  // A CSV alongside the workbooks, because plenty of legacy billing software
  // exports nothing else.
  const csvLines = [
    'Medicine,Company,Pack,MRP,Purchase Rate,GST',
    ...PRODUCTS.map((p) => `"${p.name}","${p.company}","${p.pack}",${p.mrp},${p.ptr},${p.gst}`),
  ];
  const csvPath = path.join(targetDir, 'sample_product_master.csv');
  fs.writeFileSync(csvPath, `﻿${csvLines.join('\r\n')}\r\n`, 'utf8');
  written.push(csvPath);

  const readme = [
    '# Sample data',
    '',
    'Generated by `npm run sample:data`. Regenerate them at any time - they are',
    'built from the same field catalogue the importer matches against.',
    '',
    'These files are deliberately untidy, the way real pharmacy exports are:',
    'trade column names, rupee symbols in price cells, three different date',
    'styles, a title row above the headers, and a handful of rows with genuine',
    'mistakes so the validation report has something to show.',
    '',
    '| File | What it demonstrates |',
    '|---|---|',
    ...FILES.map((f) => `| \`${f.file}\` | ${f.description} |`),
    '| `sample_product_master.csv` | The same product data as CSV |',
    '',
    'All companies, distributors, licence numbers and customer names are',
    'invented. No real personal, patient or commercial data appears here.',
    '',
    'Suggested order: Product Master, then Supplier/Distributor Master, then',
    'Opening Stock, then Price List, then Purchase and Sales History.',
    '',
  ].join('\n');
  const readmePath = path.join(targetDir, 'README.md');
  fs.writeFileSync(readmePath, readme, 'utf8');
  written.push(readmePath);

  return written;
}

// `npm run sample:data`
if (require.main === module) {
  generateSampleData()
    .then((files) => {
      console.log(`\n  Sample data written to ${SAMPLE_DIR}\n`);
      for (const file of files) console.log(`    ${path.basename(file)}`);
      console.log('');
    })
    .catch((err) => {
      console.error('Sample data generation failed:', err);
      process.exit(1);
    });
}
