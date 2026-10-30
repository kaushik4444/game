'use strict';
/**
 * Texas Hold'em, pure rules (no sockets, no timers). 2-8 players, chips, blinds that can rise, side pots.
 * Actions: {type:'fold'} {type:'check'} {type:'call'} {type:'raise', to} {type:'allin'} {type:'continue'}
 * `to` is the player's TOTAL bet in the current betting round (so a bet and a raise are the same action).
 */
const RANK_CHARS = '23456789TJQKA';
const SUITS = ['S', 'H', 'D', 'C'];
const RANK_NAMES = { 2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven', 8: 'Eight', 9: 'Nine', 10: 'Ten', 11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace' };
const RANK_PLURAL = { 2: 'Twos', 3: 'Threes', 4: 'Fours', 5: 'Fives', 6: 'Sixes', 7: 'Sevens', 8: 'Eights', 9: 'Nines', 10: 'Tens', 11: 'Jacks', 12: 'Queens', 13: 'Kings', 14: 'Aces' };
const LEVELS = [[10, 20], [15, 30], [25, 50], [50, 100], [75, 150], [100, 200], [150, 300], [200, 400], [300, 600], [500, 1000], [1000, 2000], [2000, 4000]];
const START_LEVEL = { 1000: 0, 2000: 0, 5000: 2 };
const HANDS_PER_LEVEL = { fixed: 0, slow: 10, normal: 6, fast: 3 };
const CATEGORY = ['High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush'];

function buildDeck() {
  const d = [];
  for (let r = 2; r <= 14; r++) for (const s of SUITS) d.push({ id: RANK_CHARS[r - 2] + s, rank: r, suit: s });
  return d;
}

function shuffle(a, rng) {
  const d = a.slice();
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

// ------------------------------------------------------------------ hand evaluation
const cmp = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
};

/** Score of exactly five cards: an array that compares lexicographically (higher is better). */
function eval5(cards) {
  const ranks = cards.map((c) => c.rank).sort((a, b) => b - a);
  const flush = cards.every((c) => c.suit === cards[0].suit);
  const uniq = [...new Set(ranks)];
  let straightHigh = 0;
  if (uniq.length === 5) {
    if (ranks[0] - ranks[4] === 4) straightHigh = ranks[0];
    else if (ranks[0] === 14 && ranks[1] === 5 && ranks[4] === 2) straightHigh = 5; // the wheel
  }
  const counts = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
  // groups ordered by count, then rank
  const groups = Object.keys(counts).map((r) => ({ r: Number(r), n: counts[r] })).sort((a, b) => b.n - a.n || b.r - a.r);
  if (straightHigh && flush) return [8, straightHigh];
  if (groups[0].n === 4) return [7, groups[0].r, groups[1].r];
  if (groups[0].n === 3 && groups[1].n === 2) return [6, groups[0].r, groups[1].r];
  if (flush) return [5, ...ranks];
  if (straightHigh) return [4, straightHigh];
  if (groups[0].n === 3) return [3, groups[0].r, groups[1].r, groups[2].r];
  if (groups[0].n === 2 && groups[1].n === 2) return [2, groups[0].r, groups[1].r, groups[2].r];
  if (groups[0].n === 2) return [1, groups[0].r, groups[1].r, groups[2].r, groups[3].r];
  return [0, ...ranks];
}

const COMBOS = {};
function combos(n, k) {
  const key = n + ',' + k;
  if (COMBOS[key]) return COMBOS[key];
  const out = [];
  const rec = (start, cur) => {
    if (cur.length === k) return out.push(cur.slice());
    for (let i = start; i < n; i++) {
      cur.push(i);
      rec(i + 1, cur);
      cur.pop();
    }
  };
  rec(0, []);
  return (COMBOS[key] = out);
}

/** Best five of five to seven cards: { score, cards } */
function best(cards) {
  let bestScore = null;
  let bestCards = null;
  for (const idx of combos(cards.length, 5)) {
    const five = idx.map((i) => cards[i]);
    const s = eval5(five);
    if (!bestScore || cmp(s, bestScore) > 0) {
      bestScore = s;
      bestCards = five;
    }
  }
  return { score: bestScore, cards: bestCards };
}

