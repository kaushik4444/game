'use strict';
const assert = require('node:assert/strict');
const E = require('../games/themind/engine');
const plugin = require('../games/themind');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n' + e.stack); process.exitCode = 1; }
}
function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const people = (n) => Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: 'P' + i }));
const must = (g, id, a) => { const r = E.applyAction(g, id, a); assert.ok(r.ok, JSON.stringify(a) + ': ' + r.error); };
const readyAll = (g) => g.players.forEach((p) => must(g, p.id, { type: 'ready' }));
/** Game at level 1..: everybody ready, hands replaced by the given arrays. */
function rig(hands, opts = {}) {
  const g = E.createGame(people(hands.length), opts, mulberry32(3));
  readyAll(g);
  g.hands = hands.map((h) => h.slice().sort((a, b) => a - b));
  return g;
}
const lowest = (g) => Math.min(...g.hands.flat());
const holder = (g, card) => g.players[g.hands.findIndex((h) => h.includes(card))].id;

console.log('setup');

test('levels, lives and stars by team size; options', () => {
  assert.deepEqual([2, 3, 4].map((n) => E.MAX_LEVELS[n]), [12, 10, 8]);
  for (const [n, lives] of [[2, 2], [3, 3], [4, 4]]) {
    const g = E.createGame(people(n), {}, mulberry32(1));
    assert.equal(g.lives, lives);
    assert.equal(g.stars, 1);
  }
  assert.equal(E.createGame(people(3), { lives: 'easy' }, mulberry32(1)).lives, 4);
  assert.equal(E.createGame(people(3), { lives: 'easy' }, mulberry32(1)).stars, 2);
  assert.equal(E.createGame(people(3), { lives: 'hard' }, mulberry32(1)).stars, 0);
  assert.equal(E.createGame(people(3), { shurikens: false }, mulberry32(1)).stars, 0);
  assert.throws(() => E.createGame(people(5), {}, mulberry32(1)));
});

test('dealing: level N gives N unique sorted cards from 1-100 to each player', () => {
  const g = E.createGame(people(4), {}, mulberry32(7));
  assert.equal(g.phase, 'ready');
  must(g, 'p0', { type: 'ready' });
  assert.equal(g.phase, 'ready', 'waits for everybody');
  for (const id of ['p1', 'p2', 'p3']) must(g, id, { type: 'ready' });
  assert.equal(g.phase, 'playing');
  assert.ok(g.hands.every((h) => h.length === 1));
  g.level = 5; g.phase = 'levelEnd'; g.ready = new Set(); g.hands = g.hands.map(() => []);
  g.level = 4; readyAll(g);
  assert.equal(g.level, 5);
  const all = g.hands.flat();
  assert.equal(all.length, 20);
  assert.equal(new Set(all).size, 20);
  assert.ok(all.every((c) => c >= 1 && c <= 100));
  g.hands.forEach((h) => assert.deepEqual(h, h.slice().sort((a, b) => a - b)));
});

console.log('playing');

test('playing in order clears the level and grants the right bonus', () => {
  const g = rig([[10], [20], [30]]);
  must(g, 'p0', { type: 'play' });
  must(g, 'p1', { type: 'play' });
  assert.equal(g.phase, 'playing');
  must(g, 'p2', { type: 'play' });
  assert.equal(g.phase, 'levelEnd');
  assert.equal(g.lives, 3);
  assert.deepEqual(g.pile.map((p) => p.card), [10, 20, 30]);
  assert.equal(E.bonusFor(2, { shurikens: true }, 10).star, true);
  assert.equal(E.bonusFor(3, {}, 10).life, true);
  assert.equal(E.bonusFor(10, {}, 10).life, false);
  g.level = 3; // clearing level 3 gives a life
  g.phase = 'playing'; g.hands = [[1], [2], [3]]; g.pile = [];
  for (const id of ['p0', 'p1', 'p2']) must(g, id, { type: 'play' });
  assert.equal(g.lives, 4);
  assert.equal(E.viewFor(g, 'p0').clearedBonus.life, true);
});

test('playing too early costs a life and discards every lower card', () => {
  const g = rig([[10, 60], [20, 25], [30, 90]]);
  const lives = g.lives;
  must(g, 'p2', { type: 'play' }); // plays 30 while 10 and 20, 25 are lower
  assert.equal(g.lives, lives - 1);
  assert.deepEqual(g.discarded.map((d) => d.card).sort((a, b) => a - b), [10, 20, 25]);
  assert.deepEqual(g.hands, [[60], [], [90]]);
  assert.equal(g.event.type, 'mistake');
  assert.equal(g.event.discards.length, 3);
  assert.equal(g.stats.mistakes, 1);
});

test('losing the last life ends the game and reveals the hands', () => {
  const g = rig([[10], [20]], {});
  g.lives = 1;
  g.hands = [[10, 11], [20, 21]];
  must(g, 'p1', { type: 'play' });
  assert.equal(g.phase, 'gameOver');
  assert.equal(g.won, false);
  assert.ok(E.viewFor(g, 'p0').finalHands);
  assert.equal(E.applyAction(g, 'p0', { type: 'play' }).ok, false);
});

test('clearing the last level wins', () => {
  const g = rig([[1], [2]]);
  g.level = g.maxLevel;
  must(g, 'p0', { type: 'play' });
  must(g, 'p1', { type: 'play' });
  assert.equal(g.phase, 'gameOver');
  assert.equal(g.won, true);
});

