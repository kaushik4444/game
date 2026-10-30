'use strict';
/**
 * Wizard — pure rules engine (no I/O, no timers).
 *
 * 60-card deck: 4 suits (R,Y,G,B) x 1..13, 4 Wizards, 4 Jesters.
 * 3-6 players, 60/n rounds. In round r every player gets r cards.
 *
 * Phases: chooseTrump -> bidding -> playing -> roundEnd -> ... -> gameOver
 */

const SUITS = ['R', 'Y', 'G', 'B'];
const SUIT_ORDER = { R: 0, Y: 1, G: 2, B: 3 };

function buildDeck() {
  const deck = [];
  for (const s of SUITS) for (let r = 1; r <= 13; r++) deck.push({ id: s + r, type: 'num', suit: s, rank: r });
  for (let i = 1; i <= 4; i++) deck.push({ id: 'W' + i, type: 'wizard', suit: null, rank: null });
  for (let i = 1; i <= 4; i++) deck.push({ id: 'J' + i, type: 'jester', suit: null, rank: null });
  return deck;
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function sortHand(hand) {
  const key = (c) => (c.type === 'wizard' ? -1 : c.type === 'jester' ? 99 : SUIT_ORDER[c.suit] * 20 + c.rank);
  return hand.sort((a, b) => key(a) - key(b) || a.id.localeCompare(b.id));
}

function cardName(c) {
  if (c.type === 'wizard') return 'Wizard';
  if (c.type === 'jester') return 'Jester';
  const names = { R: 'Red', Y: 'Yellow', G: 'Green', B: 'Blue' };
  return `${names[c.suit]} ${c.rank}`;
}

/** Suit that must be followed, or null if there is none (empty trick, wizard led, only jesters so far). */
function ledSuit(trick) {
  for (const t of trick) {
    if (t.card.type === 'wizard') return null;
    if (t.card.type === 'num') return t.card.suit;
  }
  return null;
}

/** Cards a player may legally play. Wizards and Jesters can always be played. */
function legalCards(hand, trick) {
  const s = ledSuit(trick);
  if (!s) return hand.slice();
  if (!hand.some((c) => c.type === 'num' && c.suit === s)) return hand.slice();
  return hand.filter((c) => c.type !== 'num' || c.suit === s);
}

/** Seat index of the player who wins a (complete or partial) trick. */
function trickWinner(trick, trumpSuit) {
  const w = trick.find((t) => t.card.type === 'wizard');
  if (w) return w.player; // first wizard wins
  const nums = trick.filter((t) => t.card.type === 'num');
  if (!nums.length) return trick[0].player; // all jesters: first one wins
  const trumps = trumpSuit ? nums.filter((t) => t.card.suit === trumpSuit) : [];
  const ls = ledSuit(trick);
  const pool = trumps.length ? trumps : nums.filter((t) => t.card.suit === ls);
  return pool.reduce((a, b) => (b.card.rank > a.card.rank ? b : a)).player;
}

function scoreFor(bid, tricks) {
  return bid === tricks ? 20 + 10 * tricks : -10 * Math.abs(bid - tricks);
}

const VARIANTS = ['none', 'plusminus', 'hidden', 'secret'];
const isSimul = (g) => g.options.variant === 'hidden' || g.options.variant === 'secret';
const foresightActive = (g) => g.options.foresight && g.round === 1;

function createGame(playerList, options = {}, rng = Math.random) {
  const n = playerList.length;
  if (n < 3 || n > 6) throw new Error('Wizard needs 3-6 players');
  const g = {
    rng,
    n,
    options: {
      variant: VARIANTS.includes(options.variant) ? options.variant : 'none',
      foresight: !!options.foresight,
      length: options.length === 'short' ? 'short' : 'full',
    },
    totalRounds: options.length === 'short' ? Math.min(5, 60 / n) : 60 / n,
    players: playerList.map((p) => ({ id: p.id, name: p.name, score: 0, bid: null, tricks: 0, hand: [] })),
    round: 0,
    dealer: Math.floor(rng() * n),
    phase: 'bidding',
    turn: 0,
    trumpCard: null,
    trumpSuit: null,
    trick: [],
    lastTrick: null,
    history: [],
    log: [], // public play-by-play log: [{ by, card, kind, when }]
  };
  startRound(g);
  return g;
}

function startRound(g) {
  if (g.round > 0) g.dealer = (g.dealer + 1) % g.n;
  g.round++;
  const deck = shuffle(buildDeck(), g.rng);
  for (const p of g.players) {
    p.hand = sortHand(deck.splice(0, g.round));
    p.bid = null;
    p.tricks = 0;
  }
  g.trumpCard = deck.length ? deck[0] : null; // last round: whole deck dealt, no trump
  g.trumpSuit = null;
  g.trick = [];
  g.lastTrick = null;
  g.turn = (g.dealer + 1) % g.n;
  g.phase = 'bidding';
  if (g.trumpCard && g.trumpCard.type === 'num') g.trumpSuit = g.trumpCard.suit;
  else if (g.trumpCard && g.trumpCard.type === 'wizard') {
    g.phase = 'chooseTrump';
    g.turn = g.dealer;
  } // jester or no card: no trump
}

function forbiddenBid(g) {
  if (g.options.variant !== 'plusminus' || g.phase !== 'bidding' || g.turn !== g.dealer) return null;
  const others = g.players.reduce((s, p, i) => s + (i !== g.dealer && p.bid !== null ? p.bid : 0), 0);
  const f = g.round - others;
  return f >= 0 && f <= g.round ? f : null;
}

function endRound(g) {
  const rows = g.players.map((p) => {
    const delta = scoreFor(p.bid, p.tricks);
    p.score += delta;
    return { bid: p.bid, tricks: p.tricks, delta, score: p.score };
  });
  g.history.push({ round: g.round, dealer: g.dealer, trumpSuit: g.trumpSuit, rows });
  g.phase = g.round >= g.totalRounds ? 'gameOver' : 'roundEnd';
}

const ok = () => ({ ok: true });
const fail = (error) => ({ ok: false, error });

/** playerId may be null only for the system-driven 'continue' action. */
function applyAction(g, playerId, action) {
  if (!action || typeof action.type !== 'string') return fail('Invalid action');
  const idx = playerId === null ? -1 : g.players.findIndex((p) => p.id === playerId);
  if (playerId !== null && idx < 0) return fail('You are not in this game');

  switch (action.type) {
    case 'chooseTrump': {
      if (g.phase !== 'chooseTrump') return fail('Not choosing trump now');
      if (idx !== g.dealer) return fail('Only the dealer chooses trump');
      if (!SUITS.includes(action.suit)) return fail('Invalid suit');
      g.trumpSuit = action.suit;
      g.phase = 'bidding';
      g.turn = (g.dealer + 1) % g.n;
      return ok();
    }
    case 'bid': {
      if (g.phase !== 'bidding') return fail('Not bidding now');
      const simul = isSimul(g);
      if (simul) {
        if (idx < 0 || g.players[idx].bid !== null) return fail('You have already bid');
      } else if (idx !== g.turn) return fail('Not your turn');
      const amt = action.amount;
      if (!Number.isInteger(amt) || amt < 0 || amt > g.round) return fail('Invalid bid');
      if (!simul && amt === forbiddenBid(g)) return fail(`The dealer cannot bid ${amt}`);
      g.players[idx].bid = amt;
      g.log.push({ by: g.players[idx].name, card: `bids ${amt}`, kind: 'bid' });
      if (g.players.every((p) => p.bid !== null)) {
        g.phase = 'playing';
        g.turn = (g.dealer + 1) % g.n;
      } else if (!simul) g.turn = (g.turn + 1) % g.n;
      return ok();
    }
    case 'play': {
      if (g.phase !== 'playing') return fail('Not playing now');
      if (idx !== g.turn) return fail('Not your turn');
      const p = g.players[idx];
      let ci = p.hand.findIndex((c) => c.id === action.cardId);
      if (ci < 0 && action.cardId === 'hidden' && foresightActive(g) && p.hand.length === 1) ci = 0; // foresight: you play your unseen card
      if (ci < 0) return fail('Card not in your hand');
      if (!legalCards(p.hand, g.trick).includes(p.hand[ci])) return fail('You must follow suit');
      const [card] = p.hand.splice(ci, 1);
      g.trick.push({ player: idx, card });
      g.log.push({ by: g.players[idx].name, card: cardName(card), kind: 'play' });
      if (g.trick.length === g.n) {
        const winner = trickWinner(g.trick, g.trumpSuit);
        g.players[winner].tricks++;
        g.lastTrick = { cards: g.trick, winner };
        g.trick = [];
        g.turn = winner;
        if (g.players.every((q) => q.hand.length === 0)) endRound(g);
      } else g.turn = (g.turn + 1) % g.n;
      return ok();
    }
    case 'continue': {
      if (g.phase !== 'roundEnd') return fail('Round is not over');
      startRound(g);
      return ok();
    }
    default:
      return fail('Unknown action');
  }
}

/**
 * Last trick of a round: every player holds exactly one card, so once the first card is down the rest is
 * forced. Returns { playerId, action } for the player whose turn it is, or null.
 */
function forcedPlay(g) {
  if (g.phase !== 'playing' || !g.trick.length) return null;
  const p = g.players[g.turn];
  if (!p || p.hand.length !== 1) return null;
  return { playerId: p.id, action: { type: 'play', cardId: p.hand[0].id } };
}

/** Everyone the game is waiting for (several players at once during simultaneous bidding). */
function awaitingList(g) {
  if (g.phase === 'bidding' && isSimul(g)) return g.players.filter((p) => p.bid === null).map((p) => p.id);
  const w = awaiting(g);
  return w ? [w] : [];
}

/** Player id who must act next, or null (system / nobody). */
function awaiting(g) {
  if (g.phase === 'chooseTrump') return g.players[g.dealer].id;
  if (g.phase === 'bidding' || g.phase === 'playing') return g.players[g.turn].id;
  return null;
}

/** What one player is allowed to see. Other hands are never included. */
function viewFor(g, playerId) {
  const me = g.players.findIndex((p) => p.id === playerId);
  const simul = isSimul(g);
  const myTurnToPlay = g.phase === 'playing' && me === g.turn;
  const best = Math.max(...g.players.map((p) => p.score));
  const hideOthers =
    (g.options.variant === 'hidden' && g.phase === 'bidding') ||
    (g.options.variant === 'secret' && (g.phase === 'bidding' || g.phase === 'playing' || g.phase === 'chooseTrump'));
  // Foresight (round 1): you see everybody's card except your own.
  const blind = foresightActive(g) && me >= 0 && g.players[me].hand.length === 1 && g.phase !== 'roundEnd' && g.phase !== 'gameOver';
  const real = me >= 0 ? g.players[me].hand : [];
  const hand = blind ? [{ id: 'hidden', type: 'back' }] : real;
  const legal = myTurnToPlay ? (blind ? ['hidden'] : legalCards(real, g.trick).map((c) => c.id)) : [];
  const others = foresightActive(g) && me >= 0
    ? g.players.map((p, i) => ({ player: i, card: i !== me && p.hand.length === 1 ? p.hand[0] : null })).filter((x) => x.card)
    : [];
  const bidding = g.phase === 'bidding';
  return {
    game: 'wizard',
    phase: g.phase,
    round: g.round,
    totalRounds: g.totalRounds,
    n: g.n,
    dealer: g.dealer,
    turn: g.phase === 'chooseTrump' ? g.dealer : (bidding && !simul) || g.phase === 'playing' ? g.turn : null,
    me,
    myTurn: awaitingList(g).includes(playerId),
    options: g.options,
    simultaneous: simul,
    trumpCard: g.trumpCard,
    trumpSuit: g.trumpSuit,
    trick: g.trick,
    trickLeader: g.trick.length && g.phase === 'playing' ? trickWinner(g.trick, g.trumpSuit) : null, // who is winning the trick so far
    trickNo: g.players.reduce((s, p) => s + p.tricks, 0), // tricks finished this round
    autoPlay: me >= 0 && me === g.turn && forcedPlay(g) !== null, // your last card is played for you
    lastTrick: g.lastTrick,
    hand,
    legal,
    log: g.log.slice(-60),
    foresight: others,
    forbiddenBid: bidding && !simul && me === g.turn ? forbiddenBid(g) : null,
    players: g.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      bid: hideOthers && i !== me ? null : p.bid,
      hasBid: p.bid !== null,
      tricks: p.tricks,
      cards: p.hand.length,
    })),
    history: g.history,
    winners: g.phase === 'gameOver' ? g.players.filter((p) => p.score === best).map((p) => p.id) : [],
  };
}

