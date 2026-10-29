'use strict';
const assert = require('node:assert/strict');
const E = require('../games/twentynine/engine');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n' + e.stack); process.exitCode = 1; }
}
function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const people = () => [0, 1, 2, 3].map((i) => ({ id: 'p' + i, name: 'P' + i }));
const card = (suit, rank) => E.buildDeck().find((c) => c.suit === suit && c.rank === rank);
const entry = (player, c, trump = false) => ({ player, card: c, trump });

console.log('29 rules');

test('32 cards worth 28 points; order J > 9 > A > 10 > K > Q > 8 > 7', () => {
  const d = E.buildDeck();
  assert.equal(d.length, 32);
  assert.equal(d.reduce((s, c) => s + c.pts, 0), 28);
  const spades = d.filter((c) => c.suit === 'S').sort((a, b) => b.ord - a.ord).map((c) => c.rank);
  assert.deepEqual(spades, ['J', '9', 'A', '10', 'K', 'Q', '8', '7']);
});

test('trick winner: highest of lead suit; revealed trump cuts; hidden-trump discards do not', () => {
  assert.equal(E.trickWinner([entry(0, card('H', '10')), entry(1, card('H', 'J')), entry(2, card('S', 'J')), entry(3, card('H', '7'))]), 1);
  // spade played while trump hidden is only a discard
  assert.equal(E.trickWinner([entry(0, card('H', '10')), entry(1, card('S', 'J'), false), entry(2, card('H', 'K')), entry(3, card('H', '7'))]), 0);
  // spade played after the trump was shown cuts
  assert.equal(E.trickWinner([entry(0, card('H', 'J')), entry(1, card('S', '7'), true), entry(2, card('H', '9')), entry(3, card('S', '8'), true)]), 3);
  // trump suit led: ordinary comparison among the led suit
  assert.equal(E.trickWinner([entry(0, card('S', '9'), false), entry(1, card('S', 'J'), true), entry(2, card('H', 'J'), false), entry(3, card('S', '7'), true)]), 1);
});

test('bidding: ascending bids 15-28, pass, dealer forced to bid when all pass, 28 ends it', () => {
  const g = E.createGame(people(), {}, mulberry32(1));
  const first = (g.dealer + 1) % 4;
  assert.equal(g.turn, first);
  const id = (s) => g.players[s % 4].id;
  assert.equal(E.applyAction(g, id(first + 1), { type: 'bid', amount: 15 }).ok, false); // not your turn
  assert.equal(E.applyAction(g, id(first), { type: 'bid', amount: 14 }).ok, false); // below minimum
  assert.equal(E.applyAction(g, id(first), { type: 'bid', amount: 29 }).ok, false); // above maximum
  assert.equal(E.applyAction(g, id(first), { type: 'bid', amount: 15.5 }).ok, false);
  assert.equal(E.applyAction(g, id(first), { type: 'bid', pass: true }).ok, true);
  assert.equal(E.applyAction(g, id(first + 1), { type: 'bid', pass: true }).ok, true);
  assert.equal(E.applyAction(g, id(first + 2), { type: 'bid', pass: true }).ok, true);
  assert.equal(E.viewFor(g, id(first + 3)).canPass, false); // dealer must bid
  assert.equal(E.applyAction(g, id(first + 3), { type: 'bid', pass: true }).ok, false);
  assert.equal(E.applyAction(g, id(first + 3), { type: 'bid', amount: 15 }).ok, true);
  assert.equal(g.phase, 'chooseTrump');
  assert.equal(g.turn, g.dealer);

  const h = E.createGame(people(), {}, mulberry32(2));
  const f = (h.dealer + 1) % 4;
  assert.equal(E.applyAction(h, h.players[f].id, { type: 'bid', amount: 20 }).ok, true);
  assert.equal(E.applyAction(h, h.players[(f + 1) % 4].id, { type: 'bid', amount: 20 }).ok, false); // must beat it
  assert.equal(E.applyAction(h, h.players[(f + 1) % 4].id, { type: 'bid', amount: 28 }).ok, true);
  assert.equal(h.phase, 'chooseTrump'); // 28 ends the bidding at once
  assert.equal(h.highBidder, (f + 1) % 4);
});

function toPlaying(seed) {
  const g = E.createGame(people(), {}, mulberry32(seed));
  const f = (g.dealer + 1) % 4;
  E.applyAction(g, g.players[f].id, { type: 'bid', amount: 16 });
  for (let k = 1; k < 4; k++) E.applyAction(g, g.players[(f + k) % 4].id, { type: 'bid', pass: true });
  const bidder = g.players[g.highBidder];
  const suit = bidder.hand[0].suit;
  const other = ['S', 'H', 'D', 'C'].find((s) => !bidder.hand.some((c) => c.suit === s));
  if (other) assert.equal(E.applyAction(g, bidder.id, { type: 'chooseTrump', suit: other }).ok, false); // must hold the suit
  assert.equal(E.applyAction(g, g.players[(g.highBidder + 1) % 4].id, { type: 'chooseTrump', suit }).ok, false);
  assert.equal(E.applyAction(g, bidder.id, { type: 'chooseTrump', suit }).ok, true);
  return g;
}

test('after trump is chosen everybody has 8 cards and the player left of the dealer leads', () => {
  const g = toPlaying(3);
  assert.equal(g.phase, 'playing');
  for (const p of g.players) assert.equal(p.hand.length, 8);
  assert.equal(g.turn, (g.dealer + 1) % 4);
  assert.equal(new Set(g.players.flatMap((p) => p.hand.map((c) => c.id))).size, 32);
});

