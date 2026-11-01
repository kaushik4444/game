'use strict';
require('./helpers/env');
// Reliable match persistence, without any database: retries, error classification, idempotence, spool and shutdown.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMatchQueue, isTransient } = require('../db/matchQueue');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n' + e.stack); process.exitCode = 1; }
}
const quiet = () => { const lines = { log: [], warn: [], error: [] }; return { lines, log: (m) => lines.log.push(m), warn: (m) => lines.warn.push(m), error: (m) => lines.error.push(m) }; };
const rec = (key = '11111111-1111-4111-8111-111111111111') => ({ matchKey: key, roomCode: 'ABCDEF', gameId: 'wizard', seats: 2, options: {}, startedAt: new Date(0), participants: [{ playerId: null, name: 'A', seat: 0, score: 1, isWinner: true, isBot: false, leftEarly: false }, { playerId: null, name: 'B', seat: 1, score: 0, isWinner: false, isBot: true, leftEarly: false }] });
const dbErr = (code, message = 'boom') => Object.assign(new Error(message), { code });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tv-spool-'));
const files = (d) => fs.readdirSync(d).sort();

(async () => {
  console.log('error classification');
  await test('connection, timeout, deadlock, shutdown and resource errors are transient; data and schema errors are not', () => {
    for (const c of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', '08006', '08001', '40001', '40P01', '57P01', '57014', '53300', '55P03']) assert.equal(isTransient(dbErr(c)), true, c);
    for (const c of ['23505', '23503', '22P02', '42P01', '42703', '42601', '23502']) assert.equal(isTransient(dbErr(c)), false, c);
    assert.equal(isTransient(new Error('Connection terminated unexpectedly')), true);
    assert.equal(isTransient(new Error('timeout exceeded when trying to connect')), true);
    assert.equal(isTransient(new Error('something else')), false);
    assert.equal(isTransient(null), false);
  });

  console.log('retries');
  await test('a transient failure is retried until it works, and is reported saved', async () => {
    const l = quiet(); let calls = 0; let saved = 0;
    const q = createMatchQueue({ record: async () => { if (++calls < 3) throw dbErr('57P01'); return { matchId: 'x' }; }, delays: [1, 1, 1], log: l, onSaved: () => saved++ });
    const r = await q.enqueue(rec());
    assert.deepEqual([r.status, r.attempts, calls, saved], ['saved', 3, 3, 1]);
    assert.equal(l.lines.warn.length, 2, 'every retry is logged');
    assert.equal(q.stats().saved, 1);
    assert.equal(q.stats().retried, 2);
  });
  await test('retries are bounded: after the last one the match is reported NOT saved, logged as an error, and onGiveUp fires', async () => {
    const l = quiet(); let calls = 0; let gaveUp = null;
    const q = createMatchQueue({ record: async () => { calls++; throw dbErr('ECONNREFUSED', 'connect ECONNREFUSED'); }, delays: [1, 1, 1], log: l, onGiveUp: (r, e) => (gaveUp = { r, e }) });
    const r = await q.enqueue(rec());
    assert.equal(r.status, 'failed');
    assert.equal(calls, 4, 'one try plus three retries, then stop');
    assert.equal(gaveUp.r.matchKey, rec().matchKey);
    assert.match(l.lines.error.join('\n'), /NOT SAVED after 3 retries.*match 11111111-1111-4111-8111-111111111111.*wizard.*ABCDEF/);
    assert.equal(q.stats().failed, 1);
    assert.equal(q.stats().saved, 0, 'a failed write is never counted as saved');
  });
  await test('a permanent error is not retried', async () => {
    const l = quiet(); let calls = 0;
    const q = createMatchQueue({ record: async () => { calls++; throw dbErr('42P01', 'relation "matches" does not exist'); }, delays: [1, 1, 1], log: l });
    const r = await q.enqueue(rec());
    assert.deepEqual([r.status, calls], ['failed', 1]);
    assert.match(l.lines.error.join('\n'), /permanent error, not retrying.*42P01/);
  });
  await test('a result that is a duplicate counts as already saved, not as a failure', async () => {
    const q = createMatchQueue({ record: async () => ({ matchId: null, duplicate: true }), delays: [1], log: quiet() });
    const r = await q.enqueue(rec());
    assert.equal(r.status, 'duplicate');
    assert.deepEqual([q.stats().duplicates, q.stats().saved, q.stats().failed], [1, 0, 0]);
  });
  await test('the same match queued twice at once is written once; enqueue never rejects or throws', async () => {
    let calls = 0;
    const q = createMatchQueue({ record: async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return { matchId: 'x' }; }, delays: [1], log: quiet() });
    const [a, b] = await Promise.all([q.enqueue(rec()), q.enqueue(rec())]);
    assert.deepEqual([a.status, b.status, calls], ['saved', 'saved', 1]);
    await assert.doesNotReject(q.enqueue(null));
    assert.equal((await q.enqueue(undefined)).status, 'failed');
  });
  await test('enqueue returns at once: the game loop is never blocked by a slow or failing database', async () => {
    const q = createMatchQueue({ record: () => new Promise(() => {}), delays: [1], log: quiet() }); // never answers
    const t = Date.now();
    q.enqueue(rec());
    assert.ok(Date.now() - t < 50);
    assert.equal(q.stats().pending, 1);
    q.close();
  });

  console.log('spool, restart and shutdown');
  await test('the record is written ahead of the first attempt, and removed once the database has it', async () => {
    const dir = tmp(); let seenDuring = null;
    const q = createMatchQueue({ record: async (r) => { seenDuring = files(dir); return { matchId: 'x' }; }, spoolDir: dir, delays: [1], log: quiet() });
    await q.enqueue(rec());
    assert.deepEqual(seenDuring, ['11111111-1111-4111-8111-111111111111.json']);
    assert.deepEqual(files(dir), []);
  });
  await test('a restart while a write is pending: the next process replays the spool and the match is saved once', async () => {
    const dir = tmp(); const l1 = quiet();
    const q1 = createMatchQueue({ record: async () => { throw dbErr('ECONNREFUSED'); }, spoolDir: dir, delays: [1], log: l1 });
    assert.equal((await q1.enqueue(rec())).status, 'failed');
    assert.equal(files(dir).length, 1, 'the unsaved result survives in the spool');
    q1.close();
    const stored = new Map(); // a database that enforces the match key
    const record = async (r) => (stored.has(r.matchKey) ? { matchId: null, duplicate: true } : (stored.set(r.matchKey, r), { matchId: 'x' }));
    const q2 = createMatchQueue({ record, spoolDir: dir, delays: [1], log: quiet() }); // "after the restart"
    assert.equal(q2.replaySpool(), 1);
    assert.equal(await q2.drain(2000), true);
    assert.equal(stored.size, 1);
    assert.deepEqual(files(dir), []);
    const q3 = createMatchQueue({ record, spoolDir: dir, delays: [1], log: quiet() });
    assert.equal(q3.replaySpool(), 0);
  });
  await test('replaying a match the database already has is harmless (idempotent by key)', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, rec().matchKey + '.json'), JSON.stringify(rec()));
    const q = createMatchQueue({ record: async () => ({ matchId: null, duplicate: true }), spoolDir: dir, delays: [1], log: quiet() });
    q.replaySpool(); await q.drain(1000);
    assert.equal(q.stats().duplicates, 1);
    assert.deepEqual(files(dir), []);
  });
  await test('a permanent failure is parked as .failed (kept for inspection, not replayed forever); a corrupt file is parked as .bad', async () => {
    const dir = tmp(); const l = quiet();
    const q = createMatchQueue({ record: async () => { throw dbErr('23502', 'null value'); }, spoolDir: dir, delays: [1], log: l });
    await q.enqueue(rec());
    assert.deepEqual(files(dir), ['11111111-1111-4111-8111-111111111111.failed']);
    fs.writeFileSync(path.join(dir, 'garbage.json'), '{nope');
    assert.equal(q.replaySpool(), 0);
    assert.ok(files(dir).includes('garbage.bad'));
    assert.match(l.lines.error.join('\n'), /unreadable spool file garbage\.json/);
  });
  await test('drain waits for pending writes (SIGTERM on deploy) and gives up at its deadline', async () => {
    let release; const gate = new Promise((r) => (release = r));
    const q = createMatchQueue({ record: async () => { await gate; return { matchId: 'x' }; }, delays: [1], log: quiet() });
    q.enqueue(rec());
    assert.equal(await q.drain(30), false, 'still pending at the deadline');
    setTimeout(release, 20);
    assert.equal(await q.drain(2000), true);
    assert.equal(q.stats().pending, 0);
  });
  await test('close() stops retrying at once and keeps the unsaved record in the spool', async () => {
    const dir = tmp();
    const q = createMatchQueue({ record: async () => { throw dbErr('08006'); }, spoolDir: dir, delays: [60000, 60000], log: quiet() });
    const p = q.enqueue(rec());
    await new Promise((r) => setTimeout(r, 20));
    q.close();
    const r = await Promise.race([p, new Promise((res) => setTimeout(() => res('hung'), 1000))]);
    assert.equal(r.status, 'failed');
    assert.equal(files(dir).length, 1);
    assert.equal((await q.enqueue(rec('22222222-2222-4222-8222-222222222222'))).status, 'failed', 'a closed queue refuses new work instead of hiding it');
    assert.ok(files(dir).includes('22222222-2222-4222-8222-222222222222.json'), '...and keeps it in the spool so the next start can save it');
  });
  await test('a game that finishes during shutdown is replayed by the next process exactly once', async () => {
    const dir = tmp();
    const q1 = createMatchQueue({ record: async () => { throw new Error('must not be attempted after close'); }, spoolDir: dir, delays: [1], log: quiet() });
    q1.close();
    assert.equal((await q1.enqueue(rec())).error, 'shutting down');
    const stored = new Map();
    const record = async (r) => (stored.has(r.matchKey) ? { matchId: null, duplicate: true } : (stored.set(r.matchKey, r), { matchId: 'x' }));
    const q2 = createMatchQueue({ record, spoolDir: dir, delays: [1], log: quiet() });
    assert.equal(q2.replaySpool(), 1);
    await q2.drain(1000);
    assert.equal(stored.size, 1);
    assert.equal(q2.replaySpool(), 0, 'nothing left to replay');
  });
  await test('replaying the spool while a write is in flight does not start a second write for the same game', async () => {
    const dir = tmp(); let calls = 0; let release; const gate = new Promise((r) => (release = r));
    const q = createMatchQueue({ record: async () => { calls++; await gate; return { matchId: 'x' }; }, spoolDir: dir, delays: [1], log: quiet() });
    const p = q.enqueue(rec());
    assert.equal(q.replaySpool(), 0, 'the periodic replay skips a record that is being written');
    release(); await p;
    assert.equal(calls, 1);
  });
  await test('a game that fails every retry is saved by a later replay once the database is back (the periodic replay)', async () => {
    const dir = tmp(); let up = false; const stored = new Map();
    const record = async (r) => { if (!up) throw dbErr('ECONNREFUSED'); stored.set(r.matchKey, r); return { matchId: 'x' }; };
    const q = createMatchQueue({ record, spoolDir: dir, delays: [1, 1], log: quiet() });
    assert.equal((await q.enqueue(rec())).status, 'failed');
    up = true;
    assert.equal(q.replaySpool(), 1);
    await q.drain(1000);
    assert.equal(stored.size, 1);
    assert.deepEqual(files(dir), []);
  });
  await test('without a spool directory a failure is still logged and reported, and says the result is lost', async () => {
    const l = quiet();
    const q = createMatchQueue({ record: async () => { throw dbErr('08006'); }, spoolDir: null, delays: [1], log: l });
    assert.equal((await q.enqueue(rec())).status, 'failed');
    assert.match(l.lines.error.join('\n'), /no spool configured: this result is lost/);
  });

  console.log(`\n${passed} match queue tests passed`);
})();
