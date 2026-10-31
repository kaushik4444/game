'use strict';
/**
 * PostgreSQL for tests. Opt-in and sandboxed:
 *
 *  - Needs TEST_DATABASE_URL (a server where we may CREATE DATABASE). DATABASE_URL is never used by tests.
 *  - Refuses anything that looks like a real deployment: managed hosts (neon.tech, supabase.co, render.com, amazonaws.com ...),
 *    the same host as the DATABASE_URL in the environment or in .env / .env.local, and any non-local host unless
 *    ALLOW_REMOTE_TEST_DB=1 is set (and even then never the managed hosts above).
 *  - Every run creates its own throw-away database (tv_test_<random>) and drops it afterwards, so tests cannot see or
 *    change existing data, and parallel runs do not collide.
 *
 * Usage in a test file:  require('./helpers/env'); const t = await require('./helpers/testdb').create(); process.env.DATABASE_URL = t.url; ...
 * Without TEST_DATABASE_URL a test prints SKIPPED and exits 0 (`npm test`); with --require (`npm run test:pg`) it fails instead.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const MANAGED = /(neon\.tech|supabase\.co|supabase\.com|render\.com|amazonaws\.com|azure\.com|googleusercontent\.com|herokuapp\.com|elephantsql\.com|aivencloud\.com)$/i;

function dotenvUrls() {
  const out = [];
  for (const f of ['.env', '.env.local']) {
    try {
      const m = /^\s*DATABASE_URL\s*=\s*(.+?)\s*$/m.exec(fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8'));
      if (m) out.push(m[1].replace(/^["']|["']$/g, ''));
    } catch { /* no such file */ }
  }
  return out;
}

function assertSafe(url, env = process.env) {
  let u;
  try { u = new URL(url); } catch { throw new Error('TEST_DATABASE_URL is not a valid URL'); }
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error('TEST_DATABASE_URL must be a postgres:// URL');
  if (MANAGED.test(u.hostname)) throw new Error(`refusing TEST_DATABASE_URL on a managed/production host (${u.hostname}): tests only run on a local or dedicated test server`);
  for (const real of [env.TV_ORIGINAL_DATABASE_URL, env.DATABASE_URL, ...dotenvUrls()].filter(Boolean)) {
    let r;
    try { r = new URL(real); } catch { continue; }
    if (r.hostname === u.hostname && r.port === u.port && !LOOPBACK.has(u.hostname)) throw new Error('refusing TEST_DATABASE_URL: it points at the same server as DATABASE_URL');
  }
  if (!LOOPBACK.has(u.hostname) && env.ALLOW_REMOTE_TEST_DB !== '1') throw new Error('refusing a non-local TEST_DATABASE_URL (set ALLOW_REMOTE_TEST_DB=1 if this is a dedicated test server)');
  return u;
}

/** Returns { url, name, admin(), drop() } for a fresh database, or null when PostgreSQL tests are not configured (after printing why). */
async function create() {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) {
    if (process.argv.includes('--require')) {
      console.error('FAIL  TEST_DATABASE_URL is not set; PostgreSQL tests were required (e.g. postgres://postgres@127.0.0.1:5432/postgres)');
      process.exit(1);
    }
    console.log('SKIPPED  PostgreSQL tests: set TEST_DATABASE_URL to run them (see README, "Testing")');
    process.exit(0);
  }
  const u = assertSafe(base);
  const pg = require('pg');
  const name = 'tv_test_' + crypto.randomBytes(6).toString('hex');
  const maint = new pg.Client({ connectionString: base });
  await maint.connect();
  try { await maint.query(`CREATE DATABASE ${name}`); } finally { await maint.end(); }
  const dbUrl = new URL(base);
  dbUrl.pathname = '/' + name;
  const url = dbUrl.toString();
  const opened = [];
  return {
    url,
    name,
    /** A separate connection for the test itself (inspect rows, break things on purpose). */
    async client() {
      const c = new pg.Client({ connectionString: url });
      await c.connect();
      opened.push(c);
      return c;
    },
    /** A second fresh database on the same server (for migration upgrade tests). */
    async another() {
      const n = 'tv_test_' + crypto.randomBytes(6).toString('hex');
      const m = new pg.Client({ connectionString: base });
      await m.connect();
      try { await m.query(`CREATE DATABASE ${n}`); } finally { await m.end(); }
      const x = new URL(base);
      x.pathname = '/' + n;
      return { name: n, url: x.toString() };
    },
    async drop(...extra) {
      for (const c of opened) await c.end().catch(() => {});
      const m = new pg.Client({ connectionString: base });
      await m.connect();
      try {
        for (const n of [name, ...extra]) await m.query(`DROP DATABASE IF EXISTS ${n} WITH (FORCE)`);
      } finally { await m.end(); }
    },
  };
}

module.exports = { create, assertSafe };
