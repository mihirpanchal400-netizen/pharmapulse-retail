import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { config } from '../config';

/**
 * Database backup: `npm run backup`.
 *
 * Uses SQLite's own online backup API rather than a plain file copy. That
 * matters because the database runs in WAL mode: copying `pharmapulse.db` while
 * the server is running can capture a file whose latest pages are still sitting
 * in the `-wal` sidecar, producing a backup that is silently out of date. The
 * backup API checkpoints properly and yields a single consistent file.
 */
async function backup(): Promise<void> {
  const source = config.databasePath;

  if (source === ':memory:') {
    console.error('  The database is in-memory (NODE_ENV=test). Nothing to back up.');
    process.exit(1);
  }
  if (!fs.existsSync(source)) {
    console.error(`  No database found at ${source}.`);
    console.error('  Run  npm run seed  first.');
    process.exit(1);
  }

  const dir = path.join(path.dirname(source), 'backups');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const now = new Date();
  const stamp =
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-` +
    `${String(now.getDate()).padStart(2, '0')}-` +
    `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  const target = path.join(dir, `pharmapulse-${stamp}.db`);

  const db = new Database(source, { readonly: true });
  try {
    await db.backup(target);
  } finally {
    db.close();
  }

  const sizeMb = (fs.statSync(target).size / 1024 / 1024).toFixed(2);

  console.log('');
  console.log('  Backup complete');
  console.log('  ------------------------------------------------');
  console.log(`  Source   ${source}`);
  console.log(`  Backup   ${target}`);
  console.log(`  Size     ${sizeMb} MB`);
  console.log('');
  console.log('  To restore, stop the app first, then in PowerShell:');
  console.log(`    Copy-Item "${target}" "${source}" -Force`);
  console.log('');

  // Keep the ten most recent backups; older ones are pruned so the folder does
  // not grow without bound on a laptop.
  const kept = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('pharmapulse-') && f.endsWith('.db'))
    .sort()
    .reverse();
  for (const stale of kept.slice(10)) {
    fs.unlinkSync(path.join(dir, stale));
    console.log(`  Pruned old backup: ${stale}`);
  }
}

if (require.main === module) {
  backup().catch((err) => {
    console.error('  Backup failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