function describe(score) {
  const [c, a, b] = score;
  switch (c) {
    case 8: return a === 14 ? 'Royal flush' : `Straight flush, ${RANK_NAMES[a]} high`;
    case 7: return `Four ${RANK_PLURAL[a]}`;
    case 6: return `Full house, ${RANK_PLURAL[a]} over ${RANK_PLURAL[b]}`;
    case 5: return `Flush, ${RANK_NAMES[a]} high`;
    case 4: return `Straight, ${RANK_NAMES[a]} high`;
    case 3: return `Three ${RANK_PLURAL[a]}`;
    case 2: return `Two pair, ${RANK_PLURAL[a]} and ${RANK_PLURAL[b]}`;
    case 1: return `Pair of ${RANK_PLURAL[a]}`;
    default: return `${RANK_NAMES[a]} high`;
  }
}

// ------------------------------------------------------------------ game
const ok = { ok: true };
const fail = (error) => ({ ok: false, error });

function createGame(players, options, rng) {
  const chips = Number(options.chips) || 1000;
  const g = {
    rng,
    n: players.length,
    options: { chips, blinds: options.blinds || 'normal', limit: options.limit || 'last' },
    startChips: chips,
    players: players.map((p) => ({ id: p.id, name: p.name, chips, bet: 0, total: 0, folded: false, allIn: false, out: false, inHand: false, hole: [], acted: false, raiseOk: true, shown: false, last: '' })),
    handNo: 0,
    dealer: -1,
    phase: 'betting',
    street: 'preflop',
    board: [],
    deck: [],
    currentBet: 0,
    minRaise: 0,
    turn: -1,
    sb: -1,
    bb: -1,
    result: null,
    history: [],
    standings: null,
    levelIdx: START_LEVEL[chips] || 0,
  };
  startHand(g);
  return g;
}

const blindsOf = (g) => LEVELS[g.levelIdx];
const live = (g) => g.players.filter((p) => p.inHand && !p.folded);
const potOf = (g) => g.players.reduce((s, p) => s + p.total, 0);

function nextIdx(g, from, pred) {
  for (let k = 1; k <= g.n; k++) {
    const i = (from + k) % g.n;
    if (pred(g.players[i], i)) return i;
  }
  return -1;
}

function put(p, amount) {
  const a = Math.min(amount, p.chips);
  p.chips -= a;
  p.bet += a;
  p.total += a;
  if (p.chips === 0) p.allIn = true;
  return a;
}

function startHand(g) {
  g.handNo++;
  const per = HANDS_PER_LEVEL[g.options.blinds];
  const base = START_LEVEL[g.startChips] || 0;
  g.levelIdx = Math.min(LEVELS.length - 1, base + (per ? Math.floor((g.handNo - 1) / per) : 0));
  const [sbAmt, bbAmt] = blindsOf(g);
  for (const p of g.players) {
    p.bet = 0;
    p.total = 0;
    p.folded = false;
    p.allIn = false;
    p.hole = [];
    p.acted = false;
    p.raiseOk = true;
    p.shown = false;
    p.last = '';
    p.inHand = !p.out && p.chips > 0;
  }
  g.board = [];
  g.result = null;
  g.street = 'preflop';
  g.phase = 'betting';
  g.deck = shuffle(buildDeck(), g.rng);
  g.dealer = nextIdx(g, g.dealer, (p) => p.inHand);
  const inHand = g.players.filter((p) => p.inHand).length;
  let sbIdx;
  let bbIdx;
  if (inHand === 2) {
    sbIdx = g.dealer; // heads-up: the dealer posts the small blind and acts first before the flop
    bbIdx = nextIdx(g, g.dealer, (p) => p.inHand);
  } else {
    sbIdx = nextIdx(g, g.dealer, (p) => p.inHand);
    bbIdx = nextIdx(g, sbIdx, (p) => p.inHand);
  }
  g.sb = sbIdx;
  g.bb = bbIdx;
  for (let r = 0; r < 2; r++) {
    for (let k = 1; k <= g.n; k++) {
      const p = g.players[(g.dealer + k) % g.n];
      if (p.inHand) p.hole.push(g.deck.pop());
    }
  }
  put(g.players[sbIdx], sbAmt);
  put(g.players[bbIdx], bbAmt);
  g.players[sbIdx].last = `Small blind ${g.players[sbIdx].bet}`;
  g.players[bbIdx].last = `Big blind ${g.players[bbIdx].bet}`;
  g.currentBet = Math.max(g.players[sbIdx].bet, g.players[bbIdx].bet);
  g.minRaise = bbAmt;
  const first = inHand === 2 ? sbIdx : nextIdx(g, bbIdx, (p) => p.inHand);
  g.turn = first;
  settle(g, first);
}

