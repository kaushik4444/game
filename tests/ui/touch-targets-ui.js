'use strict';
/**
 * Phones and tablets: the home screen and the table toolbar have no horizontal scrolling, and every control a player taps
 * there is at least 44 px tall (Apple HIG 44 pt; WCAG 2.5.5). Desktop sizes are not checked here.
 * Playwright/Chromium only; skips, exit 0, when Playwright is not installed.
 */
const assert = require('node:assert/strict');
const { serve, scriptedPage, loadPlaywright, sessionOk, welcome, tableMessages } = require('./harness');
const games = require('../../games');
const { chromium } = loadPlaywright();

const MIN = 44;
const PHONES = [['Android 360', 360, 740], ['iPhone 14', 390, 844], ['tablet', 768, 1024]];

// Visible, enabled controls in the page's app area, with their size and a readable name.
const MEASURE = (selector) => {
  const vw = innerWidth;
  const out = { overflowX: Math.max(0, document.documentElement.scrollWidth - vw), short: [], count: 0 };
  const name = (el) => (el.getAttribute('aria-label') || el.innerText || el.className || el.tagName).toString().trim().replace(/\s+/g, ' ').slice(0, 40);
  for (const el of document.querySelectorAll(selector)) {
    if (el.closest('[hidden],[aria-hidden=true]') || el.disabled) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    out.count++;
    if (r.height < 44) out.short.push(`${name(el)} (${Math.round(r.width)}x${Math.round(r.height)})`);
  }
  return out;
};

const HOME_CONTROLS = '#app button, #app a[href], #app [role=button]';
const TOOLBAR_CONTROLS = '[aria-label="Open chat"], [aria-label="Send a reaction"], [aria-label="Leave table"], [aria-label="More options"], [aria-label^="Join voice chat"]';

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('ok    ' + name); } catch (e) { failed++; console.error('FAIL  ' + name + '\n      ' + e.message.split('\n').slice(0, 4).join('\n      ')); }
}

(async () => {
  const browser = await chromium.launch();
  const srv = await serve({
    'GET /api/auth/session': () => sessionOk(),
    'GET /api/me/friends': () => ({ friends: [] }),
    'GET /api/me/recent': () => ({ recent: [] }),
  });
  try {
    for (const [label, width, height] of PHONES) {
      await check(`home screen, ${label} ${width}x${height}: no horizontal scroll, all controls >= 44 px`, async () => {
        const { page, ctx } = await scriptedPage(browser, { viewport: { width, height }, messages: [welcome({ games: games.list() })] });
        try {
          await page.goto(srv.url + '/', { waitUntil: 'load' });
          await page.waitForSelector('#app .btn', { timeout: 5000 });
          const r = await page.evaluate(MEASURE, HOME_CONTROLS);
          assert.equal(r.overflowX, 0, 'page scrolls sideways');
          assert.ok(r.count >= 6, `expected the home controls, found ${r.count}`);
          assert.deepEqual(r.short, [], 'controls under 44 px');
        } finally { await ctx.close(); }
      });
    }

    for (const [gameId, n] of [['wizard', 4], ['gofish', 4], ['tictactoe', 2]]) {
      for (const [label, width, height] of [['iPhone 14', 390, 844], ['tablet', 768, 1024]]) {
        await check(`table toolbar, ${gameId} on ${label} ${width}x${height}: no horizontal scroll, toolbar >= 44 px`, async () => {
          const names = ['Aarav', 'Bo', 'Cy', 'Di'].slice(0, n).map((name) => ({ name }));
          const { page, ctx } = await scriptedPage(browser, { viewport: { width, height }, messages: tableMessages(gameId, names, { seed: 3 }) });
          try {
            await page.goto(srv.url + '/', { waitUntil: 'load' });
            await page.waitForSelector(TOOLBAR_CONTROLS, { timeout: 5000 });
            const r = await page.evaluate(MEASURE, TOOLBAR_CONTROLS);
            assert.equal(r.overflowX, 0, 'page scrolls sideways');
            assert.ok(r.count >= 4, `expected the toolbar, found ${r.count}`);
            assert.deepEqual(r.short, [], 'toolbar controls under 44 px');
          } finally { await ctx.close(); }
        });
      }
    }
  } finally {
    await browser.close();
    srv.server.close();
  }
  if (failed) { console.error(`\n${failed} touch-target check(s) failed`); process.exit(1); }
  console.log('\nall touch-target checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
