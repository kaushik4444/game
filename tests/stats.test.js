'use strict';
// Player stats: the numbers on the profile, and the websocket request that serves them.
require('./helpers/env'); // first: NODE_ENV=test, no .env loading, no DATABASE_URL (memory-mode test)
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { registerAndVerify } = require('./helpers/auth');
const { computeProfile } = require('../db/stats');
const dbMatches = require('../db/matches');
const dbPool = require('../db/pool');
const { start } = require('../server');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n' + e.stack); process.exitCode = 1; }
}
const games = require('../games');
const metrics = (id) => (games.get(id) || {}).stats || null; // each game says what its "best" number means
const day = (n) => new Date(Date.UTC(2026, 9, 1 + n)); // n days after 1 Oct 2026
/** rows newest first: "WLLW" is read left to right, newest first */
const rows = (pattern, game = 'wizard') => [...pattern].map((c, i) => ({ gameId: game, finishedAt: day(100 - i), isWinner: c === 'W', score: 10 * (i + 1) }));

(async () => {
  assert.equal(dbPool.hasDatabase(), false, 'this file tests the in-memory store: it must never be connected to a real database');
  console.log('profile numbers');
  await test('the example: 24 games, 11 wins, 13 losses, 45.8%, favourite Wizard', () => {
    const mix = [];
    for (let i = 0; i < 24; i++) mix.push({ gameId: i < 14 ? 'wizard' : i < 20 ? 'poker' : 'themind', finishedAt: day(200 - i), isWinner: i % 24 < 11, score: i });
    const s = computeProfile(mix);
    assert.equal(s.played, 24);
    assert.equal(s.wins, 11);
    assert.equal(s.losses, 13);
    assert.equal(s.winRate, 45.8);
    assert.equal(s.favouriteGame, 'wizard');
  });
  await test('no games: zeros, no win rate, no favourite', () => {
    const s = computeProfile([]);
    assert.equal(s.played, 0);
    assert.equal(s.winRate, null);
    assert.equal(s.favouriteGame, null);
    assert.deepEqual(s.recent, []);
    assert.deepEqual(s.streak, { current: 0, best: 0 });
    assert.equal(s.lastPlayed, null);
  });
  await test('favourite game is the most played; a tie goes to the game with more wins, then name order', () => {
    const a = [...rows('WW', 'poker'), ...rows('LL', 'wizard')];
    assert.equal(computeProfile(a).favouriteGame, 'poker');
    const b = [...rows('WLL', 'poker'), ...rows('LLLL', 'wizard')];
    assert.equal(computeProfile(b).favouriteGame, 'wizard', 'most played wins even with fewer victories');
    const c = [...rows('LL', 'wizard'), ...rows('LL', 'poker')];
    assert.equal(computeProfile(c).favouriteGame, 'poker', 'full tie: alphabetical');
  });
  await test('streaks: current counts from the newest game, best is the longest run ever', () => {
    const s = computeProfile(rows('WWLWWWWL')); // newest first
    assert.equal(s.streak.current, 2);
    assert.equal(s.streak.best, 4);
    assert.equal(computeProfile(rows('LWW')).streak.current, 0);
  });
  await test('per game record, win rate and best score; recent keeps the newest 10', () => {
    const r = [...rows('WWLL', 'wizard'), ...rows('W', 'poker'), ...rows('LLLLLLLL', 'themind')];
    const s = computeProfile(r, { metrics });
    const w = s.perGame.find((g) => g.gameId === 'wizard');
    assert.deepEqual([w.played, w.wins, w.losses, w.winRate, w.best], [4, 2, 2, 50, 40]);
    assert.equal(s.perGame[0].gameId, 'themind');
    assert.equal(s.recent.length, 10);
    assert.equal(s.recent[0].won, true);
    assert.equal(s.lastPlayed, day(100).toISOString());
  });

  console.log('stats over the store and the websocket');
  await test('the store counts only real games: leavers and bots are excluded', async () => {
    await dbMatches.recordMatch({ matchKey: 'aaaaaaaa-0000-4000-8000-000000000001', roomCode: 'AAAAAA', gameId: 'poker', seats: 2, options: {}, participants: [
      { playerId: '00000000-0000-4000-8000-0000000000b1', name: 'S', seat: 0, score: 900, isWinner: true, isBot: false, leftEarly: false },
      { playerId: '00000000-0000-4000-8000-0000000000b2', name: 'Y', seat: 1, score: 100, isWinner: false, isBot: false, leftEarly: true }] });
    const x = await dbMatches.getPlayerProfile('00000000-0000-4000-8000-0000000000b1', { memberSince: day(0) });
    assert.deepEqual([x.played, x.wins, x.favouriteGame, x.memberSince], [1, 1, 'poker', day(0).toISOString()]);
    assert.equal((await dbMatches.getPlayerProfile('00000000-0000-4000-8000-0000000000b2')).played, 0);
  });

  await test('getStats returns only the asking player\'s own record over the websocket', async () => {
    const srv = await start({ port: 0, trustProxy: false, database: { prepare: async () => ({ mode: 'memory' }) } });
    const auth = await registerAndVerify(srv.port, { email: `stats.${Date.now()}@test.local`, displayName: 'Stat' });
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
    const msgs = [];
    ws.on('message', (d) => msgs.push(JSON.parse(d)));
    await new Promise((r) => ws.on('open', r));
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    ws.send(JSON.stringify({ t: 'hello', token: auth.token })); await wait(200);
    const me = msgs.find((m) => m.t === 'welcome');
    ws.send(JSON.stringify({ t: 'getStats', playerId: '00000000-0000-4000-8000-0000000000b1' })); await wait(150); // asking for somebody else's id must not work
    const first = msgs.filter((m) => m.t === 'stats').pop();
    assert.equal(first.stats.played, 0);
    await dbMatches.recordMatch({ matchKey: 'aaaaaaaa-0000-4000-8000-000000000002', roomCode: 'BBBBBB', gameId: 'wizard', seats: 2, options: {}, participants: [
      { playerId: me.id, name: 'Stat', seat: 0, score: 70, isWinner: true, isBot: false, leftEarly: false },
      { playerId: 'bot_1', name: 'Bot', seat: 1, score: 20, isWinner: false, isBot: true, leftEarly: false }] });
    await wait(1100); // requests are limited to one per second
    ws.send(JSON.stringify({ t: 'getStats' })); await wait(150);
    const second = msgs.filter((m) => m.t === 'stats').pop();
    assert.deepEqual([second.stats.played, second.stats.wins, second.stats.winRate, second.stats.favouriteGame], [1, 1, 100, 'wizard']);
    assert.ok(second.stats.memberSince, 'member since is reported');
    ws.send(JSON.stringify({ t: 'getStats' })); ws.send(JSON.stringify({ t: 'getStats' })); await wait(150);
    assert.equal(msgs.filter((m) => m.t === 'stats').length, 2, 'rapid repeats are ignored');
    ws.close(); await srv.close();
  });

  console.log('what "best" means per game');
  const row = (gameId, score, isWinner, options = {}) => ({ gameId, score, isWinner, options, finishedAt: day(1) });
  await test('wizard: best is the highest final score; the game is a solo game', () => {
    const g = computeProfile([row('wizard', 140, true), row('wizard', 220, true), row('wizard', -30, false)], { metrics }).perGame[0];
    assert.deepEqual([g.kind, g.best, g.bestLabel, g.bestText], ['solo', 220, 'Highest score', '220']);
  });
  await test('29: a team game with no "best score" (a winning team always ends near the target, so a maximum would mislead)', () => {
    const g = computeProfile([row('twentynine', 6, true), row('twentynine', -6, false)], { metrics }).perGame[0];
    assert.deepEqual([g.kind, g.best, g.bestLabel, g.wins, g.losses], ['team', null, null, 1, 1]);
  });
  await test('poker: best is the final stack as a multiple of the starting chips, never raw chips', () => {
    const g = computeProfile([row('poker', 3000, true, { chips: '1000' }), row('poker', 6000, true, { chips: '5000' }), row('poker', 0, false, { chips: '2000' })], { metrics }).perGame[0];
    assert.deepEqual([g.best, g.bestText], [3, '×3']); // 3,000 of 1,000 beats 6,000 of 5,000 (1.2)
    assert.match(g.bestLabel, /starting chips/);
  });
  await test('the mind: a co-operative game; best is the most levels cleared', () => {
    const g = computeProfile([row('themind', 5, false), row('themind', 8, true), row('themind', 3, false)], { metrics }).perGame[0];
    assert.deepEqual([g.kind, g.best, g.bestLabel], ['coop', 8, 'Most levels cleared']);
  });
  await test('an unknown game or a game without a description still counts wins and losses, without a best', () => {
    const g = computeProfile([row('mystery', 99, true)], { metrics }).perGame[0];
    assert.deepEqual([g.played, g.wins, g.best, g.bestLabel, g.kind], [1, 1, null, null, 'solo']);
  });
  await test('the profile sent to players contains no functions or internals', () => {
    const s = JSON.stringify(computeProfile([row('poker', 2000, true, { chips: '1000' })], { metrics }));
    assert.doesNotMatch(s, /formatBest|bestOf/);
  });

  console.log(`\n${passed} stats tests passed`);
})();
