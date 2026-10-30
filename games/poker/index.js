'use strict';
const engine = require('./engine');
const { TIME_LIMIT_OPTION } = require('../common');

module.exports = {
  id: 'poker',
  name: 'Poker',
  icon: '♠️',
  accent: '#1f6fe0',
  tagline: "Texas Hold'em with chips and blinds. Read the table, bet, bluff, and take everyone's stack.",
  seats: { min: 2, max: 8, default: 5 },
  options: [
    {
      key: 'chips',
      type: 'select',
      label: 'Starting chips',
      default: '1000',
      choices: [
        { value: '1000', label: '1,000 chips', desc: 'Blinds start at 10 / 20. Quick games.' },
        { value: '2000', label: '2,000 chips', desc: 'Blinds start at 10 / 20. More room to play.' },
        { value: '5000', label: '5,000 chips', desc: 'Blinds start at 25 / 50. Deep stacks, long game.' },
      ],
    },
    {
      key: 'blinds',
      type: 'select',
      label: 'Blinds go up',
      default: 'normal',
      choices: [
        { value: 'fixed', label: 'Never', desc: 'The blinds stay the same all game.' },
        { value: 'slow', label: 'Every 10 hands', desc: 'Slow pressure.' },
        { value: 'normal', label: 'Every 6 hands', desc: 'A normal pace.' },
        { value: 'fast', label: 'Every 3 hands', desc: 'Fast, forces action.' },
      ],
    },
    {
      key: 'limit',
      type: 'select',
      label: 'Game ends',
      default: 'last',
      choices: [
        { value: 'last', label: 'Last player standing', desc: 'Play until everyone else is out.' },
        { value: '10', label: 'After 10 hands', desc: 'The biggest stack wins.' },
        { value: '20', label: 'After 20 hands', desc: 'The biggest stack wins.' },
        { value: '30', label: 'After 30 hands', desc: 'The biggest stack wins.' },
      ],
    },
    TIME_LIMIT_OPTION,
  ],
  rules: [
    "Texas Hold'em for 2 to 8 players. Everyone starts with the same chips. Each hand you get two private cards and share five community cards that are dealt face up: three (the flop), one (the turn) and one (the river). Your hand is the best five cards out of your two and the five on the table.",
    'Before the cards are dealt the two players left of the dealer button post forced bets: the small blind and the big blind. The button moves one seat each hand. With two players, the button posts the small blind.',
    'There are four betting rounds: before the flop, on the flop, on the turn and on the river. On your turn you can fold (give up the hand), check (bet nothing, if nobody has bet), call (match the bet) or raise (bet more; a raise must be at least as large as the previous bet or raise). You can also go all-in with every chip you have.',
    'If you are all-in for less than the others bet, you can only win the part of the pot you covered: the extra chips go into a side pot that only the other players can win.',
    'If everyone else folds, the last player wins the pot without showing cards. Otherwise the best hand wins at the showdown, and equal hands split the pot.',
    'Hand ranking, best to worst: straight flush, four of a kind, full house, flush, straight, three of a kind, two pair, one pair, high card. The 4-colour deck has spades in blue-black, hearts in red, diamonds in blue and clubs in green so the suits are easy to tell apart.',
    'Players with no chips left are out. The game ends when one player has all the chips, or after the number of hands the host chose, when the biggest stack wins.',
  ],

  create(players, options, rng) {
    const g = engine.createGame(players, options, rng);
    return {
      view: (playerId) => engine.viewFor(g, playerId),
      act: (playerId, action) => engine.applyAction(g, playerId, action),
      awaiting: () => engine.awaiting(g),
      botAction: (playerId) => engine.botAction(g, playerId),
      autoAction: () => (g.phase === 'handEnd' ? { type: 'continue' } : null),
      isOver: () => g.phase === 'gameOver',
    };
  },
};
