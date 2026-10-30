'use strict';
const db = require('./pool');

/**
 * In-memory fallback match archive used when DATABASE_URL is not configured.
 */
class MemoryMatchStore {
  constructor() {
    this.matches = [];
  }

  async recordMatch(match) {
    this.matches.push({ ...match, recordedAt: new Date() });
    return match;
  }

  async getPlayerStats(playerId) {
    let played = 0;
    let wins = 0;
    for (const m of this.matches) {
      const part = m.participants.find((p) => p.playerId === playerId);
      if (part) {
        played++;
        if (part.isWinner) wins++;
      }
    }
    return { played, wins, losses: played - wins };
  }
}

const memoryStore = new MemoryMatchStore();

/**
 * Persist a completed match and participant results.
 * Called automatically when a game reaches finished state.
 */
async function recordMatch({ roomCode, gameId, seats, options, participants }) {
  if (!db.hasDatabase()) {
    return memoryStore.recordMatch({ roomCode, gameId, seats, options, participants });
  }

  try {
    return await db.withTransaction(async (client) => {
      const matchRes = await client.query(
        `INSERT INTO matches (room_code, game_id, seats, options, finished_at)
         VALUES ($1, $2, $3, $4, NOW())
         RETURNING id`,
        [roomCode, gameId, seats, JSON.stringify(options || {})]
      );

      const matchId = matchRes.rows[0].id;

      for (const p of participants) {
        // Only set player_id if it's a valid UUID string (not bot or synthetic id)
        const isUuid = typeof p.playerId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.playerId);
        await client.query(
          `INSERT INTO match_participants (match_id, player_id, player_name, seat, score, is_winner, is_bot)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            matchId,
            isUuid ? p.playerId : null,
            p.name || 'Player',
            p.seat ?? 0,
            p.score ?? 0,
            Boolean(p.isWinner),
            Boolean(p.isBot),
          ]
        );
      }

      return { matchId };
    });
  } catch (err) {
    console.error('[db:matches] Error recording match:', err.message);
    return null;
  }
}

/**
 * Retrieve lifetime statistics for a player across games.
 */
async function getPlayerStats(playerId) {
  if (!db.hasDatabase()) {
    return memoryStore.getPlayerStats(playerId);
  }

  try {
    const res = await db.query(
      `SELECT
         COUNT(*)::int AS played,
         COUNT(*) FILTER (WHERE is_winner = TRUE)::int AS wins,
         COUNT(*) FILTER (WHERE is_winner = FALSE)::int AS losses
       FROM match_participants
       WHERE player_id = $1`,
      [playerId]
    );

    const row = res.rows[0];
    return {
      played: row ? row.played : 0,
      wins: row ? row.wins : 0,
      losses: row ? row.losses : 0,
    };
  } catch (err) {
    console.error('[db:matches] Error fetching player stats:', err.message);
    return { played: 0, wins: 0, losses: 0 };
  }
}

module.exports = {
  recordMatch,
  getPlayerStats,
};
