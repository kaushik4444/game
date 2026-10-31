'use strict';
/**
 * One-off removal of ALL user and gameplay data, keeping the schema and the migration history.
 *
 * This module only builds and runs the plan; scripts/cleanup-user-data.js is the command line around it.
 *
 * Safety properties (each one is covered by tests/cleanup.test.js or tests/cleanup.pg.test.js):
 *  - Dry run is the default and runs inside a READ ONLY transaction that is always rolled back.
 *  - Deleting needs the explicit execute option AND a confirmation equal to the database name.
 *  - The target must be named in CLEANUP_DATABASE_URL (never DATABASE_URL), and a remote host must be named again
 *    with --expect-host, so a pasted wrong URL is refused.
 *  - The database must look exactly as the repository expects: the same tables, the same foreign keys, no triggers, and
 *    exactly the migrations in db/migrations applied. Anything else (a table nobody classified, a missing migration) is
 *    refused instead of ignored.
 *  - Rows are deleted table by table, children before parents, never with TRUNCATE or CASCADE. Every DELETE must remove
 *    exactly the rows that were counted under lock, and the other tables must be unchanged afterwards (so a hidden
 *    cascade is detected).
 *  - Everything happens in one transaction. Any error, mismatch or failed check rolls it back.
 *  - The schema (tables, columns, indexes, constraints, triggers) and schema_migrations are fingerprinted before and
 *    after; a difference rolls back. Nothing here issues DDL.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** Tables to empty, in the order they are deleted: every table appears before the tables it references. */
const PLAN = [
  { table: 'match_participants', stores: 'Per-player result rows of finished games (name, seat, score, winner/bot/left-early flags, optional account id)', references: ['matches', 'players'] },
  { table: 'matches', stores: 'Finished games (game, room code, seats, options, time, idempotency key)', references: [] },
  { table: 'auth_email_tokens', stores: 'Hashed single-use email verification and password-reset tokens with the address they were sent to', references: ['players'] },
  { table: 'auth_sessions', stores: 'Hashed session tokens (registered and legacy anonymous), expiry and revocation', references: ['players'] },
  { table: 'auth_identities', stores: 'Login methods: email address, Argon2 password hash, verification time', references: ['players'] },
  { table: 'auth_rate_limits', stores: 'Hashed per-address / per-email rate-limit counters', references: [] },
  { table: 'players', stores: 'Accounts: registered players and legacy anonymous players (username, display name, avatar, timestamps)', references: [] },
];
const PRESERVE = [
  { table: 'schema_migrations', stores: 'Migration history: which db/migrations files were applied (the application checks it on every start)' },
];
const CLEAN_TABLES = PLAN.map((p) => p.table);
const KNOWN_TABLES = [...CLEAN_TABLES, ...PRESERVE.map((p) => p.table)].sort();

/** The only foreign keys the application schema has. A different set means the schema changed and this plan needs a review. */
const EXPECTED_FKS = [
  { child: 'auth_email_tokens', parent: 'players', onDelete: 'CASCADE' },
  { child: 'auth_identities', parent: 'players', onDelete: 'CASCADE' },
  { child: 'auth_sessions', parent: 'players', onDelete: 'CASCADE' },
  { child: 'match_participants', parent: 'matches', onDelete: 'CASCADE' },
  { child: 'match_participants', parent: 'players', onDelete: 'SET NULL' },
];
const ON_DELETE = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };
const MIGRATION_LOCK_KEY = 727274; // the advisory lock db/migrate.js holds while migrating
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

class RefusedError extends Error {
  constructor(message) { super(message); this.name = 'RefusedError'; }
}

const quoteIdent = (name) => {
  if (!KNOWN_TABLES.includes(name)) throw new RefusedError(`internal error: "${name}" is not a classified table`);
  return `public."${name}"`;
};
const sha = (value) => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

