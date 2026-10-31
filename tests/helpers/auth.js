'use strict';
const crypto = require('node:crypto');

async function parseJson(r) {
  return r.json().catch(() => ({}));
}

async function getCsrf(port) {
  const r = await fetch(`http://127.0.0.1:${port}/api/auth/csrf`);
  const json = await parseJson(r);
  if (!r.ok || json.ok === false || !json.csrfToken) throw new Error('Could not fetch CSRF token');
  const cookie = r.headers.get('set-cookie') || '';
  return { csrfToken: json.csrfToken, cookie };
}

async function post(port, path, body, opts = {}) {
  const headers = { 'content-type': 'application/json' };
  if (opts.csrfToken) headers['x-csrf-token'] = opts.csrfToken;
  if (opts.cookie) headers.cookie = opts.cookie;
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(Object.assign({}, body || {}, opts.csrfToken ? { csrfToken: opts.csrfToken } : {})),
  });
  const json = await parseJson(r);
  if (!r.ok || json.ok === false) {
    throw new Error((json && json.error) || `HTTP ${r.status} ${path}`);
  }
  return { json, headers: r.headers, cookie: r.headers.get('set-cookie') || opts.cookie || '' };
}

async function registerAndVerify(port, { email, username, password = 'TestPass123!', displayName = 'Player', avatar = '🧙' }) {
  try {
    const handle = (username || String(displayName || 'player').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 18) || 'player') + String(Math.floor(Math.random() * 100000));
    const csrf = await getCsrf(port);
    const reg = await post(port, '/api/auth/register', { email, username: handle.slice(0, 24), password, displayName, avatar }, csrf);
    const verifyToken = reg.json && reg.json.debug && reg.json.debug.verifyToken;
    if (!verifyToken) throw new Error('Missing debug verify token in test mode');
    await post(port, '/api/auth/verify-email', { token: verifyToken }, { csrfToken: csrf.csrfToken, cookie: reg.cookie || csrf.cookie });
    const login = await post(port, '/api/auth/login', { email, password }, { csrfToken: csrf.csrfToken, cookie: reg.cookie || csrf.cookie });
    const ws = await post(port, '/api/auth/ws-token', {}, { csrfToken: csrf.csrfToken, cookie: login.cookie || reg.cookie || csrf.cookie });
    return { token: ws.json.token, player: login.json.player, cookie: login.cookie || reg.cookie || csrf.cookie, csrfToken: csrf.csrfToken };
  } catch (err) {
    // In-memory test mode has no email/password auth; create a local anonymous session token.
    if (/requires PostgreSQL|Registration failed/i.test(String(err.message || ''))) {
      const dbPlayers = require('../../db/players');
      const created = await dbPlayers.createAnonymousPlayer({ displayName, avatar });
      return { token: created.rawToken, player: created.player, cookie: '', csrfToken: crypto.randomBytes(12).toString('hex') };
    }
    throw err;
  }
}

module.exports = { post, registerAndVerify, getCsrf };
