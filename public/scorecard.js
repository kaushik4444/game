/* Wizard scorecard: scorekeeping for games played with a real deck. Works offline once loaded; data stays on this device. */
(() => {
  'use strict';
  const KEY = 'ct_scorecard_v1';
  const $ = document.getElementById('sc');
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(G)); } catch { /* private mode */ } };
  const toast = (t) => {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = t;
    document.getElementById('toasts').appendChild(el);
    setTimeout(() => el.remove(), 3000);
  };

  const scoreFor = (bid, won) => (bid === won ? 20 + 10 * won : -10 * Math.abs(bid - won));
  const defaultRounds = (n) => Math.floor(60 / n);

  // G = null (setup) or { names, rounds, dealer0, plusMinus, done: [{bids, won}], cur: {bids, won, stage}, editing: null|index, tab, setup }
  let G = load();
  let setup = { names: ['', '', ''], rounds: 0, plusMinus: false };
  if (G && !G.names) G = null;

  const n = () => G.names.length;
  const roundNo = () => (G.editing !== null ? G.editing : G.done.length) + 1; // 1-based = cards per player
  const dealerOf = (r) => (G.dealer0 + r - 1) % n(); // r is 1-based
  const totals = () => G.names.map((_, i) => G.done.reduce((s, r) => s + scoreFor(r.bids[i], r.won[i]), 0));
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const fresh = () => ({ bids: G.names.map(() => 0), won: G.names.map(() => 0), stage: 'bid' });

  function startGame() {
    const names = setup.names.map((s, i) => s.trim() || `Player ${i + 1}`);
    if (new Set(names.map((s) => s.toLowerCase())).size !== names.length) return toast('Give each player a different name');
    const rounds = Math.max(1, Math.min(defaultRounds(names.length), Number(setup.rounds) || defaultRounds(names.length)));
    G = { names, rounds, dealer0: Math.floor(Math.random() * names.length), plusMinus: !!setup.plusMinus, done: [], cur: null, editing: null, tab: 'play' };
    G.cur = fresh();
    save();
    render();
  }

  function setupHTML() {
    const cnt = setup.names.length;
    const rows = setup.names
      .map((nm, i) => `<div class="row"><input type="text" maxlength="20" data-name="${i}" placeholder="Player ${i + 1}" value="${esc(nm)}" aria-label="Player ${i + 1} name">${cnt > 3 ? `<button class="btn ghost small" data-act="rm" data-i="${i}" aria-label="Remove player ${i + 1}">✕</button>` : ''}</div>`)
      .join('');
    const max = defaultRounds(cnt);
    return `<main class="sc">
      <div class="sc-top"><h1>Wizard scorecard</h1><a href="/">Card Table</a></div>
      <p class="sub">Keep score for a game of Wizard played with a real deck. Works offline, and your game is saved on this device.</p>
      <section class="panel names"><div class="label">Players (3 to 6, in seating order)</div>${rows}
        ${cnt < 6 ? '<button class="btn ghost small" data-act="add" style="justify-self:start">+ Add player</button>' : ''}</section>
      <section class="panel names">
        <label class="label" for="rounds">Rounds to play</label>
        <input id="rounds" type="text" inputmode="numeric" data-rounds value="${setup.rounds || max}" aria-label="Rounds">
        <p class="sub">A full game with ${cnt} players is ${max} rounds (the deck has 60 cards).</p>
        <label class="chk"><input type="checkbox" data-pm ${setup.plusMinus ? 'checked' : ''}><span><b>Plus / Minus 1 rule</b><br><span class="sub">The dealer may not make the total of all bids equal the number of tricks. The scorecard warns you.</span></span></label>
      </section>
      <button class="btn big" data-act="start">Start game</button>
    </main>`;
  }

  function stepper(i, val, max) {
    return `<div class="step"><button type="button" data-act="dec" data-i="${i}" aria-label="Less">−</button><output aria-live="polite">${val}</output><button type="button" data-act="inc" data-i="${i}" aria-label="More">+</button></div>`;
  }

  function playHTML() {
    const r = roundNo();
    const dealer = dealerOf(r);
    const first = (dealer + 1) % n();
    const c = G.cur;
    const key = c.stage === 'bid' ? 'bids' : 'won';
    const tot = totals();
    const rows = G.names
      .map((nm, i) => `<div class="prow ${i === dealer ? 'dealer' : ''} ${c.stage === 'bid' && i === first ? 'first' : ''}">
        <div class="who"><b>${esc(nm)}${i === dealer ? '<span class="bdg d">Dealer</span>' : ''}${c.stage === 'bid' && i === first ? '<span class="bdg f">Bids first</span>' : ''}</b><small>${tot[i]} pts</small></div>
        ${stepper(i, c[key][i], r)}</div>`)
      .join('');
    const s = sum(c[key]);
    let bar;
    if (c.stage === 'bid') {
      const d = s - r;
      const warn = G.plusMinus && s === r;
      bar = `<div class="sumbar ${warn ? 'warn' : ''}">Total bid <b>${s}</b> / <b>${r}</b> tricks · ${d === 0 ? (warn ? `the dealer must change their bid (Plus / Minus 1)` : 'exactly right') : d > 0 ? `over by ${d}` : `under by ${-d}`}</div>`;
    } else bar = `<div class="sumbar ${s === r ? 'ok' : 'warn'}">Tricks won <b>${s}</b> / <b>${r}</b>${s === r ? ' ✓' : s < r ? ` · ${r - s} still to enter` : ` · ${s - r} too many`}</div>`;
    const last = G.editing === null && G.done.length + 1 >= G.rounds;
    return `<div class="stage"><span class="${c.stage === 'bid' ? 'on' : ''}">1 · Bids</span><span class="${c.stage === 'won' ? 'on' : ''}">2 · Tricks won</span></div>
      <h2>${G.editing !== null ? 'Editing round ' + r : 'Round ' + r + ' of ' + G.rounds}</h2>
      <p class="sub">${r} card${r === 1 ? '' : 's'} each${c.stage === 'bid' ? ` · ${esc(G.names[first])} bids first` : ''}</p>
      <div class="plist">${rows}</div>${bar}
      <div class="row">${c.stage === 'won' ? '<button class="btn ghost" data-act="back">← Bids</button>' : ''}
      ${c.stage === 'bid' ? '<button class="btn big" data-act="tricks">Bids are in →</button>' : `<button class="btn big" data-act="save" ${s === r ? '' : 'disabled'}>${last ? 'Save and finish' : G.editing !== null ? 'Save changes' : 'Save round'}</button>`}</div>`;
  }

  function scoresHTML() {
    const head = `<tr><th>Rd</th>${G.names.map((nm) => `<th>${esc(nm)}</th>`).join('')}</tr>`;
    const body = G.done
      .map((r, k) => `<tr class="edit" data-act="edit" data-k="${k}"><td>${k + 1}</td>${G.names.map((_, i) => { const d = scoreFor(r.bids[i], r.won[i]); return `<td class="cell"><span class="${d >= 0 ? 'pos' : 'neg'}">${d > 0 ? '+' : ''}${d}</span><small>${r.bids[i]} / ${r.won[i]}</small></td>`; }).join('')}</tr>`)
      .join('');
    const tot = totals();
    const best = Math.max(...tot);
    const foot = G.done.length ? `<tfoot><tr><td>Total</td>${tot.map((t) => `<td class="${G.done.length && t === best ? 'lead' : ''}">${t}</td>`).join('')}</tr></tfoot>` : '';
    return `<h2>Scores</h2><p class="sub">Each cell shows the points, then bid / won. Tap a round to correct it.</p>
      <div class="score-wrap"><table class="score"><thead>${head}</thead><tbody>${body || `<tr><td colspan="${n() + 1}" class="hint">No rounds saved yet</td></tr>`}</tbody>${foot}</table></div>`;
  }

  function finishHTML() {
    const tot = totals();
    const order = G.names.map((nm, i) => ({ nm, t: tot[i] })).sort((a, b) => b.t - a.t);
    const best = order[0].t;
    return `<h2>Game over 🏆</h2>
      <ol class="podium">${order.map((o, k) => `<li><span>${o.t === best ? '🏆' : k + 1 + '.'}</span><span>${esc(o.nm)}</span><span class="pts">${o.t}</span></li>`).join('')}</ol>
      <button class="btn big" data-act="new">New game</button>`;
  }

  const over = () => G.done.length >= G.rounds && G.editing === null;

  function gameHTML() {
    const body = G.tab === 'scores' ? scoresHTML() : over() ? finishHTML() : playHTML();
    return `<main class="sc">
      <div class="sc-top"><h1>Wizard scorecard</h1><a href="/">Card Table</a></div>
      <div class="tabs" role="tablist"><button class="${G.tab === 'scores' ? '' : 'on'}" data-act="tab" data-t="play">Round</button><button class="${G.tab === 'scores' ? 'on' : ''}" data-act="tab" data-t="scores">Scores</button></div>
      ${body}
      <div class="menu"><button class="btn ghost small" data-act="undo" ${G.done.length ? '' : 'disabled'}>Undo last round</button><button class="btn ghost small" data-act="copy" ${G.done.length ? '' : 'disabled'}>Copy scores</button><button class="btn ghost small" data-act="new">New game</button></div>
    </main>`;
  }

  function render() {
    const keep = document.activeElement && document.activeElement.dataset ? { name: document.activeElement.dataset.name, rounds: document.activeElement.dataset.rounds } : {};
    $.innerHTML = G ? gameHTML() : setupHTML();
    if (keep.name !== undefined) {
      const el = $.querySelector(`[data-name="${keep.name}"]`);
      if (el) { el.focus(); try { el.setSelectionRange(el.value.length, el.value.length); } catch { /* ignore */ } }
    }
  }

  function summary() {
    const tot = totals();
    return `Wizard scores after ${G.done.length} round${G.done.length === 1 ? '' : 's'}:\n` + G.names.map((nm, i) => ({ nm, t: tot[i] })).sort((a, b) => b.t - a.t).map((o, k) => `${k + 1}. ${o.nm}: ${o.t}`).join('\n');
  }

  const acts = {
    add: () => { if (setup.names.length < 6) { setup.names.push(''); setup.rounds = 0; render(); } },
    rm: (el) => { if (setup.names.length > 3) { setup.names.splice(Number(el.dataset.i), 1); setup.rounds = 0; render(); } },
    start: startGame,
    inc: (el) => { const k = G.cur.stage === 'bid' ? 'bids' : 'won'; const i = Number(el.dataset.i); G.cur[k][i] = Math.min(roundNo(), G.cur[k][i] + 1); save(); render(); },
    dec: (el) => { const k = G.cur.stage === 'bid' ? 'bids' : 'won'; const i = Number(el.dataset.i); G.cur[k][i] = Math.max(0, G.cur[k][i] - 1); save(); render(); },
    tricks: () => { G.cur.stage = 'won'; save(); render(); },
    back: () => { G.cur.stage = 'bid'; save(); render(); },
    save: () => {
      if (sum(G.cur.won) !== roundNo()) return toast(`Tricks won must add up to ${roundNo()}`);
      const rec = { bids: G.cur.bids.slice(), won: G.cur.won.slice() };
      if (G.editing !== null) { G.done[G.editing] = rec; G.editing = null; G.tab = 'scores'; } else G.done.push(rec);
      G.cur = fresh();
      save();
      render();
    },
    tab: (el) => { G.tab = el.dataset.t; save(); render(); },
    edit: (el) => {
      const k = Number(el.dataset.k);
      G.editing = k;
      G.cur = { bids: G.done[k].bids.slice(), won: G.done[k].won.slice(), stage: 'bid' };
      G.tab = 'play';
      save();
      render();
    },
    undo: () => {
      if (!G.done.length || !confirm('Remove the last saved round?')) return;
      G.done.pop();
      G.editing = null;
      G.cur = fresh();
      save();
      render();
    },
    copy: async () => {
      try { await navigator.clipboard.writeText(summary()); toast('Scores copied'); } catch { window.prompt('Copy the scores:', summary()); }
    },
    new: () => {
      if (G && G.done.length && !over() && !confirm('Start a new game? The current scores will be lost.')) return;
      setup = { names: G ? G.names.slice() : ['', '', ''], rounds: 0, plusMinus: false };
      G = null;
      try { localStorage.removeItem(KEY); } catch { /* ignore */ }
      render();
    },
  };

  $.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (el && !el.disabled && Object.hasOwn(acts, el.dataset.act)) acts[el.dataset.act](el);
  });
  $.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.name !== undefined) setup.names[Number(t.dataset.name)] = t.value;
    else if (t.dataset.rounds !== undefined) setup.rounds = Number(t.value.replace(/\D/g, '')) || 0;
  });
  $.addEventListener('change', (e) => { if (e.target.dataset.pm !== undefined) setup.plusMinus = e.target.checked; });

  render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
