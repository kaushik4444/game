'use strict';
/**
 * The Mind plugin: adapts the pure engine to the server's game interface. Real-time: there is no turn clock
 * (so no time-limit option) and bots play on a rhythm, timed by botDelayMs().
 */
const engine = require('./engine');

module.exports = {
  id: 'themind',
  name: 'The Mind',
  icon: '🧠',
  accent: '#4f6bff',
  tagline: 'No turns, no talking. Play your numbers in ascending order by feel alone.',
  seats: { min: 2, max: 4, default: 3 },
  options: [
    {
      key: 'lives',
      type: 'select',
      label: 'Difficulty',
      default: 'standard',
      choices: [
        { value: 'standard', label: 'Standard', desc: '2 players: 2 lives, 3 players: 3 lives, 4 players: 4 lives. You start with 1 throwing star.' },
        { value: 'easy', label: 'Easy', desc: 'One extra life and you start with 2 throwing stars.' },
        { value: 'hard', label: 'Hard', desc: 'One life fewer than standard and no throwing star to begin with.' },
      ],
    },
    {
      key: 'pace',
      type: 'select',
      label: 'Bot pace',
      default: 'relaxed',
      choices: [
        { value: 'relaxed', label: 'Relaxed', desc: 'Bots take their time so you can follow who plays what.' },
        { value: 'normal', label: 'Normal', desc: 'A steady rhythm.' },
        { value: 'fast', label: 'Fast', desc: 'Bots play quickly.' },
      ],
    },
    {
      key: 'shurikens',
      type: 'boolean',
      label: 'Throwing stars',
      desc: 'Lets the team agree to discard everyone’s lowest card at once. Turn off for a purer game.',
      default: true,
    },
  ],
  rules: [
    'Everyone shares one deck of numbers from 1 to 100. In level 1 each player gets 1 card, in level 2 two cards, and so on. Together you must play every card onto one pile in ascending order.',
    'There are no turns and you may not speak or signal about your cards (the table chat is for before and after levels, not for hinting). Each player plays when they feel it is the right moment for their lowest card: wait longer when your number is high, go sooner when it is low. Press “Play lowest card” (or tap your lowest card) to put it down.',
    'If someone plays a card while another player still holds a lower one, the team loses a life. Every lower card still in anybody’s hand is revealed and discarded, and play carries on.',
    'Throwing star: any player can propose one. When everyone who still holds cards agrees (bots agree on their own), every player discards their lowest card face up. No life is lost.',
    'Team size decides the length: 2 players play 12 levels (start with 2 lives), 3 players 10 levels (3 lives), 4 players 8 levels (4 lives). You start with 1 star. Clearing level 2, 5 or 8 earns a star; clearing level 3, 6 or 9 earns a life (at most 5 lives and 3 stars).',
    'Clear the last level to win together. If your lives run out, the team loses.',
  ],

  create(players, options, rng) {
    const g = engine.createGame(players, options, rng);
    const k = { relaxed: 1.6, normal: 1, fast: 0.7 }[options && options.pace] || 1.6; // pace multiplier
    const rate = {}; // each bot has its own sense of rhythm, in ms per number of gap
    const jit = {}; // cached timing so botDelayMs is stable between re-plans of the same situation
    const r = () => rng();
    players.forEach((p) => { rate[p.id] = (300 + r() * 180) * k; });
    const delayFor = (id) => {
      const idx = g.players.findIndex((p) => p.id === id);
      if (idx < 0) return 1000;
      const c = jit[id];
      if (c && c.v === g.version) return c.d;
      let d;
      if (g.phase === 'ready' || g.phase === 'levelEnd') d = (700 + r() * 900) * k;
      else if (g.starPaused) d = (700 + r() * 1200) * k;
      else if (g.votes.size && g.stars > 0 && !g.votes.has(idx)) d = (600 + r() * 900) * k;
      else {
        const hand = g.hands[idx];
        const gap = hand.length ? Math.max(0, hand[0] - engine.tableTop(g)) : 0;
        let t = gap * rate[id] * (0.86 + r() * 0.28); // slightly early or late
        if (r() < 0.04) t *= 1.3; // occasional hesitation
        d = Math.min(25000, Math.max((900 + gap * 25) * k, t));
        d += r() * 250;
      }
      jit[id] = { v: g.version, d };
      return d;
    };
    return {
      view: (playerId) => engine.viewFor(g, playerId),
      act: (playerId, action) => {
        try { return engine.applyAction(g, playerId, action); } catch (e) { return { ok: false, error: 'Invalid action' }; }
      },
      awaiting: () => engine.awaitingList(g),
      botAction: (playerId) => engine.botAction(g, playerId),
      botDelayMs: (playerId) => delayFor(playerId),
      autoAction: () => null,
      isOver: () => g.phase === 'gameOver',
    };
  },
};
