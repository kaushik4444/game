'use strict';

const pct = (wins, played) => (played ? Math.round((wins / played) * 1000) / 10 : null); // one decimal, e.g. 45.8

/**
 * Build a player's profile statistics from their finished matches. Pure (no I/O), shared by the in-memory and Postgres stores.
 *
 * rows: one per match the player really played (no bots, no early leavers), NEWEST FIRST:
 *   { gameId, finishedAt (Date|string), isWinner, score }
 */
function computeProfile(rows, { memberSince = null, recentCount = 10 } = {}) {
  const played = rows.length;
  const wins = rows.filter((r) => r.isWinner).length;

  const byGame = new Map();
  for (const r of rows) {
    const g = byGame.get(r.gameId) || { gameId: r.gameId, played: 0, wins: 0, best: null };
    g.played++;
    if (r.isWinner) g.wins++;
    if (Number.isFinite(r.score) && (g.best === null || r.score > g.best)) g.best = r.score;
    byGame.set(r.gameId, g);
  }
  const perGame = [...byGame.values()]
    .map((g) => ({ ...g, losses: g.played - g.wins, winRate: pct(g.wins, g.played) }))
    .sort((a, b) => b.played - a.played || b.wins - a.wins || a.gameId.localeCompare(b.gameId));

  // streaks of consecutive wins; rows are newest first
  let current = 0;
  for (const r of rows) {
    if (!r.isWinner) break;
    current++;
  }
  let best = 0;
  let run = 0;
  for (const r of rows) {
    run = r.isWinner ? run + 1 : 0;
    if (run > best) best = run;
  }

  const iso = (d) => (d ? new Date(d).toISOString() : null);
  return {
    played,
    wins,
    losses: played - wins,
    winRate: pct(wins, played),
    favouriteGame: perGame.length ? perGame[0].gameId : null, // most played; ties go to more wins
    perGame,
    streak: { current, best },
    recent: rows.slice(0, recentCount).map((r) => ({ gameId: r.gameId, finishedAt: iso(r.finishedAt), won: Boolean(r.isWinner), score: Number.isFinite(r.score) ? r.score : null })),
    lastPlayed: rows.length ? iso(rows[0].finishedAt) : null,
    memberSince: iso(memberSince),
  };
}

module.exports = { computeProfile };