// ------------------------------------------------------------------------------------------------ target and guards
function parseTarget(url) {
  let u;
  try { u = new URL(url); } catch { throw new RefusedError('CLEANUP_DATABASE_URL is not a valid URL'); }
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new RefusedError('CLEANUP_DATABASE_URL must be a postgres:// or postgresql:// URL');
  const socket = /[?&]host=\//.test(url);
  const database = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (!database) throw new RefusedError('CLEANUP_DATABASE_URL has no database name');
  return {
    host: socket ? '(unix socket)' : u.hostname.toLowerCase(),
    port: u.port || '5432',
    database,
    user: decodeURIComponent(u.username || ''),
    isLocal: socket || LOCAL_HOSTS.has(u.hostname.toLowerCase()),
    hasSslMode: /[?&]sslmode=/.test(url),
    sslMode: new URLSearchParams(u.search).get('sslmode'),
  };
}

/** Rules that need no connection. Throws RefusedError. */
function checkTarget(target, { expectHost, expectDb, execute, confirm }) {
  if (!target.isLocal) {
    if (!expectHost) throw new RefusedError(`the target host is remote (${target.host}): repeat it with --expect-host=${target.host} to show this is the database you mean`);
  }
  if (expectHost && expectHost.toLowerCase() !== target.host) throw new RefusedError(`--expect-host=${expectHost} does not match the host in CLEANUP_DATABASE_URL (${target.host})`);
  if (expectDb && expectDb !== target.database) throw new RefusedError(`--expect-db=${expectDb} does not match the database in CLEANUP_DATABASE_URL (${target.database})`);
  if (execute) {
    if (!confirm) throw new RefusedError(`refusing to delete without confirmation: add --confirm=${target.database} (the exact database name) to --execute`);
    if (confirm !== target.database) throw new RefusedError(`--confirm="${confirm}" does not equal the database name "${target.database}": nothing was changed`);
  }
}

// ------------------------------------------------------------------------------------------------ schema inspection
function repoMigrations(dir = path.join(__dirname, 'migrations')) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
}

async function discover(client) {
  const q = async (sql) => (await client.query(sql)).rows;
  const tables = (await q(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                           WHERE n.nspname = 'public' AND c.relkind IN ('r','p') ORDER BY 1`)).map((r) => r.relname);
  const views = (await q(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                          WHERE n.nspname = 'public' AND c.relkind IN ('v','m') ORDER BY 1`)).map((r) => r.relname);
  const sequences = (await q(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                              WHERE n.nspname = 'public' AND c.relkind = 'S' ORDER BY 1`)).map((r) => r.relname);
  const functions = (await q(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                              WHERE n.nspname = 'public' ORDER BY 1`)).map((r) => r.proname);
  const foreignSchemas = (await q(`SELECT DISTINCT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                                   WHERE c.relkind IN ('r','p','v','m','S') AND n.nspname NOT IN ('public','information_schema') AND n.nspname NOT LIKE 'pg\\_%'`)).map((r) => r.nspname);
  const fks = (await q(`SELECT con.conname, child.relname AS child, parent.relname AS parent, con.confdeltype AS on_delete
                        FROM pg_constraint con
                        JOIN pg_class child ON child.oid = con.conrelid JOIN pg_class parent ON parent.oid = con.confrelid
                        JOIN pg_namespace n ON n.oid = child.relnamespace
                        WHERE con.contype = 'f' AND n.nspname = 'public' ORDER BY 2, 3, 1`))
    .map((r) => ({ name: r.conname, child: r.child, parent: r.parent, onDelete: ON_DELETE[r.on_delete] || r.on_delete }));
  const triggers = (await q(`SELECT c.relname AS tbl, t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                             JOIN pg_namespace n ON n.oid = c.relnamespace WHERE NOT t.tgisinternal AND n.nspname = 'public' ORDER BY 1, 2`));
  const applied = tables.includes('schema_migrations') ? (await client.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r) => r.version) : [];
  return { tables, views, sequences, functions, foreignSchemas, fks, triggers, applied };
}

