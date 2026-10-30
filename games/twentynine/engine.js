'use strict';
/**
 * 29 (Twenty-Nine) — pure rules engine.
 *
 * 4 players in 2 teams (seats 0+2 vs 1+3), 32 cards (7..A in 4 suits).
 * Card order high->low: J, 9, A, 10, K, Q, 8, 7.  Points: J=3, 9=2, A=1, 10=1 (28 in total, +1 for the last trick = 29).
 * Each hand: deal 4 cards, bid (15-28), the bidder secretly picks trump, deal 4 more, play 8 tricks.
 * The trump suit stays hidden until someone who cannot follow suit asks for it to be shown.
 */

const SUITS = ['S', 'H', 'D', 'C']; // spades, hearts, diamonds, clubs
const RANKS = ['7', '8', 'Q', 'K', '10', 'A', '9', 'J']; // low -> high
const POINTS = { J: 3, 9: 2, A: 1, 10: 1, K: 0, Q: 0, 8: 0, 7: 0 };
const MIN_BID = 15;
const MAX_BID = 28;

function buildDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ id: s + r, suit: s, rank: r, pts: POINTS[r], ord: RANKS.indexOf(r) });
  return d;
}
function shuffle(a, rng) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const sortHand = (h) => h.sort((a, b) => SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit) || b.ord - a.ord);
const team = (seat) => seat % 2;

function ledSuit(trick) {
  return trick.length ? trick[0].card.suit : null;
}

/**
 * Winner (seat) of a trick. Entries carry `trump: true` when the card was played after the trump was
 * revealed and is of the trump suit; trump cards played earlier were just discards.
 */
function trickWinner(trick) {
  const led = ledSuit(trick);
  const cutters = trick.filter((t) => t.trump && t.card.suit !== led);
  const pool = cutters.length ? cutters : trick.filter((t) => t.card.suit === led);
  return pool.reduce((a, b) => (b.card.ord > a.card.ord ? b : a)).player;
}

function createGame(playerList, options = {}, rng = Math.random) {
  if (playerList.length !== 4) throw new Error('29 needs exactly 4 players');
  const target = [3, 6, 9].includes(Number(options.target)) ? Number(options.target) : 6;
  const g = {
    rng,
    n: 4,
    options: { target },
    players: playerList.map((p) => ({ id: p.id, name: p.name, hand: [] })),
    dealer: Math.floor(rng() * 4),
    handNo: 0,
    teamScore: [0, 0],
    history: [],
    phase: 'bidding',
    log: [],
  };
  startHand(g);
  return g;
}

function startHand(g) {
  if (g.handNo > 0) g.dealer = (g.dealer + 1) % 4;
  g.handNo++;
  const deck = shuffle(buildDeck(), g.rng);
  for (const p of g.players) p.hand = sortHand(deck.splice(0, 4));
  g.stock = deck; // 16 cards, dealt after trump is chosen
  g.phase = 'bidding';
  g.turn = (g.dealer + 1) % 4;
  g.bids = [null, null, null, null]; // null = not yet, 'pass', or a number
  g.highBid = 0;
  g.highBidder = -1;
  g.trumpSuit = null;
  g.trumpRevealed = false;
  g.revealer = -1;
  g.trick = [];
  g.lastTrick = null;
  g.tricksPlayed = 0;
  g.handPoints = [0, 0];
}

function minBid(g) {
  return Math.max(MIN_BID, g.highBid + 1);
}
function canPass(g) {
  // the dealer bids last; if everyone before passed, the dealer has to bid
  return !(g.turn === g.dealer && g.highBidder < 0);
}

function legalCards(g, seat) {
  const hand = g.players[seat].hand;
  if (!g.trick.length) return hand.slice();
  const led = ledSuit(g.trick);
  const follow = hand.filter((c) => c.suit === led);
  if (follow.length) return follow;
  // cannot follow: after asking for the trump to be shown you must play trump if you have it
  if (g.revealer === seat) {
    const trumps = hand.filter((c) => c.suit === g.trumpSuit);
    if (trumps.length) return trumps;
  }
  return hand.slice();
}

function canReveal(g, seat) {
  if (g.phase !== 'playing' || g.trumpRevealed || seat !== g.turn || !g.trick.length || g.revealer === seat) return false;
  const led = ledSuit(g.trick);
  return !g.players[seat].hand.some((c) => c.suit === led);
}

/**
 * Last trick of a hand: everybody holds one card. After the first card is down the rest play automatically,
 * except a player who may still ask for the trump to be shown (that choice can change the winner).
 */
function forcedPlay(g) {
  if (g.phase !== 'playing' || !g.trick.length) return null;
  const p = g.players[g.turn];
  if (!p || p.hand.length !== 1 || canReveal(g, g.turn)) return null;
  return { playerId: p.id, action: { type: 'play', cardId: p.hand[0].id } };
}

const ok = () => ({ ok: true });
const fail = (error) => ({ ok: false, error });