const needsAction = (g, p) => {
  if (!p.inHand || p.folded || p.allIn) return false;
  if (p.bet < g.currentBet) return true;
  if (p.acted) return false;
  return g.players.some((q) => q !== p && q.inHand && !q.folded && !q.allIn); // somebody left to bet against
};

/** After any change: finish the hand, deal the next street, or hand the turn to the next player who must act. `from` is inclusive. */
function settle(g, from) {
  for (;;) {
    if (live(g).length === 1) return endHand(g, false);
    let nxt = -1;
    for (let k = 0; k < g.n; k++) {
      const i = (from + k) % g.n;
      if (needsAction(g, g.players[i])) {
        nxt = i;
        break;
      }
    }
    if (nxt >= 0) {
      g.turn = nxt;
      return;
    }
    // betting round over
    for (const p of g.players) {
      p.bet = 0;
      p.acted = false;
      p.raiseOk = true;
      if (p.folded) continue;
      p.last = p.allIn ? 'All-in' : '';
    }
    g.currentBet = 0;
    g.minRaise = blindsOf(g)[1];
    if (g.street === 'river') return endHand(g, true);
    g.deck.pop(); // burn
    if (g.street === 'preflop') {
      g.board.push(g.deck.pop(), g.deck.pop(), g.deck.pop());
      g.street = 'flop';
    } else if (g.street === 'flop') {
      g.board.push(g.deck.pop());
      g.street = 'turn';
    } else {
      g.board.push(g.deck.pop());
      g.street = 'river';
    }
    from = (g.dealer + 1) % g.n; // after the flop: first live player left of the dealer
  }
}

