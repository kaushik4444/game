'use strict';
const assert = require('node:assert/strict');
const E = require('../games/wizard/engine');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (e) {
    console.error('FAIL  ' + name + '\n' + e.stack);
    process.exitCode = 1;
  }
}
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const num = (suit, rank) => ({ id: suit + rank, type: 'num', suit, rank });
const W = (i = 1) => ({ id: 'W' + i, type: 'wizard', suit: null, rank: null });
const J = (i = 1) => ({ id: 'J' + i, type: 'jester', suit: null, rank: null });
const play = (player, card) => ({ player, card });
const people = (n) => Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: 'P' + i }));

console.log('rules');

test('deck has 60 unique cards: 52 numbers, 4 wizards, 4 jesters', () => {
  const d = E.buildDeck();
  assert.equal(d.length, 60);
  assert.equal(new Set(d.map((c) => c.id)).size, 60);
  assert.equal(d.filter((c) => c.type === 'wizard').length, 4);
  assert.equal(d.filter((c) => c.type === 'jester').length, 4);
});

test('led suit: first non-jester decides; wizard led means no suit', () => {
  assert.equal(E.ledSuit([]), null);
  assert.equal(E.ledSuit([play(0, num('R', 5))]), 'R');
  assert.equal(E.ledSuit([play(0, J()), play(1, num('G', 2))]), 'G');
  assert.equal(E.ledSuit([play(0, J()), play(1, W()), play(2, num('G', 2))]), null);
  assert.equal(E.ledSuit([play(0, W()), play(1, num('G', 2))]), null);
  assert.equal(E.ledSuit([play(0, J()), play(1, J(2))]), null);
});

test('must follow suit, but wizards and jesters are always legal', () => {
  const hand = [num('R', 3), num('G', 9), W(), J()];
  const ids = (cs) => cs.map((c) => c.id).sort();
  assert.deepEqual(ids(E.legalCards(hand, [play(0, num('R', 7))])), ['J1', 'R3', 'W1']);
  assert.deepEqual(ids(E.legalCards(hand, [])), ids(hand));
  assert.deepEqual(ids(E.legalCards(hand, [play(0, W())])), ids(hand));
  // no card of the led suit -> anything goes
  assert.deepEqual(ids(E.legalCards([num('G', 1), num('B', 2)], [play(0, num('R', 7))])), ['B2', 'G1']);
});

test('trick winner: wizard > trump > led suit; first wizard wins; all jesters -> first', () => {
  const t = (cards, trump) => E.trickWinner(cards.map((c, i) => play(i, c)), trump);
  assert.equal(t([num('R', 13), W(1), W(2), num('R', 1)], 'R'), 1);
  assert.equal(t([num('R', 13), num('G', 2), num('R', 5)], 'G'), 1); // trump beats led suit
  assert.equal(t([num('R', 4), num('G', 13), num('R', 9)], 'B'), 2); // off-suit loses
  assert.equal(t([num('R', 4), num('G', 13), num('R', 9)], null), 2);
  assert.equal(t([J(1), J(2), J(3)], 'R'), 0);
  assert.equal(t([J(1), num('B', 2), num('B', 3), num('R', 13)], null), 2); // jester led: next number sets suit
  assert.equal(t([num('G', 2), J(), num('G', 3)], null), 2);
  assert.equal(t([num('R', 2), num('G', 3), num('B', 4)], 'B'), 2);
  assert.equal(t([num('R', 2), num('G', 3), num('B', 4), num('G', 5)], 'G'), 3); // highest trump
});

test('scoring: exact = 20 + 10/trick, miss = -10 per trick off', () => {
  assert.equal(E.scoreFor(0, 0), 20);
  assert.equal(E.scoreFor(3, 3), 50);
  assert.equal(E.scoreFor(2, 0), -20);
  assert.equal(E.scoreFor(0, 3), -30);
});

console.log('game flow');

test('round structure for 3-6 players', () => {
  for (const [n, rounds] of [[3, 20], [4, 15], [5, 12], [6, 10]]) {
    const g = E.createGame(people(n), {}, mulberry32(n));
    assert.equal(g.totalRounds, rounds);
    assert.equal(g.round, 1);
    for (const p of g.players) assert.equal(p.hand.length, 1);
  }
  assert.throws(() => E.createGame(people(2)));
  assert.throws(() => E.createGame(people(7)));
});