/** Fingerprint of everything that must not change: structure and migration history. Contains no user data. */
async function fingerprint(client) {
  const q = async (sql) => (await client.query(sql)).rows;
  const structure = {
    columns: await q(`SELECT table_name, column_name, ordinal_position, data_type, is_nullable, column_default
                      FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1, 3`),
    indexes: await q("SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1, 2"),
    constraints: await q(`SELECT c.relname AS tbl, con.conname, con.contype, pg_get_constraintdef(con.oid) AS def
                          FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
                          WHERE n.nspname = 'public' ORDER BY 1, 2`),
    triggers: await q(`SELECT c.relname AS tbl, t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                       JOIN pg_namespace n ON n.oid = c.relnamespace WHERE NOT t.tgisinternal AND n.nspname = 'public' ORDER BY 1, 2`),
  };
  const migrations = await q('SELECT version, applied_at FROM schema_migrations ORDER BY version');
  return {
    structureDigest: sha(structure),
    migrationsDigest: sha(migrations.map((m) => [m.version, new Date(m.applied_at).toISOString()])),
    counts: { columns: structure.columns.length, indexes: structure.indexes.length, constraints: structure.constraints.length, tables: new Set(structure.columns.map((c) => c.table_name)).size },
    migrations: migrations.map((m) => m.version),
  };
}

/** Is `order` safe for these foreign keys? A table must be deleted before any table it references. */
function validateOrder(order, fks) {
  const pos = new Map(order.map((t, i) => [t, i]));
  for (const fk of fks) {
    if (!pos.has(fk.child) || !pos.has(fk.parent)) continue;
    if (pos.get(fk.child) > pos.get(fk.parent)) {
      throw new RefusedError(`unsafe deletion order: "${fk.child}" references "${fk.parent}" (${fk.name}) but would be deleted after it`);
    }
  }
}

/** Compare what the database contains with what this plan was written for. Throws RefusedError listing every difference. */
function checkSchema(found, { migrationFiles = repoMigrations(), order = CLEAN_TABLES } = {}) {
  const problems = [];
  const unknown = found.tables.filter((t) => !KNOWN_TABLES.includes(t));
  const missing = KNOWN_TABLES.filter((t) => !found.tables.includes(t));
  if (unknown.length) problems.push(`unclassified table(s) ${unknown.join(', ')}: they may hold user data, so this script refuses to guess (add them to the plan in db/cleanup.js, with a test)`);
  if (missing.length) problems.push(`expected table(s) missing: ${missing.join(', ')}`);
  if (found.foreignSchemas.length) problems.push(`tables exist in other schema(s): ${found.foreignSchemas.join(', ')}`);

  const want = EXPECTED_FKS.map((f) => `${f.child}>${f.parent}:${f.onDelete}`).sort();
  const have = found.fks.map((f) => `${f.child}>${f.parent}:${f.onDelete}`).sort();
  const extraFks = have.filter((f) => !want.includes(f)); const lostFks = want.filter((f) => !have.includes(f));
  if (extraFks.length) problems.push(`unexpected foreign key(s): ${extraFks.join(', ')}`);
  if (lostFks.length) problems.push(`expected foreign key(s) missing: ${lostFks.join(', ')}`);
  for (const fk of found.fks) {
    if (PRESERVE.some((p) => p.table === fk.child) && CLEAN_TABLES.includes(fk.parent)) problems.push(`the preserved table "${fk.child}" references "${fk.parent}", which would be emptied`);
  }
  if (found.views && found.views.length) problems.push(`unexpected view(s): ${found.views.join(', ')}`);
  if (found.sequences && found.sequences.length) problems.push(`unexpected sequence(s): ${found.sequences.join(', ')}`);
  if (found.functions && found.functions.length) {
    const customFns = found.functions.filter((fn) => !['gen_random_uuid', 'uuid_generate_v4'].includes(fn));
    if (customFns.length) problems.push(`unexpected function(s): ${customFns.join(', ')}`);
  }
  if (found.triggers && found.triggers.length) problems.push(`trigger(s) on ${found.triggers.map((t) => t.tbl + '.' + t.tgname).join(', ')}: a trigger could change other data during the deletes`);


  const appliedSet = new Set(found.applied); const repoSet = new Set(migrationFiles);
  const notApplied = migrationFiles.filter((m) => !appliedSet.has(m)); const notInRepo = found.applied.filter((m) => !repoSet.has(m));
  if (notApplied.length) problems.push(`migration(s) in the repository but not applied to this database: ${notApplied.join(', ')} (deploy or run the migrations first)`);
  if (notInRepo.length) problems.push(`migration(s) applied to this database but unknown to this code version: ${notInRepo.join(', ')} (run this script from the deployed version)`);

  if (!problems.length) {
    try { validateOrder(order, found.fks); } catch (e) { problems.push(e.message); }
  }
  if (problems.length) throw new RefusedError('this database is not in the state the cleanup plan expects:\n  - ' + problems.join('\n  - '));
}