function endHand(g, showdown) {
  const alive = live(g);
  // return any bet nobody matched
  const byTotal = g.players.filter((p) => p.total > 0).sort((a, b) => b.total - a.total);
  if (byTotal.length > 1 && byTotal[0].total > byTotal[1].total) {
    const back = byTotal[0].total - byTotal[1].total;
    byTotal[0].total -= back;
    byTotal[0].chips += back;
    if (byTotal[0].chips > 0) byTotal[0].allIn = false;
  } else if (byTotal.length === 1) {
    byTotal[0].chips += byTotal[0].total;
    byTotal[0].total = 0;
  }
  const won = new Map();
  const award = (p, amt) => won.set(p, (won.get(p) || 0) + amt);
  const pots = [];
  let evals = null;
  if (showdown && alive.length > 1) {
    // run the board out if players were all-in before the river
    while (g.board.length < 5) {
      if (g.board.length === 0) g.board.push(g.deck.pop(), g.deck.pop(), g.deck.pop());
      else g.board.push(g.deck.pop());
    }
    evals = new Map(alive.map((p) => [p, best(p.hole.concat(g.board))]));
  }
  const levels = [...new Set(g.players.filter((p) => p.total > 0).map((p) => p.total))].sort((a, b) => a - b);
  let prev = 0;
  for (const lvl of levels) {
    const amount = g.players.reduce((s, p) => s + Math.max(0, Math.min(p.total, lvl) - prev), 0);
    const eligible = alive.filter((p) => p.total >= lvl);
    prev = lvl;
    if (!amount) continue;
    if (!eligible.length) {
      if (pots.length) pots[pots.length - 1].amount += amount;
      else pots.push({ amount, eligible: alive.slice() });
      continue;
    }
    const last = pots[pots.length - 1];
    if (last && last.eligible.length === eligible.length && last.eligible.every((p) => eligible.includes(p))) last.amount += amount;
    else pots.push({ amount, eligible });
  }
  const potResults = [];
  for (const pot of pots) {
    let winners;
    if (!evals) winners = pot.eligible.slice(0, 1);
    else {
      let top = null;
      winners = [];
      for (const p of pot.eligible) {
        const s = evals.get(p).score;
        const c = top ? cmp(s, top) : 1;
        if (c > 0) {
          top = s;
          winners = [p];
        } else if (c === 0) winners.push(p);
      }
    }
    // odd chips go to the first winner left of the dealer
    winners.sort((a, b) => ((g.players.indexOf(a) - g.dealer - 1 + g.n) % g.n) - ((g.players.indexOf(b) - g.dealer - 1 + g.n) % g.n));
    const share = Math.floor(pot.amount / winners.length);
    let rem = pot.amount - share * winners.length;
    for (const w of winners) {
      award(w, share + (rem > 0 ? 1 : 0));
      if (rem > 0) rem--;
    }
    potResults.push({ amount: pot.amount, winners: winners.map((w) => g.players.indexOf(w)), eligible: pot.eligible.map((p) => g.players.indexOf(p)) });
  }
  for (const [p, amt] of won) p.chips += amt;
  if (evals) for (const p of alive) p.shown = true;
  g.result = {
    handNo: g.handNo,
    showdown: !!evals,
    pot: potOf(g),
    board: g.board.map((c) => c.id),
    pots: potResults,
    winners: [...won.entries()].map(([p, amt]) => ({
      player: g.players.indexOf(p),
      amount: amt,
      hand: evals ? describe(evals.get(p).score) : null,
      best: evals ? evals.get(p).cards.map((c) => c.id) : null,
    })),
    hands: evals ? alive.map((p) => ({ player: g.players.indexOf(p), hand: describe(evals.get(p).score) })) : [],
  };
  g.history.push({ hand: g.handNo, pot: g.result.pot, winners: g.result.winners.map((w) => ({ player: w.player, amount: w.amount, hand: w.hand })) });
  if (g.history.length > 30) g.history.shift();
  for (const p of g.players) if (p.inHand && p.chips === 0) p.out = true;
  g.turn = -1;
  g.phase = 'handEnd';
  const remaining = g.players.filter((p) => !p.out);
  const limit = g.options.limit === 'last' ? 0 : Number(g.options.limit);
  if (remaining.length <= 1 || (limit && g.handNo >= limit)) finishGame(g);
}

function finishGame(g) {
  g.phase = 'gameOver';
  const order = g.players.map((p, i) => ({ player: i, chips: p.chips })).sort((a, b) => b.chips - a.chips || a.player - b.player);
  let rank = 0;
  order.forEach((o, k) => {
    if (k === 0 || o.chips < order[k - 1].chips) rank = k + 1;
    o.rank = rank;
  });
  g.standings = order;
}

// ------------------------------------------------------------------ actions
const maxTo = (p) => p.bet + p.chips;
const minTo = (g, p) => Math.min(maxTo(p), g.currentBet + g.minRaise);

function applyAction(g, playerId, action) {
  if (!action || typeof action !== 'object') return fail('Invalid action');
  if (action.type === 'continue') {
    if (g.phase !== 'handEnd') return fail('Nothing to continue');
    if (playerId !== null && !g.players.some((p) => p.id === playerId)) return fail('You are not seated at this table');
    startHand(g);
    return ok;
  }
  if (g.phase !== 'betting') return fail('Not your turn');
  const p = g.players[g.turn];
  if (!p || p.id !== playerId) return fail('Not your turn');
  const toCall = g.currentBet - p.bet;
  switch (action.type) {
    case 'fold':
      p.folded = true;
      p.last = 'Fold';
      break;
    case 'check':
      if (toCall > 0) return fail('You cannot check, there is a bet to call');
      p.last = 'Check';
      break;
    case 'call': {
      if (toCall <= 0) return fail('Nothing to call');
      const a = put(p, toCall);
      p.last = p.allIn ? `All-in ${p.bet}` : `Call ${a}`;
      break;
    }
    case 'allin':
    case 'raise': {
      let to = action.type === 'allin' ? maxTo(p) : action.to;
      if (!Number.isInteger(to)) return fail('Enter a whole number');
      if (to <= g.currentBet) {
        if (action.type === 'allin' && toCall > 0) {
          const a = put(p, toCall);
          p.last = p.allIn ? `All-in ${p.bet}` : `Call ${a}`;
          break;
        }
        return fail(`You must raise to more than ${g.currentBet}`);
      }
      if (!p.raiseOk) return fail('You cannot raise now');
      if (to > maxTo(p)) return fail('You do not have that many chips');
      if (to < g.currentBet + g.minRaise && to < maxTo(p)) return fail(`The minimum raise is to ${Math.min(g.currentBet + g.minRaise, maxTo(p))}`);
      const size = to - g.currentBet;
      const opening = g.currentBet === 0;
      put(p, to - p.bet);
      if (size >= g.minRaise) {
        g.minRaise = size;
        for (const q of g.players) if (q !== p) { q.acted = false; q.raiseOk = true; }
      } else {
        for (const q of g.players) if (q !== p) { if (q.acted) q.raiseOk = false; q.acted = false; } // an incomplete all-in does not reopen raising
      }
      g.currentBet = p.bet;
      p.last = p.allIn ? `All-in ${p.bet}` : opening ? `Bet ${p.bet}` : `Raise to ${p.bet}`;
      break;
    }
    default:
      return fail('Unknown action');
  }
  p.acted = true;
  settle(g, (g.turn + 1) % g.n);
  return ok;
}

