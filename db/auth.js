'use strict';
const crypto = require('crypto');
const db = require('./pool');
const dbPlayers = require('./players');
const argon2 = require('@node-rs/argon2');

const TOKEN_BYTES = 32;
const SESSION_TTL_DAYS = Number(process.env.AUTH_SESSION_TTL_DAYS || 30);
const EMAIL_VERIFY_TTL_MIN = Number(process.env.AUTH_VERIFY_TTL_MIN || 60 * 24);
const PASSWORD_RESET_TTL_MIN = Number(process.env.AUTH_RESET_TTL_MIN || 30);
const PROVIDER_EMAIL = 'email';

// Used when an email does not exist: we still run Argon2 verify to keep timing close.
const DUMMY_HASH = '$argon2id$v=19$m=19456,t=2,p=1$0GgPfIM9MqfotBF5KfEh/g$iKR5A2M4Km8CSdX6Fc09pcaBzicf93q7FCwHRzpAHKo';

const isEmail = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim()) && s.trim().length <= 320;
const normEmail = (s) => String(s || '').trim().toLowerCase();
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 32) || 'Player';
const cleanAvatar = (s) => String(s || '').slice(0, 16) || '🧙';
const hashToken = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex');
const newRawToken = () => crypto.randomBytes(TOKEN_BYTES).toString('hex');
const expiresAt = (mins) => new Date(Date.now() + mins * 60 * 1000);

function makeSessionResult(player, rawToken) {
  return {
    token: rawToken,
    player: {
      id: player.id,
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

async function createSession(client, playerId) {
  const raw = newRawToken();
  const tokenHash = hashToken(raw);
  const ttlDays = Number.isFinite(SESSION_TTL_DAYS) && SESSION_TTL_DAYS > 0 ? SESSION_TTL_DAYS : 30;
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

async function registerEmail({ email, password, displayName, avatar }) {
  if (!db.hasDatabase()) throw new Error('Email authentication requires PostgreSQL (set DATABASE_URL).');
  if (!isEmail(email)) throw new Error('Please enter a valid email address.');
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) throw new Error('Password must be 8-200 characters.');

  const e = normEmail(email);
  const pwHash = await hashPassword(password);

  return db.withTransaction(async (client) => {
    const exists = await client.query('SELECT 1 FROM auth_identities WHERE provider = $1 AND provider_user_id = $2 LIMIT 1', [PROVIDER_EMAIL, e]);
    if (exists.rows.length) throw new Error('An account already exists for this email.');

    const p = await client.query(
      `INSERT INTO players (display_name, avatar, is_anonymous)
       VALUES ($1, $2, FALSE)
       RETURNING id, display_name, avatar, created_at`,
      [cleanName(displayName), cleanAvatar(avatar)]
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
      ttlMinutes: Number.isFinite(EMAIL_VERIFY_TTL_MIN) && EMAIL_VERIFY_TTL_MIN > 0 ? EMAIL_VERIFY_TTL_MIN : 1440,
    });

    const sessionToken = await createSession(client, player.id);
    return { ...makeSessionResult(player, sessionToken), verifyToken, email: e };
  });
}

async function loginEmail({ email, password }) {
  if (!db.hasDatabase()) throw new Error('Email authentication requires PostgreSQL (set DATABASE_URL).');
  if (!isEmail(email) || typeof password !== 'string') throw new Error('Invalid email or password.');

  const e = normEmail(email);

  return db.withTransaction(async (client) => {
    const r = await client.query(
      `SELECT p.id, p.display_name, p.avatar, p.created_at,
              i.password_hash, i.email, i.email_verified_at
       FROM auth_identities i
       JOIN players p ON p.id = i.player_id
       WHERE i.provider = $1 AND i.provider_user_id = $2
       LIMIT 1`,
      [PROVIDER_EMAIL, e]
    );

    if (!r.rows.length) {
      await verifyPassword(DUMMY_HASH, password);
      throw new Error('Invalid email or password.');
    }

    const row = r.rows[0];
    const ok = await verifyPassword(row.password_hash, password);
    if (!ok) throw new Error('Invalid email or password.');

    const sessionToken = await createSession(client, row.id);
    return makeSessionResult(row, sessionToken);
  });
}

async function resendVerification({ email }) {
  if (!db.hasDatabase()) throw new Error('Email authentication requires PostgreSQL (set DATABASE_URL).');
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
      ttlMinutes: Number.isFinite(EMAIL_VERIFY_TTL_MIN) && EMAIL_VERIFY_TTL_MIN > 0 ? EMAIL_VERIFY_TTL_MIN : 1440,
    });
    return { ok: true, verifyToken, email: e };
  });
}

