'use strict';
/**
 * Shared helpers for the browser UI tests (Playwright/Chromium, no server, no database): serves public/, answers /api/ from a
 * table of mock responses, and replaces the WebSocket with a scripted one so the real client code runs against messages we
 * choose (including real engine views). Tests skip, exit 0, when Playwright is not installed.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg' };

function loadPlaywright() {
  try { return require('playwright'); } catch { console.log('SKIPPED: playwright is not installed'); process.exit(0); }
}

/** api: { 'GET /api/me/profile': (req) => json | { status, body }, ... }. Unknown /api/ calls get {ok:true}. */
function serve(api = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const rel = decodeURIComponent(u.pathname);
    if (rel.startsWith('/api/')) {
      const handler = api[`${req.method} ${rel}`] || api[`${req.method} ${rel}${u.search}`];
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        calls.push({ method: req.method, path: rel + u.search, body });
        let out = handler ? handler({ url: u, body }) : { ok: true };
        let status = 200;
        if (out && out.__status) { status = out.__status; out = out.body; }
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
      });
      return;
    }
    const file = path.normalize(path.join(PUBLIC, rel.endsWith('/') ? rel + 'index.html' : rel));
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (e, d) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' }); res.end(d); });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, calls, url: `http://127.0.0.1:${server.address().port}` })));
}

/**
 * A page whose WebSocket is scripted. messages: sent after the client's `hello` (10 ms apart). Returns the page; the
 * client's own outgoing messages are collected in page.__sent via window.__sent. Use page.evaluate to push more messages
 * later: window.__push({ t: 'latency', ms: 42 }).
 */
async function scriptedPage(browser, { viewport = { width: 390, height: 844 }, messages = [], hasTouch = viewport.width < 800 } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, hasTouch });
  const page = await ctx.newPage();
  await page.addInitScript((msgs) => {
    window.__sent = [];
    let sock = null;
    window.__push = (m) => sock && sock.onmessage && sock.onmessage({ data: JSON.stringify(m) });
    window.WebSocket = class {
      constructor() { sock = this; this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen && this.onopen({}); }, 0); }
      send(raw) { try { window.__sent.push(JSON.parse(raw)); } catch { /* ignore */ } if (JSON.parse(raw).t === 'hello') msgs.forEach((x, i) => setTimeout(() => window.__push(x), 10 * (i + 1))); }
      close() { this.readyState = 3; }
    };
  }, messages);
  return { page, ctx };
}

const welcome = (extra = {}) => ({ t: 'welcome', id: 'me', name: 'Aarav', avatar: '🧙', avatars: ['🧙', '🦊', '🐉'], emotes: ['👍'], games: [], tables: [], rejoin: [], ...extra });
const sessionOk = (extra = {}) => ({ ok: true, authenticated: true, player: { id: 'me', display_name: 'Aarav', username: 'aarav', avatar: '🧙', email: 'a@b.c' }, emailVerified: true, csrfToken: 'x', ...extra });

module.exports = { serve, scriptedPage, loadPlaywright, welcome, sessionOk, PUBLIC };
