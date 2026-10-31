'use strict';
// Player stats: the numbers on the profile, and the websocket request that serves them.
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { computeProfile } = require('../db/stats');
const dbMatches = require('../db/matches');
const { start } = require('../server');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n' + e.stack); process.exitCode = 1; }
}
const day = (n) => new Date(Date.UTC(2026, 9, 1 + n)); // n days after 1 Oct 2026
/** rows newest first: "WLLW" is read left to right, newest first */
const rows = (pattern, game = 'wizard') => [...pattern].map((c, i) => ({ gameId: game, finishedAt: day(100 - i), isWinner: c === 'W', score: 10 * (i + 1) }));

(async () => {
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
    const s = computeProfile(r);
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
      { playerId: 'sx', name: 'S', seat: 0, score: 900, isWinner: true, isBot: false, leftEarly: false },
      { playerId: 'sy', name: 'Y', seat: 1, score: 100, isWinner: false, isBot: false, leftEarly: true }] });
    const x = await dbMatches.getPlayerProfile('sx', { memberSince: day(0) });
    assert.deepEqual([x.played, x.wins, x.favouriteGame, x.memberSince], [1, 1, 'poker', day(0).toISOString()]);
    assert.equal((await dbMatches.getPlayerProfile('sy')).played, 0);
  });

  await test('getStats returns only the asking player\'s own record over the websocket', async () => {
    const srv = await start({ port: 0, trustProxy: false, database: { prepare: async () => ({ mode: 'memory' }) } });
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
    const msgs = [];
    ws.on('message', (d) => msgs.push(JSON.parse(d)));
    await new Promise((r) => ws.on('open', r));
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    ws.send(JSON.stringify({ t: 'hello', name: 'Stat' })); await wait(200);
    const me = msgs.find((m) => m.t === 'welcome');
    ws.send(JSON.stringify({ t: 'getStats', playerId: 'sx' })); await wait(150); // asking for somebody else's id must not work
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

  console.log(`\n${passed} stats tests passed`);
})();
