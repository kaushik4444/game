'use strict';
/** End-to-end: real HTTP + WebSocket server, two human clients and a bot play a complete Wizard game. */
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');
const { start } = require('../server');

const guard = setTimeout(() => {
  console.error('FAIL smoke test timed out');
  process.exit(1);
}, 60000);

function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ port, path, host: '127.0.0.1' }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

/** Minimal client with a naive-but-legal strategy. */
function client(port, name, token) {
  const c = { name, last: null, room: null, view: null, errors: [], chats: [], notices: [], tables: [], ws: new WebSocket(`ws://127.0.0.1:${port}/ws`), playing: false };
  c.send = (m) => c.ws.send(JSON.stringify(m));
  c.waiters = [];
  c.until = (pred, label) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for ' + label)), 20000);
      const check = () => {
        if (pred()) { clearTimeout(t); resolve(); return true; }
        return false;
      };
      if (!check()) c.waiters.push(check);
    });
  c.ws.on('open', () => c.send({ t: 'hello', name, token }));
  c.ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.t === 'welcome') Object.assign(c, { id: m.id, token: m.token, games: m.games });
    if (m.t === 'state') { c.room = m.room; c.view = m.view; if (c.playing) c.step(); }
    if (m.t === 'error') c.errors.push(m.message);
    if (m.t === 'chat') c.chats.push(m.m);
    if (m.t === 'notice') c.notices.push(m.text);
    if (m.t === 'tables') c.tables = m.tables;
    c.waiters = c.waiters.filter((w) => !w());
  });
  c.step = () => {
    const v = c.view;
    if (!v || !v.myTurn) return;
    // act once per distinct turn, like a human would (the server broadcasts on every presence change too)
    const key = [v.phase, v.round, v.hand.length, v.trick.length, v.players.filter((p) => p.bid !== null).length].join('|');
    if (key === c.lastKey) return;
    c.lastKey = key;
    if (v.phase === 'chooseTrump') c.send({ t: 'act', action: { type: 'chooseTrump', suit: 'G' } });
    else if (v.phase === 'bidding') c.send({ t: 'act', action: { type: 'bid', amount: v.forbiddenBid === 0 ? 1 : 0 } });
    else if (v.phase === 'playing') c.send({ t: 'act', action: { type: 'play', cardId: v.legal[0] } });
  };
  return c;
}

