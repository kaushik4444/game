'use strict';
/**
 * The Mind: pure rules engine (no timers, no sockets). Real-time cooperative game: there are no turns.
 * Every player holds some numbers from 1-100; together the team must play them all onto one pile in ascending
 * order without talking. A play always puts down the acting player's LOWEST card.
 */

const MAX_LEVELS = { 2: 12, 3: 10, 4: 8 };
const BASE_LIVES = { 2: 2, 3: 3, 4: 4 };
const STAR_LEVELS = [2, 5, 8]; // clearing these levels grants a throwing star
const LIFE_LEVELS = [3, 6, 9]; // clearing these levels grants a life
const LIFE_CAP = 5;
const STAR_CAP = 3;

const LIVES_MODES = ['standard', 'easy', 'hard'];

function normalizeOptions(o) {
  o = o || {};
  return {
    lives: LIVES_MODES.includes(o.lives) ? o.lives : 'standard',
    shurikens: o.shurikens === false ? false : true,
  };
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function startingLives(n, mode) {
  const base = BASE_LIVES[n];
  return mode === 'easy' ? base + 1 : mode === 'hard' ? Math.max(1, base - 1) : base;
}
function startingStars(opts) {
  if (!opts.shurikens) return 0;
  return opts.lives === 'easy' ? 2 : opts.lives === 'hard' ? 0 : 1;
}
/** What clearing `level` grants: { life, star } booleans. */
function bonusFor(level, opts, maxLevel) {
  if (level >= maxLevel) return { life: false, star: false };
  return { life: LIFE_LEVELS.includes(level), star: opts.shurikens && STAR_LEVELS.includes(level) };
}

function createGame(players, options, rng) {
  const n = players.length;
  if (n < 2 || n > 4) throw new Error('The Mind needs 2-4 players');
  const opts = normalizeOptions(options);
  const g = {
    game: 'themind',
    n,
    players: players.map((p) => ({ id: p.id, name: p.name })),
    rng,
    options: opts,
    maxLevel: MAX_LEVELS[n],
    level: 1,
    lives: startingLives(n, opts.lives),
    startLives: startingLives(n, opts.lives),
    stars: startingStars(opts),
    phase: 'ready', // ready (before a level) | playing | levelEnd (level cleared, waiting) | gameOver
    won: false,
    hands: players.map(() => []),
    ready: new Set(),
    pile: [], // { card, player }
    discarded: [], // cards thrown away this level (mistakes and stars), public: { card, player, why }
    votes: new Set(), // player indices that agree to throw a star
    starReady: new Set(), // player indices that are ready to continue after a star discard
    starPaused: false, // waits for players to confirm before the level continues after a star
    event: null, // latest public event, with a rising seq
    seq: 0,
    version: 0, // bumped on every state change (bots use it to cache their timing)
    stats: { mistakes: 0, starsUsed: 0, cleared: 0 },
    finalHands: null,
    log: [],
  };
  return g;
}

const indexOf = (g, id) => g.players.findIndex((p) => p.id === id);

function bump(g) {
  g.version++;
}
function emit(g, ev) {
  g.seq++;
  g.event = Object.assign({ seq: g.seq }, ev);
}

function dealLevel(g) {
  const deck = shuffle(Array.from({ length: 100 }, (_, i) => i + 1), g.rng);
  g.hands = g.players.map(() => []);
  for (let r = 0; r < g.level; r++) for (let i = 0; i < g.n; i++) g.hands[i].push(deck.pop());
  g.hands.forEach((h) => h.sort((a, b) => a - b));
  g.pile = [];
  g.discarded = [];
  g.votes = new Set();
  g.starReady = new Set();
  g.starPaused = false;
  g.ready = new Set();
  g.phase = 'playing';
  emit(g, { type: 'level', level: g.level });
}

const handsEmpty = (g) => g.hands.every((h) => h.length === 0);

function finishLevelIfDone(g) {
  if (g.phase !== 'playing' || !handsEmpty(g)) return;
  g.stats.cleared++;
  g.votes = new Set();
  if (g.level >= g.maxLevel) {
    g.phase = 'gameOver';
    g.won = true;
    emit(g, { type: 'won', level: g.level });
    return;
  }
  const b = bonusFor(g.level, g.options, g.maxLevel);
  if (b.life) g.lives = Math.min(LIFE_CAP, g.lives + 1);
  if (b.star) g.stars = Math.min(STAR_CAP, g.stars + 1);
  const cleared = g.level;
  g.phase = 'levelEnd';
  g.ready = new Set();
  emit(g, { type: 'cleared', level: cleared, bonus: b });
}

function lose(g) {
  g.phase = 'gameOver';
  g.won = false;
  g.finalHands = g.hands.map((h) => h.slice());
  emit(g, { type: 'lost', level: g.level });
}

/** Voters still needed: players that hold cards. */
function checkStar(g) {
  if (g.phase !== 'playing' || !g.votes.size || g.stars <= 0) return;
  const need = g.hands.map((h, i) => (h.length ? i : -1)).filter((i) => i >= 0);
  if (!need.length || !need.every((i) => g.votes.has(i))) return;
  const discards = [];
  g.stars--;
  g.stats.starsUsed++;
  for (let i = 0; i < g.n; i++) {
    if (!g.hands[i].length) continue;
    const card = g.hands[i].shift();
    discards.push({ player: i, card });
    g.discarded.push({ card, player: i, why: 'star' });
  }
  discards.sort((a, b) => a.card - b.card);
  for (const d of discards) g.log.push({ by: g.players[d.player].name, card: `discarded ${d.card} (star)`, kind: 'star' });
  g.votes = new Set();
  g.starReady = new Set();
  g.starPaused = true;
  emit(g, { type: 'star', discards });
  if (g.hands.every((h) => h.length === 0)) {
    g.starPaused = false;
    finishLevelIfDone(g);
  }
}

function playLowest(g, who, expect) {
  if (g.starPaused) return { ok: false, error: 'Wait until everyone confirms after the star' };
  const hand = g.hands[who];
  if (!hand.length) return { ok: false, error: 'You have no cards left' };
  const card = hand[0];
  if (expect !== undefined && expect !== card) return { ok: false, error: 'Your lowest card changed' };
  hand.shift();
  g.pile.push({ card, player: who });
  // anyone holding something lower: too late
  const lost = [];
  for (let i = 0; i < g.n; i++) {
    while (g.hands[i].length && g.hands[i][0] < card) {
      const c = g.hands[i].shift();
      lost.push({ player: i, card: c });
      g.discarded.push({ card: c, player: i, why: 'mistake' });
    }
  }
  if (lost.length) {
    lost.sort((a, b) => a.card - b.card);
    g.lives--;
    g.stats.mistakes++;
    g.log.push({ by: g.players[who].name, card: `played ${card} too early`, kind: 'mistake' });
    emit(g, { type: 'mistake', by: who, card, discards: lost, lives: g.lives });
    if (g.lives <= 0) {
      lose(g);
      return { ok: true };
    }
  } else {
    g.log.push({ by: g.players[who].name, card: `played ${card}`, kind: 'play' });
    emit(g, { type: 'play', by: who, card });
  }
  finishLevelIfDone(g);
  checkStar(g);
  return { ok: true };
}

function applyAction(g, playerId, action) {
  const who = indexOf(g, playerId);
  if (who < 0) return { ok: false, error: 'You are not a player in this game' };
  if (!action || typeof action !== 'object') return { ok: false, error: 'Bad action' };
  if (g.phase === 'gameOver') return { ok: false, error: 'The game is over' };
  let res;
  switch (action.type) {
    case 'ready':
      if (g.phase === 'playing' && g.starPaused) {
        g.starReady.add(who);
        const need = g.hands.map((h, i) => (h.length ? i : -1)).filter((i) => i >= 0);
        if (!need.length || need.every((i) => g.starReady.has(i))) {
          g.starPaused = false;
          g.starReady = new Set();
          emit(g, { type: 'starResume', by: who });
          finishLevelIfDone(g);
        }
        res = { ok: true };
        break;
      }
      if (g.phase !== 'ready' && g.phase !== 'levelEnd') return { ok: false, error: 'No level is waiting to start' };
      g.ready.add(who);
      if (g.ready.size >= g.n) {
        if (g.phase === 'levelEnd') g.level++;
        dealLevel(g);
      }
      res = { ok: true };
      break;
    case 'play': {
      if (g.phase !== 'playing') return { ok: false, error: 'Wait for the level to start' };
      let expect;
      if (action.card !== undefined) {
        if (!Number.isInteger(action.card)) return { ok: false, error: 'Bad card' };
        expect = action.card;
      }
      res = playLowest(g, who, expect);
      break;
    }
    case 'shuriken': {
      if (g.phase !== 'playing') return { ok: false, error: 'Stars can only be thrown during a level' };
      if (g.starPaused) return { ok: false, error: 'Confirm continue after the current star first' };
      if (!g.options.shurikens) return { ok: false, error: 'Throwing stars are switched off' };
      if (action.cancel) {
        g.votes = new Set();
        emit(g, { type: 'starCancel', by: who });
        res = { ok: true };
        break;
      }
      if (g.stars <= 0) return { ok: false, error: 'No throwing stars left' };
      if (!g.hands[who].length) return { ok: false, error: 'You have no cards left' };
      if (!g.votes.has(who)) {
        const first = g.votes.size === 0;
        g.votes.add(who);
        if (first) emit(g, { type: 'starPropose', by: who });
      }
      checkStar(g);
      res = { ok: true };
      break;
    }
    default:
      return { ok: false, error: 'Unknown action' };
  }
  if (res.ok) bump(g);
  return res;
}

function awaitingList(g) {
  if (g.phase === 'ready' || g.phase === 'levelEnd') return g.players.filter((p, i) => !g.ready.has(i)).map((p) => p.id);
  if (g.phase === 'playing') {
    if (g.starPaused) return g.players.filter((p, i) => g.hands[i].length && !g.starReady.has(i)).map((p) => p.id);
    return g.players.filter((p, i) => g.hands[i].length).map((p) => p.id);
  }
  return [];
}

/** The highest number that is publicly known on the table this level. */
function tableTop(g) {
  let top = 0;
  for (const p of g.pile) top = Math.max(top, p.card);
  for (const d of g.discarded) top = Math.max(top, d.card);
  return top;
}

function botAction(g, playerId) {
  const who = indexOf(g, playerId);
  if (g.phase === 'ready' || g.phase === 'levelEnd') return { type: 'ready' };
  if (g.phase === 'playing' && g.starPaused) return { type: 'ready' };
  if (g.phase === 'playing' && g.votes.size && g.stars > 0 && who >= 0 && !g.votes.has(who) && g.hands[who].length) return { type: 'shuriken' };
  return { type: 'play' };
}

function viewFor(g, playerId) {
  const me = indexOf(g, playerId);
  const over = g.phase === 'gameOver';
  const hand = me >= 0 ? g.hands[me].slice() : [];
  const needsReady = (g.phase === 'ready' || g.phase === 'levelEnd') && me >= 0 && !g.ready.has(me);
  const nextLevel = g.phase === 'levelEnd' ? g.level + 1 : g.level;
  return {
    game: 'themind',
    me,
    n: g.n,
    options: Object.assign({}, g.options),
    phase: g.phase,
    level: g.level,
    nextLevel,
    maxLevel: g.maxLevel,
    lives: g.lives,
    startLives: g.startLives,
    stars: g.stars,
    won: g.won,
    players: g.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      cards: g.hands[i].length,
      ready: g.ready.has(i),
      voted: g.votes.has(i),
    })),
    hand,
    pile: g.pile.map((p) => ({ card: p.card, player: p.player })),
    discarded: g.discarded.map((d) => ({ card: d.card, player: d.player, why: d.why })),
    votes: [...g.votes],
    starPending: g.votes.size > 0 && g.phase === 'playing',
    canStar: g.phase === 'playing' && !g.starPaused && g.options.shurikens && g.stars > 0 && me >= 0 && hand.length > 0,
    starPaused: g.starPaused,
    starReady: [...g.starReady],
    event: g.event,
    canResume: g.phase === 'playing' && g.starPaused && me >= 0 && hand.length > 0 && !g.starReady.has(me),
    waitingAfterStar: g.phase === 'playing' && g.starPaused,
    waitingAfterStarCount: g.phase === 'playing' && g.starPaused ? g.hands.filter((h, i) => h.length && !g.starReady.has(i)).length : 0,
    starDiscardCount: g.discarded.filter((d) => d.why === 'star').length,
    clearedBonus: g.phase === 'levelEnd' && g.event && g.event.type === 'cleared' ? g.event.bonus : null,
    upcomingBonus: bonusFor(nextLevel, g.options, g.maxLevel),
    stats: Object.assign({}, g.stats),
    log: g.log ? g.log.slice(-20) : [],
    finalHands: over && g.finalHands ? g.finalHands.map((h) => h.slice()) : null,
    myTurn: !over && me >= 0 && ((g.phase === 'playing' && hand.length > 0) || needsReady),
    winners: over && g.won ? g.players.map((p) => p.id) : [],
  };
}

module.exports = {
  MAX_LEVELS, BASE_LIVES, STAR_LEVELS, LIFE_LEVELS, LIFE_CAP, STAR_CAP,
  createGame, applyAction, awaitingList, botAction, viewFor, tableTop, bonusFor, startingLives, startingStars, normalizeOptions, shuffle,
};