// ------------------------------------------------------------------------------------------------ reporting data
const mask = (email) => {
  const s = String(email || ''); const at = s.indexOf('@');
  return at < 1 ? '***' : `${s[0]}***${s.slice(at)}`;
};

async function counts(client, tables = CLEAN_TABLES) {
  const out = {};
  for (const t of tables) out[t] = (await client.query(`SELECT count(*)::int AS n FROM ${quoteIdent(t)}`)).rows[0].n;
  return out;
}

const SAMPLE_SQL = {
  players: 'SELECT id, username, display_name, is_anonymous, created_at, last_seen_at FROM public."players" ORDER BY created_at LIMIT $1',
  auth_identities: 'SELECT player_id, provider, email, (email_verified_at IS NOT NULL) AS verified, created_at FROM public."auth_identities" ORDER BY created_at LIMIT $1',
  auth_sessions: 'SELECT player_id, created_at, expires_at, (revoked_at IS NOT NULL) AS revoked FROM public."auth_sessions" ORDER BY created_at LIMIT $1', // never the token hash
  auth_email_tokens: 'SELECT player_id, purpose, expires_at, (used_at IS NOT NULL) AS used FROM public."auth_email_tokens" ORDER BY created_at LIMIT $1',
  auth_rate_limits: 'SELECT scope, left(key, 8) AS key_prefix, count, window_start FROM public."auth_rate_limits" ORDER BY window_start LIMIT $1',
  matches: 'SELECT id, game_id, room_code, seats, finished_at FROM public."matches" ORDER BY finished_at LIMIT $1',
  match_participants: 'SELECT match_id, player_name, seat, score, is_winner, is_bot, left_early, (player_id IS NOT NULL) AS has_account FROM public."match_participants" ORDER BY match_id, seat LIMIT $1',
};

async function samples(client, n) {
  const out = {};
  if (!n) return out;
  for (const t of CLEAN_TABLES) {
    const rows = (await client.query(SAMPLE_SQL[t], [n])).rows;
    out[t] = rows.map((r) => (r.email !== undefined ? { ...r, email: mask(r.email) } : r));
  }
  return out;
}

async function breakdowns(client) {
  const one = async (sql) => (await client.query(sql)).rows;
  const p = (await one("SELECT count(*) FILTER (WHERE is_anonymous)::int AS anonymous, count(*) FILTER (WHERE NOT is_anonymous)::int AS registered FROM public.\"players\""))[0];
  const g = await one('SELECT game_id, count(*)::int AS matches FROM public."matches" GROUP BY game_id ORDER BY game_id');
  const m = (await one(`SELECT count(*) FILTER (WHERE is_bot)::int AS bots, count(*) FILTER (WHERE NOT is_bot AND player_id IS NOT NULL)::int AS linked_humans,
                               count(*) FILTER (WHERE NOT is_bot AND player_id IS NULL)::int AS unlinked_humans FROM public."match_participants"`))[0];
  return { players: p, matchesByGame: g, participants: m };
}

// ------------------------------------------------------------------------------------------------ connection
async function connect(url, target, pg = require('pg')) {
  if (!target.isLocal && target.sslMode !== 'verify-full' && target.sslMode !== 'verify-ca' && target.sslMode !== 'require') {
     throw new RefusedError('remote database connection MUST use sslmode=verify-full, verify-ca or require');
  }
  const client = new pg.Client({
    connectionString: url,
    application_name: 'tableverse-cleanup',
    connectionTimeoutMillis: 10000,
    // a remote database is never reached in plaintext
    ...(target.isLocal ? {} : { ssl: { rejectUnauthorized: true } }),
  });
  client.on('error', () => {}); // a dropped idle connection must not crash the script; the pending query reports it
  await client.connect();
  return client;
}