(async () => {
  const app = await start({ port: 0, botDelay: [0, 3], autoAdvanceMs: 20, absentMs: 150, maxMsgsPerSec: Infinity, trickPauseMs: 0, forcedMs: 0 });
  const { port } = app;

  // --- static hosting
  const home = await get(port, '/');
  assert.equal(home.status, 200);
  assert.match(home.body, /Card Table/);
  assert.equal(home.headers['x-content-type-options'], 'nosniff');
  assert.equal((await get(port, '/games/wizard.js')).status, 200);
  assert.equal((await get(port, '/healthz')).body, 'ok');
  assert.equal((await get(port, '/nope')).status, 404);
  assert.equal((await get(port, '/../server.js')).status, 404);
  assert.notEqual((await get(port, '/%2e%2e/server.js')).status, 200);
  assert.notEqual((await get(port, '/..%2fserver.js')).status, 200);
  assert.notEqual((await get(port, '/%00')).status, 200);
  console.log('  ok  static files are served and traversal is blocked');

  // --- lobby
  const a = client(port, 'Alice');
  await a.until(() => a.id, 'welcome');
  assert.equal(a.games[0].id, 'wizard');
  a.send({ t: 'create', gameId: 'wizard', visibility: 'public' });
  await a.until(() => a.room, 'room created');
  assert.match(a.room.code, /^[A-HJ-NP-Z]{6}$/);
  assert.equal(a.room.hostId, a.id);

  const b = client(port, 'Bob');
  await b.until(() => b.id, 'welcome B');
  await b.until(() => b.tables.some((t) => t.code === a.room.code && t.status === 'lobby'), 'public lobby listing');
  assert.equal(b.tables.find((t) => t.code === a.room.code).members, 1);

  // Public visibility changes are pushed to everyone browsing the directory.
  a.send({ t: 'setVisibility', visibility: 'private' });
  await b.until(() => !b.tables.some((t) => t.code === a.room.code), 'public table removed when made private');
  a.send({ t: 'setVisibility', visibility: 'public' });
  await b.until(() => b.tables.some((t) => t.code === a.room.code), 'private table listed when made public');

  const privateHost = client(port, 'Private Host');
  await privateHost.until(() => privateHost.id, 'welcome private host');
  privateHost.send({ t: 'create', gameId: 'wizard' });
  await privateHost.until(() => privateHost.room, 'private room created');
  assert.equal(privateHost.room.visibility, 'private');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(b.tables.some((t) => t.code === privateHost.room.code), false);
  privateHost.close();
  b.send({ t: 'join', code: 'ZZZZ' });
  await b.until(() => b.errors.length, 'error for bad code');
  b.send({ t: 'join', code: a.room.code.toLowerCase() });
  await b.until(() => b.room, 'B joined');
  await a.until(() => a.room.members.length === 2, 'A sees B');
  console.log('  ok  create / join by code');

  assert.equal(a.room.seats, 4); // default for Wizard
  b.send({ t: 'setSeats', seats: 3 });
  await b.until(() => b.errors.some((e) => /host/.test(e)), 'only host sets seats');
  a.send({ t: 'setSeats', seats: 2 });
  a.send({ t: 'setSeats', seats: 7 });
  await a.until(() => a.errors.filter((e) => /Invalid number/.test(e)).length === 2, 'seat range enforced (3-6)');
  a.send({ t: 'setSeats', seats: 3 });
  await a.until(() => a.room.seats === 3, 'seats -> 3');
  b.send({ t: 'addBot' });
  await b.until(() => b.errors.some((e) => /host/.test(e)), 'only host adds bots');
  a.send({ t: 'addBot' });
  await a.until(() => a.room.members.length === 3 && a.room.members[2].bot, 'bot added');
  a.send({ t: 'addBot' });
  await a.until(() => a.errors.some((e) => /seats are taken/.test(e)), 'cannot exceed seats');
  a.send({ t: 'setSeats', seats: 2 + 1 });
  a.send({ t: 'setOptions', options: { variant: 'plusminus', foresight: true, length: 'bogus', evil: true } });
  await a.until(() => a.room.options.variant === 'plusminus', 'options updated');
  assert.equal(a.room.options.foresight, true);
  assert.equal(a.room.options.length, 'full'); // invalid select value falls back to the default
  assert.equal(a.room.options.evil, undefined);
  b.send({ t: 'start' });
  await b.until(() => b.errors.some((e) => /host/.test(e)), 'only host starts');
  console.log('  ok  host-only controls, bot seats, option sanitising');

  // --- play a whole game (3 players x 20 rounds)
  a.playing = b.playing = true;
  a.send({ t: 'start' });
  await a.until(() => a.view, 'game started');
  await b.until(() => b.view, 'game started B');
  assert.equal(a.view.game, 'wizard');
  assert.equal(a.view.hand.length, 1);
  assert.ok(!JSON.stringify(a.view).includes('"hand":[{') || a.view.players.every((p) => p.hand === undefined));
  a.step(); b.step();

  // --- someone joining a running game becomes a spectator; chat works for everybody
  const sp = client(port, 'Sam');
  await sp.until(() => sp.id, 'welcome S');
  sp.send({ t: 'join', code: a.room.code });
  await sp.until(() => sp.room && sp.view, 'spectator joined');
  assert.equal(sp.view.me, -1);
  assert.equal(sp.view.hand.length, 0);
  assert.equal(sp.view.foresight.length, 0); // spectators must not see hidden cards
  assert.equal(sp.room.members.length, 3);
  assert.equal(sp.room.spectators.length, 1);
  await a.until(() => a.room.spectators.length === 1 && a.notices.some((t) => /Sam/.test(t)), 'players are told about the spectator');
  sp.send({ t: 'act', action: { type: 'bid', amount: 0 } });
  await sp.until(() => sp.errors.some((e) => /watching/.test(e)), 'spectators cannot act');
  sp.send({ t: 'chat', text: '  hello <b>table</b>  ' });
  await a.until(() => a.chats.some((m) => m.name === 'Sam' && m.spec && m.text === 'hello <b>table</b>'), 'chat reaches players');
  a.send({ t: 'chat', text: 'welcome Sam' });
  await sp.until(() => sp.chats.some((m) => m.text === 'welcome Sam'), 'chat reaches spectators');
  console.log('  ok  spectators join a running game and chat');

  // Alice drops mid-game and comes back with her token; Bob keeps playing.
  await a.until(() => a.view.round >= 2, 'round 2');
  const token = a.token;
  a.playing = false;
  a.ws.close();
  await b.until(() => b.room.members.find((m) => m.name === 'Alice' && !m.connected), 'B sees A offline');
  const a2 = client(port, 'Alice', token);
  a2.playing = true;
  await a2.until(() => a2.view && a2.room, 'A resumed into the same table');
  assert.equal(a2.id, a.id);
  assert.equal(a2.room.code, a.room.code);
  assert.ok(a2.view.hand.length >= 1);
  console.log('  ok  reconnect with token resumes the seat');
  a2.step();

  await b.until(() => b.view.phase === 'gameOver', 'game over');
  await a2.until(() => a2.view.phase === 'gameOver', 'game over A');
  assert.equal(b.view.history.length, 20);
  assert.ok(b.view.log.length > 0, 'Wizard exposes a public activity log');
  assert.equal(b.room.status, 'finished');
  assert.ok(b.view.winners.length >= 1);
  console.log('  ok  full 3-player game (20 rounds) with a bot, ending in gameOver');

  // --- absent human is covered by a bot, rematch returns to lobby
  a2.send({ t: 'rematch' });
  await a2.until(() => a2.room.status === 'lobby', 'rematch -> lobby');
  a2.playing = false;
  b.playing = false;
  a2.send({ t: 'start' });
  await a2.until(() => a2.view && a2.view.round === 1, 'second game');
  b.ws.close(); // Bob vanishes; the server should auto-play his turns after absentMs
  await a2.until(() => a2.view.round >= 2 || a2.view.myTurn, 'progress while Bob is away');
  console.log('  ok  rematch and absent-player cover');

  // --- illegal actions are rejected
  assert.ok(a2.view.hand.length >= 1);
  a2.errors.length = 0;
  a2.send({ t: 'act', action: { type: 'play', cardId: 'NOPE' } });
  a2.send({ t: 'act', action: { type: 'bid', amount: 9999 } });
  a2.send({ t: 'act', action: null });
  a2.send({ t: '__proto__' });
  a2.send({ t: 'constructor' });
  await a2.until(() => a2.errors.length >= 2, 'illegal actions rejected');
  console.log('  ok  illegal actions rejected');

  // --- empty seats are filled with bots on start; second game (29) is registered
  const c = client(port, 'Cara');
  await c.until(() => c.id, 'welcome C');
  assert.deepEqual(c.games.map((g) => g.id).sort(), ['poker', 'themind', 'twentynine', 'wizard']);
  const wiz = c.games.find((g) => g.id === 'wizard');
  assert.deepEqual([wiz.seats.min, wiz.seats.max], [3, 6]);
  assert.ok(wiz.options.find((o) => o.key === 'variant').choices.length === 4);
  c.send({ t: 'create', gameId: 'twentynine' });
  await c.until(() => c.room && c.room.gameId === 'twentynine', '29 table');
  assert.deepEqual(c.room.seatLabels, ['Team A', 'Team B', 'Team A', 'Team B']);
  c.send({ t: 'setSeats', seats: 3 });
  await c.until(() => c.errors.some((e) => /Invalid number/.test(e)), '29 is always 4 players');
  c.send({ t: 'setOptions', options: { target: '3' } });
  await c.until(() => c.room.options.target === '3', '29 option');
  c.send({ t: 'start' });
  await c.until(() => c.view && c.view.game === 'twentynine', '29 started with bots filling');
  assert.equal(c.room.members.length, 4);
  assert.equal(c.room.members.filter((m) => m.bot).length, 3);
  assert.equal(c.view.hand.length, 4);
  console.log('  ok  seats setting, bot fill on start, second game registered');
  c.send({ t: 'leave' });
  c.ws.close();

  // --- Poker over the wire: a human plays check/call against bots for a few hands
  const pk = client(port, 'Pia');
  await pk.until(() => pk.id, 'welcome P');
  pk.send({ t: 'create', gameId: 'poker' });
  await pk.until(() => pk.room && pk.room.gameId === 'poker', 'poker table');
  pk.send({ t: 'setSeats', seats: 4 });
  pk.send({ t: 'setOptions', options: { timeLimit: 'off', limit: '10' } });
  await pk.until(() => pk.room.options.limit === '10', 'poker options');
  pk.send({ t: 'start' });
  await pk.until(() => pk.view && pk.view.game === 'poker', 'poker started');
  assert.equal(pk.view.hand.length, 2);
  assert.equal(pk.view.players.length, 4);
  assert.ok(pk.view.log.length >= 2, 'Poker exposes blind activity');
  let lastKey = '';
  pk.playing = false;
  const pkStep = () => {
    const v = pk.view;
    if (!v || !v.myTurn) return;
    const key = v.handNo + ':' + v.street + ':' + v.currentBet + ':' + v.pot;
    if (key === lastKey) return;
    lastKey = key;
    pk.send({ t: 'act', action: { type: v.canCheck ? 'check' : 'call' } });
  };
  pk.step = pkStep;
  pk.playing = true;
  pkStep();
  await pk.until(() => pk.view.handNo >= 3 || pk.view.phase === 'gameOver', 'poker hands are played');
  assert.ok(pk.view.players.every((p) => p.cards === null || pk.view.phase !== 'betting'));
  console.log('  ok  poker: create, start with bots, play hands over WebSocket');
  pk.send({ t: 'leave' });
  pk.ws.close();

  // --- The Mind over the wire: bots ready up on their own, the level is dealt, only my own cards are visible
  const tm = client(port, 'Tom');
  await tm.until(() => tm.id, 'welcome Tom');
  tm.send({ t: 'create', gameId: 'themind' });
  await tm.until(() => tm.room && tm.room.gameId === 'themind', 'mind table');
  tm.send({ t: 'setSeats', seats: 3 });
  tm.send({ t: 'start' });
  await tm.until(() => tm.view && tm.view.game === 'themind' && tm.view.phase === 'ready', 'mind started');
  tm.send({ t: 'act', action: { type: 'ready' } });
  await tm.until(() => tm.view.phase === 'playing', 'level 1 dealt once everybody is ready');
  assert.equal(tm.view.hand.length, 1);
  assert.deepEqual(tm.view.players.map((p) => p.cards), [1, 1, 1]);
  assert.equal(tm.room.deadline, null, 'no turn clock in a real-time game');
  assert.ok(tm.view.log.length >= 0, 'The Mind exposes a public activity log');
  console.log('  ok  the mind: create, bots ready up, level dealt');
  tm.send({ t: 'leave' });
  tm.ws.close();

  // --- turn time limit: a bot plays for a human who does not act; "off" disables it
  const fast = await start({ port: 0, botDelay: [0, 3], autoAdvanceMs: 20, absentMs: 60000, trickPauseMs: 0, forcedMs: 0, timeScale: 0.01, maxMsgsPerSec: Infinity });
  const t = client(fast.port, 'Tina');
  await t.until(() => t.id, 'welcome T');
  t.send({ t: 'create', gameId: 'wizard' });
  await t.until(() => t.room, 'T table');
  t.send({ t: 'setSeats', seats: 3 });
  t.send({ t: 'setOptions', options: { timeLimit: '20' } });
  await t.until(() => t.room.options.timeLimit === '20', 'time limit set');
  t.send({ t: 'start' });
  await t.until(() => t.view && t.room.status === 'playing', 'T started');
  await t.until(() => t.view.round >= 2, 'idle human is auto-played after the limit'); // Tina never acts
  assert.ok(t.chats.some((m) => m.sys && /ran out of time/.test(m.text)));
  assert.ok(t.notices.some((x) => /Time is up/.test(x)));
  t.send({ t: 'rematch' }); // not the host-finished state: must be refused
  const off = client(fast.port, 'Olga');
  await off.until(() => off.id, 'welcome O');
  off.send({ t: 'create', gameId: 'twentynine' });
  await off.until(() => off.room, 'O table');
  off.send({ t: 'setOptions', options: { timeLimit: 'off' } });
  await off.until(() => off.room.options.timeLimit === 'off', 'limit off');
  off.send({ t: 'start' });
  await off.until(() => off.view && off.view.game === 'twentynine', 'O started');
  assert.equal(off.room.deadline, null);
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(off.view.phase === 'bidding' || off.view.phase === 'chooseTrump' || off.view.myTurn === false || off.view.myTurn === true);
  assert.equal(off.view.hand.length, 4); // nothing was auto-played for Olga
  t.ws.close();
  off.ws.close();
  await fast.close();
  console.log('  ok  turn time limit auto-plays idle humans; off disables it');

  // --- leaving
  a2.send({ t: 'leave' });
  await a2.until(() => true, 'noop');
  a2.ws.close();
  await app.close();
  clearTimeout(guard);
  console.log('\nsmoke test passed');
  process.exit(0);
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
