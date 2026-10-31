'use strict';
require('./helpers/env'); // first: NODE_ENV=test, no .env loading, no DATABASE_URL (memory-mode test)
const assert = require('assert');
const dbPlayers = require('../db/players');
const dbMatches = require('../db/matches');

async function testPlayers() {
  console.log('db players');
  const created = await dbPlayers.createAnonymousPlayer({ displayName: 'Alice', avatar: '🦊' });
  assert.ok(created.player.id, 'player has an id');
  assert.equal(created.player.display_name, 'Alice');
  assert.equal(created.player.avatar, '🦊');
  assert.ok(created.rawToken, 'raw bearer token returned');

  // Verify token authentication
  const auth = await dbPlayers.authenticateToken(created.rawToken);
  assert.ok(auth, 'authenticates with bearer token');
  assert.equal(auth.id, created.player.id);
  assert.equal(auth.display_name, 'Alice');

  // Verify bad token fails
  const bad = await dbPlayers.authenticateToken('bad-token-1234');
  assert.equal(bad, null, 'rejects invalid token');

  // Verify profile update
  const updated = await dbPlayers.updateProfile(created.player.id, { displayName: 'Alice In Wonderland', avatar: '🦄' });
  assert.equal(updated.display_name, 'Alice In Wonderland');
  assert.equal(updated.avatar, '🦄');

  const reauth = await dbPlayers.authenticateToken(created.rawToken);
  assert.equal(reauth.display_name, 'Alice In Wonderland');
  assert.equal(reauth.avatar, '🦄');

  console.log('  ok  anonymous player creation, token hashing & authentication');
}

async function testMatches() {
  console.log('db matches');
  const p1 = await dbPlayers.createAnonymousPlayer({ displayName: 'Winner Player' });
  const p2 = await dbPlayers.createAnonymousPlayer({ displayName: 'Second Player' });

  const recorded = await dbMatches.recordMatch({
    roomCode: 'TEST01',
    gameId: 'wizard',
    seats: 3,
    options: { variant: 'standard' },
    participants: [
      { playerId: p1.player.id, name: 'Winner Player', seat: 0, score: 120, isWinner: true, isBot: false },
      { playerId: p2.player.id, name: 'Second Player', seat: 1, score: 70, isWinner: false, isBot: false },
      { playerId: null, name: 'Merlin', seat: 2, score: 40, isWinner: false, isBot: true },
    ],
  });

  assert.ok(recorded, 'match recorded successfully');

  const stats1 = await dbMatches.getPlayerStats(p1.player.id);
  assert.equal(stats1.played, 1);
  assert.equal(stats1.wins, 1);
  assert.equal(stats1.losses, 0);

  const stats2 = await dbMatches.getPlayerStats(p2.player.id);
  assert.equal(stats2.played, 1);
  assert.equal(stats2.wins, 0);
  assert.equal(stats2.losses, 1);

  console.log('  ok  match recording and lifetime stats computation');
}

async function run() {
  await testPlayers();
  await testMatches();
  console.log('\nAll database layer unit tests passed.\n');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
