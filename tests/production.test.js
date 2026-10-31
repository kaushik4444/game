'use strict';
// Production configuration: startup must fail loudly instead of running on the wrong database, plus the abuse limits.
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const WebSocket = require('ws');
const { prepareDatabase } = require('../db/startup');
const { start } = require('../server');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n' + e.stack); process.exitCode = 1; }
}
const quiet = { log() {}, warn() {} };
const fakeDb = (o = {}) => ({ driverMissing: () => false, ping: async () => {}, ...o });
const rejects = (p, re) => assert.rejects(p, (e) => re.test(e.message));

(async () => {
  console.log('database startup');
  await test('production without DATABASE_URL refuses to start', async () => {
    await rejects(prepareDatabase({ env: { NODE_ENV: 'production' }, db: fakeDb(), log: quiet }), /DATABASE_URL is required/);
  });
  await test('development and tests without DATABASE_URL use the in-memory store', async () => {
    assert.deepEqual(await prepareDatabase({ env: {}, db: fakeDb(), log: quiet }), { mode: 'memory' });
    assert.deepEqual(await prepareDatabase({ env: { NODE_ENV: 'test' }, db: fakeDb(), log: quiet }), { mode: 'memory' });
  });
  await test('DATABASE_URL set but the pg driver missing: fatal in production, a warning in development', async () => {
    const db = fakeDb({ driverMissing: () => true });
    await rejects(prepareDatabase({ env: { NODE_ENV: 'production', DATABASE_URL: 'postgres://x' }, db, log: quiet }), /"pg" package is not installed/);
    let warned = '';
    const r = await prepareDatabase({ env: { DATABASE_URL: 'postgres://x' }, db, log: { log() {}, warn: (m) => (warned = m) } });
    assert.equal(r.mode, 'memory');
    assert.match(warned, /pg/);
  });
  await test('an unreachable database is fatal (it is checked before accepting users)', async () => {
    const db = fakeDb({ ping: async () => { throw new Error('ECONNREFUSED'); } });
    let migrated = false;
    await rejects(prepareDatabase({ env: { DATABASE_URL: 'postgres://x' }, db, migrate: async () => { migrated = true; }, log: quiet }), /Cannot reach the database: ECONNREFUSED/);
    assert.equal(migrated, false, 'no migration is attempted on a dead database');
  });
  await test('a failing migration is fatal, in production and in development', async () => {
    const migrate = async () => { throw new Error('syntax error at or near "CREAT"'); };
    for (const NODE_ENV of ['production', 'development']) {
      await rejects(prepareDatabase({ env: { NODE_ENV, DATABASE_URL: 'postgres://x' }, db: fakeDb(), migrate, log: quiet }), /Database migration failed: syntax error/);
    }
  });
  await test('a reachable database with good migrations starts in postgres mode, pinging before migrating', async () => {
    const order = [];
    const r = await prepareDatabase({
      env: { NODE_ENV: 'production', DATABASE_URL: 'postgres://x' },
      db: fakeDb({ ping: async () => order.push('ping') }),
      migrate: async () => { order.push('migrate'); return { applied: ['001_init.sql'] }; },
      log: quiet,
    });
    assert.deepEqual(r, { mode: 'postgres' });
    assert.deepEqual(order, ['ping', 'migrate']);
  });
  await test('start() rejects and never listens when the database is not acceptable', async () => {
    await rejects(start({ port: 0, database: { prepare: async () => { throw new Error('Database migration failed: boom'); } } }), /migration failed/);
  });
  await test('node server.js exits with a non-zero status in production without DATABASE_URL', () => {
    const env = { ...process.env, NODE_ENV: 'production', PORT: '0' };
    delete env.DATABASE_URL;
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, encoding: 'utf8', timeout: 15000, cwd: path.join(__dirname, '..') });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /DATABASE_URL is required/);
    assert.doesNotMatch(r.stdout, /running on/);
  });

  console.log('abuse limits');
  const base = { port: 0, trustProxy: false, database: { prepare: async () => ({ mode: 'memory' }) } };
  const connect = (srv, headers) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { headers });
    const o = { ws, closed: null, msgs: [] };
    ws.on('message', (d) => o.msgs.push(JSON.parse(d)));
    ws.on('close', (code) => (o.closed = code));
    ws.on('error', (e) => (o.error = e.message));
    ws.on('open', () => resolve(o));
    ws.on('unexpected-response', (_, res) => { o.error = 'HTTP ' + res.statusCode; resolve(o); });
    ws.on('error', () => resolve(o));
  });
  const hello = (o, extra = {}) => o.ws.send(JSON.stringify({ t: 'hello', name: 'T', ...extra }));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  await test('a WebSocket from another website (foreign Origin) is refused; the site itself is allowed', async () => {
    const srv = await start(base);
    const evil = await connect(srv, { Origin: 'http://evil.example' });
    assert.match(evil.error || '', /403|401|400/);
    const good = await connect(srv, { Origin: `http://127.0.0.1:${srv.port}` });
    hello(good); await wait(150);
    assert.ok(good.msgs.some((m) => m.t === 'welcome'));
    good.ws.close(); await srv.close();
  });

  await test('too many open sockets from one address are closed', async () => {
    const srv = await start({ ...base, maxSocketsPerIp: 2 });
    const a = await connect(srv); const b = await connect(srv); const c = await connect(srv);
    await wait(150);
    assert.equal(c.closed, 1013);
    assert.equal(a.closed, null);
    a.ws.close(); b.ws.close(); await srv.close();
  });

  await test('new accounts per address are capped, returning players are not affected', async () => {
    const srv = await start({ ...base, maxNewAccountsPerIp: 2 });
    const tokens = [];
    for (let i = 0; i < 2; i++) { const c = await connect(srv); hello(c); await wait(150); tokens.push(c.msgs.find((m) => m.t === 'welcome').token); c.ws.close(); }
    const third = await connect(srv); hello(third); await wait(200);
    assert.equal(third.closed, 1013);
    assert.ok(third.msgs.some((m) => m.t === 'error'));
    const back = await connect(srv); hello(back, { token: tokens[0] }); await wait(200);
    assert.ok(back.msgs.some((m) => m.t === 'welcome'), 'a returning player is still let in');
    back.ws.close(); await srv.close();
  });

  await test('the site-wide account limit stops a flood even from many different addresses', async () => {
    const srv = await start({ ...base, trustProxy: true, maxNewAccountsPerMin: 3, maxNewAccountsPerIp: 1000 });
    let refused = 0;
    for (let i = 0; i < 5; i++) {
      const c = await connect(srv, { 'X-Forwarded-For': `10.0.0.${i}` });
      hello(c); await wait(120);
      if (c.closed === 1013) refused++;
      c.ws.close();
    }
    assert.equal(refused, 2);
    await srv.close();
  });

  await test('/readyz answers, and responses carry HSTS only in production', async () => {
    const srv = await start(base);
    const r = await fetch(`http://127.0.0.1:${srv.port}/readyz`);
    assert.equal(r.status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${srv.port}/`)).headers.get('strict-transport-security'), null);
    await srv.close();
    const prod = await start({ ...base, env: { NODE_ENV: 'production' } });
    assert.match((await fetch(`http://127.0.0.1:${prod.port}/`)).headers.get('strict-transport-security'), /max-age/);
    await prod.close();
  });

  console.log(`\n${passed} production tests passed`);
})();
