'use strict';
require('./helpers/env');
// The cleanup plan and its guards, without a database (the database behaviour is in cleanup.pg.test.js).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const c = require('../db/cleanup');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n' + e.stack); process.exitCode = 1; }
}
const refused = (fn, re) => assert.throws(fn, (e) => e instanceof c.RefusedError && re.test(e.message), re.toString());
const cli = (args, env = {}) => spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'cleanup-user-data.js'), ...args], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 20000 });

console.log('the plan');
test('it covers exactly the tables the migrations create, and every one is either emptied or preserved', () => {
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  const created = new Set();
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql'))) {
    for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+(?:public\.)?"?(\w+)"?/gi)) created.add(m[1]);
  }
  assert.deepEqual([...created].sort(), c.KNOWN_TABLES, 'a new table must be classified in db/cleanup.js (and given a test) before this script may run again');
  assert.ok(c.CLEAN_TABLES.every((t) => !c.PRESERVE.some((p) => p.table === t)), 'no table is both');
});
test('schema_migrations is preserved and is not in the delete list', () => {
  assert.deepEqual(c.PRESERVE.map((p) => p.table), ['schema_migrations']);
  assert.ok(!c.CLEAN_TABLES.includes('schema_migrations'));
});
test('the delete order puts every table before the tables it references', () => {
  const fks = c.EXPECTED_FKS.map((f) => ({ ...f, name: `${f.child}_fk` }));
  assert.doesNotThrow(() => c.validateOrder(c.CLEAN_TABLES, fks));
  assert.deepEqual(c.CLEAN_TABLES, ['match_participants', 'matches', 'auth_email_tokens', 'auth_sessions', 'auth_identities', 'auth_rate_limits', 'players']);
  assert.equal(c.CLEAN_TABLES[c.CLEAN_TABLES.length - 1], 'players', 'accounts last: everything refers to them');
});
test('an order that deletes a parent before its child is refused', () => {
  const fks = c.EXPECTED_FKS.map((f) => ({ ...f, name: `${f.child}_fk` }));
  refused(() => c.validateOrder([...c.CLEAN_TABLES].reverse(), fks), /unsafe deletion order/);
  refused(() => c.validateOrder(['matches', 'match_participants', 'players'], fks), /"match_participants" references "matches"/);
  refused(() => c.validateOrder(['players', 'auth_sessions'], fks), /"auth_sessions" references "players"/);
});

console.log('what the database must look like');
const healthy = () => ({
  tables: [...c.KNOWN_TABLES], foreignSchemas: [], triggers: [], applied: c.repoMigrations(),
  fks: c.EXPECTED_FKS.map((f) => ({ ...f, name: `${f.child}_fk` })),
});
test('the expected schema passes', () => assert.doesNotThrow(() => c.checkSchema(healthy())));
test('an unclassified table is refused by name instead of being ignored', () => {
  const f = healthy(); f.tables.push('user_notes');
  refused(() => c.checkSchema(f), /unclassified table\(s\) user_notes/);
});
test('a missing table, another schema, a trigger, a new foreign key, a view, a sequence or function are all refused', () => {
  let f = healthy(); f.tables = f.tables.filter((t) => t !== 'matches');
  refused(() => c.checkSchema(f), /missing: matches/);
  f = healthy(); f.foreignSchemas = ['audit'];
  refused(() => c.checkSchema(f), /other schema\(s\): audit/);
  f = healthy(); f.triggers = [{ tbl: 'players', tgname: 'audit_players' }];
  refused(() => c.checkSchema(f), /trigger\(s\) on players\.audit_players/);
  f = healthy(); f.fks.push({ name: 'x', child: 'matches', parent: 'players', onDelete: 'CASCADE' });
  refused(() => c.checkSchema(f), /unexpected foreign key\(s\): matches>players/);
  f = healthy(); f.fks = f.fks.filter((k) => k.child !== 'auth_sessions');
  refused(() => c.checkSchema(f), /foreign key\(s\) missing: auth_sessions>players/);
  f = healthy(); f.views = ['user_view'];
  refused(() => c.checkSchema(f), /unexpected view\(s\): user_view/);
  f = healthy(); f.sequences = ['custom_seq'];
  refused(() => c.checkSchema(f), /unexpected sequence\(s\): custom_seq/);
  f = healthy(); f.functions = ['custom_func'];
  refused(() => c.checkSchema(f), /unexpected function\(s\): custom_func/);
});
test('a preserved table that references a table to be emptied is refused', () => {
  const f = healthy(); f.fks.push({ name: 'bad', child: 'schema_migrations', parent: 'players', onDelete: 'CASCADE' });
  refused(() => c.checkSchema(f), /preserved table "schema_migrations" references "players"/);
});
test('migration history must match the repository exactly, both ways', () => {
  let f = healthy(); f.applied = f.applied.slice(0, -1);
  refused(() => c.checkSchema(f), /not applied to this database: 004_/);
  f = healthy(); f.applied = [...f.applied, '999_future.sql'];
  refused(() => c.checkSchema(f), /unknown to this code version: 999_future\.sql/);
});