const awaiting = (g) => (g.phase === 'betting' && g.turn >= 0 ? [g.players[g.turn].id] : []);

// ------------------------------------------------------------------ views
function viewFor(g, playerId) {
  const me = g.players.findIndex((p) => p.id === playerId);
  const mine = me >= 0 ? g.players[me] : null;
  const turnP = g.turn >= 0 ? g.players[g.turn] : null;
  const myTurn = !!(g.phase === 'betting' && mine && turnP === mine);
  const toCall = mine && myTurn ? Math.min(g.currentBet - mine.bet, mine.chips) : 0;
  const [sb, bb] = blindsOf(g);
  const per = HANDS_PER_LEVEL[g.options.blinds];
  const next = per && g.levelIdx < LEVELS.length - 1 ? LEVELS[g.levelIdx + 1] : null;
  const limit = g.options.limit === 'last' ? 0 : Number(g.options.limit);
  let myHand = null;
  if (mine && mine.inHand && !mine.folded && g.board.length >= 3) myHand = describe(best(mine.hole.concat(g.board)).score);
  return {
    game: 'poker',
    me,
    phase: g.phase,
    street: g.street,
    handNo: g.handNo,
    limit,
    startChips: g.startChips,
    dealer: g.dealer,
    sbIdx: g.sb,
    bbIdx: g.bb,
    blinds: { sb, bb, next, handsLeft: per ? per - ((g.handNo - 1) % per) : 0 },
    turn: g.turn,
    myTurn,
    pot: potOf(g),
    board: g.board,
    hand: mine ? mine.hole : [],
    myHand,
    toCall,
    canCheck: myTurn && g.currentBet - mine.bet <= 0,
    currentBet: g.currentBet,
    minRaiseTo: myTurn ? minTo(g, mine) : 0,
    maxRaiseTo: myTurn ? maxTo(mine) : 0,
    canRaise: myTurn && mine.raiseOk && mine.chips > g.currentBet - mine.bet,
    players: g.players.map((p) => ({
      id: p.id,
      name: p.name,
      chips: p.chips,
      bet: p.bet,
      folded: p.folded,
      allIn: p.allIn,
      out: p.out,
      inHand: p.inHand,
      last: p.last,
      cards: p.shown && g.phase !== 'betting' ? p.hole : null,
    })),
    result: g.result,
    history: g.history.slice(-12),
    standings: g.standings,
    options: g.options,
  };
}

// ------------------------------------------------------------------ bots
function preflopStrength(hole) {
  const [a, b] = hole.map((c) => c.rank).sort((x, y) => y - x);
  let s;
  if (a === b) s = 0.5 + ((a - 2) / 12) * 0.45;
  else {
    s = (a - 2 + (b - 2)) / 24 * 0.52;
    if (hole[0].suit === hole[1].suit) s += 0.06;
    const gap = a - b;
    if (gap === 1) s += 0.06;
    else if (gap === 2) s += 0.03;
    if (b >= 10) s += 0.08;
    if (a === 14) s += 0.05;
  }
  return Math.min(1, s);
}

