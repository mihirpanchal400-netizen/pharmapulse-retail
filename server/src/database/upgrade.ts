import { getDb, closeDb } from './connection';
import { runMigrations } from './migrate';

/** One-shot schema upgrade + verification: `npm run db:upgrade`. */
function upgrade(): void {
  const db = getDb();
  const started = Date.now();
  runMigrations(db);

  const tables = (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite%' ORDER BY name")
      .all() as { name: string }[]
  ).map((t) => t.name);
  const productCols = (db.prepare('PRAGMA table_info(products)').all() as { name: string }[]).length;
  const sales = db.prepare('SELECT COUNT(*) AS n FROM sales').get() as { n: number };
  const sample = db
    .prepare('SELECT product_name, mrp, ptr, pts, hsn_code, schedule_category FROM products LIMIT 2')
    .all();

  console.log(`\n  Schema upgrade complete in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`  Tables (${tables.length}): ${tables.join(', ')}`);
  console.log(`  products columns: ${productCols}`);
  console.log(`  sales rows preserved: ${sales.n}`);
  console.log(`  sample: ${JSON.stringify(sample)}\n`);
  closeDb();
}

if (require.main === module) {
  try {
    upgrade();
  } catch (err) {
    console.error('  Upgrade failed:', err instanceof Error ? err.message : err);
    closeDb();
    process.exit(1);
  }
}
