/* Card Table client: connection, home, lobby. Games render themselves via CardTable.register(). */
(() => {
  'use strict';

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
    remove(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
  };
  // Older versions kept a bearer token here. The session is now an HttpOnly cookie, so the old value is never used: delete it.
  store.remove('ct_token');

  const $app = document.getElementById('app');
  const $banner = document.getElementById('banner');
  const $toasts = document.getElementById('toasts');

  const S = {
    id: null,
    token: '', // short-lived websocket auth credential (never persisted)
    csrf: '', // fetched from the server (cookie-backed), never stored
    emailVerified: false,
    email: '',
    name: store.get('ct_name') || '',
    username: store.get('ct_username') || '',
    games: [],
    room: null,
    view: null,
    ready: false,
    draftCode: '',
    avatar: store.get('ct_avatar') || '',
    avatars: [],
    emotes: [],
    named: !!store.get('ct_name'),
    chat: [],
    chatOpen: false,
    unread: 0,
    skew: 0, // server clock minus this device's clock, for the turn countdown
    announcement: '',
    dismissedAnnouncement: store.get('ct_ann'), // the text that was dismissed, so a changed announcement shows again
    recentTables: (() => { try { return JSON.parse(store.get('ct_recent') || '[]'); } catch { return []; } })(),
    publicTables: [],
    rejoin: [], // running games where a bot is playing this player's seat
    avatarOpen: false,
    menuOpen: false, // the account dropdown in the top bar
    wnSeen: store.get('ct_wn_seen') || '', // the last What's new version this person opened
    createVisibility: 'private',
    sessionListOpen: store.get('ct_sessions_open') !== '0',
    guest: false, // true when the home screen is the public snapshot (no socket, no session)
    auth: null, // the open auth sheet: 'login' or 'register'
    requireEmailVerification: true, // current server policy; secure default until the server says otherwise
    pending: [], // play actions that wait for a successful login, then run once the lobby opens
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

  // ------------------------------------------------------------ auth + connection
  const send = (msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };

  // CSRF: the server sets a ct_csrf cookie; every POST repeats its value in a header (the cookie alone proves nothing).
  async function ensureCsrf(force) {
    if (S.csrf && !force) return S.csrf;
    try {
      const r = await fetch('/api/auth/csrf', { credentials: 'same-origin' });
      const out = await r.json();
      S.csrf = (out && out.csrfToken) || '';
    } catch { S.csrf = ''; }
    return S.csrf;
  }

  async function postJson(url, body, retried) {
    await ensureCsrf();
    const r = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': S.csrf },
      body: JSON.stringify(body || {}),
    });
    let data = {};
    try { data = await r.json(); } catch { /* ignore */ }
    if (r.status === 403 && /CSRF/i.test(data.error || '') && !retried) { // cookie expired or was cleared: fetch a fresh pair once
      await ensureCsrf(true);
      return postJson(url, body, true);
    }
    if (data && data.csrfToken) S.csrf = data.csrfToken;
    if (!r.ok || data.ok === false) throw new Error(data.error || `Request failed (${r.status})`);
    return data;
  }

  async function hydrateSession() {
    try {
      const r = await fetch('/api/auth/session', { credentials: 'same-origin' });
      const out = await r.json();
      if (out && out.csrfToken) S.csrf = out.csrfToken;
      if (out && out.ok) S.requireEmailVerification = policyRequiresVerification(out); // secure default stays true when field is missing/invalid
      if (!out || !out.ok || !out.authenticated) return false;
      S.name = out.player && out.player.display_name ? out.player.display_name : S.name;
      S.username = out.player && out.player.username ? out.player.username : S.username;
      S.avatar = out.player && out.player.avatar ? out.player.avatar : S.avatar;
      S.emailVerified = !!out.emailVerified;
      S.email = out.player && out.player.email ? out.player.email : '';
      S.named = !!S.name;
      if (S.name) store.set('ct_name', S.name);
      if (S.username) store.set('ct_username', S.username);
      if (S.avatar) store.set('ct_avatar', S.avatar);
      return true;
    } catch {
      return false;
    }
  }

  function clearClientSession() {
    S.token = '';
    S.csrf = '';
    S.emailVerified = false;
    S.email = '';
    S.id = null;
    store.set('ct_csrf', ''); // older versions kept it in localStorage
  }

  async function doLogoutAll() {
    try {
      await postJson('/api/auth/logout-all', {});
    } catch {
      // ignore network failures; clear local state regardless
    }
    S.signedOutIntentionally = true;
    clearClientSession();
    S.ready = false;
    S.room = null;
    S.view = null;
    loadSnapshot();
    toast('Logged out everywhere.');
  }

  async function doLogout() {
    try {
      await postJson('/api/auth/logout', {});
    } catch {
      // ignore network failures; clear local state regardless
    }
    S.signedOutIntentionally = true;
    clearClientSession();
    S.ready = false;
    S.room = null;
    S.view = null;
    loadSnapshot();
    toast('Logged out.');
  }

  function policyRequiresVerification(out) {
    if (Object.prototype.hasOwnProperty.call(out || {}, 'emailVerificationRequired')) return !!out.emailVerificationRequired;
    if (Object.prototype.hasOwnProperty.call(out || {}, 'requiresVerification')) return !!out.requiresVerification;
    return true;
  }

  function authPolicyHintHTML() {
    if (S.requireEmailVerification) {
      return '<p class="auth-policy-hint">Email verification is required before entering the lobby.</p>';
    }
    return '<p class="auth-policy-hint optional" role="status">Friend-testing mode: email verification is optional right now. You can play immediately after creating your account.</p>';
  }

  // The auth sheet: a small dialog over the (public) home page. Logging in is never a place you get sent to —
  // it is a step you take when you try to play, and afterwards you land where you were heading.
  function openAuthSheet(tab = 'login', msg = '') {
    S.auth = tab;
    closeOverlay();
    const loginOn = tab === 'login';
    const resend = S.requireEmailVerification ? '<button class="btn ghost small" data-act="resendVerification">Resend verification email</button>' : '';
    const overlay = document.createElement('div');
    overlay.id = 'auth-overlay';
    overlay.className = 'overlay';
    overlay.innerHTML = `<div class="sheet auth-sheet" data-stop="1" role="dialog" aria-label="${loginOn ? 'Log in' : 'Create account'}">
      <div class="row" style="justify-content:space-between"><h2>${loginOn ? 'Welcome back' : 'Create your account'}</h2><button class="btn ghost small" data-auth-close aria-label="Close">✕</button></div>
      ${msg ? `<p class="auth-msg" role="status">${esc(msg)}</p>` : ''}
      <div class="row auth-tabs">
        <button class="btn ${loginOn ? '' : 'ghost'} small" data-act="showLogin">Log in</button>
        <button class="btn ${loginOn ? 'ghost' : ''} small" data-act="showRegister">Create account</button>
      </div>
      ${loginOn ? `
        <form id="loginForm" class="auth-form">
          <input id="loginEmail" type="email" required placeholder="Email" autocomplete="email">
          <input id="loginPassword" type="password" required minlength="8" placeholder="Password" autocomplete="current-password">
          <button class="btn big" type="submit">Log in</button>
        </form>
        <div class="row auth-links"><button class="btn ghost small" data-act="forgotPassword">Forgot password?</button>${resend}</div>
      ` : `
        <form id="registerForm" class="auth-form">
          <input id="registerName" type="text" maxlength="20" required placeholder="Display name" autocomplete="nickname">
          <input id="registerUsername" type="text" maxlength="24" required pattern="[a-z0-9_]{3,24}" placeholder="Username (lowercase)" autocomplete="username">
          <small id="registerUsernameHint" class="hint"></small>
          <input id="registerEmail" type="email" required placeholder="Email" autocomplete="email">
          ${authPolicyHintHTML()}
          <input id="registerPassword" type="password" required minlength="8" placeholder="Password (8+ characters)" autocomplete="new-password">
          <button class="btn big" type="submit">Create account</button>
        </form>
      `}
    </div>`;
    overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target.closest('[data-auth-close]')) closeOverlay(); });
    document.body.appendChild(overlay);
    const first = document.getElementById(loginOn ? 'loginEmail' : 'registerName');
    if (first && !matchMedia('(pointer: coarse)').matches) first.focus();
    if (!loginOn) {
      const u = document.getElementById('registerUsername');
      if (u) u.addEventListener('input', async () => {
        const hint = document.getElementById('registerUsernameHint');
        const value = String(u.value || '').trim().toLowerCase();
        if (!hint) return;
        if (!value) { hint.textContent = ''; return; }
        if (!/^[a-z0-9_]{3,24}$/.test(value)) { hint.textContent = 'Use 3-24 chars: lowercase letters, numbers, underscore.'; return; }
        try {
          const out = await fetch(`/api/auth/username-available?username=${encodeURIComponent(value)}`).then((r) => r.json());
          hint.textContent = out.available ? 'Username is available.' : 'Username is already taken.';
        } catch { hint.textContent = ''; }
      });
    }
  }

  function closeOverlay() {
    const el = document.getElementById('auth-overlay');
    if (el) el.remove();
    S.auth = null;
  }

  async function doLogin(email, password) {
    const out = await postJson('/api/auth/login', { email, password });
    S.token = '';
    if (out.csrfToken) S.csrf = out.csrfToken;
    S.name = out.player && out.player.display_name ? out.player.display_name : S.name;
    S.username = out.player && out.player.username ? out.player.username : S.username;
    S.avatar = out.player && out.player.avatar ? out.player.avatar : S.avatar;
    S.email = out.player && out.player.email ? out.player.email : '';
    S.named = !!S.name;
    S.requireEmailVerification = policyRequiresVerification(out);
    S.emailVerified = !!(out.player && out.player.email_verified);
    S.signedOutIntentionally = false;
    if (S.name) store.set('ct_name', S.name);
    if (S.username) store.set('ct_username', S.username);
    if (S.avatar) store.set('ct_avatar', S.avatar);
    if (S.requireEmailVerification && !S.emailVerified) {
      openAuthSheet('login', 'Please verify your email before playing. Use “Resend verification email” if the link did not arrive.');
      return;
    }
    closeOverlay();
    connect();
    if (!S.emailVerified) toast('Email verification pending. Friend-testing mode lets you play while unverified.');
  }

  async function doRegister(name, username, email, password) {
    const out = await postJson('/api/auth/register', { displayName: name, username, email, password, avatar: S.avatar || undefined });
    S.token = '';
    if (out.csrfToken) S.csrf = out.csrfToken;
    S.name = out.player && out.player.display_name ? out.player.display_name : name;
    S.username = out.player && out.player.username ? out.player.username : String(username || '').toLowerCase();
    S.avatar = out.player && out.player.avatar ? out.player.avatar : S.avatar;
    S.email = out.player && out.player.email ? out.player.email : '';
    S.named = !!S.name;
    S.requireEmailVerification = policyRequiresVerification(out);
    S.emailVerified = !!(out.player && out.player.email_verified);
    S.signedOutIntentionally = false;
    if (S.name) store.set('ct_name', S.name);
    if (S.username) store.set('ct_username', S.username);
    if (S.avatar) store.set('ct_avatar', S.avatar);
    if (out.requiresVerification) {
      openAuthSheet('login', out.emailSent === false
        ? 'Account created — but the verification email could not be sent. Use “Resend verification email”, then verify and log in.'
        : 'Account created. Check your email for a verification link, then log in here.');
      return;
    }
    closeOverlay();
    connect();
    toast(out.emailSent === false
      ? 'Account created. Email verification is still pending, and delivery failed. Friend-testing mode lets you play now.'
      : 'Account created. Email verification is still pending; friend-testing mode lets you play now.');
  }

  async function doResendVerification() {
    const email = window.prompt('Enter the email you registered with:');
    if (!email) return;
    try {
      await postJson('/api/auth/resend-verification', { email });
      toast('If this account needs verifying, a new link has been sent.');
    } catch (e) {
      toast(e.message || 'Could not send the email');
    }
  }

  async function doForgotPassword() {
    const email = window.prompt('Enter your account email:');
    if (!email) return;
    try {
      await postJson('/api/auth/forgot-password', { email });
      toast('If this account exists, a reset link has been sent.');
    } catch (e) {
      toast(e.message || 'Could not send reset link');
    }
  }

  // The session cookie rides along with the WebSocket upgrade, so the page never handles the session token.
  function connect() {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onopen = () => {
      retry = 0;
      $banner.hidden = true;
      send({ t: 'hello' });
    };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      onMessage(m);
    };
    ws.onclose = (e) => {
      S.ready = false;
      if (e.code === 4000) {
        $banner.textContent = 'Tableverse is open in another tab. Reload to play here.';
        $banner.hidden = false;
        return;
      }
      if (e.code === 4001) { // signed out elsewhere, or the password was reset
        clearClientSession();
        $banner.hidden = true;
        loadSnapshot();
        if (S.signedOutIntentionally) S.signedOutIntentionally = false; // this tab clicked Log out: show the public home, do not nag
        else openAuthSheet('login', 'You have been signed out. Please log in again.');
        return;
      }
      if (e.code === 1008) return; // refused (not logged in, not verified): the login sheet is already showing, do not loop
      $banner.textContent = 'Reconnecting…';
      $banner.hidden = false;
      setTimeout(connect, Math.min(5000, 500 * 2 ** retry++));
    };
  }

  const hashCode = () => {
    const c = decodeURIComponent(location.hash.slice(1)).toUpperCase();
    return /^[A-Z]{6}$/.test(c) ? c : '';
  };
  const setHash = (code) => {
    try { history.replaceState(null, '', code ? '#' + code : location.pathname + location.search); } catch { /* ignore */ }
  };

  function rememberTable(room) {
    if (!room || !room.code || !room.gameId) return;
    const item = { code: room.code, gameId: room.gameId, name: (gameMeta(room.gameId) || {}).name || room.gameId, at: Date.now() };
    S.recentTables = [item, ...S.recentTables.filter((x) => x.code !== item.code)].slice(0, 5);
    store.set('ct_recent', JSON.stringify(S.recentTables));
  }

  function recentTablesHTML() {
    if (!S.recentTables.length) return '';
    const rows = S.recentTables.map((r) => {
      const live = S.publicTables.find((t) => t.code === r.code);
      const mine = S.rejoin.some((x) => x.code === r.code);
      const status = mine ? 'Your seat is waiting' : live ? (live.status === 'playing' ? 'In progress' : 'Available') : 'Private or expired';
      return `<button class="recent-table ${mine ? 'mine' : ''}" data-act="rejoin" data-code="${esc(r.code)}"><span>↺</span><b>${esc(r.name)}</b><code>${esc(r.code)}</code>${mine ? '<em class="rj-badge">Rejoin</em>' : `<small>${status}</small>`}</button>`;
    }).join('');
    return `<section class="panel recent-panel"><div class="panel-tag">RECENT TABLES</div><div class="recent-tables">${rows}</div></section>`;
  }

  /** Big banner at the top of the home screen: a game is running and a bot is playing your seat. */
  function rejoinBannerHTML() {
    if (!S.rejoin.length) return '';
    return S.rejoin.map((r) => {
      const g = gameMeta(r.gameId) || { name: r.gameId, icon: '🎴' };
      return `<div class="rejoin-banner panel" role="status"><span class="rj-ico">${esc(g.icon || '🎴')}</span><div class="rj-text"><b>Your ${esc(g.name)} game is still running</b><span>${r.paused ? 'Everyone stepped out, so it is paused' : 'A bot is playing your seat'} at table <code>${esc(r.code)}</code>. Jump back in to carry on.</span></div><button class="btn" data-act="rejoin" data-code="${esc(r.code)}">Rejoin</button></div>`;
    }).join('');
  }

  function tableByCode(code) {
    return S.publicTables.find((t) => t.code === code) || null;
  }

  /** Home data for visitors (no socket): the public games list, the live table directory and the site announcement. */
  async function loadSnapshot() {
    S.guest = true;
    S.rejoin = []; // a stale "your game is waiting" banner must not survive into guest browsing
    try {
      const r = await fetch('/api/games', { credentials: 'same-origin' });
      const out = await r.json();
      if (out && out.ok) {
        S.games = out.games || [];
        S.publicTables = out.tables || [];
        S.announcement = typeof out.announcement === 'string' ? out.announcement : '';
      }
    } catch { /* offline: the home screen still renders, just without live data */ }
    render();
  }

  /** Play actions need a live lobby session: guests are asked to log in, and the action they tapped runs right after. */
  const authed = () => !S.guest && !!ws && ws.readyState === 1;
  function gateLogin(fn) {
    if (authed()) {
      fn();
      return;
    }
    S.pending = [fn];
    if (!S.guest) {
      // logged in with a valid session, the socket is just down: keep the action for the reconnect instead of nagging
      if (!ws || ws.readyState >= 2) connect();
      return;
    }
    const code = hashCode();
    openAuthSheet('login', code ? `Log in to join table ${code}.` : 'Log in to play — you will go straight where you tapped.');
  }

  function tableJoinModeOptions(t) {
    if (!t) return ['join', 'spectate'];
    if (t.status === 'playing') return ['spectate'];
    return ['join', 'spectate'];
  }

  function openJoinModeDialog(code, t, onPick) {
    const modes = tableJoinModeOptions(t);
    if (modes.length === 1) return onPick(modes[0]);
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    const label = t
      ? (t.status === 'playing' ? 'This table is in progress.' : 'This table is waiting in the lobby.')
      : 'Choose how to enter this table.';
    overlay.innerHTML = `<div class="sheet" data-stop="1" role="dialog" aria-label="Join or spectate"><h2>Join table ${esc(code)}</h2><p class="hint">${esc(label)}</p><div class="row" style="margin-top:12px; gap:10px; flex-wrap:wrap">${modes.includes('join') ? '<button class="btn" data-join-mode="join">Join as player</button>' : ''}${modes.includes('spectate') ? '<button class="btn ghost" data-join-mode="spectate">Spectate</button>' : ''}</div><div class="row" style="margin-top:10px"><button class="btn ghost small" data-join-close="1">Cancel</button></div></div>`;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.closest('[data-join-close]')) {
        overlay.remove();
        return;
      }
      const pick = e.target.closest('[data-join-mode]');
      if (!pick) return;
      overlay.remove();
      onPick(pick.dataset.joinMode);
    });
    document.body.appendChild(overlay);
  }

  /** Joining any table (directory, recent, code box or invite link) goes through the same gate: guests are asked to log in first. */
  function askJoinMode(code, t) {
    if (!authed()) return gateLogin(() => askJoinMode(code, tableByCode(code)));
    openJoinModeDialog(code, t, (mode) => joinTable(code, mode));
  }

  function publicTableAction(t) {
    if (t.status === 'playing') return { label: 'Spectate', disabled: false, cls: 'ghost' };
    if (t.members >= t.seats) return { label: 'Full', disabled: true, cls: 'ghost' };
    return { label: 'Join / Spectate', disabled: false, cls: '' };
  }

  function publicTablesHTML() {
    const count = S.publicTables.length;
    const rows = S.publicTables.map((t) => {
      const g = gameMeta(t.gameId) || { name: t.gameId, icon: '🎴' };
      const action = publicTableAction(t);
      return `<div class="public-table"><span class="public-game-icon">${esc(g.icon || '🎴')}</span><div class="public-table-info"><b>${esc(g.name)}</b><span>${esc(t.host)}'s table · ${t.members}/${t.seats} players${t.spectators ? ` · 👁 ${t.spectators}` : ''}</span></div><button class="btn ${action.cls} small" data-act="joinPublic" data-code="${esc(t.code)}" ${action.disabled ? 'disabled' : ''}>${action.label}</button></div>`;
    }).join('');
    return `<section class="panel public-tables-panel"><div class="row" style="justify-content:space-between"><div><div class="panel-tag">SESSIONS IN PROGRESS <span class="session-count">${count}</span></div><p class="public-help">Open lobbies can be joined; active games can be watched.</p></div><button class="btn ghost small" data-act="toggleSessions" aria-expanded="${S.sessionListOpen}">${S.sessionListOpen ? 'Hide' : 'Show'}</button></div>${S.sessionListOpen ? count ? `<div class="public-tables">${rows}</div>` : '<p class="hint">Nobody is hosting a public table right now.</p>' : ''}</section>`;
  }

  function joinTable(code, mode) {
    if (!S.named || !S.name) return toast('Choose your player name first');
    const msg = { t: 'join', code, name: S.name, avatar: S.avatar || undefined };
    if (mode === 'spectate') msg.spectate = true;
    send(msg);
  }


  function onMessage(m) {
    switch (m.t) {
      case 'welcome': {
        S.id = m.id;
        S.token = '';
        S.guest = false;
        S.games = m.games;
        S.publicTables = m.tables || [];
        S.rejoin = m.rejoin || [];
        S.announcement = typeof m.announcement === 'string' ? m.announcement : '';
        S.avatars = m.avatars || [];
        S.emotes = m.emotes || [];
        if (!S.name) S.name = m.name;
        if (!S.avatar) S.avatar = m.avatar;
        S.ready = true;
        render();
        const queue = S.pending;
        S.pending = [];
        for (const fn of queue) {
          try { fn(); } catch { /* a stale action must not break the session */ }
        }
        const code = hashCode();
        if (code && !S.room && !queue.length) {
          const t = tableByCode(code);
          askJoinMode(code, t);
        }
        break;
      }
      case 'authRequired':
        clearClientSession();
        S.ready = false;
        loadSnapshot();
        openAuthSheet('login', m.message || 'Log in to play.');
        break;
      case 'stats':
        drawStats(m.stats);
        break;
      case 'tables':
        S.publicTables = m.tables || [];
        S.rejoin = m.rejoin || [];
        if (!S.room) render();
        break;
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
        rememberTable(m.room);
        S.skew = (m.room.now || Date.now()) - Date.now();
        setHash(m.room.code);
        soundsFor(prevView, m.view);
        prevView = m.view;
        const mine = !!(m.view && m.view.myTurn);
        if (mine && !wasMyTurn) {
          try { navigator.vibrate && navigator.vibrate(70); } catch { /* ignore */ }
          if (document.hidden) document.title = '● Your turn · Tableverse';
        }
        wasMyTurn = mine;
        render();
        break;
      }
      case 'left':
        S.room = null;
        S.view = null;
        S.chat = [];
        // Refresh directory after returning to the home screen; the last tables
        // update may have arrived while this client was still inside a room.
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

  document.addEventListener('visibilitychange', () => { if (!document.hidden) document.title = 'Tableverse'; });

  document.addEventListener('submit', async (e) => {
    if (e.target.id === 'loginForm') {
      e.preventDefault();
      const email = (document.getElementById('loginEmail') || {}).value;
      const password = (document.getElementById('loginPassword') || {}).value;
      try {
        await doLogin(email, password);
      } catch (err) {
        openAuthSheet('login', err.message || 'Login failed');
      }
    }
    if (e.target.id === 'registerForm') {
      e.preventDefault();
      const name = (document.getElementById('registerName') || {}).value;
      const username = (document.getElementById('registerUsername') || {}).value;
      const email = (document.getElementById('registerEmail') || {}).value;
      const password = (document.getElementById('registerPassword') || {}).value;
      try {
        await doRegister(name, username, email, password);
      } catch (err) {
        openAuthSheet('register', err.message || 'Registration failed');
      }
    }
  });

  document.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-act]');
    if (!a) return;
    if (a.dataset.act === 'showLogin') return openAuthSheet('login');
    if (a.dataset.act === 'showRegister') return openAuthSheet('register');
    if (a.dataset.act === 'showAuth') return openAuthSheet(S.auth || 'login');
    if (a.dataset.act === 'forgotPassword') return doForgotPassword();
    if (a.dataset.act === 'resendVerification') return doResendVerification();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (S.auth) closeOverlay();
    else if (document.getElementById('modal-overlay')) closeModal();
    else if (S.menuOpen) { closeMenu(); document.querySelector('.tb-avatar-btn')?.focus(); }
  });
  // a click anywhere outside the open account menu closes it
  document.addEventListener('click', (e) => {
    if (S.menuOpen && !e.target.closest('.menu-wrap')) closeMenu();
  });

  const verifyToken = new URLSearchParams(location.search).get('token');
  if (location.pathname.endsWith('/verify-email.html') && verifyToken) {
    postJson('/api/auth/verify-email', { token: verifyToken })
      .then(() => { loadSnapshot(); openAuthSheet('login', 'Email verified. You can log in now.'); })
      .catch((e) => { loadSnapshot(); openAuthSheet('login', e.message || 'Verification failed.'); });
  }
  if (location.pathname.endsWith('/reset-password.html') && verifyToken) {
    // a real form (hidden password field, confirmation) instead of window.prompt, which shows the password in plain text
    loadSnapshot();
    openModal('Choose a new password', `<form id="resetForm" class="auth-form"><input id="resetPw" type="password" minlength="8" required placeholder="New password (8+ characters)" autocomplete="new-password"><input id="resetPw2" type="password" minlength="8" required placeholder="Repeat the password" autocomplete="new-password"><p id="resetMsg" class="auth-msg" role="status" hidden></p><button class="btn big" type="submit">Update password</button></form>`, (o) => {
      o.querySelector('#resetForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const msg = o.querySelector('#resetMsg');
        const show = (t) => { msg.textContent = t; msg.hidden = false; };
        const pw = o.querySelector('#resetPw').value;
        if (pw !== o.querySelector('#resetPw2').value) return show('The two passwords do not match.');
        try {
          await postJson('/api/auth/reset-password', { token: verifyToken, newPassword: pw });
          closeModal();
          history.replaceState(null, '', '/');
          openAuthSheet('login', 'Password updated. Log in with the new one.');
        } catch (err) { show(err.message || 'Reset failed. Ask for a new link.'); }
      });
    });
  }

  (async () => {
    await ensureCsrf();
    const ok = await hydrateSession();
    if (!ok) {
      clearClientSession();
      await loadSnapshot(); // the home page must open for visitors without a session
      if (hashCode()) {
        const code = hashCode();
        openAuthSheet('login', `Log in to join table ${code}.`);
      }
      return;
    }
    if (S.requireEmailVerification && !S.emailVerified) {
      await loadSnapshot();
      openAuthSheet('login', 'Please verify your email to enter the lobby.');
      return;
    }
    connect();
    if (!S.emailVerified) toast('Email verification pending. Friend-testing mode lets you play while unverified.');
  })();

  // ------------------------------------------------------------ rendering
  const avatarColor = (s) => {
    let h = 0;
    for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return `hsl(${h} 55% 42%)`;
  };
  const initial = (name) => esc([...name][0] || '?').toUpperCase();
  const avatar = (m) => `<span class="avatar" style="background:${avatarColor(m.name)}">${m.avatar ? esc(m.avatar) : initial(m.name)}</span>`;

  function profileHTML() {
    const userBadge = S.username ? `<div class="profile-user">@${esc(S.username)}</div>` : '';
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
            ${userBadge}
            <span class="profile-hint">Seen by friends at the table</span>
          </div>
        </div>
      </div>
      <label class="label" for="name">Your name</label>
      <input id="name" type="text" maxlength="20" autocomplete="nickname" placeholder="Type your nickname" value="${esc(myName)}">
      <div class="row" style="justify-content:space-between;margin-top:12px"><span class="label">Avatar</span><button type="button" class="btn ghost small" data-act="toggleAvatars" aria-expanded="${S.avatarOpen}">${S.avatarOpen ? 'Done' : 'Change'}</button></div>
      ${S.avatarOpen ? `<div class="av-picks">${picks}</div>` : ''}
    </div>`;
  }

  let prevView = null;
  const bidSig = (v) => JSON.stringify(v.bids || (v.players || []).map((p) => (p.bid !== undefined && p.bid !== null ? p.bid : p.hasBid ? 1 : null)));
  /** Play a sound for whatever changed between two game views. */
  function soundsFor(a, b) {
    const snd = CardTable.sound;
    if (!b || !snd) return;
    if (!a || a.phase === undefined) return;
    if (b.phase === 'gameOver' && a.phase !== 'gameOver') return snd.play(b.won === false ? 'lose' : 'fanfare'); // co-op games report won=false when the team loses
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
    if (isSpectator()) $watch.textContent = `👁 You are watching · ${sp.length} spectator${sp.length === 1 ? '' : 's'}`;
    else $watch.textContent = `👁 ${sp.length}`;
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

  // ------------------------------------------------------------ top bar, account menu and its dialogs
  const WHATS_NEW_VERSION = '2026-11-friend-testing';
  const WHATS_NEW = [
    ['🧪', 'Friend testing is open', 'Tableverse is now open for friend testing with fast sign-up and browser play on phone and desktop.'],
    ['🔓', 'Optional email verification mode', 'Friend-testing mode can temporarily allow immediate play after sign-up while still keeping accounts unverified in storage until verified.'],
    ['⚙️', 'Server-controlled auth policy', 'The app now follows the server policy for verification requirements, so login/register messaging always matches the backend mode.'],
    ['🔐', 'Accounts', 'Sign in with email and password. Your name, avatar and stats follow your account to every device.'],
    ['🧑‍🎤', 'Account menu', 'Profile, settings, stats, what’s new and log out now live in the menu at the top right.'],
    ['🌐', 'Public and private tables', 'A live table directory, one-tap rejoin and stronger 6-letter room codes.'],
  ];
  const hasNewNews = () => S.wnSeen !== WHATS_NEW_VERSION;

  function topbarHTML() {
    const brand = '<a class="tb-brand" href="/" aria-label="Tableverse home"><span class="tb-mark">🂡</span><span class="tb-name">Tableverse</span></a>';
    if (S.guest) {
      return `<nav class="topbar" aria-label="Main">${brand}<div class="tb-right"><button type="button" class="btn ghost small" data-act="showLogin">Log in</button><button type="button" class="btn small" data-act="showRegister">Sign up</button></div></nav>`;
    }
    const name = S.named ? S.name : 'Player';
    const av = `<span class="avatar tb-av" style="background:${avatarColor(name)}">${S.avatar ? esc(S.avatar) : initial(name)}</span>`;
    const item = (act, icon, label, extra = '', cls = '') => `<button type="button" role="menuitem" class="menu-item ${cls}" data-act="${act}"><span class="mi-ico" aria-hidden="true">${icon}</span><span class="mi-label">${label}</span>${extra}</button>`;
    const menu = S.menuOpen ? `<div class="menu" role="menu" aria-label="Account">
        <div class="menu-head">${av}<div class="menu-who"><b>${esc(name)}</b>${S.username ? `<small>@${esc(S.username)}</small>` : ''}</div></div>
        ${item('openProfile', '👤', 'Profile')}
        ${item('stats', '📊', 'My stats')}
        ${item('openSettings', '⚙️', 'Settings')}
        ${item('openWhatsNew', '🎉', 'What’s new', hasNewNews() ? '<span class="mi-new">New</span>' : '')}
        <div class="menu-sep" role="separator"></div>
        ${item('logout', '🚪', 'Log out')}
        ${item('logoutAll', '🔒', 'Log out everywhere', '', 'dim')}
      </div>` : '';
    return `<nav class="topbar" aria-label="Main">${brand}<div class="tb-right"><div class="menu-wrap"><button type="button" class="tb-avatar-btn" data-act="toggleMenu" aria-haspopup="menu" aria-expanded="${S.menuOpen}" aria-label="Account menu for ${esc(name)}">${av}${hasNewNews() ? '<span class="tb-dot" aria-hidden="true"></span>' : ''}<span class="tb-caret" aria-hidden="true">▾</span></button>${menu}</div></div></nav>`;
  }

  function closeMenu() {
    if (!S.menuOpen) return false;
    S.menuOpen = false;
    render();
    return true;
  }

  const modalActions = {};
  function closeModal() {
    const o = document.getElementById('modal-overlay');
    if (o) o.remove();
  }
  function openModal(title, bodyHTML, onMount) {
    closeModal();
    const o = document.createElement('div');
    o.id = 'modal-overlay';
    o.className = 'overlay';
    o.innerHTML = `<div class="sheet modal-sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="row modal-head"><h2>${esc(title)}</h2><button type="button" class="btn ghost small" data-modal-close aria-label="Close">✕</button></div><div class="modal-body">${bodyHTML}</div></div>`;
    o.addEventListener('click', (e) => {
      if (e.target === o || e.target.closest('[data-modal-close]')) return closeModal();
      const el = e.target.closest('[data-modal-act]');
      if (el && !el.disabled && Object.hasOwn(modalActions, el.dataset.modalAct)) modalActions[el.dataset.modalAct](el, o);
    });
    document.body.appendChild(o);
    const first = o.querySelector('input, button:not([data-modal-close])');
    if (first && !matchMedia('(pointer: coarse)').matches) first.focus();
    if (onMount) onMount(o);
  }

  function openProfileDialog() {
    const body = () => {
      const name = S.named ? S.name : '';
      const picks = S.avatars.map((a) => `<button type="button" class="av-pick ${a === S.avatar ? 'on' : ''}" data-modal-act="pickAvatar" data-a="${esc(a)}" aria-label="Avatar ${esc(a)}" aria-pressed="${a === S.avatar}">${esc(a)}</button>`).join('');
      return `<div class="profile-header"><div class="profile-preview"><span class="avatar big" style="background:${avatarColor(name || 'Player')}">${S.avatar ? esc(S.avatar) : initial(name || 'Player')}</span><div class="profile-meta"><span class="profile-welcome">${name ? `Playing as <b>${esc(name)}</b>` : 'Choose a display name'}</span>${S.username ? `<span class="profile-user">@${esc(S.username)}</span>` : ''}<span class="profile-hint">Seen by friends at the table</span></div></div></div>
        <label class="label" for="profileName">Display name</label>
        <input id="profileName" type="text" maxlength="20" autocomplete="nickname" placeholder="Your nickname" value="${esc(name)}">
        <span class="label" style="margin-top:6px">Avatar</span>
        <div class="av-picks">${picks}</div>`;
    };
    openModal('Profile', body(), (o) => {
      const redraw = () => {
        const input = o.querySelector('#profileName');
        const keep = input ? input.value : '';
        o.querySelector('.modal-body').innerHTML = body();
        const again = o.querySelector('#profileName');
        if (again && keep !== again.value) again.value = keep;
      };
      modalActions.pickAvatar = (el) => {
        S.avatar = el.dataset.a;
        store.set('ct_avatar', S.avatar);
        send({ t: 'setName', name: S.name || undefined, avatar: S.avatar });
        redraw();
        render();
      };
      let timer = null;
      o.addEventListener('input', (e) => {
        if (e.target.id !== 'profileName') return;
        S.name = e.target.value.trim().slice(0, 20);
        S.named = !!S.name;
        if (S.name) store.set('ct_name', S.name);
        clearTimeout(timer);
        timer = setTimeout(() => { if (S.name) { send({ t: 'setName', name: S.name, avatar: S.avatar || undefined }); render(); } }, 400);
      });
    });
  }

  function openSettingsDialog() {
    const resendLabel = S.requireEmailVerification ? 'Resend verification email' : 'Resend verification email — Soon';
    const verificationStatus = S.emailVerified
      ? `<div class="setting-row verify-status"><div><b>Email verified</b><small>Your email address is verified.</small></div><span class="verify-pill verified">Verified</span></div>`
      : `<div class="setting-row verify-status"><div><b>Email verification pending</b><small>Your email address has not been verified yet. ${S.requireEmailVerification ? 'Please verify your email before entering the lobby.' : 'You can play normally. Email verification is optional during friend testing.'}</small></div><span class="verify-pill ${S.requireEmailVerification ? 'required' : 'optional'}">${S.requireEmailVerification ? 'Pending' : 'Pending'}</span></div>
         <div class="setting-row verify-status"><div><b>Verification email</b><small>${S.requireEmailVerification ? 'Use this to send another verification link to your account email.' : 'Email verification is optional during friend testing. Resending will be available soon.'}</small></div><button type="button" class="btn ghost small" data-modal-act="resendVerificationFromSettings" ${S.requireEmailVerification ? '' : 'disabled aria-disabled="true"'}>${resendLabel}</button></div>`;
    const body = () => `<div class="setting-row"><div><b>Sound effects</b><small>Card sounds, turn alerts and fanfares.</small></div><button type="button" class="btn ${CardTable.sound.isMuted() ? 'ghost' : ''} small" data-modal-act="toggleSound" aria-pressed="${!CardTable.sound.isMuted()}">${CardTable.sound.isMuted() ? 'Off' : 'On'}</button></div>
      <div class="setting-row"><div><b>Recent tables</b><small>${S.recentTables.length ? `${S.recentTables.length} remembered on this device.` : 'Nothing remembered on this device.'}</small></div><button type="button" class="btn ghost small" data-modal-act="clearRecent" ${S.recentTables.length ? '' : 'disabled'}>Clear</button></div>
      <div class="setting-row"><div><b>Announcements</b><small>Show the site banner again if you dismissed it.</small></div><button type="button" class="btn ghost small" data-modal-act="showAnnouncement" ${S.announcement && S.dismissedAnnouncement === S.announcement ? '' : 'disabled'}>Show</button></div>
      ${verificationStatus}
      <div class="setting-row"><div><b>Account</b><small>${S.username ? `Signed in as @${esc(S.username)}.` : 'Signed in.'} Signing out everywhere ends every session on every device.</small></div><button type="button" class="btn ghost small" data-modal-act="logoutAllFromSettings">Log out everywhere</button></div>`;
    openModal('Settings', body(), (o) => {
      const redraw = () => { o.querySelector('.modal-body').innerHTML = body(); };
      modalActions.toggleSound = () => { CardTable.sound.toggle(); redraw(); };
      modalActions.clearRecent = () => { S.recentTables = []; store.set('ct_recent', '[]'); redraw(); render(); };
      modalActions.showAnnouncement = () => { S.dismissedAnnouncement = null; store.remove('ct_ann'); redraw(); render(); };
      modalActions.resendVerificationFromSettings = async () => {
        if (!S.requireEmailVerification || S.emailVerified || !S.email) return;
        try {
          await postJson('/api/auth/resend-verification', { email: S.email });
          toast('If this account needs verifying, a new link has been sent.');
        } catch (e) {
          toast(e.message || 'Could not send the email');
        }
      };
      modalActions.logoutAllFromSettings = () => { closeModal(); doLogoutAll(); };
    });
  }

  function openWhatsNewDialog() {
    S.wnSeen = WHATS_NEW_VERSION;
    store.set('ct_wn_seen', S.wnSeen);
    render();
    openModal('What’s new', `<ul class="wn-list">${WHATS_NEW.map(([ico, t, d]) => `<li><span class="wn-ico" aria-hidden="true">${ico}</span><div><b>${esc(t)}</b><p>${esc(d)}</p></div></li>`).join('')}</ul>`);
  }

  function render() {
    // keep the cursor in the name box when the screen is redrawn (e.g. someone joins while you type)
    const ae = document.activeElement;
    const keep = ae && ae.id === 'name' ? { start: ae.selectionStart, end: ae.selectionEnd } : null;
    if (!S.ready && !S.guest && !S.room) {
      $app.innerHTML = '<div class="page"><div class="brand"><div class="mark">🂡</div><h1>Tableverse</h1><p>Connecting…</p></div></div>';
    } else if (!S.room) renderHome();
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
    const who = S.guest ? '' : (S.named ? S.name : '');
    $app.innerHTML = `
    ${topbarHTML()}
    <main class="page wide home-arena">
      <section class="hero">
        <div class="hero-copy">
          <div class="arena-tag">⚔️ Multiplayer card tables</div>
          <h1>${who ? `Welcome back, <span class="hero-name">${esc(who)}</span>` : 'Your friends. Your games. <span class="hero-name">One table.</span>'}</h1>
          <p class="brand-desc">${S.guest ? 'Real-time Wizard, 29, Poker and The Mind with instant rooms and smart bots that fill any empty seat. Right in your browser.' : 'Pick a game, open a table and send the link, or jump back in with a code. Bots fill any empty seat.'}</p>
          ${S.guest ? `<div class="row hero-cta"><button type="button" class="btn big" data-act="showRegister">Create free account</button><button type="button" class="btn ghost big" data-act="showLogin">Log in</button></div>` : `<div class="row hero-cta"><button type="button" class="btn big" data-act="scrollGames">Choose a game</button><button type="button" class="btn ghost big" data-act="stats">📊 My stats</button></div>`}
          <div class="arena-features">
            <span class="feat-badge">✨ No install</span>
            <span class="feat-badge">📱 Phone &amp; desktop</span>
            <span class="feat-badge">🛡️ Fair hidden-state deals</span>
          </div>
        </div>
        <section class="panel join-panel">
          <div class="panel-tag">QUICK JOIN</div>
          <label class="label" for="code">Have a table code?</label>
          <p class="join-sub">Enter the 6-letter code from your friend to sit down straight away.</p>
          <form class="join-form" id="joinForm">
            <input id="code" type="text" maxlength="6" placeholder="ABCDEF" autocomplete="off" autocapitalize="characters" spellcheck="false" value="${esc(S.draftCode)}">
            <button class="btn big-join" type="submit">Join</button>
          </form>
          <div class="join-tips">Or open an invite link: <code>site/#CODE</code></div>
        </section>
      </section>
      ${rejoinBannerHTML()}
      ${S.announcement && S.dismissedAnnouncement !== S.announcement ? `
      <div class="whats-new announcement panel" role="status">
        <span class="wn-icon">📣</span>
        <div class="wn-content">${esc(S.announcement)}</div>
        <button class="wn-close" data-act="dismissAnnouncement" aria-label="Dismiss announcement">✕</button>
      </div>` : ''}
      ${publicTablesHTML()}
      ${recentTablesHTML()}
      <div class="section-head" id="games">
        <h2 class="section">Games</h2>
        <span class="section-sub">Pick a game and host a table for your friends</span>
      </div>
      <section class="game-grid">${tiles}</section>
      <a class="panel tool-tile" href="/scorecard.html"><span class="tool-ico">📝</span><span><b>Wizard scorecard</b><br><small>Playing with a real deck? Enter bids and tricks each round and the scores are worked out for you. Works offline.</small></span></a>
      <section class="roadmap-box panel">
        <div class="roadmap-head"><span class="roadmap-icon">🧭</span><div><b>More arena games coming soon</b><p>New ways to play with friends are on the way.</p></div></div>
        <div class="upcoming-games">
          <div class="upcoming-game"><span>⛏️</span><b>Saboteur</b><small>Hidden roles &amp; tunnel strategy</small><em>In development</em></div>
          <div class="upcoming-game"><span>🐂</span><b>6 nimmt!</b><small>Take rows, avoid the bullheads</small><em>Coming next</em></div>
          <div class="upcoming-game"><span>🌈</span><b>UNO</b><small>Classic colour-changing card battles</small><em>Coming next</em></div>
        </div>
      </section>
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
      ${r.spectators && r.spectators.length ? `<details class="spectator-list"><summary>👁 ${r.spectators.length} watching</summary><div class="spectator-names">${r.spectators.map((x) => esc(x.name)).join(', ')}</div></details>` : ''}
      <section class="panel code-card">
        <div class="label">Table code · share it with your friends</div>
        <div class="code">${esc(r.code)}</div>
        <div class="row" style="justify-content:center">
          <button class="btn small" data-act="copyLink">Copy invite link</button>
          <button class="btn small wa" data-act="whatsapp">WhatsApp</button>
          ${navigator.share ? '<button class="btn ghost small" data-act="share">Share…</button>' : ''}
        </div>
        ${isHost ? `<div class="visibility-control"><span class="visibility-status ${r.visibility === 'public' ? 'public' : 'private'}">${r.visibility === 'public' ? '🌐 Public table' : '🔒 Private table'}</span><button class="btn ghost small" data-act="toggleVisibility">${r.visibility === 'public' ? 'Make private' : 'Make public'}</button><small>${r.visibility === 'public' ? 'Anyone can find this table in Sessions in Progress.' : 'Only people with the invite link or code can join.'}</small></div>` : ''}
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
          ? `<div class="start-bar"><button class="btn big" data-act="start">Start game${open > 0 ? ` <small>· ${open} bot${open === 1 ? '' : 's'} will join</small>` : ''}</button></div>`
          : '<div class="start-bar wait"><p class="label" style="text-align:center;margin:0">Waiting for the host to start…</p></div>'
      }
    </main>`;
  }

  // ------------------------------------------------------------ player stats
  const statsGame = (id) => gameMeta(id) || { name: id, icon: '🎴' };
  const KIND_NOTE = { team: 'team game: a win means your team won', coop: 'co-operative: the whole table wins or loses together' };
  const fmtDate = (iso) => { try { return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return ''; } };

  function openStats() {
    const old = document.getElementById('stats-overlay');
    if (old) old.remove();
    const overlay = document.createElement('div');
    overlay.id = 'stats-overlay';
    overlay.className = 'overlay';
    overlay.innerHTML = '<div class="sheet stats-sheet" data-stop="1" role="dialog" aria-label="My stats"><div class="row" style="justify-content:space-between"><h2>📊 My stats</h2><button class="btn ghost small" data-stats-close>Close</button></div><div class="stats-body"><p class="hint">Loading…</p></div></div>';
    overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target.closest('[data-stats-close]')) overlay.remove(); });
    document.body.appendChild(overlay);
    send({ t: 'getStats' });
  }

  function drawStats(s) {
    const body = document.querySelector('#stats-overlay .stats-body');
    if (!body || !s) return;
    if (!s.played) {
      body.innerHTML = '<p class="hint" style="text-align:left">No finished games yet. Finish a game with friends or bots and your record shows up here. Games you leave early do not count.</p>';
      return;
    }
    const fav = s.favouriteGame ? statsGame(s.favouriteGame) : null;
    const tile = (label, value, cls = '') => `<div class="stat-tile ${cls}"><span class="stat-v">${value}</span><span class="stat-l">${label}</span></div>`;
    const games = s.perGame.map((g) => {
      const meta = statsGame(g.gameId);
      return `<div class="stat-game"><span class="stat-game-name">${esc(meta.icon || '🎴')} ${esc(meta.name)}${KIND_NOTE[g.kind] ? ` <small class="stat-kind" title="${esc(KIND_NOTE[g.kind])}">${g.kind === 'coop' ? 'co-op' : 'teams'}</small>` : ''}</span><span class="stat-game-rec">${g.wins}W · ${g.losses}L</span><span class="stat-bar" aria-hidden="true"><i style="width:${g.winRate || 0}%"></i></span><span class="stat-game-pct">${g.winRate}%</span>${g.best !== null && g.bestLabel ? `<span class="stat-game-best">${esc(g.bestLabel)}: <b>${esc(g.bestText)}</b></span>` : ''}</div>`;
    }).join('');
    const recent = s.recent.map((r) => `<span class="stat-chip ${r.won ? 'w' : 'l'}" title="${esc(statsGame(r.gameId).name)} · ${esc(fmtDate(r.finishedAt))}">${esc(statsGame(r.gameId).icon || '🎴')}<b>${r.won ? 'W' : 'L'}</b></span>`).join('');
    body.innerHTML = `
      <div class="stat-grid">
        ${tile('Games played', s.played)}
        ${tile('Wins', s.wins, 'good')}
        ${tile('Losses', s.losses)}
        ${tile('Win rate', s.winRate + '%')}
        ${tile('Favourite game', fav ? `${esc(fav.icon || '🎴')} ${esc(fav.name)}` : '–', 'wide')}
        ${tile('Win streak', s.streak.current)}
        ${tile('Best streak', s.streak.best)}
      </div>
      <h3 class="stat-h">By game</h3>
      <div class="stat-games">${games}</div>
      <h3 class="stat-h">Last ${s.recent.length} games <small>(newest first)</small></h3>
      <div class="stat-recent">${recent}</div>
      <p class="hint" style="text-align:left;margin-top:12px">Ties share the win. ${s.lastPlayed ? `Last played ${esc(fmtDate(s.lastPlayed))}. ` : ''}${s.memberSince ? `Playing since ${esc(fmtDate(s.memberSince))}. ` : ''}Your stats belong to the player saved in this browser, so clearing site data starts a new player.</p>`;
  }

  function openActivityLog() {
    const entries = (S.view && S.view.log) || [];
    const overlay = document.createElement('div');
    overlay.className = 'overlay activity-overlay';
    overlay.innerHTML = `<div class="sheet activity-sheet" data-stop="1"><div class="row" style="justify-content:space-between"><h2>Game log</h2><button class="btn ghost small" data-log-close>Close</button></div>${entries.length ? `<ol class="activity-list">${entries.slice(-60).reverse().map((e) => `<li><span>${esc(e.card || e.text || '')}</span></li>`).join('')}</ol>` : '<p class="hint">No plays yet.</p>'}</div>`;
    overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target.closest('[data-log-close]')) overlay.remove(); });
    document.body.appendChild(overlay);
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
      activityLog: () => openActivityLog(),
      act: (action) => send({ t: 'act', action }),
      leave: () => {
        const playing = S.room.status === 'playing' && !isSpectator();
        if (!playing || confirm('Leave the game? A bot takes your seat, and you can rejoin from the home screen.')) send({ t: 'leave' });
      },
      rematch: () => send({ t: 'rematch' }),
      showRules: () => showRules(S.room.gameId),
      rerender: render,
      toast,
    });
    const top = $app.querySelector('.wz-top');
    if (top) top.querySelector('.row')?.insertAdjacentHTML('afterbegin', '<button class="btn ghost small" data-act="activityLog" aria-label="Open game log">📜 Log</button>');
    const log = (S.view.log || []).slice(-12).reverse();
    if (log.length) {
      const details = document.createElement('details');
      details.className = 'game-log-inline';
      details.innerHTML = `<summary>📜 Game log <span>${S.view.log.length} plays</span></summary><ol>${log.map((e) => `<li><span>${esc(e.card || e.text || '')}</span></li>`).join('')}</ol>`;
      $app.querySelector('.wz')?.appendChild(details);
    }
    const bar = $app.querySelector('.wz-status');
    if (bar) bar.insertAdjacentHTML('beforeend', '<span class="ct-timer" hidden></span>');
    updateTimer();
  }

  // ------------------------------------------------------------ events
  const actions = {
    avatar: (el) => {
      S.avatar = el.dataset.a;
      S.avatarOpen = false;
      store.set('ct_avatar', S.avatar);
      send({ t: 'setName', name: S.name || undefined, avatar: S.avatar });
      render();
    },
    scrollGames: () => document.getElementById('games')?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }),
    toggleMenu: () => { S.menuOpen = !S.menuOpen; render(); },
    openProfile: () => { S.menuOpen = false; render(); openProfileDialog(); },
    openSettings: () => { S.menuOpen = false; render(); openSettingsDialog(); },
    openWhatsNew: () => { S.menuOpen = false; openWhatsNewDialog(); },
    toggleAvatars: () => { S.avatarOpen = !S.avatarOpen; render(); },
    stats: () => { if (S.menuOpen) { S.menuOpen = false; render(); } return authed() ? openStats() : gateLogin(() => openStats()); },
    emotes: () => toggleEmoteBar(),
    activityLog: () => openActivityLog(),
    sound: () => { CardTable.sound.toggle(); render(); },
    create: (el) => {
      if (!authed()) return gateLogin(() => actions.create(el));
      const game = el.dataset.game;
      send({ t: 'create', gameId: game, visibility: 'private', name: S.name || undefined, avatar: S.avatar || undefined });
    },
    toggleVisibility: () => {
      const cur = S.room && S.room.visibility;
      send({ t: 'setVisibility', visibility: cur === 'public' ? 'private' : 'public' });
    },
    // The server decides: your old seat if you had one (a bot is playing it), otherwise a seat in a lobby, otherwise watching.
    rejoin: (el) => askJoinMode(el.dataset.code, tableByCode(el.dataset.code)),
    joinPublic: (el) => askJoinMode(el.dataset.code, tableByCode(el.dataset.code)),
    toggleSessions: () => { S.sessionListOpen = !S.sessionListOpen; store.set('ct_sessions_open', S.sessionListOpen ? '1' : '0'); render(); },
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
    dismissAnnouncement: () => {
      S.dismissedAnnouncement = S.announcement;
      store.set('ct_ann', S.announcement);
      render();
    },
    logout: () => { S.menuOpen = false; doLogout(); },
    logoutAll: () => { S.menuOpen = false; doLogoutAll(); },
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
      const text = `Join my ${g ? g.name : 'card'} table on Tableverse: ${inviteUrl()} (code ${S.room.code})`;
      window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener');
    },
    share: () => {
      navigator.share({ title: 'Tableverse', text: `Join my table (code ${S.room.code})`, url: inviteUrl() }).catch(() => {});
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
      if (S.draftCode.length !== 6) return toast('Enter the 6-letter table code');
      const code = S.draftCode;
      gateLogin(() => askJoinMode(code, tableByCode(code)));
    }
  });

})();