function postflopStrength(g, p) {
  const all = p.hole.concat(g.board);
  const { score } = best(all);
  const cat = score[0];
  let s;
  if (cat === 0) s = 0.08 + (score[1] - 2) / 12 * 0.1;
  else if (cat === 1) {
    const boardMax = Math.max(...g.board.map((c) => c.rank));
    const pairRank = score[1];
    const usesHole = p.hole.some((c) => c.rank === pairRank);
    s = !usesHole ? 0.28 : pairRank >= boardMax ? 0.58 + (pairRank - 2) / 12 * 0.08 : 0.42;
  } else s = [0, 0, 0.74, 0.82, 0.88, 0.92, 0.96, 0.99, 1][cat];
  if (g.street !== 'river' && cat < 4) {
    const bySuit = {};
    for (const c of all) bySuit[c.suit] = (bySuit[c.suit] || 0) + 1;
    if (SUITS.some((su) => bySuit[su] === 4 && p.hole.some((c) => c.suit === su))) s += 0.2;
    const have = new Set(all.map((c) => c.rank));
    if (have.has(14)) have.add(1);
    for (let lo = 1; lo <= 10; lo++) {
      let k = 0;
      for (let r = lo; r < lo + 5; r++) if (have.has(r)) k++;
      if (k === 4 && p.hole.some((c) => c.rank >= lo && c.rank < lo + 5)) {
        s += 0.12;
        break;
      }
    }
  }
  return Math.min(1, s);
}

/** A legal action for the player to move, always. */
function botAction(g, playerId) {
  const p = g.players[g.turn];
  if (g.phase === 'handEnd') return { type: 'continue' };
  if (!p || p.id !== playerId) return { type: 'fold' };
  const toCall = g.currentBet - p.bet;
  const pot = potOf(g);
  const r = g.rng;
  let s = g.street === 'preflop' ? preflopStrength(p.hole) : postflopStrength(g, p);
  s = Math.max(0, Math.min(1, s + (r() - 0.5) * 0.14));
  const bb = blindsOf(g)[1];
  const raiseTo = (want) => {
    if (!p.raiseOk || p.chips <= toCall) return toCall > 0 ? { type: 'call' } : { type: 'check' };
    const unit = Math.max(1, Math.floor(bb / 2));
    const to = Math.round(want / unit) * unit;
    const final = Math.min(maxTo(p), Math.max(minTo(g, p), to));
    return final >= maxTo(p) ? { type: 'allin' } : { type: 'raise', to: final };
  };
  if (toCall <= 0) {
    if (s > 0.82) return raiseTo(g.currentBet + Math.max(bb * 2, pot * (0.6 + r() * 0.5)));
    if (s > 0.6 && r() < 0.65) return raiseTo(g.currentBet + Math.max(bb * 2, pot * (0.35 + r() * 0.3)));
    if (s < 0.3 && r() < 0.08) return raiseTo(g.currentBet + Math.max(bb * 2, pot * 0.5));
    if (g.street === 'preflop' && s > 0.55 && g.currentBet <= bb) return raiseTo(bb * (2.5 + r() * 1.5));
    return { type: 'check' };
  }
  const odds = toCall / (pot + toCall);
  const cheap = toCall <= Math.max(bb, p.chips * 0.05);
  if (s > 0.86 && r() < 0.8) return raiseTo(g.currentBet + Math.max(g.minRaise, pot * (0.6 + r() * 0.6)));
  if (g.street === 'preflop' && s > 0.72 && g.currentBet <= bb * 4 && r() < 0.5) return raiseTo(g.currentBet * 3);
  if (s > odds + 0.12) return { type: 'call' };
  if (cheap && s > 0.2) return { type: 'call' };
  if (s > odds - 0.04 && r() < 0.35) return { type: 'call' };
  if (r() < 0.04 && p.chips > toCall) return { type: 'call' };
  return { type: 'fold' };
}

module.exports = { startHand, createGame, applyAction, viewFor, awaiting, botAction, buildDeck, best, eval5, describe, cmp, LEVELS, potOf };