// ------------------------------------------------------------------------------------------------ the run
/**
 * @param {object} o
 * @param {string} o.url            CLEANUP_DATABASE_URL
 * @param {boolean} [o.execute]     false (default): dry run
 * @param {string} [o.confirm]      must equal the database name when executing
 * @param {string} [o.expectHost]
 * @param {string} [o.expectDb]
 * @param {number} [o.sample]       rows to show per table (default 5, 0 = none)
 * @param {object} [o.hooks]        test hooks: afterDelete(table), beforeCommit()
 * @param {number} [o.lockTimeoutMs]
 * @returns {Promise<object>} report
 */
async function run(o) {
  const { url, execute = false, confirm, expectHost, expectDb, sample = 5, hooks = {}, lockTimeoutMs = 10000, order = CLEAN_TABLES } = o;
  const target = parseTarget(url);
  checkTarget(target, { expectHost, expectDb, execute, confirm });
  const client = await connect(url, target, o.pg);
  const report = { mode: execute ? 'execute' : 'dry-run', target: { host: target.host, port: target.port, database: target.database, user: target.user, local: target.isLocal }, committed: false };
  let began = false;
  try {
    await client.query(execute ? 'BEGIN' : 'BEGIN READ ONLY');
    began = true;
    await client.query(`SET LOCAL lock_timeout = '${Math.max(100, Math.floor(lockTimeoutMs))}ms'`);
    await client.query("SET LOCAL statement_timeout = '300s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '120s'");

    const who = (await client.query('SELECT current_database() AS db, current_user AS usr, current_setting(\'server_version\') AS version')).rows[0];
    if (who.db !== target.database) throw new RefusedError(`connected to "${who.db}" but the URL names "${target.database}"`);
    report.server = { database: who.db, user: who.usr, version: who.version };

    const lock = (await client.query('SELECT pg_try_advisory_xact_lock($1) AS ok', [MIGRATION_LOCK_KEY])).rows[0].ok;
    if (!lock) throw new RefusedError('a migration is running on this database right now (advisory lock is held); try again later');

    const found = await discover(client);
    checkSchema(found, { order });
    report.migrations = found.applied;
    report.foreignKeys = found.fks;
    report.order = order;
    report.preserved = PRESERVE.map((p) => p.table);

    if (execute) for (const t of order) await client.query(`LOCK TABLE ${quoteIdent(t)} IN SHARE ROW EXCLUSIVE MODE`); // no writer can slip in between counting and deleting
    const before = await counts(client, order);
    const finger = await fingerprint(client);
    report.before = before;
    report.totalRows = Object.values(before).reduce((a, b) => a + b, 0);
    report.fingerprint = finger;
    report.preservedCounts = { schema_migrations: found.applied.length };
    report.breakdowns = await breakdowns(client);
    report.samples = await samples(client, sample);

    if (!execute) {
      await client.query('ROLLBACK');
      began = false;
      report.committed = false;
      return report;
    }

    // ---- execute: dependency-aware, one table at a time, each delete checked against the count taken under lock
    report.deleted = {};
    for (const t of order) {
      const res = await client.query(`DELETE FROM ${quoteIdent(t)}`);
      if (res.rowCount !== before[t]) throw new Error(`deleted ${res.rowCount} rows from ${t} but counted ${before[t]} under lock: aborting`);
      report.deleted[t] = res.rowCount;
      if (hooks.afterDelete) await hooks.afterDelete(t);
      const now = await counts(client, order);
      for (const other of order) {
        if (order.indexOf(other) <= order.indexOf(t)) { if (now[other] !== 0) throw new Error(`${other} is not empty after its own delete (${now[other]} rows)`); continue; }
        if (now[other] !== before[other]) throw new Error(`deleting ${t} changed ${other} (${before[other]} -> ${now[other]}): an unexpected cascade, aborting`);
      }
    }
    const after = await counts(client, order);
    const empty = order.filter((t) => after[t] !== 0);
    if (empty.length) throw new Error(`tables still hold rows after the cleanup: ${empty.join(', ')}`);
    const finger2 = await fingerprint(client);
    if (finger2.structureDigest !== finger.structureDigest) throw new Error('the schema fingerprint changed during the cleanup: aborting');
    if (finger2.migrationsDigest !== finger.migrationsDigest) throw new Error('schema_migrations changed during the cleanup: aborting');
    if (hooks.beforeCommit) await hooks.beforeCommit();
    await client.query('COMMIT');
    began = false;
    report.after = after;
    report.committed = true;
    return report;
  } catch (err) {
    if (began) { try { await client.query('ROLLBACK'); report.rolledBack = true; } catch { report.rolledBack = false; } }
    err.report = report;
    throw err;
  } finally {
    await client.end().catch(() => {});
  }
}

