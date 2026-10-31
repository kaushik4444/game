'use strict';

/**
 * Turn a finished room into the record we store. Pure: no I/O, so it is unit-tested.
 * Returns null when the game cannot say who won (so we store nothing rather than wrong results).
 *
 * room.members is in seat order (the game was created from it). A member who left mid-game is flagged `bot`
 * (a bot finished their seat) and listed in room.leftEarly; they stay in the record but are not counted in stats.
 */
function buildMatchRecord(room, game) {
  const results = typeof game.results === 'function' ? game.results() : null;
  if (!Array.isArray(results) || results.length !== room.members.length) return null;
  const left = room.leftEarly || new Set();
  return {
    matchKey: room.matchKey || null,
    roomCode: room.code,
    gameId: room.gameId,
    seats: room.seats,
    options: room.options || {},
    startedAt: room.startedAt ? new Date(room.startedAt) : null,
    participants: room.members.map((m, seat) => {
      const r = results[seat] || {};
      const leftEarly = Boolean(m.bot && left.has(m.id));
      return {
        playerId: m.id,
        name: String(m.name || 'Player').slice(0, 32),
        seat,
        score: Number.isFinite(r.score) ? Math.round(r.score) : 0,
        isWinner: Boolean(r.winner),
        isBot: Boolean(m.bot) && !leftEarly,
        leftEarly,
      };
    }),
  };
}

module.exports = { buildMatchRecord };
