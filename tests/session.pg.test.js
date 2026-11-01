'use strict';
require('./helpers/env');
// Single active session per account on a REAL PostgreSQL: two-device login, sign-out, password reset, revoked tokens that
// try to come back over a WebSocket, concurrent logins, the database-level guarantee and the migration's clean-up.
// Runs only with TEST_DATABASE_URL (throw-away database from tests/helpers/testdb.js).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { Browser, registerAndVerify } = require('./helpers/auth');
const testdb = require('./helpers/testdb');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n' + e.stack); process.exitCode = 1; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, ms = 15000) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + label); await sleep(25); }
}
const quiet = () => ({ log() {}, warn() {}, error() {} });
const PW = 'TestPass123!';

function socket(port, cookie) {
  const c = { msgs: [], closed: null, ws: new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } }) };
  c.ws.on('open', () => c.ws.send(JSON.stringify({ t: 'hello' })));
  c.ws.on('message', (raw) => { c.msgs.push(JSON.parse(raw)); });
  c.ws.on('close', (code) => { c.closed = code; });
  c.ws.on('error', () => {});
  c.welcome = () => c.msgs.find((m) => m.t === 'welcome');
  c.refused = () => c.msgs.some((m) => m.t === 'authRequired');
  return c;
}

(async () => {
  const t = await testdb.create();
  const spool = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-sesspool-'));
  process.env.MATCH_SPOOL_DIR = spool;
  try {
    process.env.DATABASE_URL = t.url;
    const dbAuth = require('../db/auth');
    const dbPlayers = require('../db/players');
    const { start } = require('../server');
    const x = await t.client();
    const q = async (sql, params) => (await x.query(sql, params)).rows;
    const fast = { port: 0, trustProxy: false, botDelay: [0, 3], autoAdvanceMs: 20, trickPauseMs: 0, forcedMs: 0, timeScale: 0.01, absentMs: 60000, maxMsgsPerSec: Infinity, matchRetryDelays: [20, 40, 80], matchLog: quiet() };
    const srv = await start(fast);
    let seq = 1;
    const newUser = async (tag) => {
      const email = `${tag.toLowerCase()}.${seq++}@test.local`;
      const u = await registerAndVerify(srv.port, { email, username: `${tag.toLowerCase()}${seq}`, displayName: tag, password: PW });
      const me = (await u.browser.get('/api/auth/session')).json.player;
      return { ...u, email, id: me.id };
    };
    const login = async (u) => { const b = new Browser(srv.port); await b.csrf(); const r = await b.must('/api/auth/login', { email: u.email, password: PW }); return { browser: b, token: r.json.token }; };
    const active = async (id) => (await q('SELECT count(*)::int AS n FROM auth_sessions WHERE player_id = $1 AND revoked_at IS NULL', [id]))[0].n;

    console.log('single active session');
    await test('a second login retires the first: its socket is closed (4002), its cookie stops working and it cannot reconnect', async () => {
      const u = await newUser('Dual');
      const s1 = socket(srv.port, u.browser.cookieHeader);
      await until(() => s1.welcome(), 'device one connects');
      const d2 = await login(u);
      await until(() => s1.closed !== null, 'device one is closed');
      assert.equal(s1.closed, 4002);
      assert.equal((await u.browser.get('/api/auth/session')).json.authenticated, false, 'device one is signed out over HTTP too');
      assert.equal((await d2.browser.get('/api/auth/session')).json.authenticated, true);
      const back = socket(srv.port, u.browser.cookieHeader);
      await until(() => back.closed !== null, 'the old cookie is refused');
      assert.ok(back.refused() && !back.welcome(), 'revoked session must not reconnect');
      const s2 = socket(srv.port, d2.browser.cookieHeader);
      await until(() => s2.welcome(), 'device two connects');
      assert.equal(await active(u.id), 1);
      s2.ws.close();
    });

    await test('the server memory cannot outlive the database: a revoked token cached by the server is still refused', async () => {
      const u = await newUser('Cache');
      const s1 = socket(srv.port, u.browser.cookieHeader);
      await until(() => s1.welcome(), 'connected (token is now cached in server memory)');
      s1.ws.close();
      await sleep(50);
      await x.query('UPDATE auth_sessions SET revoked_at = NOW() WHERE player_id = $1 AND revoked_at IS NULL', [u.id]); // revoked behind the server\'s back
      const again = socket(srv.port, u.browser.cookieHeader);
      await until(() => again.closed !== null, 'refused');
      assert.ok(again.refused() && !again.welcome());
    });

    await test('logout closes only that session\'s sockets; logging in again works; other accounts are untouched', async () => {
      const u = await newUser('Out');
      const other = await newUser('Bystander');
      const so = socket(srv.port, other.browser.cookieHeader);
      const s = socket(srv.port, u.browser.cookieHeader);
      await until(() => s.welcome() && so.welcome(), 'both connect');
      await u.browser.must('/api/auth/logout', {});
      await until(() => s.closed !== null, 'closed by logout');
      assert.equal(s.closed, 4001);
      assert.equal(so.closed, null, 'the bystander stays connected');
      assert.equal(await active(u.id), 0);
      const d = await login(u);
      const s2 = socket(srv.port, d.browser.cookieHeader);
      await until(() => s2.welcome(), 'logs in again');
      s2.ws.close(); so.ws.close();
    });

    await test('a password reset closes the open socket, kills the old session and lets only the new password in', async () => {
      const u = await newUser('Reset');
      const s = socket(srv.port, u.browser.cookieHeader);
      await until(() => s.welcome(), 'connected');
      const anon = new Browser(srv.port); await anon.csrf();
      const forgot = await anon.must('/api/auth/forgot-password', { email: u.email });
      await anon.must('/api/auth/reset-password', { token: forgot.json.debug.resetToken, newPassword: 'NewPass123!' });
      await until(() => s.closed !== null, 'closed by the reset');
      assert.equal(s.closed, 4001);
      assert.equal(await active(u.id), 0);
      const back = socket(srv.port, u.browser.cookieHeader);
      await until(() => back.closed !== null, 'old cookie refused');
      assert.ok(back.refused());
      assert.equal((await anon.post('/api/auth/login', { email: u.email, password: PW })).status, 401);
      const b = new Browser(srv.port); await b.csrf();
      await b.must('/api/auth/login', { email: u.email, password: 'NewPass123!' });
      assert.equal(await active(u.id), 1);
    });

    await test('simultaneous logins leave exactly one working session', async () => {
      const u = await newUser('Race');
      const results = await Promise.all(Array.from({ length: 8 }, () => dbAuth.loginEmail({ email: u.email, password: PW })));
      assert.equal(await active(u.id), 1);
      const valid = (await Promise.all(results.map((r) => dbPlayers.authenticateToken(r.token)))).filter(Boolean);
      assert.equal(valid.length, 1, 'only one of the eight tokens still authenticates');
    });

    await test('the database itself refuses a second active session for one account', async () => {
      const u = await newUser('Index');
      await assert.rejects(
        x.query("INSERT INTO auth_sessions (player_id, token_hash, expires_at) VALUES ($1, repeat('9',64), NOW() + INTERVAL '1 day')", [u.id]),
        (e) => e.code === '23505',
        'a unique violation'
      );
      // revoked rows are history and are unlimited
      await x.query("INSERT INTO auth_sessions (player_id, token_hash, revoked_at) VALUES ($1, repeat('8',64), NOW()), ($1, repeat('7',64), NOW())", [u.id]);
    });

    await test('migration 006 revokes (never deletes) all but the newest active session of an account that already had several', async () => {
      const u = await newUser('Legacy');
      await x.query('DROP INDEX ux_auth_sessions_one_active');
      try {
        await x.query("INSERT INTO auth_sessions (player_id, token_hash, created_at) VALUES ($1, repeat('1',64), NOW() - INTERVAL '3 hours'), ($1, repeat('2',64), NOW() - INTERVAL '2 hours'), ($1, repeat('3',64), NOW() + INTERVAL '1 hour')", [u.id]);
        const before = (await q('SELECT count(*)::int AS n FROM auth_sessions WHERE player_id = $1', [u.id]))[0].n;
        assert.ok((await active(u.id)) >= 4, 'precondition: several active sessions');
        await x.query(fs.readFileSync(path.join(__dirname, '../db/migrations/006_single_active_session.sql'), 'utf8'));
        assert.equal(await active(u.id), 1);
        assert.equal((await q('SELECT count(*)::int AS n FROM auth_sessions WHERE player_id = $1', [u.id]))[0].n, before, 'nothing was deleted');
        assert.equal((await q("SELECT count(*)::int AS n FROM auth_sessions WHERE token_hash = repeat('3',64) AND revoked_at IS NULL"))[0].n, 1, 'the newest one is the survivor');
        assert.equal((await q("SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'ux_auth_sessions_one_active'"))[0].n, 1, 'the index is back');
      } finally {
        await x.query('CREATE UNIQUE INDEX IF NOT EXISTS ux_auth_sessions_one_active ON auth_sessions(player_id) WHERE revoked_at IS NULL');
      }
    });

    await srv.close();
    console.log(`\n${passed} session tests passed`);
  } finally {
    fs.rmSync(spool, { recursive: true, force: true });
    await t.drop();
  }
})().catch((e) => { console.error(e); process.exit(1); });