test('bidding starts left of dealer, dealer bids last, then the same seat leads', () => {
  const g = E.createGame(people(4), {}, mulberry32(7));
  if (g.phase === 'chooseTrump') E.applyAction(g, g.players[g.dealer].id, { type: 'chooseTrump', suit: 'R' });
  const first = (g.dealer + 1) % 4;
  assert.equal(g.turn, first);
  for (let k = 0; k < 4; k++) {
    assert.equal(g.turn, (first + k) % 4);
    assert.equal(E.applyAction(g, g.players[g.turn].id, { type: 'bid', amount: 0 }).ok, true);
  }
  assert.equal(g.phase, 'playing');
  assert.equal(g.turn, first);
  assert.equal(g.dealer, (first + 3) % 4);
});

test('actions are validated', () => {
  const g = E.createGame(people(3), {}, mulberry32(3));
  if (g.phase === 'chooseTrump') {
    assert.equal(E.applyAction(g, g.players[(g.dealer + 1) % 3].id, { type: 'chooseTrump', suit: 'R' }).ok, false);
    assert.equal(E.applyAction(g, g.players[g.dealer].id, { type: 'chooseTrump', suit: 'X' }).ok, false);
    E.applyAction(g, g.players[g.dealer].id, { type: 'chooseTrump', suit: 'R' });
  }
  const wrong = g.players[(g.turn + 1) % 3].id;
  const right = g.players[g.turn].id;
  assert.equal(E.applyAction(g, wrong, { type: 'bid', amount: 0 }).ok, false); // not your turn
  assert.equal(E.applyAction(g, right, { type: 'bid', amount: 2 }).ok, false); // more than the round allows
  assert.equal(E.applyAction(g, right, { type: 'bid', amount: -1 }).ok, false);
  assert.equal(E.applyAction(g, right, { type: 'bid', amount: 0.5 }).ok, false);
  assert.equal(E.applyAction(g, right, { type: 'bid', amount: '1' }).ok, false);
  assert.equal(E.applyAction(g, right, { type: 'play', cardId: 'R1' }).ok, false); // wrong phase
  assert.equal(E.applyAction(g, 'nobody', { type: 'bid', amount: 0 }).ok, false);
  assert.equal(E.applyAction(g, right, null).ok, false);
  assert.equal(E.applyAction(g, right, { type: 'constructor' }).ok, false);
  assert.equal(E.applyAction(g, right, { type: 'continue' }).ok, false);
  assert.equal(E.applyAction(g, right, { type: 'bid', amount: 1 }).ok, true);
});

test('following suit is enforced and a trick is resolved correctly', () => {
  const g = E.createGame(people(3), {}, mulberry32(11));
  g.round = 2; g.phase = 'playing'; g.trumpSuit = null; g.trumpCard = null; g.turn = 0; g.dealer = 2;
  g.players.forEach((p) => { p.bid = 0; p.tricks = 0; });
  g.players[0].hand = [num('R', 5), num('G', 1)];
  g.players[1].hand = [num('R', 9), num('B', 2)];
  g.players[2].hand = [num('G', 12), num('R', 2)];
  assert.equal(E.applyAction(g, 'p0', { type: 'play', cardId: 'R5' }).ok, true);
  assert.equal(E.applyAction(g, 'p1', { type: 'play', cardId: 'B2' }).ok, false); // has red, must follow
  assert.equal(E.applyAction(g, 'p1', { type: 'play', cardId: 'R9' }).ok, true);
  assert.equal(E.applyAction(g, 'p2', { type: 'play', cardId: 'G12' }).ok, false);
  assert.equal(E.applyAction(g, 'p2', { type: 'play', cardId: 'R2' }).ok, true);
  assert.equal(g.players[1].tricks, 1);
  assert.equal(g.turn, 1); // winner leads next
  assert.equal(g.lastTrick.winner, 1);
  assert.equal(g.trick.length, 0);
});

test('stick-the-dealer option forbids the bid that makes the total equal the tricks', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const g = E.createGame(people(4), { variant: 'plusminus' }, mulberry32(seed));
    while (g.phase !== 'gameOver') {
      const who = E.awaiting(g);
      const before = g.phase;
      const res = E.applyAction(g, who, E.botAction(g, who));
      assert.equal(res.ok, true, res.error);
      if (before === 'bidding' && g.phase === 'playing') {
        const total = g.players.reduce((s, p) => s + p.bid, 0);
        assert.notEqual(total, g.round, `seed ${seed} round ${g.round}`);
      }
      if (g.phase === 'roundEnd') E.applyAction(g, null, { type: 'continue' });
    }
  }
});

