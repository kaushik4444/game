'use strict';
/**
 * Wizard plugin: adapts the pure engine to the server's game interface.
 * See games/README.md for the interface every game implements.
 */
const engine = require('./engine');
const { TIME_LIMIT_OPTION } = require('../common');

module.exports = {
  id: 'wizard',
  name: 'Wizard',
  icon: '🧙',
  accent: '#7b4bd0',
  tagline: 'Predict exactly how many tricks you will win. Trump, wizards and jesters make it wild.',
  seats: { min: 3, max: 6, default: 4 },
  options: [
    {
      key: 'variant',
      type: 'select',
      label: 'Variant',
      default: 'none',
      choices: [
        { value: 'none', label: 'None', desc: 'Standard bidding, one player after another.' },
        { value: 'plusminus', label: 'Plus / Minus 1', desc: 'The total of all bids may not equal the number of tricks, so somebody always has to miss. The dealer bids last and may not make the total match.' },
        { value: 'hidden', label: 'Hidden prediction', desc: 'Everyone bids at the same time. Bids are revealed together just before the round starts.' },
        { value: 'secret', label: 'Secret prediction', desc: 'Everyone bids at the same time. Bids stay hidden until the end of the round.' },
      ],
    },
    {
      key: 'foresight',
      type: 'boolean',
      label: 'Foresight',
      desc: 'In round 1, when each player has only one card, you cannot see your own card. You see everyone else’s instead, and bid from that.',
      default: false,
    },
    {
      key: 'length',
      type: 'select',
      label: 'Game length',
      default: 'full',
      choices: [
        { value: 'full', label: 'Full game', desc: 'The whole deck is dealt out by the last round: 20 rounds with 3 players, 15 with 4, 12 with 5, 10 with 6.' },
        { value: 'short', label: 'Short (5 rounds)', desc: 'Only the first 5 rounds. Good for a quick game.' },
      ],
    },
    TIME_LIMIT_OPTION,
  ],
  rules: [
    'The deck has 60 cards: four suits (1–13), four Wizards and four Jesters. Round 1 deals one card each, round 2 two cards, and so on.',
    'The next card in the deck sets the trump suit. If it is a Wizard the dealer picks the trump suit; if it is a Jester (or no card is left) there is no trump.',
    'Each player predicts how many tricks they will win. Then you play tricks: follow the lead suit if you can. Wizards and Jesters can always be played.',
    'A trick is won by the first Wizard, otherwise the highest trump, otherwise the highest card of the lead suit. Jesters lose to everything; a Wizard led means there is no suit to follow, and a Jester led lets the next number card set the suit.',
    'Score: predict exactly right and you get 20 points plus 10 per trick. Miss, and you lose 10 points for each trick you are off.',
  ],

  create(players, options, rng) {
    const g = engine.createGame(players, options, rng);
    return {
      view: (playerId) => engine.viewFor(g, playerId),
      act: (playerId, action) => engine.applyAction(g, playerId, action),
      awaiting: () => engine.awaitingList(g),
      botAction: (playerId) => engine.botAction(g, playerId),
      // Action the server applies on its own after a pause when nobody has to act (between rounds).
      forcedPlay: () => engine.forcedPlay(g),
      stamp: () => g.lastTrick, // changes whenever a trick is completed
      autoAction: () => (g.phase === 'roundEnd' ? { type: 'continue' } : null),
      isOver: () => g.phase === 'gameOver',
      // final result per seat, in seat order: used for match history and stats
      results: () => {
        const best = Math.max(...g.players.map((p) => p.score));
        return g.players.map((p) => ({ score: p.score, winner: p.score === best }));
      },
    };
  },
};
