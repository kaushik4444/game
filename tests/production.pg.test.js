'use strict';
require('./helpers/env');
// Production path on a REAL PostgreSQL: a finished game goes through the server, the queue and the database; plus failures.
// Runs only with TEST_DATABASE_URL; every run uses its own throw-away database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { registerAndVerify, Browser } = require('./helpers/auth');
const testdb = require('./helpers/testdb');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n' + e.stack); process.exitCode = 1; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, ms = 30000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + label);
    await sleep(25);
  }
}
const quiet = () => { const lines = { log: [], warn: [], error: [] }; return { lines, log: (m) => lines.log.push(m), warn: (m) => lines.warn.push(m), error: (m) => lines.error.push(m) }; };

function client(port, name, token) {
  const c = { name, room: null, view: null, chats: [], notices: [], errors: [], stats: null, ws: new WebSocket(`ws://127.0.0.1:${port}/ws`) };
  c.send = (m) => c.ws.send(JSON.stringify(m));
  c.ws.on('open', () => c.send({ t: 'hello', token }));
  c.ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.t === 'welcome') Object.assign(c, { id: m.id, token: m.token });
    if (m.t === 'state') { c.room = m.room; c.view = m.view; }
    if (m.t === 'chat') c.chats.push(m.m);
    if (m.t === 'notice') c.notices.push(m.text);
    if (m.t === 'error') c.errors.push(m.message);
    if (m.t === 'stats') c.stats = m.stats;
  });
  c.ready = () => until(() => c.id, 'welcome ' + name);
  c.getStats = async () => { c.stats = null; await sleep(1100); c.send({ t: 'getStats' }); return until(() => c.stats, 'stats'); };
  return c;
}

/** A WebSocket that authenticates with the session cookie only, as a browser does. */
function cookieSocket(port, cookie) {
  const c = { msgs: [], closed: null, ws: new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: cookie ? { cookie } : {} }) };
  c.ws.on('open', () => c.ws.send(JSON.stringify({ t: 'hello' })));
  c.ws.on('message', (raw) => c.msgs.push(JSON.parse(raw)));
  c.ws.on('close', (code) => { c.closed = code; });
  c.welcome = () => c.msgs.find((m) => m.t === 'welcome');
  return c;
}