async function verifyEmailToken(rawToken) {
  if (!db.hasDatabase()) throw new Error('Email authentication requires PostgreSQL (set DATABASE_URL).');
  if (!rawToken || typeof rawToken !== 'string') throw new Error('Invalid verification token.');
  const tokenHash = hashToken(rawToken);

  return db.withTransaction(async (client) => {
    const tok = await client.query(
      `SELECT id, player_id, email, expires_at, used_at
       FROM auth_email_tokens
       WHERE token_hash = $1 AND purpose = 'verify_email'
       LIMIT 1`,
      [tokenHash]
    );
    if (!tok.rows.length) throw new Error('Invalid verification token.');
    const t = tok.rows[0];
    if (t.used_at) throw new Error('This verification link has already been used.');
    if (new Date(t.expires_at).getTime() < Date.now()) throw new Error('This verification link has expired.');

    await client.query('UPDATE auth_email_tokens SET used_at = NOW() WHERE id = $1', [t.id]);
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
  if (!db.hasDatabase()) throw new Error('Email authentication requires PostgreSQL (set DATABASE_URL).');
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
      ttlMinutes: Number.isFinite(PASSWORD_RESET_TTL_MIN) && PASSWORD_RESET_TTL_MIN > 0 ? PASSWORD_RESET_TTL_MIN : 30,
    });
    return { ok: true, resetToken, email: e };
  });
}

async function resetPassword({ token, newPassword }) {
  if (!db.hasDatabase()) throw new Error('Email authentication requires PostgreSQL (set DATABASE_URL).');
  if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 200) throw new Error('Password must be 8-200 characters.');
  if (!token || typeof token !== 'string') throw new Error('Invalid reset token.');

  const tokenHash = hashToken(token);
  const pwHash = await hashPassword(newPassword);

  return db.withTransaction(async (client) => {
    const tok = await client.query(
      `SELECT id, player_id, email, expires_at, used_at
       FROM auth_email_tokens
       WHERE token_hash = $1 AND purpose = 'password_reset'
       LIMIT 1`,
      [tokenHash]
    );
    if (!tok.rows.length) throw new Error('Invalid reset token.');
    const t = tok.rows[0];
    if (t.used_at) throw new Error('This reset link has already been used.');
    if (new Date(t.expires_at).getTime() < Date.now()) throw new Error('This reset link has expired.');

    await client.query('UPDATE auth_email_tokens SET used_at = NOW() WHERE id = $1', [t.id]);
    await client.query(
      `UPDATE auth_identities
       SET password_hash = $1
       WHERE player_id = $2 AND provider = $3 AND provider_user_id = $4`,
      [pwHash, t.player_id, PROVIDER_EMAIL, t.email]
    );
    await client.query('UPDATE auth_sessions SET revoked_at = NOW() WHERE player_id = $1 AND revoked_at IS NULL', [t.player_id]);
    return { ok: true };
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

module.exports = {
  registerEmail,
  loginEmail,
  resendVerification,
  verifyEmailToken,
  requestPasswordReset,
  resetPassword,
  revokeSession,
  sessionInfo,
};
