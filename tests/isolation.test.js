'use strict';
// Test isolation: tests must never be able to write into a real (for example Neon production) database.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n' + e.stack); process.exitCode = 1; }
}
const run = (code, env) => spawnSync(process.execPath, ['-e', code], { cwd: path.join(__dirname, '..'), env: { PATH: process.env.PATH, NODE_PATH: process.env.NODE_PATH || '', ...env }, encoding: 'utf8', timeout: 20000 });

console.log('the test environment guard');
test('a DATABASE_URL in the shell is removed and the process runs on the in-memory store', () => {
  const r = run("require('./tests/helpers/env'); const p = require('./db/pool'); console.log(JSON.stringify({ url: process.env.DATABASE_URL || null, db: p.hasDatabase(), saved: process.env.TV_ORIGINAL_DATABASE_URL }))", { DATABASE_URL: 'postgresql://user:pw@ep-prod.neon.tech/neondb?sslmode=require' });
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.deepEqual([o.url, o.db], [null, false]);
  assert.match(o.saved, /neon\.tech/, 'remembered only so the test database can be checked against it');
});
test('even without the guard, NODE_ENV=test stops db/pool.js from loading .env files', () => {
  const r = run("const p = require('./db/pool'); console.log(p.hasDatabase())", { NODE_ENV: 'test' });
  assert.equal(r.stdout.trim(), 'false');
});

console.log('the PostgreSQL test database guard');
const { assertSafe } = require('./helpers/testdb');
test('local servers are accepted', () => {
  for (const u of ['postgres://postgres@127.0.0.1:5432/postgres', 'postgres://u:p@localhost/postgres', 'postgresql://postgres@[::1]:5433/postgres']) assert.doesNotThrow(() => assertSafe(u, {}), u);
});
test('managed and production hosts are refused, even with ALLOW_REMOTE_TEST_DB', () => {
  for (const u of ['postgresql://u:p@ep-cool-123.eu-central-1.aws.neon.tech/neondb?sslmode=require', 'postgres://u@db.abcd.supabase.co:5432/postgres', 'postgres://u@dpg-1.frankfurt-postgres.render.com/db', 'postgres://u@x.rds.amazonaws.com/db'])
    assert.throws(() => assertSafe(u, { ALLOW_REMOTE_TEST_DB: '1' }), /managed|production/, u);
});
test('another remote host needs an explicit opt-in', () => {
  assert.throws(() => assertSafe('postgres://u@10.1.2.3:5432/postgres', {}), /non-local/);
  assert.doesNotThrow(() => assertSafe('postgres://u@10.1.2.3:5432/postgres', { ALLOW_REMOTE_TEST_DB: '1' }));
});
test('the same remote server as DATABASE_URL is refused even if opted in', () => {
  assert.throws(() => assertSafe('postgres://u@db.internal.example:5432/test', { ALLOW_REMOTE_TEST_DB: '1', DATABASE_URL: 'postgres://prod@db.internal.example:5432/app' }), /same server/);
  assert.throws(() => assertSafe('postgres://u@db.internal.example:5432/test', { ALLOW_REMOTE_TEST_DB: '1', TV_ORIGINAL_DATABASE_URL: 'postgres://prod@db.internal.example:5432/app' }), /same server/);
});
test('garbage and non-postgres URLs are refused', () => {
  assert.throws(() => assertSafe('not a url', {}), /valid URL/);
  assert.throws(() => assertSafe('mysql://root@127.0.0.1/x', {}), /postgres/);
});

console.log(`\n${passed} isolation tests passed`);
