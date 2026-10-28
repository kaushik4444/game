'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const games = require('./games');

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
const AVATARS = ['🧙', '🧝', '🧛', '🧞', '🦊', '🐺', '🦉', '🐉', '🦄', '🐙', '🐸', '🦁', '🐼', '🐯', '🦅', '🐲'];
const EMOTES = ['👍', '👏', '😂', '😮', '😡', '🤔', '🔥', '😎'];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const rand = (a, b) => a + Math.random() * (b - a);
const cleanName = (s) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20) : '');

function start(opts = {}) {
  const port = opts.port ?? Number(process.env.PORT || 3000);
  const botDelay = opts.botDelay || [900, 1600]; // ms range a bot "thinks"
  const autoAdvanceMs = opts.autoAdvanceMs ?? 8000; // pause between rounds
  const absentMs = opts.absentMs ?? 15000; // a disconnected human's turn is played by a bot after this
  const maxMsgsPerSec = opts.maxMsgsPerSec ?? 30; // per socket; humans send a handful of messages per minute

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

  function roomInfo(room) {
    const def = games.get(room.gameId);
    return {
      code: room.code,
      gameId: room.gameId,
      hostId: room.hostId,
      status: room.status,
      options: room.options,
      seats: room.seats,
      min: def.seats.min,
      max: def.seats.max,
      seatLabels: def.seatLabel ? Array.from({ length: room.seats }, (_, i) => def.seatLabel(i, room.seats)) : null,
      members: room.members.map((m) => ({ id: m.id, name: m.name, bot: m.bot, avatar: m.avatar, connected: isConnected(m) })),
    };
  }

  function broadcast(room) {
    const info = roomInfo(room);
    for (const m of humans(room)) {
      const p = players.get(m.id);
      if (p && p.connected) send(p.ws, { t: 'state', room: info, view: room.game ? room.game.view(m.id) : null });
    }
  }

  function afterChange(room) {
    if (room.game && room.game.isOver()) room.status = 'finished';
    broadcast(room);
    schedule(room);
  }

  /** Decide whether the server must act soon (bot turn, absent human, between rounds) and set one timer for it. */
  function schedule(room) {
    clearTimeout(room.timer);
    room.timer = null;
    const g = room.game;
    if (!g || room.status !== 'playing' || g.isOver()) return;
    if (!humans(room).some(isConnected)) return; // nobody watching: pause

    const waiting = [].concat(g.awaiting() ?? []);
    let who = null;
    let delay;
    let run;
    if (!waiting.length) {
      const auto = g.autoAction();
      if (!auto) return;
      delay = autoAdvanceMs;
      run = () => g.act(null, auto);
    } else {
      const ms = waiting.map((id) => room.members.find((x) => x.id === id)).filter(Boolean);
      const bot = ms.find((m) => m.bot);
      const absent = ms.find((m) => !m.bot && !isConnected(m));
      if (bot) {
        who = bot.id;
        delay = rand(botDelay[0], botDelay[1]);
      } else if (absent) {
        who = absent.id;
        delay = absentMs;
      } else return; // connected humans are thinking
      run = () => g.act(who, g.botAction(who));
    }
    room.timer = setTimeout(() => {
      room.timer = null;
      if (room.game !== g || g.isOver()) return;
      const now = [].concat(g.awaiting() ?? []);
      if (who === null ? now.length > 0 : !now.includes(who)) return schedule(room);
      const m = room.members.find((x) => x.id === who);
      if (who !== null && m && !m.bot && isConnected(m)) return; // they came back
      const res = run();
      if (!res.ok) console.error('auto action failed:', res.error);
      afterChange(room);
    }, delay);
    if (room.timer.unref) room.timer.unref();
  }

  function newCode() {
    for (;;) {
      let c = '';
      for (let i = 0; i < 4; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
      if (!rooms.has(c)) return c;
    }
  }

  function destroyRoom(room) {
    clearTimeout(room.timer);
    rooms.delete(room.code);
    for (const m of humans(room)) {
      const p = players.get(m.id);
      if (p && p.room === room.code) p.room = null;
    }
  }

  function leaveRoom(p) {
    const room = rooms.get(p.room);
    p.room = null;
    if (!room) return;
    const i = room.members.findIndex((m) => m.id === p.id);
    if (i < 0) return;
    if (room.status === 'playing') room.members[i].bot = true; // a bot takes over the seat
    else room.members.splice(i, 1);
    if (!humans(room).length) return destroyRoom(room);
    if (room.hostId === p.id) room.hostId = humans(room)[0].id;
    broadcast(room);
    schedule(room);
  }

  function addMember(room, p) {
    room.members.push({ id: p.id, name: p.name, avatar: p.avatar, bot: false });
    p.room = room.code;
  }

  // ------------------------------------------------------------ message handlers
  const handlers = {
    setName(p, msg) {
      applyProfile(p, msg);
      const room = rooms.get(p.room);
      if (!room) return;
      const m = room.members.find((x) => x.id === p.id);
      if (m) {
        m.avatar = p.avatar;
        if (room.status !== 'playing') m.name = p.name;
      }
      broadcast(room);
    },

    emote(p, msg) {
      const room = rooms.get(p.room);
      if (!room || room.status === 'lobby' || !EMOTES.includes(msg.e)) return;
      const now = Date.now();
      if (now - (p.lastEmote || 0) < 700) return;
      p.lastEmote = now;
      for (const m of humans(room)) {
        const q = players.get(m.id);
        if (q && q.connected) send(q.ws, { t: 'emote', id: p.id, e: msg.e });
      }
    },

    create(p, msg) {
      const def = games.get(msg.gameId);
      if (!def) return sendError(p, 'Unknown game');
      if (rooms.size >= MAX_ROOMS) return sendError(p, 'Server is full, try again later');
      applyProfile(p, msg);
      if (p.room) leaveRoom(p);
      const room = { code: newCode(), gameId: def.id, hostId: p.id, status: 'lobby', seats: def.seats.default, options: sanitizeOptions(def, {}), members: [], game: null, timer: null };
      rooms.set(room.code, room);
      addMember(room, p);
      broadcast(room);
    },

    join(p, msg) {
      const code = typeof msg.code === 'string' ? msg.code.trim().toUpperCase() : '';
      const room = rooms.get(code);
      applyProfile(p, msg);
      if (!room) return sendError(p, `No table with code ${code || '?'}`);
      if (p.room === code && room.members.some((m) => m.id === p.id)) return broadcast(room);
      if (room.status !== 'lobby') return sendError(p, 'That game has already started');
      if (room.members.length >= room.seats) return sendError(p, 'That table is full');
      if (p.room) leaveRoom(p);
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
      afterChange(room);
    },

    act(p, msg) {
      const room = rooms.get(p.room);
      if (!room || room.status !== 'playing' || !room.game) return sendError(p, 'No game in progress');
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

  function onHello(ws, msg) {
    let p = typeof msg.token === 'string' ? tokens.get(msg.token) : null;
    if (!p) {
      p = {
        id: 'p_' + crypto.randomBytes(6).toString('hex'),
        token: crypto.randomBytes(16).toString('hex'),
        name: 'Guest ' + (100 + crypto.randomInt(900)),
        avatar: pick(AVATARS),
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
    send(ws, { t: 'welcome', id: p.id, token: p.token, name: p.name, avatar: p.avatar, avatars: AVATARS, emotes: EMOTES, games: games.list() });
    const room = rooms.get(p.room);
    if (room) {
      broadcast(room);
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
      if (humans(room).some(isConnected)) room.idleSince = null;
      else if (!room.idleSince) room.idleSince = now;
      else if (now - room.idleSince > 10 * 60 * 1000) destroyRoom(room);
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

  return new Promise((resolve) => server.listen(port, () => resolve({ server, port: server.address().port, close })));
}

module.exports = { start };

if (require.main === module) {
  start().then(({ port }) => console.log(`Card Table running on http://localhost:${port}`));
}
