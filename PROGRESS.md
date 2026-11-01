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

## Pending
- A3 Wizard mobile UI, A4 Match history/restart, A5 Full regression review.
- B1 Friends DB + API, B2 Friends functionality, B3 Private tables + invitations, B4 Presence + notifications, B5 Frontend.

## Known issues
- PG-backed tests unexecuted in the agent sandbox (see above).
- `players` and `tokens` maps in server.js are per process: with several server instances, sockets of a revoked session are only closed by the instance that handled the HTTP request; the others refuse the session at the next (re)connect because `handleHello` re-checks the database.

## Next step
Start Stage A3 (Wizard mobile UI): inspect `.wz-top` and responsive rules in `public/table.css` / `public/games/wizard.js`; fix real overflow rather than the `.wz { overflow-x: hidden }` added in dbcb73e.
