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
  c.ws.on('open', () => c.send({ t: 'hello', name, token }));
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

    /** A short Wizard game: one human (idle, so the server's turn limit plays for them) and two bots, played to the end. */
    async function playGame(srv, name = 'Hana', extra = {}) {
      const c = client(srv.port, name);
      await c.ready();
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
    hana.ws.close();
    await srv.close();

    console.log('players who leave');
    await test('a player who leaves early is stored as such and does not get the game in their stats; the one who stayed does', async () => {
      srv = await start({ ...fast, matchLog: quiet() });
      const a = client(srv.port, 'Stayer'); const b = client(srv.port, 'Quitter');
      await a.ready(); await b.ready();
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
      b.send({ t: 'hello', name: 'Quitter', token: b.token });
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
    if (process.platform !== 'win32') {
      await test('the production process starts on this database (HSTS, /readyz) and exits cleanly on SIGTERM', async () => {
        const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, NODE_ENV: 'production', PORT: '0', DATABASE_URL: t.url, MATCH_SPOOL_DIR: spool() }, cwd: path.join(__dirname, '..') });
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
