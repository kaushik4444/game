'use strict';
const dbAuth = require('../db/auth');
const dbFriends = require('../db/friends');
const { AuthError } = dbAuth;
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

function createFriendRoutes({ env, debugTokens, ctx }) {
  const { limit, requestIp, readSessionToken, sendJson, readJsonBody, onEvent = () => {}, validateRoomInvite = async () => false } = ctx;
  const rate = (prod, test, key) => Number(env[key] || (debugTokens ? test : prod));
  const RL = {
    api: { scope: 'friends:api:ip', limit: rate(240, 5000, 'RL_FRIENDS_API_IP_LIMIT'), windowMs: 10 * MIN },
    userApi: { scope: 'friends:api:player', limit: rate(240, 5000, 'RL_FRIENDS_API_PLAYER_LIMIT'), windowMs: 10 * MIN },
    search: { scope: 'friends:search:player', limit: rate(30, 500, 'RL_FRIENDS_SEARCH_LIMIT'), windowMs: HOUR },
    create: { scope: 'friends:create:player', limit: rate(20, 300, 'RL_FRIENDS_CREATE_LIMIT'), windowMs: HOUR },
    invite: { scope: 'friends:invite:player', limit: rate(20, 300, 'RL_INVITATION_CREATE_LIMIT'), windowMs: HOUR },
  };
  async function requireUser(req) {
    await limit([{ ...RL.api, key: requestIp(req) }]);
    const token = readSessionToken(req);
    const info = token ? await dbAuth.sessionInfo(token) : null;
    if (!info || !info.authenticated || !info.player || info.player.is_anonymous) throw new AuthError('Please log in.', 401);
    await limit([{ ...RL.userApi, key: info.player.id }]);
    return { id: info.player.id };
  }
  async function body(req) {
    const value = await readJsonBody(req);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AuthError('Invalid request.');
    return value;
  }
  async function perPlayer(rule, id) { await limit([{ ...rule, key: id }]); }
  const routes = {
    'GET /api/me/friends/search': async (req, res) => {
      const user = await requireUser(req);
      await perPlayer(RL.search, user.id);
      const query = new URL(req.url, 'http://x').searchParams.get('username');
      sendJson(res, 200, { ok: true, players: await dbFriends.searchPlayers(user.id, query) });
    },
    'GET /api/me/friends': async (req, res) => {
      const user = await requireUser(req);
      sendJson(res, 200, { ok: true, friends: await dbFriends.listFriends(user.id, ctx.presence || new Map()) });
    },
    'GET /api/me/friend-requests': async (req, res) => {
      const user = await requireUser(req);
      const direction = new URL(req.url, 'http://x').searchParams.get('direction') || 'incoming';
      if (!['incoming', 'outgoing'].includes(direction)) throw new AuthError('Invalid request.');
      sendJson(res, 200, { ok: true, requests: await dbFriends.listRequests(user.id, direction) });
    },
    'POST /api/me/friend-requests': async (req, res) => {
      const user = await requireUser(req);
      await perPlayer(RL.create, user.id);
      const data = await body(req);
      if (Object.keys(data).some((k) => k !== 'username') || typeof data.username !== 'string') throw new AuthError('Invalid request.');
      const request = await dbFriends.sendRequest(user.id, data.username);
      if (request.status === 'pending') onEvent({ type: 'friend-request', playerId: request.playerId, fromId: user.id });
      else if (request.status === 'accepted') onEvent({ type: 'friend-accepted', playerId: request.playerId }); // they had asked first: this completes it
      sendJson(res, 201, { ok: true, request });
    },
    'POST /api/me/friend-requests/accept': async (req, res) => {
      const user = await requireUser(req); const data = await body(req);
      if (Object.keys(data).some((k) => k !== 'requestId')) throw new AuthError('Invalid request.');
      const request = await dbFriends.transitionRequest(user.id, data.requestId, 'accept');
      onEvent({ type: 'friend-accepted', playerId: request.playerId });
      sendJson(res, 200, { ok: true, request });
    },
    'POST /api/me/friend-requests/decline': async (req, res) => {
      const user = await requireUser(req); const data = await body(req);
      if (Object.keys(data).some((k) => k !== 'requestId')) throw new AuthError('Invalid request.');
      sendJson(res, 200, { ok: true, request: await dbFriends.transitionRequest(user.id, data.requestId, 'decline') });
    },
    'POST /api/me/friend-requests/cancel': async (req, res) => {
      const user = await requireUser(req); const data = await body(req);
      if (Object.keys(data).some((k) => k !== 'requestId')) throw new AuthError('Invalid request.');
      sendJson(res, 200, { ok: true, request: await dbFriends.transitionRequest(user.id, data.requestId, 'cancel') });
    },
    'POST /api/me/friends/remove': async (req, res) => {
      const user = await requireUser(req); const data = await body(req);
      if (Object.keys(data).some((k) => k !== 'friendId')) throw new AuthError('Invalid request.');
      await dbFriends.removeFriend(user.id, data.friendId);
      onEvent({ type: 'friend-removed', playerId: user.id, friendId: data.friendId }); // the table loses the person who may no longer be there
      sendJson(res, 200, { ok: true });
    },
    'GET /api/me/table-invitations': async (req, res) => {
      const user = await requireUser(req);
      const direction = new URL(req.url, 'http://x').searchParams.get('direction') || 'incoming';
      if (!['incoming', 'outgoing'].includes(direction)) throw new AuthError('Invalid request.');
      sendJson(res, 200, { ok: true, invitations: await dbFriends.listInvitations(user.id, direction) });
    },
    'POST /api/me/table-invitations': async (req, res) => {
      const user = await requireUser(req);
      await perPlayer(RL.invite, user.id);
      const data = await body(req);
      if (Object.keys(data).some((k) => !['username', 'gameId', 'roomCode', 'expiresAt'].includes(k)) || !['username', 'gameId', 'roomCode', 'expiresAt'].every((k) => Object.hasOwn(data, k))) throw new AuthError('Invalid request.');
      const invitation = await dbFriends.createInvitation(user.id, data.username, data.gameId, data.roomCode, data.expiresAt, validateRoomInvite);
      onEvent({ type: 'table-invitation', playerId: invitation.playerId, invitationId: invitation.id });
      sendJson(res, 201, { ok: true, invitation });
    },
    'POST /api/me/table-invitations/accept': async (req, res) => {
      const user = await requireUser(req); const data = await body(req);
      if (Object.keys(data).some((k) => k !== 'invitationId')) throw new AuthError('Invalid request.');
      sendJson(res, 200, { ok: true, invitation: await dbFriends.transitionInvitation(user.id, data.invitationId, 'accept') });
    },
    'POST /api/me/table-invitations/decline': async (req, res) => {
      const user = await requireUser(req); const data = await body(req);
      if (Object.keys(data).some((k) => k !== 'invitationId')) throw new AuthError('Invalid request.');
      sendJson(res, 200, { ok: true, invitation: await dbFriends.transitionInvitation(user.id, data.invitationId, 'decline') });
    },
    'POST /api/me/table-invitations/revoke': async (req, res) => {
      const user = await requireUser(req); const data = await body(req);
      if (Object.keys(data).some((k) => k !== 'invitationId')) throw new AuthError('Invalid request.');
      sendJson(res, 200, { ok: true, invitation: await dbFriends.transitionInvitation(user.id, data.invitationId, 'revoke') });
    },
  };
  return routes;
}

module.exports = { createFriendRoutes };
