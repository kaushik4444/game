'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const games = require('./games');
const dbPool = require('./db/pool');
const { migrate } = require('./db/migrate');
const dbPlayers = require('./db/players');
const dbMatches = require('./db/matches');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'",
};
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I / O
const BOT_NAMES = ['Merlin', 'Morgana', 'Gandalf', 'Circe', 'Rincewind', 'Radagast', 'Elminster', 'Oz'];
const MAX_ROOMS = 500;
const MAX_SPECTATORS = 20;
const CHAT_KEEP = 60; // messages remembered per table
const AVATARS = ['🧙', '🧝', '🧛', '🧞', '🦊', '🐺', '🦉', '🐉', '🦄', '🐙', '🐸', '🦁', '🐼', '🐯', '🦅', '🐲'];
const EMOTES = ['👍', '👏', '😂', '😮', '😡', '🤔', '🔥', '😎'];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const rand = (a, b) => a + Math.random() * (b - a);
const cleanName = (s) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20) : '');
const cleanText = (s) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) : '');

function start(opts = {}) {
  const port = opts.port ?? Number(process.env.PORT || 3000);
  const botDelay = opts.botDelay || [900, 1600]; // ms range a bot "thinks"
  const autoAdvanceMs = opts.autoAdvanceMs ?? 8000; // pause between rounds
  const absentMs = opts.absentMs ?? 15000; // a disconnected human's turn is played by a bot after this
  const maxMsgsPerSec = opts.maxMsgsPerSec ?? 30; // per socket; humans send a handful of messages per minute
  const trickPauseMs = opts.trickPauseMs ?? 1700; // time everybody gets to see a finished trick being collected
  const timeScale = opts.timeScale ?? 1; // tests shrink the turn time limit with this
  const forcedMs = opts.forcedMs ?? 700; // delay between automatic plays in the last trick of a round

  const players = new Map(); // id -> player
  const tokens = new Map(); // secret token -> player
  const rooms = new Map(); // code -> room

  // ------------------------------------------------------------ http
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      return res.end();
    }
    let rel;
    try {
      rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      res.writeHead(400);
      return res.end();
    }
    if (rel === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }
    if (rel.includes('\0')) {
      res.writeHead(400);
      return res.end();
    }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403);
      return res.end();
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Not found');
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        ...SECURITY_HEADERS,
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  });

  // ------------------------------------------------------------ helpers
  const send = (ws, obj) => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  };
  const sendError = (p, message) => send(p.ws, { t: 'error', message });
  const isConnected = (m) => m.bot || !!players.get(m.id)?.connected;
  const humans = (room) => room.members.filter((m) => !m.bot);
  const isSpec = (room, id) => room.spectators.some((s) => s.id === id);
  /** Everybody who should receive table updates: seated humans and spectators. */
  const viewers = (room) => humans(room).concat(room.spectators);
  const awaitingOf = (g) => [].concat(g.awaiting() ?? []);

  function roomInfo(room) {
    const def = games.get(room.gameId);
    return {
      code: room.code,
      gameId: room.gameId,
      hostId: room.hostId,
      status: room.status,
      options: room.options,
      visibility: room.visibility,
      seats: room.seats,
      min: def.seats.min,
      max: def.seats.max,
      seatLabels: def.seatLabel ? Array.from({ length: room.seats }, (_, i) => def.seatLabel(i, room.seats)) : null,
      members: room.members.map((m) => ({ id: m.id, name: m.name, bot: m.bot, avatar: m.avatar, connected: isConnected(m) })),
      spectators: room.spectators.map((s) => ({ id: s.id, name: s.name, avatar: s.avatar, connected: isConnected(s) })),
      deadline: room.status === 'playing' ? room.deadline : null, // epoch ms when the awaited human(s) get auto-played
      now: Date.now(), // lets clients correct for clock differences
    };
  }

  function publicTables() {
    return [...rooms.values()]
      .filter((room) => room.visibility === 'public' && (room.status === 'lobby' || room.status === 'playing'))
      .map((room) => ({
        code: room.code,
        gameId: room.gameId,
        status: room.status,
        seats: room.seats,
        // A filled bot seat is still an occupied player seat, so the directory
        // always reflects the live table population rather than only humans.
        members: room.members.length,
        humans: room.members.filter((m) => !m.bot).length,
        host: room.members.find((m) => m.id === room.hostId)?.name || 'Host',
        spectators: room.spectators.length,
      }));
  }

  function broadcastTables() {
    const message = { t: 'tables', tables: publicTables() };
    for (const p of players.values()) if (p.connected) send(p.ws, message);
  }

  function broadcast(room) {
    room.lastActivity = Date.now();
    const info = roomInfo(room);
    for (const m of viewers(room)) {
      const p = players.get(m.id);
      if (p && p.connected) send(p.ws, { t: 'state', room: info, view: room.game ? room.game.view(m.id) : null });
    }
    broadcastTables();
  }

  // ------------------------------------------------------------ chat
  function pushChat(room, m) {
    m.ts = Date.now();
    room.chat.push(m);
    if (room.chat.length > CHAT_KEEP) room.chat.shift();
    for (const v of viewers(room)) {
      const p = players.get(v.id);
      if (p && p.connected) send(p.ws, { t: 'chat', m });
    }
  }
  const sys = (room, text) => pushChat(room, { sys: true, text });
  const sendChatLog = (p, room) => send(p.ws, { t: 'chatlog', messages: room.chat });
  function notifyOthers(room, exceptId, text) {
    for (const v of viewers(room)) {
      if (v.id === exceptId) continue;
      const q = players.get(v.id);
      if (q && q.connected) send(q.ws, { t: 'notice', text });
    }
  }

  // ------------------------------------------------------------ turn timer
  const limitMs = (room) => {
    const s = Number(room.options && room.options.timeLimit);
    return Number.isFinite(s) && s > 0 ? s * 1000 * timeScale : 0;
  };

  /**
   * Called after every game action: starts a fresh deadline for whoever the game now waits for.
   * During simultaneous moves (everybody bids at once) the deadline is shared and not restarted by each bid.
   */
  function touchTimer(room) {
    const g = room.game;
    const limit = limitMs(room);
    const now = awaitingOf(g);
    const prev = room.waiting || [];
    const sameBatch = prev.length > 1 && now.length > 0 && now.every((id) => prev.includes(id));
    const humanWaiting = now.some((id) => room.members.some((m) => m.id === id && !m.bot));
    if (!limit || !humanWaiting) room.deadline = null;
    else if (!sameBatch || !room.deadline) room.deadline = Date.now() + Math.max(0, (room.pauseUntil || 0) - Date.now()) + limit;
    room.waiting = now;
  }

  function afterChange(room) {
    const g = room.game;
    if (g) {
      if (g.isOver() && room.status !== 'finished') {
        room.status = 'finished';
        // Persist completed match asynchronously
        try {
          const scores = g.scores ? g.scores() : [];
          const maxScore = scores.length ? Math.max(...scores) : 0;
          const participants = room.members.map((m, idx) => ({
            playerId: m.id,
            name: m.name,
            seat: idx,
            score: scores[idx] ?? 0,
            isWinner: (scores[idx] ?? 0) === maxScore,
            isBot: Boolean(m.bot),
          }));
          dbMatches.recordMatch({
            roomCode: room.code,
            gameId: room.gameId,
            seats: room.seats,
            options: room.options,
            participants,
          }).catch((err) => console.error('[server] Failed to record match:', err.message));
        } catch (e) {
          console.error('[server] Error preparing match record:', e.message);
        }
      }
      // a trick just finished: give everyone a moment to see it being collected before the next card
      const lt = g.stamp ? g.stamp() : null;
      if (lt && lt !== room.lastStamp && trickPauseMs > 0) room.pauseUntil = Date.now() + trickPauseMs;
      room.lastStamp = lt;
      touchTimer(room);
    }
    broadcast(room);
    schedule(room);
  }

  /** Decide whether the server must act soon (bot turn, absent human, forced play, timeout, between rounds) and set one timer for it. */
  function schedule(room) {
    clearTimeout(room.timer);
    room.timer = null;
    const g = room.game;
    if (!g || room.status !== 'playing' || g.isOver()) return;
    if (!humans(room).some(isConnected)) return; // nobody watching: pause

    const waiting = awaitingOf(g);
    const pause = Math.max(0, (room.pauseUntil || 0) - Date.now());
    let delay;
    let run;
    let valid;
    const forced = waiting.length && g.forcedPlay ? g.forcedPlay() : null;
    if (!waiting.length) {
      const auto = g.autoAction();
      if (!auto) return;
      delay = autoAdvanceMs;
      run = () => g.act(null, auto);
      valid = () => awaitingOf(g).length === 0;
    } else if (forced) {
      // last trick of the round: after the first card the rest is automatic
      delay = Math.max(forcedMs, pause);
      run = () => g.act(forced.playerId, forced.action);
      valid = () => {
        const f = g.forcedPlay && g.forcedPlay();
        return !!f && f.playerId === forced.playerId;
      };
    } else {
      const ms = waiting.map((id) => room.members.find((x) => x.id === id)).filter(Boolean);
      const bots = ms.filter((m) => m.bot);
      let who = bots[0] || ms.find((m) => !m.bot && !isConnected(m));
      let botMs = null;
      if (bots.length && typeof g.botDelayMs === 'function') {
        // a real-time game (The Mind) times its bots itself: the bot that wants to play soonest goes next
        const t = bots.map((m) => ({ m, d: g.botDelayMs(m.id) })).sort((x, y) => x.d - y.d)[0];
        who = t.m;
        botMs = Math.max(0, t.d);
      }
      if (who) {
        delay = Math.max(who.bot ? (botMs !== null ? botMs : rand(botDelay[0], botDelay[1])) : absentMs, pause);
        run = () => g.act(who.id, g.botAction(who.id));
        valid = () => awaitingOf(g).includes(who.id) && (who.bot || !isConnected(who));
      } else if (room.deadline) {
        // connected humans are thinking, but the table has a time limit
        const dl = room.deadline;
        delay = Math.max(0, dl - Date.now());
        run = () => {
          let res = { ok: true };
          for (const id of awaitingOf(g)) {
            const m = room.members.find((x) => x.id === id);
            const r = g.act(id, g.botAction(id));
            if (!r.ok) res = r;
            else if (m && !m.bot) {
              sys(room, `⏱ ${m.name} ran out of time. A bot played for them.`);
              const q = players.get(id);
              if (q && q.connected) send(q.ws, { t: 'notice', text: 'Time is up! A bot played for you.' });
            }
          }
          return res;
        };
        valid = () => room.deadline === dl && awaitingOf(g).length > 0;
      } else return; // connected humans are thinking, no limit
    }
    room.timer = setTimeout(() => {
      room.timer = null;
      if (room.game !== g || g.isOver()) return;
      if (!valid()) return schedule(room);
      const res = run();
      if (!res.ok) console.error('auto action failed:', res.error);
      afterChange(room);
    }, delay);
    if (room.timer.unref) room.timer.unref();
  }

  function newCode() {
    for (;;) {
      let c = '';
      for (let i = 0; i < 6; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
      if (!rooms.has(c)) return c;
    }
  }

  function destroyRoom(room) {
    clearTimeout(room.timer);
    rooms.delete(room.code);
    broadcastTables();
    for (const m of viewers(room)) {
      const p = players.get(m.id);
      if (p && p.room === room.code) {
        p.room = null;
        if (isSpec(room, m.id)) send(p.ws, { t: 'left' });
      }
    }
  }

  function leaveRoom(p) {
    const room = rooms.get(p.room);
    p.room = null;
    if (!room) return;
    const si = room.spectators.findIndex((s) => s.id === p.id);
    if (si >= 0) {
      room.spectators.splice(si, 1);
      sys(room, `👁 ${p.name} stopped watching`);
      return broadcast(room);
    }
    const i = room.members.findIndex((m) => m.id === p.id);
    if (i < 0) return;
    if (room.status === 'playing') {
      room.members[i].bot = true; // a bot takes over the seat
      sys(room, `${p.name} left. A bot took over the seat.`);
    } else room.members.splice(i, 1);
    if (!humans(room).length) return destroyRoom(room);
    if (room.hostId === p.id) room.hostId = humans(room)[0].id;
    broadcast(room);
    schedule(room);
  }

  function addMember(room, p) {
    room.members.push({ id: p.id, name: p.name, avatar: p.avatar, bot: false });
    p.room = room.code;
  }

  function addSpectator(room, p) {
    room.spectators.push({ id: p.id, name: p.name, avatar: p.avatar });
    p.room = room.code;
  }

  // ------------------------------------------------------------ message handlers
  const handlers = {
    setName(p, msg) {
      applyProfile(p, msg);
      dbPlayers.updateProfile(p.id, { displayName: p.name, avatar: p.avatar }).catch(() => {});
      const room = rooms.get(p.room);
      if (!room) return;
      const m = room.members.find((x) => x.id === p.id);
      if (m) {
        m.avatar = p.avatar;
        if (room.status !== 'playing') m.name = p.name;
      }
      const s = room.spectators.find((x) => x.id === p.id);
      if (s) {
        s.avatar = p.avatar;
        s.name = p.name;
      }
      broadcast(room);
    },

    emote(p, msg) {
      const room = rooms.get(p.room);
      if (!room || room.status === 'lobby' || isSpec(room, p.id) || !EMOTES.includes(msg.e)) return;
      const now = Date.now();
      if (now - (p.lastEmote || 0) < 700) return;
      p.lastEmote = now;
      for (const m of viewers(room)) {
        const q = players.get(m.id);
        if (q && q.connected) send(q.ws, { t: 'emote', id: p.id, e: msg.e });
      }
    },

    chat(p, msg) {
      const room = rooms.get(p.room);
      if (!room) return;
      const text = cleanText(msg.text);
      if (!text) return;
      const now = Date.now();
      if (now - (p.lastChat || 0) < 500) return sendError(p, 'Slow down a little');
      p.lastChat = now;
      pushChat(room, { id: p.id, name: p.name, avatar: p.avatar, text, spec: isSpec(room, p.id) });
    },

    create(p, msg) {
      const def = games.get(msg.gameId);
      if (!def) return sendError(p, 'Unknown game');
      if (rooms.size >= MAX_ROOMS) return sendError(p, 'Server is full, try again later');
      applyProfile(p, msg);
      if (p.room) leaveRoom(p);
      const room = {
        code: newCode(),
        createdAt: Date.now(),
        lastActivity: Date.now(),
        idleSince: null,
        gameId: def.id,
        visibility: msg.visibility === 'public' ? 'public' : 'private',
        hostId: p.id,
        status: 'lobby',
        seats: def.seats.default,
        options: sanitizeOptions(def, {}),
        members: [],
        spectators: [],
        chat: [],
        game: null,
        timer: null,
        deadline: null,
        waiting: [],
        pauseUntil: 0,
        lastStamp: null,
      };
      rooms.set(room.code, room);
      addMember(room, p);
      broadcast(room);
      sendChatLog(p, room);
    },

    join(p, msg) {
      const code = typeof msg.code === 'string' ? msg.code.trim().toUpperCase() : '';
      const room = rooms.get(code);
      applyProfile(p, msg);
      if (!room) return sendError(p, `No table with code ${code || '?'}`);
      if (p.room === code && (room.members.some((m) => m.id === p.id) || isSpec(room, p.id))) return broadcast(room);
      if (room.status !== 'lobby') {
        // the game is already running: the newcomer watches
        if (room.spectators.length >= MAX_SPECTATORS) return sendError(p, 'Too many spectators at that table');
        if (p.room) leaveRoom(p);
        addSpectator(room, p);
        sys(room, `👁 ${p.name} is watching`);
        notifyOthers(room, p.id, `👁 ${p.name} is watching the game`);
        broadcast(room);
        sendChatLog(p, room);
        return;
      }
      if (room.members.length >= room.seats) return sendError(p, 'That table is full');
      if (p.room) leaveRoom(p);
      addMember(room, p);
      broadcast(room);
      sendChatLog(p, room);
    },

    sit(p) {
      const room = rooms.get(p.room);
      if (!room || room.status !== 'lobby' || !isSpec(room, p.id)) return sendError(p, 'Not possible right now');
      if (room.members.length >= room.seats) return sendError(p, 'There is no open seat');
      room.spectators.splice(room.spectators.findIndex((s) => s.id === p.id), 1);
      addMember(room, p);
      broadcast(room);
    },

    leave(p) {
      leaveRoom(p);
      send(p.ws, { t: 'left' });
    },

    addBot(p) {
      const room = hostRoom(p, 'lobby');
      if (!room) return;
      if (room.members.length >= room.seats) return sendError(p, 'All seats are taken');
      addBotTo(room);
      broadcast(room);
    },

    removeBot(p, msg) {
      const room = hostRoom(p, 'lobby');
      if (!room) return;
      const i = room.members.findIndex((m) => m.id === msg.id && m.bot);
      if (i >= 0) room.members.splice(i, 1);
      broadcast(room);
    },

    setOptions(p, msg) {
      const room = hostRoom(p, 'lobby');
      if (!room) return;
      room.options = sanitizeOptions(games.get(room.gameId), msg.options);
      broadcast(room);
    },

    setVisibility(p, msg) {
      const room = hostRoom(p, 'lobby');
      if (!room) return;
      room.visibility = msg.visibility === 'public' ? 'public' : 'private';
      broadcast(room); // also broadcasts the directory, removing private tables immediately
    },

    setSeats(p, msg) {
      const room = hostRoom(p, 'lobby');
      if (!room) return;
      const def = games.get(room.gameId);
      const n = msg.seats;
      if (!Number.isInteger(n) || n < def.seats.min || n > def.seats.max) return sendError(p, 'Invalid number of players');
      while (room.members.length > n) {
        const i = room.members.map((m) => m.bot).lastIndexOf(true);
        if (i < 0) return sendError(p, 'Too many human players for that many seats');
        room.members.splice(i, 1);
      }
      room.seats = n;
      broadcast(room);
    },

    start(p) {
      const room = hostRoom(p, 'lobby');
      if (!room) return;
      const def = games.get(room.gameId);
      while (room.members.length < room.seats) addBotTo(room); // empty seats are filled with bots
      room.game = def.create(
        room.members.map((m) => ({ id: m.id, name: m.name })),
        room.options,
        Math.random
      );
      room.status = 'playing';
      room.deadline = null;
      room.waiting = [];
      room.pauseUntil = 0;
      room.lastStamp = null;
      afterChange(room);
    },

    act(p, msg) {
      const room = rooms.get(p.room);
      if (!room || room.status !== 'playing' || !room.game) return sendError(p, 'No game in progress');
      if (isSpec(room, p.id)) return sendError(p, 'You are watching this game');
      const res = room.game.act(p.id, msg.action);
      if (!res.ok) {
        sendError(p, res.error || 'Not allowed');
        return broadcast(room); // resync the sender's view
      }
      afterChange(room);
    },

    rematch(p) {
      const room = hostRoom(p, 'finished');
      if (!room) return;
      clearTimeout(room.timer);
      room.game = null;
      room.status = 'lobby';
      room.deadline = null;
      // spectators take any free seat; the rest keep watching and can sit down when the host frees a seat
      for (const s of room.spectators.slice()) {
        if (room.members.length >= room.seats) break;
        room.spectators.splice(room.spectators.indexOf(s), 1);
        room.members.push({ id: s.id, name: s.name, avatar: s.avatar, bot: false });
      }
      broadcast(room);
    },
  };

  function addBotTo(room) {
    const used = new Set(room.members.map((m) => m.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) || 'Bot ' + (room.members.length + 1);
    const usedAv = new Set(room.members.map((m) => m.avatar));
    const avatar = pick(AVATARS.filter((a) => !usedAv.has(a)).concat(AVATARS.slice(0, 1)));
    room.members.push({ id: 'bot_' + crypto.randomBytes(4).toString('hex'), name, avatar, bot: true });
  }

  function applyProfile(p, msg) {
    const name = cleanName(msg.name);
    if (name) p.name = name;
    if (AVATARS.includes(msg.avatar)) p.avatar = msg.avatar;
  }

  function hostRoom(p, status) {
    const room = rooms.get(p.room);
    if (!room) return null;
    if (room.hostId !== p.id) return void sendError(p, 'Only the host can do that');
    if (room.status !== status) return void sendError(p, 'Not possible right now');
    return room;
  }

  function sanitizeOptions(def, given) {
    const out = {};
    for (const o of def.options) {
      const v = given ? given[o.key] : undefined;
      if (o.type === 'boolean') out[o.key] = typeof v === 'boolean' ? v : o.default;
      else if (o.type === 'select') out[o.key] = o.choices.some((c) => c.value === v) ? v : o.default;
    }
    return out;
  }

  // ------------------------------------------------------------ websocket
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8 * 1024 });

  async function onHello(ws, msg) {
    let p = typeof msg.token === 'string' ? tokens.get(msg.token) : null;
    let bearerToken = msg.token;

    if (!p && typeof msg.token === 'string') {
      // Check database / persistent store
      const dbPlayer = await dbPlayers.authenticateToken(msg.token);
      if (dbPlayer) {
        p = {
          id: dbPlayer.id,
          token: msg.token,
          name: dbPlayer.display_name,
          avatar: dbPlayer.avatar,
          room: null,
          ws: null,
          connected: false,
          lastSeen: Date.now(),
        };
        players.set(p.id, p);
        tokens.set(p.token, p);
      }
    }

    if (!p) {
      // Create new anonymous player account
      const created = await dbPlayers.createAnonymousPlayer({
        displayName: cleanName(msg.name) || 'Guest ' + (100 + crypto.randomInt(900)),
        avatar: AVATARS.includes(msg.avatar) ? msg.avatar : pick(AVATARS),
      });

      bearerToken = created.rawToken;
      p = {
        id: created.player.id,
        token: bearerToken,
        name: created.player.display_name,
        avatar: created.player.avatar,
        room: null,
        ws: null,
        connected: false,
        lastSeen: Date.now(),
      };
      players.set(p.id, p);
      tokens.set(p.token, p);
    }
    if (p.ws && p.ws !== ws) {
      p.ws.player = null;
      p.ws.close(4000, 'replaced');
    }
    p.ws = ws;
    p.connected = true;
    ws.player = p;
    applyProfile(p, msg);
    send(ws, { t: 'welcome', id: p.id, token: p.token, name: p.name, avatar: p.avatar, avatars: AVATARS, emotes: EMOTES, games: games.list(), tables: publicTables() });
    const room = rooms.get(p.room);
    if (room) {
      broadcast(room);
      sendChatLog(p, room);
      schedule(room);
    } else p.room = null;
  }

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.player = null;
    ws.msgs = 0;
    ws.on('pong', () => (ws.isAlive = true));
    ws.on('message', (raw) => {
      if (++ws.msgs > maxMsgsPerSec) return ws.close(1008, 'slow down'); // flood guard; counter is reset every second
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
      if (msg.t === 'hello') return onHello(ws, msg);
      const p = ws.player;
      if (!p || !Object.hasOwn(handlers, msg.t)) return;
      try {
        handlers[msg.t](p, msg);
      } catch (e) {
        console.error('handler error', msg.t, e);
        sendError(p, 'Something went wrong');
      }
    });
    ws.on('close', () => {
      const p = ws.player;
      if (!p || p.ws !== ws) return;
      p.ws = null;
      p.connected = false;
      p.lastSeen = Date.now();
      const room = rooms.get(p.room);
      if (room) {
        broadcast(room);
        schedule(room);
      }
    });
    ws.on('error', () => {});
  });

  // keep-alive, rate-limit window reset, garbage collection
  const ticker = setInterval(() => {
    for (const ws of wss.clients) {
      ws.msgs = 0;
      if (!ws.pingAt || Date.now() - ws.pingAt > 30000) {
        if (ws.isAlive === false) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        ws.pingAt = Date.now();
        ws.ping();
      }
    }
  }, 1000);
  const gc = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      const hasConnectedHuman = humans(room).some(isConnected);
      if (hasConnectedHuman) {
        room.idleSince = null;
      } else if (!room.idleSince) {
        room.idleSince = now;
      } else if (now - room.idleSince > 10 * 60 * 1000) {
        destroyRoom(room);
        continue;
      }
      // Abandoned lobbies are short lived; a stalled game gets a longer grace period.
      const idleLimit = room.status === 'lobby' ? 15 * 60 * 1000 : 60 * 60 * 1000;
      if (now - (room.lastActivity || room.createdAt || now) > idleLimit) {
        destroyRoom(room);
        continue;
      }
      // spectators who disappeared for a while are dropped
      for (const s of room.spectators.slice()) {
        const sp = players.get(s.id);
        if (!sp || (!sp.connected && now - sp.lastSeen > 5 * 60 * 1000)) {
          room.spectators.splice(room.spectators.indexOf(s), 1);
          if (sp) sp.room = null;
        }
      }
    }
    for (const p of players.values()) {
      if (!p.connected && !rooms.has(p.room) && now - p.lastSeen > 60 * 60 * 1000) {
        players.delete(p.id);
        tokens.delete(p.token);
      }
    }
  }, 60 * 1000);
  ticker.unref();
  gc.unref();

  function close() {
    clearInterval(ticker);
    clearInterval(gc);
    for (const room of rooms.values()) clearTimeout(room.timer);
    for (const ws of wss.clients) ws.terminate();
    return new Promise((resolve) => wss.close(() => server.close(() => resolve())));
  }

  // Run pending database migrations automatically if DATABASE_URL is configured
  if (dbPool.hasDatabase()) {
    migrate().catch((err) => console.error('[server] Startup migration warning:', err.message));
  }

  return new Promise((resolve) => server.listen(port, () => resolve({ server, port: server.address().port, close })));
}

module.exports = { start };

if (require.main === module) {
  start().then(({ port }) => console.log(`Tableverse running on http://localhost:${port}`));
}
