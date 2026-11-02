'use strict';
/** Friends / ping UI in a real browser against scripted API and WebSocket (see harness.js). npm run test:ui:social */
const assert = require('node:assert/strict');
const { serve, scriptedPage, loadPlaywright, welcome, sessionOk, tableMessages } = require('./harness');
const { chromium } = loadPlaywright();

let passed = 0; let failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { failed++; console.error('FAIL  ' + name + '\n' + (e.stack || e)); } }

const profile = { ok: true, profile: { username: 'aarav', displayName: 'Aarav', avatar: '🧙', email: 'a@b.c', emailVerified: true, joinedAt: '2026-01-01T00:00:00Z' }, stats: { played: 0, wins: 0, losses: 0, winRate: null, perGame: [], recent: [], streak: { current: 0, best: 0 } } };
const friends = { ok: true, friends: [
  { id: 'f1', username: 'bob', display_name: 'Bo', avatar: '🦊', online: true, playing: null, ping: 38, last_seen: null },
  { id: 'f2', username: 'cyd', display_name: 'Cy', avatar: '🐉', online: true, playing: 'wizard', ping: 310, last_seen: null },
  { id: 'f3', username: 'dia', display_name: 'Di', avatar: '🧙', online: false, playing: null, ping: null, last_seen: '2026-11-01T10:00:00Z' },
] };

