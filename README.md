# Tableverse

> **Your friends. Your games. One table.**

Live site: **https://game-fmy4.onrender.com**

Tableverse is a browser-based multiplayer game arena for quick social sessions with no install.

## Current games

- **Wizard** (3–6): plus/minus one, hidden/secret prediction, foresight, short game.
- **29** (4): team-based trick play with secret trump and 3/6/9 match length options.
- **Poker (No-Limit Texas Hold’em)** (2–8): blinds, all-ins, side pots, showdown resolution.
- **The Mind** (2–4): co-op, real-time ascending play with lives/stars and difficulty options.

Bots can fill open seats so tables can start quickly.

## Friend-testing status (current)

Tableverse is currently open for friend testing.

- Account login is required for play actions.
- **Email verification is currently optional** in this environment.
- This is controlled by `REQUIRE_EMAIL_VERIFICATION`.
  - `REQUIRE_EMAIL_VERIFICATION=false` → immediate play allowed after signup/login.
  - `REQUIRE_EMAIL_VERIFICATION=true` → verified email required before lobby access.
  - Missing or invalid values default to secure mode (`true`).
- Optional mode does **not** fake verification: `email_verified_at` remains null until real verification.

## What exists today

- Public home page + live table directory.
- Auth sheet that resumes the action a visitor originally tapped after login.
- Account menu (Profile, Settings, What’s New, logout controls) and a profile page (`#profile`; public pages at `#u/<username>`).
- Real-time chat, spectators, reconnect/rejoin, activity log.
- Cookie-based auth (`HttpOnly` session cookie), CSRF double-submit protection, rate limits.

## What's new in v0.6 — profiles, history, account deletion

- **Profiles.** Own profile (username, display name, join date, stats, history, account tab) and a public page per username showing only username, display name, avatar, join date, games played, wins and win rate. Display names are validated server-side (2–20 characters, control characters and `<>` removed).
- **History and stats.** Paginated finished-match history (10 per page, newest first). Statistics are aggregated in SQL (no row cap); only human, finished, non-early-leave games with a match key are counted, each match once.
- **Delete Account.** Password re-authentication, then one transaction: sessions, credentials, tokens and recent tables are removed; match rows are kept with the seat renamed to `Deleted player` and `player_id` unlinked. A game still in progress shows the seat as `Deleted player` and is recorded that way when it ends.
- **One active session per account** (migration 006). Logging in on a second device signs the first one out (its socket closes with code 4002); a partial unique index makes the database enforce it.
- **Recent tables** are per account (table `player_recent_tables`, migration 005) and sync across devices. Closed tables are dropped on read. The old browser-only `ct_recent` key is removed.
- **Game logs** show who acted (shared client formatter); Poker and 29 log wording was clarified.
- **Home page** reduced to join/create, rejoin, recent and open tables.

New endpoints: `GET /api/me/profile`, `POST /api/me/display-name`, `GET /api/me/history?page=`, `GET /api/me/recent`, `POST /api/me/recent/clear`, `POST /api/me/delete-account`, `GET /api/players/:username` (public).

## Roadmap (planned, not shipped yet)

- Saboteur
- 6 nimmt! (Take 5)
- UNO

## Database & architecture

Tableverse uses PostgreSQL (Neon, Supabase, or self-hosted) for accounts, sessions, and match history.

- `DATABASE_URL` configures persistent storage.
- If `DATABASE_URL` is omitted and `NODE_ENV` is not `production`, the app uses in-memory storage.
- In production, startup is strict: missing/unreachable DB or failed migration aborts boot.
- Migrations live in `db/migrations/` and run transactionally under an advisory lock.
- `/healthz` = process liveness; `/readyz` includes database readiness.

### Auth and security notes

- Session is stored only in an HttpOnly `ct_session` cookie (`Secure` in production).
- JavaScript never receives the session token in production responses.
- CSRF uses the `ct_csrf` cookie + `X-CSRF-Token` header check on auth POST routes.
- `REQUIRE_EMAIL_VERIFICATION` controls whether verified email is required for lobby entry.
- Resend/forgot-password flows are non-enumerating and return the same outward response.

### Production email requirements

Production requires:

- `EMAIL_PROVIDER=resend`
- `EMAIL_FROM`
- `PUBLIC_APP_URL`
- `RESEND_API_KEY`

If provider delivery fails after signup, the account is still created and the response reports the delivery failure explicitly.

## Render deployment

`render.yaml` includes baseline production settings:

- `NODE_ENV=production`
- `TRUST_PROXY=1`
- `REQUIRE_EMAIL_VERIFICATION=true` (secure default)

Set `DATABASE_URL` and email variables in Render env settings before deploying.

## Development

```bash
npm start
npm test
```

## PostgreSQL tests

`tests/db.pg.test.js`, `tests/production.pg.test.js`, `tests/cleanup.pg.test.js`, `tests/account.pg.test.js` require a disposable local PostgreSQL instance:

```bash
TEST_DATABASE_URL=postgres://postgres:secret@127.0.0.1:5432/postgres npm run test:pg
```

The test helper refuses managed/production-like hosts and does not use `DATABASE_URL`.

## Data cleanup tooling

For safe user-data cleanup runbook and script details:

- `scripts/cleanup-user-data.js`
- `docs/DATA_CLEANUP.md`
