#!/usr/bin/env node
'use strict';
/**
 * Removes ALL user and gameplay data (accounts, sessions, tokens, matches, results, rate limits) and keeps the schema.
 * Read docs/DATA_CLEANUP.md before using it.
 *
 *   CLEANUP_DATABASE_URL=postgres://... node scripts/cleanup-user-data.js                      dry run (the default, read-only)
 *   CLEANUP_DATABASE_URL=... node scripts/cleanup-user-data.js --execute --confirm=<database>   delete (see the guards in db/cleanup.js)
 *   CLEANUP_DATABASE_URL=... node scripts/cleanup-user-data.js --verify [--snapshot=pre.json]   read-only checks afterwards
 *
 * It deliberately ignores DATABASE_URL and .env files: the target must be named on purpose.
 * Exit codes: 0 done, 1 failed (and rolled back), 2 refused / bad usage (nothing was changed).
 */
const fs = require('fs');
const { parseArgs } = require('util');
const cleanup = require('../db/cleanup');

const HELP = `Usage: node scripts/cleanup-user-data.js [options]

Environment:
  CLEANUP_DATABASE_URL   the database to clean (required; DATABASE_URL and .env are never used)

Options:
  (none)                 dry run: read-only, prints what would be deleted
  --execute              really delete. Also needs --confirm=<database name>
  --confirm=<name>       must equal the database name in CLEANUP_DATABASE_URL
  --expect-host=<host>   required for a remote host: must equal the host in the URL
  --expect-db=<name>     optional extra check on the database name
  --sample=<n>           rows shown per table (default 5, 0 = none)
  --snapshot=<file>      dry run / execute: write the schema fingerprint (no user data) to this file
                         verify: compare against it
  --verify               read-only checks after a cleanup (tables empty, schema and migrations intact, app read paths work)
  --no-app-smoke         with --verify: skip the application read-path checks
  --json                 print the result as JSON
  --help
`;

(async () => {
  let args;
  try {
    args = parseArgs({
      options: {
        execute: { type: 'boolean', default: false }, confirm: { type: 'string' }, 'expect-host': { type: 'string' }, 'expect-db': { type: 'string' },
        sample: { type: 'string', default: '5' }, snapshot: { type: 'string' }, verify: { type: 'boolean', default: false }, 'no-app-smoke': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
      },
      allowPositionals: false,
    }).values;
  } catch (e) {
    console.error(`REFUSED: ${e.message}\n\n${HELP}`);
    process.exit(2);
  }
  if (args.help) { console.log(HELP); return; }

  const url = process.env.CLEANUP_DATABASE_URL;
  if (!url) {
    console.error('REFUSED: CLEANUP_DATABASE_URL is not set.' + (process.env.DATABASE_URL ? ' (DATABASE_URL is set but is deliberately not used: name the target explicitly.)' : ''));
    process.exit(2);
  }
  const sample = Number(args.sample);
  if (!Number.isInteger(sample) || sample < 0 || sample > 1000) { console.error('REFUSED: --sample must be a whole number from 0 to 1000'); process.exit(2); }
  if (args.confirm && !args.execute) console.error('note: --confirm has no effect without --execute; this is a dry run.');

  const common = { url, expectHost: args['expect-host'], expectDb: args['expect-db'] };
  try {
    if (args.verify) {
      const snapshot = args.snapshot ? JSON.parse(fs.readFileSync(args.snapshot, 'utf8')) : null;
      const res = await cleanup.verify({ ...common, snapshot, appSmoke: !args['no-app-smoke'] });
      if (args.json) console.log(JSON.stringify(res, null, 2));
      else {
        console.log(`Verification of database "${res.target.database}" on ${res.target.host}`);
        for (const c of res.checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail && !c.ok ? '  [' + c.detail + ']' : ''}`);
        console.log(res.ok ? '\nAll checks passed.' : '\nSome checks FAILED.');
      }
      process.exit(res.ok ? 0 : 1);
    }

    const report = await cleanup.run({ ...common, execute: args.execute, confirm: args.confirm, sample });
    if (args.snapshot) {
      fs.writeFileSync(args.snapshot, JSON.stringify({ takenAt: new Date().toISOString(), target: report.target, mode: report.mode, counts: report.before, fingerprint: report.fingerprint }, null, 2));
    }
    console.log(args.json ? JSON.stringify(report, null, 2) : cleanup.formatReport(report));
    if (!args.json && report.mode === 'dry-run') {
      const t = report.target;
      console.log(`\nTo delete for real (after review), run:\n  CLEANUP_DATABASE_URL=<url> node scripts/cleanup-user-data.js --execute --confirm=${t.database}${t.local ? '' : ' --expect-host=' + t.host} --snapshot=pre-cleanup.json`);
    }
  } catch (e) {
    if (e instanceof cleanup.RefusedError) {
      console.error(`REFUSED: ${e.message}\nNothing was changed.`);
      process.exit(2);
    }
    console.error(`FAILED: ${e.message}`);
    if (e.report && e.report.rolledBack) console.error('The transaction was rolled back: nothing was changed.');
    else if (e.report && e.report.mode === 'execute') console.error('Could not confirm the rollback: run with --verify to see the current state.');
    process.exit(1);
  }
})();