let outgoing = []; let friendList = friends.friends; // bob, cyd and dia are friends; ann and the others are not
(async () => {
  const { server, url, calls } = await serve({
    'GET /api/me/friend-requests?direction=outgoing': () => ({ ok: true, requests: outgoing }),
    'POST /api/me/friend-requests': ({ body }) => { const u = JSON.parse(body).username; if (u === 'broke') return { __status: 409, body: { ok: false, error: 'You already sent a request.' } }; outgoing = [{ id: 'r1', username: u, display_name: u }]; return { ok: true, request: { id: 'r1', status: 'pending' } }; },
    'POST /api/me/avatar': ({ body }) => { const a = JSON.parse(body).avatar; if (a === '🐉') return { __status: 429, body: { ok: false, error: 'Too many changes. Try again later.' } }; profile.profile.avatar = a; return { ok: true, avatar: a }; },
    'GET /api/me/friends': () => ({ ok: true, friends: friendList }),
    'GET /api/players/ann': () => ({ ok: true, profile: { username: 'ann', displayName: 'Ann', avatar: '🦊', joinedAt: '2026-02-02T00:00:00Z', played: 12, wins: 5, winRate: 41.7 } }),
    'GET /api/auth/session': () => sessionOk(),
    'GET /api/me/profile': () => profile,
    'GET /api/me/history?page=1': () => ({ ok: true, items: [], total: 0, page: 1, pages: 1, pageSize: 10 }),
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

  await test('changing the profile picture saves it through the API and updates the profile header', async () => {
    const { page, ctx } = await scriptedPage(browser, { messages: msgs });
    await page.goto(url + '/#profile');
    await page.waitForSelector('.pp-head .avatar');
    await page.click('[data-act="editProfile"]');
    await page.waitForSelector('#modal-overlay .av-pick');
    const before = calls.length;
    await page.click('#modal-overlay .av-pick[data-a="🦊"]');
    await page.waitForFunction(() => document.querySelector('.pp-head .avatar').textContent.trim() === '🦊');
    const post = calls.slice(before).find((c) => c.path === '/api/me/avatar');
    assert.ok(post, 'the choice was sent to the API');
    assert.equal(JSON.parse(post.body).avatar, '🦊');
    assert.equal(await page.$eval('#modal-overlay .av-pick.on', (el) => el.dataset.a), '🦊', 'the dialog marks the saved choice');
    await ctx.close();
  });

  await test('a refused picture change goes back to the old picture and says why', async () => {
    const { page, ctx } = await scriptedPage(browser, { messages: msgs });
    await page.goto(url + '/#profile');
    await page.waitForSelector('.pp-head .avatar');
    const was = (await page.textContent('.pp-head .avatar')).trim();
    await page.click('[data-act="editProfile"]');
    await page.click('#modal-overlay .av-pick[data-a="🐉"]');
    await page.waitForFunction(() => /Too many changes/.test(document.body.textContent));
    assert.equal((await page.textContent('.pp-head .avatar')).trim(), was, 'the header still shows the saved picture');
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

  const seats = [
    { name: 'Aarav', username: 'aarav', ping: 20 },
    { name: 'Ann', username: 'ann', ping: 75, id: 'u-ann', avatar: '🦊' },
    { name: 'Bo', username: 'bob', ping: 38, id: 'u-bob' },
    { name: 'Merlin', bot: true, id: 'bot1' },
    { name: 'Gus', username: null, id: 'u-gus', ping: 400 },
  ];
  const tableMsgs = () => tableMessages('wizard', seats);
  const seat = (page, pid) => page.click(`.pseat[data-pid="${pid}"]`);

  await test('tapping a stranger opens a card with their handle, ping and record, and Add friend sends one request', async () => {
    outgoing = [];
    const { page, ctx } = await scriptedPage(browser, { messages: tableMsgs() });
    await page.goto(url + '/');
    await page.waitForSelector('.pseat[data-pid="u-ann"]');
    await seat(page, 'u-ann');
    await page.waitForSelector('.pcard-head');
    const head = await page.textContent('.pcard-head');
    assert.match(head, /Ann/); assert.match(head, /@ann/); assert.match(head, /75 ms · Good/);
    await page.waitForFunction(() => /12\s*Games/.test(document.querySelector('.pcard-stats')?.textContent.replace(/\s+/g, '') ? document.querySelector('.pcard-stats').textContent.replace(/(\d)([A-Za-z])/g, '$1 $2') : ''));
    const before = calls.filter((c) => c.method === 'POST' && c.path === '/api/me/friend-requests').length;
    await page.click('[data-modal-act="cardAdd"]');
    await page.waitForFunction(() => /Request sent/.test(document.querySelector('.pcard-actions')?.textContent || ''));
    const posts = calls.filter((c) => c.method === 'POST' && c.path === '/api/me/friend-requests');
    assert.equal(posts.length, before + 1); assert.deepEqual(JSON.parse(posts.at(-1).body), { username: 'ann' });
    assert.equal(await page.$('[data-modal-act="cardAdd"]'), null, 'no second Add friend while pending');
    await ctx.close();
  });

  await test('a friend’s card says so and offers removal; a bot and a guest offer no friend actions', async () => {
    const { page, ctx } = await scriptedPage(browser, { messages: tableMsgs() });
    await page.goto(url + '/');
    await page.waitForSelector('.pseat[data-pid="u-bob"]');
    await page.waitForFunction(() => window.__sent.length > 0);
    await page.waitForTimeout(300);
    await seat(page, 'u-bob');
    await page.waitForSelector('.pcard-head');
    assert.match(await page.textContent('.pcard-actions'), /You are friends/);
    assert.ok(await page.$('[data-modal-act="cardRemove"]'));
    await page.click('[data-modal-close]');
    await seat(page, 'bot1');
    await page.waitForSelector('.pcard-head');
    assert.match(await page.textContent('.pcard-head'), /Bot/);
    assert.equal(await page.$('[data-modal-act="cardAdd"]'), null);
    assert.equal(await page.$('[data-modal-act="cardMute"]'), null, 'nothing to mute on a bot');
    await page.click('[data-modal-close]');
    await seat(page, 'u-gus');
    await page.waitForSelector('.pcard-head');
    assert.match(await page.textContent('.pcard-actions'), /Guests have no username/);
    assert.match(await page.textContent('.pcard-head'), /400 ms · Poor/);
    await ctx.close();
  });

  await test('your own card offers profile editing, not friending; muting is remembered and reversible', async () => {
    const { page, ctx } = await scriptedPage(browser, { messages: tableMsgs() });
    await page.goto(url + '/');
    await page.waitForSelector('.pseat[data-pid="me"]');
    await seat(page, 'me');
    await page.waitForSelector('.pcard-head');
    assert.ok(await page.$('[data-modal-act="cardEditMe"]'));
    assert.equal(await page.$('[data-modal-act="cardAdd"]'), null);
    await page.click('[data-modal-close]');
    await seat(page, 'u-ann');
    await page.waitForSelector('[data-modal-act="cardMute"]');
    await page.click('[data-modal-act="cardMute"]');
    await page.waitForFunction(() => /Unmute/.test(document.querySelector('.pcard-actions').textContent));
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('ct_muted'))), ['u-ann']);
    await page.click('[data-modal-act="cardMute"]');
    await page.waitForFunction(() => /Mute in chat/.test(document.querySelector('.pcard-actions').textContent));
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('ct_muted'))), []);
    await ctx.close();
  });

  await test('the keyboard opens a card too, and a failed request shows its reason inside the card', async () => {
    const { page, ctx } = await scriptedPage(browser, { messages: tableMessages('wizard', [seats[0], { name: 'Broke', username: 'broke', id: 'u-br' }, seats[2], seats[3]]) });
    await page.goto(url + '/');
    await page.waitForSelector('.pseat[data-pid="u-br"]');
    await page.focus('.pseat[data-pid="u-br"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-modal-act="cardAdd"]');
    await page.click('[data-modal-act="cardAdd"]');
    await page.waitForSelector('.pcard-actions', {});
    await page.waitForFunction(() => /already sent a request/.test(document.querySelector('.modal-body').textContent));
    assert.ok(await page.$('[data-modal-act="cardAdd"]'), 'the person can try again');
    await ctx.close();
  });

  await browser.close(); server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