test('the dealer is forced off the forbidden bid in the view', () => {
  const g = E.createGame(people(3), { variant: 'plusminus' }, mulberry32(5));
  if (g.phase === 'chooseTrump') E.applyAction(g, g.players[g.dealer].id, { type: 'chooseTrump', suit: 'B' });
  E.applyAction(g, E.awaiting(g), { type: 'bid', amount: 1 });
  E.applyAction(g, E.awaiting(g), { type: 'bid', amount: 0 });
  const dealer = g.players[g.dealer].id;
  assert.equal(E.viewFor(g, dealer).forbiddenBid, 0);
  assert.equal(E.applyAction(g, dealer, { type: 'bid', amount: 0 }).ok, false);
  assert.equal(E.applyAction(g, dealer, { type: 'bid', amount: 1 }).ok, true);
});

test('wizard turned up lets the dealer choose trump; jester / last round means no trump', () => {
  let sawWizard = false, sawJester = false;
  for (let seed = 1; seed < 400 && !(sawWizard && sawJester); seed++) {
    const g = E.createGame(people(3), {}, mulberry32(seed));
    if (g.trumpCard.type === 'wizard') {
      sawWizard = true;
      assert.equal(g.phase, 'chooseTrump');
      assert.equal(g.trumpSuit, null);
      assert.equal(E.awaiting(g), g.players[g.dealer].id);
    }
    if (g.trumpCard.type === 'jester') {
      sawJester = true;
      assert.equal(g.phase, 'bidding');
      assert.equal(g.trumpSuit, null);
    }
  }
  assert.ok(sawWizard && sawJester);
  // last round deals the whole deck, so there is no trump card
  const last = E.createGame(people(3), {}, mulberry32(2));
  last.round = 19; last.phase = 'roundEnd';
  E.applyAction(last, null, { type: 'continue' });
  assert.equal(last.round, 20);
  assert.equal(last.trumpCard, null);
  assert.equal(last.trumpSuit, null);
  assert.equal(last.phase, 'bidding');
});

test('views never leak other players\' hands', () => {
  const g = E.createGame(people(4), {}, mulberry32(9));
  const v = E.viewFor(g, 'p1');
  assert.equal(v.me, 1);
  assert.equal(v.hand.length, 1);
  assert.deepEqual(v.hand, g.players[1].hand);
  for (const p of v.players) assert.equal(p.hand, undefined);
  const json = JSON.stringify(v);
  for (const i of [0, 2, 3]) {
    const id = g.players[i].hand[0].id;
    // the card may legitimately be the visible trump card; otherwise it must not appear
    if (!(v.trumpCard && v.trumpCard.id === id)) assert.ok(!json.includes(`"id":"${id}"`), `leaked ${id}`);
  }
  assert.equal(E.viewFor(g, 'spectator').hand.length, 0);
});

test('last trick: after the first card the rest is forced; trickLeader tracks the winning card', () => {
  const g = E.createGame(people(3), {}, mulberry32(11));
  g.round = 1; g.phase = 'playing'; g.trumpSuit = 'G'; g.turn = 0; g.dealer = 2;
  g.players.forEach((p) => { p.bid = 0; p.tricks = 0; });
  g.players[0].hand = [num('R', 5)];
  g.players[1].hand = [num('R', 9)];
  g.players[2].hand = [num('G', 2)];
  assert.equal(E.forcedPlay(g), null); // the leader still plays by hand
  assert.equal(E.viewFor(g, 'p0').autoPlay, false);
  assert.equal(E.viewFor(g, 'p0').trickLeader, null);
  assert.equal(E.applyAction(g, 'p0', { type: 'play', cardId: 'R5' }).ok, true);
  assert.deepEqual(E.forcedPlay(g), { playerId: 'p1', action: { type: 'play', cardId: 'R9' } });
  assert.equal(E.viewFor(g, 'p1').autoPlay, true);
  assert.equal(E.viewFor(g, 'p2').autoPlay, false);
  assert.equal(E.viewFor(g, 'p2').trickLeader, 0);
  E.applyAction(g, 'p1', E.forcedPlay(g).action);
  assert.equal(E.viewFor(g, 'p2').trickLeader, 1);
  E.applyAction(g, 'p2', E.forcedPlay(g).action);
  assert.equal(g.lastTrick.winner, 2); // trump 2 beats the reds
  assert.equal(E.forcedPlay(g), null);
});

