/* Card Table client: connection, home, lobby. Games render themselves via CardTable.register(). */
(() => {
  'use strict';

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };

  const $app = document.getElementById('app');
  const $banner = document.getElementById('banner');
  const $toasts = document.getElementById('toasts');

  const S = {
    id: null,
    token: store.get('ct_token'),
    name: store.get('ct_name') || '',
    games: [],
    room: null,
    view: null,
    ready: false,
    draftCode: '',
  };
  const plugins = {};
  let ws = null;
  let retry = 0;
  let wasMyTurn = false;
  let nameTimer = null;

  function toast(text) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    $toasts.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  window.CardTable = { esc, toast, register: (id, p) => { plugins[id] = p; } };

  const gameMeta = (id) => S.games.find((g) => g.id === id);
  const inviteUrl = () => `${location.origin}/#${S.room.code}`;

  // ------------------------------------------------------------ rules dialog
  function showRules(gameId) {
    const g = gameMeta(gameId);
    if (!g) return;
    const variants = (g.options || [])
      .filter((o) => o.type === 'select' || o.desc)
      .map((o) => {
        if (o.type === 'boolean') return `<dt>${esc(o.label)}</dt><dd>${esc(o.desc)}</dd>`;
        return o.choices.filter((c) => c.value !== o.default || o.choices.length > 2).map((c) => `<dt>${esc(o.label)}: ${esc(c.label)}</dt><dd>${esc(c.desc)}</dd>`).join('');
      })
      .join('');
    const el = document.createElement('div');
    el.className = 'overlay';
    el.innerHTML = `<div class="sheet" role="dialog" aria-label="How to play ${esc(g.name)}">
      <h2>${esc(g.icon)} How to play ${esc(g.name)}</h2>
      ${(g.rules || []).map((p) => `<p class="rule">${esc(p)}</p>`).join('')}
      ${variants ? `<h3 style="margin:16px 0 6px">Options</h3><dl class="variants">${variants}</dl>` : ''}
      <div class="row" style="margin-top:14px"><button class="btn" data-close="1">Got it</button></div></div>`;
    el.addEventListener('click', (e) => { if (e.target === el || e.target.closest('[data-close]')) el.remove(); });
    document.body.appendChild(el);
  }
  window.CardTable.showRules = showRules;

  // ------------------------------------------------------------ connection
  const send = (msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };

  function connect() {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onopen = () => {
      retry = 0;
      $banner.hidden = true;
      send({ t: 'hello', token: S.token || undefined, name: S.name || undefined });
    };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      onMessage(m);
    };
    ws.onclose = (e) => {
      S.ready = false;
      if (e.code === 4000) {
        $banner.textContent = 'Card Table is open in another tab. Reload to play here.';
        $banner.hidden = false;
        return;
      }
      $banner.textContent = 'Reconnecting…';
      $banner.hidden = false;
      setTimeout(connect, Math.min(5000, 500 * 2 ** retry++));
    };
  }

  const hashCode = () => {
    const c = decodeURIComponent(location.hash.slice(1)).toUpperCase();
    return /^[A-Z]{4}$/.test(c) ? c : '';
  };
  const setHash = (code) => {
    try { history.replaceState(null, '', code ? '#' + code : location.pathname + location.search); } catch { /* ignore */ }
  };

  function onMessage(m) {
    switch (m.t) {
      case 'welcome': {
        S.id = m.id;
        S.token = m.token;
        S.games = m.games;
        if (!S.name) S.name = m.name;
        store.set('ct_token', m.token);
        S.ready = true;
        const code = hashCode();
        if (code) send({ t: 'join', code, name: S.name });
        render();
        break;
      }
      case 'state': {
        S.room = m.room;
        S.view = m.view;
        setHash(m.room.code);
        const mine = !!(m.view && m.view.myTurn);
        if (mine && !wasMyTurn) {
          try { navigator.vibrate && navigator.vibrate(70); } catch { /* ignore */ }
          if (document.hidden) document.title = '● Your turn · Card Table';
        }
        wasMyTurn = mine;
        render();
        break;
      }
      case 'left':
        S.room = null;
        S.view = null;
        wasMyTurn = false;
        setHash('');
        render();
        break;
      case 'error':
        toast(m.message);
        if (!S.room && hashCode()) setHash('');
        break;
    }
  }

  document.addEventListener('visibilitychange', () => { if (!document.hidden) document.title = 'Card Table'; });

  // ------------------------------------------------------------ rendering
  const avatarColor = (s) => {
    let h = 0;
    for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return `hsl(${h} 55% 42%)`;
  };
  const avatar = (name, bot) => `<span class="avatar" style="background:${avatarColor(name)}">${bot ? '🤖' : esc([...name][0] || '?').toUpperCase()}</span>`;
  const range = (s) => (s.min === s.max ? `${s.min} players` : `${s.min}–${s.max} players`);

  function render() {
    if (!S.ready && !S.room) {
      $app.innerHTML = '<div class="page"><div class="brand"><div class="mark">🂡</div><h1>Card Table</h1><p>Connecting…</p></div></div>';
    } else if (!S.room) renderHome();
    else if (S.room.status === 'lobby') renderLobby();
    else renderGame();
  }

  function renderHome() {
    const tiles = S.games
      .map(
        (g) => `
      <article class="panel game-tile" style="--accent:${esc(g.accent || '#7b4bd0')}">
        <div class="game-art" aria-hidden="true">${esc(g.icon || '🎴')}</div>
        <div class="game-body">
          <h3>${esc(g.name)}</h3>
          <p>${esc(g.tagline)}</p>
          <div class="meta">${range(g.seats)} · bots can fill seats</div>
          <div class="row">
            <button class="btn" data-act="create" data-game="${esc(g.id)}">Create a table</button>
            <button class="btn ghost" data-act="rules" data-game="${esc(g.id)}">How to play</button>
          </div>
        </div>
      </article>`
      )
      .join('');
    $app.innerHTML = `
    <main class="page wide">
      <header class="brand">
        <div class="mark">🂡</div>
        <h1>Card Table</h1>
        <p>Card and board games with friends, right in your browser. Phone or desktop, nothing to install.</p>
      </header>
      <div class="home-grid">
        <section class="panel">
          <label class="label" for="name">Your name</label>
          <input id="name" type="text" maxlength="20" autocomplete="nickname" value="${esc(S.name)}">
        </section>
        <section class="panel">
          <label class="label" for="code">Have a code? Join a table</label>
          <form class="join-form" id="joinForm">
            <input id="code" type="text" maxlength="4" placeholder="ABCD" autocomplete="off" autocapitalize="characters" spellcheck="false" value="${esc(S.draftCode)}">
            <button class="btn" type="submit">Join</button>
          </form>
        </section>
      </div>
      <h2 class="section">Choose a game</h2>
      <section class="game-grid">${tiles}</section>
      <p class="foot">More games are on the way.</p>
    </main>`;
  }

  function optionHTML(o, r, isHost) {
    const dis = isHost ? '' : 'disabled';
    if (o.type === 'boolean') {
      return `<div class="opt-card"><label class="opt"><input type="checkbox" data-opt="${esc(o.key)}" ${r.options[o.key] ? 'checked' : ''} ${dis}><span><b>${esc(o.label)}</b></span></label>${o.desc ? `<p class="opt-desc">${esc(o.desc)}</p>` : ''}</div>`;
    }
    const cur = o.choices.find((c) => c.value === r.options[o.key]) || o.choices[0];
    return `<div class="opt-card"><label class="opt-label" for="opt-${esc(o.key)}">${esc(o.label)}</label>
      <select id="opt-${esc(o.key)}" data-opt="${esc(o.key)}" ${dis}>${o.choices.map((c) => `<option value="${esc(c.value)}" ${c.value === cur.value ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select>
      <p class="opt-desc">${esc(cur.desc)}</p></div>`;
  }

  function renderLobby() {
    const r = S.room;
    const g = gameMeta(r.gameId) || { name: r.gameId, options: [], seats: { min: r.min, max: r.max }, icon: '🎴' };
    const isHost = r.hostId === S.id;
    const n = r.members.length;
    const open = r.seats - n;
    const seats = [];
    for (let i = 0; i < r.seats; i++) {
      const m = r.members[i];
      const label = r.seatLabels ? `<span class="tag team t${i % 2}">${esc(r.seatLabels[i])}</span>` : '';
      if (m) {
        seats.push(`
      <li class="seat">
        ${avatar(m.name, m.bot)}
        <span class="nm">${esc(m.name)}${m.id === S.id ? ' <em>(you)</em>' : ''}</span>
        ${label}
        ${m.id === r.hostId ? '<span class="tag host">host</span>' : ''}
        <span class="dot ${m.connected ? '' : 'off'}" title="${m.connected ? 'online' : 'offline'}"></span>
        ${isHost && m.bot ? `<button class="btn ghost small" data-act="removeBot" data-id="${esc(m.id)}" aria-label="Remove ${esc(m.name)}">✕</button>` : ''}
      </li>`);
      } else {
        seats.push(`<li class="seat empty"><span class="avatar ghost">?</span><span class="nm">Open seat</span>${label}</li>`);
      }
    }
    const stepper =
      g.seats.min !== g.seats.max
        ? `<div class="stepper" role="group" aria-label="Number of players">
            <button class="btn ghost small" data-act="seats" data-n="${r.seats - 1}" ${isHost && r.seats > g.seats.min ? '' : 'disabled'} aria-label="Fewer players">−</button>
            <span><b>${r.seats}</b> players</span>
            <button class="btn ghost small" data-act="seats" data-n="${r.seats + 1}" ${isHost && r.seats < g.seats.max ? '' : 'disabled'} aria-label="More players">+</button>
          </div>`
        : `<span class="label">${r.seats} players</span>`;
    const opts = (g.options || []).map((o) => optionHTML(o, r, isHost)).join('');
    $app.innerHTML = `
    <main class="page">
      <div class="row" style="justify-content:space-between">
        <button class="btn ghost small" data-act="leave">← Leave</button>
        <h2>${esc(g.icon)} ${esc(g.name)}</h2>
        <button class="btn ghost small" data-act="rules" data-game="${esc(r.gameId)}">Rules</button>
      </div>
      <section class="panel code-card">
        <div class="label">Table code · share it with your friends</div>
        <div class="code">${esc(r.code)}</div>
        <div class="row" style="justify-content:center">
          <button class="btn small" data-act="copyLink">Copy invite link</button>
          <button class="btn small wa" data-act="whatsapp">WhatsApp</button>
          ${navigator.share ? '<button class="btn ghost small" data-act="share">Share…</button>' : ''}
        </div>
      </section>
      <section class="panel">
        <div class="row" style="justify-content:space-between">
          <h3>Players <span class="label">${n} joined</span></h3>
          ${isHost ? stepper : `<span class="label">${r.seats} seats</span>`}
        </div>
        <ul class="seats">${seats.join('')}</ul>
        ${isHost && open > 0 ? `<div class="row" style="margin-top:12px"><button class="btn ghost small" data-act="addBot">+ Add a bot</button><button class="btn ghost small" data-act="fillBots">Fill ${open} open seat${open === 1 ? '' : 's'} with bots</button></div>` : ''}
      </section>
      ${opts ? `<section class="panel"><h3 style="margin-bottom:10px">Variants &amp; options</h3><div class="opts">${opts}</div>${isHost ? '' : '<p class="hint" style="margin-top:8px">Only the host can change these.</p>'}</section>` : ''}
      ${
        isHost
          ? `<button class="btn big" data-act="start">Start game${open > 0 ? ` <small>· ${open} bot${open === 1 ? '' : 's'} will join</small>` : ''}</button>`
          : '<p class="label" style="text-align:center">Waiting for the host to start…</p>'
      }
    </main>`;
  }

  function renderGame() {
    const plugin = plugins[S.room.gameId];
    if (!plugin || !S.view) {
      $app.innerHTML = '<div class="page"><p>This game is not available in your browser version. Reload the page.</p></div>';
      return;
    }
    plugin.render($app, S.view, {
      room: S.room,
      game: gameMeta(S.room.gameId),
      isHost: S.room.hostId === S.id,
      act: (action) => send({ t: 'act', action }),
      leave: () => {
        const playing = S.room.status === 'playing';
        if (!playing || confirm('Leave the game? A bot will take your seat.')) send({ t: 'leave' });
      },
      rematch: () => send({ t: 'rematch' }),
      showRules: () => showRules(S.room.gameId),
      rerender: render,
      toast,
    });
  }

  // ------------------------------------------------------------ events
  const actions = {
    create: (el) => send({ t: 'create', gameId: el.dataset.game, name: S.name || undefined }),
    leave: () => send({ t: 'leave' }),
    rules: (el) => showRules(el.dataset.game),
    addBot: () => send({ t: 'addBot' }),
    fillBots: () => {
      for (let i = 0; i < S.room.seats - S.room.members.length; i++) send({ t: 'addBot' });
    },
    removeBot: (el) => send({ t: 'removeBot', id: el.dataset.id }),
    seats: (el) => send({ t: 'setSeats', seats: Number(el.dataset.n) }),
    start: () => send({ t: 'start' }),
    copyLink: async () => {
      try {
        await navigator.clipboard.writeText(inviteUrl());
        toast('Invite link copied');
      } catch {
        window.prompt('Copy this link:', inviteUrl());
      }
    },
    whatsapp: () => {
      const g = gameMeta(S.room.gameId);
      const text = `Join my ${g ? g.name : 'card'} table on Card Table: ${inviteUrl()} (code ${S.room.code})`;
      window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener');
    },
    share: () => {
      navigator.share({ title: 'Card Table', text: `Join my table (code ${S.room.code})`, url: inviteUrl() }).catch(() => {});
    },
  };

  $app.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (el && !el.disabled && Object.hasOwn(actions, el.dataset.act)) actions[el.dataset.act](el);
  });
  $app.addEventListener('input', (e) => {
    if (e.target.id === 'name') {
      S.name = e.target.value.trim().slice(0, 20);
      store.set('ct_name', S.name);
      clearTimeout(nameTimer);
      nameTimer = setTimeout(() => S.name && send({ t: 'setName', name: S.name }), 400);
    } else if (e.target.id === 'code') {
      e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '');
      S.draftCode = e.target.value;
    }
  });
  $app.addEventListener('change', (e) => {
    if (e.target.dataset && e.target.dataset.opt && S.room) {
      const options = {};
      $app.querySelectorAll('[data-opt]').forEach((c) => { options[c.dataset.opt] = c.type === 'checkbox' ? c.checked : c.value; });
      send({ t: 'setOptions', options });
    }
  });
  $app.addEventListener('submit', (e) => {
    if (e.target.id === 'joinForm') {
      e.preventDefault();
      if (S.draftCode.length === 4) send({ t: 'join', code: S.draftCode, name: S.name || undefined });
      else toast('Enter the 4-letter table code');
    }
  });

  connect();
})();
