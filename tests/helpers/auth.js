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

async function registerAndVerify(port, { email, password = 'TestPass123!', displayName = 'Player', avatar = '🧙' }) {
  const reg = await post(port, '/api/auth/register', { email, password, displayName, avatar });
  const verifyToken = reg && reg.debug && reg.debug.verifyToken;
  if (!verifyToken) throw new Error('Missing debug verify token in test mode');
  await post(port, '/api/auth/verify-email', { token: verifyToken });
  const login = await post(port, '/api/auth/login', { email, password });
  return { token: login.token, player: login.player };
}

module.exports = { post, registerAndVerify };
