# Stage 7: removing all user and gameplay data

Purpose: empty every table that holds users or their history, **keep the schema, the indexes, the constraints and the
migration history**, and leave the application working. This document is the plan and the runbook. The script is
`scripts/cleanup-user-data.js` (library: `db/cleanup.js`).

**Nothing in this repository runs the cleanup by itself.** It only happens when a person runs the command in section 4
with `--execute` and the confirmation. The script was developed and tested only on throw-away local databases.

## 1. Every table in the database (discovered from `db/migrations/001` to `004`)

There are 8 tables and 5 foreign keys. The script itself re-discovers the live schema on every run and **refuses** if it
finds a table or foreign key that is not in this list, a trigger, or a migration set that differs from this code version.

| Table | What it stores | Action | Foreign keys | Delete order |
|---|---|---|---|---|
| `match_participants` | Per-player result rows of finished games (name, seat, score, winner / bot / left-early flags, optional account id) | **Empty** | `match_id` → `matches` (CASCADE); `player_id` → `players` (SET NULL) | 1 |
| `matches` | Finished games (game, room code, seats, options, time, idempotency `match_key`) | **Empty** | referenced by `match_participants` | 2 |
| `auth_email_tokens` | Hashed single-use verification / password-reset tokens and the address they were sent to | **Empty** | `player_id` → `players` (CASCADE) | 3 |
| `auth_sessions` | Hashed session tokens: registered **and legacy anonymous**, with expiry / revocation | **Empty** | `player_id` → `players` (CASCADE) | 4 |
| `auth_identities` | Login methods: email, Argon2 password hash, verification time | **Empty** | `player_id` → `players` (CASCADE) | 5 |
| `auth_rate_limits` | Hashed per-address / per-email rate-limit counters | **Empty** | none | 6 |
| `players` | Accounts: registered players and **legacy anonymous players** | **Empty** | referenced by the four tables above | 7 (last) |
| `schema_migrations` | Which migration files were applied | **PRESERVE, never touched** | none | not in the plan |

Player statistics are not stored anywhere: they are computed from `matches` / `match_participants`, so emptying those
removes all stats. There are no other user-related tables, views, sequences (all keys are UUIDs) or triggers.

Why this order: every table is deleted **before** the tables it references, so no row is ever left pointing at a
deleted parent and nothing depends on `ON DELETE CASCADE` / `SET NULL` doing deletions behind the script's back. The
script checks that each `DELETE` removed exactly the rows it counted and that the tables still to come are unchanged.
It never uses `TRUNCATE`, `DROP`, `ALTER`, `CREATE` or `CASCADE`.

## 2. What the script guarantees

* **Dry run by default**: read-only transaction (`BEGIN READ ONLY`), always rolled back. Prints the row count of every table, breakdowns and a masked sample of the records.
* **Two things are needed to delete**: `--execute` and `--confirm=<exact database name>`.
* **The target is named on purpose**: `CLEANUP_DATABASE_URL` only. `DATABASE_URL` and `.env` files are ignored. A remote host must also be repeated with `--expect-host=<host>`. The connected `current_database()` must equal the URL's database. A running migration (advisory lock) blocks it.
* **Expected state only**: same 8 tables, same 5 foreign keys, no triggers, no other schema, and exactly the migrations in `db/migrations` applied. Anything else is refused with the list of differences.
* **One transaction**: tables are locked (`SHARE ROW EXCLUSIVE`: readers keep working, writers wait), counted, deleted in the order above and checked; a schema and migration-history fingerprint taken before and after must be identical. Any error, mismatch or timeout rolls everything back (`lock_timeout` 10 s, `statement_timeout` 5 min).
* **Nothing sensitive is printed**: emails are masked (`a***@example.com`), token hashes are never selected, the connection password is never shown, and the snapshot file holds only structure digests and counts.

## 3. Before you run it for real (checklist)

