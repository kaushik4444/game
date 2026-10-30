'use strict';
const assert = require('node:assert/strict');
const E = require('../games/poker/engine');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n' + e.stack); process.exitCode = 1; }
}
function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const C = (s) => s.split(' ').map((x) => ({ id: x, rank: '23456789TJQKA'.indexOf(x[0]) + 2, suit: x[1] }));
const people = (n) => Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: 'P' + i }));
const opts = (o = {}) => Object.assign({ chips: '1000', blinds: 'fixed', limit: 'last' }, o);
const score = (s) => E.best(C(s)).score;
const beats = (a, b) => E.cmp(score(a), score(b)) > 0;

/** New game with known chips, dealer and cards. holes: ['AS KS', ...]; board: 'a b c d e'. Seat 0 is the dealer. */
function rig(n, { chips, holes, board } = {}) {
  const g = E.createGame(people(n), opts(), mulberry32(1));
  g.players.forEach((p, i) => (p.chips = chips ? chips[i] : 1000)); // undo the blinds of the automatic first hand
  g.dealer = n - 1; // so seat 0 becomes the dealer
  g.handNo = 0;
  E.startHand(g);
  if (holes) holes.forEach((h, i) => (g.players[i].hole = C(h)));
  if (board) {
    const b = C(board);
    const filler = C('2C 3C 4C 5C');
    g.deck = [b[4], filler[0], b[3], filler[1], b[2], b[1], b[0], filler[2]];
  }
  return g;
}
const act = (g, i, a) => E.applyAction(g, g.players[i].id, a);
const must = (g, i, a) => { const r = act(g, i, a); assert.ok(r.ok, JSON.stringify(a) + ': ' + r.error); };

console.log('hands');

test('categories rank in the right order', () => {
  const hands = ['AS KD 9C 6H 3D 2S 4C', 'AS AD 9C 6H 3D 2S 4C', 'AS AD 9C 9H 3D 2S 4C', 'AS AD AC 6H 3D 2S 8C', '5S 6D 7C 8H 9D 2S 2C', 'AS 3S 9S 6S 2S KD 7C', 'AS AD AC 6H 6D 2S 4C', 'AS AD AC AH 3D 2S 4C', '5S 6S 7S 8S 9S 2D 2C'];
  for (let i = 1; i < hands.length; i++) assert.ok(beats(hands[i], hands[i - 1]), hands[i] + ' should beat ' + hands[i - 1]);
});

test('the wheel is the lowest straight; kickers and ties are compared', () => {
  assert.deepEqual(score('AS 2D 3C 4H 5S 9D KD').slice(0, 2), [4, 5]);
  assert.ok(beats('6S 2D 3C 4H 5S 9D KD', 'AS 2D 3C 4H 5S 9D KD'));
  assert.ok(beats('AS AD KC 6H 3D 2S 4C', 'AS AD QC 6H 3D 2S 4C'));
  assert.equal(E.cmp(score('AS KD QC JH 9D 3S 2C'), score('AH KS QD JC 9S 3D 2H')), 0);
  assert.equal(E.describe(score('AS KS QS JS TS 2D 3C')), 'Royal flush');
  assert.equal(E.describe(score('9S 9H 9D KC KD 2C 3C')), 'Full house, Nines over Kings');
});

console.log('betting');

test('three players: blinds, first to act is left of the big blind, 4-colour deck has 52 unique cards', () => {
  assert.equal(new Set(E.buildDeck().map((c) => c.id)).size, 52);
  const g = rig(3);
  assert.equal(g.sb, 1);
  assert.equal(g.bb, 2);
  assert.equal(g.turn, 0);
  assert.deepEqual(g.players.map((p) => p.bet), [0, 10, 20]);
  assert.equal(E.potOf(g), 30);
});

test('heads-up: the dealer is the small blind and acts first before the flop, last after it', () => {
  const g = rig(2);
  assert.equal(g.sb, 0);
  assert.equal(g.bb, 1);
  assert.equal(g.turn, 0);
  must(g, 0, { type: 'call' });
  must(g, 1, { type: 'check' });
  assert.equal(g.street, 'flop');
  assert.equal(g.turn, 1, 'the big blind acts first after the flop');
});

