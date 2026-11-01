'use strict';
require('./helpers/env');
const assert = require('node:assert/strict');
const { Browser } = require('./helpers/auth');
const WebSocket = require('ws');
const { start } = require('../server');
const testdb = require('./helpers/testdb');
const dbFriends = require('../db/friends');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, timeout = 8000) {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`timeout waiting for ${label}`);
    await wait(20);
  }
}
function wsClient(port, token) {
  const c = { messages: [], errors: [], notices: [], room: null, ws: new WebSocket(`ws://127.0.0.1:${port}/ws`) };
  c.send = (message) => c.ws.send(JSON.stringify(message));
  c.wait = (predicate, label) => until(() => predicate(c), label);
  c.ws.on('open', () => c.send({ t: 'hello', token }));
  c.ws.on('message', (raw) => {
    const message = JSON.parse(raw);
    c.messages.push(message);
    if (message.t === 'state') c.room = message.room;
    if (message.t === 'error') c.errors.push(message.message);
    if (message.t === 'socialNotice') c.notices.push(message);
  });
  return c;
}

async function run() {
  const t = await testdb.create();
  if (!t) return;
  process.env.DATABASE_URL = t.url;
  const dbPool = require('../db/pool');
  await dbPool.close();
  const app = await start({ port: 0, trustProxy: false, maxMsgsPerSec: Infinity, matchLog: { log() {}, warn() {}, error() {} } });
  const clients = [];
  const browsers = [];
  const playerIds = [];
  try {
    let n = 0;
    async function account(label) {
      n++;
      const browser = new Browser(app.port);
      browsers.push(browser);
      await browser.csrf();
      const username = `${label.toLowerCase()}_${n}`;
      const registered = await browser.must('/api/auth/register', {
        email: `${username}@test.local`, username, password: 'TestPass123!', displayName: label,
      });
      const playerId = registered.json.player.id;
      playerIds.push(playerId);
      await browser.must('/api/auth/verify-email', { token: registered.json.debug.verifyToken });
      const login = await browser.must('/api/auth/login', { email: `${username}@test.local`, password: 'TestPass123!' });
      const client = wsClient(app.port, login.json.token);
      clients.push(client);
      await client.wait((c) => c.messages.some((m) => m.t === 'welcome'), `${label} welcome`);
      return { browser, client, username, id: playerId };
    }

    const host = await account('Host');
    const invitee = await account('Invitee');
    const stranger = await account('Stranger');
    const request = await host.browser.post('/api/me/friend-requests', { username: invitee.username });
    assert.equal(request.status, 201);
    assert.equal((await invitee.browser.post('/api/me/friend-requests/accept', { requestId: request.json.request.id })).status, 200);

    host.client.send({ t: 'create', gameId: 'wizard', visibility: 'private' });
    await host.client.wait((c) => c.room && c.room.visibility === 'private', 'private table');
    const code = host.client.room.code;
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const created = await host.browser.post('/api/me/table-invitations', { username: invitee.username, gameId: 'wizard', roomCode: code, expiresAt });
    assert.equal(created.status, 201, created.json.error);
    await until(() => invitee.client.notices.some((notice) => notice.kind === 'table-invitation'), 'invitation notice');
    const notHost = await invitee.browser.post('/api/me/table-invitations', { username: stranger.username, gameId: 'wizard', roomCode: code, expiresAt });
    assert.equal(notHost.status, 404, 'non-host cannot issue invitation to another private room');
    assert.equal((await host.browser.post('/api/me/table-invitations', { username: invitee.username, gameId: 'twentynine', roomCode: code, expiresAt })).status, 404, 'wrong game rejected');
    assert.equal((await host.browser.post('/api/me/table-invitations', { username: invitee.username, gameId: 'wizard', roomCode: 'ABCDEF', expiresAt })).status, 404, 'nonexistent room rejected');
    assert.equal((await stranger.browser.post('/api/me/table-invitations/accept', { invitationId: created.json.invitation.id })).status, 404, 'wrong recipient cannot accept');
    const early = await dbFriends.transitionInvitation(host.id, created.json.invitation.id, 'accept').catch((error) => error);
    assert.equal(early.status, 404, 'inviter cannot accept their own invite');
    await dbFriends.expireInvitation(created.json.invitation.id);
    assert.equal((await invitee.browser.post('/api/me/table-invitations/accept', { invitationId: created.json.invitation.id })).status, 404, 'expired invitation cannot be accepted');

    const liveAgain = await host.browser.post('/api/me/table-invitations', { username: invitee.username, gameId: 'wizard', roomCode: code, expiresAt });
    assert.equal(liveAgain.status, 201, liveAgain.json.error);
    const currentInvite = liveAgain.json.invitation;
    stranger.client.send({ t: 'join', code });
    await stranger.client.wait((c) => c.errors.length, 'stranger denied');
    invitee.client.send({ t: 'join', code, spectate: true });
    await invitee.client.wait((c) => c.errors.length, 'pending invite denied');

    const incoming = await invitee.browser.get('/api/me/table-invitations');
    assert.equal(incoming.json.invitations.length, 1);
    const accepted = await invitee.browser.post('/api/me/table-invitations/accept', { invitationId: currentInvite.id });
    assert.equal(accepted.status, 200, accepted.json.error);
    invitee.client.send({ t: 'join', code, spectate: true });
    await invitee.client.wait((c) => c.room && c.room.code === code, 'accepted invitation grants spectator entry');
    const invitees = await dbFriends.authorizedRoomInvitees(host.id, code, 'wizard');
    assert.deepEqual(invitees, [invitee.id]);

    await host.browser.post('/api/me/friends/remove', { friendId: invitee.id });
    invitee.client.send({ t: 'join', code });
    await until(() => invitee.client.errors.length > 0, 'friend removal revokes access');
    console.log('private table PostgreSQL invitation tests passed');
  } finally {
    for (const client of clients) client.ws.terminate();
    await app.close();
    if (playerIds.length) {
      const cleanup = await t.client();
      try {
        await cleanup.query('DELETE FROM players WHERE id = ANY($1::uuid[])', [playerIds]);
      } finally { await cleanup.end(); }
    }
    await t.drop();
  }
}

run().catch((error) => { console.error(error); process.exit(1); });
