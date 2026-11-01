'use strict';
/**
 * Account-level data behind the profile page: own profile, display name, match history, public profile,
 * recent tables and account deletion. Accounts exist only with PostgreSQL (the in-memory mode has no registered
 * players), so these functions throw/return empty without a database where noted.
 */
const db = require('./pool');
const dbAuth = require('./auth');
const { isUuid, getPlayerProfile } = require('./matches');

const { AuthError } = dbAuth;
const RECENT_LIMIT = 6;
const HISTORY_PAGE_SIZE = 10;
const { DELETED_NAME } = require('./matches');

/** The same rules the lobby uses for a name: printable, no angle brackets, 2-20 characters. */
function cleanDisplayName(input) {
  const name = String(input ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();
  if (name.length < 2) throw new AuthError('Display name must be at least 2 characters.', 400);
  if (name.length > 20) throw new AuthError('Display name can be at most 20 characters.', 400);
  return name;
}

const need = () => { if (!db.hasDatabase()) throw new AuthError('Accounts need the database to be configured.', 503); };
const iso = (d) => (d ? new Date(d).toISOString() : null);

/** Everything the signed-in person may see about themself (includes their own email; never any hash). */
async function getOwnProfile(playerId) {
  need();
  const r = await db.query(
    `SELECT p.id, p.username, p.display_name, p.avatar, p.created_at, i.email, i.email_verified_at
     FROM players p LEFT JOIN auth_identities i ON i.player_id = p.id AND i.provider = 'email'
     WHERE p.id = $1 LIMIT 1`, [playerId]);
  const row = r.rows[0];
  if (!row) throw new AuthError('Account not found.', 404);
  return { id: row.id, username: row.username, displayName: row.display_name, avatar: row.avatar, joinedAt: iso(row.created_at), email: row.email || null, emailVerified: Boolean(row.email_verified_at) };
}

async function updateDisplayName(playerId, rawName) {
  need();
  const name = cleanDisplayName(rawName);
  const r = await db.query('UPDATE players SET display_name = $2 WHERE id = $1 RETURNING display_name', [playerId, name]);
  if (!r.rows.length) throw new AuthError('Account not found.', 404);
  return { displayName: r.rows[0].display_name };
}

/**
 * Finished games of one registered player, newest first, paginated.
 * Only real recorded games count: a row needs a match_key (older rows have unknown winners) and the player must be a
 * human seat. A seat the player left early is listed as "left" but never counted as a win or a loss. A player appears
 * at most once per match, so a duplicate participant row cannot repeat a game.
 */
async function getHistory(playerId, { page = 1, pageSize = HISTORY_PAGE_SIZE } = {}) {
  need();
  if (!isUuid(playerId)) return { page: 1, pageSize, total: 0, pages: 0, items: [] };
  const size = Math.min(50, Math.max(1, Math.floor(Number(pageSize)) || HISTORY_PAGE_SIZE));
  const total = (await db.query(
    `SELECT COUNT(DISTINCT mp.match_id)::int AS n FROM match_participants mp JOIN matches m ON m.id = mp.match_id
     WHERE mp.player_id = $1 AND mp.is_bot = FALSE AND m.match_key IS NOT NULL`, [playerId])).rows[0].n;
  const pages = Math.ceil(total / size);
  const pg = Math.min(Math.max(1, Math.floor(Number(page)) || 1), Math.max(1, pages));
  const r = await db.query(
    `SELECT * FROM (
       SELECT DISTINCT ON (m.id) m.id, m.game_id, m.finished_at, m.seats, mp.score, mp.is_winner, mp.left_early,
         (SELECT COUNT(*)::int FROM match_participants x WHERE x.match_id = m.id AND x.is_bot = FALSE) AS humans
       FROM match_participants mp JOIN matches m ON m.id = mp.match_id
       WHERE mp.player_id = $1 AND mp.is_bot = FALSE AND m.match_key IS NOT NULL
       ORDER BY m.id, mp.seat
     ) h ORDER BY finished_at DESC, id LIMIT $2 OFFSET $3`, [playerId, size, (pg - 1) * size]);
  return {
    page: pg, pageSize: size, total, pages,
    items: r.rows.map((x) => ({
      gameId: x.game_id, finishedAt: iso(x.finished_at), seats: x.seats, humans: x.humans, score: x.score,
      result: x.left_early ? 'left' : x.is_winner ? 'won' : 'lost', // 'left' is not counted in the statistics
    })),
  };
}

/** What anybody may see: no id, no email, no sessions, no per-match detail. */
async function getPublicProfile(username) {
  need();
  const u = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9_]{3,24}$/.test(u)) return null;
  const r = await db.query('SELECT id, username, display_name, avatar, created_at FROM players WHERE username = $1 AND is_anonymous = FALSE LIMIT 1', [u]);
  const row = r.rows[0];
  if (!row) return null;
  const s = await getPlayerProfile(row.id, { memberSince: row.created_at });
  return { username: row.username, displayName: row.display_name, avatar: row.avatar, joinedAt: iso(row.created_at), played: s.played, wins: s.wins, winRate: s.winRate };
}

