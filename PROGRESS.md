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
- Commit `bf1c387571fb6a2f2c0c4fd5e2267da5bf46bb61` (`Fix Stage 6.1 friendship invitation races`) pushed to `origin/feature/stage-6-friends-private-tables`; not merged into `main`.

### S6.2–S6.5 — continued by the agent after the owner's `incomplete stage 6` commit (d2f1a23)
Already in place from the owner's commit: private tables (default) need an accepted invitation, enforced on `join`, `sit` and reconnect (`canEnterRoom`); invitation APIs validate the room; live `socialNotice` / `socialPresence` messages; friends panel, invitations and the in-lobby invite form in `public/app.js`; migration 008.
Fixed / added in this session:
- **Per-socket message order**: handlers became async (`join` awaits the DB) but were fired without waiting, so a following `act`/`chat`/`leave` could overtake a join. Messages of one socket now run through a promise queue (`ws.queue`).
- **Host change no longer locks guests out**: authorization accepted only invitations from the *current* host, so after a host handover a guest who reconnected was removed from the table. `room.hosts` records everyone who hosted; `canJoinPrivateRoom` takes a list of inviter ids.
- **Presence shows the game being played** (`playing: 'wizard'`, never the table code); debounced live push (`schedulePresence`) after create/join/sit/leave/start/rematch, game end and table close; no presence DB work in memory mode (it was logging an error per connection).
- **UI**: private lobbies no longer show Copy link / WhatsApp / Share (they are not access grants); fixed real horizontal overflow at 320px (`.page` and `.seats` grid columns were sized by their content; the table code font now scales). Friends panel checked at 320/375/414/768/1280 (no overflow, buttons >= 34px).
- **Tests**: spectators test uses public tables (private ones need an invitation); `cleanup.test.js` expects migration 008 as the newest; `private-tables.test.js` expects 401 (memory-mode players have no cookie session) and lost a duplicated tail; `private-tables.pg.test.js` friend-removal check was vacuous (an earlier refusal already satisfied it) - now compares error counts and checks the table; new host-change and presence scenarios; both private-tables suites are registered in `npm test` / `test:pg` / `build`.

### Verification state (honest)
- Run and passing in the agent sandbox: engine, twentynine, poker, themind, results, scrub, spectators, stats, matchqueue, isolation, email, cleanup, db, production, smoke, private-tables (all DB-free), `npm run build`, `git diff --check`; Playwright layout checks of the lobby/friends UI with mocked API/WebSocket.
- **NOT run (no PostgreSQL server in the sandbox): every `*.pg.test.js`**, including the new host-change and presence scenarios in `tests/private-tables.pg.test.js`. Run `npm run test:pg` against a disposable database before trusting them.
- Known gaps: removing a friend revokes invitations and blocks new joins, but does not remove someone who is already seated/watching; presence is per server instance; an unfinished mobile Wizard-header experiment is kept in `git stash` (A3 is already on main, so it is probably obsolete).

## Stage 7 (owner-requested follow-ups on this branch)

Each stage is one commit; resume from the first stage that is not marked done.

- **7.0 / 7.1 (done, commit a41cdf2)**: friend-removal and notification fixes; per-connection ping (`latency` WebSocket message, `tests/ping.test.js`); ping badge on your own profile, on a friend's profile and in the friends list (`pingBadge` in `public/app.js`).
- **7.2 (done, commit 3f3b716)**: player card - tap any seat at a table (or press Enter/Space on it) to open a card with the handle, ping and record, plus Add friend / Remove friend / profile / mute; guests and bots offer no friend actions (`openPlayerCard`).
- **7.3 (done, this commit)**: profile picture update.
  - `POST /api/me/avatar` (`lib/accountRoutes.js`): signed-in only, CSRF, rate limit `RL_ME_AVATAR_LIMIT` (60/h), body `{ avatar }` must be one of the server's fixed `AVATARS`; stored by `db/account.js` `updateAvatar`. The live table (seat, spectator list) updates through `onProfileChanged({ playerId, avatar })` in `server.js`.
  - Client: one `changeAvatar()` shared by the lobby picker and the Edit-profile dialog; signed-in players save through the API (the old picture comes back with the server's reason if it refuses), guests keep the socket-only path; the profile page header refreshes without a reload.
  - Decision for the owner: pictures are still the fixed emoji set. Uploading real photos needs image validation, size limits, storage and serving, and moderation; it is deliberately not started. Say if you want it as its own stage.
  - Tests: new case in `tests/account.pg.test.js` (validation, CSRF, 401 when signed out, DB row, own and public profile, new socket's welcome); two cases in `tests/ui/social-ui.js` (saves and updates header; refused change reverts and shows the reason).
  - Verified here: `npm run build`; `tests/ui/social-ui.js` 9/9 (Playwright, mocked API); `db/account.updateAvatar` run against a real local PostgreSQL 16 with all 8 migrations applied (bad values -> 400, unknown account -> 404, success persisted); engine, twentynine, poker, themind, results, scrub, cleanup unit suites.
  - NOT run here: `tests/account.pg.test.js` (needs the `ws` and argon2 packages, which this sandbox cannot install: the npm registry is blocked), so the new route-level case is only syntax-checked. Run `npm run test:pg` before merging.
- **7.4a (done)**: refactor with identical behavior: one `avatar(m, cls)` helper replaces five hand-written avatar spans; one `adoptPlayer()` replaces three copies of the sign-in state block (session restore, login, register). `app.js` 1824 -> 1816 lines. Checked: `node --check`, `social-ui.js` 9/9, `wizard-layout.js` all viewports ok (one earlier run reported "1 viewport(s) failed" once and was clean on the immediate re-run; not reproduced, cause not captured - watch for it).
- **7.4+ (next)**: more UX/UI refactor and polish (see "Next step").

## Remaining Stage 6 work

- **S6.2 — Friends System:** Complete any remaining friend-search/request/list/remove UX and authorization behavior without duplicating the existing backend. Audit actual shipped behavior and agree the exact scope before changes.
- **S6.3–S6.5 — Private tables:** Stage 6.1 currently stores invitation metadata and lifecycle only; it does not authorize private-room joins, hide private rooms from public discovery, provide invite UX/share links, or handle related room lifecycle/presence. Define each remaining stage from the project roadmap, then implement in order with API, WebSocket, UI, and race/security tests.
- Once scope is grounded, deliver each stage with focused and full test suites, accurate progress notes, and separate commits/pushes to this branch. Never merge to `main`; stop after Stage 6 for the requested review.

## Next step
Stage 7.4: UX/UI refactor of `public/app.js` (one ~1800-line IIFE): remove duplicated friend/avatar markup helpers, split rendering helpers into small named functions, keep behavior identical and re-run `node tests/ui/social-ui.js` and `node tests/ui/wizard-layout.js` (use `NODE_PATH=$(npm root -g)` for Playwright) after every change. Then run `npm run test:pg` against a disposable PostgreSQL before merging.