test('actions are validated', () => {
  const g = rig(3);
  assert.equal(act(g, 1, { type: 'call' }).ok, false, 'not your turn');
  assert.equal(act(g, 0, { type: 'check' }).ok, false, 'cannot check facing the big blind');
  assert.equal(act(g, 0, { type: 'raise', to: 30 }).ok, false, 'min raise is to 40');
  assert.equal(act(g, 0, { type: 'raise', to: 40.5 }).ok, false);
  assert.equal(act(g, 0, { type: 'raise', to: 5000 }).ok, false, 'more than you have');
  assert.equal(act(g, 0, { type: 'dance' }).ok, false);
  assert.equal(E.applyAction(g, 'stranger', { type: 'fold' }).ok, false);
  assert.equal(E.applyAction(g, g.players[0].id, null).ok, false);
  must(g, 0, { type: 'raise', to: 40 });
  assert.equal(act(g, 1, { type: 'raise', to: 50 }).ok, false, 'a re-raise must add at least the last raise (to 60)');
  must(g, 1, { type: 'raise', to: 60 });
});

test('everybody folds: the last player takes the pot and nothing is shown', () => {
  const g = rig(3);
  must(g, 0, { type: 'fold' });
  must(g, 1, { type: 'fold' });
  assert.equal(g.phase, 'handEnd');
  assert.equal(g.players[2].chips, 1010);
  assert.equal(g.result.showdown, false);
  assert.ok(E.viewFor(g, 'p0').players.every((p) => p.cards === null));
});

test('a full hand to showdown: streets, best hand wins, chips add up', () => {
  const g = rig(3, { holes: ['AS AD', '7C 2D', 'KS KD'], board: '9H 5C 3D JS 4H' });
  must(g, 0, { type: 'call' });
  must(g, 1, { type: 'call' });
  must(g, 2, { type: 'check' });
  assert.equal(g.street, 'flop');
  assert.equal(g.board.length, 3);
  assert.equal(g.turn, 1, 'first live player left of the dealer');
  for (const i of [1, 2, 0]) must(g, i, { type: 'check' });
  assert.equal(g.street, 'turn');
  for (const i of [1, 2, 0]) must(g, i, { type: 'check' });
  assert.equal(g.street, 'river');
  must(g, 1, { type: 'raise', to: 100 });
  must(g, 2, { type: 'call' });
  must(g, 0, { type: 'call' });
  assert.equal(g.phase, 'handEnd');
  assert.equal(g.result.showdown, true);
  assert.equal(g.result.winners.length, 1);
  assert.equal(g.result.winners[0].player, 0);
  assert.equal(g.result.winners[0].hand, 'Pair of Aces');
  assert.deepEqual(g.players.map((p) => p.chips), [1240, 880, 880]);
  assert.equal(g.players.reduce((s, p) => s + p.chips, 0), 3000);
});

test('side pots: a short all-in only wins what it covered', () => {
  const g = rig(3, { chips: [100, 300, 300], holes: ['AS AD', 'KS KD', 'QS QD'], board: '2H 5C 9D JS 4H' });
  must(g, 0, { type: 'allin' }); // 100
  must(g, 1, { type: 'allin' }); // 300
  must(g, 2, { type: 'call' });
  assert.equal(g.phase, 'handEnd');
  assert.deepEqual(g.result.pots.map((p) => p.amount), [300, 400]);
  assert.deepEqual(g.players.map((p) => p.chips), [300, 400, 0]);
  assert.equal(g.players[2].out, true);
});

test('an uncalled bet is returned', () => {
  const g = rig(2, { chips: [1000, 200], holes: ['2S 3D', 'AS AD'], board: '9H 5C 8D JS 4H' });
  must(g, 0, { type: 'allin' });
  must(g, 1, { type: 'call' });
  assert.deepEqual(g.players.map((p) => p.chips), [800, 400]);
});

test('split pots share equally and the odd chip goes left of the dealer', () => {
  const g = rig(3, { holes: ['AS KD', 'AH KC', '2S 3D'], board: 'QH JC TD 4S 5H' });
  must(g, 0, { type: 'call' });
  must(g, 1, { type: 'call' });
  must(g, 2, { type: 'check' });
  for (let k = 0; k < 3; k++) for (const i of [1, 2, 0]) if (g.phase === 'betting' && g.turn === i) must(g, i, { type: 'check' });
  assert.equal(g.phase, 'handEnd');
  assert.equal(g.result.winners.length, 2);
  assert.equal(g.players[0].chips + g.players[1].chips + g.players[2].chips, 3000);
  assert.equal(g.players[0].chips, 1010);
  assert.equal(g.players[1].chips, 1010);
  assert.equal(g.players[2].chips, 980);
});

