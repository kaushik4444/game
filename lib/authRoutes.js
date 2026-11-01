'use strict';
/**
 * HTTP routes under /api/auth: register, login, logout, email verification, password reset, session info.
 *
 *  - The session lives only in an HttpOnly cookie (ct_session). Scripts never see it, and the WebSocket upgrade carries
 *    the cookie itself, so no endpoint hands the token to JavaScript. (Only NODE_ENV=test returns it, for test clients
 *    that are not browsers.)
 *  - CSRF uses the double-submit pattern with a real cookie: the ct_csrf cookie is set by the server and every POST must
 *    repeat its value in the X-CSRF-Token header. A page on another site can neither read nor set that cookie.
 *  - Every mutating endpoint is rate limited per address and, where an email or token is involved, per email/token.
 *  - Endpoints that could reveal whether an email has an account (resend, forgot password) always answer the same way.
 */
const crypto = require('crypto');
const dbAuth = require('../db/auth');
const { AuthError } = dbAuth;
const { hitRateLimit } = require('../db/rateLimit');
const { createAccountRoutes } = require('./accountRoutes');

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

function createAuthRoutes({ env, production, trustProxy, emailSender, sendJson, readJsonBody, onSignedOut = () => {}, onProfileChanged = () => {}, onAccountDeleted = () => {}, tableStatus = () => null, log = console }) {
  const debugTokens = env.NODE_ENV === 'test';
  const rate = (prod, test, key) => Number(env[key] || (debugTokens ? test : prod));
  const RL = {
    registerIp: { scope: 'auth:register:ip', limit: rate(8, 500, 'RL_REGISTER_IP_LIMIT'), windowMs: 10 * MIN },
    registerEmail: { scope: 'auth:register:email', limit: rate(4, 100, 'RL_REGISTER_EMAIL_LIMIT'), windowMs: HOUR },
    loginIp: { scope: 'auth:login:ip', limit: rate(25, 1000, 'RL_LOGIN_IP_LIMIT'), windowMs: 10 * MIN },
    loginEmail: { scope: 'auth:login:email', limit: rate(8, 200, 'RL_LOGIN_EMAIL_LIMIT'), windowMs: 15 * MIN },
    resendIp: { scope: 'auth:resend:ip', limit: rate(10, 400, 'RL_RESEND_IP_LIMIT'), windowMs: HOUR },
    resendEmail: { scope: 'auth:resend:email', limit: rate(3, 100, 'RL_RESEND_EMAIL_LIMIT'), windowMs: HOUR },
    forgotIp: { scope: 'auth:forgot:ip', limit: rate(10, 400, 'RL_FORGOT_IP_LIMIT'), windowMs: HOUR },
    forgotEmail: { scope: 'auth:forgot:email', limit: rate(5, 100, 'RL_FORGOT_EMAIL_LIMIT'), windowMs: HOUR },
    resetIp: { scope: 'auth:reset:ip', limit: rate(12, 400, 'RL_RESET_IP_LIMIT'), windowMs: HOUR },
    resetToken: { scope: 'auth:reset:token', limit: rate(6, 150, 'RL_RESET_TOKEN_LIMIT'), windowMs: 15 * MIN },
    usernameIp: { scope: 'auth:username:ip', limit: rate(60, 2000, 'RL_USERNAME_IP_LIMIT'), windowMs: 10 * MIN },
  };

  const hashKey = (s) => crypto.createHash('sha256').update(String(s || '')).digest('hex');
  const requestIp = (req) => {
    const xff = trustProxy ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
    return xff || req.socket.remoteAddress || 'unknown';
  };

  // ---------------------------------------------------------------- cookies and CSRF
  const secure = production ? '; Secure' : '';
  const maxAge = () => Math.round(dbAuth.sessionTtlDays() * 24 * 60 * 60);
  const sessionCookie = (token) => `ct_session=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge()}; HttpOnly; SameSite=Lax${secure}`;
  const clearedSessionCookie = () => `ct_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`;
  const csrfCookie = (token) => `ct_csrf=${token}; Path=/; Max-Age=${maxAge()}; SameSite=Lax${secure}`; // readable by the page on purpose

  const readCookie = (req, name) => {
    for (const chunk of String(req.headers.cookie || '').split(';')) {
      const i = chunk.indexOf('=');
      if (i < 0 || chunk.slice(0, i).trim() !== name) continue;
      try { return decodeURIComponent(chunk.slice(i + 1).trim()) || null; } catch { return null; }
    }
    return null;
  };
  const readSessionToken = (req) => readCookie(req, 'ct_session');

  const pendingCookies = new WeakMap(); // res -> Set-Cookie lines (a response may need both cookies)
  const addCookie = (res, line) => {
    const list = pendingCookies.get(res) || [];
    list.push(line);
    pendingCookies.set(res, list);
    res.setHeader('Set-Cookie', list);
  };

  const csrfFor = (req, res) => {
    const existing = readCookie(req, 'ct_csrf');
    if (existing && /^[a-f0-9]{48}$/.test(existing)) return existing;
    const fresh = crypto.randomBytes(24).toString('hex');
    addCookie(res, csrfCookie(fresh));
    return fresh;
  };
  const requireCsrf = (req) => {
    const cookie = readCookie(req, 'ct_csrf') || '';
    const header = String(req.headers['x-csrf-token'] || '');
    const ok = cookie.length > 0 && cookie.length === header.length && crypto.timingSafeEqual(Buffer.from(cookie), Buffer.from(header));
    if (!ok) throw new AuthError('Invalid CSRF token.', 403);
  };

  // ---------------------------------------------------------------- helpers
  async function limit(checks) {
    for (const c of checks) {
      if (!c.key) continue;
      const out = await hitRateLimit({ scope: c.scope, key: c.key, limit: c.limit, windowMs: c.windowMs });
      if (!out.allowed) throw new AuthError('Too many requests. Please wait and try again.', 429, { retryAfter: Math.max(1, Math.ceil(out.resetMs / 1000)) });
    }
  }
  const byIpAndEmail = (req, ipRule, emailRule, email) => [{ ...ipRule, key: requestIp(req) }, { ...emailRule, key: hashKey(dbAuth.normEmail(email)) }];

  // Email is best effort once the database row exists: a provider outage must not strand the account or reveal who has one.
  async function deliver(kind, { email, token }) {
    try {
      if (!debugTokens) await (kind === 'verify' ? emailSender.sendVerification({ email, token }) : emailSender.sendPasswordReset({ email, token }));
      return true;
    } catch (err) {
      log.error(`[auth] ${kind} email could not be delivered: ${err.message}`);
      return false;
    }
  }

  // ---------------------------------------------------------------- routes
  const routes = {
    'GET /api/auth/csrf': async (req, res) => sendJson(res, 200, { ok: true, csrfToken: csrfFor(req, res) }),

    'GET /api/auth/username-available': async (req, res) => {
      await limit([{ ...RL.usernameIp, key: requestIp(req) }]);
      const username = new URL(req.url, 'http://x').searchParams.get('username') || '';
      sendJson(res, 200, { ok: true, ...(await dbAuth.checkUsernameAvailability({ username })) });
    },

    'GET /api/auth/session': async (req, res) => {
      const token = readSessionToken(req);
      const csrfToken = csrfFor(req, res);
      if (!token) {
        return sendJson(res, 200, {
          ok: true,
          authenticated: false,
          emailVerificationRequired: dbAuth.isEmailVerificationRequired(env),
          csrfToken,
        });
      }
      const info = await dbAuth.sessionInfo(token);
      const player = info.player
        ? { ...info.player, email: info.email || null, email_verified: Boolean(info.emailVerified) }
        : null;
      sendJson(res, 200, {
        ok: true,
        authenticated: Boolean(info.authenticated),
        player,
        emailVerified: Boolean(info.emailVerified),
        emailVerificationRequired: dbAuth.isEmailVerificationRequired(env),
        csrfToken,
      });
    },

    'POST /api/auth/register': async (req, res) => {
      const body = await readJsonBody(req);
      await limit(byIpAndEmail(req, RL.registerIp, RL.registerEmail, body.email));
      const out = await dbAuth.registerEmail({ email: body.email, username: body.username, password: body.password, displayName: body.displayName, avatar: body.avatar });
      const emailSent = await deliver('verify', { email: out.email, token: out.verifyToken });
      addCookie(res, sessionCookie(out.token));
      const verificationRequired = dbAuth.isEmailVerificationRequired(env);
      sendJson(res, 201, {
        ok: true,
        requiresVerification: verificationRequired,
        emailVerificationRequired: verificationRequired,
        emailSent,
        token: debugTokens ? out.token : undefined,
        csrfToken: csrfFor(req, res),
        player: out.player,
        ...(debugTokens ? { debug: { verifyToken: out.verifyToken } } : {}),
        message: verificationRequired
          ? (emailSent
              ? 'Account created. Please verify your email before entering the lobby.'
              : 'Account created, but the verification email could not be sent. Use "Resend verification email" in a moment.')
          : (emailSent
              ? 'Account created. You can log in now; email verification is currently optional.'
              : 'Account created. You can log in now, but the verification email could not be sent yet.'),
      });
    },

    'POST /api/auth/login': async (req, res) => {
      const body = await readJsonBody(req);
      await limit(byIpAndEmail(req, RL.loginIp, RL.loginEmail, body.email));
      const out = await dbAuth.loginEmail({ email: body.email, password: body.password });
      onSignedOut({ playerId: out.player.id, token: null, exceptToken: out.token }); // one active session: the older device is signed out
      addCookie(res, sessionCookie(out.token));
      const verificationRequired = dbAuth.isEmailVerificationRequired(env) && !out.player.email_verified;
      sendJson(res, 200, {
        ok: true,
        token: debugTokens ? out.token : undefined,
        csrfToken: csrfFor(req, res),
        player: out.player,
        requiresVerification: verificationRequired,
        emailVerificationRequired: dbAuth.isEmailVerificationRequired(env),
      });
    },

    'POST /api/auth/logout': async (req, res) => {
      const token = readSessionToken(req);
      const s = await dbAuth.readSessionFromCookie(token);
      await dbAuth.revokeSession(token);
      if (s) onSignedOut({ playerId: s.player_id, token });
      addCookie(res, clearedSessionCookie());
      sendJson(res, 200, { ok: true });
    },

    'POST /api/auth/logout-all': async (req, res) => {
      const out = await dbAuth.revokeAllSessionsForCurrent(readSessionToken(req));
      if (out.playerId) onSignedOut({ playerId: out.playerId, token: null });
      addCookie(res, clearedSessionCookie());
      sendJson(res, 200, { ok: true, revoked: out.revoked || 0 });
    },

    'POST /api/auth/resend-verification': async (req, res) => {
      const body = await readJsonBody(req);
      await limit(byIpAndEmail(req, RL.resendIp, RL.resendEmail, body.email));
      const out = await dbAuth.resendVerification({ email: body.email });
      if (out.verifyToken) await deliver('verify', { email: out.email, token: out.verifyToken });
      sendJson(res, 200, { ok: true, ...(debugTokens && out.verifyToken ? { debug: { verifyToken: out.verifyToken } } : {}), message: 'If this account exists, a verification email has been sent.' });
    },

    'POST /api/auth/verify-email': async (req, res) => {
      const body = await readJsonBody(req);
      await dbAuth.verifyEmailToken(body.token);
      sendJson(res, 200, { ok: true, message: 'Email verified. You can now enter the lobby.' });
    },

    'POST /api/auth/forgot-password': async (req, res) => {
      const body = await readJsonBody(req);
      await limit(byIpAndEmail(req, RL.forgotIp, RL.forgotEmail, body.email));
      const out = await dbAuth.requestPasswordReset({ email: body.email });
      if (out.resetToken) await deliver('reset', { email: out.email, token: out.resetToken });
      sendJson(res, 200, { ok: true, ...(debugTokens && out.resetToken ? { debug: { resetToken: out.resetToken } } : {}), message: 'If this account exists, a reset email has been sent.' });
    },

    'POST /api/auth/reset-password': async (req, res) => {
      const body = await readJsonBody(req);
      await limit([{ ...RL.resetIp, key: requestIp(req) }, { ...RL.resetToken, key: hashKey(body.token) }]);
      const out = await dbAuth.resetPassword({ token: body.token, newPassword: body.newPassword });
      if (out.playerId) onSignedOut({ playerId: out.playerId, token: null });
      addCookie(res, clearedSessionCookie());
      sendJson(res, 200, { ok: true, message: 'Password updated. Please log in again.' });
    },
  };

  // Signed-in account endpoints (profile, history, recent tables, deletion) and the public profile share these helpers.
  const accountRoutes = createAccountRoutes({
    env, debugTokens, onProfileChanged, onAccountDeleted, tableStatus,
    ctx: { limit, requestIp, readSessionToken, sendJson, readJsonBody, addCookie, clearedSessionCookie },
  });

  /** Returns true when the request belonged to /api/auth/, /api/me/ or /api/players/ and has been answered. */
  async function handle(req, res, rel) {
    let route = null;
    if (rel.startsWith('/api/auth/')) route = routes[`${req.method} ${rel}`];
    else if (rel.startsWith('/api/me/')) route = accountRoutes[`${req.method} ${rel}`];
    else if (rel.startsWith('/api/players/') && req.method === 'GET') {
      try { req.routeParam = decodeURIComponent(rel.slice('/api/players/'.length)).slice(0, 64); } catch { req.routeParam = ''; }
      route = accountRoutes['GET /api/players/:username'];
    }
    if (!route) return false;
    try {
      if (req.method === 'POST') requireCsrf(req);
      await route(req, res);
    } catch (err) {
      if (res.headersSent) return true;
      if (err instanceof AuthError) {
        if (err.retryAfter) res.setHeader('Retry-After', String(err.retryAfter));
        sendJson(res, err.status, { ok: false, error: err.message });
      } else if (err && err.message === 'payload too large') sendJson(res, 413, { ok: false, error: 'Request too large.' });
      else if (err && err.message === 'invalid json') sendJson(res, 400, { ok: false, error: 'Invalid request.' });
      else {
        log.error(`[auth] ${req.method} ${rel} failed: ${err && err.stack ? err.stack : err}`);
        sendJson(res, 500, { ok: false, error: 'Could not process request.' });
      }
    }
    return true;
  }

  return { handle, readSessionToken };
}

module.exports = { createAuthRoutes };