// ------------------------------------------------------------------------------------------------ verification (read only)
/**
 * Checks after an execution (also safe at any time): every targeted table is empty, the migration history and the
 * schema are what they were, and the application's read paths work. `snapshot` is the JSON a previous run wrote.
 */
async function verify({ url, expectHost, expectDb, snapshot = null, appSmoke = true, pg }) {
  const target = parseTarget(url);
  checkTarget(target, { expectHost, expectDb, execute: false });
  const client = await connect(url, target, pg);
  const checks = [];
  const check = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail });
  try {
    await client.query('BEGIN READ ONLY');
    const found = await discover(client);
    let schemaOk = true; let schemaDetail = '';
    try { checkSchema(found); } catch (e) { schemaOk = false; schemaDetail = e.message; }
    check('database has exactly the expected tables, foreign keys, no triggers, and the migrations of this code version', schemaOk, schemaDetail);

    const c = await counts(client, CLEAN_TABLES.filter((t) => found.tables.includes(t)));
    for (const t of CLEAN_TABLES) check(`${t} is empty`, c[t] === 0, c[t] === undefined ? 'table missing' : `${c[t]} rows`);
    const anon = found.tables.includes('players') ? (await client.query('SELECT count(*)::int AS n FROM public."players" WHERE is_anonymous')).rows[0].n : -1;
    check('no legacy anonymous players remain', anon === 0, `${anon} rows`);

    const hasMigrations = found.tables.includes('schema_migrations');
    const f = hasMigrations ? await fingerprint(client) : { migrations: [], structureDigest: '', migrationsDigest: '', counts: {} };
    if (!hasMigrations) check('schema_migrations exists', false, 'table missing');
    check('migration history lists exactly the repository migrations', JSON.stringify(f.migrations) === JSON.stringify(repoMigrations()), f.migrations.join(', '));
    const haveFks = new Set(found.fks.map((x) => `${x.child}>${x.parent}:${x.onDelete}`));
    for (const e of EXPECTED_FKS) check(`foreign key ${e.child} -> ${e.parent} (${e.onDelete}) exists`, haveFks.has(`${e.child}>${e.parent}:${e.onDelete}`));
    if (snapshot) {
      check('schema fingerprint equals the snapshot taken before the cleanup (tables, columns, indexes, constraints)', f.structureDigest === snapshot.fingerprint.structureDigest, `${f.counts.tables} tables, ${f.counts.indexes} indexes, ${f.counts.constraints} constraints`);
      check('schema_migrations is byte-identical to the snapshot (versions and applied_at)', f.migrationsDigest === snapshot.fingerprint.migrationsDigest);
    } else {
      check('schema fingerprint comparison skipped (no --snapshot given): only the structural checks ran', true);
    }
    await client.query('ROLLBACK');
  } finally {
    await client.end().catch(() => {});
  }

  if (appSmoke) {
    // The application's own read paths, through its own modules, on this database. Read-only queries only.
    const saved = { url: process.env.DATABASE_URL, skip: process.env.TABLEVERSE_SKIP_DOTENV };
    try {
      process.env.DATABASE_URL = url; process.env.TABLEVERSE_SKIP_DOTENV = '1';
      for (const m of ['./pool', './players', './rateLimit', './stats', './matches', './auth']) delete require.cache[require.resolve(m)]; // fresh modules bound to this database
      const dbPool = require('./pool'); const dbMatches = require('./matches'); const dbAuth = require('./auth');
      const uuid = '00000000-0000-4000-8000-000000000000';
      const stats = await dbMatches.getPlayerStats(uuid);
      check('app: player stats query works', stats && stats.played === 0, JSON.stringify(stats));
      const free = await dbAuth.checkUsernameAvailability({ username: 'cleanup_probe_user' });
      check('app: username lookup works and finds nobody', free.available === true);
      check('app: session lookup works and finds nobody', (await dbAuth.readSessionFromCookie('not-a-session')) === null);
      await dbPool.close();
    } catch (e) {
      check('app: read paths work', false, e.message);
    } finally {
      if (saved.url === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved.url;
      if (saved.skip === undefined) delete process.env.TABLEVERSE_SKIP_DOTENV; else process.env.TABLEVERSE_SKIP_DOTENV = saved.skip;
    }
  }
  return { target: { host: target.host, database: target.database }, ok: checks.every((c) => c.ok), checks };
}

