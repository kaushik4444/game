'use strict';
require('./helpers/env');
// Profiles, history, statistics, recent tables and account deletion on a REAL PostgreSQL (throw-away database from
// tests/helpers/testdb.js) through the running server. Runs only with TEST_DATABASE_URL.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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
async function until(fn, label, ms = 30000) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + label); await sleep(25); }
}
const quiet = () => ({ log() {}, warn() {}, error() {} });
const PW = 'TestPass123!';

/** A WebSocket that authenticates with the session cookie only, as a browser does. */
function socket(port, cookie) {
  const c = { msgs: [], closed: null, ws: new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } }) };
  c.ws.on('open', () => c.ws.send(JSON.stringify({ t: 'hello' })));
  c.ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    c.msgs.push(m);
    if (m.t === 'state') { c.room = m.room; c.view = m.view; }
  });
  c.ws.on('close', (code) => { c.closed = code; });
  c.ws.on('error', () => {});
  c.send = (m) => c.ws.send(JSON.stringify(m));
  c.welcome = () => c.msgs.find((m) => m.t === 'welcome');
  return c;
}

(async () => {
  const t = await testdb.create(); // exits (SKIPPED) when PostgreSQL tests are not configured
  const spool = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-acctspool-'));
  process.env.MATCH_SPOOL_DIR = spool;
  try {
    process.env.DATABASE_URL = t.url;
    const dbPool = require('../db/pool');
    const dbMatches = require('../db/matches');
    const dbAccount = require('../db/account');
    const { start } = require('../server');
    const x = await t.client();
    const q = async (sql, params) => (await x.query(sql, params)).rows;
    const fast = { port: 0, trustProxy: false, botDelay: [0, 3], autoAdvanceMs: 20, trickPauseMs: 0, forcedMs: 0, timeScale: 0.01, absentMs: 60000, maxMsgsPerSec: Infinity, matchRetryDelays: [20, 40, 80], matchLog: quiet() };
    const srv = await start(fast);
    assert.equal(srv.database.mode, 'postgres');
    let seq = 1;
    const newUser = async (tag, displayName = tag) => {
      const email = `${tag.toLowerCase()}.${seq++}@test.local`;
      const username = `${tag.toLowerCase()}${seq}`.slice(0, 24);
      const u = await registerAndVerify(srv.port, { email, username, displayName, password: PW });
      const me = (await u.browser.get('/api/auth/session')).json.player;
      return { ...u, email, username: me.username, id: me.id, cookie: u.browser.cookieHeader };
    };
    const record = (over) => dbMatches.recordMatch({ matchKey: crypto.randomUUID(), roomCode: 'ABCDEF', gameId: 'wizard', seats: 3, options: {}, ...over });
    const part = (id, name, o = {}) => ({ playerId: id, name, seat: 0, score: 10, isWinner: false, isBot: false, leftEarly: false, ...o });

    // ------------------------------------------------------------------------------------------ profile privacy
    console.log('profiles');
    await test('the own profile needs a login and includes the email; the public profile shows only the public fields', async () => {
      const anon = new Browser(srv.port); await anon.csrf();
      assert.equal((await anon.get('/api/me/profile')).status, 401);
      assert.equal((await anon.get('/api/me/history')).status, 401);
      assert.equal((await anon.get('/api/me/recent')).status, 401);
      const u = await newUser('Priv', 'Private Pat');
      const own = (await u.browser.get('/api/me/profile')).json;
      assert.equal(own.profile.email, u.email);
      assert.equal(own.profile.username, u.username);
      assert.ok(own.profile.joinedAt);
      const pub = await anon.get(`/api/players/${u.username}`);
      assert.equal(pub.status, 200);
      assert.deepEqual(Object.keys(pub.json.profile).sort(), ['avatar', 'displayName', 'joinedAt', 'played', 'username', 'winRate', 'wins']);
      const raw = JSON.stringify(pub.json);
      for (const secret of [u.email, u.id, 'password', 'token', 'session', 'hash']) assert.ok(!raw.toLowerCase().includes(String(secret).toLowerCase()), 'public profile leaks ' + secret);
      assert.equal(pub.headers.get('cache-control'), 'no-store');
      assert.equal((await anon.get('/api/players/nobody_here_1')).status, 404);
      assert.equal((await anon.get('/api/players/Bad%20Name!')).status, 404);
      assert.equal((await anon.get('/api/players/%E0%A4%A')).status, 404, 'a malformed escape is a 404, not a crash');
    });

    await test('a legacy anonymous player has no profile and no public page', async () => {
      const id = (await q("INSERT INTO players (display_name, is_anonymous) VALUES ('Guesty', TRUE) RETURNING id"))[0].id;
      assert.equal(await dbAccount.getPublicProfile('guesty'), null);
      await q('DELETE FROM players WHERE id = $1', [id]);
    });

    await test('display names: validated on the server, cleaned, CSRF protected, and visible to new sockets', async () => {
      const u = await newUser('Namer', 'Namer One');
      const post = (name, opts) => u.browser.post('/api/me/display-name', { displayName: name }, opts);
      assert.equal((await post('a')).status, 400);
      assert.equal((await post('   ')).status, 400);
      assert.equal((await post('x'.repeat(21))).status, 400);
      assert.equal((await post(null)).status, 400);
      assert.equal((await post('Fine Name', { csrf: false })).status, 403);
      const ok = await post('  Pat   <b>Lee</b> ');
      assert.equal(ok.status, 200);
      assert.equal(ok.json.displayName, 'Pat bLee/b', 'angle brackets and extra spaces are removed');
      assert.equal((await q('SELECT display_name FROM players WHERE id = $1', [u.id]))[0].display_name, 'Pat bLee/b');
      assert.equal((await u.browser.get('/api/me/profile')).json.profile.displayName, 'Pat bLee/b');
      const s = socket(srv.port, u.cookie);
      await until(() => s.welcome(), 'welcome');
      assert.equal(s.welcome().name, 'Pat bLee/b');
      s.ws.close();
    });

    await test('profile picture: only the fixed avatars, own account only, CSRF protected, saved and visible everywhere', async () => {
      const u = await newUser('Pic', 'Pic One');
      const post = (avatar, opts) => u.browser.post('/api/me/avatar', { avatar }, opts);
      for (const bad of ['💀', '', null, 42, {}, ['🦊'], '🦊🦊', 'x'.repeat(200)]) assert.equal((await post(bad)).status, 400, JSON.stringify(bad));
      assert.equal((await post('🦊', { csrf: false })).status, 403);
      const anon = new Browser(srv.port); await anon.csrf();
      assert.equal((await anon.post('/api/me/avatar', { avatar: '🦊' })).status, 401, 'signed-out callers are refused');
      const ok = await post('🦊');
      assert.equal(ok.status, 200);
      assert.equal(ok.json.avatar, '🦊');
      assert.equal((await q('SELECT avatar FROM players WHERE id = $1', [u.id]))[0].avatar, '🦊');
      assert.equal((await u.browser.get('/api/me/profile')).json.profile.avatar, '🦊');
      const pub = await anon.get('/api/players/' + u.username);
      assert.equal(pub.json.profile.avatar, '🦊');
      const s = socket(srv.port, u.cookie);
      await until(() => s.welcome(), 'welcome');
      assert.equal(s.welcome().avatar, '🦊');
      s.ws.close();
    });

    // ------------------------------------------------------------------------------------------ history and statistics
    console.log('history and statistics');
    await test('history lists only real finished games, newest first, in pages; statistics count only what should count', async () => {
      const a = await newUser('Hist', 'Hist Ana');
      const other = await newUser('Other', 'Other Olga');
      // 12 wins and 13 losses recorded the normal way (24 + the early leaver below), each with a bot and another human
      for (let i = 0; i < 25; i++) {
        await record({ roomCode: 'R' + String(i).padStart(5, '0'), participants: [part(a.id, 'Hist Ana', { seat: 0, isWinner: i % 2 === 0 }), part(other.id, 'Other Olga', { seat: 1, isWinner: i % 2 === 1 }), part(null, 'Bot Bo', { seat: 2, isBot: true })] });
        await q("UPDATE matches SET finished_at = NOW() - ($1 || ' minutes')::interval WHERE room_code = $2", [String(100 - i), 'R' + String(i).padStart(5, '0')]);
      }
      // one game she left early (listed, never counted), one game with no result (no match_key), one duplicate submission
      await record({ roomCode: 'LEFT01', participants: [part(a.id, 'Hist Ana', { seat: 0, leftEarly: true }), part(null, 'Bot Bo', { seat: 1, isBot: true })] });
      await q("WITH m AS (INSERT INTO matches (room_code, game_id, seats) VALUES ('OLD001','wizard',3) RETURNING id) INSERT INTO match_participants (match_id, player_id, player_name, seat, is_winner) SELECT id, $1, 'Hist Ana', 0, TRUE FROM m", [a.id]);
      const key = crypto.randomUUID();
      const dupOne = await record({ matchKey: key, roomCode: 'DUP001', participants: [part(a.id, 'Hist Ana', { isWinner: true })] });
      const dupTwo = await record({ matchKey: key, roomCode: 'DUP001', participants: [part(a.id, 'Hist Ana', { isWinner: true })] });
      assert.ok(dupOne.matchId && dupTwo.duplicate === true, 'the same game submitted twice is stored once');

      const h1 = (await a.browser.get('/api/me/history?page=1')).json;
      assert.equal(h1.total, 27, '25 + the early leaver + one duplicate-key game; the unfinished (no key) game is not listed');
      assert.equal(h1.pages, 3); assert.equal(h1.pageSize, 10); assert.equal(h1.items.length, 10);
      const h3 = (await a.browser.get('/api/me/history?page=3')).json;
      assert.equal(h3.items.length, 7);
      const seen = new Set();
      for (const p of [1, 2, 3]) for (const it of (await a.browser.get(`/api/me/history?page=${p}`)).json.items) seen.add(it.finishedAt + it.result + it.score + Math.random());
      assert.equal(seen.size, 27, 'every game appears on exactly one page');
      assert.deepEqual(Object.keys(h1.items[0]).sort(), ['finishedAt', 'gameId', 'humans', 'result', 'score', 'seats'], 'a history row names no other player');
      const all = [];
      for (const p of [1, 2, 3]) all.push(...(await a.browser.get(`/api/me/history?page=${p}`)).json.items);
      assert.ok(all.every((it, i) => i === 0 || all[i - 1].finishedAt >= it.finishedAt), 'newest first');
      assert.equal(all.filter((it) => it.result === 'left').length, 1);
      assert.equal((await a.browser.get('/api/me/history?page=99')).json.page, 3, 'a page past the end is clamped');
      assert.equal((await a.browser.get('/api/me/history?page=-4')).json.page, 1);
      assert.equal((await a.browser.get('/api/me/history?page=abc')).json.page, 1);

      const stats = (await a.browser.get('/api/me/profile')).json.stats;
      assert.equal(stats.played, 26, 'the early leaver and the result-less game are not counted');
      assert.equal(stats.wins, 13 + 0 + 1 - 0, '13 even-numbered wins + the duplicate-key game');
      assert.equal(stats.wins + stats.losses, stats.played);
      assert.equal(stats.winRate, Math.round((stats.wins / stats.played) * 1000) / 10);
      assert.ok(stats.streak.best >= 1 && stats.recent.length === 10);
      // the other player's record is their own: 12 wins out of 25, and the bot has no account at all
      const o = (await other.browser.get('/api/me/profile')).json.stats;
      assert.deepEqual([o.played, o.wins], [25, 12]);
    });

    await test('lifetime statistics are exact beyond 5,000 games (no row cap)', async () => {
      const big = await newUser('Big', 'Big Bertha');
      await q(`WITH m AS (INSERT INTO matches (room_code, game_id, seats, match_key, finished_at)
                 SELECT 'BIG' || g, 'poker', 3, gen_random_uuid(), NOW() - (g || ' seconds')::interval FROM generate_series(1, 5200) g RETURNING id, room_code)
               INSERT INTO match_participants (match_id, player_id, player_name, seat, score, is_winner)
               SELECT id, $1, 'Big Bertha', 0, 0, (substr(room_code, 4)::int % 4 = 0) FROM m`, [big.id]);
      const s = (await big.browser.get('/api/me/profile')).json.stats;
      assert.equal(s.played, 5200);
      assert.equal(s.wins, 1300);
      assert.equal(s.losses, 3900);
      assert.equal(s.winRate, 25);
      assert.equal(s.perGame[0].played, 5200);
      const h = (await big.browser.get('/api/me/history?page=1')).json;
      assert.equal(h.total, 5200); assert.equal(h.pages, 520);
      assert.equal(s.streak.best, 1, 'wins are every 4th game: the best streak is 1');
    });

    // ------------------------------------------------------------------------------------------ recent tables
    console.log('recent tables');
    await test('recent tables belong to the account: isolated between players, shared between devices, stale ones dropped, clearable', async () => {
      const a = await newUser('Recent', 'Recent Rae');
      const b = await newUser('Recent', 'Recent Rob');
      const sa = socket(srv.port, a.cookie);
      await until(() => sa.welcome(), 'welcome');
      sa.send({ t: 'create', gameId: 'wizard' });
      await until(() => sa.room, 'table');
      const code = sa.room.code;
      const mine = await until(async () => { const r = (await a.browser.get('/api/me/recent')).json; return r.tables.length ? r.tables : null; }, 'recent table saved');
      assert.deepEqual(mine.map((x) => [x.code, x.gameId, x.status]), [[code, 'wizard', 'lobby']]);
      assert.deepEqual((await b.browser.get('/api/me/recent')).json.tables, [], 'another account sees nothing');
      const phone = new Browser(srv.port); await phone.csrf(); await phone.must('/api/auth/login', { email: a.email, password: PW });
      assert.equal((await phone.get('/api/me/recent')).json.tables[0].code, code, 'the list follows the account to a new login');
      a.browser = phone; // one active session per account: logging in on the phone signed the first browser out

      // a failed join does not bump or add anything
      const sb = socket(srv.port, b.cookie);
      await until(() => sb.welcome(), 'welcome b');
      sb.send({ t: 'join', code: 'ZZZZZZ' });
      await sleep(200);
      assert.deepEqual((await b.browser.get('/api/me/recent')).json.tables, []);
      sb.send({ t: 'join', code });
      await until(() => sb.room, 'b joined');
      assert.equal((await until(async () => { const r = (await b.browser.get('/api/me/recent')).json; return r.tables.length ? r : null; }, 'b recent')).tables[0].code, code);

      // a code that no longer exists is removed instead of shown
      await q("INSERT INTO player_recent_tables (player_id, room_code, game_id) VALUES ($1, 'GONE01', 'poker')", [a.id]);
      const listed = (await a.browser.get('/api/me/recent')).json.tables.map((x) => x.code);
      assert.deepEqual(listed, [code]);
      assert.equal((await q("SELECT count(*)::int AS n FROM player_recent_tables WHERE room_code = 'GONE01'"))[0].n, 0, 'the stale row was deleted');

      // the list keeps at most 6
      for (let i = 0; i < 9; i++) await dbAccount.rememberTable(a.id, { code: 'KEEP0' + i, gameId: 'poker' });
      assert.ok((await dbAccount.listRecentTables(a.id)).length <= dbAccount.RECENT_LIMIT);

      assert.equal((await a.browser.post('/api/me/recent/clear', {}, { csrf: false })).status, 403);
      await a.browser.must('/api/me/recent/clear', {});
      assert.deepEqual((await phone.get('/api/me/recent')).json.tables, []);
      assert.equal((await q('SELECT count(*)::int AS n FROM player_recent_tables WHERE player_id = $1', [a.id]))[0].n, 0);
      assert.equal((await q('SELECT count(*)::int AS n FROM player_recent_tables WHERE player_id = $1', [b.id]))[0].n, 1, 'clearing one account leaves the other alone');
      sa.ws.close(); sb.ws.close();
    });

    // ------------------------------------------------------------------------------------------ deletion
    console.log('account deletion');
    await test('a wrong or missing password, a missing CSRF header or no login all leave the account untouched', async () => {
      const u = await newUser('Keep', 'Keeper');
      assert.equal((await u.browser.post('/api/me/delete-account', { password: 'wrong-password' })).status, 403);
      assert.equal((await u.browser.post('/api/me/delete-account', {})).status, 400);
      assert.equal((await u.browser.post('/api/me/delete-account', { password: PW }, { csrf: false })).status, 403);
      const anon = new Browser(srv.port); await anon.csrf();
      assert.equal((await anon.post('/api/me/delete-account', { password: PW })).status, 401);
      assert.equal((await q('SELECT count(*)::int AS n FROM players WHERE id = $1', [u.id]))[0].n, 1);
      assert.equal((await u.browser.get('/api/auth/session')).json.authenticated, true);
    });

    await test('deleting removes the account, every session, tokens and recent tables, keeps and anonymises the match records, frees the username, and closes open sockets', async () => {
      const u = await newUser('Gone', 'Real Name Zed');
      const friend = await newUser('Friend', 'Friendly Fay');
      // one active session per account: the second login signs the first device (and its socket) out
      const second = new Browser(srv.port); await second.csrf(); await second.must('/api/auth/login', { email: u.email, password: PW });
      const s1 = socket(srv.port, u.cookie); const s2 = socket(srv.port, second.cookieHeader);
      await until(() => s1.msgs.some((m) => m.t === 'authRequired') || s2.welcome(), 'the live session connects');
      assert.equal(s1.welcome(), undefined, 'the retired session cannot connect');
      await until(() => s2.welcome(), 'welcomes');
      await dbAccount.rememberTable(u.id, { code: 'OLD123', gameId: 'wizard' });
      await record({ roomCode: 'KEEP01', participants: [part(u.id, 'Real Name Zed', { seat: 0, isWinner: true }), part(friend.id, 'Friendly Fay', { seat: 1 }), part(null, 'Bot Bo', { seat: 2, isBot: true })] });
      const before = (await friend.browser.get('/api/me/profile')).json.stats;
      assert.equal((await q('SELECT count(*)::int AS n FROM auth_sessions WHERE player_id = $1', [u.id]))[0].n >= 2, true);

      const del = await second.post('/api/me/delete-account', { password: PW });
      assert.equal(del.status, 200, JSON.stringify(del.json));
      assert.equal(del.json.matchesKept, 1);
      assert.match(del.setCookie.find((c) => c.startsWith('ct_session=')) || '', /Max-Age=0/, 'the session cookie is cleared');

      for (const tbl of ['players', 'auth_identities', 'auth_sessions', 'auth_email_tokens', 'player_recent_tables']) {
        const col = tbl === 'players' ? 'id' : 'player_id';
        assert.equal((await q(`SELECT count(*)::int AS n FROM ${tbl} WHERE ${col} = $1`, [u.id]))[0].n, 0, tbl + ' still has rows of the deleted account');
      }
      const rows = await q("SELECT player_id, player_name, is_bot, is_winner FROM match_participants mp JOIN matches m ON m.id = mp.match_id WHERE m.room_code = 'KEEP01' ORDER BY seat");
      assert.equal(rows.length, 3, 'the match and all its seats are kept');
      assert.deepEqual([rows[0].player_id, rows[0].player_name, rows[0].is_winner], [null, 'Deleted player', true], 'the result stays, the identity goes');
      assert.equal(rows[1].player_name, 'Friendly Fay');
      assert.ok(!JSON.stringify(await q('SELECT * FROM match_participants')).includes('Real Name Zed'), 'the real name appears nowhere in the match records');
      assert.deepEqual((await friend.browser.get('/api/me/profile')).json.stats.played, before.played, "the other player's history is unchanged");

      // every session is dead, on every device and every socket
      assert.equal((await u.browser.get('/api/auth/session')).json.authenticated, false);
      assert.equal((await second.get('/api/auth/session')).json.authenticated, false);
      assert.equal((await second.post('/api/auth/login', { email: u.email, password: PW })).status, 401, 'the credentials are gone');
      await until(() => s1.closed !== null && s2.closed !== null, 'sockets closed');
      assert.equal(s2.closed, 4001);
      assert.equal(s1.closed, 1008, 'the retired session was refused at the door');
      const again = socket(srv.port, u.cookie);
      await until(() => again.msgs.some((m) => m.t === 'authRequired') || again.closed !== null, 'old cookie refused');
      assert.equal(again.welcome(), undefined);
      assert.equal((await new Browser(srv.port).get(`/api/players/${u.username}`)).status, 404, 'the public profile is gone');

      // the username and email can be used again by a new account with no history
      const reborn = new Browser(srv.port); await reborn.csrf();
      const reg = await reborn.post('/api/auth/register', { email: u.email, username: u.username, password: PW, displayName: 'Reborn' });
      assert.equal(reg.status < 300, true, 'the same email and username can register again: ' + JSON.stringify(reg.json));
      await reborn.must('/api/auth/verify-email', { token: reg.json.debug.verifyToken });
      await reborn.must('/api/auth/login', { email: u.email, password: PW });
      const stats = (await reborn.get('/api/me/profile')).json.stats;
      assert.equal(stats.played, 0);
      assert.equal((await reborn.get('/api/me/history')).json.total, 0);
    });

    await test('a game that finishes after the account was deleted never brings the real name back (database level)', async () => {
      const u = await newUser('Late', 'Late Larry');
      await dbAccount.deleteAccount(u.id, PW);
      await record({ roomCode: 'LATE01', participants: [part(u.id, 'Late Larry', { seat: 0, isWinner: true }), part(null, 'Bot Bo', { seat: 1, isBot: true })] });
      const rows = await q("SELECT player_id, player_name, is_bot FROM match_participants mp JOIN matches m ON m.id = mp.match_id WHERE m.room_code = 'LATE01' ORDER BY seat");
      assert.deepEqual([rows[0].player_id, rows[0].player_name], [null, 'Deleted player']);
      assert.deepEqual([rows[1].player_name, rows[1].is_bot], ['Bot Bo', true], 'bots keep their names');
    });

    await test('deleting the account while a game is being played: the table forgets the name, the game finishes, and the stored record says Deleted player', async () => {
      const u = await newUser('Live', 'Secret Sam');
      const watcher = await newUser('Watch', 'Watcher Wes');
      const s = socket(srv.port, u.cookie);
      await until(() => s.welcome(), 'welcome');
      s.send({ t: 'create', gameId: 'wizard' });
      await until(() => s.room, 'table');
      const code = s.room.code;
      // a second seated human keeps the game running once the first one is gone (a table with no human left pauses by
      // design); the short turn limit plays for them
      const friend = await newUser('Pal', 'Pal Pat');
      const f = socket(srv.port, friend.cookie);
      await until(() => f.welcome(), 'friend welcome');
      f.send({ t: 'join', code });
      await until(() => f.room && f.room.members.length === 2, 'friend seated');
      s.send({ t: 'setSeats', seats: 3 });
      s.send({ t: 'setOptions', options: { length: 'short', timeLimit: '20' } });
      s.send({ t: 'start' });
      await until(() => s.room && s.room.status === 'playing', 'playing');
      const w = socket(srv.port, watcher.cookie);
      await until(() => w.welcome(), 'watcher welcome');
      w.send({ t: 'join', code });
      await until(() => w.room, 'watching');

      // put the real name into every place it can live: a chat message, and a game log line ("Secret Sam bids N")
      s.send({ t: 'chat', text: 'good luck everyone' });
      await until(() => s.msgs.some((m) => m.t === 'chat' && m.m.text === 'good luck everyone'), 'own chat message echoed');
      const logHas = (c, text) => !!(c.view && (c.view.log || []).some((e) => `${e.by} ${e.card || e.text || ''}`.includes(text)));
      // the short turn limit may play for the human before this bid lands: either way the log names them
      for (let i = 0; i < 40 && !logHas(s, 'Secret Sam'); i++) {
        if (s.view && s.view.myTurn) s.send({ t: 'act', action: { type: 'bid', amount: i % 2 } });
        await sleep(100);
      }
      await until(() => logHas(s, 'Secret Sam') && logHas(w, 'Secret Sam'), 'the real name is in the game log before deleting');
      assert.ok(JSON.stringify(w.msgs).includes('Secret Sam'), 'precondition: the name was visible at the table');

      const mark = w.msgs.length;
      const del = await u.browser.post('/api/me/delete-account', { password: PW });
      assert.equal(del.status, 200, JSON.stringify(del.json));
      await until(() => s.closed === 4001, 'the deleted player\'s socket is closed');
      await until(() => w.msgs.slice(mark).some((m) => m.t === 'state'), 'a state broadcast after the deletion');

      // 1. nothing sent to the watcher after the deletion carries the real name: state, log, players, notices, chat
      const after = w.msgs.slice(mark);
      assert.ok(!JSON.stringify(after).includes('Secret Sam'), 'a broadcast after the deletion still names the player');
      // 2. the latest state: seat list, game players and the earlier log line are anonymised, not dropped
      const latest = after.filter((m) => m.t === 'state').pop();
      assert.ok(latest.room.members.some((m) => m.name === 'Deleted player'), 'the seat shows as Deleted player');
      assert.ok(latest.view.players.some((p) => p.name === 'Deleted player'), "the game's player list shows Deleted player");
      assert.ok(logHas(w, 'Deleted player'), 'the earlier log line is kept, with the anonymous name');
      assert.ok(!logHas(w, 'Secret Sam'), 'no log line names the real person');
      // 3. someone who joins later is handed the chat history and the state: still no real name
      const late = socket(srv.port, (await newUser('Late2', 'Latecomer Lou')).cookie);
      await until(() => late.welcome(), 'late welcome');
      late.send({ t: 'join', code });
      await until(() => late.msgs.some((m) => m.t === 'chatlog') && late.view, 'the history reaches a late joiner');
      const history = late.msgs.find((m) => m.t === 'chatlog').messages;
      assert.ok(!JSON.stringify(late.msgs).includes('Secret Sam'), 'the history handed to a new viewer names the deleted player');
      assert.ok(history.some((c) => c.text === 'good luck everyone' && c.name === 'Deleted player'), 'their chat message stays, under the anonymous name');
      assert.ok(history.some((c) => c.sys && c.text.includes('Deleted player')), 'system lines about them stay, anonymised');
      late.ws.close();
      assert.equal((await q('SELECT count(*)::int AS n FROM players WHERE id = $1', [u.id]))[0].n, 0);

      const [match] = await until(async () => { const r = await q('SELECT id FROM matches WHERE room_code = $1', [code]); return r.length ? r : null; }, 'the game finished and was recorded', 60000);
      const rows = await q('SELECT player_id, player_name, is_bot, left_early FROM match_participants WHERE match_id = $1 ORDER BY seat', [match.id]);
      assert.equal(rows.length, 3);
      assert.ok(rows.every((r) => r.player_name !== 'Secret Sam'), 'the real name is not in the record: ' + JSON.stringify(rows));
      const seat = rows.find((r) => r.player_name === 'Deleted player');
      assert.ok(seat && seat.player_id === null, 'the seat is kept, anonymised and unlinked');
      assert.equal((await q('SELECT count(*)::int AS n FROM match_participants WHERE player_id = $1', [u.id]))[0].n, 0);
      // nothing about the account is left on disk in the spool either
      for (const f of fs.readdirSync(spool)) assert.ok(!fs.readFileSync(path.join(spool, f), 'utf8').includes('Secret Sam'), 'spool file ' + f + ' holds the real name');
      w.ws.close();
    });

    await srv.close();
    await dbPool.close();
    console.log(`\n${passed} account tests passed`);
  } finally {
    fs.rmSync(spool, { recursive: true, force: true });
    await t.drop();
  }
})().catch((e) => { console.error(e); process.exit(1); });