// ---------------------------------------------------------------- bot

function cardStrength(c, trumpSuit) {
  if (c.type === 'wizard') return 1000;
  if (c.type === 'jester') return 0;
  return c.rank + (c.suit === trumpSuit ? 100 : 0);
}

function estimateBid(g, p) {
  let s = 0;
  for (const c of p.hand) {
    if (c.type === 'wizard') s += 1;
    else if (c.type === 'num') {
      if (c.suit === g.trumpSuit) s += c.rank >= 13 ? 0.9 : c.rank >= 11 ? 0.75 : c.rank >= 9 ? 0.5 : c.rank >= 7 ? 0.35 : 0.2;
      else s += c.rank === 13 ? 0.45 : c.rank === 12 ? 0.3 : c.rank === 11 ? 0.15 : 0.04;
    }
  }
  return Math.max(0, Math.min(g.round, Math.round(s)));
}

/** Round-1 foresight: the bot sees the other cards and the trump card, but not its own. */
function foresightBid(g, idx) {
  const seen = new Set(g.players.filter((_, i) => i !== idx).map((p) => p.hand[0].id));
  if (g.trumpCard) seen.add(g.trumpCard.id);
  const unseen = buildDeck().filter((c) => !seen.has(c.id));
  const top = Math.max(...g.players.filter((_, i) => i !== idx).map((p) => cardStrength(p.hand[0], g.trumpSuit)));
  const beats = unseen.filter((c) => cardStrength(c, g.trumpSuit) > top).length;
  return beats / unseen.length >= 0.5 ? 1 : 0;
}

