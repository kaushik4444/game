# Tableverse progress notes (branch `feature/stage-6-friends-private-tables`)

Never merge this branch into `main` from an agent session. Work in small stages: test, commit, push after each.

## How to run the tests
- No database needed: `node tests/<name>.test.js` for engine, twentynine, poker, themind, results, scrub, stats, matchqueue, isolation, email, cleanup, db, production, smoke.
- PostgreSQL suites (`npm run test:pg`) need `TEST_DATABASE_URL` pointing at a THROW-AWAY local database. Never use the Neon production URL.
- A skipped PostgreSQL suite is not a pass. The prior A1–A5 sandbox could not execute PostgreSQL tests; refer to the CI run or run them locally with a dedicated disposable database.

## Completed before Stage 6
- Profiles/history (Stage 5), account deletion anonymisation, revoked-WebSocket and repeat-spectator fixes by the owner (commits dbcb73e, 3a91c6e).
- **A1 Single active session** (migration 006): `createSession` locks the player row, revokes older sessions, inserts; partial unique index `ux_auth_sessions_one_active`; login runs in one transaction; a new login closes the older device's sockets (code 4002, client shows a sign-in sheet); logout/reset close sockets by session token (4001).
- **A2 Spectator reliability**: duplicate joins detect existing seat/watching state before capacity checks, repair stale room state, and avoid duplicate announcements.
- **A3 Wizard/table mobile layout**: mobile overflow and seat/status/trump placement fixed; browser UI suite covered 288 viewport/setup checks.
- **A4 Match history and restart**: unique match key, shutdown-safe spool and periodic replay.
- **A5 Regression review**: recorded in earlier project progress and merged to main.

## Stage 6 progress

### S6.1 — Database & Backend Foundation (verified)
- Branch created from latest fetched `origin/main` at `aafd049` as `feature/stage-6-friends-private-tables`.
- Added migration `007_friends_private_tables.sql` defining canonical friendships, constrained friend-request lifecycle, and private-table invitation metadata with FK cascades, uniqueness and lookup indexes.
- Added `db/friends.js` persistence operations and authenticated endpoints under `/api/me/friends*`, `/api/me/friend-requests*`, and `/api/me/table-invitations*`; routing reuses cookie session auth, CSRF, error handling and rate limiting.
- Updated cleanup classification, delete order and test fixtures for the three new tables.
- Added `tests/friends.pg.test.js`; included it in package scripts/build syntax checks.
- The opposite-direction request policy is auto-accept: a new request in response to an existing reverse pending request atomically accepts it and creates the friendship.
- Known boundary: invitation APIs persist table metadata and invitation lifecycle only. They do not authorize room joins, generate shareable secret codes, create private rooms, send notifications, or provide presence/UI; those behaviors remain for S6.3–S6.5.
- Review fixes: SQL search retains the `[a-z0-9_]` input policy and uses parameterized SQL with LIKE escaping; tests reject `%` and backslash prefixes. Friend-request transitions acquire the canonical pair advisory lock before row locking. Invitation acceptance now shares that lock with friend removal and revalidates friendship before accepting. Added migration-007 concurrent application coverage and invitation/removal race coverage. Cleanup schema inventory now includes both participant FKs for each social table.
- Verification: `node tests/production.test.js` (13 pass), `node tests/smoke.test.js` (pass), `npm run build` (pass), and `git diff --check` (pass). Full `npm run test:pg` passed against the disposable local PostgreSQL test databases with no skips: database/migration 30, PostgreSQL production 17, cleanup 13, account 10, match lifecycle 4, session 7, and friends/invitations 7 tests. The three-instance migration test confirms migrations 001–007 apply once and subsequent migration run is a no-op.
- Test database: local endpoint `127.0.0.1:5432/postgres`; helper creates/drops random `tv_test_*` databases. User provided this as TEST_DATABASE_URL and it passed helper safety checks.
- Commit `86055f3` (`Fix Stage 6.1 friendship invitation races`) pushed to `origin/feature/stage-6-friends-private-tables`; not merged into `main`.

## Next steps
1. Push the verified S6.1 commit on this branch; do not merge to `main`.
2. Proceed to **S6.2 — Friends System** (finish search/request lifecycle/remove-friend behavior and dedicated authorization/duplicate testing; avoid duplicating the S6.1 API implementation).
