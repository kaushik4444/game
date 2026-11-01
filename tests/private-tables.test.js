'use strict';
// Private room access control and live invitation behavior using the DB-free test setup.
require('./helpers/env');
const assert = require('node:assert/strict');
const { Browser, registerAndVerify } = require('./helpers/auth');
const WebSocket = require('ws');
const { start } = require('../server');
const dbPool = require('../db/pool');
const dbAccount = require('../db/account');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, timeout = 5000) {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`timeout waiting for ${label}`);
    await wait(20);
  }
}
function wsClient(port, token) {
  const c = { messages: [], errors: [], notices: [], online: [], room: null, ws: new WebSocket(`ws://127.0.0.1:${port}/ws`) };
  c.send = (message) => c.ws.send(JSON.stringify(message));
  c.wait = (predicate, label) => until(() => predicate(c), label);
  c.ws.on('open', () => c.send({ t: 'hello', token }));
  c.ws.on('message', (raw) => {
    const message = JSON.parse(raw);
    c.messages.push(message);
    if (message.t === 'state') c.room = message.room;
    if (message.t === 'error') c.errors.push(message.message);
    if (message.t === 'socialNotice') c.notices.push(message);
    if (message.t === 'socialPresence') c.online.push(message);
  });
  return c;
}

(async () => {
  if (dbPool.hasDatabase()) throw new Error('private-tables.test.js requires DB-free environment');
  const app = await start({ port: 0, trustProxy: false, maxMsgsPerSec: Infinity, matchLog: { log() {}, warn() {}, error() {} } });
  const clients = [];
  try {
    let n = 0;
    const user = async (name) => {
      n++;
      const result = await registerAndVerify(app.port, { username: `${name.toLowerCase()}_${n}`, email: `${name.toLowerCase()}_${n}@test.local`, displayName: name });
      const browser = result.browser;
      const client = wsClient(app.port, result.token);
      clients.push(client);
      await client.wait((c) => c.messages.some((m) => m.t === 'welcome'), `${name} welcome`);
      return { browser: result.browser, client, id: client.messages.find((m) => m.t === 'welcome').id, username: result.player.username };
    };
    const a = await user('Host');
    const b = await user('Invitee');
    const stranger = await user('Stranger');

    a.client.send({ t: 'create', gameId: 'wizard' });
    await a.client.wait((c) => c.room && c.room.status === 'lobby', 'private room created');
    const code = a.client.room.code;
    assert.equal((await a.browser.post('/api/me/friend-requests', { username: b.username })).status, 503, 'social API requires postgres');
    // In memory mode private access remains host-only; it must not accidentally fall back to code-only access.
    stranger.client.send({ t: 'join', code });
    await stranger.client.wait((c) => c.errors.length > 0, 'unauthorized join rejected');
    assert.equal(stranger.client.room, null);
    stranger.client.send({ t: 'join', code, spectate: true });
    await wait(150);
    assert.equal(a.client.room.members.length, 1);
    assert.equal(a.client.room.spectators.length, 0);
    assert.ok(stranger.client.errors.length >= 2);

    // Social features stay unavailable without PostgreSQL; the host-only policy must remain enforced.
    assert.equal((await a.browser.post('/api/me/table-invitations', { username: b.username, gameId: 'wizard', roomCode: code, expiresAt: new Date(Date.now() + 60000).toISOString() })).status, 503);
    a.client.send({ t: 'setVisibility', visibility: 'private' });
    await a.client.wait((c) => c.room && c.room.visibility === 'private', 'room changed private');
    stranger.client.send({ t: 'join', code });
    await wait(150);
    assert.equal(stranger.client.room, null, 'private conversion immediately restores authorization');
    assert.ok(stranger.client.errors.length >= 3);

    a.client.send({ t: 'setVisibility', visibility: 'public' });
    await a.client.wait((c) => c.room && c.room.visibility === 'public', 'room changed public again');
    stranger.client.send({ t: 'join', code });
    await stranger.client.wait((c) => c.room && c.room.code === code, 'public code join allowed');

    console.log('private table access tests passed (DB-free policy safeguards)');
    await dbAccount.clearRecentTables(a.id);
    await dbAccount.clearRecentTables(b.id);
    await dbAccount.clearRecentTables(stranger.id);
    a.client.send({ t: 'setVisibility', visibility: 'public' });
    await a.client.wait((c) => c.room && c.room.visibility === 'public', 'room changed public');
    stranger.client.send({ t: 'join', code });
    await stranger.client.wait((c) => c.room && c.room.code === code, 'public code join allowed');

    console.log('private table access tests passed (DB-free policy safeguards)');
    await dbAccount.clearRecentTables(a.id);
    await dbAccount.clearRecentTables(b.id);
    await dbAccount.clearRecentTables(stranger.id);
  } finally {
    for (const client of clients) client.ws.terminate();
    await app.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
