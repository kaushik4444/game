'use strict';
require('./helpers/env');
// The cleanup on a REAL PostgreSQL, in throw-away databases created by tests/helpers/testdb.js. Nothing here can reach
// DATABASE_URL, Neon or any real data. Runs only with TEST_DATABASE_URL (see README, "Testing").
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const testdb = require('./helpers/testdb');
const WebSocket = require('ws');
const { Browser } = require('./helpers/auth');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n' + e.stack); process.exitCode = 1; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, ms = 15000) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + label); await sleep(20); }
}

/** A WebSocket that authenticates with the session cookie only (hello carries no token), as a browser does. */
function cookieSocket(port, cookie) {
  const c = { msgs: [], ws: new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } }) };
  c.ws.on('open', () => c.ws.send(JSON.stringify({ t: 'hello' })));
  c.ws.on('message', (raw) => c.msgs.push(JSON.parse(raw)));
  c.welcome = () => c.msgs.find((m) => m.t === 'welcome');
  return c;
}

(async () => {
  const t = await testdb.create();
  const spool = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-cleanspool-'));
  process.env.MATCH_SPOOL_DIR = spool;
  const snapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-cleansnap-'));
  try {
    process.env.DATABASE_URL = t.url;
    const dbPool = require('../db/pool');
    await require('../db/migrate').migrate();
    const cleanup = require('../db/cleanup');
    const { start } = require('../server');
    const x = await t.client();
    const q = async (sql, params) => (await x.query(sql, params)).rows;
    const ALL = cleanup.KNOWN_TABLES;

    /** md5 of the full content of every table: equal before and after means nothing was written. */
    async function dump() {
      const out = {};
      for (const tbl of ALL) out[tbl] = (await q(`SELECT count(*)::int AS n, md5(coalesce(string_agg(r::text, '|' ORDER BY r::text), '')) AS h FROM public."${tbl}" r`))[0];
      return out;
    }
    const rows = async (tbl) => (await q(`SELECT count(*)::int AS n FROM public."${tbl}"`))[0].n;

    /** A realistic mix: registered and legacy anonymous players, sessions of both, tokens, limits, matches with bots and leavers. */
    async function seed() {
      const reg = []; const anon = [];
      for (const [name, user] of [['Ada', 'ada_x'], ['Bo', 'bo_y']]) reg.push((await q("INSERT INTO players (username, display_name, is_anonymous) VALUES ($1,$2,FALSE) RETURNING id", [user, name]))[0].id);
      for (const name of ['Guest1', 'Guest2', 'Guest3']) anon.push((await q("INSERT INTO players (display_name, is_anonymous) VALUES ($1, TRUE) RETURNING id", [name]))[0].id);
      await q("INSERT INTO auth_identities (player_id, provider, provider_user_id, email, password_hash, email_verified_at) VALUES ($1,'email','ada@example.com','ada@example.com','$argon2id$fake', NOW()), ($2,'email','bo@example.com','bo@example.com','$argon2id$fake', NULL)", reg);
      await q("INSERT INTO auth_sessions (player_id, token_hash, expires_at) VALUES ($1, repeat('a',64), NOW() + INTERVAL '5 days'), ($1, repeat('b',64), NOW() - INTERVAL '1 day'), ($2, repeat('c',64), NULL), ($3, repeat('d',64), NULL)", [reg[0], anon[0], anon[1]]);
      await q("UPDATE auth_sessions SET revoked_at = NOW() WHERE token_hash = repeat('b',64)");
      await q("INSERT INTO auth_email_tokens (player_id, purpose, email, token_hash, expires_at) VALUES ($1,'verify_email','bo@example.com', repeat('e',64), NOW() + INTERVAL '1 day'), ($1,'password_reset','bo@example.com', repeat('f',64), NOW() - INTERVAL '1 day')", [reg[1]]);
      await q("INSERT INTO auth_rate_limits (scope, key, window_start, count) VALUES ('auth:login:ip','k1',NOW(),3), ('auth:login:email','k2',NOW(),1), ('auth:register:ip','k3',NOW() - INTERVAL '3 days',9)");
      for (const [game, key] of [['wizard', 1], ['twentynine', 2], ['poker', 3]]) {
        const m = (await q("INSERT INTO matches (room_code, game_id, seats, match_key) VALUES ($1,$2,3, gen_random_uuid()) RETURNING id", ['ROOM' + key, game]))[0].id;
        await q("INSERT INTO match_participants (match_id, player_id, player_name, seat, score, is_winner, is_bot, left_early) VALUES ($1,$2,'Ada',0,50,TRUE,FALSE,FALSE), ($1,$3,'Guest1',1,20,FALSE,FALSE,TRUE), ($1,NULL,'Bot',2,10,FALSE,TRUE,FALSE), ($1,NULL,'Visitor',3,5,FALSE,FALSE,FALSE)", [m, reg[0], anon[0]]);
      }
      return { players: 5, auth_identities: 2, auth_sessions: 4, auth_email_tokens: 2, auth_rate_limits: 3, matches: 3, match_participants: 12 };
    }
    const SEEDED = { match_participants: 12, matches: 3, auth_email_tokens: 2, auth_sessions: 4, auth_identities: 2, auth_rate_limits: 3, players: 5 };

    /** The same database through the command line. NODE_PATH is passed on so a locally borrowed driver still resolves. */
    const cli = (args, url = t.url) => spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'cleanup-user-data.js'), ...args], { env: { PATH: process.env.PATH, NODE_PATH: process.env.NODE_PATH || '', CLEANUP_DATABASE_URL: url }, encoding: 'utf8', timeout: 60000 });
    const recordingPg = (log) => {
      const real = require('pg');
      return { ...real, Client: class extends real.Client { query(...a) { log.push(String((a[0] && a[0].text) || a[0])); return super.query(...a); } } };
    };

    console.log('the live schema');
    await test('every table and foreign key of the migrated database is classified, and the plan order is valid for them', async () => {
      const found = await cleanup.discover(x);
      assert.deepEqual(found.tables, ALL);
      assert.doesNotThrow(() => cleanup.checkSchema(found));
      assert.deepEqual(found.fks.map((f) => `${f.child}>${f.parent}:${f.onDelete}`).sort(), cleanup.EXPECTED_FKS.map((f) => `${f.child}>${f.parent}:${f.onDelete}`).sort());
      assert.deepEqual(found.applied, cleanup.repoMigrations());
    });

    console.log('dry run');
    await test('a dry run reports every row count and changes nothing; it only issues read statements in a READ ONLY transaction', async () => {
      assert.deepEqual(await seed(), SEEDED);
      const before = await dump();
      const log = [];
      const report = await cleanup.run({ url: t.url, pg: recordingPg(log) });
      assert.equal(report.mode, 'dry-run');
      assert.equal(report.committed, false);
      assert.deepEqual(report.before, SEEDED);
      assert.equal(report.totalRows, 31);
      assert.deepEqual(report.order, cleanup.CLEAN_TABLES);
      assert.deepEqual(report.preserved, ['schema_migrations']);
      assert.deepEqual(report.breakdowns.players, { anonymous: 3, registered: 2 });
      assert.deepEqual(await dump(), before, 'every table is byte-identical afterwards');
      assert.equal(log[0], 'BEGIN READ ONLY');
      assert.equal(log[log.length - 1], 'ROLLBACK');
      const writes = log.filter((s) => /^\s*(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|LOCK|COMMIT)/i.test(s));
      assert.deepEqual(writes, [], 'no write statement of any kind: ' + writes.join(' | '));
      const text = cleanup.formatReport(report);
      assert.match(text, /DRY RUN \(read-only; nothing will be changed\)/);
      assert.match(text, /would delete 31 rows from 7 tables\. Nothing was changed/);
      assert.match(text, /3 legacy anonymous/);
      assert.ok(!text.includes('ada@example.com') && text.includes('a***@example.com'), 'emails are masked');
      assert.ok(!/a{64}|c{64}|e{64}/.test(text + JSON.stringify(report)), 'token hashes are never shown');
    });

    await test('the command line defaults to a dry run, prints the plan, and changes nothing', async () => {
      const before = await dump();
      const r = cli([]);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /DRY RUN/);
      assert.match(r.stdout, /match_participants\s+12/);
      assert.match(r.stdout, /schema_migrations/);
      assert.match(r.stdout, /--execute --confirm=tv_test_/);
      assert.deepEqual(await dump(), before);
      const withConfirmOnly = cli([`--confirm=${t.name}`]);
      assert.equal(withConfirmOnly.status, 0);
      assert.match(withConfirmOnly.stderr, /--confirm has no effect without --execute/);
      assert.deepEqual(await dump(), before, '--confirm alone does not delete');
    });

    console.log('refusing to delete');
    await test('--execute without confirmation, or with the wrong one, refuses and deletes nothing', async () => {
      const before = await dump();
      for (const args of [['--execute'], ['--execute', '--confirm=yes'], ['--execute', '--confirm=postgres'], ['--execute', `--confirm=${t.name}x`]]) {
        const r = cli(args);
        assert.equal(r.status, 2, args.join(' ') + '\n' + r.stdout + r.stderr);
        assert.match(r.stderr, /REFUSED/);
        assert.match(r.stderr, /Nothing was changed/);
      }
      await assert.rejects(cleanup.run({ url: t.url, execute: true }), (e) => e instanceof cleanup.RefusedError);
      await assert.rejects(cleanup.run({ url: t.url, execute: true, confirm: 'other' }), (e) => e instanceof cleanup.RefusedError);
      assert.deepEqual(await dump(), before);
    });

    await test('a database that is not in the expected state is refused: unknown table, trigger, missing or extra migration', async () => {
      const before = await dump();
      const userTables = (d) => Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'schema_migrations'));
      const refusedWith = async (re) => { await assert.rejects(cleanup.run({ url: t.url, execute: true, confirm: t.name }), (e) => e instanceof cleanup.RefusedError && re.test(e.message), String(re)); assert.deepEqual(userTables(await dump()), userTables(before), 'no user data was touched'); };
      // an unclassified table, even an innocent looking one
      await x.query('CREATE TABLE tv_user_notes (id int, player_id uuid)');
      try { await refusedWith(/unclassified table\(s\) tv_user_notes/); } finally { await x.query('DROP TABLE tv_user_notes'); }
      // a table that references players (could be user data, and would block or be changed by the deletes)
      await x.query('CREATE TABLE tv_friends (id int, player_id uuid REFERENCES players(id))');
      try { await refusedWith(/unclassified table\(s\) tv_friends[\s\S]*unexpected foreign key\(s\): tv_friends>players:NO ACTION/); } finally { await x.query('DROP TABLE tv_friends'); }
      // a trigger
      await x.query('CREATE FUNCTION tv_noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN OLD; END $$');
      await x.query('CREATE TRIGGER tv_trg BEFORE DELETE ON players FOR EACH ROW EXECUTE FUNCTION tv_noop()');
      try { await refusedWith(/trigger\(s\) on players\.tv_trg/); } finally { await x.query('DROP TRIGGER tv_trg ON players'); await x.query('DROP FUNCTION tv_noop()'); }
      // migration history out of step with the code
      // renamed (not deleted) so the row, including its timestamp, comes back exactly
      await x.query("UPDATE schema_migrations SET version = 'tmp_hidden' WHERE version = '004_auth_hardening.sql'");
      try { await refusedWith(/not applied to this database: 004_auth_hardening\.sql/); } finally { await x.query("UPDATE schema_migrations SET version = '004_auth_hardening.sql' WHERE version = 'tmp_hidden'"); }
      await x.query("INSERT INTO schema_migrations (version) VALUES ('999_from_the_future.sql')");
      try { await refusedWith(/unknown to this code version: 999_from_the_future\.sql/); } finally { await x.query("DELETE FROM schema_migrations WHERE version = '999_from_the_future.sql'"); }
      assert.deepEqual(await dump(), before, 'and the repairs above restored everything exactly');
    });

    await test('a deletion order that violates a foreign key is refused before anything is touched', async () => {
      const before = await dump();
      for (const order of [[...cleanup.CLEAN_TABLES].reverse(), ['players', ...cleanup.CLEAN_TABLES.filter((x2) => x2 !== 'players')], ['matches', 'match_participants', 'auth_email_tokens', 'auth_sessions', 'auth_identities', 'auth_rate_limits', 'players']]) {
        await assert.rejects(cleanup.run({ url: t.url, execute: true, confirm: t.name, order }), (e) => e instanceof cleanup.RefusedError && /unsafe deletion order/.test(e.message));
      }
      assert.deepEqual(await dump(), before);
    });

    console.log('errors roll everything back');
    await test('an error after some tables were already deleted rolls the whole transaction back', async () => {
      const before = await dump();
      for (const failAt of ['match_participants', 'matches', 'auth_sessions', 'auth_rate_limits']) {
        const err = await cleanup.run({ url: t.url, execute: true, confirm: t.name, hooks: { afterDelete: (tbl) => { if (tbl === failAt) throw new Error('injected failure after ' + tbl); } } }).then(() => null, (e) => e);
        assert.ok(err && /injected failure after/.test(err.message), 'failed at ' + failAt);
        assert.equal(err.report.rolledBack, true);
        assert.deepEqual(await dump(), before, `after a failure following the delete of ${failAt} nothing is gone`);
      }
      const late = await cleanup.run({ url: t.url, execute: true, confirm: t.name, hooks: { beforeCommit: () => { throw new Error('failure right before commit'); } } }).then(() => null, (e) => e);
      assert.match(late.message, /right before commit/);
      assert.deepEqual(await dump(), before, 'even when every delete had succeeded');
    });

    await test('a real database error (another session holds a lock) times out, rolls back and leaves the data alone', async () => {
      const before = await dump();
      const blocker = await t.client();
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE players IN ACCESS EXCLUSIVE MODE');
      try {
        const err = await cleanup.run({ url: t.url, execute: true, confirm: t.name, lockTimeoutMs: 300 }).then(() => null, (e) => e);
        assert.ok(err, 'must fail');
        assert.equal(err.code, '55P03', err.message);
        assert.equal(err.report.rolledBack, true);
      } finally { await blocker.query('ROLLBACK'); }
      assert.deepEqual(await dump(), before);
    });

    console.log('the real cleanup');
    await test('execute with the right confirmation empties every user and gameplay table in dependency order and nothing else', async () => {
      const before = await dump();
      const fingerprintBefore = await cleanup.fingerprint(x);
      const foundBefore = await cleanup.discover(x);
      const log = [];
      const report = await cleanup.run({ url: t.url, execute: true, confirm: t.name, pg: recordingPg(log) });
      assert.equal(report.committed, true);
      assert.deepEqual(report.deleted, SEEDED, 'each delete removed exactly the rows counted under lock');
      assert.deepEqual(Object.keys(report.deleted), cleanup.CLEAN_TABLES, 'in the planned order');
      for (const tbl of cleanup.CLEAN_TABLES) assert.equal(await rows(tbl), 0, tbl + ' is empty');
      assert.equal(await rows('players'), 0, 'including the legacy anonymous players');

      const statements = log.filter((s) => /^\s*DELETE/i.test(s));
      assert.deepEqual(statements.map((s) => /"(\w+)"/.exec(s)[1]), cleanup.CLEAN_TABLES, 'one DELETE per table, children first, players last');
      assert.ok(statements.every((s) => !/WHERE/i.test(s) === true), 'whole tables, no row filters');
      const forbidden = log.filter((s) => /TRUNCATE|DROP|ALTER|CREATE\s|CASCADE/i.test(s));
      assert.deepEqual(forbidden, [], 'no TRUNCATE, DROP, ALTER, CREATE or CASCADE');
      assert.ok(log.some((s) => /^LOCK TABLE/.test(s)) && log.indexOf('COMMIT') > log.findIndex((s) => /^DELETE/.test(s)));

      const after = await dump();
      assert.deepEqual(after.schema_migrations, before.schema_migrations, 'migration history is byte-identical');
      assert.equal(after.schema_migrations.n, 4);
      const fingerprintAfter = await cleanup.fingerprint(x);
      assert.equal(fingerprintAfter.structureDigest, fingerprintBefore.structureDigest, 'tables, columns, indexes, constraints unchanged');
      assert.equal(fingerprintAfter.migrationsDigest, fingerprintBefore.migrationsDigest);
      assert.deepEqual((await cleanup.discover(x)).fks, foundBefore.fks, 'every foreign key is still there');
      assert.ok(fingerprintAfter.counts.indexes >= 12 && fingerprintAfter.counts.constraints >= 15, JSON.stringify(fingerprintAfter.counts));
    });

    await test('verification passes afterwards (empty tables, intact schema, snapshot equal, application read paths work)', async () => {
      const fp = await cleanup.fingerprint(x);
      const res = await cleanup.verify({ url: t.url, snapshot: { fingerprint: fp } });
      assert.equal(res.ok, true, JSON.stringify(res.checks.filter((c) => !c.ok)));
      const names = res.checks.map((c) => c.name).join('\n');
      for (const needle of ['players is empty', 'no legacy anonymous players remain', 'migration history lists exactly', 'schema fingerprint equals the snapshot', 'schema_migrations is byte-identical', 'foreign key auth_sessions -> players', 'app: player stats query works', 'app: session lookup works']) assert.ok(names.includes(needle), needle);
    });

    await test('verification FAILS on a database that still holds data', async () => {
      await seed();
      const res = await cleanup.verify({ url: t.url, appSmoke: false });
      assert.equal(res.ok, false);
      assert.ok(res.checks.some((c) => !c.ok && /players is empty/.test(c.name)));
      assert.ok(res.checks.some((c) => !c.ok && /no legacy anonymous players/.test(c.name)));
      const r = cli(['--verify', '--no-app-smoke']);
      assert.equal(r.status, 1);
      assert.match(r.stdout, /FAIL {2}players is empty/);
    });

    await test('end to end through the command line: dry run with snapshot, execute, verify with snapshot', async () => {
      const snap = path.join(snapDir, 'pre.json');
      const dry = cli(['--snapshot=' + snap, '--sample=2']);
      assert.equal(dry.status, 0, dry.stdout + dry.stderr);
      assert.match(dry.stdout, /would delete \d+ rows from 7 tables/);
      const saved = JSON.parse(fs.readFileSync(snap, 'utf8'));
      assert.ok(saved.fingerprint.structureDigest && !JSON.stringify(saved).includes('ada@example.com'), 'the snapshot holds structure and counts, no user data');
      const run = cli(['--execute', `--confirm=${t.name}`, '--snapshot=' + snap]);
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.match(run.stdout, /COMMITTED\. Deleted \d+ rows from 7 tables/);
      for (const tbl of cleanup.CLEAN_TABLES) assert.equal(await rows(tbl), 0);
      const ver = cli(['--verify', '--snapshot=' + snap]);
      assert.equal(ver.status, 0, ver.stdout + ver.stderr);
      assert.match(ver.stdout, /All checks passed/);
      assert.match(ver.stdout, /PASS {2}schema fingerprint equals the snapshot/);
      const again = cli(['--execute', `--confirm=${t.name}`]); // running it twice is harmless
      assert.equal(again.status, 0, again.stdout + again.stderr);
      assert.match(again.stdout, /Deleted 0 rows/);
    });

    await test('the application works on the cleaned database: register, verify, log in, reach the lobby, and migrations still start clean', async () => {
      const srv = await start({ port: 0, trustProxy: false, absentMs: 60000, maxMsgsPerSec: Infinity, matchLog: { log() {}, warn() {}, error() {} } });
      try {
        const b = new Browser(srv.port); await b.csrf();
        const email = 'afterclean@test.local';
        const reg = await b.post('/api/auth/register', { email, username: 'after_clean', password: 'TestPass123!', displayName: 'After' });
        assert.equal(reg.status, 201, JSON.stringify(reg.json));
        assert.equal((await b.post('/api/auth/verify-email', { token: reg.json.debug.verifyToken })).status, 200);
        assert.equal((await b.post('/api/auth/login', { email, password: 'TestPass123!' })).status, 200);
        const s = cookieSocket(srv.port, b.cookieHeader);
        await until(() => s.welcome(), 'lobby welcome');
        s.ws.close();
        assert.equal(await rows('players'), 1);
        assert.equal(await rows('auth_sessions'), 2);
        assert.ok(await rows('auth_rate_limits') >= 1, 'rate limiting works again');
      } finally { await srv.close(); }
      const m = await require('../db/migrate').migrate();
      assert.deepEqual(m.applied, [], 'no migration is pending or re-applied');
    });
    await dbPool.close();
  } finally {
    await t.drop();
    fs.rmSync(spool, { recursive: true, force: true });
    fs.rmSync(snapDir, { recursive: true, force: true });
  }
  console.log(`\n${passed} PostgreSQL cleanup tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