test('an incomplete all-in raise does not let earlier bettors raise again', () => {
  const g = rig(3, { chips: [1000, 130, 1000] });
  must(g, 0, { type: 'raise', to: 100 });
  must(g, 1, { type: 'allin' }); // to 130, only 30 more
  must(g, 2, { type: 'call' }); // calls 130 from the big blind
  assert.equal(g.turn, 0);
  const v = E.viewFor(g, 'p0');
  assert.equal(v.canRaise, false);
  assert.equal(act(g, 0, { type: 'raise', to: 300 }).ok, false);
  must(g, 0, { type: 'call' });
});

test('blinds rise on schedule and the game ends after the chosen number of hands', () => {
  const g = E.createGame(people(2), opts({ blinds: 'fast', limit: '4' }), mulberry32(9));
  const seen = [];
  for (let i = 0; i < 4; i++) {
    seen.push(E.viewFor(g, 'p0').blinds.bb);
    while (g.phase === 'betting') must(g, g.turn, { type: 'fold' });
    if (g.phase === 'handEnd') E.applyAction(g, null, { type: 'continue' });
  }
  assert.deepEqual(seen, [20, 20, 20, 30]);
  assert.equal(g.phase, 'gameOver');
  assert.equal(g.standings[0].rank, 1);
  assert.equal(E.applyAction(g, 'p0', { type: 'continue' }).ok, false);
});

console.log('privacy');

test('views never leak other hole cards; spectators see none; shown at showdown', () => {
  const g = rig(3, { holes: ['AS AD', 'KS KD', 'QS QD'], board: '2H 5C 9D JS 4H' });
  for (const id of ['p0', 'p1', 'p2', 'watcher']) {
    const v = E.viewFor(g, id);
    const json = JSON.stringify(v);
    g.players.forEach((p, i) => {
      if (p.id === id) return;
      for (const c of p.hole) assert.ok(!json.includes(`"id":"${c.id}"`), `${id} can see ${c.id}`);
    });
    if (id === 'watcher') { assert.equal(v.me, -1); assert.deepEqual(v.hand, []); assert.equal(v.myTurn, false); }
  }
  must(g, 0, { type: 'call' });
  must(g, 1, { type: 'call' });
  must(g, 2, { type: 'check' });
  for (let k = 0; k < 3; k++) for (const i of [1, 2, 0]) if (g.phase === 'betting' && g.turn === i) must(g, i, { type: 'check' });
  const end = E.viewFor(g, 'watcher');
  assert.equal(end.phase, 'handEnd');
  assert.ok(end.players.every((p) => p.cards && p.cards.length === 2));
});

console.log('simulation');

test('300 bot-only games finish, bots are always legal and chips are conserved', () => {
  let hands = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const n = 2 + (seed % 7);
    const o = opts({ chips: ['1000', '2000', '5000'][seed % 3], blinds: ['fixed', 'slow', 'normal', 'fast'][seed % 4], limit: ['last', '10', '20', '30'][seed % 4] });
    const g = E.createGame(people(n), o, mulberry32(seed));
    const total = n * Number(o.chips);
    let steps = 0;
    while (g.phase !== 'gameOver') {
      assert.ok(++steps < 30000, 'seed ' + seed + ' did not finish');
      const sum = g.players.reduce((s, p) => s + p.chips + (g.phase === 'betting' ? p.total : 0), 0);
      assert.equal(sum, total, 'chips conserved, seed ' + seed);
      if (g.phase === 'handEnd') { hands++; must(g, 0, { type: 'continue' }); continue; }
      const p = g.players[g.turn];
      const a = E.botAction(g, p.id);
      const r = E.applyAction(g, p.id, a);
      assert.ok(r.ok, `seed ${seed}: ${JSON.stringify(a)} ${r.error}`);
    }
    assert.equal(g.players.reduce((s, p) => s + p.chips, 0), total);
  }
  assert.ok(hands > 3000);
});

console.log(`\n${passed} poker tests passed`);
