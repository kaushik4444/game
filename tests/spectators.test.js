'use strict';
// Spectator and seat transitions on the real server (in-memory mode, no database): duplicate joins, capacity checks that
// come after duplicate detection, rejoining, switching tables, player <-> spectator, and no repeated notifications.
require('./helpers/env');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { registerAndVerify } = require('./helpers/auth');
const { start } = require('../server');

const guard = setTimeout(() => { console.error('FAIL spectator test timed out'); process.exit(1); }, 90000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, ms = 8000) {
  const t0 = Date.now();
  for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + label); await sleep(15); }
}
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n' + e.stack); process.exitCode = 1; }
}

function client(port, token) {
  const c = { room: null, errors: [], chats: [], notices: [], left: 0, ws: new WebSocket(`ws://127.0.0.1:${port}/ws`) };
  c.send = (m) => c.ws.send(JSON.stringify(m));
  c.ws.on('open', () => c.send({ t: 'hello', token }));
  c.ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.t === 'welcome') c.id = m.id;
    if (m.t === 'state') c.room = m.room;
    if (m.t === 'error') c.errors.push(m.message);
    if (m.t === 'chat') c.chats.push(m.m);
    if (m.t === 'chatlog') c.chats = c.chats.concat(m.messages);
    if (m.t === 'notice') c.notices.push(m.text);
    if (m.t === 'left') { c.room = null; c.left++; }
  });
  c.sys = (re) => c.chats.filter((x) => x.sys && re.test(x.text)).length;
  c.watching = (code) => !!(c.room && c.room.code === code && c.room.spectators.some((s) => s.id === c.id));
  c.seated = (code) => !!(c.room && c.room.code === code && c.room.members.some((m) => m.id === c.id && !m.bot));
  return c;
}

