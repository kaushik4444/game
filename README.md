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
- Account menu (Profile, Stats, Settings, What’s New, logout controls).
- Real-time chat, spectators, reconnect/rejoin, activity log.
- Cookie-based auth (`HttpOnly` session cookie), CSRF double-submit protection, rate limits.

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

`tests/db.pg.test.js`, `tests/production.pg.test.js`, `tests/cleanup.pg.test.js` require a disposable local PostgreSQL instance:

```bash
TEST_DATABASE_URL=postgres://postgres:secret@127.0.0.1:5432/postgres npm run test:pg
```

The test helper refuses managed/production-like hosts and does not use `DATABASE_URL`.

## Data cleanup tooling

For safe user-data cleanup runbook and script details:

- `scripts/cleanup-user-data.js`
- `docs/DATA_CLEANUP.md`
