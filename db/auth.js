'use strict';
const crypto = require('crypto');
const db = require('./pool');
const dbPlayers = require('./players');
const argon2 = require('@node-rs/argon2');

/** An error whose message is safe to show to the person using the form. Anything else is a server fault (500). */
class AuthError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    Object.assign(this, extra);
  }
}

const TOKEN_BYTES = 32;
const positive = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback);
const sessionTtlDays = () => positive(process.env.AUTH_SESSION_TTL_DAYS, 30);
const verifyTtlMin = () => positive(process.env.AUTH_VERIFY_TTL_MIN, 60 * 24);
const resetTtlMin = () => positive(process.env.AUTH_RESET_TTL_MIN, 30);
const isEmailVerificationRequired = (env = process.env) => {
  const raw = String(env.REQUIRE_EMAIL_VERIFICATION || '').trim().toLowerCase();
  if (!raw) return true;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return true; // secure default on invalid value
};
const PROVIDER_EMAIL = 'email';
const USERNAME_RE = /^[a-z0-9_]{3,24}$/;

// Used when an email does not exist: we still run Argon2 verify to keep timing close.
const DUMMY_HASH = '$argon2id$v=19$m=19456,t=2,p=1$0GgPfIM9MqfotBF5KfEh/g$iKR5A2M4Km8CSdX6Fc09pcaBzicf93q7FCwHRzpAHKo';

const isEmail = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim()) && s.trim().length <= 320;
const normEmail = (s) => String(s || '').trim().toLowerCase();
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 32) || 'Player';
const cleanAvatar = (s) => String(s || '').slice(0, 16) || '🧙';
const normUsername = (s) => String(s || '').trim().toLowerCase();
const isUsername = (u) => USERNAME_RE.test(u);
const hashToken = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex');
const newRawToken = () => crypto.randomBytes(TOKEN_BYTES).toString('hex');
const expiresAt = (mins) => new Date(Date.now() + mins * 60 * 1000);

function makeSessionResult(player, rawToken) {
  return {
    token: rawToken,
    player: {
      id: player.id,
      username: player.username || null,
      display_name: player.display_name,
      avatar: player.avatar,
      created_at: player.created_at,
      email: player.email || null,
      email_verified: Boolean(player.email_verified_at),
    },
  };
}

async function hashPassword(password) {
  return argon2.hash(String(password)); // default: Argon2id (OWASP baseline)
}

async function verifyPassword(hash, password) {
  try {
    return await argon2.verify(String(hash), String(password));
  } catch {
    return false;
  }
}

async function revokeSession(rawToken) {
  if (!db.hasDatabase() || !rawToken) return false;
  const tokenHash = hashToken(rawToken);
  const res = await db.query('UPDATE auth_sessions SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL', [tokenHash]);
  return res.rowCount > 0;
}

async function revokeAllSessionsForCurrent(rawToken) {
  if (!db.hasDatabase() || !rawToken) return { revoked: 0 };
  const tokenHash = hashToken(rawToken);
  return db.withTransaction(async (client) => {
    const s = await client.query(
      `SELECT player_id
       FROM auth_sessions
       WHERE token_hash = $1
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > NOW())
       LIMIT 1`,
      [tokenHash]
    );
    if (!s.rows.length) return { revoked: 0 };
    const playerId = s.rows[0].player_id;
    const out = await client.query('UPDATE auth_sessions SET revoked_at = NOW() WHERE player_id = $1 AND revoked_at IS NULL', [playerId]);
    return { revoked: out.rowCount, playerId };
  });
}

async function readSessionFromCookie(rawToken) {
  if (!db.hasDatabase() || !rawToken) return null;
  const tokenHash = hashToken(rawToken);
  const r = await db.query(
    `SELECT player_id
     FROM auth_sessions
     WHERE token_hash = $1
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > NOW())
     LIMIT 1`,
    [tokenHash]
  );
  return r.rows[0] || null;
}

