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
  store.remove('ct_recent'); // recent tables used to be kept per browser; they now live on the account

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
    recentTables: [], // the signed-in player's recent tables, from the server (follow the account across devices)
    friends: [],
    friendRequests: { incoming: [], outgoing: [] },
    invitations: { incoming: [], outgoing: [] },
    socialLoading: false,
    socialError: '',
    socialNotice: '',
    friendSearch: [],
    friendSearchBusy: false,
    inviteFriendOptions: '',
    friendQuery: '',
    roomInviteSent: new Set(),
    page: 'home', // 'home' | 'profile' | 'player' (a public profile); the table and game screens take over while a room is open
    profile: null, // own profile page: { loading, error, data, tab, history }
    player: null, // a public profile page: { username, loading, error, data }
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

  /**
   * One line of a game log, the same for every game. Engines log { by, card }: Wizard writes whole sentences under
   * "System" (the names are already inside), the other games put the actor in `by` and only the action in `card`
   * ("played 12", "folds", "bids 16"). Showing `card` alone is what dropped the names.
   */
  const logLine = (e) => {
    const text = String((e && (e.card || e.text)) || '').trim();
    const by = String((e && e.by) || '').trim();
    if (!by || by === 'System' || by === 'Table' || text.startsWith(by)) return text;
    return `${by} ${text}`;
  };

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
  const safeTableUrl = () => S.room && S.room.visibility === 'public' ? inviteUrl() : `${location.origin}/`;

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
    S.page = 'home'; S.profile = null; S.player = null; S.recentTables = []; // nothing of the old account stays on screen
    if (location.hash === '#profile') { try { history.replaceState(null, '', location.pathname + location.search); } catch { /* ignore */ } }
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
          <input id="registerUsername" type="text" maxlength="24" required pattern="[a-z0-9_]{3,24}" placeholder="Username (lowercase)" autocomplete="username" autocapitalize="off" spellcheck="false">
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
        u.value = value;
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
      if (e.code === 4002) { // a newer login (another device) took over the single active session
        clearClientSession();
        $banner.hidden = true;
        loadSnapshot();
        openAuthSheet('login', 'You signed in on another device, so this one was signed out. Log in again to play here.');
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

  /** Recent tables belong to the account: fetched from the server, so every device shows the same list. */
  async function loadRecent() {
    if (S.guest) { S.recentTables = []; return; }
    try {
      const r = await fetch('/api/me/recent', { credentials: 'same-origin' });
      const out = await r.json();
      if (!r.ok || !out.ok) return;
      S.recentTables = (out.tables || []).map((t) => ({ code: t.code, gameId: t.gameId, status: t.status, name: (gameMeta(t.gameId) || {}).name || t.gameId }));
      if (!S.room) render();
    } catch { /* offline: the list simply stays as it was */ }
  }

  async function loadSocial({ quiet = false } = {}) {
    if (!S.ready || S.guest) return;
    if (!quiet) { S.socialLoading = true; S.socialError = ''; render(); }
    try {
      const paths = [
      '/api/me/friends',
      '/api/me/friend-requests?direction=incoming',
      '/api/me/friend-requests?direction=outgoing',
      '/api/me/table-invitations?direction=incoming',
      '/api/me/table-invitations?direction=outgoing',
    ];
      const results = await Promise.all(paths.map(async (url) => {
        const r = await fetch(url, { credentials: 'same-origin' });
        const data = await r.json();
        if (!r.ok || !data.ok) throw new Error(data.error || 'Could not load friends.');
        return data;
      }));
      S.friends = results[0].friends || [];
      S.friendRequests = { incoming: results[1].requests || [], outgoing: results[2].requests || [] };
      S.invitations = { incoming: results[3].invitations || [], outgoing: results[4].invitations || [] };
      S.socialError = '';
    } catch (error) {
      S.socialError = error.message || 'Could not load friends.';
    } finally {
      S.socialLoading = false;
      if (!S.room) render();
    }
  }

  async function searchFriends(query) {
    S.friendQuery = query.trim();
    if (S.friendQuery.length < 1) { S.friendSearch = []; render(); return; }
    S.friendSearchBusy = true;
    render();
    try {
      const r = await fetch(`/api/me/friends/search?username=${encodeURIComponent(S.friendQuery)}`, { credentials: 'same-origin' });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || 'Search failed.');
      S.friendSearch = data.players || [];
      S.socialError = '';
    } catch (error) { S.socialError = error.message || 'Search failed.'; }
    finally { S.friendSearchBusy = false; if (!S.room) render(); }
  }

  async function socialPost(path, body, success) {
    try {
      await postJson(path, body);
      S.socialError = '';
      if (success) toast(success);
      await loadSocial({ quiet: true });
    } catch (error) {
      S.socialError = error.message || 'Could not update friends.';
      if (!S.room) render();
    }
  }

  function joinAcceptedInvitation(invitation) {
    if (!invitation || invitation.status !== 'accepted') return toast('Accept the invitation before joining.');
    const game = gameMeta(invitation.game_id || invitation.gameId);
    toast(`Joining ${(game && game.name) || 'private'} table…`);
    joinTable(invitation.room_code || invitation.roomCode, 'join');
  }

  function socialHTML() {
    if (S.guest) return '';
    const friends = S.friends.map((f) => `<li class="social-row"><span class="social-avatar">${esc(f.avatar || '🧙')}</span><span class="social-info"><b>${esc(f.display_name || f.username)}</b><small>@${esc(f.username)} · ${f.online ? (f.playing ? '🎮 Playing ' + esc((gameMeta(f.playing) || {}).name || f.playing) : '🟢 Online') : 'Last seen ' + (f.last_seen ? new Date(f.last_seen).toLocaleString() : 'unknown')}</small></span><button class="btn ghost small" data-act="removeFriend" data-id="${esc(f.id)}">Remove</button></li>`).join('');
    const friendNames = new Set(S.friends.map((friend) => friend.username));
    const requestNames = new Set([...S.friendRequests.incoming, ...S.friendRequests.outgoing].map((request) => request.username));
    const invitationNames = new Set(S.invitations.incoming.map((invitation) => invitation.username));
    const searchResults = S.friendSearch.filter((player) => !friendNames.has(player.username) && !requestNames.has(player.username) && !invitationNames.has(player.username));
    const inviteTargets = S.friends.filter((friend) => !S.invitations.outgoing.some((invitation) => invitation.username === friend.username) && !S.roomInviteSent.has(`${S.room?.code}:${friend.username}`));
    const resultHTML = searchResults.map((p) => `<li class="social-row"><span class="social-info"><b>${esc(p.display_name || p.username)}</b><small>@${esc(p.username)}</small></span><button class="btn small" data-act="sendFriend" data-username="${esc(p.username)}">Add friend</button></li>`).join('');
    const tableInviteTargets = inviteTargets.map((f) => `<option value="${esc(f.username)}">${esc(f.display_name || f.username)} (@${esc(f.username)})</option>`).join('');
    S.inviteFriendOptions = tableInviteTargets;
    const incoming = S.friendRequests.incoming.map((r) => `<li class="social-row"><span class="social-info"><b>${esc(r.display_name || r.username)}</b><small>@${esc(r.username)} sent a friend request</small></span><button class="btn small" data-act="acceptFriend" data-id="${esc(r.id)}">Accept</button><button class="btn ghost small" data-act="declineFriend" data-id="${esc(r.id)}">Decline</button></li>`).join('');
    const outgoing = S.friendRequests.outgoing.map((r) => `<li class="social-row"><span class="social-info"><b>${esc(r.display_name || r.username)}</b><small>Request pending</small></span><button class="btn ghost small" data-act="cancelFriend" data-id="${esc(r.id)}">Cancel</button></li>`).join('');
    const invites = S.invitations.incoming.map((i) => `<li class="social-row"><span class="social-info"><b>${esc(i.display_name || i.username)}</b><small>${esc(i.game_id)} table · ${esc(i.room_code)} · expires ${esc(new Date(i.expires_at).toLocaleString())}</small></span><button class="btn small" data-act="acceptInvitation" data-id="${esc(i.id)}">Accept</button><button class="btn ghost small" data-act="declineInvitation" data-id="${esc(i.id)}">Decline</button></li>`).join('');
    const sent = S.invitations.outgoing.map((i) => `<li class="social-row"><span class="social-info"><b>${esc(i.display_name || i.username)}</b><small>${esc(i.room_code)} · ${esc(i.status)}</small></span><button class="btn ghost small" data-act="revokeInvitation" data-id="${esc(i.id)}">Revoke</button></li>`).join('');
    return `<section class="home-section social-panel" id="friends"><div class="row" style="justify-content:space-between"><h2 class="section">Friends</h2><button class="btn ghost small" data-act="refreshSocial">Refresh</button></div>
      ${S.socialError ? `<p class="social-error" role="alert">${esc(S.socialError)}</p>` : ''}${S.socialNotice ? `<p class="social-notice" role="status">${esc(S.socialNotice)}</p>` : ''}${S.socialLoading ? '<p class="hint">Loading friends…</p>' : ''}
      <form id="friendSearchForm" class="social-search"><label class="sr-only" for="friendSearch">Search by username</label><input id="friendSearch" minlength="1" maxlength="24" autocomplete="off" placeholder="Find someone by username" value="${esc(S.friendQuery)}"><button class="btn small" type="submit" ${S.friendSearchBusy ? 'disabled' : ''}>Search</button></form>
      ${resultHTML ? `<ul class="social-list">${resultHTML}</ul>` : (S.friendQuery && !S.friendSearchBusy ? '<p class="hint">No new players found.</p>' : '')}
      <h3>Friend requests</h3>${incoming || outgoing ? `<ul class="social-list">${incoming}${outgoing}</ul>` : '<p class="hint">No pending friend requests.</p>'}
      <h3>Your friends</h3>${friends ? `<ul class="social-list">${friends}</ul>` : '<p class="hint">No friends yet. Search for a username to add someone.</p>'}
      <h3>Table invitations</h3>${invites ? `<ul class="social-list">${invites}</ul>` : '<p class="hint">No pending invitations.</p>'}${sent ? `<details><summary>Sent invitations</summary><ul class="social-list">${sent}</ul></details>` : ''}
    </section>`;
  }

  function inviteFriendsHTML() {
    if (!S.room || S.room.visibility !== 'private' || S.room.hostId !== S.id || S.guest) return '';
    const friends = S.inviteFriendOptions || '';
    return `<form id="tableInviteForm" class="social-search"><label for="tableInviteFriend">Invite a friend to this private table</label><select id="tableInviteFriend" required>${friends || '<option value="">All friends already invited</option>'}</select><button class="btn small" type="submit" ${friends ? '' : 'disabled'}>Send invitation</button></form>`;
  }

  function recentTablesHTML() {
    if (!S.recentTables.length) return '';
    const rows = S.recentTables.map((r) => {
      const mine = S.rejoin.some((x) => x.code === r.code);
      const status = mine ? 'Your seat is waiting' : r.status === 'playing' ? 'In progress' : 'Open';
      return `<button class="recent-table ${mine ? 'mine' : ''}" data-act="rejoin" data-code="${esc(r.code)}"><span>↺</span><b>${esc(r.name)}</b><code>${esc(r.code)}</code>${mine ? '<em class="rj-badge">Rejoin</em>' : `<small>${status}</small>`}</button>`;
    }).join('');
    return `<section class="home-section"><h2 class="section">Recent tables</h2><div class="recent-tables">${rows}</div></section>`;
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
    return `<section class="home-section public-tables-panel"><div class="row" style="justify-content:space-between;align-items:center"><div><h2 class="section">Open tables <span class="session-count">${count}</span></h2></div><button class="btn ghost small" data-act="toggleSessions" aria-expanded="${S.sessionListOpen}">${S.sessionListOpen ? 'Hide' : 'Show'}</button></div>${S.sessionListOpen ? count ? `<div class="public-tables">${rows}</div>` : emptyState('🪑', 'No open tables', 'Create a table and make it public, and it appears here for everyone.') : ''}</section>`;
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
        loadRecent();
        loadSocial({ quiet: true });
        if (!S.routed) { S.routed = true; applyRoute(); } // open #profile or #u/<name> if that is where the person came in
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
      case 'socialNotice':
        S.socialNotice = m.text || 'You have a new friends update.';
        toast(S.socialNotice);
        if (S.ready && !S.room) loadSocial({ quiet: true });
        render();
        break;
      case 'socialPresence':
        if (Array.isArray(m.friends)) S.friends = m.friends;
        else {
          const friend = S.friends.find((f) => f.id === m.playerId);
          if (friend) { friend.online = Boolean(m.online); friend.playing = m.playing || null; friend.last_seen = m.lastSeen || friend.last_seen; }
        }
        if (!S.room) render();
        break;
      case 'state': {
        S.room = m.room;
        S.view = m.view;
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
        S.page = 'home';
        loadRecent();
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
      const username = String((document.getElementById('registerUsername') || {}).value || '').trim().toLowerCase();
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

  window.addEventListener('popstate', () => { if (!S.room) applyRoute(); });

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
      S.routed = true;
      if (routeFromHash().page === 'player') applyRoute();
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

  // ------------------------------------------------------------ profile pages
  const emptyState = (icon, title, text) => `<div class="empty"><span class="empty-ico" aria-hidden="true">${icon}</span><b>${esc(title)}</b><p>${esc(text)}</p></div>`;
  const loadingBlock = (text = 'Loading…') => `<div class="loading" role="status"><span class="spinner" aria-hidden="true"></span>${esc(text)}</div>`;
  const errorBlock = (text, retryAct) => `<div class="error-block" role="alert"><p>${esc(text)}</p>${retryAct ? `<button type="button" class="btn ghost small" data-act="${retryAct}">Try again</button>` : ''}</div>`;
  const RESULT_LABEL = { won: 'Won', lost: 'Lost', left: 'Left early' };

  async function getJson(url) {
    const r = await fetch(url, { credentials: 'same-origin' });
    let out = null;
    try { out = await r.json(); } catch { /* not json */ }
    if (r.status === 401) { const e = new Error('Please log in again.'); e.status = 401; throw e; }
    if (!r.ok || !out || out.ok === false) { const e = new Error((out && out.error) || `Request failed (${r.status})`); e.status = r.status; throw e; }
    return out;
  }

  /** Hash routes: #profile (own page) and #u/<username> (public). A 6-letter hash is still a table code. */
  function routeFromHash() {
    const h = decodeURIComponent(location.hash.slice(1));
    if (h === 'profile') return { page: 'profile' };
    const m = /^u\/([a-z0-9_]{3,24})$/i.exec(h);
    if (m) return { page: 'player', username: m[1].toLowerCase() };
    return { page: 'home' };
  }
  function applyRoute() {
    const r = routeFromHash();
    if (r.page === 'profile' && S.guest) { S.page = 'home'; openAuthSheet('login', 'Log in to see your profile.'); return; }
    if (r.page === 'profile') return void openPage('profile', null, true);
    if (r.page === 'player') return void openPage('player', r.username, true);
    S.page = 'home';
    render();
  }
  function openPage(page, arg, fromHash) {
    if (S.menuOpen) S.menuOpen = false;
    S.page = page;
    if (!fromHash) { try { history.pushState(null, '', page === 'profile' ? '#profile' : page === 'player' ? '#u/' + arg : location.pathname + location.search); } catch { /* ignore */ } }
    window.scrollTo(0, 0);
    if (page === 'profile') loadProfile(); else if (page === 'player') loadPlayer(arg); else render();
  }

  async function loadProfile(historyPage = 1) {
    const keepTab = S.profile && S.profile.tab;
    S.profile = { loading: true, error: '', data: null, history: null, tab: keepTab || 'overview', historyPage };
    render();
    try {
      const [me, hist] = await Promise.all([getJson('/api/me/profile'), getJson(`/api/me/history?page=${historyPage}`)]);
      S.profile = { ...S.profile, loading: false, data: me, history: hist };
      S.name = me.profile.displayName; S.named = true;
    } catch (e) {
      S.profile = { ...S.profile, loading: false, error: e.message || 'Could not load your profile.' };
    }
    render();
  }
  async function loadPlayer(username) {
    S.player = { username, loading: true, error: '', data: null };
    render();
    try { S.player.data = (await getJson(`/api/players/${encodeURIComponent(username)}`)).profile; }
    catch (e) { S.player.error = e.status === 404 ? 'There is no player with that username.' : (e.message || 'Could not load this profile.'); }
    S.player.loading = false;
    render();
  }

  const joinedText = (iso) => (iso ? `Joined ${fmtDate(iso)}` : '');

  function historyHTML(h) {
    if (!h || !h.total) return emptyState('🕘', 'No games yet', 'Finished games show up here with the game, the date and how it went.');
    const rows = h.items.map((g) => {
      const meta = statsGame(g.gameId);
      return `<li class="hist-row"><span class="hist-ico" aria-hidden="true">${esc(meta.icon || '🎴')}</span><span class="hist-main"><b>${esc(meta.name)}</b><small>${esc(fmtDate(g.finishedAt))} · ${g.humans} player${g.humans === 1 ? '' : 's'}${g.seats > g.humans ? ` + ${g.seats - g.humans} bot${g.seats - g.humans === 1 ? '' : 's'}` : ''}</small></span><span class="result ${g.result}">${RESULT_LABEL[g.result]}</span></li>`;
    }).join('');
    const pager = h.pages > 1 ? `<nav class="pager" aria-label="History pages"><button type="button" class="btn ghost small" data-act="historyPage" data-page="${h.page - 1}" ${h.page <= 1 ? 'disabled' : ''}>← Newer</button><span>Page ${h.page} of ${h.pages}</span><button type="button" class="btn ghost small" data-act="historyPage" data-page="${h.page + 1}" ${h.page >= h.pages ? 'disabled' : ''}>Older →</button></nav>` : '';
    return `<ul class="hist-list">${rows}</ul>${pager}<p class="hint" style="text-align:left">Games you left early are listed but not counted in your statistics.</p>`;
  }

  function renderProfilePage() {
    const P = S.profile || { loading: true };
    let inner;
    if (P.loading) inner = loadingBlock('Loading your profile…');
    else if (P.error) inner = errorBlock(P.error, 'reloadProfile');
    else {
      const me = P.data.profile;
      const name = me.displayName;
      const tab = P.tab || 'overview';
      const tabBtn = (id, label) => `<button type="button" role="tab" class="tab ${tab === id ? 'on' : ''}" aria-selected="${tab === id}" data-act="profileTab" data-tab="${id}">${label}</button>`;
      const panel = tab === 'history' ? historyHTML(P.history)
        : tab === 'account' ? `<div class="account-list">
            <div class="setting-row"><div><b>Email</b><small>${esc(me.email || 'No email on this account')}${me.email ? (me.emailVerified ? ' · verified' : ' · not verified') : ''}. Only you can see this.</small></div></div>
            <div class="setting-row"><div><b>Public profile</b><small>Anyone with the link can see your username, display name, avatar, join date and win totals.</small></div><button type="button" class="btn ghost small" data-act="copyProfileLink">Copy link</button></div>
            <div class="setting-row"><div><b>Sessions</b><small>Sign out of this device, or of every device you are logged in on.</small></div><span class="row" style="gap:6px"><button type="button" class="btn ghost small" data-act="logout">Log out</button><button type="button" class="btn ghost small" data-act="logoutAll">Everywhere</button></span></div>
            <div class="danger-zone"><div><b>Delete account</b><small>Permanently removes your account and sign-in. This cannot be undone.</small></div><button type="button" class="btn danger small" data-act="openDeleteAccount">Delete account…</button></div>
          </div>`
        : statsHTML(P.data.stats);
      inner = `<header class="pp-head">
          <span class="avatar big" style="background:${avatarColor(name)}">${me.avatar ? esc(me.avatar) : initial(name)}</span>
          <div class="pp-id"><h1>${esc(name)}</h1><p>${me.username ? `@${esc(me.username)} · ` : ''}${esc(joinedText(me.joinedAt))}</p></div>
          <button type="button" class="btn ghost small" data-act="editProfile">Edit profile</button>
        </header>
        <div class="tabs" role="tablist">${tabBtn('overview', 'Overview')}${tabBtn('history', `History${P.history && P.history.total ? ` <small>${P.history.total}</small>` : ''}`)}${tabBtn('account', 'Account')}</div>
        <section class="tab-panel" role="tabpanel">${panel}</section>`;
    }
    $app.innerHTML = `${topbarHTML()}<main class="page profile-page"><a class="back-link" href="/" data-act="goHome">← Back to games</a>${inner}</main>`;
  }

  function renderPlayerPage() {
    const P = S.player || { loading: true };
    let inner;
    if (P.loading) inner = loadingBlock('Loading profile…');
    else if (P.error) inner = errorBlock(P.error);
    else {
      const d = P.data;
      inner = `<header class="pp-head"><span class="avatar big" style="background:${avatarColor(d.displayName)}">${d.avatar ? esc(d.avatar) : initial(d.displayName)}</span><div class="pp-id"><h1>${esc(d.displayName)}</h1><p>@${esc(d.username)} · ${esc(joinedText(d.joinedAt))}</p></div></header>
        <div class="stat-grid"><div class="stat-tile"><span class="stat-v">${d.played}</span><span class="stat-l">Games played</span></div><div class="stat-tile good"><span class="stat-v">${d.wins}</span><span class="stat-l">Wins</span></div><div class="stat-tile"><span class="stat-v">${d.winRate === null ? '–' : d.winRate + '%'}</span><span class="stat-l">Win rate</span></div></div>`;
    }
    $app.innerHTML = `${topbarHTML()}<main class="page profile-page"><a class="back-link" href="/" data-act="goHome">← Back to games</a>${inner}</main>`;
  }

  // ---- account deletion
  function openDeleteAccountDialog() {
    openModal('Delete your account', `<form id="deleteForm" class="auth-form">
        <p class="hint" style="text-align:left;color:var(--ink)">This permanently deletes your account. It cannot be undone.</p>
        <ul class="plain-list">
          <li><b>Deleted:</b> your login (email and password), your username and display name, your avatar, your sessions on every device and your recent tables.</li>
          <li><b>Kept:</b> the games you finished, so other players’ history and results stay correct. Your seat in them is shown as “Deleted player” and is no longer linked to you.</li>
        </ul>
        <label class="label" for="deletePw">Enter your password to confirm</label>
        <input id="deletePw" type="password" required autocomplete="current-password" placeholder="Password">
        <p id="deleteMsg" class="auth-msg" role="alert" hidden></p>
        <div class="row" style="justify-content:flex-end;gap:8px"><button type="button" class="btn ghost" data-modal-close>Cancel</button><button type="submit" class="btn danger">Delete my account</button></div>
      </form>`, (o) => {
      o.addEventListener('submit', async (e) => {
        if (e.target.id !== 'deleteForm') return;
        e.preventDefault();
        const msg = o.querySelector('#deleteMsg');
        const btn = e.target.querySelector('button[type=submit]');
        btn.disabled = true;
        try {
          await postJson('/api/me/delete-account', { password: o.querySelector('#deletePw').value });
          closeModal();
          S.signedOutIntentionally = true;
          clearClientSession();
          for (const k of ['ct_name', 'ct_username', 'ct_avatar']) store.remove(k);
          S.name = ''; S.username = ''; S.named = false; S.avatar = ''; S.profile = null; S.recentTables = [];
          S.ready = false; S.room = null; S.view = null; S.page = 'home';
          try { history.replaceState(null, '', location.pathname); } catch { /* ignore */ }
          loadSnapshot();
          toast('Your account has been deleted.');
        } catch (err) {
          msg.textContent = err.message || 'Could not delete the account.';
          msg.hidden = false;
          btn.disabled = false;
        }
      });
    });
  }

  // ------------------------------------------------------------ top bar, account menu and its dialogs
  const WHATS_NEW_VERSION = '2026-11-profiles';
  const WHATS_NEW = [
    ['👤', 'Profiles and history', 'Your profile page shows your stats and every finished game, with pages. You can change your display name there.'],
    ['🗑️', 'Delete your account', 'From your profile, with your password. Your finished games stay in other players\u2019 history as \u201cDeleted player\u201d.'],
    ['🕘', 'Recent tables follow you', 'They are saved on your account now, so any device shows the same list.'],
    ['📜', 'Clearer game logs', 'Every log line now says who did what.'],
    ['🧪', 'Friend testing is open', 'Sign up and play in the browser on phone or desktop.'],
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
        ${item('openProfilePage', '👤', 'Profile and history')}
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

  /** Edit name and avatar. The name is saved over HTTP (validated on the server); the avatar goes through the table socket as before. */
  function openEditProfileDialog() {
    const body = () => {
      const name = S.named ? S.name : '';
      const picks = S.avatars.map((a) => `<button type="button" class="av-pick ${a === S.avatar ? 'on' : ''}" data-modal-act="pickAvatar" data-a="${esc(a)}" aria-label="Avatar ${esc(a)}" aria-pressed="${a === S.avatar}">${esc(a)}</button>`).join('');
      return `<form id="nameForm" class="auth-form">
          <label class="label" for="profileName">Display name</label>
          <input id="profileName" type="text" minlength="2" maxlength="20" required autocomplete="nickname" value="${esc(name)}">
          <small class="hint" style="text-align:left">2 to 20 characters. Other players at your tables see this name.</small>
          <p id="nameMsg" class="auth-msg" role="alert" hidden></p>
          <button class="btn" type="submit">Save name</button>
        </form>
        <span class="label" style="margin-top:6px">Avatar</span>
        <div class="av-picks">${picks}</div>`;
    };
    openModal('Edit profile', body(), (o) => {
      modalActions.pickAvatar = (el) => {
        S.avatar = el.dataset.a;
        store.set('ct_avatar', S.avatar);
        send({ t: 'setName', name: S.name || undefined, avatar: S.avatar });
        const keep = o.querySelector('#profileName').value;
        o.querySelector('.modal-body').innerHTML = body();
        o.querySelector('#profileName').value = keep;
        render();
      };
      o.addEventListener('submit', async (e) => {
        if (e.target.id !== 'nameForm') return;
        e.preventDefault();
        const msg = o.querySelector('#nameMsg');
        const btn = e.target.querySelector('button[type=submit]');
        btn.disabled = true;
        try {
          const out = await postJson('/api/me/display-name', { displayName: o.querySelector('#profileName').value });
          S.name = out.displayName; S.named = true;
          store.set('ct_name', S.name);
          if (S.profile && S.profile.data) S.profile.data.profile.displayName = S.name;
          closeModal();
          toast('Name saved');
          render();
        } catch (err) {
          msg.textContent = err.message || 'Could not save the name.';
          msg.hidden = false;
          btn.disabled = false;
        }
      });
    });
  }

  function openSettingsDialog() {
    const body = () => `<div class="setting-row"><div><b>Sound effects</b><small>Card sounds, turn alerts and fanfares. Saved on this device.</small></div><button type="button" class="btn ${CardTable.sound.isMuted() ? 'ghost' : ''} small" data-modal-act="toggleSound" aria-pressed="${!CardTable.sound.isMuted()}">${CardTable.sound.isMuted() ? 'Off' : 'On'}</button></div>
      <div class="setting-row"><div><b>Recent tables</b><small>${S.recentTables.length ? `${S.recentTables.length} saved on your account.` : 'Nothing saved yet.'}</small></div><button type="button" class="btn ghost small" data-modal-act="clearRecent" ${S.recentTables.length ? '' : 'disabled'}>Clear</button></div>
      <div class="setting-row"><div><b>Account</b><small>Profile, history and account deletion are on your profile page.</small></div><button type="button" class="btn ghost small" data-modal-act="openProfileFromSettings">Open</button></div>`;
    openModal('Settings', body(), (o) => {
      const redraw = () => { o.querySelector('.modal-body').innerHTML = body(); };
      modalActions.toggleSound = () => { CardTable.sound.toggle(); redraw(); };
      modalActions.clearRecent = async () => {
        try { await postJson('/api/me/recent/clear', {}); S.recentTables = []; redraw(); render(); } catch (err) { toast(err.message || 'Could not clear recent tables'); }
      };
      modalActions.openProfileFromSettings = () => { closeModal(); openPage('profile'); };
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
    } else if (!S.room && S.page === 'profile' && !S.guest) renderProfilePage();
    else if (!S.room && S.page === 'player') renderPlayerPage();
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

  function renderHome() {
    const tiles = S.games.map((g) => `
      <article class="game-card" style="--accent:${esc(g.accent || '#7b4bd0')}">
        <div class="game-art" aria-hidden="true">${esc(g.icon || '🎴')}</div>
        <div class="game-body">
          <h3>${esc(g.name)} <small>${range(g.seats)}</small></h3>
          <p>${esc(g.tagline)}</p>
          <div class="row game-actions">
            <button class="btn small" data-act="create" data-game="${esc(g.id)}">Create table</button>
            <button class="btn ghost small" data-act="rules" data-game="${esc(g.id)}">Rules</button>
          </div>
        </div>
      </article>`).join('');
    const name = S.guest ? '' : (S.named ? S.name : '');
    $app.innerHTML = `
    ${topbarHTML()}
    <main class="page wide home">
      <section class="home-hero">
        <div class="home-intro">
          <h1>${name ? `Hi, ${esc(name)}` : 'Your friends. Your games. One table.'}</h1>
          <p>${name ? 'Host a table below, or join a friend with their code.' : 'Free card games in your browser. Bots fill any empty seat.'}</p>
          ${S.guest ? '<div class="row" style="gap:8px"><button type="button" class="btn" data-act="showRegister">Create account</button><button type="button" class="btn ghost" data-act="showLogin">Log in</button></div>' : ''}
        </div>
        <form class="join-form" id="joinForm" aria-label="Join a table">
          <label class="label" for="code">Have a table code?</label>
          <div class="join-row"><input id="code" type="text" maxlength="6" placeholder="ABCDEF" autocomplete="off" autocapitalize="characters" spellcheck="false" value="${esc(S.draftCode)}"><button class="btn" type="submit">Join</button></div>
        </form>
      </section>
      ${rejoinBannerHTML()}
      ${S.announcement && S.dismissedAnnouncement !== S.announcement ? `<div class="notice-bar" role="status"><span>${esc(S.announcement)}</span><button type="button" class="wn-close" data-act="dismissAnnouncement" aria-label="Dismiss announcement">✕</button></div>` : ''}
      ${recentTablesHTML()}
      ${socialHTML()}
      <section class="home-section" id="games">
        <h2 class="section">Games</h2>
        ${tiles ? `<div class="game-grid">${tiles}</div>` : loadingBlock('Loading games…')}
      </section>
      ${publicTablesHTML()}
      <footer class="home-foot"><a href="/scorecard.html">Wizard paper scorecard</a></footer>
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
        <div class="label">${r.visibility === 'public' ? 'Table code · share it with your friends' : 'Table code · private, invited friends only'}</div>
        <div class="code">${esc(r.code)}</div>
        ${r.visibility === 'public' ? `<div class="row" style="justify-content:center">
          <button class="btn small" data-act="copyLink">Copy invite link</button>
          <button class="btn small wa" data-act="whatsapp">WhatsApp</button>
          ${navigator.share ? '<button class="btn ghost small" data-act="share">Share…</button>' : ''}
        </div>` : ''}
        ${isHost ? `<div class="visibility-control"><span class="visibility-status ${r.visibility === 'public' ? 'public' : 'private'}">${r.visibility === 'public' ? '🌐 Public table' : '🔒 Private table'}</span><button class="btn ghost small" data-act="toggleVisibility">${r.visibility === 'public' ? 'Make private' : 'Make public'}</button><small>${r.visibility === 'public' ? 'Anyone can find this table in Sessions in Progress.' : 'Only friends with an accepted invitation can join.'}</small></div>` : ''}
        ${inviteFriendsHTML()}${r.visibility === 'public' ? '<small>Public table links and codes can be shared freely.</small>' : '<small>Private table links and codes are not access grants. Invite each friend above; they must accept first.</small>'}
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

  /** The statistics block of a profile. Games you left early and bot seats are never counted (the server leaves them out). */
  function statsHTML(s) {
    if (!s || !s.played) return emptyState('🃏', 'No finished games yet', 'Finish a game with friends or bots and your record shows up here. Games you leave early are not counted.');
    const fav = s.favouriteGame ? statsGame(s.favouriteGame) : null;
    const tile = (label, value, cls = '') => `<div class="stat-tile ${cls}"><span class="stat-v">${value}</span><span class="stat-l">${label}</span></div>`;
    const games = s.perGame.map((g) => {
      const meta = statsGame(g.gameId);
      return `<div class="stat-game"><span class="stat-game-name">${esc(meta.icon || '🎴')} ${esc(meta.name)}${KIND_NOTE[g.kind] ? ` <small class="stat-kind" title="${esc(KIND_NOTE[g.kind])}">${g.kind === 'coop' ? 'co-op' : 'teams'}</small>` : ''}</span><span class="stat-game-rec">${g.wins}W · ${g.losses}L</span><span class="stat-bar" aria-hidden="true"><i style="width:${g.winRate || 0}%"></i></span><span class="stat-game-pct">${g.winRate}%</span>${g.best !== null && g.bestLabel ? `<span class="stat-game-best">${esc(g.bestLabel)}: <b>${esc(g.bestText)}</b></span>` : ''}</div>`;
    }).join('');
    const recent = s.recent.map((r) => `<span class="stat-chip ${r.won ? 'w' : 'l'}" title="${esc(statsGame(r.gameId).name)} · ${esc(fmtDate(r.finishedAt))}">${esc(statsGame(r.gameId).icon || '🎴')}<b>${r.won ? 'W' : 'L'}</b></span>`).join('');
    return `
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
      <p class="hint" style="text-align:left;margin-top:12px">Ties share the win. Games you left early are not counted.</p>`;
  }

  function openActivityLog() {
    const entries = (S.view && S.view.log) || [];
    const overlay = document.createElement('div');
    overlay.className = 'overlay activity-overlay';
    overlay.innerHTML = `<div class="sheet activity-sheet" data-stop="1"><div class="row" style="justify-content:space-between"><h2>Game log</h2><button class="btn ghost small" data-log-close>Close</button></div>${entries.length ? `<ol class="activity-list">${entries.slice(-60).reverse().map((e) => `<li><span>${esc(logLine(e))}</span></li>`).join('')}</ol>` : '<p class="hint">No plays yet.</p>'}</div>`;
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
      details.innerHTML = `<summary>📜 Game log <span>${S.view.log.length} plays</span></summary><ol>${log.map((e) => `<li><span>${esc(logLine(e))}</span></li>`).join('')}</ol>`;
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
    goHome: (el, e) => { if (e) e.preventDefault(); openPage('home'); },
    reloadProfile: () => loadProfile(),
    profileTab: (el) => { if (S.profile) { S.profile.tab = el.dataset.tab; render(); } },
    historyPage: (el) => loadProfile(Number(el.dataset.page) || 1),
    editProfile: () => openEditProfileDialog(),
    openDeleteAccount: () => openDeleteAccountDialog(),
    copyProfileLink: async () => {
      const u = S.profile && S.profile.data && S.profile.data.profile.username;
      if (!u) return;
      const url = `${location.origin}/#u/${u}`;
      try { await navigator.clipboard.writeText(url); toast('Profile link copied'); } catch { window.prompt('Copy this link:', url); }
    },
    toggleMenu: () => { S.menuOpen = !S.menuOpen; render(); },
    openProfilePage: () => { S.menuOpen = false; openPage('profile'); },
    openSettings: () => { S.menuOpen = false; render(); openSettingsDialog(); },
    openWhatsNew: () => { S.menuOpen = false; openWhatsNewDialog(); },
    toggleAvatars: () => { S.avatarOpen = !S.avatarOpen; render(); },
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
    refreshSocial: () => loadSocial(),
    sendFriend: (el) => socialPost('/api/me/friend-requests', { username: el.dataset.username }, 'Friend request sent.'),
    acceptFriend: (el) => socialPost('/api/me/friend-requests/accept', { requestId: el.dataset.id }, 'Friend request accepted.'),
    declineFriend: (el) => socialPost('/api/me/friend-requests/decline', { requestId: el.dataset.id }),
    cancelFriend: (el) => socialPost('/api/me/friend-requests/cancel', { requestId: el.dataset.id }),
    removeFriend: (el) => { if (confirm('Remove this friend? Pending invitations between you will be revoked.')) socialPost('/api/me/friends/remove', { friendId: el.dataset.id }, 'Friend removed.'); },
    acceptInvitation: async (el) => {
      try {
        const out = await postJson('/api/me/table-invitations/accept', { invitationId: el.dataset.id });
        await loadSocial({ quiet: true });
        joinAcceptedInvitation(out.invitation);
      } catch (error) { S.socialError = error.message || 'Could not accept invitation.'; render(); }
    },
    declineInvitation: (el) => socialPost('/api/me/table-invitations/decline', { invitationId: el.dataset.id }),
    revokeInvitation: (el) => socialPost('/api/me/table-invitations/revoke', { invitationId: el.dataset.id }),
    logout: () => { S.menuOpen = false; doLogout(); },
    logoutAll: () => { S.menuOpen = false; doLogoutAll(); },
    copyLink: async () => {
      const url = safeTableUrl();
      try {
        await navigator.clipboard.writeText(url);
        toast(S.room.visibility === 'public' ? 'Table link copied' : 'Private code is not an access grant. Invite friends from the table.');
      } catch {
        window.prompt('Copy this link:', url);
      }
    },
    whatsapp: () => {
      const g = gameMeta(S.room.gameId);
      const url = safeTableUrl();
      const text = S.room.visibility === 'public'
        ? `Join my ${g ? g.name : 'card'} table on Tableverse: ${url} (code ${S.room.code})`
        : `Join my private ${g ? g.name : 'card'} table on Tableverse. I will send you a friend invitation in the app.`;
      window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener');
    },
    share: () => {
      const url = safeTableUrl();
      const text = S.room.visibility === 'public' ? `Join my table (code ${S.room.code})` : 'I will send you a private table invitation in the app.';
      navigator.share({ title: 'Tableverse', text, url }).catch(() => {});
    },
  };

  $app.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (el && !el.disabled && Object.hasOwn(actions, el.dataset.act)) actions[el.dataset.act](el, e);
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
  $app.addEventListener('submit', async (e) => {
    if (e.target.id === 'joinForm') {
      e.preventDefault();
      if (S.draftCode.length !== 6) return toast('Enter the 6-letter table code');
      const code = S.draftCode;
      gateLogin(() => askJoinMode(code, tableByCode(code)));
    } else if (e.target.id === 'friendSearchForm') {
      e.preventDefault();
      searchFriends(document.getElementById('friendSearch')?.value || '');
    } else if (e.target.id === 'tableInviteForm') {
      e.preventDefault();
      const username = document.getElementById('tableInviteFriend')?.value;
      if (!username || !S.room || S.room.visibility !== 'private') return;
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      try {
        await postJson('/api/me/table-invitations', { username, gameId: S.room.gameId, roomCode: S.room.code, expiresAt });
        S.roomInviteSent.add(`${S.room.code}:${username}`);
        toast('Invitation sent.');
        await loadSocial({ quiet: true });
        render();
      } catch (error) {
        S.socialError = error.message || 'Could not send invitation.';
        render();
      }
    }
  });

  setInterval(() => { if (S.ready && !S.room) loadSocial({ quiet: true }); }, 60000);

})();
