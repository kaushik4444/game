'use strict';
// Connection quality on the real server (in-memory mode, no database): every connected player is probed, the player is told
// their own smoothed round trip, table members carry it for the other humans, bots have none, and it disappears on disconnect.
require('./helpers/env');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { registerAndVerify } = require('./helpers/auth');
const { start } = require('../server');

const guard = setTimeout(() => { console.error('FAIL ping test timed out'); process.exit(1); }, 60000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, ms = 8000) {
  const t0 = Date.now();
  for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + label); await sleep(15); }
}
let passed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n' + e.stack); process.exitCode = 1; } }

function client(port, token) {
  const c = { room: null, latency: [], ws: new WebSocket(`ws://127.0.0.1:${port}/ws`) };
  c.send = (m) => c.ws.send(JSON.stringify(m));
  c.ws.on('open', () => c.send({ t: 'hello', token }));
  c.ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.t === 'welcome') c.id = m.id; if (m.t === 'state') c.room = m.room; if (m.t === 'latency') c.latency.push(m.ms); });
  return c;
}

(async () => {
  const srv = await start({ port: 0, trustProxy: false, botDelay: [0, 3], timeScale: 0.01, maxMsgsPerSec: Infinity, matchLog: { log() {}, warn() {}, error() {} } });
  try {
    const mk = async (name) => { const u = await registerAndVerify(srv.port, { email: `${name.toLowerCase()}@test.local`, displayName: name, password: 'TestPass123!' }); const c = client(srv.port, u.token); await until(() => c.id, name); return c; };
    const a = await mk('Ann'); const b = await mk('Bea');
    await test('a connected player is told their own ping, a sane number of milliseconds', async () => {
      await until(() => a.latency.length > 0, 'first latency report');
      assert.ok(Number.isInteger(a.latency[0]) && a.latency[0] >= 0 && a.latency[0] < 5000, 'got ' + a.latency[0]);
    });
    await test('other humans at the table see each other’s ping; bots have none', async () => {
      a.send({ t: 'create', gameId: 'wizard', visibility: 'public' });
      await until(() => a.room, 'table');
      a.send({ t: 'addBot' });
      b.send({ t: 'join', code: a.room.code });
      await until(() => b.room && b.room.members.length >= 3, 'joined');
      for (let i = 0; i < 8 && !(b.room.members.filter((m) => !m.bot).every((m) => Number.isFinite(m.ping))); i++) { await sleep(1000); a.send({ t: 'chat', text: 'x' + i }); await sleep(100); } // any broadcast carries the newest pings
      assert.ok(b.room.members.filter((m) => !m.bot).every((m) => Number.isFinite(m.ping)), 'humans have a ping');
      const bot = b.room.members.find((m) => m.bot);
      assert.equal(bot.ping, null);
    });
    await test('the measurement is forgotten when the player disconnects', async () => {
      const id = b.id;
      b.ws.close();
      await sleep(300);
      for (let i = 0; i < 5; i++) { a.send({ t: 'chat', text: 'y' + i }); await sleep(150); }
      await until(() => { const m = a.room && a.room.members.find((x) => x.id === id); return !m || m.ping === null; }, 'ping cleared');
    });
  } finally { await srv.close(); clearTimeout(guard); }
  console.log(`\n${passed} ping tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
