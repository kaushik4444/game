'use strict';

async function post(port, path, body) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok || json.ok === false) {
    throw new Error((json && json.error) || `HTTP ${r.status} ${path}`);
  }
  return json;
}

async function registerAndVerify(port, { email, username, password = 'TestPass123!', displayName = 'Player', avatar = '🧙' }) {
  try {
    const handle = (username || String(displayName || 'player').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 18) || 'player') + String(Math.floor(Math.random() * 100000));
    const reg = await post(port, '/api/auth/register', { email, username: handle.slice(0, 24), password, displayName, avatar });
    const verifyToken = reg && reg.debug && reg.debug.verifyToken;
    if (!verifyToken) throw new Error('Missing debug verify token in test mode');
    await post(port, '/api/auth/verify-email', { token: verifyToken });
    const login = await post(port, '/api/auth/login', { email, password });
    return { token: login.token, player: login.player };
  } catch (err) {
    // In-memory test mode has no email/password auth; create a local anonymous session token.
    if (/requires PostgreSQL|Registration failed/i.test(String(err.message || ''))) {
      const dbPlayers = require('../../db/players');
      const created = await dbPlayers.createAnonymousPlayer({ displayName, avatar });
      return { token: created.rawToken, player: created.player };
    }
    throw err;
  }
}

module.exports = { post, registerAndVerify };