console.log('the target and the confirmation');
test('a local database needs no host confirmation; a remote one does, and it must match', () => {
  const local = c.parseTarget('postgres://postgres@127.0.0.1:5432/tv');
  assert.equal(local.isLocal, true);
  assert.doesNotThrow(() => c.checkTarget(local, {}));
  const remote = c.parseTarget('postgresql://u:secret@ep-quiet-123.eu-central-1.aws.neon.tech/neondb?sslmode=require');
  assert.equal(remote.isLocal, false);
  assert.equal(remote.database, 'neondb');
  refused(() => c.checkTarget(remote, {}), /remote.*--expect-host=ep-quiet-123/);
  refused(() => c.checkTarget(remote, { expectHost: 'ep-other.neon.tech' }), /does not match the host/);
  assert.doesNotThrow(() => c.checkTarget(remote, { expectHost: 'EP-QUIET-123.eu-central-1.aws.neon.tech' }));
});
test('executing needs --confirm equal to the database name', () => {
  const t = c.parseTarget('postgres://postgres@localhost/tableverse');
  refused(() => c.checkTarget(t, { execute: true }), /without confirmation: add --confirm=tableverse/);
  refused(() => c.checkTarget(t, { execute: true, confirm: 'yes' }), /does not equal the database name "tableverse"/);
  refused(() => c.checkTarget(t, { execute: true, confirm: 'tableverse2' }), /does not equal/);
  assert.doesNotThrow(() => c.checkTarget(t, { execute: true, confirm: 'tableverse' }));
  assert.doesNotThrow(() => c.checkTarget(t, { execute: false }), 'a dry run needs no confirmation');
});
test('--expect-db must match when given; bad URLs are refused', () => {
  const t = c.parseTarget('postgres://postgres@localhost/tableverse');
  refused(() => c.checkTarget(t, { expectDb: 'other' }), /--expect-db=other/);
  refused(() => c.parseTarget('mysql://root@localhost/x'), /postgres/);
  refused(() => c.parseTarget('not a url'), /valid URL/);
  refused(() => c.parseTarget('postgres://localhost'), /no database name/);
});

console.log('the command line');
test('without CLEANUP_DATABASE_URL it refuses, and it never falls back to DATABASE_URL', () => {
  const r = cli([], { DATABASE_URL: 'postgresql://u:p@ep-prod.neon.tech/neondb' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /CLEANUP_DATABASE_URL is not set/);
  assert.match(r.stderr, /DATABASE_URL is set but is deliberately not used/);
  assert.doesNotMatch(r.stderr + r.stdout, /ep-prod/, 'the URL is not echoed');
});
test('--execute without --confirm is refused before any connection is made', () => {
  const r = cli(['--execute'], { CLEANUP_DATABASE_URL: 'postgres://postgres@127.0.0.1:1/tv' }); // nothing listens on port 1
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /REFUSED: refusing to delete without confirmation/);
  assert.match(r.stderr, /Nothing was changed/);
});
test('a remote host without --expect-host is refused before connecting; the password is never printed', () => {
  const r = cli([], { CLEANUP_DATABASE_URL: 'postgresql://user:hunter2@ep-x.neon.tech/neondb?sslmode=require' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--expect-host=ep-x\.neon\.tech/);
  assert.doesNotMatch(r.stderr + r.stdout, /hunter2/);
});
test('bad options are refused with usage', () => {
  assert.equal(cli(['--sample=abc'], { CLEANUP_DATABASE_URL: 'postgres://u@127.0.0.1:1/x' }).status, 2);
  assert.equal(cli(['--drop-everything'], { CLEANUP_DATABASE_URL: 'postgres://u@127.0.0.1:1/x' }).status, 2);
  assert.match(cli(['--help']).stdout, /dry run/);
});
test('masking hides the address but keeps the domain', () => {
  assert.equal(c.mask('someone@example.com'), 's***@example.com');
  assert.equal(c.mask(null), '***');
});
test('the script and library contain no destructive statement other than the table-by-table DELETE', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'db', 'cleanup.js'), 'utf8') + fs.readFileSync(path.join(__dirname, '..', 'scripts', 'cleanup-user-data.js'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  for (const bad of [/TRUNCATE/i, /DROP\s+(TABLE|SCHEMA|INDEX|DATABASE|CONSTRAINT)/i, /ALTER\s+TABLE/i, /CREATE\s+(TABLE|INDEX)/i, /CASCADE\s*;/i, /DELETE\s+FROM\s+schema_migrations/i]) assert.doesNotMatch(code, bad, String(bad));
  assert.equal([...code.matchAll(/DELETE FROM/g)].length, 1, 'exactly one DELETE statement, run per classified table');
});

console.log(`\n${passed} cleanup unit tests passed`);