// ---------------------------------------------------------------------------------------------- recent tables
const memoryRecent = new Map(); // playerId -> [{ code, gameId, at }] (in-memory mode and tests)

async function rememberTable(playerId, { code, gameId }) {
  if (!playerId || !code || !gameId) return;
  if (!db.hasDatabase() || !isUuid(playerId)) {
    const list = (memoryRecent.get(playerId) || []).filter((x) => x.code !== code);
    memoryRecent.set(playerId, [{ code, gameId, at: new Date() }, ...list].slice(0, RECENT_LIMIT));
    return;
  }
  await db.withTransaction(async (c) => {
    await c.query(
      `INSERT INTO player_recent_tables (player_id, room_code, game_id, last_seen_at) VALUES ($1, $2, $3, NOW())
       ON CONFLICT (player_id, room_code) DO UPDATE SET last_seen_at = NOW(), game_id = EXCLUDED.game_id`, [playerId, code, gameId]);
    await c.query(
      `DELETE FROM player_recent_tables WHERE player_id = $1 AND room_code NOT IN
         (SELECT room_code FROM player_recent_tables WHERE player_id = $1 ORDER BY last_seen_at DESC LIMIT ${RECENT_LIMIT})`, [playerId]);
  });
}

async function listRecentTables(playerId) {
  if (!db.hasDatabase() || !isUuid(playerId)) return (memoryRecent.get(playerId) || []).map((x) => ({ code: x.code, gameId: x.gameId, at: iso(x.at) }));
  const r = await db.query('SELECT room_code, game_id, last_seen_at FROM player_recent_tables WHERE player_id = $1 ORDER BY last_seen_at DESC LIMIT $2', [playerId, RECENT_LIMIT]);
  return r.rows.map((x) => ({ code: x.room_code, gameId: x.game_id, at: iso(x.last_seen_at) }));
}

async function forgetRecentTables(playerId, codes) {
  if (!codes.length) return;
  if (!db.hasDatabase() || !isUuid(playerId)) {
    memoryRecent.set(playerId, (memoryRecent.get(playerId) || []).filter((x) => !codes.includes(x.code)));
    return;
  }
  await db.query('DELETE FROM player_recent_tables WHERE player_id = $1 AND room_code = ANY($2::text[])', [playerId, codes]);
}

async function clearRecentTables(playerId) {
  memoryRecent.delete(playerId);
  if (db.hasDatabase() && isUuid(playerId)) await db.query('DELETE FROM player_recent_tables WHERE player_id = $1', [playerId]);
}

// ---------------------------------------------------------------------------------------------- deletion
/**
 * Permanently delete an account after the password was confirmed. In one transaction:
 *  - the player's seats in finished games stay (so other players' histories and results stay correct) but lose the
 *    name and the link to the account: player_name becomes "Deleted player", player_id becomes NULL;
 *  - the player row is deleted, which removes by foreign key: login identity (email, password hash), every session,
 *    verification / reset tokens, recent tables. The username becomes free again.
 * Wrong password: nothing changes. Returns { matchesKept }.
 */
async function deleteAccount(playerId, password) {
  need();
  if (typeof password !== 'string' || !password) throw new AuthError('Enter your password to delete your account.', 400);
  const r = await db.query("SELECT password_hash FROM auth_identities WHERE player_id = $1 AND provider = 'email' LIMIT 1", [playerId]);
  if (!r.rows.length) throw new AuthError('This account has no password to confirm with.', 400);
  // Argon2 outside the transaction: no connection is held while it runs
  if (!(await dbAuth.verifyPassword(r.rows[0].password_hash, password))) throw new AuthError('That password is not correct.', 403);
  return db.withTransaction(async (c) => {
    const locked = await c.query('SELECT id FROM players WHERE id = $1 FOR UPDATE', [playerId]);
    if (!locked.rows.length) throw new AuthError('Account not found.', 404);
    const anon = await c.query('UPDATE match_participants SET player_name = $2, player_id = NULL WHERE player_id = $1', [playerId, DELETED_NAME]);
    const del = await c.query('DELETE FROM players WHERE id = $1', [playerId]);
    if (del.rowCount !== 1) throw new Error('account row was not deleted');
    return { matchesKept: anon.rowCount };
  });
}

module.exports = { DELETED_NAME, RECENT_LIMIT, HISTORY_PAGE_SIZE, cleanDisplayName, getOwnProfile, updateDisplayName, getHistory, getPublicProfile, rememberTable, listRecentTables, forgetRecentTables, clearRecentTables, deleteAccount };