// ------------------------------------------------------------------------------------------------ text output
function formatReport(r) {
  const L = [];
  const pad = (s, n) => String(s).padEnd(n);
  const head = r.mode === 'execute' ? 'EXECUTE' : 'DRY RUN (read-only; nothing will be changed)';
  L.push(`Tableverse user-data cleanup: ${head}`);
  L.push(`Target     : database "${r.target.database}" on ${r.target.host}:${r.target.port} as ${r.target.user || '(default user)'} (${r.target.local ? 'local' : 'remote'})`);
  if (r.server) L.push(`Connected  : current_database() = ${r.server.database}, PostgreSQL ${r.server.version}`);
  if (r.migrations) L.push(`Migrations : ${r.migrations.length} applied, identical to db/migrations (${r.migrations.join(', ')})`);
  if (r.foreignKeys) L.push(`Schema     : ${r.fingerprint.counts.tables} tables, ${r.fingerprint.counts.indexes} indexes, ${r.fingerprint.counts.constraints} constraints, ${r.foreignKeys.length} foreign keys, no triggers; every table is classified`);
  L.push('');
  L.push(`${pad('#', 3)}${pad('table', 22)}${pad('rows', 9)}${r.deleted ? pad('deleted', 9) : ''}what it stores`);
  r.order.forEach((t, i) => {
    const plan = PLAN.find((p) => p.table === t);
    L.push(`${pad(i + 1, 3)}${pad(t, 22)}${pad(r.before[t], 9)}${r.deleted ? pad(r.deleted[t] ?? '-', 9) : ''}${plan ? plan.stores : ''}`);
  });
  L.push(`${pad('', 3)}${pad('TOTAL', 22)}${pad(r.totalRows, 9)}`);
  L.push('');
  L.push(`Preserved  : ${r.preserved.join(', ')} (${r.preservedCounts.schema_migrations} rows, untouched); all tables, indexes, constraints and foreign keys stay`);
  if (r.breakdowns) {
    const b = r.breakdowns;
    L.push('');
    L.push(`Players    : ${b.players.registered} registered, ${b.players.anonymous} legacy anonymous`);
    L.push(`Matches    : ${b.matchesByGame.length ? b.matchesByGame.map((g) => `${g.game_id} ${g.matches}`).join(', ') : 'none'}`);
    L.push(`Results    : ${b.participants.linked_humans} rows linked to an account, ${b.participants.unlinked_humans} human rows without account, ${b.participants.bots} bot rows`);
  }
  if (r.samples && Object.keys(r.samples).length) {
    L.push('');
    L.push('Sample of the records that would be deleted (emails masked, token hashes never shown):');
    for (const t of r.order) {
      const rows = r.samples[t] || [];
      L.push(`  ${t} (${r.before[t]} rows${rows.length < r.before[t] ? `, first ${rows.length}` : ''})`);
      for (const row of rows) L.push('    ' + JSON.stringify(row));
    }
  }
  L.push('');
  if (r.mode === 'dry-run') L.push(`Result     : would delete ${r.totalRows} rows from ${r.order.length} tables. Nothing was changed (the read-only transaction was rolled back).`);
  else if (r.committed) L.push(`Result     : COMMITTED. Deleted ${Object.values(r.deleted).reduce((a, b) => a + b, 0)} rows from ${r.order.length} tables; schema and migration history verified unchanged inside the transaction.`);
  return L.join('\n');
}

module.exports = { PLAN, PRESERVE, CLEAN_TABLES, KNOWN_TABLES, EXPECTED_FKS, RefusedError, parseTarget, checkTarget, checkSchema, validateOrder, repoMigrations, discover, fingerprint, counts, run, verify, formatReport, mask };
