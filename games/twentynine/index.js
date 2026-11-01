'use strict';
const engine = require('./engine');
const { scrubDeep } = require('../scrub');
const { TIME_LIMIT_OPTION } = require('../common');

module.exports = {
  id: 'twentynine',
  name: '29',
  icon: '🂫',
  accent: '#d64545',
  tagline: 'The classic South Asian trick-taking game for two teams of two. Bid, hide your trump, and take the points.',
  seats: { min: 4, max: 4, default: 4 },
  // 'team': a win means your TEAM won. No "best score": a winning team always ends on about the same game points,
  // so a maximum would say nothing.
  stats: { kind: 'team', bestLabel: null, bestOf: null },
  seatLabel: (i) => (i % 2 === 0 ? 'Team A' : 'Team B'),
  options: [
    {
      key: 'target',
      type: 'select',
      label: 'Play until',
      default: '6',
      choices: [
        { value: '3', label: '3 game points', desc: 'A short match.' },
        { value: '6', label: '6 game points', desc: 'The usual match.' },
        { value: '9', label: '9 game points', desc: 'A long evening.' },
      ],
    },
    TIME_LIMIT_OPTION,
  ],
  rules: [
    'Four players, two teams: you and the player sitting opposite are partners. 32 cards (7 to Ace). Card order, high to low: J, 9, A, 10, K, Q, 8, 7.',
    'Card points: Jack 3, Nine 2, Ace 1, Ten 1. That is 28 points, plus 1 for winning the last trick makes 29.',
    'Everyone gets 4 cards and bids once, starting left of the dealer: a number from 15 to 28 that beats the previous bid, or pass. If everyone passes, the dealer must bid 15. A bid of 28 ends the bidding at once.',
    'The highest bidder secretly picks the trump suit (one they hold). Four more cards are then dealt to each player.',
    'Play 8 tricks and follow the lead suit if you can. If you cannot follow, you may ask to see the trump: it is then shown to everyone and you must play a trump card if you have one. Until it is shown, trump cards played as discards do not count as trump.',
    'The bidding team needs at least as many points as it bid. Make it and the team scores +1 game point, miss it and it scores −1. The first team to reach the target wins (or the other team wins if one team falls to minus the target).',
  ],

  create(players, options, rng) {
    const g = engine.createGame(players, options, rng);
    return {
      view: (playerId) => engine.viewFor(g, playerId),
      // an account was deleted: its name is rewritten everywhere in the state, including the log
      scrub: (names, to) => scrubDeep([g, players], names, to),
      act: (playerId, action) => engine.applyAction(g, playerId, action),
      awaiting: () => engine.awaiting(g),
      botAction: (playerId) => engine.botAction(g, playerId),
      forcedPlay: () => engine.forcedPlay(g),
      stamp: () => g.lastTrick, // changes whenever a trick is completed
      autoAction: () => (g.phase === 'handEnd' ? { type: 'continue' } : null),
      isOver: () => g.phase === 'gameOver',
      // teams are the even and the odd seats (seat % 2); every member of the winning team wins
      results: () => players.map((_, i) => ({ score: g.teamScore[i % 2], winner: g.winnerTeam === i % 2 })),
    };
  },
};
