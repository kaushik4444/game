'use strict';
const crypto = require('crypto');
const db = require('./pool');

/**
 * SHA-256 hash a raw bearer token before database persistence or lookup.
 */
function hashToken(rawToken) {
  return crypto.createHash('sha256').update(String(rawToken)).digest('hex');
}

/**
 * Generate a cryptographically secure random bearer token.
 */
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * In-memory fallback repository used when DATABASE_URL is not configured.
 */
class MemoryPlayerStore {
  constructor() {
    this.players = new Map(); // id -> player record
    this.sessions = new Map(); // tokenHash -> { playerId, revokedAt }
  }

  async getPlayerByToken(rawToken) {
    const hash = hashToken(rawToken);
    const session = this.sessions.get(hash);
    if (!session || session.revokedAt) return null;
    const player = this.players.get(session.playerId);
    if (player) player.last_seen_at = new Date();
    return player ? { ...player } : null;
  }

  async createAnonymousPlayer({ displayName, avatar }) {
    const id = 'p_' + crypto.randomUUID();
    const rawToken = generateToken();
    const hash = hashToken(rawToken);

    const player = {
      id,
      username: null,
      display_name: displayName || 'Guest',
      avatar: avatar || '🧙',
      is_anonymous: true,
      created_at: new Date(),
      last_seen_at: new Date(),
    };

    this.players.set(id, player);
    this.sessions.set(hash, { playerId: id, createdAt: new Date(), revokedAt: null });

    return { player: { ...player }, rawToken };
  }

  async updateProfile(playerId, { displayName, avatar }) {
    const player = this.players.get(playerId);
    if (!player) return null;
    if (displayName) player.display_name = displayName;
    if (avatar) player.avatar = avatar;
    player.last_seen_at = new Date();
    return { ...player };
  }

  async touch(playerId) {
    const player = this.players.get(playerId);
    if (player) player.last_seen_at = new Date();
  }
}

const memoryStore = new MemoryPlayerStore();

/**
 * Authenticate a player from their raw bearer token.
 * Returns the player record or null if invalid or revoked.
 */
async function authenticateToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') return null;

  if (!db.hasDatabase()) {
    return memoryStore.getPlayerByToken(rawToken);
  }

  const tokenHash = hashToken(rawToken);
  const sql = `
    SELECT p.id, p.username, p.display_name, p.avatar, p.is_anonymous, p.created_at, p.last_seen_at
    FROM auth_sessions s
    JOIN players p ON s.player_id = p.id
    WHERE s.token_hash = $1
      AND s.revoked_at IS NULL
      AND (s.expires_at IS NULL OR s.expires_at > NOW())
    LIMIT 1;
  `;

  // A database failure must not look like "unknown token": the caller would then create a brand-new
  // identity for a returning player. So errors are thrown (null means the token is really invalid).
  const res = await db.query(sql, [tokenHash]);
  if (res.rows.length === 0) return null;

  const player = res.rows[0];
  // Asynchronously update last_seen_at without blocking auth flow
  db.query('UPDATE players SET last_seen_at = NOW() WHERE id = $1', [player.id]).catch(() => {});

  return player;
}

/**
 * Create a new anonymous player account with a secure session bearer token.
 */
async function createAnonymousPlayer({ displayName, avatar }) {
  if (!db.hasDatabase()) {
    return memoryStore.createAnonymousPlayer({ displayName, avatar });
  }

  const rawToken = generateToken();
  const tokenHash = hashToken(rawToken);

  return db.withTransaction(async (client) => {
    const playerRes = await client.query(
      `INSERT INTO players (display_name, avatar, is_anonymous)
       VALUES ($1, $2, TRUE)
       RETURNING id, username, display_name, avatar, is_anonymous, created_at, last_seen_at`,
      [String(displayName || 'Guest').slice(0, 32), avatar || '🧙']
    );

    const player = playerRes.rows[0];

    await client.query(
      `INSERT INTO auth_sessions (player_id, token_hash)
       VALUES ($1, $2)`,
      [player.id, tokenHash]
    );

    return { player, rawToken };
  });
}

/**
 * Update a player's display name or avatar.
 */
async function updateProfile(playerId, { displayName, avatar }) {
  if (!db.hasDatabase()) {
    return memoryStore.updateProfile(playerId, { displayName, avatar });
  }

  try {
    const res = await db.query(
      `UPDATE players
       SET display_name = COALESCE($2, display_name),
           avatar = COALESCE($3, avatar),
           last_seen_at = NOW()
       WHERE id = $1
       RETURNING id, username, display_name, avatar, is_anonymous, created_at, last_seen_at`,
      [playerId, displayName || null, avatar || null]
    );
    return res.rows[0] || null;
  } catch (err) {
    console.error('[db:players] Error updating profile:', err.message);
    return null;
  }
}

module.exports = {
  hashToken,
  generateToken,
  authenticateToken,
  createAnonymousPlayer,
  updateProfile,
};
