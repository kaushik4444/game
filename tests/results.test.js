'use strict';
// Match history: every game must report per-seat results, and a finished room becomes exactly one correct record.
const assert = require('node:assert/strict');
const games = require('../games');
const { buildMatchRecord } = require('../db/matchRecord');
const dbMatches = require('../db/matches');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n' + e.stack); process.exitCode = 1; }
}
function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const defaults = (def, over = {}) => Object.assign(Object.fromEntries(def.options.map((o) => [o.key, o.default])), over);

/** Play a whole game with bots only, the way the server does, and return the finished game. */
function playOut(id, n, over, seed) {
  const def = games.get(id);
  const players = Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: 'P' + i }));
  const g = def.create(players, defaults(def, over), mulberry32(seed));
  for (let step = 0; !g.isOver(); step++) {
    assert.ok(step < 200000, `${id} did not finish`);
    const waiting = g.awaiting();
    if (waiting.length) {
      const who = waiting[0];
      const forced = g.forcedPlay ? g.forcedPlay() : null;
      const r = forced ? g.act(forced.playerId, forced.action) : g.act(who, g.botAction(who));
      assert.ok(r.ok, `${id}: ${r.error}`);
    } else {
      const auto = g.autoAction();
      assert.ok(auto, `${id}: stuck with nobody to act`);
      assert.ok(g.act(null, auto).ok);
    }
  }
  return { g, players };
}

const room = (id, members, extra = {}) => ({ code: 'ABC123', gameId: id, seats: members.length, options: {}, matchKey: '11111111-1111-4111-8111-111111111111', startedAt: Date.now() - 60000, members, leftEarly: new Set(), ...extra });
const seatsOf = (players) => players.map((p) => ({ id: p.id, name: p.name, bot: false }));

(async () => {
  console.log('results per game');
  for (const [id, n, over] of [['wizard', 3, {}], ['wizard', 4, {}], ['twentynine', 4, {}], ['poker', 3, { limit: '10' }], ['poker', 2, { limit: '10' }], ['themind', 2, {}], ['themind', 3, {}]]) {
    await test(`${id} (${n} players) reports a result for every seat and at least one winner`, async () => {
      const { g, players } = playOut(id, n, over, 7 + n);
      const res = g.results();
      assert.equal(res.length, n);
      assert.ok(res.every((r) => Number.isFinite(r.score) && typeof r.winner === 'boolean'));
      assert.ok(res.some((r) => r.winner) || id === 'themind', 'somebody won');
      const rec = buildMatchRecord(room(id, seatsOf(players)), g);
      assert.equal(rec.participants.length, n);
    });
  }

  await test('wizard: the highest score wins, ties share the win', async () => {
    const { g } = playOut('wizard', 3, {}, 11);
    const res = g.results();
    const best = Math.max(...res.map((r) => r.score));
    res.forEach((r) => assert.equal(r.winner, r.score === best));
  });

  await test('twentynine: both members of the winning team win, nobody on the other team', async () => {
    const { g } = playOut('twentynine', 4, {}, 5);
    const res = g.results();
    assert.equal(res[0].winner, res[2].winner);
    assert.equal(res[1].winner, res[3].winner);
    assert.notEqual(res[0].winner, res[1].winner);
  });

  await test('poker: the biggest stack wins', async () => {
    const { g } = playOut('poker', 3, { limit: '10' }, 3);
    const res = g.results();
    const top = Math.max(...res.map((r) => r.score));
    res.forEach((r) => assert.equal(r.winner, r.score === top));
  });

  await test('the mind: the team wins or loses together', async () => {
    const { g } = playOut('themind', 2, {}, 9);
    const res = g.results();
    assert.ok(res.every((r) => r.winner === res[0].winner));
  });

  console.log('match record');
  await test('buildMatchRecord keeps seats, caps names, flags real bots and leavers', async () => {
    const members = [
      { id: 'a', name: 'Alice', bot: false },
      { id: 'bot_1', name: 'Merlin', bot: true },
      { id: 'c', name: 'C'.repeat(50), bot: true }, // left early: a bot finished the seat
    ];
    const g = { results: () => [{ score: 10, winner: true }, { score: 5.4, winner: false }, { score: 1, winner: false }] };
    const rec = buildMatchRecord(room('wizard', members, { leftEarly: new Set(['c']) }), g);
    assert.deepEqual(rec.participants.map((p) => p.isBot), [false, true, false]);
    assert.deepEqual(rec.participants.map((p) => p.leftEarly), [false, false, true]);
    assert.deepEqual(rec.participants.map((p) => p.isWinner), [true, false, false]);
    assert.equal(rec.participants[1].score, 5);
    assert.equal(rec.participants[2].name.length, 32);
    assert.ok(rec.startedAt instanceof Date);
  });

  await test('no results() hook or a wrong length: nothing is recorded instead of wrong data', async () => {
    const members = [{ id: 'a', name: 'A', bot: false }, { id: 'b', name: 'B', bot: false }];
    assert.equal(buildMatchRecord(room('x', members), {}), null);
    assert.equal(buildMatchRecord(room('x', members), { results: () => [{ score: 1, winner: true }] }), null);
  });

  await test('recording the same game twice stores it once; leavers and bots do not count in stats', async () => {
    const members = [{ id: 'u1', name: 'A', bot: false }, { id: 'u2', name: 'B', bot: true }, { id: 'bot_x', name: 'Bot', bot: true }];
    const g = { results: () => [{ score: 3, winner: false }, { score: 9, winner: true }, { score: 1, winner: false }] };
    const rec = buildMatchRecord(room('wizard', members, { matchKey: '22222222-2222-4222-8222-222222222222', leftEarly: new Set(['u2']) }), g);
    const first = await dbMatches.recordMatch(rec);
    const second = await dbMatches.recordMatch(rec);
    assert.ok(first.matchId);
    assert.equal(second.duplicate, true);
    assert.deepEqual(await dbMatches.getPlayerStats('u1'), { played: 1, wins: 0, losses: 1 });
    assert.deepEqual(await dbMatches.getPlayerStats('u2'), { played: 0, wins: 0, losses: 0 }, 'a player who left is not credited');
  });

  console.log(`\n${passed} result tests passed`);
})();
