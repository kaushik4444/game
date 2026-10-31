'use strict';
require('./helpers/env');
// PostgreSQL mode: migrations, players, match recording and stats against a REAL database.
// Runs only with TEST_DATABASE_URL (a server where we may CREATE DATABASE); every run uses its own throw-away database.
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const testdb = require('./helpers/testdb');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n' + e.stack); process.exitCode = 1; }
}
const uuid = () => crypto.randomUUID();
let dbPlayersRef = null;
/** A real account (a row in players) with a valid uuid: stats are attributed through the foreign key. */
const account = async (name = 'Test') => (await dbPlayersRef.createAnonymousPlayer({ displayName: name })).player.id;
const participant = (over = {}) => ({ playerId: uuid(), name: 'P', seat: 0, score: 0, isWinner: false, isBot: false, leftEarly: false, ...over });
const matchOf = (over = {}) => ({ matchKey: uuid(), roomCode: 'ABCDEF', gameId: 'wizard', seats: 2, options: { length: 'short' }, startedAt: new Date(Date.now() - 60000), participants: [participant({ seat: 0, isWinner: true, score: 90 }), participant({ seat: 1, score: 40 })], ...over });

(async () => {
  const t = await testdb.create(); // exits (SKIPPED) when PostgreSQL tests are not configured
  const extra = [];
  try {
    process.env.DATABASE_URL = t.url; // only now: db/pool.js reads it when it is first required
    const dbPool = require('../db/pool');
    const { migrate } = require('../db/migrate');
    const dbPlayers = require('../db/players');
    dbPlayersRef = dbPlayers;
    const dbAuth = require('../db/auth');
    const { hitRateLimit } = require('../db/rateLimit');
    const dbMatches = require('../db/matches');
    const x = await t.client(); // the test's own connection, to look at the tables

    assert.equal(dbPool.hasDatabase(), true);
    assert.equal(new URL(process.env.DATABASE_URL).pathname.slice(1), t.name, 'tests run on their own throw-away database');

    console.log('migrations');
    await test('three instances starting at once apply every migration exactly once (advisory lock)', async () => {
      const results = await Promise.all([migrate(), migrate(), migrate()]);
      const applied = results.flatMap((r) => r.applied);
      assert.deepEqual(applied.sort(), ['001_init.sql', '002_match_integrity.sql', '003_auth_accounts.sql', '004_auth_hardening.sql']);
      assert.equal((await x.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n, 4);
    });
    await test('running migrations again changes nothing', async () => {
      assert.deepEqual((await migrate()).applied, []);
    });
    await test('the schema has the integrity columns and the partial unique index', async () => {
      const cols = (await x.query("SELECT column_name FROM information_schema.columns WHERE table_name IN ('matches','match_participants')")).rows.map((r) => r.column_name);
      assert.ok(cols.includes('match_key') && cols.includes('left_early'));
      const idx = (await x.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_matches_match_key'")).rows[0].indexdef;
      assert.match(idx, /UNIQUE/);
      assert.match(idx, /WHERE \(match_key IS NOT NULL\)/);
    });
    await test('auth session index predicate is immutable (no NOW)', async () => {
      const idx = (await x.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_auth_sessions_valid'"));
      assert.ok(idx.rows.length, 'idx_auth_sessions_valid exists');
      assert.doesNotMatch(idx.rows[0].indexdef, /NOW\(/i);
      assert.match(idx.rows[0].indexdef, /WHERE \(revoked_at IS NULL\)/i);
    });
    await test('upgrade from main schema to 003 succeeds (auth migration has no volatile index predicate)', async () => {
      const old = await t.another(); extra.push(old.name);
      const fs = require('node:fs');
      const pg = require('pg');
      const c = new pg.Client({ connectionString: old.url });
      await c.connect();
      try {
        const sql001 = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '001_init.sql'), 'utf8');
        const sql002 = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '002_match_integrity.sql'), 'utf8');
        await c.query(sql001);
        await c.query(sql002);
        await c.query("INSERT INTO schema_migrations (version) VALUES ('001_init.sql'), ('002_match_integrity.sql')");
        const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'db', 'migrate.js')], { env: { ...process.env, DATABASE_URL: old.url }, encoding: 'utf8', timeout: 30000 });
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /Applied: 003_auth_accounts\.sql/);
        const idx3 = await c.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_auth_sessions_valid'");
        assert.ok(idx3.rows.length === 1, 'idx_auth_sessions_valid created by 003');
        assert.doesNotMatch(idx3.rows[0].indexdef, /NOW\(/i);
      } finally { await c.end(); }
    });
    await test('upgrade from the schema that is live today (001 only, with old rows): 002 applies and old data survives', async () => {
      const old = await t.another(); extra.push(old.name);
      const fs = require('node:fs');
      const pg = require('pg');
      const c = new pg.Client({ connectionString: old.url });
      await c.connect();
      try {
        const sql001 = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '001_init.sql'), 'utf8');
        await c.query(sql001);
        await c.query("INSERT INTO schema_migrations (version) VALUES ('001_init.sql')");
        const p = (await c.query("INSERT INTO players (display_name) VALUES ('Old') RETURNING id")).rows[0].id;
        const m = (await c.query("INSERT INTO matches (room_code, game_id, seats) VALUES ('OLD001','wizard',2) RETURNING id")).rows[0].id;
        await c.query("INSERT INTO match_participants (match_id, player_id, player_name, seat, score, is_winner, is_bot) VALUES ($1,$2,'Old',0,0,false,false)", [m, p]);
        const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'db', 'migrate.js')], { env: { ...process.env, DATABASE_URL: old.url }, encoding: 'utf8', timeout: 30000 });
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /Applied: 002_match_integrity\.sql/);
        assert.doesNotMatch(r.stdout, /Applying migration: 001/);
        const kept = (await c.query('SELECT m.match_key, mp.left_early FROM matches m JOIN match_participants mp ON mp.match_id = m.id')).rows;
        assert.deepEqual(kept, [{ match_key: null, left_early: false }], 'old rows are kept, with the new columns filled safely');
      } finally { await c.end(); }
    });
    await test('a failing migration leaves the database exactly as it was (all or nothing)', async () => {
      const fs = require('node:fs');
      const dir = path.join(__dirname, '..', 'db', 'migrations');
      const bad = path.join(dir, '999_test_broken.sql');
      fs.writeFileSync(bad, 'CREATE TABLE tv_should_not_exist (id int); SELECT * FROM table_that_does_not_exist;');
      try {
        await assert.rejects(migrate(), /table_that_does_not_exist/);
      } finally { fs.unlinkSync(bad); }
      assert.equal((await x.query("SELECT to_regclass('tv_should_not_exist') AS t")).rows[0].t, null);
      assert.equal((await x.query("SELECT count(*)::int AS n FROM schema_migrations WHERE version LIKE '999%'")).rows[0].n, 0);
    });
    await test('upgrade from the schema that is live today (001 only, with old rows): 002 applies and old data survives', async () => {
      const old = await t.another(); extra.push(old.name);
      const fs = require('node:fs');
      const pg = require('pg');
      const c = new pg.Client({ connectionString: old.url });
      await c.connect();
      try {
        const sql001 = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '001_init.sql'), 'utf8');
        await c.query(sql001);
        await c.query("INSERT INTO schema_migrations (version) VALUES ('001_init.sql')");
        const p = (await c.query("INSERT INTO players (display_name) VALUES ('Old') RETURNING id")).rows[0].id;
        const m = (await c.query("INSERT INTO matches (room_code, game_id, seats) VALUES ('OLD001','wizard',2) RETURNING id")).rows[0].id;
        await c.query("INSERT INTO match_participants (match_id, player_id, player_name, seat, score, is_winner, is_bot) VALUES ($1,$2,'Old',0,0,false,false)", [m, p]);
        const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'db', 'migrate.js')], { env: { ...process.env, DATABASE_URL: old.url }, encoding: 'utf8', timeout: 30000 });
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /Applied: 002_match_integrity\.sql/);
        assert.doesNotMatch(r.stdout, /Applying migration: 001/);
        const kept = (await c.query('SELECT m.match_key, mp.left_early FROM matches m JOIN match_participants mp ON mp.match_id = m.id')).rows;
        assert.deepEqual(kept, [{ match_key: null, left_early: false }], 'old rows are kept, with the new columns filled safely');
      } finally { await c.end(); }
    });

    console.log('players');
    await test('anonymous players get a uuid, the token is stored only as a SHA-256 hash, bad tokens are rejected', async () => {
      const a = await dbPlayers.createAnonymousPlayer({ displayName: 'Alice', avatar: '🦊' });
      assert.match(a.player.id, /^[0-9a-f-]{36}$/);
      assert.equal((await dbPlayers.authenticateToken(a.rawToken)).id, a.player.id);
      assert.equal(await dbPlayers.authenticateToken('not-a-token'), null);
      const rows = (await x.query('SELECT token_hash FROM auth_sessions WHERE player_id = $1', [a.player.id])).rows;
      assert.equal(rows.length, 1);
      assert.notEqual(rows[0].token_hash, a.rawToken);
      assert.equal(rows[0].token_hash, crypto.createHash('sha256').update(a.rawToken).digest('hex'));
      const up = await dbPlayers.updateProfile(a.player.id, { displayName: 'Alice 2', avatar: '🦄' });
      assert.deepEqual([up.display_name, up.avatar], ['Alice 2', '🦄']);
    });

    console.log('authentication');
    await test('registration stores permanent identity, argon2 hash, verify token hash and session', async () => {
      const out = await dbAuth.registerEmail({ email: `auth.${Date.now()}@test.local`, username: 'wizardhero', password: 'TestPass123!', displayName: 'Wizard Hero', avatar: '🧙' });
      assert.ok(out.token && out.verifyToken);
      const p = (await x.query('SELECT id, username, is_anonymous FROM players WHERE id = $1', [out.player.id])).rows[0];
      assert.deepEqual([p.username, p.is_anonymous], ['wizardhero', false]);
      const id = (await x.query("SELECT provider, provider_user_id, email, password_hash, email_verified_at FROM auth_identities WHERE player_id = $1", [out.player.id])).rows[0];
      assert.equal(id.provider, 'email');
      assert.equal(id.provider_user_id, out.email);
      assert.ok(/^\$argon2id\$/.test(id.password_hash), 'password hash must be argon2id');
      assert.notEqual(id.password_hash, 'TestPass123!');
      assert.equal(id.email_verified_at, null);
      const tok = (await x.query('SELECT token_hash, purpose, used_at FROM auth_email_tokens WHERE player_id = $1 ORDER BY created_at DESC LIMIT 1', [out.player.id])).rows[0];
      assert.equal(tok.purpose, 'verify_email');
      assert.equal(tok.used_at, null);
      assert.equal(tok.token_hash.length, 64);
      const sess = (await x.query('SELECT token_hash, revoked_at, expires_at FROM auth_sessions WHERE player_id = $1 ORDER BY created_at DESC LIMIT 1', [out.player.id])).rows[0];
      assert.equal(sess.token_hash.length, 64);
      assert.equal(sess.revoked_at, null);
      assert.ok(sess.expires_at);
    });
    await test('duplicate email and case-insensitive duplicate username are rejected', async () => {
      const email = `dupe.${Date.now()}@test.local`;
      await dbAuth.registerEmail({ email, username: 'sameuser1', password: 'TestPass123!', displayName: 'A' });
      await assert.rejects(dbAuth.registerEmail({ email, username: 'sameuser2', password: 'TestPass123!', displayName: 'B' }), /already exists/i);
      await assert.rejects(dbAuth.registerEmail({ email: `other.${Date.now()}@test.local`, username: 'SAMEUSER1', password: 'TestPass123!', displayName: 'C' }), /username is already taken/i);
    });
    await test('concurrent registration for the same username allows only one success', async () => {
      const username = `raceuser${String(Date.now()).slice(-6)}`;
      const emailA = `race.a.${Date.now()}@test.local`;
      const emailB = `race.b.${Date.now()}@test.local`;
      const [a, b] = await Promise.allSettled([
        dbAuth.registerEmail({ email: emailA, username, password: 'TestPass123!', displayName: 'A' }),
        dbAuth.registerEmail({ email: emailB, username: username.toUpperCase(), password: 'TestPass123!', displayName: 'B' }),
      ]);
      const ok = [a, b].filter((r) => r.status === 'fulfilled').length;
      assert.equal(ok, 1);
    });
    await test('invalid login credentials are rejected and unverified sessions cannot enter websocket lobby', async () => {
      const email = `uv.${Date.now()}@test.local`;
      const reg = await dbAuth.registerEmail({ email, username: `uv${String(Date.now()).slice(-6)}`, password: 'TestPass123!', displayName: 'UV' });
      await assert.rejects(dbAuth.loginEmail({ email, password: 'bad-pass' }), /invalid email or password/i);
      const info = await dbAuth.sessionInfo(reg.token);
      assert.equal(info.authenticated, true);
      assert.equal(info.emailVerified, false, 'an unverified account has a session but is not allowed into the lobby');
    });
    await test('verification token is single-use and concurrency-safe', async () => {
      const email = `verify.${Date.now()}@test.local`;
      const reg = await dbAuth.registerEmail({ email, username: `verify${String(Date.now()).slice(-6)}`, password: 'TestPass123!', displayName: 'V' });
      await dbAuth.verifyEmailToken(reg.verifyToken);
      await assert.rejects(dbAuth.verifyEmailToken(reg.verifyToken), /already been used/i);
      assert.equal((await dbAuth.sessionInfo(reg.token)).emailVerified, true);

      const reg2 = await dbAuth.registerEmail({ email: `verify2.${Date.now()}@test.local`, username: `verifyb${String(Date.now()).slice(-6)}`, password: 'TestPass123!', displayName: 'V2' });
      const settled = await Promise.allSettled([dbAuth.verifyEmailToken(reg2.verifyToken), dbAuth.verifyEmailToken(reg2.verifyToken)]);
      assert.equal(settled.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(settled.filter((r) => r.status === 'rejected').length, 1);
    });
    await test('password-reset token is single-use, concurrency-safe, and revokes all existing sessions', async () => {
      const email = `reset.${Date.now()}@test.local`;
      const reg = await dbAuth.registerEmail({ email, username: `reset${String(Date.now()).slice(-6)}`, password: 'TestPass123!', displayName: 'R' });
      await dbAuth.verifyEmailToken(reg.verifyToken);
      const login2 = await dbAuth.loginEmail({ email, password: 'TestPass123!' });
      const req = await dbAuth.requestPasswordReset({ email });
      const settled = await Promise.allSettled([
        dbAuth.resetPassword({ token: req.resetToken, newPassword: 'NewPass123!' }),
        dbAuth.resetPassword({ token: req.resetToken, newPassword: 'NewPass123!' }),
      ]);
      assert.equal(settled.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(settled.filter((r) => r.status === 'rejected').length, 1);
      await assert.rejects(dbAuth.loginEmail({ email, password: 'TestPass123!' }), /invalid email or password/i);
      await dbAuth.loginEmail({ email, password: 'NewPass123!' });
      const active = (await x.query('SELECT count(*)::int AS n FROM auth_sessions WHERE player_id = $1 AND revoked_at IS NULL', [reg.player.id])).rows[0].n;
      assert.equal(active, 1, 'only the newest login remains active after reset');
      const old1 = await dbPlayers.authenticateToken(reg.token);
      const old2 = await dbPlayers.authenticateToken(login2.token);
      assert.equal(old1, null);
      assert.equal(old2, null);
    });
    await test('expired verification and reset tokens are rejected', async () => {
      const email = `exp.${Date.now()}@test.local`;
      const reg = await dbAuth.registerEmail({ email, username: `exp${String(Date.now()).slice(-6)}`, password: 'TestPass123!', displayName: 'E' });
      const vh = crypto.createHash('sha256').update(reg.verifyToken).digest('hex');
      await x.query("UPDATE auth_email_tokens SET expires_at = NOW() - INTERVAL '1 minute' WHERE token_hash = $1", [vh]);
      await assert.rejects(dbAuth.verifyEmailToken(reg.verifyToken), /expired/i);

      const email2 = `exp2.${Date.now()}@test.local`;
      const reg2 = await dbAuth.registerEmail({ email: email2, username: `expb${String(Date.now()).slice(-6)}`, password: 'TestPass123!', displayName: 'E2' });
      await dbAuth.verifyEmailToken(reg2.verifyToken);
      const req = await dbAuth.requestPasswordReset({ email: email2 });
      const rh = crypto.createHash('sha256').update(req.resetToken).digest('hex');
      await x.query("UPDATE auth_email_tokens SET expires_at = NOW() - INTERVAL '1 minute' WHERE token_hash = $1", [rh]);
      await assert.rejects(dbAuth.resetPassword({ token: req.resetToken, newPassword: 'Another123!' }), /expired/i);
    });
    await test('session expiry and revokeAll/revokeCurrent semantics are enforced', async () => {
      const email = `sess.${Date.now()}@test.local`;
      const reg = await dbAuth.registerEmail({ email, username: `sess${String(Date.now()).slice(-6)}`, password: 'TestPass123!', displayName: 'S' });
      await dbAuth.verifyEmailToken(reg.verifyToken);
      const login2 = await dbAuth.loginEmail({ email, password: 'TestPass123!' });
      const other = await dbAuth.registerEmail({ email: `sess.other.${Date.now()}@test.local`, username: `other${String(Date.now()).slice(-6)}`, password: 'TestPass123!', displayName: 'O' });
      await dbAuth.verifyEmailToken(other.verifyToken);

      await dbAuth.revokeSession(reg.token);
      assert.equal(await dbPlayers.authenticateToken(reg.token), null);
      assert.ok(await dbPlayers.authenticateToken(login2.token));

      const all = await dbAuth.revokeAllSessionsForCurrent(login2.token);
      assert.ok(all.revoked >= 1);
      assert.equal(await dbPlayers.authenticateToken(login2.token), null);
      assert.ok(await dbPlayers.authenticateToken(other.token), 'other account session must remain');

      const newLogin = await dbAuth.loginEmail({ email, password: 'TestPass123!' });
      const h = crypto.createHash('sha256').update(newLogin.token).digest('hex');
      await x.query("UPDATE auth_sessions SET expires_at = NOW() - INTERVAL '1 minute' WHERE token_hash = $1", [h]);
      assert.equal(await dbPlayers.authenticateToken(newLogin.token), null);
    });
    await test('shared PostgreSQL auth rate limiting increments and enforces limits', async () => {
      const k = `ip-${Date.now()}`;
      const a = await hitRateLimit({ scope: 'auth:test:ip', key: k, limit: 2, windowMs: 60000 });
      const b = await hitRateLimit({ scope: 'auth:test:ip', key: k, limit: 2, windowMs: 60000 });
      const c = await hitRateLimit({ scope: 'auth:test:ip', key: k, limit: 2, windowMs: 60000 });
      assert.equal(a.allowed, true);
      assert.equal(b.allowed, true);
      assert.equal(c.allowed, false);
      const row = (await x.query('SELECT count FROM auth_rate_limits WHERE scope = $1 AND key = $2 ORDER BY window_start DESC LIMIT 1', ['auth:test:ip', k])).rows[0];
      assert.ok(row && Number(row.count) >= 3);
    });

    console.log('recording matches');
    await test('a match and its participants are stored with the right fields; bots and unknown ids have no player', async () => {
      const human = await account('Hana');
      const m = matchOf({ participants: [participant({ playerId: human, name: 'Hana', seat: 0, score: 120, isWinner: true }), participant({ playerId: 'bot_ab12', name: 'Merlin', seat: 1, score: 80, isBot: true }), participant({ playerId: 'p_not-a-uuid', name: 'Odd', seat: 2, score: 10, leftEarly: true })] });
      const r = await dbMatches.recordMatch(m);
      assert.ok(r.matchId && !r.duplicate);
      const row = (await x.query('SELECT * FROM matches WHERE id = $1', [r.matchId])).rows[0];
      assert.deepEqual([row.match_key, row.room_code, row.game_id, row.seats, row.options], [m.matchKey, 'ABCDEF', 'wizard', 2, { length: 'short' }]);
      assert.ok(row.finished_at >= row.started_at);
      const ps = (await x.query('SELECT * FROM match_participants WHERE match_id = $1 ORDER BY seat', [r.matchId])).rows;
      assert.deepEqual(ps.map((p) => [p.player_id, p.player_name, p.score, p.is_winner, p.is_bot, p.left_early]), [
        [human, 'Hana', 120, true, false, false],
        [null, 'Merlin', 80, false, true, false],
        [null, 'Odd', 10, false, false, true],
      ]);
    });
    await test('a participant id that has no account row is stored without an account instead of failing the whole match', async () => {
      const ghost = uuid();
      const r = await dbMatches.recordMatch(matchOf({ participants: [participant({ playerId: ghost, seat: 0, isWinner: true }), participant({ seat: 1 })] }));
      assert.ok(r.matchId);
      assert.equal((await x.query('SELECT count(*)::int AS n FROM match_participants WHERE player_id = $1', [ghost])).rows[0].n, 0);
      assert.equal((await x.query('SELECT count(*)::int AS n FROM match_participants WHERE match_id = $1', [r.matchId])).rows[0].n, 2);
    });
    await test('the same match key twice stores one match, answers duplicate, and adds no participants', async () => {
      const m = matchOf();
      const first = await dbMatches.recordMatch(m);
      const second = await dbMatches.recordMatch(m);
      assert.ok(first.matchId);
      assert.deepEqual(second, { matchId: null, duplicate: true });
      assert.equal((await x.query('SELECT count(*)::int AS n FROM matches WHERE match_key = $1', [m.matchKey])).rows[0].n, 1);
      assert.equal((await x.query('SELECT count(*)::int AS n FROM match_participants WHERE match_id = $1', [first.matchId])).rows[0].n, 2);
    });
    await test('ten concurrent writers of one match key: exactly one wins, none fail', async () => {
      const m = matchOf();
      const res = await Promise.all(Array.from({ length: 10 }, () => dbMatches.recordMatch(m)));
      assert.equal(res.filter((r) => r.matchId).length, 1);
      assert.equal(res.filter((r) => r.duplicate).length, 9);
      assert.equal((await x.query('SELECT count(*)::int AS n FROM match_participants mp JOIN matches m ON m.id = mp.match_id WHERE m.match_key = $1', [m.matchKey])).rows[0].n, 2);
    });
    await test('a write that fails half way leaves nothing behind (no match row without its participants) and REJECTS', async () => {
      const m = matchOf({ participants: [participant({ seat: 0 }), participant({ seat: 1, score: 'not a number' })] });
      const err = await dbMatches.recordMatch(m).then(() => null, (e) => e);
      assert.ok(err, 'the failure is reported to the caller, never swallowed');
      assert.equal(err.code, '22P02'); // invalid_text_representation: a permanent data error
      assert.equal((await x.query('SELECT count(*)::int AS n FROM matches WHERE match_key = $1', [m.matchKey])).rows[0].n, 0);
    });
    await test('a missing table is reported as an error with its SQLSTATE (so the queue can tell it is not transient)', async () => {
      await x.query('ALTER TABLE match_participants RENAME TO mp_tmp');
      try {
        const err = await dbMatches.recordMatch(matchOf()).then(() => null, (e) => e);
        assert.equal(err && err.code, '42P01');
      } finally { await x.query('ALTER TABLE mp_tmp RENAME TO match_participants'); }
    });
    await test('a connection killed in the middle of the write is a transient error and the pool recovers afterwards', async () => {
      const { isTransient } = require('../db/matchQueue');
      let err = null;
      try {
        await dbPool.withTransaction(async (c) => {
          await c.query("INSERT INTO matches (room_code, game_id, seats) VALUES ('KILL01','wizard',2)");
          await c.query('SELECT pg_terminate_backend(pg_backend_pid())');
        });
      } catch (e) { err = e; }
      assert.ok(err && isTransient(err), 'got ' + (err && (err.code || err.message)));
      assert.equal((await x.query("SELECT count(*)::int AS n FROM matches WHERE room_code = 'KILL01'")).rows[0].n, 0, 'the half-written match was rolled back');
      assert.ok((await dbMatches.recordMatch(matchOf())).matchId, 'the next write works');
    });

    console.log('stats from the database');
    await test('stats count real games only, win/loss follow is_winner, and bots, early leavers and legacy rows are excluded', async () => {
      const me = await account('Me'); const quitter = await account('Quitter');
      const mk = (gameId, myScore, win, extra = {}) => matchOf({ gameId, participants: [participant({ playerId: me, name: 'Me', seat: 0, score: myScore, isWinner: win }), participant({ playerId: quitter, name: 'Q', seat: 1, leftEarly: true, isWinner: !win }), participant({ playerId: 'bot_1', name: 'B', seat: 2, isBot: true })], ...extra });
      await dbMatches.recordMatch(mk('wizard', 150, true));
      await dbMatches.recordMatch(mk('wizard', 60, false));
      await dbMatches.recordMatch(mk('poker', 3000, true, { options: { chips: '1000' } }));
      await dbMatches.recordMatch(mk('themind', 8, true, { seats: 3 }));
      await dbMatches.recordMatch(mk('twentynine', 6, false));
      // a legacy match written before results existed: no key, nobody marked as winner
      const legacy = (await x.query("INSERT INTO matches (room_code, game_id, seats) VALUES ('LEG001','wizard',2) RETURNING id")).rows[0].id;
      await x.query("INSERT INTO match_participants (match_id, player_id, player_name, seat, score, is_winner, is_bot) VALUES ($1,$2,'Me',0,0,false,false)", [legacy, me]);

      assert.deepEqual(await dbMatches.getPlayerStats(me), { played: 5, wins: 3, losses: 2 });
      assert.deepEqual(await dbMatches.getPlayerStats(quitter), { played: 0, wins: 0, losses: 0 }, 'leaving early is not a loss');
      const p = await dbMatches.getPlayerProfile(me, { memberSince: new Date(0) });
      assert.deepEqual([p.played, p.wins, p.losses, p.winRate], [5, 3, 2, 60]);
      const by = Object.fromEntries(p.perGame.map((g) => [g.gameId, g]));
      assert.deepEqual([by.wizard.played, by.wizard.wins, by.wizard.best, by.wizard.bestLabel], [2, 1, 150, 'Highest score']);
      assert.deepEqual([by.poker.best, by.poker.bestText], [3, '×3']);
      assert.deepEqual([by.themind.kind, by.themind.best, by.twentynine.kind, by.twentynine.best], ['coop', 8, 'team', null]);
      assert.equal(p.favouriteGame, 'wizard');
      assert.equal(p.recent.length, 5);
      assert.equal(p.memberSince, new Date(0).toISOString());
    });
    await test('asking for the stats of something that is not an account id gives an empty record, not a database error', async () => {
      assert.deepEqual(await dbMatches.getPlayerStats('sx'), { played: 0, wins: 0, losses: 0 });
      assert.equal((await dbMatches.getPlayerProfile('p_123')).played, 0);
    });
    await test('a database failure while reading stats is an error, not a misleading zero', async () => {
      await x.query('ALTER TABLE matches RENAME TO matches_tmp');
      try {
        await assert.rejects(dbMatches.getPlayerProfile(uuid()), /matches/);
        await assert.rejects(dbMatches.getPlayerStats(uuid()), /matches/);
      } finally { await x.query('ALTER TABLE matches_tmp RENAME TO matches'); }
    });

    await dbPool.close();
  } finally {
    await t.drop(...extra);
  }
  console.log(`\n${passed} PostgreSQL database tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
