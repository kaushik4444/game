'use strict';
// A deleted account's name is rewritten inside every game's state, including log lines. No database, no network.
const assert = require('node:assert/strict');
const games = require('../games');
const { scrubText } = require('../games/scrub');

assert.equal(scrubText('Sam plays 3 and Samantha bids', ['Sam'], 'Deleted player'), 'Deleted player plays 3 and Samantha bids', 'whole words only');
assert.equal(scrubText('👁 Sam is watching', ['Sam', 'Sam'], 'X'), '👁 X is watching');

const cases = [['wizard', 3], ['twentynine', 4], ['poker', 3], ['themind', 2]];
for (const [id, n] of cases) {
  const names = ['Secret Sam', 'Ann', 'Bob', 'Cy'].slice(0, n);
  const players = names.map((name, i) => ({ id: 'p' + i, name }));
  const game = games.get(id).create(players, {}, Math.random);
  // let the game run on its own for a while so the log holds lines with every name (bots act for everybody)
  for (let i = 0; i < 400 && !game.isOver(); i++) {
    const waiting = game.awaiting();
    if (!waiting.length) { const a = game.autoAction && game.autoAction(); if (!a) break; game.act(null, a); continue; }
    const a = game.botAction(waiting[0]);
    if (!a) break;
    game.act(waiting[0], a);
  }
  const before = JSON.stringify(game.view('p1'));
  assert.ok(before.includes('Secret Sam'), id + ': the name is in the state before the deletion (test precondition)');
  game.scrub(['Secret Sam'], 'Deleted player');
  for (const viewer of ['p0', 'p1', 'nobody']) {
    const after = JSON.stringify(game.view(viewer));
    assert.ok(!after.includes('Secret Sam'), id + ': the view for ' + viewer + ' still names the player');
  }
  assert.ok(JSON.stringify(game.view('p1')).includes('Deleted player'), id + ': the seat is still there');
  assert.ok(game.view('p1').log.length > 0, id + ': the log is kept');
  if (game.isOver()) assert.ok(!JSON.stringify(game.results()).includes('Secret Sam'), id + ': results');
  console.log('ok  ' + id + ' scrub');
}
console.log('\nscrub tests passed');
