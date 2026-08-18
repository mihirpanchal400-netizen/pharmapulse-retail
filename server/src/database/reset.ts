import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { closeDb, getDb } from './connection';
import { runMigrations } from './migrate';

/**
 * Deletes the database file and rebuilds an empty schema with the demo users
 * and default settings. Business data is NOT regenerated - run `npm run seed`
 * after this for a populated database.
 *
 * The existing file is moved aside rather than destroyed, so a reset run by
 * mistake is always recoverable.
 */
function reset(): void {
  const file = config.databasePath;

  if (file !== ':memory:' && fs.existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupDir = path.join(path.dirname(file), 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

    const target = path.join(backupDir, `pre-reset-${stamp}.db`);
    fs.copyFileSync(file, target);
    console.log(`  Existing database copied to ${target}`);

    // WAL sidecars must go too, or the rebuilt file inherits stale pages.
    for (const suffix of ['', '-wal', '-shm']) {
      const sidecar = `${file}${suffix}`;
      if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
    }
    console.log('  Old database removed.');
  }

  runMigrations(getDb());
  console.log('  Fresh schema created with demo users and default settings.');
  console.log('  Run  npm run seed  to load demo business data.');
  closeDb();
}

if (require.main === module) {
  try {
    reset();
  } catch (err) {
    console.error('  Reset failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
