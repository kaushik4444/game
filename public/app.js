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
    avatar: store.get('ct_avatar') || '',
    avatars: [],
    emotes: [],
    named: !!store.get('ct_name'),
    invite: '',
    chat: [],
    chatOpen: false,
    unread: 0,
    skew: 0, // server clock minus this device's clock, for the turn countdown
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

  const isSpectator = () => !!(S.room && (S.room.spectators || []).some((s) => s.id === S.id));

  window.CardTable = Object.assign(window.CardTable || {}, {
    esc,
    toast,
    register: (id, p) => { plugins[id] = p; },
    chat: {
      button: () => `<button class="btn ghost small chat-btn" data-act="chat" aria-label="Open chat">💬<span class="cb" ${S.unread ? '' : 'hidden'}>${S.unread}</span></button>`,
    },
  });

  const gameMeta = (id) => S.games.find((g) => g.id === id);
  const inviteUrl = () => `${location.origin}/#${S.room.code}`;

  // ------------------------------------------------------------ rules dialog
  function showRules(gameId) {
    const g = gameMeta(gameId);
    if (!g) return;
    const variants = (g.options || [])
      .filter((o) => (o.type === 'select' || o.desc) && !o.noRules)
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
      send({ t: 'hello', token: S.token || undefined, name: S.name || undefined, avatar: S.avatar || undefined });
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
        S.avatars = m.avatars || [];
        S.emotes = m.emotes || [];
        if (!S.name) S.name = m.name;
        if (!S.avatar) S.avatar = m.avatar;
        store.set('ct_token', m.token);
        S.ready = true;
        const code = hashCode();
        if (code && !S.room) {
          if (S.named) send({ t: 'join', code, name: S.name, avatar: S.avatar });
          else S.invite = code; // first visit via an invite link: ask for a name before joining
        }
        render();
        break;
      }
      case 'emote':
        showEmote(m.id, m.e);
        CardTable.sound.play('emote');
        break;
      case 'chat':
        onChat(m.m);
        break;
      case 'chatlog':
        S.chat = m.messages || [];
        S.unread = 0;
        drawChat();
        updateBadges();
        break;
      case 'notice':
        toast(m.text);
        break;
      case 'state': {
        S.room = m.room;
        S.view = m.view;
        S.invite = '';
        S.skew = (m.room.now || Date.now()) - Date.now();
        setHash(m.room.code);
        soundsFor(prevView, m.view);
        prevView = m.view;
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
        S.chat = [];
        S.unread = 0;
        closeChat();
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
  const initial = (name) => esc([...name][0] || '?').toUpperCase();
  const avatar = (m) => `<span class="avatar" style="background:${avatarColor(m.name)}">${m.avatar ? esc(m.avatar) : initial(m.name)}</span>`;

  function profileHTML() {
    const picks = S.avatars
      .map((a) => `<button type="button" class="av-pick ${a === S.avatar ? 'on' : ''}" data-act="avatar" data-a="${esc(a)}" aria-label="Avatar ${esc(a)}" aria-pressed="${a === S.avatar}">${esc(a)}</button>`)
      .join('');
    const myName = S.named ? S.name : '';
    const initialChar = myName ? esc([...myName][0] || '?').toUpperCase() : '★';
    const previewBg = myName ? avatarColor(myName) : 'hsl(260 55% 42%)';
    return `<div class="profile">
      <div class="profile-header">
        <div class="profile-preview">
          <span class="avatar big" style="background:${previewBg}">${S.avatar ? esc(S.avatar) : initialChar}</span>
          <div class="profile-meta">
            <span class="profile-welcome">${myName ? `Playing as <b>${esc(myName)}</b>` : 'Choose your player persona'}</span>
            <span class="profile-hint">Seen by friends at the table</span>
          </div>
        </div>
      </div>
      <label class="label" for="name">Your name</label>
      <input id="name" type="text" maxlength="20" autocomplete="nickname" placeholder="Type your nickname" value="${esc(myName)}">
      <div class="label" style="margin-top:12px">Choose your avatar</div>
      <div class="av-picks">${picks}</div>
    </div>`;
  }

  let prevView = null;
  const bidSig = (v) => JSON.stringify(v.bids || (v.players || []).map((p) => (p.bid !== undefined && p.bid !== null ? p.bid : p.hasBid ? 1 : null)));
  /** Play a sound for whatever changed between two game views. */
  function soundsFor(a, b) {
    const snd = CardTable.sound;
    if (!b || !snd) return;
    if (!a || a.phase === undefined) return;
    if (b.phase === 'gameOver' && a.phase !== 'gameOver') return snd.play('fanfare');
    if ((b.phase === 'roundEnd' || b.phase === 'handEnd') && a.phase !== b.phase) return snd.play('round');
    if (b.lastTrick && (!a.lastTrick || JSON.stringify(a.lastTrick) !== JSON.stringify(b.lastTrick)) && b.trick && !b.trick.length) {
      snd.play(b.lastTrick.winner === b.me ? 'win' : 'card');
    } else if (b.trick && a.trick && b.trick.length > a.trick.length) snd.play('card');
    else if (b.phase === 'bidding' && bidSig(a) !== bidSig(b)) snd.play('tick');
    else if (a.phase !== b.phase && (b.phase === 'bidding' || b.phase === 'playing') && !(b.trick && b.trick.length)) snd.play('deal');
    // after a finished trick the winner is asked to lead only once the cards have been collected
    const trickDone = b.lastTrick && b.trick && !b.trick.length && (!a.lastTrick || a.trickNo !== b.trickNo || a.round !== b.round || a.handNo !== b.handNo);
    if (b.myTurn && (!a.myTurn || trickDone)) setTimeout(() => snd.play('turn'), trickDone ? CardTable.TRICK_HOLD_MS + 80 : 220);
  }

  function showEmote(id, e) {
    const seat = document.querySelector(`[data-pid="${CSS.escape(id)}"] .av`);
    const r = seat ? seat.getBoundingClientRect() : { left: innerWidth / 2, top: 80, width: 0, height: 0 };
    const el = document.createElement('div');
    el.className = 'emote-pop';
    el.textContent = e;
    el.style.left = r.left + r.width / 2 + 'px';
    el.style.top = r.top + r.height / 2 + 'px';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2500);
  }

  function toggleEmoteBar() {
    const old = document.getElementById('emote-bar');
    if (old) return old.remove();
    const bar = document.createElement('div');
    bar.id = 'emote-bar';
    bar.className = 'emote-bar';
    bar.innerHTML = S.emotes.map((e) => `<button type="button" data-e="${esc(e)}" aria-label="Send ${esc(e)}">${esc(e)}</button>`).join('');
    bar.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-e]');
      if (b) { send({ t: 'emote', e: b.dataset.e }); bar.remove(); }
    });
    document.body.appendChild(bar);
    setTimeout(() => document.addEventListener('click', function close(ev) {
      if (!bar.contains(ev.target)) { bar.remove(); document.removeEventListener('click', close); }
      else if (!bar.isConnected) document.removeEventListener('click', close);
    }), 0);
  }

  // ------------------------------------------------------------ chat, watchers, turn timer
  const $chat = document.createElement('div');
  $chat.id = 'chat';
  $chat.className = 'chat';
  $chat.hidden = true;
  $chat.innerHTML = `<div class="chat-head"><b>Table chat</b><span class="chat-watch"></span><button type="button" class="chat-x" data-chat="close" aria-label="Close chat">✕</button></div>
    <div class="chat-list" id="chat-list" aria-live="polite"></div>
    <form class="chat-form" id="chat-form"><input id="chat-input" type="text" maxlength="200" placeholder="Say something…" autocomplete="off"><button class="btn small" type="submit">Send</button></form>`;
  document.body.appendChild($chat);
  const $watch = document.createElement('button');
  $watch.id = 'watchers';
  $watch.type = 'button';
  $watch.className = 'watchers';
  $watch.hidden = true;
  document.body.appendChild($watch);

  function msgHTML(m) {
    if (m.sys) return `<div class="msg sys">${esc(m.text)}</div>`;
    const mine = m.id === S.id;
    return `<div class="msg ${mine ? 'mine' : ''}"><span class="mav" style="background:${avatarColor(m.name)}">${m.avatar ? esc(m.avatar) : initial(m.name)}</span><div class="mb"><b>${esc(m.name)}${m.spec ? ' <i title="Spectator">👁</i>' : ''}</b><p>${esc(m.text)}</p></div></div>`;
  }
  function drawChat() {
    const list = document.getElementById('chat-list');
    if (!list) return;
    list.innerHTML = S.chat.length ? S.chat.map(msgHTML).join('') : '<p class="hint">No messages yet. Say hello!</p>';
    list.scrollTop = list.scrollHeight;
    const w = S.room && S.room.spectators && S.room.spectators.length ? `👁 ${S.room.spectators.map((x) => esc(x.name)).join(', ')} watching` : '';
    $chat.querySelector('.chat-watch').innerHTML = w;
  }
  function updateBadges() {
    document.querySelectorAll('[data-act="chat"] .cb').forEach((el) => {
      el.textContent = S.unread;
      el.hidden = !S.unread;
    });
  }
  function onChat(m) {
    S.chat.push(m);
    if (S.chat.length > 60) S.chat.shift();
    if (S.chatOpen) drawChat();
    else if (!m.sys && m.id !== S.id) {
      S.unread++;
      updateBadges();
      CardTable.sound.play('chat');
    }
  }
  function openChat() {
    S.chatOpen = true;
    S.unread = 0;
    $chat.hidden = false;
    drawChat();
    updateBadges();
    const inp = document.getElementById('chat-input');
    if (inp && !matchMedia('(pointer: coarse)').matches) inp.focus();
  }
  function closeChat() {
    S.chatOpen = false;
    $chat.hidden = true;
  }
  $chat.addEventListener('click', (e) => { if (e.target.closest('[data-chat="close"]')) closeChat(); });
  $chat.addEventListener('submit', (e) => {
    e.preventDefault();
    const inp = document.getElementById('chat-input');
    const text = inp.value.trim();
    if (text) send({ t: 'chat', text });
    inp.value = '';
  });
  $watch.addEventListener('click', openChat);

  function updateWatchers() {
    const sp = (S.room && S.room.spectators) || [];
    if (!S.room || !sp.length) {
      $watch.hidden = true;
      return;
    }
    const names = sp.map((x) => x.name);
    const shown = names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', ');
    $watch.textContent = isSpectator() ? `👁 You are watching · ${sp.length} spectator${sp.length === 1 ? '' : 's'}` : `👁 ${shown} watching`;
    $watch.hidden = false;
  }

  let lastTickSec = -1;
  function updateTimer() {
    const dl = S.room && S.room.status === 'playing' ? S.room.deadline : null;
    const left = dl ? Math.max(0, Math.ceil((dl - (Date.now() + S.skew)) / 1000)) : null;
    document.querySelectorAll('.ct-timer').forEach((el) => {
      if (left === null) {
        el.hidden = true;
        return;
      }
      el.hidden = false;
      el.textContent = `⏱ ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
      el.classList.toggle('warn', left <= 10);
    });
    if (left !== null && left <= 5 && left > 0 && left !== lastTickSec && S.view && S.view.myTurn) CardTable.sound.play('tick');
    lastTickSec = left === null ? -1 : left;
  }
  setInterval(updateTimer, 500);

  const range = (s) => (s.min === s.max ? `${s.min} players` : `${s.min}–${s.max} players`);

  function render() {
    // keep the cursor in the name box when the screen is redrawn (e.g. someone joins while you type)
    const ae = document.activeElement;
    const keep = ae && ae.id === 'name' ? { start: ae.selectionStart, end: ae.selectionEnd } : null;
    if (!S.ready && !S.room) {
      $app.innerHTML = '<div class="page"><div class="brand"><div class="mark">🂡</div><h1>Card Table</h1><p>Connecting…</p></div></div>';
    } else if (!S.room && S.invite) renderInvite();
    else if (!S.room) renderHome();
    else if (S.room.status === 'lobby') renderLobby();
    else renderGame();
    updateWatchers();
    if ($chat && S.chatOpen) drawChat();
    if (keep) {
      const el = document.getElementById('name');
      if (el) {
        el.focus();
        try { el.setSelectionRange(keep.start, keep.end); } catch { /* ignore */ }
      }
    }
  }

  function renderInvite() {
    $app.innerHTML = `
    <main class="page">
      <header class="brand"><span class="brand-snd">${CardTable.sound.button()}</span>
        <div class="mark">🂡</div>
        <h1>You’re invited!</h1>
        <p>Join table <b class="code-inline">${esc(S.invite)}</b> on Card Table. Pick a name and an avatar so your friends know who you are.</p>
      </header>
      <section class="panel">${profileHTML()}</section>
      <button class="btn big" data-act="joinInvite">Join table ${esc(S.invite)}</button>
      <button class="btn ghost" data-act="cancelInvite">Not now</button>
    </main>`;
  }

  function renderHome() {
    const tiles = S.games
      .map(
        (g) => `
      <article class="panel game-tile" style="--accent:${esc(g.accent || '#7b4bd0')}">
        <div class="game-art" aria-hidden="true">${esc(g.icon || '🎴')}</div>
        <div class="game-body">
          <div class="game-header">
            <h3>${esc(g.name)}</h3>
            <span class="game-badge">${range(g.seats)}</span>
          </div>
          <p>${esc(g.tagline)}</p>
          <div class="game-meta-tags">
            <span class="meta-pill">🤖 AI Bots fill seats</span>
            <span class="meta-pill">⚡ Instant join</span>
            <span class="meta-pill">💬 Live chat</span>
          </div>
          <div class="row game-actions">
            <button class="btn" data-act="create" data-game="${esc(g.id)}">Create a table</button>
            <button class="btn ghost" data-act="rules" data-game="${esc(g.id)}">How to play</button>
          </div>
        </div>
      </article>`
      )
      .join('');
    $app.innerHTML = `
    <main class="page wide home-arena">
      <header class="brand">
        <span class="brand-snd">${CardTable.sound.button()}</span>
        <div class="arena-tag">⚔️ MULTIPLAYER ARENA</div>
        <div class="mark">🂡</div>
        <h1>Card Table</h1>
        <p class="brand-desc">Real-time card and board games with friends. Instant rooms, smart bots, authentic gameplay — right in your browser.</p>
        <div class="arena-features">
          <span class="feat-badge">✨ No app install required</span>
          <span class="feat-badge">📱 Mobile & desktop ready</span>
          <span class="feat-badge">🛡️ Fair hidden-state deals</span>
        </div>
      </header>
      <div class="home-grid">
        <section class="panel profile-panel">
          <div class="panel-tag">PLAYER IDENTITY</div>
          ${profileHTML()}
        </section>
        <section class="panel join-panel">
          <div class="panel-tag">QUICK ACCESS</div>
          <label class="label" for="code">Have a table code? Jump in</label>
          <p class="join-sub">Enter the 4-letter code shared by your friend to join their game table immediately.</p>
          <form class="join-form" id="joinForm">
            <input id="code" type="text" maxlength="4" placeholder="ABCD" autocomplete="off" autocapitalize="characters" spellcheck="false" value="${esc(S.draftCode)}">
            <button class="btn big-join" type="submit">Join Table</button>
          </form>
          <div class="join-tips">💡 Anyone can also join via direct link: <code>site/#CODE</code></div>
        </section>
      </div>
      <div class="section-head">
        <h2 class="section">Featured Games</h2>
        <span class="section-sub">Pick a card game and host a private table for your friends</span>
      </div>
      <section class="game-grid">${tiles}</section>
      <div class="roadmap-box panel">
        <span class="roadmap-icon">🧭</span>
        <div>
          <b>More arena games coming soon:</b>
          <p>Poker (Texas Hold'em), The Mind, and Saboteur are actively in development!</p>
        </div>
      </div>
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
    const spectating = isSpectator();
    const seats = [];
    for (let i = 0; i < r.seats; i++) {
      const m = r.members[i];
      const label = r.seatLabels ? `<span class="tag team t${i % 2}">${esc(r.seatLabels[i])}</span>` : '';
      if (m) {
        seats.push(`
      <li class="seat">
        ${avatar(m)}
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
        <span class="row" style="gap:6px">${CardTable.chat.button()}<button class="btn ghost small" data-act="rules" data-game="${esc(r.gameId)}">Rules</button></span>
      </div>
      ${spectating ? `<section class="panel"><h3>👁 You are watching</h3><p class="hint" style="text-align:left;margin:6px 0 10px">The next game starts when the host presses Start. ${open > 0 ? 'There is an open seat if you want to play.' : 'Ask the host to free a seat if you want to play.'}</p>${open > 0 ? '<button class="btn" data-act="sit">Take a seat</button>' : ''}</section>` : ''}
      ${r.spectators && r.spectators.length ? `<p class="label" style="text-align:center">👁 Watching: ${r.spectators.map((x) => esc(x.name)).join(', ')}</p>` : ''}
      <section class="panel code-card">
        <div class="label">Table code · share it with your friends</div>
        <div class="code">${esc(r.code)}</div>
        <div class="row" style="justify-content:center">
          <button class="btn small" data-act="copyLink">Copy invite link</button>
          <button class="btn small wa" data-act="whatsapp">WhatsApp</button>
          ${navigator.share ? '<button class="btn ghost small" data-act="share">Share…</button>' : ''}
        </div>
      </section>
      <section class="panel">${profileHTML()}</section>
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
        const playing = S.room.status === 'playing' && !isSpectator();
        if (!playing || confirm('Leave the game? A bot will take your seat.')) send({ t: 'leave' });
      },
      rematch: () => send({ t: 'rematch' }),
      showRules: () => showRules(S.room.gameId),
      rerender: render,
      toast,
    });
    const bar = $app.querySelector('.wz-status');
    if (bar) bar.insertAdjacentHTML('beforeend', '<span class="ct-timer" hidden></span>');
    updateTimer();
  }

  // ------------------------------------------------------------ events
  const actions = {
    avatar: (el) => {
      S.avatar = el.dataset.a;
      store.set('ct_avatar', S.avatar);
      send({ t: 'setName', name: S.name || undefined, avatar: S.avatar });
      render();
    },
    emotes: () => toggleEmoteBar(),
    sound: () => { CardTable.sound.toggle(); render(); },
    joinInvite: () => {
      if (!S.named || !S.name) return toast('Please type your name first');
      store.set('ct_name', S.name);
      send({ t: 'join', code: S.invite, name: S.name, avatar: S.avatar });
    },
    cancelInvite: () => {
      S.invite = '';
      setHash('');
      render();
    },
    create: (el) => send({ t: 'create', gameId: el.dataset.game, name: S.name || undefined, avatar: S.avatar || undefined }),
    leave: () => send({ t: 'leave' }),
    chat: () => (S.chatOpen ? closeChat() : openChat()),
    sit: () => send({ t: 'sit' }),
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
      S.named = !!S.name;
      if (S.name) store.set('ct_name', S.name);
      clearTimeout(nameTimer);
      nameTimer = setTimeout(() => S.name && send({ t: 'setName', name: S.name, avatar: S.avatar || undefined }), 400);
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
      if (S.draftCode.length === 4) send({ t: 'join', code: S.draftCode, name: S.name || undefined, avatar: S.avatar || undefined });
      else toast('Enter the 4-letter table code');
    }
  });

  connect();
})();
