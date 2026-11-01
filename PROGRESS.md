# Tableverse progress notes (branch `claude/tableverse-friends-private-tables`)

Never merge this branch into `main` from an agent session. Work in small stages: test, commit, push after each.

## How to run the tests
- No database needed: `node tests/<name>.test.js` for engine, twentynine, poker, themind, results, scrub, stats, matchqueue, isolation, email, cleanup, db, production, smoke.
- PostgreSQL suites (`npm run test:pg`) need `TEST_DATABASE_URL` pointing at a THROW-AWAY local database. Never use the Neon production URL.
- The agent sandbox used so far cannot install `pg`, `ws` (borrowed from /opt/npm-tools), `@node-rs/argon2` and has no PostgreSQL server, so **every `*.pg.test.js` file has only been syntax-checked there, never executed**. Run `npm run test:pg` locally before merging.

## Completed
- (before this task) Profiles/history (Stage 5), account deletion anonymisation, revoked-WebSocket and repeat-spectator fixes by the owner (commits dbcb73e, 3a91c6e).
- **A1 Single active session** (migration 006): `createSession` locks the player row, revokes older sessions, inserts; partial unique index `ux_auth_sessions_one_active`; login runs in one transaction; a new login closes the older device's sockets (code 4002, client shows a sign-in sheet); logout/reset close sockets by session token (4001). Tests: `tests/session.pg.test.js` (new), `account.pg`, `production.pg`, `cleanup.test`, `db.pg` adjusted.

- **A2 Spectator reliability**: `join` now detects "already at this table" (seated or watching) before any capacity check, repairs a stale `p.room`, and never repeats the watching/joined announcement; spectator cap is configurable (`opts.maxSpectators`, default 20) for tests. Tests: `tests/spectators.test.js` (DB-free, runs on the real server in memory mode; 7 tests, passing).

- **A3 Wizard/table mobile layout**: removed `.wz { overflow-x: hidden }` and fixed what it hid: phone header is two even rows (round label, then six controls), seats no longer sit under the status/bid bars, trump card moves above the table for 3 and 5+ players on phones (desktop corner shows the card only), The Mind level dots shrink instead of overflowing at 320 px. `npm run test:ui` (tests/ui/wizard-layout.js) drives real Chromium with real engine views: 8 table setups x 6 seeds x 6 viewports (320x568 ... 1280x800, incl. phone landscape) = 288 checks, all passing. It is not in CI (needs a browser).
- **A4 Match history and restart**: reviewed the whole lifecycle (new `matchKey` per start, record only at game end, `status` guard, unique `match_key`, spool replay). Fixed: a game finishing during shutdown is now spooled instead of dropped; the spool is replayed every 10 minutes (not only at start) and skips records already being written. Tests: 4 new cases in `tests/matchqueue.test.js` (run, passing) and `tests/matches.pg.test.js` (rematch = new match and nothing overwritten, exactly once, failing DB -> spool -> restart saves once, second restart adds nothing).
- **A5 Regression review**: see "Test report" below.

## Test report (last run, A5)
Executed and passing here: `npm run build`; engine, twentynine, poker, themind, results, scrub, matchqueue (17), cleanup, email, isolation, db (memory mode); `npm run test:ui` (288 browser checks).
NOT executed here (cannot load `pg` / `@node-rs/argon2`, registry unreachable, no real PostgreSQL driver): `production`, `smoke`, `spectators`, `stats`, and every `*.pg.test.js` (`db`, `production`, `cleanup`, `account`, `session`, `matches`) - these print SKIPPED without TEST_DATABASE_URL, which exits 0 and is NOT a pass. Only syntax-checked. CI (`npm run test:pg` against the postgres:16 service) is where they must run.
Code review of A1-A4 (security, migration 006, in-memory mode): no defects found beyond the fixes above. Migration 006 only revokes (never deletes) extra sessions, then adds a partial unique index; every session-creating path goes through `createSession` or creates a brand-new account.

## Pending
- B1 Friends DB + API, B2 Friends functionality, B3 Private tables + invitations, B4 Presence + notifications, B5 Frontend.

## Known issues
- `tests/matches.pg.test.js`, `session.pg.test.js`, `account.pg.test.js` were written without being able to run them; expect small fixes on first CI run.
- The in-memory match store (no DATABASE_URL) keeps every match for the life of the process.
- The UI layout test covers the table screens (header, seats, trump corner) only, not lobby/home/modals.
- PG-backed tests unexecuted in the agent sandbox (see above).
- `players` and `tokens` maps in server.js are per process: with several server instances, sockets of a revoked session are only closed by the instance that handled the HTTP request; the others refuse the session at the next (re)connect because `handleHello` re-checks the database.

## Next step
Run `npm run test:pg` locally or read the CI result for this branch and fix anything in the new pg tests (written but never executed). Then B1 (friends DB + API).