test('spectators (unknown player ids) see no hands and no foresight cards', () => {
  const g = E.createGame(people(4), { foresight: true }, mulberry32(8));
  const v = E.viewFor(g, 'watcher');
  assert.equal(v.me, -1);
  assert.equal(v.hand.length, 0);
  assert.equal(v.foresight.length, 0);
  assert.equal(v.myTurn, false);
});

console.log('variants');

function playOut(g) {
  let steps = 0;
  while (g.phase !== 'gameOver') {
    assert.ok(++steps < 30000, 'game did not terminate');
    if (g.phase === 'roundEnd') { assert.equal(E.applyAction(g, null, { type: 'continue' }).ok, true); continue; }
    const who = E.awaitingList(g)[0];
    assert.ok(who, 'someone must be awaited in phase ' + g.phase);
    const res = E.applyAction(g, who, E.botAction(g, who));
    assert.equal(res.ok, true, res.error);
  }
}

test('hidden prediction: everyone bids at once; others\' bids are masked until play starts', () => {
  const g = E.createGame(people(4), { variant: 'hidden' }, mulberry32(21));
  if (g.phase === 'chooseTrump') E.applyAction(g, g.players[g.dealer].id, { type: 'chooseTrump', suit: 'R' });
  assert.equal(E.awaitingList(g).length, 4);
  assert.equal(E.applyAction(g, 'p2', { type: 'bid', amount: 1 }).ok, true); // any order
  assert.equal(E.applyAction(g, 'p2', { type: 'bid', amount: 0 }).ok, false); // only once
  assert.equal(E.awaitingList(g).length, 3);
  let v = E.viewFor(g, 'p0');
  assert.equal(v.players[2].bid, null);
  assert.equal(v.players[2].hasBid, true);
  assert.equal(E.viewFor(g, 'p2').players[2].bid, 1);
  for (const id of ['p0', 'p1', 'p3']) E.applyAction(g, id, { type: 'bid', amount: 0 });
  assert.equal(g.phase, 'playing');
  v = E.viewFor(g, 'p0');
  assert.equal(v.players[2].bid, 1); // revealed before the round starts
});

test('secret prediction: bids stay masked during play and show in the round history', () => {
  const g = E.createGame(people(3), { variant: 'secret' }, mulberry32(4));
  if (g.phase === 'chooseTrump') E.applyAction(g, g.players[g.dealer].id, { type: 'chooseTrump', suit: 'R' });
  for (const id of ['p0', 'p1', 'p2']) E.applyAction(g, id, { type: 'bid', amount: 1 });
  assert.equal(g.phase, 'playing');
  assert.equal(E.viewFor(g, 'p0').players[1].bid, null);
  assert.equal(E.viewFor(g, 'p0').players[0].bid, 1); // your own is always visible
  while (g.phase === 'playing') { const w = E.awaitingList(g)[0]; E.applyAction(g, w, E.botAction(g, w)); }
  assert.equal(g.phase, 'roundEnd');
  assert.equal(E.viewFor(g, 'p0').players[1].bid, 1);
  assert.equal(g.history[0].rows[1].bid, 1);
});

test('plus/minus 1: total bids never equal the tricks available', () => {
  for (let seed = 1; seed <= 15; seed++) {
    const g = E.createGame(people(5), { variant: 'plusminus' }, mulberry32(seed));
    let steps = 0;
    while (g.phase !== 'gameOver' && ++steps < 20000) {
      if (g.phase === 'roundEnd') { E.applyAction(g, null, { type: 'continue' }); continue; }
      const who = E.awaitingList(g)[0];
      const wasBidding = g.phase === 'bidding';
      E.applyAction(g, who, E.botAction(g, who));
      if (wasBidding && g.phase === 'playing') assert.notEqual(g.players.reduce((s, p) => s + p.bid, 0), g.round);
    }
  }
});