function finishHand(g) {
  const bidderTeam = team(g.highBidder);
  const pts = g.handPoints.slice();
  const made = pts[bidderTeam] >= g.highBid;
  g.teamScore[bidderTeam] += made ? 1 : -1;
  g.history.push({ hand: g.handNo, dealer: g.dealer, bidder: g.highBidder, bid: g.highBid, trumpSuit: g.trumpSuit, points: pts, made, score: g.teamScore.slice() });
  const [a, b] = g.teamScore;
  const t = g.options.target;
  if (a >= t || b <= -t) g.winnerTeam = 0;
  else if (b >= t || a <= -t) g.winnerTeam = 1;
  g.phase = g.winnerTeam === undefined ? 'handEnd' : 'gameOver';
}

function applyAction(g, playerId, action) {
  if (!action || typeof action.type !== 'string') return fail('Invalid action');
  const seat = playerId === null ? -1 : g.players.findIndex((p) => p.id === playerId);
  if (playerId !== null && seat < 0) return fail('You are not in this game');

  switch (action.type) {
    case 'bid': {
      if (g.phase !== 'bidding') return fail('Not bidding now');
      if (seat !== g.turn) return fail('Not your turn');
      if (action.pass === true) {
        if (!canPass(g)) return fail('Everyone passed, so you must bid');
        g.bids[seat] = 'pass';
        g.log.push({ by: g.players[seat].name, card: 'passes', kind: 'bid' });
      } else {
        const amt = action.amount;
        if (!Number.isInteger(amt) || amt < minBid(g) || amt > MAX_BID) return fail(`Bid between ${minBid(g)} and ${MAX_BID}`);
        g.bids[seat] = amt;
        g.highBid = amt;
        g.highBidder = seat;
        g.log.push({ by: g.players[seat].name, card: `bids ${amt}`, kind: 'bid' });
      }
      if (g.highBid === MAX_BID || g.bids.every((b) => b !== null)) {
        g.phase = 'chooseTrump';
        g.turn = g.highBidder;
      } else g.turn = (g.turn + 1) % 4;
      return ok();
    }
    case 'chooseTrump': {
      if (g.phase !== 'chooseTrump') return fail('Not choosing trump now');
      if (seat !== g.highBidder) return fail('Only the bidder chooses trump');
      if (!SUITS.includes(action.suit)) return fail('Invalid suit');
      if (!g.players[seat].hand.some((c) => c.suit === action.suit)) return fail('Choose a suit you hold');
      g.trumpSuit = action.suit;
      for (const p of g.players) p.hand = sortHand(p.hand.concat(g.stock.splice(0, 4)));
      g.phase = 'playing';
      g.turn = (g.dealer + 1) % 4;
      return ok();
    }
    case 'reveal': {
      if (!canReveal(g, seat)) return fail('You cannot ask for the trump now');
      g.trumpRevealed = true;
      g.revealer = seat;
      return ok();
    }
    case 'play': {
      if (g.phase !== 'playing') return fail('Not playing now');
      if (seat !== g.turn) return fail('Not your turn');
      const hand = g.players[seat].hand;
      const ci = hand.findIndex((c) => c.id === action.cardId);
      if (ci < 0) return fail('Card not in your hand');
      if (!legalCards(g, seat).includes(hand[ci])) return fail(g.revealer === seat ? 'You must play a trump card' : 'You must follow suit');
      const [card] = hand.splice(ci, 1);
      g.trick.push({ player: seat, card, trump: g.trumpRevealed && card.suit === g.trumpSuit });
      g.log.push({ by: g.players[seat].name, card: card.suit + card.rank, kind: 'play' });
      g.revealer = -1;
      if (g.trick.length < 4) {
        g.turn = (g.turn + 1) % 4;
        return ok();
      }
      const winner = trickWinner(g.trick);
      g.tricksPlayed++;
      let pts = g.trick.reduce((s, t) => s + t.card.pts, 0);
      if (g.tricksPlayed === 8) pts += 1; // last trick bonus
      g.handPoints[team(winner)] += pts;
      g.lastTrick = { cards: g.trick, winner, points: pts };
      g.trick = [];
      g.turn = winner;
      if (g.tricksPlayed === 8) finishHand(g);
      return ok();
    }
    case 'continue': {
      if (g.phase !== 'handEnd') return fail('The hand is not over');
      startHand(g);
      return ok();
    }
    default:
      return fail('Unknown action');
  }
}

function awaiting(g) {
  return g.phase === 'bidding' || g.phase === 'chooseTrump' || g.phase === 'playing' ? [g.players[g.turn].id] : [];
}

