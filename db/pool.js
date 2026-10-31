'use strict';
const fs = require('fs');
const path = require('path');

// Automatically read .env.local or .env into process.env if present
function loadEnv() {
  const root = path.resolve(__dirname, '..');
  const candidates = ['.env.local', '.env'];
  for (const name of candidates) {
    const full = path.join(root, name);
    if (fs.existsSync(full)) {
      try {
        const text = fs.readFileSync(full, 'utf8');
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eq = trimmed.indexOf('=');
          if (eq > 0) {
            const key = trimmed.slice(0, eq).trim();
            let val = trimmed.slice(eq + 1).trim();
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
              val = val.slice(1, -1);
            }
            if (!process.env[key]) {
              process.env[key] = val;
            }
          }
        }
      } catch {
        /* ignore */
      }
    }
  }
}

loadEnv();

let pg;
try {
  pg = require('pg');
} catch {
  // pg is optional; in-memory fallback will be used if pg is not installed
  pg = null;
}

const connectionString = process.env.DATABASE_URL || '';
let pool = null;

if (connectionString && pg) {
  // Neon DATABASE_URL already includes sslmode=require.
  // Let the pg library parse the connection string and handle SSL automatically.
  // For local connections without SSL in the URL, ssl will be undefined (no SSL).
  const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString) || /[?&]host=\//.test(connectionString);
  const hasSslMode = /[?&]sslmode=/.test(connectionString);
  pool = new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000, // a stuck query must not hang a player's connection forever
    // In production never talk to a remote database in plaintext, even if the URL forgot ?sslmode=require
    ...(process.env.NODE_ENV === 'production' && !isLocal && !hasSslMode ? { ssl: { rejectUnauthorized: true } } : {}),
  });

  pool.on('error', (err) => {
    console.error('[db] Unexpected pool error on idle client:', err.message);
  });
}

/**
 * Returns true if a live PostgreSQL connection pool is configured.
 */
function hasDatabase() {
  return pool !== null;
}

/** True if DATABASE_URL is set but the `pg` driver could not be loaded (a broken install, not a choice). */
function driverMissing() {
  return Boolean(connectionString) && !pg;
}

/** Round-trip to the database; rejects if it cannot be reached. */
async function ping() {
  if (!pool) throw new Error('Database is not configured. Set DATABASE_URL.');
  await pool.query('SELECT 1');
}

/**
 * Execute a query with parameters against the pool.
 */
async function query(text, params) {
  if (!pool) throw new Error('Database is not configured. Set DATABASE_URL.');
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  if (process.env.DEBUG_SQL) {
    console.log('[db]', { text, duration, rows: res.rowCount });
  }
  return res;
}

/**
 * Execute a function within a database transaction.
 */
async function withTransaction(fn) {
  if (!pool) throw new Error('Database is not configured. Set DATABASE_URL.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[db] ROLLBACK failed:', rollbackErr.message); // keep the original error
    }
    throw err;
  } finally {
    client.release();
  }
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = {
  hasDatabase,
  driverMissing,
  ping,
  query,
  withTransaction,
  close,
  getPool: () => pool,
};
