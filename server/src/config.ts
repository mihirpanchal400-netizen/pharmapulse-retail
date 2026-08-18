import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

// Load .env from the server folder first, then fall back to the repo root.
const serverEnv = path.resolve(__dirname, '..', '.env');
const rootEnv = path.resolve(__dirname, '..', '..', '.env');
if (fs.existsSync(serverEnv)) dotenv.config({ path: serverEnv });
else if (fs.existsSync(rootEnv)) dotenv.config({ path: rootEnv });

const repoRoot = path.resolve(__dirname, '..', '..');

function envStr(key: string, fallback: string): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

const isTest = process.env.NODE_ENV === 'test';

export const config = {
  env: envStr('NODE_ENV', 'development'),
  port: Number(envStr('PORT', '4000')),
  repoRoot,
  databasePath: isTest
    ? ':memory:'
    : path.resolve(repoRoot, envStr('DATABASE_PATH', './database/pharmapulse.db')),
  jwtSecret: envStr('JWT_SECRET', 'pharmapulse-development-secret-do-not-use-in-production'),
  jwtExpiresIn: envStr('JWT_EXPIRES_IN', '12h'),
  clientOrigin: envStr('CLIENT_ORIGIN', 'http://localhost:5173'),
};

/**
 * Analytics thresholds.
 *
 * These are DEFAULTS ONLY. At runtime every value below can be overridden from the
 * `settings` table (Settings screen), so nothing in the analytics engine is hardcoded.
 * See server/src/services/settingsService.ts -> getThresholds().
 */
export const defaultThresholds = {
  /** A batch is "expiring soon" when its expiry date falls within this many days. */
  expiryWarningDays: 90,
  /** Near-term expiry bucket used for the most urgent alerts. */
  expiryCriticalDays: 30,
  /** A product with stock but no sale in this many days counts as dead stock. */
  deadStockDays: 90,
  /** Multiplier applied to reorder_level when deciding LOW STOCK. 1 = exactly at reorder level. */
  lowStockThresholdMultiplier: 1,
  /** Percentage change that makes a sales trend "notable" enough to raise an insight. */
  salesGrowthThresholdPct: 10,
  /** Window (days) used for velocity / growth calculations. */
  analysisWindowDays: 30,
  /** Stock coverage below this many days is treated as a stock-out risk. */
  criticalCoverageDays: 7,
  /** Products above maximum_stock are OVERSTOCKED; this scales that ceiling. */
  overstockMultiplier: 1,
  /** How many products form the "top products" set for revenue concentration. */
  revenueConcentrationTopN: 10,
  /** Inventory Health Score penalty weights (points deducted per unit of problem). */
  healthPenaltyStockoutPerPct: 1.5,
  healthPenaltyExpiryPerPct: 1.0,
  healthPenaltyDeadStockPerPct: 0.8,
  healthPenaltyOverstockPerPct: 0.5,
};

export type Thresholds = typeof defaultThresholds;
