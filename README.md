# Card Table

Browser-based multiplayer card and board games. Phone or desktop, no install.

- **Wizard**: 3–6 players (the host picks the seat count), variants (Plus / Minus 1, Hidden prediction, Secret prediction), Foresight, short game.
- **29**: 4 players in two teams, secret trump, 3/6/9 game-point matches.
- **Poker (Texas Hold'em)**: 2–8 players with chips, blinds, side pots and all-ins. Options: starting chips (1,000 / 2,000 / 5,000), blinds that rise never / every 10 / 6 / 3 hands, and the game ends when one player has everything or after 10 / 20 / 30 hands.
- **The Mind**: 2–4 players, cooperative and real-time. No turns, no hints: play your numbers (1–100) in ascending order by feel. Lives, throwing stars, standard / easy / hard.

Bots can fill any open seat.

## What's new in v0.2

- **Table chat**: 💬 button in the lobby and in games, unread badge, history kept for the table (last 60 messages). System lines announce spectators, players leaving and time-outs.
- **Spectators**: anyone who joins with the code (or invite link) after the game has started watches instead. They never see hidden cards, cannot act, can chat, and everyone gets a toast, a chat line and a 👁 badge. After a rematch spectators take any free seat (or press *Take a seat* when the host frees one).
- **Turn time limit**: new lobby option (default 60 s; 20 s to 2 min, or **No limit** to switch auto play off). A countdown shows in the status bar. When it runs out a bot plays for that player (in simultaneous bidding everyone still to bid is covered). Disconnected players are still covered by a bot after 15 s.
- **Wizard bids vs tricks**: a strip above the table shows `Total bid 4 / 3 tricks (over by 1)` and tricks played. Hidden/secret prediction variants show how many bids are in without revealing them.
- **Trick flow**: the card currently winning the trick is marked *Leading*; the finished trick stays on the table with the 👑 *Winner*, is swept to the winner, then the winner is asked to lead (the server holds bots back for the same moment so nobody plays into a trick that is still shown).
- **Last trick auto play**: when everybody is down to one card, the first player plays and the remaining cards are played automatically (29: unless a player may still ask for the trump).
- **New card sounds**: a swish + snap + thump for a played card, a riffle for dealing and a sweep when a trick is collected.

## Wizard scorecard (offline games with a real deck)

Open `/scorecard.html` (link on the home screen). Add 3 to 6 players, then for each round enter every player's bid, then the tricks each one won; scores are worked out automatically (exact = 20 + 10 per trick, otherwise −10 per trick off). It shows the dealer and who bids first, warns when the total bid equals the tricks (Plus / Minus 1 rule), has a Scores table with totals, lets you tap a round to correct it, undo the last round, and copy the scores. It saves on the device and works offline after the first visit. It does not need a table or an account.

## Poker

Full No-Limit Texas Hold'em: dealer button, small and big blind (heads-up rules for two players), pre-flop / flop / turn / river, check / call / bet / raise (min-raise rules, incomplete all-in raises do not reopen betting), all-in, side pots, split pots, uncalled bets returned, showdown with the best five of seven cards. A 4-colour deck keeps suits easy to tell apart. The raise bar has Min / ½ pot / ¾ pot / Pot / All-in shortcuts and a slider. Bots bluff, fold, call and raise. Chat, spectators, reactions and the turn time limit work as in the other games (when time runs out a bot plays for you). `npm test` simulates 300 bot-only games and checks chips are conserved.

## The Mind

Cooperative and real-time. Level N deals N cards to each player; together you must play every card in ascending order without talking. Press *Play* (or Space on a keyboard) to put down your lowest card. Playing while someone holds a lower card costs a life and reveals and discards the lower cards. Throwing stars (everyone agrees) discard everybody's lowest card. 2 / 3 / 4 players play 12 / 10 / 8 levels with 2 / 3 / 4 lives; clearing certain levels earns a life or a star. Bots play on a rhythm that depends on how far their number is from the pile, so the table feels alive. There is no turn time limit in this game. Options: difficulty (standard / easy / hard) and throwing stars on or off. The server lets a game time its bots itself (`botDelayMs`) which is what makes this possible.

## Roadmap (next phase)

Saboteur.