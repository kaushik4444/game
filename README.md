# Card Table

Browser-based multiplayer card and board games. Phone or desktop, no install.

- **Wizard**: 3–6 players (the host picks the seat count), variants (Plus / Minus 1, Hidden prediction, Secret prediction), Foresight, short game.
- **29**: 4 players in two teams, secret trump, 3/6/9 game-point matches.

Bots can fill any open seat.

## Run

```
npm install
npm start          # http://localhost:3000   (PORT env var to change)
npm test           # rules tests + full end-to-end game over WebSockets
```

Players open the site, one creates a table, others join with the 4-letter code or the invite link (`/#ABCD`).
To play over the internet, deploy to any Node host (Render, Railway, Fly.io…): it is one process, `npm start`, with WebSockets on the same port.

## Share it with friends

Players only need a link. Everyone opens the site, one person creates a table, and the others join with the 4-letter code or the invite link (`https://your-site/#ABCD`). The lobby has Copy link, WhatsApp and Share buttons.

For friends to reach it, the server has to be reachable from the internet:

| Option | Effort | Notes |
| --- | --- | --- |
| **Render** (free) | ~5 min | Push to GitHub, then on render.com choose New > Blueprint and pick the repo (`render.yaml` is included), or New > Web Service with build `npm install` and start `npm start`. You get an `https://….onrender.com` link. The free plan sleeps after ~15 min idle (first visit takes ~30 s) and a restart ends games in progress. |
| **Railway / Fly.io** | ~10 min | A `Dockerfile` is included. Same idea: connect the repo and deploy. Paid plans stay awake. |
| **Tonight, from your PC** | 1 min | Run `npm start`, then in another terminal `npx cloudflared tunnel --url http://localhost:3000` (or `ngrok http 3000`). Share the `https://….trycloudflare.com` link. Works while your PC is on. |
| **Same Wi-Fi** | 0 min | Open `http://<your-PC-ip>:3000` on the other devices. |

WebSockets work on all of these with no extra setup, and the client switches to `wss://` automatically on https. Run a single instance: games live in server memory.

## How it works

- `server.js`: static files, WebSocket lobby, rooms, bots, reconnection (token in the browser). State lives in memory.
- `games/<id>/`: one folder per game. `engine.js` is pure rules, `index.js` plugs it into the server. See `games/README.md`.
- `public/`: vanilla JS client. `app.js` = home/lobby, `games/<id>.js` = that game's table.

Behaviour worth knowing: a dropped player is replaced by a bot after 15 s and can rejoin by reopening the page; leaving mid-game hands the seat to a bot; empty tables are removed after 10 min; the server holds all hidden info (each player is only sent their own hand).

## Wizard rules implemented

60 cards (4 suits × 1–13, 4 Wizards, 4 Jesters). Round *n* deals *n* cards; the next card sets trump (Wizard: dealer chooses; Jester or last round: no trump). Bid exact tricks; follow suit (Wizards/Jesters always playable); first Wizard wins, else highest trump, else highest of the led suit. Score: exact = 20 + 10 per trick, otherwise −10 per trick off. Optional house rule: dealer can't make bids total the number of tricks.

# game