async function revokeAllSessionsForPlayer(playerId) {
  if (!db.hasDatabase() || !playerId) return { revoked: 0 };
  const out = await db.query('UPDATE auth_sessions SET revoked_at = NOW() WHERE player_id = $1 AND revoked_at IS NULL', [playerId]);
  return { revoked: out.rowCount };
}

async function createSession(client, playerId) {
  const raw = newRawToken();
  const tokenHash = hashToken(raw);
  const ttlDays = sessionTtlDays();
  await client.query(
    'INSERT INTO auth_sessions (player_id, token_hash, expires_at) VALUES ($1, $2, NOW() + ($3::text || \' days\')::interval)',
    [playerId, tokenHash, String(ttlDays)]
  );
  return raw;
}

async function issueEmailToken(client, { playerId, purpose, email, ttlMinutes }) {
  const raw = newRawToken();
  const tokenHash = hashToken(raw);
  await client.query(
    `INSERT INTO auth_email_tokens (player_id, purpose, email, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [playerId, purpose, normEmail(email), tokenHash, expiresAt(ttlMinutes)]
  );
  return raw;
}

async function registerEmail({ email, username, password, displayName, avatar }) {
  if (!db.hasDatabase()) throw new AuthError('Email authentication requires PostgreSQL (set DATABASE_URL).', 503);
  if (!isEmail(email)) throw new AuthError('Please enter a valid email address.');
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) throw new AuthError('Password must be 8-200 characters.');

  const e = normEmail(email);
  const u = normUsername(username);
  if (!isUsername(u)) throw new AuthError('Username must be 3-24 chars: lowercase letters, numbers, underscore.');

  const pwHash = await hashPassword(password);

  try {
    return await db.withTransaction(async (client) => {
      const existsEmail = await client.query('SELECT 1 FROM auth_identities WHERE provider = $1 AND provider_user_id = $2 LIMIT 1', [PROVIDER_EMAIL, e]);
      if (existsEmail.rows.length) throw new AuthError('An account already exists for this email.');

      const existsUsername = await client.query('SELECT 1 FROM players WHERE LOWER(username) = LOWER($1) LIMIT 1', [u]);
      if (existsUsername.rows.length) throw new AuthError('This username is already taken.');

      const p = await client.query(
        `INSERT INTO players (username, display_name, avatar, is_anonymous)
         VALUES ($1, $2, $3, FALSE)
         RETURNING id, username, display_name, avatar, created_at`,
        [u, cleanName(displayName), cleanAvatar(avatar)]
      );
      const player = p.rows[0];

      await client.query(
        `INSERT INTO auth_identities (player_id, provider, provider_user_id, email, password_hash)
         VALUES ($1, $2, $3, $4, $5)`,
        [player.id, PROVIDER_EMAIL, e, e, pwHash]
      );

      const verifyToken = await issueEmailToken(client, {
        playerId: player.id,
        purpose: 'verify_email',
        email: e,
        ttlMinutes: verifyTtlMin(),
      });

      const sessionToken = await createSession(client, player.id);
      return { ...makeSessionResult(player, sessionToken), verifyToken, email: e, username: u };
    });
  } catch (err) {
    if (err && (err.code === '23505' || /already exists/i.test(err.message || ''))) {
      if ((err.constraint || '').includes('username') || /username/i.test(err.message || '')) {
        throw new AuthError('This username is already taken.');
      }
      throw new AuthError('An account already exists for this email.');
    }
    if (err && err.code === '23514') throw new AuthError('Username must be 3-24 chars: lowercase letters, numbers, underscore.');
    throw err;
  }
}

async function checkUsernameAvailability({ username }) {
  if (!db.hasDatabase()) return { available: false, reason: 'requires_postgres' };
  const u = normUsername(username);
  if (!isUsername(u)) return { available: false, reason: 'invalid' };
  const r = await db.query('SELECT 1 FROM players WHERE LOWER(username) = LOWER($1) LIMIT 1', [u]);
  return { available: r.rows.length === 0, username: u };
}

async function loginEmail({ email, password }) {
  if (!db.hasDatabase()) throw new AuthError('Email authentication requires PostgreSQL (set DATABASE_URL).', 503);
  if (!isEmail(email) || typeof password !== 'string') throw new AuthError('Invalid email or password.', 401);

  // Argon2 takes tens of milliseconds: do it without holding a database connection or transaction open.
  const r = await db.query(
    `SELECT p.id, p.username, p.display_name, p.avatar, p.created_at,
            i.password_hash, i.email, i.email_verified_at
     FROM auth_identities i
     JOIN players p ON p.id = i.player_id
     WHERE i.provider = $1 AND i.provider_user_id = $2
     LIMIT 1`,
    [PROVIDER_EMAIL, normEmail(email)]
  );
  if (!r.rows.length) {
    await verifyPassword(DUMMY_HASH, password); // keep the timing close to a real check
    throw new AuthError('Invalid email or password.', 401);
  }
  const row = r.rows[0];
  if (!(await verifyPassword(row.password_hash, password))) throw new AuthError('Invalid email or password.', 401);

  return makeSessionResult(row, await createSession(db, row.id));
}

async function resendVerification({ email }) {
  if (!db.hasDatabase()) throw new AuthError('Email authentication requires PostgreSQL (set DATABASE_URL).', 503);
  const e = normEmail(email);
  if (!isEmail(e)) return { ok: true }; // do not leak which emails exist

  return db.withTransaction(async (client) => {
    const r = await client.query(
      `SELECT i.player_id, i.email_verified_at
       FROM auth_identities i
       WHERE i.provider = $1 AND i.provider_user_id = $2
       LIMIT 1`,
      [PROVIDER_EMAIL, e]
    );
    if (!r.rows.length || r.rows[0].email_verified_at) return { ok: true };

    const verifyToken = await issueEmailToken(client, {
      playerId: r.rows[0].player_id,
      purpose: 'verify_email',
      email: e,
      ttlMinutes: verifyTtlMin(),
    });
    return { ok: true, verifyToken, email: e };
  });
}

async function verifyEmailToken(rawToken) {
  if (!db.hasDatabase()) throw new AuthError('Email authentication requires PostgreSQL (set DATABASE_URL).', 503);
  if (!rawToken || typeof rawToken !== 'string') throw new AuthError('Invalid verification token.');
  const tokenHash = hashToken(rawToken);

  return db.withTransaction(async (client) => {
    const use = await client.query(
      `UPDATE auth_email_tokens
         SET used_at = NOW()
       WHERE token_hash = $1
         AND purpose = 'verify_email'
         AND used_at IS NULL
         AND expires_at > NOW()
       RETURNING player_id, email`,
      [tokenHash]
    );
    if (!use.rows.length) {
      const reason = await client.query(
        `SELECT used_at, expires_at
         FROM auth_email_tokens
         WHERE token_hash = $1 AND purpose = 'verify_email'
         LIMIT 1`,
        [tokenHash]
      );
      if (!reason.rows.length) throw new AuthError('Invalid verification token.');
      if (reason.rows[0].used_at) throw new AuthError('This verification link has already been used.');
      throw new AuthError('This verification link has expired.');
    }

    const t = use.rows[0];
    await client.query(
      `UPDATE auth_identities
       SET email_verified_at = COALESCE(email_verified_at, NOW())
       WHERE player_id = $1 AND provider = $2 AND provider_user_id = $3`,
      [t.player_id, PROVIDER_EMAIL, t.email]
    );
    return { ok: true };
  });
}

async function requestPasswordReset({ email }) {
  if (!db.hasDatabase()) throw new AuthError('Email authentication requires PostgreSQL (set DATABASE_URL).', 503);
  const e = normEmail(email);
  if (!isEmail(e)) return { ok: true };

  return db.withTransaction(async (client) => {
    const r = await client.query(
      `SELECT i.player_id, i.email_verified_at
       FROM auth_identities i
       WHERE i.provider = $1 AND i.provider_user_id = $2
       LIMIT 1`,
      [PROVIDER_EMAIL, e]
    );
    if (!r.rows.length || !r.rows[0].email_verified_at) return { ok: true }; // only verified accounts reset

    const resetToken = await issueEmailToken(client, {
      playerId: r.rows[0].player_id,
      purpose: 'password_reset',
      email: e,
      ttlMinutes: resetTtlMin(),
    });
    return { ok: true, resetToken, email: e };
  });
}

async function resetPassword({ token, newPassword }) {
  if (!db.hasDatabase()) throw new AuthError('Email authentication requires PostgreSQL (set DATABASE_URL).', 503);
  if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 200) throw new AuthError('Password must be 8-200 characters.');
  if (!token || typeof token !== 'string') throw new AuthError('Invalid reset token.');

  const tokenHash = hashToken(token);
  const pwHash = await hashPassword(newPassword);

  return db.withTransaction(async (client) => {
    const use = await client.query(
      `UPDATE auth_email_tokens
         SET used_at = NOW()
       WHERE token_hash = $1
         AND purpose = 'password_reset'
         AND used_at IS NULL
         AND expires_at > NOW()
       RETURNING player_id, email`,
      [tokenHash]
    );
    if (!use.rows.length) {
      const reason = await client.query(
        `SELECT used_at, expires_at
         FROM auth_email_tokens
         WHERE token_hash = $1 AND purpose = 'password_reset'
         LIMIT 1`,
        [tokenHash]
      );
      if (!reason.rows.length) throw new AuthError('Invalid reset token.');
      if (reason.rows[0].used_at) throw new AuthError('This reset link has already been used.');
      throw new AuthError('This reset link has expired.');
    }

    const t = use.rows[0];
    await client.query(
      `UPDATE auth_identities
       SET password_hash = $1
       WHERE player_id = $2 AND provider = $3 AND provider_user_id = $4`,
      [pwHash, t.player_id, PROVIDER_EMAIL, t.email]
    );
    await client.query('UPDATE auth_sessions SET revoked_at = NOW() WHERE player_id = $1 AND revoked_at IS NULL', [t.player_id]);
    return { ok: true, playerId: t.player_id };
  });
}

async function sessionInfo(rawToken) {
  const player = await dbPlayers.authenticateToken(rawToken);
  if (!player || !db.hasDatabase()) {
    return {
      authenticated: Boolean(player),
      emailVerified: false,
      provider: null,
      email: null,
      player,
    };
  }
  const r = await db.query(
    `SELECT email, email_verified_at, provider
     FROM auth_identities
     WHERE player_id = $1
     ORDER BY created_at ASC
     LIMIT 1`,
    [player.id]
  );
  const i = r.rows[0] || null;
  return {
    authenticated: true,
    emailVerified: Boolean(i && i.email_verified_at),
    provider: i ? i.provider : null,
    email: i ? i.email : null,
    player,
  };
}

/** Delete rows nobody can use any more. Safe to run at any time and from several instances. */
async function purgeExpired() {
  if (!db.hasDatabase()) return { rateLimits: 0, tokens: 0, sessions: 0 };
  const run = async (sql) => (await db.query(sql)).rowCount;
  return {
    rateLimits: await run("DELETE FROM auth_rate_limits WHERE window_start < NOW() - INTERVAL '1 day'"),
    tokens: await run("DELETE FROM auth_email_tokens WHERE expires_at < NOW() - INTERVAL '7 days' OR used_at < NOW() - INTERVAL '7 days'"),
    // rows without expires_at are legacy anonymous sessions: kept
    sessions: await run("DELETE FROM auth_sessions WHERE (expires_at IS NOT NULL AND expires_at < NOW() - INTERVAL '7 days') OR revoked_at < NOW() - INTERVAL '30 days'"),
  };
}

module.exports = {
  AuthError,
  normEmail,
  sessionTtlDays,
  purgeExpired,
  isEmailVerificationRequired,
  registerEmail,
  checkUsernameAvailability,
  loginEmail,
  resendVerification,
  verifyEmailToken,
  requestPasswordReset,
  resetPassword,
  revokeSession,
  revokeAllSessionsForCurrent,
  revokeAllSessionsForPlayer,
  readSessionFromCookie,
  sessionInfo,
};
