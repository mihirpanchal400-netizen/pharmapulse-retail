import express, { type Express } from 'express';
import cors from 'cors';
import { config } from './config';
import { requireAuth } from './middleware/auth';
import { errorHandler, notFoundHandler, wrap } from './middleware/error';
import authRoutes from './routes/auth';
import catalogRoutes from './routes/catalog';
import inventoryRoutes from './routes/inventory';
import transactionRoutes from './routes/transactions';
import analyticsRoutes from './routes/analytics';
import reportRoutes from './routes/reports';
import settingsRoutes from './routes/settings';
import procurementRoutes from './routes/procurement';
import importRoutes from './routes/imports';
import { getPharmacyProfile } from './services/settingsService';

/**
 * Builds the Express application.
 *
 * Separated from `index.ts` (which listens on a port) so the test suite can
 * mount the same app with Supertest without binding a socket.
 */
export function createApp(): Express {
  const app = express();

  // The API is same-machine only. CORS exists purely so the Vite dev server on
  // :5173 can reach the API on :4000 during development.
  app.use(cors({ origin: config.clientOrigin, credentials: true }));

  // 1 MB is generous for a pharmacy invoice and stops a runaway client from
  // pushing an unbounded body into memory.
  app.use(express.json({ limit: '1mb' }));

  /** Liveness probe. Deliberately unauthenticated and free of business data. */
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', env: config.env, timestamp: new Date().toISOString() });
  });

  /**
   * Public branding for the login screen (pharmacy name, currency symbol).
   * Contains no commercial figures, so it is safe before authentication.
   */
  app.get(
    '/api/public/profile',
    wrap((_req, res) => {
      const profile = getPharmacyProfile();
      res.json({ pharmacy_name: profile.pharmacy_name, currency_symbol: profile.currency_symbol });
    }),
  );

  app.use('/api/auth', authRoutes);

  // Everything below requires a valid token. Mounting `requireAuth` once here
  // means a new route file cannot accidentally ship unauthenticated.
  app.use('/api', requireAuth);
  app.use('/api', catalogRoutes);
  app.use('/api/inventory', inventoryRoutes);
  app.use('/api', transactionRoutes);
  app.use('/api/analytics', analyticsRoutes);
  app.use('/api/reports', reportRoutes);
  app.use('/api/settings', settingsRoutes);
  // Distributor network, catalogues, comparison, purchase orders and outstanding.
  app.use('/api/procurement', procurementRoutes);
  // Import Center: Excel/CSV upload, mapping, validation, preview and history.
  app.use('/api/imports', importRoutes);

  app.use('/api', notFoundHandler);
  app.use(errorHandler);

  return app;
}
