'use strict';
const db = require('./pool');
const { AuthError } = require('./auth');

const USERNAME_RE = /^[a-z0-9_]{3,24}$/;
const CODE_RE = /^[A-Z]{6}$/;
const STATUSES = Object.freeze({
  request: ['pending', 'accepted', 'declined', 'cancelled'],
  invitation: ['pending', 'accepted', 'declined', 'revoked', 'expired'],
});
const normUsername = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const canonicalPair = (a, b) => (a < b ? [a, b] : [b, a]);
const requireDb = () => { if (!db.hasDatabase()) throw new AuthError('This feature requires PostgreSQL.', 503); };
const badInput = () => { throw new AuthError('Invalid request.'); };

function validateUsername(value) {
  const username = normUsername(value);
  if (!USERNAME_RE.test(username)) badInput();
  return username;
}
function validateRoomCode(value) {
  if (typeof value !== 'string' || !CODE_RE.test(value)) badInput();
  return value;
}
function validateGameId(value) {
  if (!['wizard', 'twentynine', 'poker', 'themind'].includes(value)) badInput();
  return value;
}
function validateId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) badInput();
  return value;
}
function mapConflict(err) {
  if (err && (err.code === '23505' || err.code === '23514' || err.code === '23503')) throw new AuthError('This relationship could not be changed.', 409);
  throw err;
}

async function searchPlayers(actorId, value) {
  requireDb();
  if (typeof value !== 'string') badInput();
  const username = value.trim().toLowerCase();
  if (!/^[a-z0-9_]{1,24}$/.test(username)) badInput();
  const escaped = username.replace(/[\\%_]/g, (char) => `\\${char}`);
  const r = await db.query(
    `SELECT p.id, p.username, p.display_name, p.avatar
     FROM players p
     WHERE p.is_anonymous = FALSE AND p.username LIKE $1 ESCAPE E'\\\\' AND p.id <> $2
     ORDER BY p.username
     LIMIT 20`, [`${escaped}%`, actorId]
  );
  return r.rows;
}

async function listFriends(playerId, presence = new Map()) {
  requireDb();
  const r = await db.query(
    `SELECT p.id, p.username, p.display_name, p.avatar, p.last_seen_at AS last_seen, f.created_at AS friends_since
     FROM friendships f
     JOIN players p ON p.id = CASE WHEN f.player_a_id = $1 THEN f.player_b_id ELSE f.player_a_id END
     WHERE f.player_a_id = $1 OR f.player_b_id = $1
     ORDER BY LOWER(p.username), p.id`, [playerId]
  );
  return r.rows.map((friend) => {
    const status = presence.get(friend.id);
    return { ...friend, online: Boolean(status && status.online), playing: (status && status.online && status.playing) || null, last_seen: (status && status.lastSeen) || friend.last_seen };
  });
}

async function hasFriendship(playerA, playerB) {
  requireDb();
  if (!playerA || !playerB || playerA === playerB) return false;
  const [a, b] = canonicalPair(playerA, playerB);
  const r = await db.query('SELECT 1 FROM friendships WHERE player_a_id = $1 AND player_b_id = $2', [a, b]);
  return r.rows.length > 0;
}

/** inviterIds: the current host and anyone who hosted this table before (an invitation outlives a host change). */
async function canJoinPrivateRoom(playerId, roomCode, gameId, inviterIds) {
  requireDb();
  const r = await db.query(
    `SELECT 1
     FROM private_table_invitations i
     JOIN friendships f ON f.player_a_id = LEAST(i.inviter_id, i.invitee_id)
                       AND f.player_b_id = GREATEST(i.inviter_id, i.invitee_id)
     WHERE i.invitee_id = $1 AND i.room_code = $2 AND i.game_id = $3
       AND i.inviter_id = ANY($4::uuid[]) AND i.status = 'accepted' AND i.expires_at > NOW()`,
    [playerId, roomCode, gameId, [].concat(inviterIds)]
  );
  return r.rows.length > 0;
}

async function authorizedRoomInvitees(inviterId, roomCode, gameId) {
  requireDb();
  const r = await db.query(
    `SELECT DISTINCT i.invitee_id
     FROM private_table_invitations i
     JOIN friendships f ON f.player_a_id = LEAST(i.inviter_id, i.invitee_id)
                       AND f.player_b_id = GREATEST(i.inviter_id, i.invitee_id)
     WHERE i.inviter_id = $1 AND i.room_code = $2 AND i.game_id = $3
       AND i.status = 'accepted' AND i.expires_at > NOW()`,
    [inviterId, roomCode, gameId]
  );
  return r.rows.map((row) => row.invitee_id);
}

async function expireInvitation(invitationId) {
  requireDb();
  await db.query(
    `UPDATE private_table_invitations SET status = 'expired', updated_at = NOW()
     WHERE id = $1 AND status IN ('pending', 'accepted') AND expires_at <= NOW()`, [invitationId]
  );
}

