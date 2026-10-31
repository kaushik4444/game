# Tableverse

> **Your friends. Your games. One table.**

Browser-based multiplayer card and board games. Phone or desktop, no install.

- **Wizard**: 3–6 players (the host picks the seat count), variants (Plus / Minus 1, Hidden prediction, Secret prediction), Foresight, short game.
- **29**: 4 players in two teams, secret trump, 3/6/9 game-point matches.
- **Poker (Texas Hold'em)**: 2–8 players with chips, blinds, side pots and all-ins. Options: starting chips (1,000 / 2,000 / 5,000), blinds that rise never / every 10 / 6 / 3 hands, and the game ends when one player has everything or after 10 / 20 / 30 hands.
- **The Mind**: 2–4 players, cooperative and real-time. No turns, no hints: play your numbers (1–100) in ascending order by feel. Lives, throwing stars, standard / easy / hard.

Bots can fill any open seat.

## Database & Architecture (PostgreSQL / Neon)

Tableverse uses PostgreSQL (Neon, Supabase, or self-hosted) for persistent player accounts, sessions, and match history:

- **Environment Configuration**: Set `DATABASE_URL` in your environment (e.g. `postgresql://user:pass@ep-xyz.neon.tech/neondb?sslmode=require`).
- **Zero-config Fallback (development and tests only)**: If `DATABASE_URL` is omitted and `NODE_ENV` is not `production`, Tableverse runs with an in-memory repository.
- **Production is strict**: with `NODE_ENV=production` the server **exits with an error** if `DATABASE_URL` is missing, the `pg` package is not installed, the database cannot be reached, or a migration fails. It checks the database and migrates *before* it accepts any player.
- **Health checks**: `/healthz` is liveness (the process is up). `/readyz` also checks the database (503 if it is down).
- **Migrations**: Automated version-controlled SQL migrations located in `db/migrations/`. Run manually via:
  ```bash
  npm run migrate
  ```
  They are also applied when the server boots, in one transaction under an advisory lock (two instances cannot race, and a failed migration changes nothing).
- **Anonymous Player Accounts**: Guests are automatically provisioned with permanent internal UUIDs and bearer tokens hashed with SHA-256 before storage.
- **Completed Match Archive**: Every completed game is saved once (a per-game `match_key` makes recording idempotent) to `matches` and `match_participants`, all or nothing. Each game reports per-seat `results()` (score and winner). A player who left mid-game (a bot finished their seat) is kept in the record but not counted in stats. Matches written before results existed (no `match_key`) have unknown winners and are left out of stats.
- **Reliable saving**: a finished game is saved in the background and never delays play. A transient failure (lost connection, timeout, deadlock, database restarting) is retried up to 5 times over about 35 seconds; a permanent one (bad data, missing table) is not retried. Retrying is safe because of the match key. A result that still cannot be saved is **never** reported as saved: it is logged as `NOT SAVED` with the game, table and players, the table gets a "result could not be saved" message, and `/readyz` shows the counts. Before the first attempt the result is also written to a small spool file (`MATCH_SPOOL_DIR`, default the system temp folder, `off` to disable) and removed once the database has it; on the next start leftovers are replayed. On SIGTERM (a Render deploy) the server waits up to 15 s for pending writes. Limits: on a host with an ephemeral disk the spool survives a process restart but not a redeploy onto a fresh machine, and a hard crash (SIGKILL, power loss) between the game ending and the spool write loses that one result.
- **What the stats mean**: a win is "you won": in Wizard the highest score (ties share), in 29 your **team** won, in Poker the biggest stack, in The Mind the **whole table** won (co-operative). *Best* is only shown where it is comparable: Wizard highest score; Poker the final stack as a multiple of the starting chips (a raw stack means different things after 1,000 and 5,000 chips); The Mind most levels cleared. 29 has no best score because a winning team always ends near the target.
- **Abuse limits**: per-address caps on open sockets (40) and new accounts per hour (30), a site-wide cap on new accounts per minute (120) and on players in memory (5000), and WebSocket upgrades from other websites (foreign `Origin`) are refused. Add extra allowed origins with `ALLOWED_ORIGINS`. Behind Render's proxy set `TRUST_PROXY=1` (done in `render.yaml`).
- **Account auth (Stage 1)**: the session is an HttpOnly `ct_session` cookie (`SameSite=Lax`, `Secure` in production, lifetime `AUTH_SESSION_TTL_DAYS`, default 30). Scripts never see it: the WebSocket upgrade carries the cookie itself and the server never returns the token in a response (only `NODE_ENV=test` does, for non-browser test clients). CSRF uses a server-set `ct_csrf` cookie: every POST under `/api/auth` must repeat its value in the `X-CSRF-Token` header, so another site can neither read nor set it. Logging out closes that session's open socket; log out everywhere and password resets close all of the account's sockets. `POST /api/auth/logout` revokes only the current session; `POST /api/auth/logout-all` revokes all of them. Expired sessions, used tokens and old rate-limit rows are purged on start and every 6 hours.
- **Transactional email**: production requires `EMAIL_PROVIDER=resend`, `EMAIL_FROM`, `PUBLIC_APP_URL` and `RESEND_API_KEY` (the server refuses to start without them; `render.yaml` lists them). If the provider is down after sign-up, the account is still created and the response says the email could not be sent, so the person can use "Resend verification email". Resend and forgot-password always answer the same way, whether or not the address has an account.
- **Database required**: accounts live in PostgreSQL, so without `DATABASE_URL` nobody can log in. Local development needs a database (a local PostgreSQL is enough). Players from before accounts existed (anonymous tokens) cannot sign in any more and their stats are not linked to new accounts.
- **Announcement banner**: set the `ANNOUNCEMENT` environment variable (max 200 characters, plain text) to show a dismissible 📣 notice on the home screen. Changing the text shows it again to players who dismissed the old one; unset it to remove the banner.
- **Render Deployment**:
  1. Create a Web Service connected to your repository.
  2. Set `DATABASE_URL` in the Render Environment Variables tab pointing to your Neon database (required: the deploy fails without it). `render.yaml` also sets `NODE_ENV=production` and `TRUST_PROXY=1`.
  3. Build Command: `npm install`
  4. Start Command: `npm start`
  5. Optional: set `ANNOUNCEMENT` to show a site-wide banner. `render.yaml` (service `tableverse`) declares both variables.


## What's new in v0.2

- **Table chat**: 💬 button in the lobby and in games, unread badge, history kept for the table (last 60 messages). System lines announce spectators, players leaving and time-outs.
- **Spectators**: anyone who joins with the code (or invite link) after the game has started watches instead. They never see hidden cards, cannot act, can chat, and everyone gets a toast, a chat line and a 👁 badge. After a rematch spectators take any free seat (or press *Take a seat* when the host frees one).
- **Turn time limit**: new lobby option (default 60 s; 20 s to 2 min, or **No limit** to switch auto play off). A countdown shows in the status bar. When it runs out a bot plays for that player (in simultaneous bidding everyone still to bid is covered). Disconnected players are still covered by a bot after 15 s.
- **Wizard bids vs tricks**: a strip above the table shows `Total bid 4 / 3 tricks (over by 1)` and tricks played. Hidden/secret prediction variants show how many bids are in without revealing them.
- **Trick flow**: the card currently winning the trick is marked *Leading*; the finished trick stays on the table with the 👑 *Winner*, is swept to the winner, then the winner is asked to lead (the server holds bots back for the same moment so nobody plays into a trick that is still shown).
- **Last trick auto play**: when everybody is down to one card, the first player plays and the remaining cards are played automatically (29: unless a player may still ask for the trump).
- **New card sounds**: a swish + snap + thump for a played card, a riffle for dealing and a sweep when a trick is collected.
- **Game activity log**: every table keeps a public play-by-play feed showing who bid, played, checked, folded, or used a special action. It is visible below the table on desktop and available from the 📜 Log button on smaller screens.
- **Recent tables**: the home screen remembers the last five tables on this device and offers one-click rejoin while they still exist.
- **Sessions in progress**: the home screen lists active public tables. Join a lobby with an open seat, see `Full` when all seats are occupied, or spectate it once play has begun. Empty/disconnected tables expire automatically: rooms with no connected human players are removed after 10 minutes; otherwise inactive lobbies expire after 15 minutes and inactive games after 60 minutes.
- **Private or public tables**: tables start Private by default. The host can switch a lobby between Private (invite code/link only) and Public (listed in Sessions in Progress) after inviting friends. Private tables never appear in the directory.

- **Leaving and rejoining**: when a player leaves a running game a bot keeps their seat and everyone is told. Rejoining (from *Recent tables*, an invite link or the table code) always gives the seat back, even if the home screen only offered *Spectate*, and the bot stops playing. Everyone also sees when a player joins a lobby, loses connection (after 4 s) or reconnects.
- **Rejoin badge**: if you leave (or get dropped from) a running game, the home screen shows a gold "Your game is still running" banner with a one-tap **Rejoin** button, and the table gets a *Rejoin* badge in *Recent tables*. If you were the last human at the table (for example a solo game against bots) the game is paused instead of closed, and waits up to 10 minutes for you.
- **Smaller UX changes**: the avatar picker is collapsed behind *Change* (home and lobby) so the name and table code stay on screen; the lobby's *Start game* button stays pinned to the bottom; Wizard's bid strip reads `Bids so far 2 for 3 tricks · 2/4 bid` while bidding and `Total bid 4 / 3 tricks (over by 1)` once everyone has bid.
- **Host hand-over**: if the host leaves, or drops offline, the host role passes to the next player who is still there (in a lobby, a spectator takes over an empty table). The new host gets a 👑 notice and a chat line.
- **Colours**: the Wizard card is royal purple and gold so it can no longer be confused with the blue suit, which is now a brighter blue.

> Tables are discoverable to everyone currently using Tableverse. Do not put private information in table codes, player names, chat, or game logs.

## Multiplayer lifecycle

Room state is in memory, so a server restart clears active sessions. Reconnecting with the same browser token restores a player to a live room while it remains on the server. Disconnected seats are covered by bots after the configured grace period.

**Room expiry rules:**
1. If a room has no connected human for 10 minutes it is destroyed immediately.
2. Otherwise, an inactive lobby (no player action for 15 minutes) is also destroyed.
3. An inactive game (no player action for 60 minutes) is destroyed.

Rules 2 and 3 are independent of whether humans are connected — they catch rooms that are technically alive but effectively abandoned.

## Browser verification

The automated suite verifies network behavior, but actual Android Chrome and iPhone Safari testing must be done on physical devices before a release.

## Accessibility and audio

Sound is optional and can be muted through the sound control. Core turn, card, bidding, and navigation actions remain usable without sound. The responsive layouts preserve 44px minimum control targets.

## Development

Run `npm start` to serve the arena and `npm test` to run all pure-engine, simulation, and WebSocket smoke tests.

## Tests

`npm test` covers the Wizard, 29, Poker and The Mind engines, match results and stats, the save queue (retries, spool, shutdown), and a real WebSocket server suite (rooms, permissions, bots, spectators, reconnects, rematches, time limits, abuse limits). These tests run on the **in-memory store** and can never reach a real database: every test file starts with `tests/helpers/env.js`, which sets `NODE_ENV=test`, stops `.env` files from loading and removes `DATABASE_URL`.

**PostgreSQL tests** (`tests/db.pg.test.js`, `tests/production.pg.test.js`: migrations, upgrade from the previous schema, recording, duplicates, rollback, a complete game through the server into real rows, stats, killed connections, an unreachable database, a restart with a pending result, SIGTERM) need their own server and are skipped without it:

```bash
# any local PostgreSQL where this user may CREATE DATABASE
TEST_DATABASE_URL=postgres://postgres:secret@127.0.0.1:5432/postgres npm run test:pg   # fails if the variable is missing
```

Each run creates a throw-away database (`tv_test_<random>`) and drops it afterwards. The helper refuses managed hosts (Neon, Supabase, Render, AWS ...), the same server as your `DATABASE_URL` or `.env`, and any non-local host unless `ALLOW_REMOTE_TEST_DB=1` (never the managed hosts). Tests never use `DATABASE_URL`.

Auth-focused local checks:

```bash
npm run build
npm test
TEST_DATABASE_URL=postgres://postgres:secret@127.0.0.1:5432/postgres npm run test:pg
```

Required auth env vars for deployment:

- `DATABASE_URL`
- `EMAIL_PROVIDER=resend`
- `EMAIL_FROM`
- `PUBLIC_APP_URL`
- `RESEND_API_KEY`
- optional auth tuning: `AUTH_SESSION_TTL_DAYS`, `AUTH_VERIFY_TTL_MIN`, `AUTH_RESET_TTL_MIN`, and `RL_*` auth rate-limit overrides.

Do not use production Neon credentials for local or CI tests; keep `TEST_DATABASE_URL` pointed at a disposable local/dev PostgreSQL server.

## Notes

The game registry currently exposes Wizard, 29, Poker, and The Mind. Saboteur, 6 nimmt!, and UNO are announced as roadmap games only until their full engines and clients are implemented.

## Platform improvements

The home screen includes persistent player identity and avatars, invite-link and share actions, live chat, sound controls, spectator support, and a responsive game layout. Recent tables are stored locally only; no account or server-side tracking is required.

For release verification, `npm test` runs the rules tests, 300-game Poker simulation, 400-game The Mind simulation, and WebSocket smoke coverage for lobby permissions, bot filling, spectators, reconnects, absent-player takeover, rematches, time limits, Poker, 29, and The Mind.

## Mobile verification checklist

- Test the home screen, lobby, invite link, chat, log, cards, controls, score overlays, and rematch flow in current Chrome on Android and Safari on iPhone.
- Verify portrait and landscape layouts at narrow widths; controls must remain reachable without horizontal page scrolling.
- Verify touch targets remain at least 44px and that reduced-motion/device audio settings do not prevent a game from being played.

## Accessibility

Player identity, game status, turn changes, score overlays, chat, and activity logs use semantic labels and live regions where appropriate. Sound is optional and can be muted from the sound button; game actions never depend on audio.

## Wizard scorecard (offline games with a real deck)


Open `/scorecard.html` (link on the home screen). Add 3 to 6 players, then for each round enter every player's bid, then the tricks each one won; scores are worked out automatically (exact = 20 + 10 per trick, otherwise −10 per trick off). It shows the dealer and who bids first, warns when the total bid equals the tricks (Plus / Minus 1 rule), has a Scores table with totals, lets you tap a round to correct it, undo the last round, and copy the scores. It saves on the device and works offline after the first visit. It does not need a table or an account.

## Poker

Full No-Limit Texas Hold'em: dealer button, small and big blind (heads-up rules for two players), pre-flop / flop / turn / river, check / call / bet / raise (min-raise rules, incomplete all-in raises do not reopen betting), all-in, side pots, split pots, uncalled bets returned, showdown with the best five of seven cards. A 4-colour deck keeps suits easy to tell apart. The raise bar has Min / ½ pot / ¾ pot / Pot / All-in shortcuts and a slider. Bots bluff, fold, call and raise. Chat, spectators, reactions and the turn time limit work as in the other games (when time runs out a bot plays for you). `npm test` simulates 300 bot-only games and checks chips are conserved.

## The Mind

Cooperative and real-time. Level N deals N cards to each player; together you must play every card in ascending order without talking. Press *Play* (or Space on a keyboard) to put down your lowest card. Playing while someone holds a lower card costs a life and reveals and discards the lower cards. Throwing stars (everyone agrees) discard everybody's lowest card. 2 / 3 / 4 players play 12 / 10 / 8 levels with 2 / 3 / 4 lives; clearing certain levels earns a life or a star. Bots play on a rhythm that depends on how far their number is from the pile, so the table feels alive. There is no turn time limit in this game. Options: difficulty (standard / easy / hard) and throwing stars on or off. The server lets a game time its bots itself (`botDelayMs`) which is what makes this possible.

## Roadmap (next phase)

- Saboteur
- 6 nimmt! (Take 5)
- UNO