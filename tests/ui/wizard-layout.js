'use strict';
/**
 * Wizard table layout check in a real browser (Playwright/Chromium). Not part of `npm test` (needs a browser);
 * run with `npm run test:ui`. It serves public/ and replaces the WebSocket with a mock that replays REAL engine views,
 * then measures every header control at phone, portrait, landscape and desktop sizes. Fails on any horizontal
 * overflow of the page or of the header, or when a header control is cut off or overlaps another.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('SKIPPED: playwright is not installed'); process.exit(0); }
const games = require('../../games');

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/json' };
const CASES = process.env.UI_GAME ? [[process.env.UI_GAME, Number(process.env.UI_SEATS || 4)]] : [['wizard', 3], ['wizard', 4], ['wizard', 6], ['twentynine', 4], ['poker', 2], ['poker', 6], ['themind', 2], ['themind', 4]];
const mulberry = (a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const SEEDS = process.env.UI_SEED ? [Number(process.env.UI_SEED)] : [1, 2, 3, 4, 5, 6];
const NAMES = ['Aarav the Magnificent', 'Bo', 'Charlotte-Anne', 'Dmitri', 'Eve', 'Frederick'];

function buildMessages(gameId, n, seed) {
  const def = games.get(gameId);
  const players = NAMES.slice(0, n).map((name, i) => ({ id: 'p' + i, name, avatar: '🧙' }));
  const g = def.create(players, Object.fromEntries((def.options || []).filter((o) => o.default !== undefined).map((o) => [o.key, o.default])), mulberry(seed));
  const room = { code: 'ABCDEF', gameId, hostId: 'p0', status: 'playing', options: {}, visibility: 'public', seats: n, min: def.seats.min, max: def.seats.max, seatLabels: null,
    members: players.map((p) => ({ id: p.id, name: p.name, bot: false, avatar: p.avatar, connected: true })), spectators: [], deadline: null, now: Date.now() };
  return [
    { t: 'welcome', id: 'p0', name: players[0].name, avatar: '🧙', avatars: ['🧙'], emotes: ['👍'], games: games.list(), tables: [], rejoin: [] },
    { t: 'state', room, view: g.view('p0') },
  ];
}

function serve() {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (rel === '/api/auth/session') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ ok: true, authenticated: true, player: { display_name: NAMES[0], username: 'aarav', avatar: '🧙', email: 'a@b.c' }, emailVerified: true, csrfToken: 'x' })); }
    if (rel.startsWith('/api/')) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ ok: true, tables: [], games: [], players: [] })); }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (e, d) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' }); res.end(d); });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

const SIZES = [
  { name: 'iPhone SE (320x568)', width: 320, height: 568 }, { name: 'small phone (360x640)', width: 360, height: 640 },
  { name: 'iPhone 14 (390x844)', width: 390, height: 844 }, { name: 'phone landscape (667x375)', width: 667, height: 375 },
  { name: 'tablet portrait (768x1024)', width: 768, height: 1024 }, { name: 'desktop (1280x800)', width: 1280, height: 800 },
];

(async () => {
  const server = await serve();
  const browser = await chromium.launch();
  let failures = 0;
  for (const [GAME, seats] of CASES) {
  for (const seed of SEEDS) {
  const msgs = buildMessages(GAME, seats, seed);
  for (const size of SIZES) {
    const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 2, hasTouch: size.width < 800 });
    const page = await ctx.newPage();
    await page.addInitScript((messages) => {
      window.WebSocket = class {
        constructor() { this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen && this.onopen({}); }, 0); }
        send(raw) { let m; try { m = JSON.parse(raw); } catch { return; } if (m.t === 'hello') messages.forEach((x, i) => setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify(x) }), 10 * (i + 1))); }
        close() { this.readyState = 3; }
      };
    }, msgs);
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForSelector('.wz-top', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(300);
    const report = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const out = { vw, pageScrollW: document.documentElement.scrollWidth, problems: [] };
      const top = document.querySelector('.wz-top');
      if (!top) { out.problems.push('no .wz-top rendered'); return out; }
      const wz = document.querySelector('.wz'); const wzOverflow = getComputedStyle(wz).overflowX; if (wzOverflow === 'hidden') out.problems.push('.wz hides horizontal overflow (overflow-x: hidden) instead of preventing it');
      const tops = top.getBoundingClientRect();
      if (top.scrollWidth > top.clientWidth + 1) out.problems.push(`header content wider than header (${top.scrollWidth} > ${top.clientWidth})`);
      if (wz && wz.scrollWidth > wz.clientWidth + 1) out.problems.push(`.wz scrolls horizontally (${wz.scrollWidth} > ${wz.clientWidth})`);
      const els = [...top.querySelectorAll('button, .wz-round, .wz-trump')].filter((e) => e.offsetParent !== null);
      const rects = els.map((e) => ({ e, r: e.getBoundingClientRect() }));
      for (const { e, r } of rects) {
        const label = (e.getAttribute('aria-label') || e.textContent || e.className).trim().slice(0, 20);
        if (r.left < -0.5 || r.right > vw + 0.5) out.problems.push(`"${label}" is off screen (${Math.round(r.left)}..${Math.round(r.right)} of ${vw})`);
        if (e.matches('button') && (r.width < 28 || r.height < 28)) out.problems.push(`"${label}" is too small to tap (${Math.round(r.width)}x${Math.round(r.height)})`);
      }
      for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i].r; const b = rects[j].r;
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) out.problems.push(`controls overlap: "${(rects[i].e.getAttribute('aria-label') || rects[i].e.textContent).trim().slice(0, 14)}" and "${(rects[j].e.getAttribute('aria-label') || rects[j].e.textContent).trim().slice(0, 14)}"`);
      }
      out.headerHeight = Math.round(tops.height); out.buttons = els.filter((e) => e.matches('button')).length;
      const hand = document.querySelector('.hand, .tm-hand, .pk-hand');
      out.handRight = hand ? Math.round(hand.getBoundingClientRect().right) : null;
      return out;
    });
    if (report.pageScrollW > report.vw + 1) report.problems.push(`page scrolls horizontally (${report.pageScrollW} > ${report.vw})`);
    // elements anywhere inside the table that stick out of the viewport (excluding scroll containers that are meant to scroll)
    const wide = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth; const bad = [];
      for (const e of document.querySelectorAll('.wz *')) {
        if (e.closest('.hand, .tm-hand, .overlay, .chat, .watchers')) continue;
        const r = e.getBoundingClientRect();
        if (r.width && (r.right > vw + 1 || r.left < -1) && getComputedStyle(e).position !== 'fixed') bad.push(`${e.tagName.toLowerCase()}.${String(e.className).split(' ')[0]} ${Math.round(r.left)}..${Math.round(r.right)}`);
        if (bad.length > 5) break;
      }
      return bad;
    });
    wide.forEach((w) => report.problems.push('sticks out of the viewport: ' + w));
    const overlaps = await page.evaluate(() => {
      const out = [];
      const bars = [...document.querySelectorAll('.wz-status, .wz-bids, .wz-top, .t29-strip, .hand, .tm-hand, .pt-corner')].filter((e) => e.offsetParent !== null);
      for (const e of document.querySelectorAll('.pt-seat')) {
        const r = e.getBoundingClientRect(); const name = (e.querySelector('.plate b') || {}).textContent || 'seat';
        for (const bar of bars) {
          const br = bar.getBoundingClientRect();
          const x = r.left < br.right - 1 && br.left < r.right - 1; const y = Math.min(r.bottom, br.bottom) - Math.max(r.top, br.top);
          if (x && y > 2) out.push(`seat "${name.slice(0, 16)}" overlaps .${String(bar.className).split(' ')[0]} by ${Math.round(y)}px`);
        }
      }
      return out;
    });
    overlaps.forEach((o) => report.problems.push(o));
    const ok = report.problems.length === 0;
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${GAME}/${seats} seed ${seed} ${size.name}: header ${report.headerHeight}px high, ${report.buttons} buttons${ok ? '' : '\n        - ' + report.problems.join('\n        - ')}`);
    if (process.env.UI_SHOT) await page.screenshot({ path: path.join(process.env.UI_SHOT, `${GAME}-${size.width}x${size.height}.png`) });
    await ctx.close();
  }
  }
  }
  await browser.close(); server.close();
  if (failures) { console.error(`\n${failures} viewport(s) failed`); process.exit(1); }
  console.log('\nall viewports ok');
})().catch((e) => { console.error(e); process.exit(1); });