test('must follow suit; may only ask for trump when void; asker must play trump if holding it', () => {
  const g = toPlaying(5);
  g.players.forEach((p, i) => { p.hand = []; });
  g.trumpSuit = 'S'; g.trumpRevealed = false;
  g.players[0].hand = [card('H', '7'), card('D', '8')];
  g.players[1].hand = [card('H', '8'), card('S', '9')];
  g.players[2].hand = [card('D', '9'), card('S', 'J'), card('S', '7')];
  g.players[3].hand = [card('H', 'J'), card('C', '7')];
  g.turn = 0; g.trick = []; g.revealer = -1;
  assert.equal(E.applyAction(g, 'p0', { type: 'play', cardId: 'H7' }).ok, true);
  assert.equal(E.applyAction(g, 'p1', { type: 'reveal' }).ok, false); // can follow, cannot ask
  assert.equal(E.applyAction(g, 'p1', { type: 'play', cardId: 'S9' }).ok, false); // must follow hearts
  assert.equal(E.applyAction(g, 'p1', { type: 'play', cardId: 'H8' }).ok, true);
  assert.equal(E.viewFor(g, 'p2').canReveal, true);
  assert.equal(E.applyAction(g, 'p2', { type: 'reveal' }).ok, true);
  assert.equal(g.trumpRevealed, true);
  assert.deepEqual(E.viewFor(g, 'p2').legal.sort(), ['S7', 'SJ']); // must trump
  assert.equal(E.applyAction(g, 'p2', { type: 'play', cardId: 'D9' }).ok, false);
  assert.equal(E.applyAction(g, 'p2', { type: 'play', cardId: 'S7' }).ok, true);
  assert.equal(E.applyAction(g, 'p3', { type: 'play', cardId: 'H8' }).ok, false); // not in hand
  assert.equal(E.applyAction(g, 'p3', { type: 'play', cardId: 'H' + 'J' }).ok, true);
  assert.equal(g.lastTrick.winner, 2); // the cut wins
});

test('trump suit is hidden from everyone but the bidder until revealed', () => {
  const g = toPlaying(7);
  const bidder = g.players[g.highBidder].id;
  for (const p of g.players) {
    const v = E.viewFor(g, p.id);
    assert.equal(v.trumpSet, true);
    if (p.id === bidder) assert.equal(v.trumpSuit, g.trumpSuit);
    else assert.equal(v.trumpSuit, null);
    assert.equal(v.hand.length, 8);
  }
  const json = JSON.stringify(E.viewFor(g, g.players[(g.highBidder + 1) % 4].id));
  assert.ok(!json.includes(`"trumpSuit":"${g.trumpSuit}"`));
  assert.equal(E.viewFor(g, 'p0').players.every((p) => p.hand === undefined), true);
});

test('last trick is forced after the first card, unless the player may still ask for the trump', () => {
  const g = toPlaying(5);
  g.players.forEach((p) => { p.hand = []; });
  g.trumpSuit = 'S'; g.trumpRevealed = false; g.revealer = -1;
  g.players[0].hand = [card('H', '7')];
  g.players[1].hand = [card('H', '8')];
  g.players[2].hand = [card('D', '9')]; // void in hearts, trump still hidden: may ask for the trump
  g.players[3].hand = [card('H', 'J')];
  g.turn = 0; g.trick = [];
  assert.equal(E.forcedPlay(g), null);
  assert.equal(E.applyAction(g, 'p0', { type: 'play', cardId: 'H7' }).ok, true);
  assert.equal(E.viewFor(g, 'p2').trickLeader, 0);
  assert.equal(E.forcedPlay(g).playerId, 'p1');
  E.applyAction(g, 'p1', E.forcedPlay(g).action);
  assert.equal(E.viewFor(g, 'p1').trickLeader, 1);
  assert.equal(E.forcedPlay(g), null); // p2 can still reveal
  assert.equal(E.viewFor(g, 'p2').autoPlay, false);
  assert.equal(E.viewFor(g, 'spectator').me, -1);
});

console.log('29 simulation');

test('200 full games: every hand distributes exactly 29 points and scores add up', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const g = E.createGame(people(), { target: [3, 6, 9][seed % 3] }, mulberry32(seed * 13));
    let steps = 0;
    while (g.phase !== 'gameOver') {
      assert.ok(++steps < 20000, 'game did not terminate');
      if (g.phase === 'handEnd') { assert.equal(E.applyAction(g, null, { type: 'continue' }).ok, true); continue; }
      const who = E.awaiting(g)[0];
      assert.ok(who);
      const a = E.botAction(g, who);
      const res = E.applyAction(g, who, a);
      assert.equal(res.ok, true, `${res.error} ${JSON.stringify(a)} phase ${g.phase}`);
    }
    let a = 0, b = 0;
    for (const h of g.history) {
      assert.equal(h.points[0] + h.points[1], 29);
      const t = h.bidder % 2;
      if (h.made) { assert.ok(h.points[t] >= h.bid); t === 0 ? a++ : b++; } else { assert.ok(h.points[t] < h.bid); t === 0 ? a-- : b--; }
    }
    assert.deepEqual(g.teamScore, [a, b]);
    const t = g.options.target;
    assert.ok(g.teamScore.some((s) => s >= t || s <= -t));
    assert.ok(g.winnerTeam === 0 || g.winnerTeam === 1);
  }
});

console.log(`\n${passed} twenty-nine tests passed`);