test('foresight: round 1 hides your own card, shows the others, and you can still play it', () => {
  const g = E.createGame(people(4), { foresight: true }, mulberry32(8));
  const mine = g.players[0].hand[0];
  const v = E.viewFor(g, 'p0');
  assert.deepEqual(v.hand, [{ id: 'hidden', type: 'back' }]);
  assert.equal(v.foresight.length, 3);
  assert.ok(v.foresight.every((f) => f.player !== 0));
  assert.deepEqual(v.foresight.map((f) => f.card.id).sort(), [1, 2, 3].map((i) => g.players[i].hand[0].id).sort());
  if (!(v.trumpCard && v.trumpCard.id === mine.id)) assert.ok(!JSON.stringify(v).includes(`"id":"${mine.id}"`), 'own card leaked');
  if (g.phase === 'chooseTrump') E.applyAction(g, g.players[g.dealer].id, { type: 'chooseTrump', suit: 'G' });
  while (g.phase === 'bidding') { const w = E.awaitingList(g)[0]; E.applyAction(g, w, E.botAction(g, w)); }
  while (E.awaiting(g) !== 'p0') { const w = E.awaiting(g); E.applyAction(g, w, E.botAction(g, w)); }
  assert.deepEqual(E.viewFor(g, 'p0').legal, ['hidden']);
  assert.equal(E.applyAction(g, 'p0', { type: 'play', cardId: 'hidden' }).ok, true);
  const trickCard = g.trick.concat(g.lastTrick ? g.lastTrick.cards : []).find((t) => t.player === 0).card;
  assert.equal(trickCard.id, mine.id);
  // later rounds are normal
  while (g.round === 1) { const w = E.awaitingList(g)[0]; if (!w) { E.applyAction(g, null, { type: 'continue' }); continue; } E.applyAction(g, w, E.botAction(g, w)); }
  assert.ok(E.viewFor(g, 'p0').hand.every((c) => c.type !== 'back'));
  assert.equal(E.viewFor(g, 'p0').foresight.length, 0);
});

test('every variant x foresight x player count plays to the end', () => {
  for (const variant of ['none', 'plusminus', 'hidden', 'secret']) {
    for (const foresight of [false, true]) {
      for (const n of [3, 4, 5, 6]) {
        const g = E.createGame(people(n), { variant, foresight }, mulberry32(n * 7 + variant.length));
        playOut(g);
        assert.equal(g.history.length, 60 / n);
      }
    }
  }
});

test('short game ends after 5 rounds', () => {
  for (const n of [3, 4, 5, 6]) {
    const g = E.createGame(people(n), { length: 'short' }, mulberry32(n));
    playOut(g);
    assert.equal(g.history.length, 5);
  }
  assert.equal(E.createGame(people(6), { length: 'short' }, mulberry32(1)).totalRounds, 5);
});

console.log('simulation');

test('full games (3-6 players, 30 seeds each) complete with consistent totals', () => {
  for (const n of [3, 4, 5, 6]) {
    for (let seed = 1; seed <= 30; seed++) {
      const g = E.createGame(people(n), {}, mulberry32(seed * 100 + n));
      let steps = 0;
      while (g.phase !== 'gameOver') {
        assert.ok(++steps < 20000, 'game did not terminate');
        if (g.phase === 'roundEnd') {
          assert.equal(E.applyAction(g, null, { type: 'continue' }).ok, true);
          continue;
        }
        const who = E.awaiting(g);
        assert.ok(who, 'someone must be awaited in phase ' + g.phase);
        const action = E.botAction(g, who);
        const res = E.applyAction(g, who, action);
        assert.equal(res.ok, true, `${res.error} (${JSON.stringify(action)})`);
        if (g.phase === 'playing' || g.phase === 'roundEnd') {
          // card conservation: hands + trick never exceed the round size
          for (const p of g.players) assert.ok(p.hand.length <= g.round);
        }
      }
      assert.equal(g.history.length, g.totalRounds);
      g.history.forEach((h, k) => {
        assert.equal(h.round, k + 1);
        assert.equal(h.rows.reduce((s, r) => s + r.tricks, 0), h.round, 'tricks per round = cards per player');
      });
      g.players.forEach((p, i) => {
        assert.equal(p.score, g.history.reduce((s, h) => s + h.rows[i].delta, 0));
      });
      assert.ok(E.viewFor(g, 'p0').winners.length >= 1);
    }
  }
});

test('bots outscore a player who always bids the maximum', () => {
  // Sanity check on bot quality: bots should beat random-ish bidding on average.
  let botTotal = 0, naiveTotal = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const g = E.createGame(people(4), {}, mulberry32(seed));
    while (g.phase !== 'gameOver') {
      if (g.phase === 'roundEnd') { E.applyAction(g, null, { type: 'continue' }); continue; }
      const who = E.awaiting(g);
      let a = E.botAction(g, who);
      if (who === 'p0' && a.type === 'bid') a = { type: 'bid', amount: g.round }; // naive: always bid everything
      assert.equal(E.applyAction(g, who, a).ok, true);
    }
    naiveTotal += g.players[0].score;
    botTotal += (g.players[1].score + g.players[2].score + g.players[3].score) / 3;
  }
  assert.ok(botTotal > naiveTotal, `bots ${botTotal} vs naive ${naiveTotal}`);
});

console.log(`\n${passed} engine tests passed`);
