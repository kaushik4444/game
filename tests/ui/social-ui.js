'use strict';
/** Friends / ping UI in a real browser against scripted API and WebSocket (see harness.js). npm run test:ui:social */
const assert = require('node:assert/strict');
const { serve, scriptedPage, loadPlaywright, welcome, sessionOk } = require('./harness');
const { chromium } = loadPlaywright();

let passed = 0; let failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { failed++; console.error('FAIL  ' + name + '\n' + (e.stack || e)); } }

const profile = { ok: true, profile: { username: 'aarav', displayName: 'Aarav', avatar: '🧙', email: 'a@b.c', emailVerified: true, joinedAt: '2026-01-01T00:00:00Z' }, stats: { played: 0, wins: 0, losses: 0, winRate: null, perGame: [], recent: [], streak: { current: 0, best: 0 } } };
const friends = { ok: true, friends: [
  { id: 'f1', username: 'bob', display_name: 'Bo', avatar: '🦊', online: true, playing: null, ping: 38, last_seen: null },
  { id: 'f2', username: 'cyd', display_name: 'Cy', avatar: '🐉', online: true, playing: 'wizard', ping: 310, last_seen: null },
  { id: 'f3', username: 'dia', display_name: 'Di', avatar: '🧙', online: false, playing: null, ping: null, last_seen: '2026-11-01T10:00:00Z' },
] };

(async () => {
  const { server, url } = await serve({
    'GET /api/auth/session': () => sessionOk(),
    'GET /api/me/profile': () => profile,
    'GET /api/me/history?page=1': () => ({ ok: true, items: [], total: 0, page: 1, pages: 1, pageSize: 10 }),
    'GET /api/me/friends': () => friends,
    'GET /api/players/zedd': () => ({ ok: true, profile: { username: 'zedd', displayName: 'Zed', avatar: '🧙', joinedAt: '2026-02-02T00:00:00Z', played: 0, wins: 0, winRate: null } }),
    'GET /api/players/bob': () => ({ ok: true, profile: { username: 'bob', displayName: 'Bo', avatar: '🦊', joinedAt: '2026-02-02T00:00:00Z', played: 4, wins: 2, winRate: 50 } }),
  });
  const browser = await chromium.launch();
  const msgs = [welcome({ games: [{ id: 'wizard', name: 'Wizard', icon: '🧙', accent: '#8a5cf6', seats: { min: 3, max: 6 }, options: [], rules: [] }] })];

  await test('your own profile shows your live connection quality and updates without a reload', async () => {
    const { page, ctx } = await scriptedPage(browser, { messages: msgs });
    await page.goto(url + '/#profile');
    await page.waitForSelector('.pp-conn');
    assert.match(await page.textContent('.pp-conn'), /– ms/, 'no measurement yet');
    await page.evaluate(() => window.__push({ t: 'latency', ms: 42 }));
    await page.waitForFunction(() => /42 ms · Excellent/.test(document.querySelector('.pp-conn').textContent));
    await page.evaluate(() => window.__push({ t: 'latency', ms: 300 }));
    await page.waitForFunction(() => /300 ms · Poor/.test(document.querySelector('.pp-conn').textContent));
    assert.ok(await page.$('.pp-conn .ping.q-poor'));
    await ctx.close();
  });

  await test('a friend’s profile page shows their status and ping, a stranger’s shows neither', async () => {
    const { page, ctx } = await scriptedPage(browser, { messages: msgs });
    await page.goto(url + '/#u/bob');
    await page.waitForFunction(() => /Friend · 🟢 Online · 38 ms · Excellent/.test((document.querySelector('.pp-conn') || {}).textContent || ''));
    await page.goto(url + '/#u/cy-not-a-friend');
    await ctx.close();
    const second = await scriptedPage(browser, { messages: msgs });
    await second.page.goto(url + '/#u/zedd');
    await second.page.waitForSelector('.pp-head');
    await second.page.waitForTimeout(300);
    assert.equal(await second.page.$('.pp-conn'), null, 'a stranger shows no status or ping');
    await second.ctx.close();
  });

  await test('the friends list shows each friend’s ping next to their status, and nothing for offline friends', async () => {
    const { page, ctx } = await scriptedPage(browser, { messages: msgs });
    await page.goto(url + '/');
    await page.waitForFunction(() => document.body.textContent.includes('Bo'));
    const text = await page.evaluate(() => [...document.querySelectorAll('.social-row')].map((r) => r.textContent.replace(/\s+/g, ' ')));
    const bo = text.find((t) => t.includes('@bob')); const cy = text.find((t) => t.includes('@cyd')); const di = text.find((t) => t.includes('@dia'));
    assert.match(bo, /Online · 38 ms/); assert.match(cy, /Playing Wizard · 310 ms/ ); assert.doesNotMatch(di, / ms/);
    await ctx.close();
  });

  await browser.close(); server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
