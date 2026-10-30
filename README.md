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
- **Zero-config Fallback**: If `DATABASE_URL` is omitted, Tableverse automatically runs with an in-memory repository for local development and offline test execution.
- **Migrations**: Automated version-controlled SQL migrations located in `db/migrations/`. Run manually via:
  ```bash
  npm run migrate
  ```
  Or automatically applied when the server boots.
- **Anonymous Player Accounts**: Guests are automatically provisioned with permanent internal UUIDs and bearer tokens hashed with SHA-256 before storage.
- **Completed Match Archive**: Every completed game is saved to the `matches` and `match_participants` tables with player scores and winner tracking.
- **Announcement banner**: set the `ANNOUNCEMENT` environment variable (max 200 characters, plain text) to show a dismissible 📣 notice on the home screen. Changing the text shows it again to players who dismissed the old one; unset it to remove the banner.
- **Render Deployment**:
  1. Create a Web Service connected to your repository.
  2. Set `DATABASE_URL` in the Render Environment Variables tab pointing to your Neon database.
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

`npm test` covers Wizard, 29, Poker, and The Mind engines plus a real WebSocket server suite that checks room creation, permission boundaries, bot filling, spectator privacy, reconnects, bot takeover, rematches, and time limits.

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