async function expireClosedRoomInvitations(roomCode) {
  requireDb();
  await db.query(
    `UPDATE private_table_invitations SET status = 'expired', updated_at = NOW()
     WHERE room_code = $1 AND status IN ('pending', 'accepted')`, [roomCode]
  );
}

async function listRequests(playerId, direction) {
  requireDb();
  const incoming = direction === 'incoming';
  const owner = incoming ? 'r.recipient_id' : 'r.requester_id';
  const other = incoming ? 'r.requester_id' : 'r.recipient_id';
  const r = await db.query(
    `SELECT r.id, r.status, r.created_at, r.updated_at,
            p.id AS player_id, p.username, p.display_name, p.avatar
     FROM friend_requests r JOIN players p ON p.id = ${other}
     WHERE ${owner} = $1 AND r.status = 'pending'
     ORDER BY r.created_at DESC LIMIT 100`, [playerId]
  );
  return r.rows;
}

async function sendRequest(actorId, targetUsername) {
  requireDb();
  const username = validateUsername(targetUsername);
  return db.withTransaction(async (client) => {
    const target = await client.query('SELECT id FROM players WHERE LOWER(username) = $1 AND is_anonymous = FALSE', [username]);
    if (!target.rows.length || target.rows[0].id === actorId) throw new AuthError('Player not found.', 404);
    const targetId = target.rows[0].id;
    const pairLock = `${[actorId, targetId].sort().join(':')}`;
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [pairLock]);
    await client.query('SELECT id FROM players WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[actorId, targetId]]);
    const [a, b] = canonicalPair(actorId, targetId);
    const existingFriend = await client.query('SELECT 1 FROM friendships WHERE player_a_id = $1 AND player_b_id = $2', [a, b]);
    if (existingFriend.rows.length) throw new AuthError('You are already friends.', 409);
    const reverse = await client.query("SELECT id FROM friend_requests WHERE requester_id = $1 AND recipient_id = $2 AND status = 'pending' FOR UPDATE", [targetId, actorId]);
    if (reverse.rows.length) {
      await client.query("UPDATE friend_requests SET status = 'accepted', updated_at = NOW() WHERE id = $1", [reverse.rows[0].id]);
      await client.query('INSERT INTO friendships (player_a_id, player_b_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [a, b]);
      return { id: reverse.rows[0].id, status: 'accepted', playerId: targetId };
    }
    try {
      const inserted = await client.query("INSERT INTO friend_requests (requester_id, recipient_id) VALUES ($1, $2) RETURNING id, status, created_at", [actorId, targetId]);
      return { ...inserted.rows[0], playerId: targetId };
    } catch (err) { mapConflict(err); }
  });
}

async function transitionRequest(actorId, requestId, action) {
  requireDb();
  validateId(requestId);
  const ownerColumn = action === 'cancel' ? 'requester_id' : 'recipient_id';
  const status = action === 'cancel' ? 'cancelled' : (action === 'accept' ? 'accepted' : 'declined');
  return db.withTransaction(async (client) => {
    const observed = await client.query(`SELECT requester_id, recipient_id FROM friend_requests WHERE id = $1 AND ${ownerColumn} = $2 AND status = 'pending'`, [requestId, actorId]);
    if (!observed.rows.length) throw new AuthError('Request not found.', 404);
    const pairLock = `${[observed.rows[0].requester_id, observed.rows[0].recipient_id].sort().join(':')}`;
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [pairLock]);
    const req = await client.query(`SELECT id, requester_id, recipient_id FROM friend_requests WHERE id = $1 AND ${ownerColumn} = $2 AND status = 'pending' FOR UPDATE`, [requestId, actorId]);
    if (!req.rows.length) throw new AuthError('Request not found.', 404);
    const row = req.rows[0];
    await client.query('UPDATE friend_requests SET status = $2, updated_at = NOW() WHERE id = $1', [requestId, status]);
    if (action === 'accept') {
      const [a, b] = canonicalPair(row.requester_id, row.recipient_id);
      await client.query('INSERT INTO friendships (player_a_id, player_b_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [a, b]);
    }
    return { id: requestId, status, playerId: row.requester_id };
  });
}

async function removeFriend(actorId, friendId) {
  requireDb();
  validateId(friendId);
  const [a, b] = canonicalPair(actorId, friendId);
  return db.withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${a}:${b}`]);
    const r = await client.query('DELETE FROM friendships WHERE player_a_id = $1 AND player_b_id = $2', [a, b]);
    if (!r.rowCount) throw new AuthError('Friend not found.', 404);
    await client.query("UPDATE private_table_invitations SET status = 'revoked', updated_at = NOW() WHERE status IN ('pending', 'accepted') AND ((inviter_id = $1 AND invitee_id = $2) OR (inviter_id = $2 AND invitee_id = $1))", [actorId, friendId]);
    return true;
  });
}

async function listInvitations(playerId, direction) {
  requireDb();
  await db.query(
    `UPDATE private_table_invitations SET status = 'expired', updated_at = NOW()
     WHERE (inviter_id = $1 OR invitee_id = $1) AND status IN ('pending', 'accepted') AND expires_at <= NOW()`, [playerId]
  );
  const incoming = direction === 'incoming';
  const owner = incoming ? 'i.invitee_id' : 'i.inviter_id';
  const other = incoming ? 'i.inviter_id' : 'i.invitee_id';
  const r = await db.query(
    `SELECT i.id, i.game_id, i.room_code, i.status, i.created_at, i.expires_at, i.updated_at,
            p.id AS player_id, p.username, p.display_name, p.avatar
     FROM private_table_invitations i JOIN players p ON p.id = ${other}
     WHERE ${owner} = $1 AND i.status = 'pending' AND i.expires_at > NOW() AND EXISTS (
       SELECT 1 FROM friendships f WHERE f.player_a_id = LEAST(i.inviter_id, i.invitee_id) AND f.player_b_id = GREATEST(i.inviter_id, i.invitee_id)
     )
     ORDER BY i.created_at DESC LIMIT 100`, [playerId]
  );
  return r.rows;
}

async function createInvitation(actorId, inviteeUsername, game, code, expiresAt, validateRoom) {
  requireDb();
  const username = validateUsername(inviteeUsername);
  const gameId = validateGameId(game);
  const roomCode = validateRoomCode(code);
  if (typeof validateRoom === 'function' && !await validateRoom(actorId, gameId, roomCode)) throw new AuthError('Private table not found.', 404);
  const expires = new Date(expiresAt);
  if (!Number.isFinite(expires.getTime()) || expires <= new Date() || expires > new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)) badInput();
  const target = await db.query('SELECT id FROM players WHERE LOWER(username) = $1 AND is_anonymous = FALSE', [username]);
  if (!target.rows.length || target.rows[0].id === actorId) throw new AuthError('Player not found.', 404);
  const [playerA, playerB] = canonicalPair(actorId, target.rows[0].id);
  return db.withTransaction(async (client) => {
    const friends = await client.query('SELECT 1 FROM friendships WHERE player_a_id = $1 AND player_b_id = $2 FOR SHARE', [playerA, playerB]);
    if (!friends.rows.length) throw new AuthError('Player not found.', 404);
    try {
      const r = await client.query(
        `INSERT INTO private_table_invitations (inviter_id, invitee_id, game_id, room_code, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (inviter_id, invitee_id, room_code) WHERE status = 'pending'
         DO UPDATE SET game_id = EXCLUDED.game_id, expires_at = EXCLUDED.expires_at, updated_at = NOW()
         RETURNING id, game_id, room_code, status, created_at, expires_at`,
        [actorId, target.rows[0].id, gameId, roomCode, expires]
      );
      return { ...r.rows[0], playerId: target.rows[0].id };
    } catch (err) { mapConflict(err); }
  });
}

async function transitionInvitation(actorId, invitationId, action) {
  requireDb();
  validateId(invitationId);
  const owner = action === 'revoke' ? 'inviter_id' : 'invitee_id';
  const status = action === 'revoke' ? 'revoked' : (action === 'accept' ? 'accepted' : 'declined');
  return db.withTransaction(async (client) => {
    const observed = await client.query(
      `SELECT inviter_id, invitee_id FROM private_table_invitations
       WHERE id = $1 AND ${owner} = $2 AND status = 'pending' AND expires_at > NOW()`, [invitationId, actorId]
    );
    if (!observed.rows.length) throw new AuthError('Invitation not found.', 404);
    const [playerA, playerB] = canonicalPair(observed.rows[0].inviter_id, observed.rows[0].invitee_id);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${playerA}:${playerB}`]);
    const invitation = await client.query(
      `SELECT id FROM private_table_invitations
       WHERE id = $1 AND ${owner} = $2 AND status = 'pending' AND expires_at > NOW() FOR UPDATE`, [invitationId, actorId]
    );
    if (!invitation.rows.length) throw new AuthError('Invitation not found.', 404);
    if (action === 'accept') {
      const friendship = await client.query(
        'SELECT 1 FROM friendships WHERE player_a_id = $1 AND player_b_id = $2 FOR UPDATE', [playerA, playerB]
      );
      if (!friendship.rows.length) throw new AuthError('Invitation not found.', 404);
    }
    const updated = await client.query(
      `UPDATE private_table_invitations SET status = $3, updated_at = NOW()
       WHERE id = $1 AND ${owner} = $2 AND status = 'pending' AND expires_at > NOW()
       RETURNING id, status`, [invitationId, actorId, status]
    );
    if (!updated.rows.length) throw new AuthError('Invitation not found.', 404);
    return updated.rows[0];
  });
}

module.exports = {
  USERNAME_RE, CODE_RE, STATUSES, validateUsername, validateRoomCode, validateGameId, validateId,
  searchPlayers, listFriends, hasFriendship, canJoinPrivateRoom, authorizedRoomInvitees,
  expireInvitation, expireClosedRoomInvitations, listRequests, sendRequest, transitionRequest, removeFriend,
  listInvitations, createInvitation, transitionInvitation,
};
