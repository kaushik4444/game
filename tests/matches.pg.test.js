'use strict';
require('./helpers/env');
// Match lifecycle on a REAL PostgreSQL through the running server: every finished game is stored exactly once, a rematch in the
// same room is a NEW match, and results survive a failing database and a restart. Runs only with TEST_DATABASE_URL.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { registerAndVerify } = require('./helpers/auth');
const testdb = require('./helpers/testdb');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n' + e.stack); process.exitCode = 1; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, ms = 40000) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + label); await sleep(25); }
}
const quiet = () => ({ log() {}, warn() {}, error() {} });

function socket(port, cookie) {
  const c = { msgs: [], closed: null, ws: new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } }) };
  c.ws.on('open', () => c.ws.send(JSON.stringify({ t: 'hello' })));
  c.ws.on('message', (raw) => { const m = JSON.parse(raw); c.msgs.push(m); if (m.t === 'state') { c.room = m.room; c.view = m.view; } if (m.t === 'welcome') c.id = m.id; });
  c.ws.on('close', (code) => { c.closed = code; });
  c.ws.on('error', () => {});
  c.send = (m) => c.ws.send(JSON.stringify(m));
  return c;
}

(async () => {
  const t = await testdb.create(); // exits (SKIPPED) when PostgreSQL tests are not configured
  const spools = [];
  const spool = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-matchspool-')); spools.push(d); return d; };
  process.env.MATCH_SPOOL_DIR = spool();
  try {
    process.env.DATABASE_URL = t.url;
    const dbPool = require('../db/pool');
    const dbMatches = require('../db/matches');
    const { start } = require('../server');
    const x = await t.client();
    const q = async (sql, params) => (await x.query(sql, params)).rows;
    const fast = { port: 0, trustProxy: false, botDelay: [0, 3], autoAdvanceMs: 20, trickPauseMs: 0, forcedMs: 0, timeScale: 0.01, absentMs: 60000, maxMsgsPerSec: Infinity, matchRetryDelays: [20, 40, 80], matchLog: quiet() };
    let seq = 1;
    const login = async (srv, name) => {
      const email = `${name.toLowerCase()}.${seq++}@test.local`;
      const u = await registerAndVerify(srv.port, { email, displayName: name, password: 'TestPass123!' });
      const me = u.player;
      return { ...u, email, id: me.id };
    };
    const open = async (srv, user) => { const s = socket(srv.port, user.browser.cookieHeader); await until(() => s.id, 'welcome'); return s; };
    /** One human (idle: the turn limit plays for them) and two bots, played to the end. */
    async function playToEnd(s, extra = {}) {
      s.send({ t: 'setSeats', seats: 3 });
      s.send({ t: 'setOptions', options: { length: 'short', timeLimit: '20', ...extra } });
      s.send({ t: 'start' });
      await until(() => s.room && s.room.status === 'finished', 'game over');
    }
    const matchesIn = (code) => q('SELECT * FROM matches WHERE room_code = $1 ORDER BY finished_at, id', [code]);

    console.log('consecutive games in one room');
    let srv = await start(fast);
    assert.equal(srv.database.mode, 'postgres');
    const ana = await login(srv, 'Ana');
    await test('a rematch is a new match: two distinct keys, two rows, nothing overwritten, stats and history count both', async () => {
      const s = await open(srv, ana);
      s.send({ t: 'create', gameId: 'wizard' });
      await until(() => s.room, 'table');
      const code = s.room.code;
      await playToEnd(s);
      const [first] = await until(async () => { const r = await matchesIn(code); return r.length ? r : null; }, 'first match stored');
      const firstParts = await q('SELECT * FROM match_participants WHERE match_id = $1 ORDER BY seat', [first.id]);
      s.send({ t: 'rematch' });
      await until(() => s.room.status === 'lobby', 'back in the lobby');
      await playToEnd(s);
      const two = await until(async () => { const r = await matchesIn(code); return r.length === 2 ? r : null; }, 'second match stored');
      assert.notEqual(two[0].match_key, two[1].match_key, 'each game has its own identity');
      assert.equal(two[0].id, first.id, 'the first game was not replaced');
      assert.deepEqual(await q('SELECT * FROM match_participants WHERE match_id = $1 ORDER BY seat', [first.id]), firstParts, 'the first result is unchanged');
      for (const m of two) assert.equal((await q('SELECT count(*)::int AS n FROM match_participants WHERE match_id = $1', [m.id]))[0].n, 3);
      assert.deepEqual(srv.matchQueue.stats(), { saved: 2, duplicates: 0, retried: 0, failed: 0, pending: 0 });
      const h = (await ana.browser.get('/api/me/history')).json;
      assert.equal(h.total, 2);
      assert.equal((await ana.browser.get('/api/me/profile')).json.stats.played, 2);
      s.ws.close();
    });

    await test('nothing is stored for a game that has not finished, and a finished game is stored once however many updates follow', async () => {
      const s = await open(srv, ana);
      s.send({ t: 'create', gameId: 'wizard' });
      await until(() => s.room && s.room.status === 'lobby', 'table');
      const code = s.room.code;
      s.send({ t: 'setSeats', seats: 3 }); s.send({ t: 'setOptions', options: { length: 'short', timeLimit: '20' } }); s.send({ t: 'start' });
      await until(() => s.room.status === 'playing', 'playing');
      await sleep(150);
      assert.equal((await matchesIn(code)).length, 0, 'a running game has no match row');
      await until(() => s.room.status === 'finished', 'game over');
      for (let i = 0; i < 5; i++) { s.send({ t: 'chat', text: 'gg ' + i }); s.send({ t: 'emote', e: '👍' }); }
      await sleep(300);
      await until(async () => (await matchesIn(code)).length === 1, 'one row');
      assert.equal((await matchesIn(code)).length, 1);
      s.ws.close();
    });

    console.log('failure and restart');
    await srv.close({ drainMs: 2000 });
    await test('a database that rejects the write loses nothing: the result waits in the spool, the next start saves it once, a third start adds nothing', async () => {
      const dir = spool();
      let attempts = 0;
      const down = await start({ ...fast, matchSpoolDir: dir, matchRecord: async () => { attempts++; const e = new Error('connection refused'); e.code = 'ECONNREFUSED'; throw e; } });
      const bea = await login(down, 'Bea');
      const s = await open(down, bea);
      s.send({ t: 'create', gameId: 'wizard' });
      await until(() => s.room, 'table');
      const code = s.room.code;
      await playToEnd(s);
      await until(() => down.matchQueue.stats().failed === 1, 'the queue gave up');
      assert.ok(attempts >= 2, 'it retried first');
      assert.equal((await matchesIn(code)).length, 0, 'the database has nothing');
      const spooled = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
      assert.equal(spooled.length, 1, 'the result is kept on disk');
      s.ws.close();
      await down.close();
      const up = await start({ ...fast, matchSpoolDir: dir });
      const rows = await until(async () => { const r = await matchesIn(code); return r.length ? r : null; }, 'replayed after the restart');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].match_key, spooled[0].replace('.json', ''), 'the stored game is the one that was spooled');
      assert.equal((await q('SELECT count(*)::int AS n FROM match_participants WHERE match_id = $1', [rows[0].id]))[0].n, 3);
      await until(() => fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length === 0, 'spool emptied');
      await up.close();
      const again = await start({ ...fast, matchSpoolDir: dir });
      await sleep(200);
      assert.equal((await matchesIn(code)).length, 1, 'restarting again does not duplicate it');
      await again.close();
    });

    await test('a new game started after a restart gets a new identity and never touches an earlier result', async () => {
      const s2 = await start(fast);
      const user = await login(s2, 'Cy');
      const s = await open(s2, user);
      s.send({ t: 'create', gameId: 'wizard' });
      await until(() => s.room, 'table');
      await playToEnd(s);
      const keys = (await q('SELECT match_key FROM matches')).map((r) => r.match_key);
      assert.equal(new Set(keys).size, keys.length, 'every stored game has a unique key');
      assert.ok(keys.every(Boolean));
      s.ws.close();
      await s2.close({ drainMs: 2000 });
    });

    await dbPool.close();
    console.log(`\n${passed} match lifecycle tests passed`);
  } finally {
    for (const d of spools) fs.rmSync(d, { recursive: true, force: true });
    await t.drop();
  }
})().catch((e) => { console.error(e); process.exit(1); });