1. Review this document, `db/cleanup.js` and the tests (`npm run test:pg`).
2. Take a database backup / branch of the Neon database (Neon: create a branch or enable point-in-time restore) so the deletion can be undone.
3. Put the site in maintenance (suspend the Render service, or scale it to zero) so nobody registers during the deletion. The script blocks writers while it runs, but players would see errors.
4. Make sure the database is migrated to the version of this repository (`npm run migrate`, or simply deploy it). The script refuses otherwise.

## 4. Commands

Use the **direct** (non-pooled) Neon connection string if you have one. Quote the URL. Never put it in a file in the repository.

```bash
# 1. Dry run (default, read-only). Writes a schema snapshot (no user data) for the later comparison.
CLEANUP_DATABASE_URL='postgresql://USER:PASSWORD@HOST/DBNAME?sslmode=require' \
  node scripts/cleanup-user-data.js --expect-host=HOST --snapshot=pre-cleanup.json

# 2. The cleanup. Only after the dry run output was reviewed and approved.
CLEANUP_DATABASE_URL='postgresql://USER:PASSWORD@HOST/DBNAME?sslmode=require' \
  node scripts/cleanup-user-data.js --execute --confirm=DBNAME --expect-host=HOST --snapshot=pre-cleanup.json

# 3. Verify afterwards (read-only)
CLEANUP_DATABASE_URL='postgresql://USER:PASSWORD@HOST/DBNAME?sslmode=require' \
  node scripts/cleanup-user-data.js --verify --expect-host=HOST --snapshot=pre-cleanup.json
```

`npm run cleanup:users -- <options>` is the same command. Options: `--sample=<n>` (rows shown per table, default 5),
`--json`, `--expect-db=<name>`, `--no-app-smoke` (verify only), `--help`.
Exit codes: `0` done, `1` failed (rolled back), `2` refused (nothing changed).

## 5. Verification after the execution

`--verify` (read-only) checks that:

* every one of the 7 tables is empty, and no legacy anonymous player remains;
* `schema_migrations` lists exactly the repository's migrations and is byte-identical to the snapshot (versions and `applied_at`);
* the schema fingerprint (tables, columns, indexes, constraints, triggers) equals the snapshot, and all 5 foreign keys exist;
* the application's own read paths work on the database (player stats query, username lookup, session lookup).

Then do the manual end-to-end check: open the site, register a test account, verify the email, log in, join a table.
(The tests do exactly this automatically on a cleaned throw-away database.) Resume the Render service afterwards.

## 6. Tests

* `tests/cleanup.test.js` (no database): the plan covers exactly the tables the migrations create; order versus foreign keys; refusals (unknown table, trigger, extra / missing foreign key or migration, remote host, missing or wrong confirmation, `DATABASE_URL` fallback); the source contains no `TRUNCATE` / `DROP` / `ALTER` / `CASCADE`.
* `tests/cleanup.pg.test.js` (real PostgreSQL, throw-away database, needs `TEST_DATABASE_URL`): a dry run issues only read statements and leaves every table byte-identical; `--execute` without or with a wrong confirmation deletes nothing; wrong deletion orders are refused; errors after any delete, before commit and a lock timeout all roll back completely; the real execution empties the 7 tables in plan order, keeps `schema_migrations` byte-identical and the schema fingerprint and foreign keys unchanged; `--verify` passes afterwards and fails on a database that still has data; an end-to-end CLI run (dry run, execute, verify); and the application then registers, verifies, logs in and reaches the lobby, and migrations report nothing pending.

```bash
npm test                                   # unit tests; the PostgreSQL files print SKIPPED without TEST_DATABASE_URL
TEST_DATABASE_URL=postgres://postgres:secret@127.0.0.1:5432/postgres npm run test:pg
```

## 7. Limits

* Rolling back is only possible until `COMMIT`. After that the backup from the checklist is the only way back.
* In-memory state of a running server (tables, rooms, cached players) is not in the database. Restart the Render service after the cleanup so it starts empty; browsers holding old cookies simply land on the login page.
* A future migration that adds a table makes `tests/cleanup.test.js` fail until the table is classified in `db/cleanup.js` (emptied or preserved) and the docs are updated. That is intended.
