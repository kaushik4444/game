'use strict';
const pool = require('./pool');
const { migrate } = require('./migrate');

/**
 * Decide, before the server accepts anybody, whether the database setup is acceptable.
 *
 *  - production without DATABASE_URL            -> throw (never silently fall back to memory with real users)
 *  - DATABASE_URL set but the pg driver missing -> throw in production, warn elsewhere
 *  - DATABASE_URL set                           -> the database must answer and every migration must apply, otherwise throw
 *  - development / tests without DATABASE_URL   -> in-memory store
 *
 * `deps` exists so tests can pass fakes.
 */
async function prepareDatabase(deps = {}) {
  const env = deps.env || process.env;
  const db = deps.db || pool;
  const runMigrations = deps.migrate || migrate;
  const log = deps.log || console;
  const production = env.NODE_ENV === 'production';

  if (!env.DATABASE_URL) {
    if (production) throw new Error('DATABASE_URL is required when NODE_ENV=production (refusing to run on the in-memory store)');
    log.log('[db] No DATABASE_URL set: using the in-memory store (data is lost on restart).');
    return { mode: 'memory' };
  }
  if (db.driverMissing()) {
    const msg = 'DATABASE_URL is set but the "pg" package is not installed';
    if (production) throw new Error(msg);
    log.warn('[db] ' + msg + ': using the in-memory store.');
    return { mode: 'memory' };
  }
  try {
    await db.ping();
  } catch (err) {
    throw new Error('Cannot reach the database: ' + err.message);
  }
  try {
    const res = await runMigrations();
    log.log(`[db] Connected. ${res && res.applied && res.applied.length ? 'Applied ' + res.applied.join(', ') : 'Schema is up to date.'}`);
  } catch (err) {
    throw new Error('Database migration failed: ' + err.message);
  }
  return { mode: 'postgres' };
}

module.exports = { prepareDatabase };