function botAction(g, playerId) {
  const idx = g.players.findIndex((p) => p.id === playerId);
  const p = g.players[idx];
  switch (g.phase) {
    case 'chooseTrump': {
      const counts = { R: 0, Y: 0, G: 0, B: 0 };
      for (const c of p.hand) if (c.type === 'num') counts[c.suit]++;
      const suit = SUITS.reduce((a, b) => (counts[b] > counts[a] ? b : a), SUITS[Math.floor(g.rng() * 4)]);
      return { type: 'chooseTrump', suit };
    }
    case 'bidding': {
      let amount = foresightActive(g) ? foresightBid(g, idx) : estimateBid(g, p);
      if (amount === forbiddenBid(g)) amount = amount + 1 <= g.round ? amount + 1 : amount - 1;
      return { type: 'bid', amount };
    }
    case 'playing': {
      const legal = legalCards(p.hand, g.trick);
      const needWin = p.bid > p.tricks;
      const str = (c) => cardStrength(c, g.trumpSuit);
      const byStr = (a, b) => str(a) - str(b);
      let pick;
      if (g.trick.length === 0) {
        pick = needWin ? legal.reduce((a, b) => (str(b) > str(a) ? b : a)) : legal.reduce((a, b) => (str(b) < str(a) ? b : a));
      } else {
        const wins = (c) => trickWinner(g.trick.concat({ player: idx, card: c }), g.trumpSuit) === idx;
        const winners = legal.filter(wins).sort(byStr);
        const losers = legal.filter((c) => !wins(c)).sort(byStr);
        if (needWin) pick = winners.length ? winners[0] : losers[0];
        else pick = losers.length ? losers[losers.length - 1] : winners[0];
      }
      return { type: 'play', cardId: pick.id };
    }
    default:
      return { type: 'continue' };
  }
}

module.exports = {
  SUITS,
  buildDeck,
  createGame,
  applyAction,
  awaiting,
  awaitingList,
  viewFor,
  botAction,
  forcedPlay,
  // exported for tests
  ledSuit,
  legalCards,
  trickWinner,
  scoreFor,
};