function viewFor(g, playerId) {
  const me = g.players.findIndex((p) => p.id === playerId);
  const myTurn = awaiting(g).includes(playerId);
  const knowsTrump = g.trumpRevealed || (me >= 0 && me === g.highBidder && g.trumpSuit !== null) || g.phase === 'gameOver' || g.phase === 'handEnd';
  return {
    game: 'twentynine',
    phase: g.phase,
    handNo: g.handNo,
    dealer: g.dealer,
    turn: g.phase === 'handEnd' || g.phase === 'gameOver' ? null : g.turn,
    me,
    myTurn,
    options: g.options,
    players: g.players.map((p) => ({ id: p.id, name: p.name, cards: p.hand.length })),
    hand: me >= 0 ? g.players[me].hand : [],
    legal: g.phase === 'playing' && me === g.turn ? legalCards(g, me).map((c) => c.id) : [],
    canReveal: me >= 0 && canReveal(g, me),
    mustTrump: g.revealer === me && me >= 0,
    bids: g.bids,
    highBid: g.highBid,
    highBidder: g.highBidder,
    minBid: g.phase === 'bidding' ? minBid(g) : null,
    maxBid: MAX_BID,
    canPass: g.phase === 'bidding' && me === g.turn ? canPass(g) : false,
    trumpSet: g.trumpSuit !== null,
    trumpSuit: knowsTrump ? g.trumpSuit : null,
    trumpRevealed: g.trumpRevealed,
    trick: g.trick,
    trickLeader: g.trick.length && g.phase === 'playing' ? trickWinner(g.trick) : null, // who is winning the trick so far (public info only)
    trickNo: g.tricksPlayed,
    autoPlay: me >= 0 && me === g.turn && forcedPlay(g) !== null,
    lastTrick: g.lastTrick,
    tricksPlayed: g.tricksPlayed,
    handPoints: g.handPoints,
    teamScore: g.teamScore,
    history: g.history,
    log: g.log.slice(-60),
    winnerTeam: g.winnerTeam === undefined ? null : g.winnerTeam,
  };
}

// ---------------------------------------------------------------- bot

function handStrength(hand) {
  let v = hand.reduce((s, c) => s + c.pts, 0);
  const bySuit = {};
  for (const c of hand) (bySuit[c.suit] = bySuit[c.suit] || []).push(c);
  for (const cs of Object.values(bySuit)) {
    if (cs.length >= 3) v += 1;
    if (cs.some((c) => c.rank === 'J') && cs.some((c) => c.rank === '9')) v += 2;
    if (cs.some((c) => c.rank === 'J') && cs.length >= 2) v += 1;
  }
  return v;
}

function bestTrump(hand) {
  const score = (suit) => {
    const cs = hand.filter((c) => c.suit === suit);
    return cs.length * 3 + cs.reduce((s, c) => s + c.pts, 0) + (cs.some((c) => c.rank === 'J') ? 3 : 0);
  };
  const owned = SUITS.filter((s) => hand.some((c) => c.suit === s));
  return owned.reduce((a, b) => (score(b) > score(a) ? b : a));
}

function botAction(g, playerId) {
  const seat = g.players.findIndex((p) => p.id === playerId);
  const hand = g.players[seat].hand;
  if (g.phase === 'bidding') {
    const want = 14 + handStrength(hand);
    const min = minBid(g);
    if (want >= min) return { type: 'bid', amount: Math.min(want, Math.max(min, Math.min(MAX_BID, 20))) };
    if (!canPass(g)) return { type: 'bid', amount: MIN_BID };
    return { type: 'bid', pass: true };
  }
  if (g.phase === 'chooseTrump') return { type: 'chooseTrump', suit: bestTrump(hand) };
  if (g.phase === 'handEnd') return { type: 'continue' };

  // playing
  const iKnowTrump = g.trumpRevealed || seat === g.highBidder;
  const trump = iKnowTrump ? g.trumpSuit : null;
  const legal = legalCards(g, seat);
  const partner = (seat + 2) % 4;
  const lowest = (cs) => cs.reduce((a, b) => (b.pts < a.pts || (b.pts === a.pts && b.ord < a.ord) ? b : a));
  const value = (c) => c.pts * 10 + c.ord;

  if (!g.trick.length) {
    const nonTrump = legal.filter((c) => c.suit !== trump);
    const pool = nonTrump.length ? nonTrump : legal;
    return { type: 'play', cardId: pool.reduce((a, b) => (value(b) > value(a) ? b : a)).id };
  }
  const winning = trickWinner(g.trick);
  const partnerWinning = winning === partner;
  if (canReveal(g, seat)) {
    const holdsTrump = seat === g.highBidder && hand.some((c) => c.suit === g.trumpSuit);
    const trickPts = g.trick.reduce((s, t) => s + t.card.pts, 0);
    if (!partnerWinning && (holdsTrump || seat !== g.highBidder) && (trickPts > 0 || g.tricksPlayed >= 5 || seat !== g.highBidder)) return { type: 'reveal' };
  }
  const beats = (c) => {
    const probe = g.trick.concat({ player: seat, card: c, trump: g.trumpRevealed && c.suit === g.trumpSuit });
    return trickWinner(probe) === seat;
  };
  const winners = legal.filter(beats);
  let pick;
  if (partnerWinning) pick = legal.reduce((a, b) => (b.pts > a.pts || (b.pts === a.pts && b.ord > a.ord) ? b : a)); // feed points to partner
  else if (winners.length) pick = winners.reduce((a, b) => (b.ord < a.ord ? b : a));
  else pick = lowest(legal);
  return { type: 'play', cardId: pick.id };
}

module.exports = { forcedPlay, SUITS, RANKS, buildDeck, createGame, applyAction, awaiting, viewFor, botAction, trickWinner, legalCards, canReveal, MIN_BID, MAX_BID };