test('play validation: stale card, no cards, not a player, before the level starts', () => {
  const g = E.createGame(people(2), {}, mulberry32(1));
  assert.equal(E.applyAction(g, 'p0', { type: 'play' }).ok, false);
  readyAll(g);
  g.hands = [[5], []];
  assert.equal(E.applyAction(g, 'p1', { type: 'play' }).ok, false);
  assert.equal(E.applyAction(g, 'p0', { type: 'play', card: 6 }).ok, false);
  assert.equal(E.applyAction(g, 'p0', { type: 'play', card: 'x' }).ok, false);
  assert.equal(E.applyAction(g, 'nobody', { type: 'play' }).ok, false);
  assert.equal(E.applyAction(g, 'p0', null).ok, false);
  assert.equal(E.applyAction(g, 'p0', { type: 'dance' }).ok, false);
  must(g, 'p0', { type: 'play', card: 5 });
});

console.log('throwing stars');

test('a star needs everybody with cards to agree, then discards each lowest card without losing a life', () => {
  const g = rig([[10, 50], [20, 60], [30, 70]]);
  const lives = g.lives;
  must(g, 'p0', { type: 'shuriken' });
  must(g, 'p1', { type: 'shuriken' });
  assert.equal(g.stars, 1, 'not yet');
  assert.equal(E.viewFor(g, 'p2').starPending, true);
  must(g, 'p2', { type: 'shuriken' });
  assert.equal(g.stars, 0);
  assert.equal(g.lives, lives);
  assert.deepEqual(g.hands, [[50], [60], [70]]);
  assert.equal(g.event.type, 'star');
  assert.deepEqual(g.event.discards.map((d) => d.card), [10, 20, 30]);
});

test('stars can be cancelled, run out, or be switched off', () => {
  const g = rig([[10, 50], [20, 60]]);
  must(g, 'p0', { type: 'shuriken' });
  must(g, 'p1', { type: 'shuriken', cancel: true });
  assert.equal(g.votes.size, 0);
  g.stars = 0;
  assert.equal(E.applyAction(g, 'p0', { type: 'shuriken' }).ok, false);
  const off = rig([[10], [20]], { shurikens: false });
  assert.equal(E.applyAction(off, 'p0', { type: 'shuriken' }).ok, false);
  assert.equal(E.viewFor(off, 'p0').canStar, false);
});

test('a star on the last cards clears the level', () => {
  const g = rig([[10], [20]]);
  must(g, 'p0', { type: 'shuriken' });
  must(g, 'p1', { type: 'shuriken' });
  assert.equal(g.phase, 'levelEnd');
});

console.log('views');

test('a player sees only their own cards; spectators see none and cannot act', () => {
  const g = rig([[10, 50], [20, 60], [30, 70]]);
  const v = E.viewFor(g, 'p1');
  assert.deepEqual(v.hand, [20, 60]);
  assert.deepEqual(v.players.map((p) => p.cards), [2, 2, 2]);
  assert.ok(v.players.every((p) => Object.keys(p).sort().join() === 'cards,id,name,ready,voted'));
  assert.ok(!('hands' in v) && v.finalHands === null);
  const s = E.viewFor(g, 'watcher');
  assert.equal(s.me, -1);
  assert.deepEqual(s.hand, []);
  assert.equal(s.myTurn, false);
  assert.equal(s.canStar, false);
  assert.equal(E.applyAction(g, 'watcher', { type: 'play' }).ok, false);
  assert.equal(E.applyAction(g, 'watcher', { type: 'ready' }).ok, false);
});

test('plugin: bots time themselves, awaiting lists players with cards', () => {
  const g = plugin.create(people(3), {}, mulberry32(5));
  assert.deepEqual(g.awaiting(), ['p0', 'p1', 'p2']);
  const d = g.botDelayMs('p0');
  assert.ok(Number.isFinite(d) && d > 0);
  assert.equal(g.act('p0', { type: 'ready' }).ok, true);
  assert.equal(g.act('p0', { type: 'x' }).ok, false);
  assert.equal(g.isOver(), false);
});

console.log('simulation');

test('400 games with imperfect timing always finish; bots only ever act legally', () => {
  let wins = 0;
  let losses = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const n = 2 + (seed % 3);
    const rng = mulberry32(seed);
    const g = E.createGame(people(n), { lives: ['standard', 'easy', 'hard'][seed % 3], shurikens: seed % 5 !== 0 }, rng);
    let steps = 0;
    while (g.phase !== 'gameOver') {
      assert.ok(++steps < 5000, 'seed ' + seed + ' stuck');
      if (g.phase === 'ready' || g.phase === 'levelEnd') { readyAll(g); continue; }
      // the right player usually goes first, sometimes somebody jumps the gun
      const withCards = g.players.filter((p, i) => g.hands[i].length);
      const right = holder(g, lowest(g));
      const pick = rng() < 0.93 ? right : withCards[Math.floor(rng() * withCards.length)].id;
      if (g.stars > 0 && rng() < 0.03) { for (const p of withCards) must(g, p.id, { type: 'shuriken' }); continue; }
      const a = E.botAction(g, pick);
      const r = E.applyAction(g, pick, a);
      assert.ok(r.ok, `seed ${seed}: ${JSON.stringify(a)} ${r.error}`);
    }
    if (g.won) wins++; else losses++;
  }
  assert.ok(wins > 20 && losses > 20, `wins ${wins}, losses ${losses}`);
});

console.log(`\n${passed} The Mind tests passed`);
