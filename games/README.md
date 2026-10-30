# Adding a game

A game is a folder `games/<id>/` whose `index.js` exports the object below. `games/wizard` and `games/twentynine` are complete examples.

```js
module.exports = {
  id: 'hearts',
  name: 'Hearts',
  icon: '♥',                         // shown on the home screen
  accent: '#d64545',                 // tile colour
  tagline: 'One line shown on the home screen',
  seats: { min: 4, max: 4, default: 4 },   // the host can change the seat count within min..max
  seatLabel: (i, n) => 'Team A',     // optional: label per seat in the lobby (teams, colours...)
  rules: ['Paragraph one', 'Paragraph two'],   // shown in the "How to play" dialog
  options: [                          // shown in the lobby; only the host can change them. Add TIME_LIMIT_OPTION from games/common.js
    { key: 'fast', type: 'boolean', label: 'Fast game', desc: 'Explanation', default: false },
    { key: 'variant', type: 'select', label: 'Variant', default: 'a',
      choices: [{ value: 'a', label: 'Classic', desc: 'Shown under the dropdown' }, { value: 'b', label: 'Other', desc: '...' }] },
  ],

  // players: [{ id, name }] in seat order (empty seats are already filled with bots). rng: () => [0,1).
  create(players, options, rng) {
    return {
      view(playerId),          // JSON for that player only. Never include other players' hidden information.
                               // Spectators call view() with an id that is not seated: return me = -1 and no hand.
                               // Include `myTurn: boolean` so the app can buzz / flash the tab.
      act(playerId, action),   // -> { ok: true } | { ok: false, error }. Validate everything: actions come
                               // straight from the network. playerId is null for autoAction().
      awaiting(),              // array of player ids the game is waiting for (usually one; several for simultaneous moves)
      forcedPlay(),            // optional: { playerId, action } when the awaited player's move is forced (the server plays it after a short delay), else null
      stamp(),                 // optional: any object that changes whenever a trick/step completes (the server pauses briefly so clients can animate it)
      botAction(playerId),     // the action a bot would take now (also covers humans who are offline)
      autoAction(),            // action applied by the server after a pause when awaiting() is empty, or null
      isOver(),
    };
  },
};
```

Then:

1. Register it in `games/index.js`.
2. Write the table renderer `public/games/<id>.js`: call `CardTable.register('<id>', { render(root, view, ctx) {} })`
   and add a `<script>` tag in `public/index.html`. `ctx` has `act(action)`, `leave()`, `rematch()`, `rerender()`,
   `showRules()`, `isHost`, `room`, `game`, `toast()`. `public/table.css` has shared card and table styles.
3. Keep the rules in a pure `engine.js` (no sockets, no timers) and unit-test it like `tests/engine.test.js`.

## Optional pacing hooks

- `botDelayMs(playerId)`: how long (ms) that bot waits before acting. Poker and The Mind use it so people can follow.
- `autoDelayMs()`: delay before `autoAction()` fires (e.g. Poker deals an all-in runout street by street).
- `stamp()`: changes when a trick ends, so the server pauses for the collect animation.