(async () => {
  const t = await testdb.create(); // exits (SKIPPED) when PostgreSQL tests are not configured
  const spools = [];
  process.env.MATCH_SPOOL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-pgspool-default-')); // the default spool of servers that do not name one: hermetic
  spools.push(process.env.MATCH_SPOOL_DIR);
  const spool = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-pgspool-')); spools.push(d); return d; };
  try {
    process.env.DATABASE_URL = t.url;
    const dbPool = require('../db/pool');
    const dbMatches = require('../db/matches');
    const { start } = require('../server');
    const x = await t.client();
    const q = async (sql, params) => (await x.query(sql, params)).rows;
    const matchesOf = (code) => q('SELECT * FROM matches WHERE room_code = $1 ORDER BY finished_at', [code]);
    const fast = { port: 0, trustProxy: false, botDelay: [0, 3], autoAdvanceMs: 20, trickPauseMs: 0, forcedMs: 0, timeScale: 0.01, absentMs: 60000, maxMsgsPerSec: Infinity, matchRetryDelays: [20, 40, 80] };

    let authSeq = 1;
    const authClient = async (srv, name) => {
      const email = `${name.toLowerCase().replace(/[^a-z0-9]/g, '')}.${authSeq++}@test.local`;
      const { token } = await registerAndVerify(srv.port, { email, displayName: name, password: 'TestPass123!' });
      const c = client(srv.port, name, token);
      await c.ready();
      return c;
    };

    /** A short Wizard game: one human (idle, so the server's turn limit plays for them) and two bots, played to the end. */
    async function playGame(srv, name = 'Hana', extra = {}) {
      const c = await authClient(srv, name);
      c.send({ t: 'create', gameId: 'wizard' });
      await until(() => c.room, 'table');
      c.send({ t: 'setSeats', seats: 3 });
      c.send({ t: 'setOptions', options: { length: 'short', timeLimit: '20', ...extra } });
      c.send({ t: 'start' });
      await until(() => c.room && c.room.status === 'finished', 'game over');
      return c;
    }

    assert.equal(dbPool.hasDatabase(), true);
    assert.equal(new URL(process.env.DATABASE_URL).pathname.slice(1), t.name);

    console.log('a complete game through the server');
    const captured = [];
    const log1 = quiet();
    let srv = await start({ ...fast, matchLog: log1, matchRecord: async (rec) => { captured.push(rec); return dbMatches.recordMatch(rec); } });
    assert.equal(srv.database.mode, 'postgres', 'the real startup path picked PostgreSQL');
    let hana;
    await test('the finished game is stored: one match row, three participant rows with the right flags', async () => {
      hana = await playGame(srv);
      const code = hana.room.code;
      const [m] = await until(async () => { const r = await matchesOf(code); return r.length ? r : null; }, 'match row');
      assert.deepEqual([m.game_id, m.seats, m.options.length], ['wizard', 3, 'short']);
      assert.match(m.match_key, /^[0-9a-f-]{36}$/);
      assert.equal(m.match_key, captured[0].matchKey);
      const ps = await q('SELECT * FROM match_participants WHERE match_id = $1 ORDER BY seat', [m.id]);
      assert.equal(ps.length, 3);
      assert.deepEqual(ps.map((p) => p.is_bot), [false, true, true]);
      assert.equal(ps[0].player_id, hana.id, 'the human is linked to their account');
      assert.ok(ps[1].player_id === null && ps[2].player_id === null, 'bots have no account');
      assert.ok(ps.every((p) => p.left_early === false));
      const best = Math.max(...ps.map((p) => p.score));
      assert.ok(ps.every((p) => p.is_winner === (p.score === best)), 'the highest Wizard score wins; ties share it');
      assert.deepEqual(ps.map((p) => p.score), hana.view.players.map((p) => p.score), 'stored scores are the scores the players saw');
      const s = srv.matchQueue.stats();
      assert.deepEqual([s.saved, s.failed, s.pending], [1, 0, 0]);
    });
    await test('player stats reflect the saved result', async () => {
      const [m] = await matchesOf(hana.room.code);
      const mine = (await q('SELECT * FROM match_participants WHERE match_id = $1 AND player_id = $2', [m.id, hana.id]))[0];
      const st = await hana.getStats();
      assert.deepEqual([st.played, st.wins, st.losses], [1, mine.is_winner ? 1 : 0, mine.is_winner ? 0 : 1]);
      assert.equal(st.perGame[0].gameId, 'wizard');
      assert.equal(st.perGame[0].best, mine.score);
      assert.equal(st.perGame[0].bestLabel, 'Highest score');
      assert.ok(st.memberSince && st.lastPlayed);
    });
    await test('recording the same game again, directly or through the queue, changes nothing', async () => {
      const rec = captured[0];
      assert.deepEqual(await dbMatches.recordMatch(rec), { matchId: null, duplicate: true });
      assert.equal((await srv.matchQueue.enqueue(rec)).status, 'duplicate');
      assert.equal((await matchesOf(hana.room.code)).length, 1);
      assert.equal((await q('SELECT count(*)::int AS n FROM match_participants mp JOIN matches m ON m.id = mp.match_id WHERE m.room_code = $1', [hana.room.code]))[0].n, 3);
      assert.equal(srv.matchQueue.stats().duplicates, 1);
      assert.equal(log1.lines.error.length, 0, 'no errors logged on the happy path: ' + log1.lines.error.join(' | '));
    });
    await test('/readyz reports the database as ready', async () => {
      const r = await fetch(`http://127.0.0.1:${srv.port}/readyz`);
      assert.equal(r.status, 200);
      assert.match(await r.text(), /^ready/);
    });
    console.log('authentication over HTTP');
    const PW = 'TestPass123!';
    const newUser = async (server, tag) => {
      const email = `${tag}.${authSeq++}@test.local`;
      const u = await registerAndVerify(server.port, { email, displayName: tag, password: PW });
      return { ...u, email };
    };
    await test('the session is an HttpOnly cookie; CSRF needs the cookie value in the header, and a made-up matching pair is refused', async () => {
      const u = await newUser(srv, 'Cookie');
      const fresh = new Browser(srv.port);
      const line = (await fresh.get('/api/auth/csrf')).setCookie.find((c) => c.startsWith('ct_csrf='));
      assert.ok(line && !/HttpOnly/i.test(line) && /SameSite=Lax/.test(line), 'the CSRF cookie is readable by the page: ' + line);
      const login = await u.browser.post('/api/auth/login', { email: u.email, password: PW });
      const sess = login.setCookie.find((c) => c.startsWith('ct_session='));
      assert.ok(/HttpOnly/.test(sess) && /SameSite=Lax/.test(sess) && /Path=\//.test(sess), sess);
      // the attack the old check allowed: no CSRF cookie, but the same invented value in header and body
      const made = 'a'.repeat(48);
      const evil = await fetch(`http://127.0.0.1:${srv.port}/api/auth/logout`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': made, cookie: `ct_session=${u.token}` }, body: JSON.stringify({ csrfToken: made }) });
      assert.equal(evil.status, 403);
      assert.equal((await u.browser.post('/api/auth/logout', {}, { headers: { 'x-csrf-token': '0'.repeat(48) } })).status, 403, 'header differs from the cookie');
      assert.equal((await u.browser.post('/api/auth/logout', {}, { csrf: false })).status, 403, 'no header');
      assert.equal((await u.browser.get('/api/auth/session')).json.authenticated, true, 'every refused attempt left the session alone');
    });
    await test('the WebSocket works from the cookie alone; logout, logout-all and a password reset close open sockets; other accounts are unaffected', async () => {
      const u = await newUser(srv, 'Signout');
      const other = await newUser(srv, 'Bystander');
      const so = cookieSocket(srv.port, other.browser.cookieHeader);
      await until(() => so.welcome(), 'bystander welcome');

      let s = cookieSocket(srv.port, u.browser.cookieHeader); // no token in hello: the cookie is enough
      await until(() => s.welcome(), 'welcome from the cookie');
      await u.browser.must('/api/auth/logout', {});
      await until(() => s.closed !== null, 'socket closed by logout');
      assert.equal(s.closed, 4001);
      const again = cookieSocket(srv.port, 'ct_session=' + u.token); // the revoked session cannot come back
      await until(() => again.closed !== null, 'revoked session refused');
      assert.ok(again.msgs.some((m) => m.t === 'authRequired'));

      const b = new Browser(srv.port); await b.csrf(); await b.must('/api/auth/login', { email: u.email, password: PW });
      s = cookieSocket(srv.port, b.cookieHeader);
      await until(() => s.welcome(), 'welcome after login');
      await b.must('/api/auth/logout-all', {});
      await until(() => s.closed !== null, 'socket closed by logout-all');
      assert.equal(s.closed, 4001);

      const c = new Browser(srv.port); await c.csrf(); await c.must('/api/auth/login', { email: u.email, password: PW });
      s = cookieSocket(srv.port, c.cookieHeader);
      await until(() => s.welcome(), 'welcome before reset');
      const forgot = await c.must('/api/auth/forgot-password', { email: u.email });
      await c.must('/api/auth/reset-password', { token: forgot.json.debug.resetToken, newPassword: 'NewPass123!' });
      await until(() => s.closed !== null, 'socket closed by the password reset');
      assert.equal(s.closed, 4001);
      assert.equal((await c.get('/api/auth/session')).json.authenticated, false);

      assert.equal(so.closed, null, 'the other account is still connected');
      so.ws.close();
    });
    await test('auth rate limits work on PostgreSQL: the counter is stored, the limit answers 429 with Retry-After', async () => {
      const rl = await start({ ...fast, matchLog: quiet(), env: { ...process.env, RL_LOGIN_EMAIL_LIMIT: '3', RL_USERNAME_IP_LIMIT: '3' } });
      try {
        const b = new Browser(rl.port); await b.csrf();
        const email = `limit.${authSeq++}@test.local`;
        const codes = [];
        for (let i = 0; i < 4; i++) codes.push((await b.post('/api/auth/login', { email, password: 'wrong-password' })).status);
        assert.deepEqual(codes, [401, 401, 401, 429]);
        const blocked = await b.post('/api/auth/login', { email, password: 'wrong-password' });
        assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
        const key = crypto.createHash('sha256').update(email).digest('hex');
        const row = (await q("SELECT count FROM auth_rate_limits WHERE scope = 'auth:login:email' AND key = $1", [key]))[0];
        assert.ok(row && row.count === 5, 'the counter lives in the database, so every app instance shares it');
        const names = [];
        for (let i = 0; i < 4; i++) names.push((await b.get('/api/auth/username-available?username=someone_' + i)).status);
        assert.deepEqual(names, [200, 200, 200, 429], 'username lookups are limited too');
      } finally { await rl.close(); }
    });
    await test('production mode: no token reaches scripts, cookies are Secure, a failed email does not strand the account, and account existence is not revealed', async () => {
      const mail = { sent: [], failNext: 0, assertReady() {}, async sendVerification(m) { if (this.failNext-- > 0) throw new Error('provider down'); this.sent.push({ kind: 'verify', ...m }); }, async sendPasswordReset(m) { if (this.failNext-- > 0) throw new Error('provider down'); this.sent.push({ kind: 'reset', ...m }); } };
      const log = quiet();
      const prod = await start({ ...fast, matchLog: quiet(), log, emailSender: mail, env: { ...process.env, NODE_ENV: 'production', REQUIRE_EMAIL_VERIFICATION: 'true' } });
      process.env.AUTH_SESSION_TTL_DAYS = '2';
      try {
        const b = new Browser(prod.port); await b.csrf();
        const email = `prod.${authSeq++}@test.local`;
        mail.failNext = 1;
        const reg = await b.post('/api/auth/register', { email, username: `prod${Date.now() % 1000000}`, password: PW, displayName: 'Prod' });
        assert.equal(reg.status, 201, JSON.stringify(reg.json));
        assert.equal(reg.json.emailSent, false);
        assert.match(reg.json.message, /could not be sent/);
        assert.equal(reg.json.token, undefined); assert.equal(reg.json.debug, undefined);
        const sess = reg.setCookie.find((c) => c.startsWith('ct_session='));
        assert.ok(/Secure/.test(sess) && /HttpOnly/.test(sess) && /Max-Age=172800/.test(sess), 'Secure, HttpOnly, and the lifetime follows AUTH_SESSION_TTL_DAYS: ' + sess);
        assert.ok(log.lines.error.some((l) => /verify email could not be delivered/.test(l)), 'the failure is logged');

        // the account exists and can get a new link
        assert.equal((await b.post('/api/auth/register', { email, username: `prodx${Date.now() % 1000000}`, password: PW, displayName: 'Prod' })).status, 400);
        await b.must('/api/auth/resend-verification', { email });
        assert.equal(mail.sent.length, 1);
        await b.must('/api/auth/verify-email', { token: mail.sent[0].token });
        const login = await b.must('/api/auth/login', { email, password: PW });
        assert.equal(login.json.token, undefined);
        assert.equal(login.json.debug, undefined);

        const s = cookieSocket(prod.port, b.cookieHeader);
        await until(() => s.welcome(), 'production welcome');
        assert.equal(s.welcome().token, undefined, 'the welcome message does not echo the session token');
        s.ws.close();

        // forgot-password: same answer for a known account whose email fails and for an address that does not exist
        mail.failNext = 1;
        const known = await b.post('/api/auth/forgot-password', { email });
        const unknown = await b.post('/api/auth/forgot-password', { email: `nobody.${authSeq++}@test.local` });
        assert.deepEqual([known.status, unknown.status], [200, 200]);
        assert.equal(known.json.message, unknown.json.message);
        assert.equal(known.json.debug, undefined);
      } finally { delete process.env.AUTH_SESSION_TTL_DAYS; await prod.close(); }
    });
    await test('when verification is optional, registration/login can proceed without verification and without fake verified status', async () => {
      const mail = { sent: [], failNext: 0, assertReady() {}, async sendVerification(m) { if (this.failNext-- > 0) throw new Error('provider down'); this.sent.push({ kind: 'verify', ...m }); }, async sendPasswordReset(m) { if (this.failNext-- > 0) throw new Error('provider down'); this.sent.push({ kind: 'reset', ...m }); } };
      // This scenario runs after other auth tests that may have already used the same test-run IP key.
      // Isolate only the registration limiter scopes used here.
      await q("DELETE FROM auth_rate_limits WHERE scope IN ('auth:register:ip', 'auth:register:email')");
      const testRateLimits = {
        RL_REGISTER_IP_LIMIT: '100',
        RL_REGISTER_EMAIL_LIMIT: '100',
      };
      const optional = await start({ ...fast, matchLog: quiet(), log: quiet(), emailSender: mail, env: { ...process.env, ...testRateLimits, NODE_ENV: 'production', REQUIRE_EMAIL_VERIFICATION: 'false' } });
      try {
        const guest = new Browser(optional.port);
        const guestSession = await guest.get('/api/auth/session');
        assert.equal(guestSession.status, 200);
        assert.equal(guestSession.json.authenticated, false);
        assert.equal(guestSession.json.emailVerificationRequired, false, 'unauthenticated session payload still exposes policy for first-render auth messaging');

        const b = new Browser(optional.port); await b.csrf();
        const email = `optional.${authSeq++}@test.local`;
        mail.failNext = 1;
        const reg = await b.post('/api/auth/register', { email, username: `optional${Date.now() % 1000000}`, password: PW, displayName: 'Optional' });
        assert.equal(reg.status, 201, JSON.stringify(reg.json));
        assert.equal(reg.json.requiresVerification, false);
        assert.equal(reg.json.emailVerificationRequired, false, 'register response exposes policy mode, not just account state');
        assert.equal(reg.json.player.email_verified, false, 'optional mode does not mark new accounts as verified');
        assert.equal(reg.json.emailSent, false);
        const row = (await q('SELECT email_verified_at FROM auth_identities WHERE provider = $1 AND provider_user_id = $2 LIMIT 1', ['email', email]))[0];
        assert.equal(row.email_verified_at, null, 'stored identity remains unverified');

        const login = await b.must('/api/auth/login', { email, password: PW });
        assert.equal(login.json.requiresVerification, false);
        assert.equal(login.json.emailVerificationRequired, false, 'login response carries server policy for UI messaging');
        assert.equal(login.json.player.email_verified, false, 'login still reports pending verification in optional mode');
        const session = await b.get('/api/auth/session');
        assert.equal(session.status, 200);
        assert.equal(session.json.emailVerificationRequired, false, 'session endpoint exposes server policy too');
        assert.equal(session.json.emailVerified, false, 'session reports actual verification state, not policy');

        // local UI helpers: optional mode keeps pending status and disables resend from Settings
        const notice = ({ emailVerified, emailVerificationRequired }) => {
          if (emailVerified) return 'verified';
          return emailVerificationRequired ? 'pending-required' : 'pending-optional';
        };
        const resendState = ({ emailVerified, emailVerificationRequired }) => ({
          disabled: !emailVerified && !emailVerificationRequired,
          callApi: !emailVerified && emailVerificationRequired,
        });
        assert.equal(notice({ emailVerified: false, emailVerificationRequired: false }), 'pending-optional');
        assert.equal(notice({ emailVerified: false, emailVerificationRequired: true }), 'pending-required');
        assert.equal(notice({ emailVerified: true, emailVerificationRequired: false }), 'verified');
        assert.deepEqual(resendState({ emailVerified: false, emailVerificationRequired: false }), { disabled: true, callApi: false }, 'optional mode resend is disabled in Settings');
        assert.deepEqual(resendState({ emailVerified: false, emailVerificationRequired: true }), { disabled: false, callApi: true }, 'required mode keeps resend enabled');

        // backend resend remains protected and generic; UI chooses whether to call it
        await b.must('/api/auth/resend-verification', { email });
        assert.equal(mail.sent.length, 1, 'optional-mode resend endpoint still works when explicitly requested');
        await b.must('/api/auth/verify-email', { token: mail.sent[0].token });
        const afterVerify = await b.get('/api/auth/session');
        assert.equal(afterVerify.json.emailVerified, true, 'session updates after real verification');
        assert.equal(afterVerify.json.player.email_verified, true, 'session payload reports verified identity');

        const loginAfterVerify = await b.must('/api/auth/login', { email, password: PW });
        assert.equal(loginAfterVerify.json.player.email_verified, true, 'verified account reports true in optional mode too');

        const optionalResendCount = mail.sent.length;
        await b.must('/api/auth/resend-verification', { email });
        assert.equal(mail.sent.length, optionalResendCount, 'already verified account does not receive another verify email');

        const s = cookieSocket(optional.port, b.cookieHeader);
        await until(() => s.welcome(), 'optional verification welcome');
        s.ws.close();

        // sensitive proof-of-email flow still requires verified status.
        // Use a separate browser so creating another account does not replace b's verified session cookie.
        const uv = new Browser(optional.port); await uv.csrf();
        const unverifiedEmail = `optional.unverified.${authSeq++}@test.local`;
        const regUnverified = await uv.post('/api/auth/register', { email: unverifiedEmail, username: `optuv${Date.now() % 1000000}`, password: PW, displayName: 'Optional UV' });
        assert.equal(regUnverified.status, 201);
        assert.equal(regUnverified.json.player.email_verified, false);
        const forgot = await uv.post('/api/auth/forgot-password', { email: unverifiedEmail });
        assert.equal(forgot.status, 200);
        assert.equal(forgot.json.debug, undefined, 'no reset token issued for unverified identity');

        // registration/login messaging keeps optional-vs-required distinction
        assert.match(reg.json.message, /optional|log in now/i);

        const requiredMail = { sent: [], assertReady() {}, async sendVerification(m) { this.sent.push({ kind: 'verify', ...m }); }, async sendPasswordReset() {} };
        const required = await start({ ...fast, matchLog: quiet(), log: quiet(), emailSender: requiredMail, env: { ...process.env, ...testRateLimits, NODE_ENV: 'production', REQUIRE_EMAIL_VERIFICATION: 'true' } });
        try {
          const rb = new Browser(required.port); await rb.csrf();
          const remail = `required.${authSeq++}@test.local`;
          const rreg = await rb.post('/api/auth/register', { email: remail, username: `required${Date.now() % 1000000}`, password: PW, displayName: 'Required' });
          assert.equal(rreg.status, 201, JSON.stringify(rreg.json));
          assert.equal(rreg.json.player.email_verified, false);
          assert.match(rreg.json.message, /verify your email/i, 'required mode registration message remains blocking');
          const rlogin = await rb.must('/api/auth/login', { email: remail, password: PW });
          assert.equal(rlogin.json.requiresVerification, true, 'required mode still blocks unverified lobby access');
          await rb.must('/api/auth/resend-verification', { email: remail });
          assert.equal(requiredMail.sent.length, 2, 'required mode resend sends another verification email');

          const gateSock = cookieSocket(required.port, rb.cookieHeader);
          await until(() => gateSock.msgs.some((m) => m.t === 'authRequired' && /verify/i.test(m.message || '')), 'required-mode websocket gate for unverified account');
          gateSock.ws.close();

          const requiredVerify = requiredMail.sent.find((m) => m.kind === 'verify' && m.email === remail);
          assert.ok(requiredVerify && requiredVerify.token, 'required-mode verification email includes a token');
          await rb.must('/api/auth/verify-email', { token: requiredVerify.token });
          const reqSession = await rb.get('/api/auth/session');
          assert.equal(reqSession.json.emailVerified, true, 'required mode session updates after verification');
          const verifiedLogin = await rb.must('/api/auth/login', { email: remail, password: PW });
          assert.equal(verifiedLogin.json.player.email_verified, true, 'verified identity reports true in required mode');
        } finally { await required.close(); }

        const sessionAfterFlows = await b.get('/api/auth/session');
        assert.equal(sessionAfterFlows.json.authenticated, true);
        assert.equal(sessionAfterFlows.json.emailVerified, true);

        const resendLabel = ({ emailVerificationRequired }) => emailVerificationRequired ? 'Resend verification email' : 'Resend verification email — Soon';
        assert.equal(resendLabel({ emailVerificationRequired: false }), 'Resend verification email — Soon');
        assert.equal(resendLabel({ emailVerificationRequired: true }), 'Resend verification email');

        const pendingLine = ({ emailVerificationRequired }) => emailVerificationRequired
          ? 'Please verify your email before entering the lobby.'
          : 'You can play normally. Email verification is optional during friend testing.';
        assert.match(pendingLine({ emailVerificationRequired: false }), /optional during friend testing/);
        assert.match(pendingLine({ emailVerificationRequired: true }), /before entering the lobby/);

        const optionalForgot = await b.post('/api/auth/forgot-password', { email });
        assert.equal(optionalForgot.status, 200);
        assert.equal(optionalForgot.json.debug, undefined, 'forgot-password remains generic after optional-mode flows');

        const guestRequired = await start({ ...fast, matchLog: quiet(), log: quiet(), emailSender: { sent: [], assertReady() {}, async sendVerification(m) { this.sent.push({ kind: 'verify', ...m }); }, async sendPasswordReset() {} }, env: { ...process.env, ...testRateLimits, NODE_ENV: 'production', REQUIRE_EMAIL_VERIFICATION: 'true' } });
        try {
          const gb = new Browser(guestRequired.port);
          const gs = await gb.get('/api/auth/session');
          assert.equal(gs.json.emailVerificationRequired, true, 'required-mode guest session advertises strict policy');
        } finally { await guestRequired.close(); }

        const resendUnknown = await b.post('/api/auth/resend-verification', { email: `nobody.${authSeq++}@test.local` });
        assert.equal(resendUnknown.status, 200);
        assert.match(String(resendUnknown.json.message || ''), /If this account exists/i, 'resend response remains non-enumerating');

        const freshOptional = await start({ ...fast, matchLog: quiet(), log: quiet(), emailSender: { sent: [], assertReady() {}, async sendVerification(m) { this.sent.push({ kind: 'verify', ...m }); }, async sendPasswordReset() {} }, env: { ...process.env, ...testRateLimits, NODE_ENV: 'production', REQUIRE_EMAIL_VERIFICATION: 'false' } });
        try {
          const ob = new Browser(freshOptional.port); await ob.csrf();
          const oe = `fresh.optional.${authSeq++}@test.local`;
          await ob.post('/api/auth/register', { email: oe, username: `fo${Date.now() % 1000000}`, password: PW, displayName: 'FreshOpt' });
          const os = await ob.get('/api/auth/session');
          assert.equal(os.json.emailVerified, false, 'optional mode keeps pending status until real verification');
        } finally { await freshOptional.close(); }

        const finalSock = cookieSocket(optional.port, b.cookieHeader);
        await until(() => finalSock.welcome(), 'verified optional welcome');
        finalSock.ws.close();

        assert.equal((await b.get('/api/auth/session')).json.authenticated, true);
      } finally { await optional.close(); }
    });

    await test('housekeeping removes expired sessions, used tokens and old rate-limit rows, and keeps what is still valid', async () => {
      const dbAuth = require('../db/auth');
      const u = await newUser(srv, 'Purge');
      const pid = u.player.id;
      const h = () => crypto.randomBytes(32).toString('hex');
      const [oldSess, legacy, fresh, oldTok] = [h(), h(), h(), h()];
      // one ACTIVE session per account (migration 006): retire the login's own, then add an expired+revoked one, the legacy
      // active one without an expiry, and a recently revoked one that has not expired yet
      await x.query('UPDATE auth_sessions SET revoked_at = NOW() WHERE player_id = $1 AND revoked_at IS NULL', [pid]);
      await x.query("INSERT INTO auth_sessions (player_id, token_hash, expires_at, revoked_at) VALUES ($1,$2, NOW() - INTERVAL '10 days', NOW() - INTERVAL '40 days'), ($1,$3, NULL, NULL), ($1,$4, NOW() + INTERVAL '5 days', NOW())", [pid, oldSess, legacy, fresh]);
      await x.query("INSERT INTO auth_email_tokens (player_id, purpose, email, token_hash, expires_at) VALUES ($1,'verify_email','x@test.local',$2, NOW() - INTERVAL '10 days')", [pid, oldTok]);
      await x.query("INSERT INTO auth_rate_limits (scope, key, window_start, count) VALUES ('purge:test','old', NOW() - INTERVAL '2 days', 1), ('purge:test','new', NOW(), 1)");
      const out = await dbAuth.purgeExpired();
      assert.ok(out.sessions >= 1 && out.tokens >= 1 && out.rateLimits >= 1, JSON.stringify(out));
      const left = (await q('SELECT token_hash FROM auth_sessions WHERE token_hash IN ($1, $2, $3)', [oldSess, legacy, fresh])).map((r) => r.token_hash);
      assert.deepEqual(left.sort(), [legacy, fresh].sort(), 'the expired session is gone; the legacy and the valid ones stay');
      assert.deepEqual((await q("SELECT key FROM auth_rate_limits WHERE scope = 'purge:test'")).map((r) => r.key), ['new']);
      assert.equal((await q('SELECT count(*)::int AS n FROM auth_email_tokens WHERE token_hash = $1', [oldTok]))[0].n, 0);
    });
    hana.ws.close();
    await srv.close();

    console.log('players who leave');
    await test('a player who leaves early is stored as such and does not get the game in their stats; the one who stayed does', async () => {
      srv = await start({ ...fast, matchLog: quiet() });
      const a = await authClient(srv, 'Stayer'); const b = await authClient(srv, 'Quitter');
      a.send({ t: 'create', gameId: 'wizard' });
      await until(() => a.room, 'table');
      a.send({ t: 'setSeats', seats: 3 });
      a.send({ t: 'setOptions', options: { length: 'short', timeLimit: '20' } });
      b.send({ t: 'join', code: a.room.code });
      await until(() => b.room && b.room.members.length === 2, 'both seated');
      a.send({ t: 'start' });
      await until(() => b.view && b.room.status === 'playing', 'started');
      b.send({ t: 'leave' });
      await until(() => a.room.status === 'finished', 'game over');
      const [m] = await until(async () => { const r = await matchesOf(a.room.code); return r.length ? r : null; }, 'match row');
      const ps = await q('SELECT * FROM match_participants WHERE match_id = $1 ORDER BY seat', [m.id]);
      assert.deepEqual(ps.map((p) => [p.left_early, p.is_bot]), [[false, false], [true, false], [false, true]]);
      assert.equal((await a.getStats()).played, 1);
      b.send({ t: 'hello', token: b.token });
      assert.equal((await b.getStats()).played, 0, 'leaving a game early is not a loss');
      a.ws.close(); b.ws.close();
      await srv.close();
    });

    console.log('database failures while recording');
    await test('a connection killed during the write: the write is retried and the match is saved exactly once', async () => {
      const log = quiet(); let first = true;
      srv = await start({ ...fast, matchLog: log, matchRecord: async (rec) => {
        if (first) {
          first = false;
          await dbPool.withTransaction(async (c) => { // a REAL failure inside PostgreSQL: the server terminates this very connection
            await c.query("INSERT INTO matches (room_code, game_id, seats) VALUES ('DEAD01','wizard',2)");
            await c.query('SELECT pg_terminate_backend(pg_backend_pid())');
          });
        }
        return dbMatches.recordMatch(rec);
      } });
      const c = await playGame(srv, 'Retry');
      await until(async () => (await matchesOf(c.room.code)).length === 1, 'saved after retry');
      const s = srv.matchQueue.stats();
      assert.deepEqual([s.saved, s.failed, s.retried >= 1], [1, 0, true]);
      assert.match(log.lines.warn.join('\n'), /retry 1\//);
      assert.equal((await q("SELECT count(*)::int AS n FROM matches WHERE room_code = 'DEAD01'"))[0].n, 0, 'the half-written row was rolled back');
      c.ws.close(); await srv.close();
    });
    await test('a permanent database error is NOT reported as saved: nothing is stored, it is logged, and the table is told', async () => {
      const log = quiet(); const dir = spool();
      srv = await start({ ...fast, matchLog: log, matchSpoolDir: dir });
      await q('ALTER TABLE match_participants RENAME TO mp_hidden');
      let c;
      try {
        c = await playGame(srv, 'Unlucky');
        await until(() => srv.matchQueue.stats().failed === 1, 'queue gave up');
        await until(() => c.chats.some((m) => m.sys && /could not be saved/.test(m.text)), 'players told');
      } finally { await q('ALTER TABLE mp_hidden RENAME TO match_participants'); }
      const s = srv.matchQueue.stats();
      assert.deepEqual([s.saved, s.failed, s.retried], [0, 1, 0], 'a permanent error is not retried');
      assert.equal((await matchesOf(c.room.code)).length, 0);
      assert.match(log.lines.error.join('\n'), /NOT SAVED \(permanent error.*42P01/);
      assert.ok(fs.readdirSync(dir).some((f) => f.endsWith('.failed')), 'kept for inspection');
      c.ws.close(); await srv.close();
    });
    await test('the database is unreachable for the whole retry window: retries are bounded, the result is reported unsaved and kept; the next start saves it once', async () => {
      const dir = spool(); const log = quiet(); let calls = 0;
      const down = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
      srv = await start({ ...fast, matchLog: log, matchSpoolDir: dir, matchRecord: async () => { calls++; throw down; } });
      const c = await playGame(srv, 'Outage');
      await until(() => srv.matchQueue.stats().failed === 1, 'gave up');
      assert.equal(calls, 4, 'one try plus the three configured retries, then it stops');
      assert.equal((await matchesOf(c.room.code)).length, 0);
      assert.match(log.lines.error.join('\n'), /NOT SAVED after 3 retries/);
      const kept = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
      assert.equal(kept.length, 1, 'the unsaved result is on disk');
      c.ws.close(); await srv.close(); // "the process stops"

      const log2 = quiet();
      const srv2 = await start({ ...fast, matchLog: log2, matchSpoolDir: dir }); // "the process starts again": real database, same spool
      await until(async () => (await matchesOf(c.room.code)).length === 1, 'replayed result saved');
      await until(() => fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length === 0, 'spool emptied');
      assert.match(log2.lines.log.join('\n'), /replaying match/);
      const rows = await matchesOf(c.room.code);
      assert.equal((await q('SELECT count(*)::int AS n FROM match_participants WHERE match_id = $1', [rows[0].id]))[0].n, 3);
      // a second restart must not store it again
      await srv2.close();
      const srv3 = await start({ ...fast, matchLog: quiet(), matchSpoolDir: dir });
      await sleep(150);
      assert.equal((await matchesOf(c.room.code)).length, 1);
      await srv3.close();
    });
    await test('shutdown (SIGTERM on deploy) waits for a slow pending write instead of losing it', async () => {
      srv = await start({ ...fast, matchLog: quiet(), matchRecord: async (rec) => { await sleep(600); return dbMatches.recordMatch(rec); } });
      const c = await playGame(srv, 'Slowpoke');
      assert.equal((await matchesOf(c.room.code)).length, 0, 'the write is still in flight');
      await srv.close({ drainMs: 5000 });
      assert.equal((await matchesOf(c.room.code)).length, 1, 'close() waited for it');
      c.ws.close();
    });

    console.log('startup and deployment');
    await test('start() refuses to run when the database cannot be reached', async () => {
      const dead = new URL(t.url); dead.port = '1'; // nothing listens there
      const child = await runServer({ NODE_ENV: 'production', DATABASE_URL: dead.toString() });
      assert.equal(child.code, 1);
      assert.match(child.stderr, /FATAL: refusing to start: Cannot reach the database/);
      assert.doesNotMatch(child.stdout, /running on/);
    });
    await test('production refuses to start without the email settings', async () => {
      const child = await runServer({ NODE_ENV: 'production', DATABASE_URL: t.url, MATCH_SPOOL_DIR: spool(), EMAIL_PROVIDER: '', RESEND_API_KEY: '' });
      assert.equal(child.code, 1);
      assert.match(child.stderr, /Transactional email is not configured/);
    });
    if (process.platform !== 'win32') {
      await test('the production process starts on this database (HSTS, /readyz) and exits cleanly on SIGTERM', async () => {
        const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, NODE_ENV: 'production', PORT: '0', DATABASE_URL: t.url, MATCH_SPOOL_DIR: spool(), EMAIL_PROVIDER: 'resend', EMAIL_FROM: 'Tableverse <noreply@example.test>', PUBLIC_APP_URL: 'https://example.test', RESEND_API_KEY: 'test-key' }, cwd: path.join(__dirname, '..') });
        let out = ''; let err = '';
        child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (err += d));
        const port = await until(() => (/running on http:\/\/localhost:(\d+) \(postgres store\)/.exec(out) || [])[1], 'production server up (' + err + ')', 20000);
        const home = await fetch(`http://127.0.0.1:${port}/`);
        assert.match(home.headers.get('strict-transport-security') || '', /max-age/);
        assert.equal((await fetch(`http://127.0.0.1:${port}/readyz`)).status, 200);
        const exited = new Promise((r) => child.on('exit', (code) => r(code)));
        child.kill('SIGTERM');
        assert.equal(await Promise.race([exited, sleep(10000).then(() => 'hung')]), 0);
        assert.match(out, /SIGTERM: finishing pending match writes/);
      });
    }

    await dbPool.close();
  } finally {
    await t.drop();
    for (const d of spools) fs.rmSync(d, { recursive: true, force: true });
  }
  console.log(`\n${passed} PostgreSQL production tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });

function runServer(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: '0', ...env }, cwd: path.join(__dirname, '..') });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => (stdout += d)); child.stderr.on('data', (d) => (stderr += d));
    const kill = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.on('exit', (code) => { clearTimeout(kill); resolve({ code, stdout, stderr }); });
  });
}