(async () => {
  const srv = await start({ port: 0, trustProxy: false, botDelay: [0, 3], autoAdvanceMs: 20, trickPauseMs: 0, forcedMs: 0, timeScale: 0.01, absentMs: 60000, maxMsgsPerSec: Infinity, maxSpectators: 2, matchLog: { log() {}, warn() {}, error() {} } });
  const all = [];
  const mk = async (name) => {
    const u = await registerAndVerify(srv.port, { email: `${name.toLowerCase()}@test.local`, displayName: name, password: 'TestPass123!' });
    const c = client(srv.port, u.token); all.push(c);
    await until(() => c.id, name + ' welcome');
    return c;
  };
  const table = async (host, o = {}) => {
    host.send({ t: 'create', gameId: 'wizard' });
    await until(() => host.room && host.room.members.some((m) => m.id === host.id), 'table created');
    const code = host.room.code;
    if (o.seats) host.send({ t: 'setSeats', seats: o.seats });
    return code;
  };

  try {
    const host = await mk('Host'); const a = await mk('Ann'); const b = await mk('Bea'); const c = await mk('Cyd');
    const code = await table(host);

    await test('a duplicate spectate request changes nothing and adds no second announcement', async () => {
      a.send({ t: 'join', code, spectate: true });
      await until(() => a.watching(code), 'a watches');
      const hostNotices = host.notices.length;
      const sysLines = host.sys(/Ann is watching/);
      for (let i = 0; i < 3; i++) a.send({ t: 'join', code, spectate: true });
      await sleep(150);
      assert.equal(host.room.spectators.filter((s) => s.id === a.id).length, 1, 'listed once');
      assert.equal(host.sys(/Ann is watching/), sysLines);
      assert.equal(sysLines, 1);
      assert.equal(host.notices.length, hostNotices, 'no repeated notice');
    });

    await test('when the spectator list is full, new spectators are refused but someone already watching is not', async () => {
      b.send({ t: 'join', code, spectate: true });
      await until(() => b.watching(code), 'b watches (second place)');
      c.send({ t: 'join', code, spectate: true });
      await until(() => c.errors.some((e) => /Too many spectators/.test(e)), 'c refused');
      assert.equal(c.watching(code), false);
      const before = host.sys(/is watching/);
      a.send({ t: 'join', code, spectate: true }); // full list, but Ann is already on it
      b.send({ t: 'join', code });                 // a plain join from a spectator is also a no-op
      await sleep(150);
      assert.deepEqual(a.errors, []);
      assert.deepEqual(b.errors, []);
      assert.equal(host.room.spectators.length, 2);
      assert.equal(host.sys(/is watching/), before);
    });

    await test('a spectator who takes a free seat leaves the spectator list and is announced as a player once', async () => {
      a.send({ t: 'sit' });
      await until(() => a.seated(code), 'a seated');
      assert.equal(host.room.spectators.some((s) => s.id === a.id), false);
      a.send({ t: 'sit' }); // not a spectator any more
      a.send({ t: 'join', code }); // already seated
      await sleep(150);
      assert.equal(host.room.members.filter((m) => m.id === a.id).length, 1);
      assert.equal(host.room.spectators.length, 1);
      // now there is room again for Cyd
      c.errors.length = 0;
      c.send({ t: 'join', code, spectate: true });
      await until(() => c.watching(code), 'c watches after a place freed up');
    });

    await test('a seated player who asks to spectate their own table stays seated and is not announced as watching', async () => {
      const before = host.sys(/Ann is watching/);
      a.send({ t: 'join', code, spectate: true });
      await sleep(150);
      assert.ok(a.seated(code));
      assert.equal(host.room.spectators.some((s) => s.id === a.id), false);
      assert.equal(host.sys(/Ann is watching/), before);
    });

    await test('a full table does not throw an existing seat-holder out, and a refused join keeps you where you are', async () => {
      const h2 = await mk('Host2'); const d = await mk('Dee'); const e = await mk('Eve');
      const f = await mk('Fay');
      const full = await table(h2, { seats: 3 });
      await until(() => h2.room.seats === 3, 'three seats');
      d.send({ t: 'join', code: full });
      f.send({ t: 'join', code: full });
      await until(() => d.seated(full) && f.seated(full), 'd and f seated (table now full)');
      d.send({ t: 'join', code: full }); // duplicate on a full table
      await sleep(150);
      assert.deepEqual(d.errors, [], 'a seated player is never told "table is full"');
      // Eve sits at the first table, then tries to join the full one: refused, and she stays at the first
      const hx = await mk('HostE'); const other = await table(hx);
      e.send({ t: 'join', code: other, spectate: true });
      await until(() => e.watching(other), 'e watches another table');
      e.send({ t: 'join', code: full });
      await until(() => e.errors.some((m) => /full/.test(m)), 'e refused');
      assert.ok(e.watching(other), 'still watching the other table');
      assert.ok(!h2.room.spectators.some((s) => s.id === e.id) && !h2.room.members.some((m) => m.id === e.id));
      e.send({ t: 'leave' });
      await until(() => e.left > 0, 'e left');
    });

    await test('switching tables leaves the old one exactly once and joins the new one', async () => {
      const x = await mk('Xan'); const hostA = await mk('HostA'); const hostB = await mk('HostB');
      const codeA = await table(hostA); const codeB = await table(hostB);
      x.send({ t: 'join', code: codeA, spectate: true });
      await until(() => x.watching(codeA), 'x watches A');
      x.send({ t: 'join', code: codeB });
      await until(() => x.seated(codeB), 'x seated at B');
      await sleep(100);
      assert.equal(hostA.room.spectators.some((s) => s.id === x.id), false, 'gone from A');
      assert.equal(hostA.sys(/Xan stopped watching/), 1, 'one "stopped watching" line');
      assert.equal(hostB.room.members.filter((m) => m.id === x.id).length, 1);
    });

    await test('in a running game: spectators can come and go, repeat joins add nothing, and a player who left gets the seat back even when asking to spectate', async () => {
      const h = await mk('Hoster'); const p2 = await mk('Pam'); const w = await mk('Wes');
      const g = await table(h, { seats: 3 });
      await until(() => h.room.seats === 3, 'three seats');
      p2.send({ t: 'join', code: g });
      await until(() => p2.seated(g), 'pam seated');
      h.send({ t: 'start' });
      await until(() => h.room && h.room.status === 'playing', 'started');
      w.send({ t: 'join', code: g });
      w.send({ t: 'join', code: g });
      await until(() => w.watching(g), 'wes watches the running game');
      await sleep(100);
      assert.equal(h.room.spectators.filter((s) => s.id === w.id).length, 1);
      assert.equal(h.sys(/Wes is watching/), 1, 'announced once');
      p2.send({ t: 'leave' });
      await until(() => h.room.members.some((m) => m.id === p2.id && m.bot), 'a bot holds pam\'s seat');
      p2.send({ t: 'join', code: g, spectate: true });
      await until(() => p2.seated(g), 'pam has her seat back');
      assert.equal(h.room.spectators.some((s) => s.id === p2.id), false, 'not a spectator');
      assert.equal(h.sys(/Pam is back/), 1);
    });

    console.log(`\n${passed} spectator tests passed`);
  } finally {
    clearTimeout(guard);
    for (const c of all) try { c.ws.terminate(); } catch { /* closed */ }
    await srv.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
