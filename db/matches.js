'use strict';
const db = require('./pool');
const { computeProfile } = require('./stats');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

/** Per-game stats descriptions (labels, which "best" number means something). Loaded lazily: games/ never requires db/. */
const gameStats = (gameId) => {
  try {
    const def = require('../games').get(gameId);
    return (def && def.stats) || null;
  } catch {
    return null;
  }
};

/**
 * In-memory fallback match archive used when DATABASE_URL is not configured.
 */
class MemoryMatchStore {
  constructor() {
    this.matches = [];
  }

  async recordMatch(match) {
    if (match.matchKey && this.matches.some((m) => m.matchKey === match.matchKey)) return { matchId: null, duplicate: true };
    this.matches.push({ ...match, recordedAt: new Date() });
    return { matchId: match.matchKey || String(this.matches.length) };
  }

  async getPlayerStats(playerId) {
    let played = 0;
    let wins = 0;
    for (const m of this.matches) {
      const part = m.participants.find((p) => p.playerId === playerId);
      if (part && !part.leftEarly && !part.isBot) {
        played++;
        if (part.isWinner) wins++;
      }
    }
    return { played, wins, losses: played - wins };
  }

  async getPlayerRows(playerId) {
    const rows = [];
    for (const m of this.matches) {
      const part = m.participants.find((p) => p.playerId === playerId);
      if (part && !part.leftEarly && !part.isBot) rows.push({ gameId: m.gameId, finishedAt: m.recordedAt, isWinner: part.isWinner, score: part.score, options: m.options || {}, seats: m.seats });
    }
    return rows.sort((a, b) => b.finishedAt - a.finishedAt);
  }
}

const memoryStore = new MemoryMatchStore();

/**
 * Persist a completed match and participant results, all-or-nothing.
 *
 * Resolves { matchId } when stored, or { matchId: null, duplicate: true } when this game (matchKey) was already stored.
 * REJECTS when the database write fails: callers must never believe a failed write succeeded. The error carries the
 * driver's `code` (SQLSTATE or network code) so callers can tell transient failures from permanent ones.
 */
async function recordMatch({ matchKey, roomCode, gameId, seats, options, startedAt, participants }) {
  if (!db.hasDatabase()) {
    return memoryStore.recordMatch({ matchKey, roomCode, gameId, seats, options, startedAt, participants });
  }

  return db.withTransaction(async (client) => {
    const matchRes = await client.query(
      `INSERT INTO matches (match_key, room_code, game_id, seats, options, started_at, finished_at)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, NOW()), NOW())
       ON CONFLICT (match_key) WHERE match_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [matchKey || null, roomCode, gameId, seats, JSON.stringify(options || {}), startedAt ? new Date(startedAt).toISOString() : null]
    );

    if (!matchRes.rows.length) return { matchId: null, duplicate: true }; // this game was already recorded
    const matchId = matchRes.rows[0].id;

    for (const p of participants) {
      await client.query(
        // The player is looked up, not trusted: an id with no account row (a wiped database, a deleted player) must not
        // make the foreign key reject the whole match. Such a participant is stored without an account.
        `INSERT INTO match_participants (match_id, player_id, player_name, seat, score, is_winner, is_bot, left_early)
         VALUES ($1, (SELECT id FROM players WHERE id = $2::uuid), $3, $4, $5, $6, $7, $8)`,
        [
          matchId,
          isUuid(p.playerId) ? p.playerId : null, // bots and synthetic ids have no account
          String(p.name || 'Player').slice(0, 32),
          p.seat ?? 0,
          p.score ?? 0,
          Boolean(p.isWinner),
          Boolean(p.isBot),
          Boolean(p.leftEarly),
        ]
      );
    }

    return { matchId };
  });
}

/**
 * Retrieve lifetime statistics for a player across games. Throws if the database fails (zeros would be misleading).
 */
async function getPlayerStats(playerId) {
  if (!db.hasDatabase()) {
    return memoryStore.getPlayerStats(playerId);
  }
  if (!isUuid(playerId)) return { played: 0, wins: 0, losses: 0 }; // not an account id: no rows, and no invalid-uuid error

  const res = await db.query(
    `SELECT
       COUNT(*)::int AS played,
       COUNT(*) FILTER (WHERE mp.is_winner = TRUE)::int AS wins,
       COUNT(*) FILTER (WHERE mp.is_winner = FALSE)::int AS losses
     FROM match_participants mp
     JOIN matches m ON m.id = mp.match_id
     WHERE mp.player_id = $1 AND mp.left_early = FALSE AND mp.is_bot = FALSE AND m.match_key IS NOT NULL`, // match_key IS NULL: written before results were reported, winners are unknown
    [playerId]
  );
  const row = res.rows[0];
  return { played: row ? row.played : 0, wins: row ? row.wins : 0, losses: row ? row.losses : 0 };
}

/**
 * Profile statistics for one player: games played, wins, losses, win rate, favourite game, per-game record,
 * streaks and recent results. Throws if the database fails (a zero would be misleading).
 */
async function getPlayerProfile(playerId, { memberSince = null } = {}) {
  let rows;
  if (!db.hasDatabase()) {
    rows = await memoryStore.getPlayerRows(playerId);
  } else if (!isUuid(playerId)) {
    rows = [];
  } else {
    const res = await db.query(
      `SELECT m.game_id, m.finished_at, m.options, m.seats, mp.is_winner, mp.score
       FROM match_participants mp
       JOIN matches m ON m.id = mp.match_id
       WHERE mp.player_id = $1 AND mp.left_early = FALSE AND mp.is_bot = FALSE AND m.match_key IS NOT NULL
       ORDER BY m.finished_at DESC
       LIMIT 5000`,
      [playerId]
    );
    rows = res.rows.map((r) => ({ gameId: r.game_id, finishedAt: r.finished_at, isWinner: r.is_winner, score: r.score, options: r.options || {}, seats: r.seats }));
  }
  return computeProfile(rows, { memberSince, metrics: gameStats });
}

module.exports = {
  isUuid,
  recordMatch,
  getPlayerProfile,
  getPlayerStats,
};
