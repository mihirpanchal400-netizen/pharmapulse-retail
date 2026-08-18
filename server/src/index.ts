import { createApp } from './app';
import { config } from './config';
import { getDb, closeDb } from './database/connection';
import { runMigrations } from './database/migrate';

/**
 * API entry point.
 *
 * Migrations run on every start. They are idempotent (CREATE TABLE IF NOT
 * EXISTS, INSERT OR IGNORE), so the application is usable immediately after a
 * fresh `npm run dev` even before `npm run seed` has been run.
 */
function start(): void {
  const db = getDb();
  runMigrations(db);

  const counts = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM products) AS products,
              (SELECT COUNT(*) FROM sales)    AS sales`,
    )
    .get() as { products: number; sales: number };

  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log('');
    console.log('  PharmaPulse Retail API');
    console.log(`  ---------------------------------------------`);
    console.log(`  Listening   http://localhost:${config.port}`);
    console.log(`  Environment ${config.env}`);
    console.log(`  Database    ${config.databasePath}`);
    console.log(`  Data        ${counts.products} products, ${counts.sales} sales`);
    if (counts.products === 0) {
      console.log('');
      console.log('  The database is empty. Run  npm run seed  to load demo data.');
    }
    console.log('');
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `\n  Port ${config.port} is already in use.\n` +
          `  Another copy of the API is probably still running.\n\n` +
          `  Find it:  Get-NetTCPConnection -LocalPort ${config.port} | Select-Object OwningProcess\n` +
          `  Stop it:  Stop-Process -Id <PID>\n` +
          `  Or set a different PORT in server/.env\n`,
      );
      process.exit(1);
    }
    throw err;
  });

  // Close the database cleanly so WAL is checkpointed rather than left behind.
  const shutdown = (signal: string) => () => {
    console.log(`\n  ${signal} received, shutting down.`);
    server.close(() => {
      closeDb();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown('SIGINT'));
  process.on('SIGTERM', shutdown('SIGTERM'));
}

start();
