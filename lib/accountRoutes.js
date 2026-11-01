'use strict';
/**
 * Signed-in account endpoints (/api/me/...) and the public profile (/api/players/:username).
 * Built on the helpers of lib/authRoutes.js: the same cookie session, CSRF check and rate limiter.
 *
 *  - Who you are always comes from the session cookie, never from a player id in the request.
 *  - /api/players/:username returns only username, display name, avatar, join date and win totals.
 */
const dbAuth = require('../db/auth');
const dbAccount = require('../db/account');
const dbMatches = require('../db/matches');

const { AuthError } = dbAuth;
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

function createAccountRoutes({ env, debugTokens, ctx, onProfileChanged = () => {}, onAccountDeleted = () => {}, tableStatus = () => null }) {
  const { limit, requestIp, readSessionToken, sendJson, readJsonBody, addCookie, clearedSessionCookie } = ctx;
  const rate = (prod, test, key) => Number(env[key] || (debugTokens ? test : prod));
  const RL = {
    api: { scope: 'me:api:ip', limit: rate(240, 5000, 'RL_ME_IP_LIMIT'), windowMs: 10 * MIN },
    name: { scope: 'me:name:player', limit: rate(20, 500, 'RL_ME_NAME_LIMIT'), windowMs: HOUR },
    delete: { scope: 'me:delete:player', limit: rate(5, 100, 'RL_ME_DELETE_LIMIT'), windowMs: HOUR },
    publicIp: { scope: 'players:public:ip', limit: rate(120, 5000, 'RL_PUBLIC_PROFILE_IP_LIMIT'), windowMs: 10 * MIN },
  };

  /** The signed-in player, from the cookie. Anonymous legacy sessions and sessions without an account are refused. */
  async function requireUser(req) {
    await limit([{ ...RL.api, key: requestIp(req) }]);
    const token = readSessionToken(req);
    const info = token ? await dbAuth.sessionInfo(token) : null;
    if (!info || !info.authenticated || !info.player) throw new AuthError('Please log in.', 401);
    return { id: info.player.id, token };
  }
  const query = (req) => new URL(req.url, 'http://x').searchParams;

  const routes = {
    'GET /api/me/profile': async (req, res) => {
      const u = await requireUser(req);
      const [profile, stats] = await Promise.all([dbAccount.getOwnProfile(u.id), dbMatches.getPlayerProfile(u.id)]);
      sendJson(res, 200, { ok: true, profile, stats });
    },

    'POST /api/me/display-name': async (req, res) => {
      const u = await requireUser(req);
      await limit([{ ...RL.name, key: u.id }]);
      const body = await readJsonBody(req);
      const out = await dbAccount.updateDisplayName(u.id, body.displayName);
      onProfileChanged({ playerId: u.id, displayName: out.displayName });
      sendJson(res, 200, { ok: true, displayName: out.displayName });
    },

    'GET /api/me/history': async (req, res) => {
      const u = await requireUser(req);
      const q = query(req);
      sendJson(res, 200, { ok: true, ...(await dbAccount.getHistory(u.id, { page: q.get('page') })) });
    },

    'GET /api/me/recent': async (req, res) => {
      const u = await requireUser(req);
      // only tables that still exist on this server are returned; the stale rows are deleted, so the list never fills with dead codes
      const all = await dbAccount.listRecentTables(u.id);
      const live = all.filter((t) => tableStatus(t.code));
      if (live.length !== all.length) await dbAccount.forgetRecentTables(u.id, all.filter((t) => !tableStatus(t.code)).map((t) => t.code));
      sendJson(res, 200, { ok: true, tables: live.map((t) => ({ ...t, status: tableStatus(t.code) })) });
    },

    'POST /api/me/recent/clear': async (req, res) => {
      const u = await requireUser(req);
      await dbAccount.clearRecentTables(u.id);
      sendJson(res, 200, { ok: true });
    },

    'POST /api/me/delete-account': async (req, res) => {
      const u = await requireUser(req);
      await limit([{ ...RL.delete, key: u.id }]);
      const body = await readJsonBody(req);
      const out = await dbAccount.deleteAccount(u.id, body.password);
      onAccountDeleted({ playerId: u.id }); // closes open sockets and forgets the player on this server
      addCookie(res, clearedSessionCookie());
      sendJson(res, 200, { ok: true, matchesKept: out.matchesKept, message: 'Your account has been deleted.' });
    },

    'GET /api/players/:username': async (req, res) => {
      await limit([{ ...RL.publicIp, key: requestIp(req) }]);
      const profile = await dbAccount.getPublicProfile(req.routeParam);
      if (!profile) throw new AuthError('No such player.', 404);
      sendJson(res, 200, { ok: true, profile });
    },
  };
  return routes;
}

module.exports = { createAccountRoutes };
