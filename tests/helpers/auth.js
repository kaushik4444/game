'use strict';
/** A tiny cookie-keeping HTTP client that behaves like a browser against /api/auth (cookies in, CSRF header out). */
class Browser {
  constructor(port) { this.port = port; this.cookies = new Map(); this.lastSetCookie = []; }

  absorb(res) {
    this.lastSetCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const line of this.lastSetCookie) {
      const [pair] = line.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i); const value = pair.slice(i + 1);
      if (/Max-Age=0/i.test(line) || !value) this.cookies.delete(name); else this.cookies.set(name, value);
    }
  }
  get cookieHeader() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }

  async request(method, path, body, { csrf = true, headers = {} } = {}) {
    const h = { ...headers };
    if (this.cookies.size) h.cookie = this.cookieHeader;
    if (method === 'POST') h['content-type'] = 'application/json';
    if (csrf && this.cookies.has('ct_csrf') && h['x-csrf-token'] === undefined) h['x-csrf-token'] = this.cookies.get('ct_csrf');
    const res = await fetch(`http://127.0.0.1:${this.port}${path}`, { method, headers: h, body: method === 'POST' ? JSON.stringify(body || {}) : undefined });
    this.absorb(res);
    const json = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok && json.ok !== false, json, headers: res.headers, setCookie: this.lastSetCookie };
  }
  get(path, opts) { return this.request('GET', path, null, opts); }
  post(path, body, opts) { return this.request('POST', path, body, opts); }
  /** Like post, but throws with the server's message when the call fails. */
  async must(path, body, opts) {
    const r = await this.post(path, body, opts);
    if (!r.ok) throw new Error(`${path}: ${r.json.error || 'HTTP ' + r.status}`);
    return r;
  }
  async csrf() { return (await this.get('/api/auth/csrf')).json.csrfToken; }
}

/**
 * Registers, verifies and logs in. Returns { browser, token, player }. `token` is the session token that only NODE_ENV=test
 * responses contain: it is for test clients that are not browsers. In memory mode (no PostgreSQL) the email flow does not
 * exist, so an anonymous player is created instead; ONLY that specific "requires PostgreSQL" answer triggers the fallback.
 */
async function registerAndVerify(port, { email, username, password = 'TestPass123!', displayName = 'Player', avatar = '🧙' }) {
  const browser = new Browser(port);
  await browser.csrf();
  const handle = ((username || String(displayName || 'player').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 18) || 'player') + Math.floor(Math.random() * 100000)).slice(0, 24);
  const reg = await browser.post('/api/auth/register', { email, username: handle, password, displayName, avatar });
  if (reg.status === 503 && /requires PostgreSQL/i.test(reg.json.error || '')) {
    const dbPlayers = require('../../db/players');
    const created = await dbPlayers.createAnonymousPlayer({ displayName, avatar });
    return { browser, token: created.rawToken, player: created.player };
  }
  if (!reg.ok) throw new Error(`register failed: ${reg.json.error || reg.status}`);
  await browser.must('/api/auth/verify-email', { token: reg.json.debug.verifyToken });
  const login = await browser.must('/api/auth/login', { email, password });
  return { browser, token: login.json.token, player: login.json.player };
}

module.exports = { Browser, registerAndVerify };
