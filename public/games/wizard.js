/* Wizard table renderer. Registered with the app shell via CardTable.register('wizard', ...). */
(() => {
  'use strict';
  const { esc, toast } = window.CardTable;

  const SUITS = {
    R: { sym: '♥', name: 'Red' },
    Y: { sym: '★', name: 'Yellow' },
    G: { sym: '♣', name: 'Green' },
    B: { sym: '♠', name: 'Blue' },
  };
  const cardName = (c) => (c.type === 'back' ? 'Hidden card' : c.type === 'wizard' ? 'Wizard' : c.type === 'jester' ? 'Jester' : `${SUITS[c.suit].name} ${c.rank}`);

  // UI-only state that survives re-renders (the server is the source of truth for the game itself).
  const ui = { selected: null, bid: null, scores: false, shownKey: null, timer: null, prevTrick: new Set(), ctx: null, latest: null, round: 0 };

  function cardHTML(c, { tag = 'div', cls = '', attrs = '' } = {}) {
    const label = esc(cardName(c));
    if (c.type === 'back') {
      return `<${tag} class="card back ${cls}" aria-label="Your hidden card" ${attrs}><span class="pip">?</span></${tag}>`;
    }
    if (c.type === 'wizard') {
      return `<${tag} class="card wizard ${cls}" aria-label="${label}" ${attrs}><span class="rk">W</span><span class="pip">🧙</span><span class="rk br">W</span></${tag}>`;
    }
    if (c.type === 'jester') {
      return `<${tag} class="card jester ${cls}" aria-label="${label}" ${attrs}><span class="rk">J</span><span class="pip">🃏</span><span class="rk br">J</span></${tag}>`;
    }
    const s = SUITS[c.suit].sym;
    return `<${tag} class="card suit-${c.suit} ${cls}" aria-label="${label}" ${attrs}><span class="rk">${c.rank}<i>${s}</i></span><span class="pip">${s}</span><span class="rk br">${c.rank}<i>${s}</i></span></${tag}>`;
  }

  const suitPill = (s) => `<span class="pill suit-${s}"><b>${SUITS[s].sym}</b> ${SUITS[s].name}</span>`;

  function sizes(v) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    let cw = w < 480 ? 62 : w < 900 ? 78 : 90;
    if (h < 620) cw = Math.min(cw, 56);
    const tcw = v.n > 4 ? Math.round(cw * 0.82) : cw;
    // Hand: overlap cards when they don't fit, scroll sideways if still too wide.
    const n = v.hand.length;
    const avail = Math.min(w, 980) - 20;
    let overlap = -6;
    if (n > 1 && n * cw + (n - 1) * 6 > avail) {
      const step = Math.max((avail - cw) / (n - 1), cw * 0.34);
      overlap = Math.round(cw - step);
    }
    return { cw, tcw, overlap };
  }

  function statusText(v) {
    const name = (i) => esc(v.players[i].name);
    if (v.phase === 'chooseTrump') return v.myTurn ? 'A wizard was turned up. Choose the trump suit.' : `${name(v.dealer)} is choosing trump…`;
    if (v.phase === 'bidding' && v.simultaneous) {
      const waiting = v.players.filter((p) => !p.hasBid).length;
      return v.myTurn ? 'Everyone bids at once. How many tricks will you win?' : waiting ? `Waiting for ${waiting} more bid${waiting === 1 ? '' : 's'}…` : 'Bids are in';
    }
    if (v.phase === 'bidding') return v.myTurn ? 'Your bid: how many tricks will you win?' : `${name(v.turn)} is bidding…`;
    if (v.phase === 'playing') {
      if (v.myTurn) return ui.selected ? 'Tap the card again, or press Play' : 'Your turn. Pick a card.';
      return `${name(v.turn)} is playing…`;
    }
    if (v.phase === 'roundEnd') return 'Round complete';
    return 'Game over';
  }

  function playersHTML(v) {
    const order = [];
    for (let k = 0; k < v.n; k++) order.push((Math.max(v.me, 0) + k) % v.n);
    return order
      .map((i) => {
        const p = v.players[i];
        const turn = v.turn === i && (v.phase === 'bidding' || v.phase === 'playing' || v.phase === 'chooseTrump');
        let line;
        if (p.bid !== null) line = `bid ${p.bid} · won ${p.tricks}`;
        else if (v.simultaneous && p.hasBid) line = v.phase === 'bidding' ? 'bid placed ✓' : `bid hidden · won ${p.tricks}`;
        else line = turn && v.phase === 'bidding' ? 'bidding…' : 'no bid yet';
        const fs = (v.foresight || []).find((f) => f.player === i);
        const hit = p.bid !== null && p.tricks === p.bid;
        return `<div class="chip ${turn ? 'turn' : ''} ${i === v.me ? 'me' : ''} ${fs ? 'hasfs' : ''}">
          ${fs ? `<div class="fs" title="${esc(p.name)}’s card">${cardHTML(fs.card)}</div>` : ''}
          <div class="nm">${esc(p.name)}${i === v.me ? ' (you)' : ''}${i === v.dealer ? '<span class="dbadge" title="Dealer">D</span>' : ''}</div>
          <div class="st ${hit && v.phase === 'playing' ? 'ok' : ''}">${line}</div>
          <div class="sc">${p.score} pts</div>
        </div>`;
      })
      .join('');
  }

  function trickHTML(v, z) {
    const live = v.trick.length > 0;
    const shown = live ? v.trick : v.lastTrick ? v.lastTrick.cards : [];
    const ids = new Set(shown.map((t) => t.card.id));
    let html;
    if (!shown.length) {
      const total = v.players.reduce((s, p) => s + (p.bid || 0), 0);
      const placed = v.players.filter((p) => p.hasBid).length;
      const fsNote = v.foresight && v.foresight.length ? ' Foresight: you can’t see your own card, but you can see the others.' : '';
      const msg =
        v.phase === 'bidding' ? (v.simultaneous ? `Bids placed: ${placed} of ${v.n}.${fsNote}` : `Bids so far: ${total} of ${v.round} trick${v.round === 1 ? '' : 's'}.${fsNote}`) : v.phase === 'chooseTrump' ? 'Waiting for trump…' : 'Lead the first card';
      html = `<div class="hint">${esc(msg)}</div>`;
    } else {
      const winner = !live && v.lastTrick ? v.lastTrick.winner : -1;
      const cards = shown
        .map((t) => {
          const isNew = live && !ui.prevTrick.has(t.card.id);
          return `<div class="tslot ${t.player === winner ? 'win' : ''}">${cardHTML(t.card, { cls: isNew ? 'pop' : '' })}<span class="who">${esc(v.players[t.player].name)}</span></div>`;
        })
        .join('');
      const cap = !live && v.lastTrick ? `<div class="hint">${esc(v.players[v.lastTrick.winner].name)} won the trick</div>` : '';
      html = `${cap}<div class="trick" style="--cw:${z.tcw}px">${cards}</div>`;
    }
    ui.prevTrick = ids;
    return html;
  }

  function trumpHTML(v) {
    if (v.phase === 'chooseTrump') return '<span class="label">Trump: dealer chooses</span>';
    const card = v.trumpCard ? `<div class="mini">${cardHTML(v.trumpCard)}</div>` : '';
    const txt = v.trumpSuit ? `<div><span class="label">Trump</span><div>${suitPill(v.trumpSuit)}</div></div>` : `<div><span class="label">Trump</span><div><b>None</b></div></div>`;
    return card + txt;
  }

  function controlsHTML(v) {
    if (v.phase === 'chooseTrump' && v.myTurn) {
      return `<div class="bidbox"><div class="label">Choose the trump suit</div><div class="bidgrid">${Object.keys(SUITS)
        .map((s) => `<button class="suitbtn suit-${s}" data-wz="trump" data-s="${s}"><b>${SUITS[s].sym}</b> ${SUITS[s].name}</button>`)
        .join('')}</div></div>`;
    }
    if (v.phase === 'bidding' && v.myTurn) {
      const btns = [];
      for (let i = 0; i <= v.round; i++) {
        btns.push(`<button class="bidbtn ${ui.bid === i ? 'on' : ''}" data-wz="pick" data-n="${i}" ${i === v.forbiddenBid ? 'disabled' : ''}>${i}</button>`);
      }
      const note = v.forbiddenBid !== null ? `<div class="hint">Plus / Minus 1: as dealer you can’t bid ${v.forbiddenBid}, because the total would equal the number of tricks.</div>` : '';
      return `<div class="bidbox"><div class="row" style="justify-content:space-between"><span class="label">Tricks you will win</span>
        <button class="btn small" data-wz="bid" ${ui.bid === null ? 'disabled' : ''}>${ui.bid === null ? 'Pick a number' : `Bid ${ui.bid}`}</button></div>
        <div class="bidgrid">${btns.join('')}</div>${note}</div>`;
    }
    return '';
  }

  function handHTML(v, z) {
    const can = v.phase === 'playing' && v.myTurn;
    const legal = new Set(v.legal);
    return v.hand
      .map((c, i) => {
        const cls = [can && legal.has(c.id) ? 'playable' : '', can && !legal.has(c.id) ? 'dim' : '', ui.selected === c.id ? 'sel' : ''].join(' ');
        return cardHTML(c, { tag: 'button', cls: 'hc ' + cls, attrs: `data-wz="card" data-id="${c.id}" style="${i ? `margin-left:${-z.overlap}px` : ''}"` });
      })
      .join('');
  }

  const VARIANT_NAMES = { none: 'Standard bidding', plusminus: 'Plus / Minus 1', hidden: 'Hidden prediction', secret: 'Secret prediction' };
  function optionsLine(v) {
    const o = v.options;
    return [VARIANT_NAMES[o.variant], o.foresight ? 'Foresight' : '', o.length === 'short' ? 'Short game' : ''].filter(Boolean).join(' · ');
  }

  function scoreTable(v) {
    const rows = [];
    const totals = v.players.map(() => 0);
    for (const h of v.history) {
      const cells = h.rows
        .map((r, i) => {
          totals[i] = r.score;
          return `<td class="${i === v.me ? 'me-col' : ''}"><b class="${r.delta >= 0 ? 'pos' : 'neg'}">${r.score}</b><small>${r.bid}/${r.tricks}</small></td>`;
        })
        .join('');
      rows.push(`<tr><td>R${h.round}</td>${cells}</tr>`);
    }
    const head = v.players.map((p, i) => `<th class="${i === v.me ? 'me-col' : ''}">${esc(p.name)}</th>`).join('');
    const foot = v.players.map((p, i) => `<td class="${i === v.me ? 'me-col' : ''}"><b>${p.score}</b></td>`).join('');
    return `<div class="score-wrap"><table class="score"><thead><tr><th></th>${head}</tr></thead><tbody>${rows.join('') || `<tr><td colspan="${v.n + 1}" class="hint">No rounds finished yet</td></tr>`}</tbody><tfoot><tr><td>Total</td>${foot}</tr></tfoot></table></div>
      <p class="hint">Each cell: running score, then bid/won</p>`;
  }

  function overlayHTML(v) {
    if (ui.scores) {
      return `<div class="overlay" data-wz="closeScores"><div class="sheet" data-stop="1"><h2>Scoreboard</h2>${scoreTable(v)}<p class="hint">${esc(optionsLine(v))}</p><div class="row" style="margin-top:12px"><button class="btn" data-wz="closeScores">Close</button><button class="btn ghost" data-wz="rules">How to play</button></div></div></div>`;
    }
    const key = v.phase + ':' + v.round;
    if ((v.phase !== 'roundEnd' && v.phase !== 'gameOver') || ui.shownKey !== key) return '';
    const h = v.history[v.history.length - 1];
    if (v.phase === 'roundEnd') {
      const rows = v.players
        .map((p, i) => {
          const r = h.rows[i];
          return `<tr class="${i === v.me ? 'me-col' : ''}"><td>${esc(p.name)}</td><td>${r.bid}</td><td>${r.tricks}</td><td class="${r.delta >= 0 ? 'pos' : 'neg'}">${r.delta > 0 ? '+' : ''}${r.delta}</td><td><b>${r.score}</b></td></tr>`;
        })
        .join('');
      return `<div class="overlay"><div class="sheet"><h2>Round ${v.round} of ${v.totalRounds}</h2>
        <div class="score-wrap"><table class="score"><thead><tr><th>Player</th><th>Bid</th><th>Won</th><th>Pts</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table></div>
        <div class="row" style="margin-top:14px"><button class="btn" data-wz="next">Next round</button><span class="hint">Starts automatically in a few seconds</span></div></div></div>`;
    }
    const order = v.players.map((p, i) => ({ p, i })).sort((a, b) => b.p.score - a.p.score);
    const win = v.winners.includes(v.players[v.me] && v.players[v.me].id);
    const list = order
      .map(({ p }, k) => `<li><span>${v.winners.includes(p.id) ? '🏆' : k + 1 + '.'}</span><span>${esc(p.name)}</span><span class="pts">${p.score}</span></li>`)
      .join('');
    return `<div class="overlay"><div class="sheet"><h2>${win ? 'You won! 🎉' : 'Game over'}</h2><ol class="podium">${list}</ol>
      <div class="row">${ui.ctx.isHost ? '<button class="btn" data-wz="again">Play again</button>' : '<span class="hint">Waiting for the host to start another game</span>'}
      <button class="btn ghost" data-wz="scores">Full scoreboard</button><button class="btn ghost" data-wz="leave">Leave table</button></div></div></div>`;
  }

  function render(root, v, ctx) {
    ui.ctx = ctx;
    ui.latest = v;
    if (v.round !== ui.round) {
      ui.round = v.round;
      ui.bid = null;
      ui.selected = null;
      ui.prevTrick = new Set();
    }
    if (!v.myTurn || v.phase !== 'playing' || !v.hand.some((c) => c.id === ui.selected)) ui.selected = null;
    if (!v.myTurn || v.phase !== 'bidding') ui.bid = null;
    if (ui.bid !== null && ui.bid === v.forbiddenBid) ui.bid = null;

    // Show the round/game results a moment after the last trick, so the final trick is visible.
    const key = v.phase + ':' + v.round;
    if ((v.phase === 'roundEnd' || v.phase === 'gameOver') && ui.shownKey !== key && !ui.timer) {
      ui.timer = setTimeout(() => {
        ui.timer = null;
        const cur = ui.latest;
        if (cur && cur.phase + ':' + cur.round === key) {
          ui.shownKey = key;
          ui.ctx.rerender();
        }
      }, 1600);
    }

    const handEl = root.querySelector('.hand');
    const scroll = handEl ? handEl.scrollLeft : 0;
    const z = sizes(v);
    const canPlay = v.phase === 'playing' && v.myTurn && ui.selected;
    root.innerHTML = `
    <div class="wz" style="--cw:${z.cw}px">
      <div class="wz-top">
        <div class="wz-round"><b>Round ${v.round}</b><span class="label"> / ${v.totalRounds}</span></div>
        <div class="wz-trump">${trumpHTML(v)}</div>
        <div class="row" style="gap:6px"><button class="btn ghost small" data-wz="scores">Scores</button><button class="btn ghost small" data-wz="leave" aria-label="Leave table">✕</button></div>
      </div>
      <div class="wz-players">${playersHTML(v)}</div>
      <div class="wz-table">${trickHTML(v, z)}</div>
      <div class="wz-status ${v.myTurn ? 'mine' : ''}"><span>${statusText(v)}</span>${canPlay ? '<button class="btn small" data-wz="play">Play</button>' : ''}</div>
      ${controlsHTML(v)}
      <div class="hand"><div class="hand-in">${handHTML(v, z)}</div></div>
      ${overlayHTML(v)}
    </div>`;
    const h2 = root.querySelector('.hand');
    if (h2) h2.scrollLeft = scroll;
    root.onclick = onClick;
  }

  function onClick(e) {
    if (e.target.closest('[data-stop]') && !e.target.closest('button')) return;
    const el = e.target.closest('[data-wz]');
    if (!el) return;
    const v = ui.latest;
    const ctx = ui.ctx;
    if (!v || !ctx) return;
    if (el.classList.contains('overlay') && e.target !== el) return; // click on backdrop only
    switch (el.dataset.wz) {
      case 'card': {
        const card = v.hand.find((c) => c.id === el.dataset.id);
        if (!card) return;
        if (v.phase !== 'playing') return toast(v.phase === 'bidding' ? 'Place your bid first' : 'Wait for the next round');
        if (!v.myTurn) return toast('Not your turn yet');
        if (!v.legal.includes(card.id)) return toast('You must follow the lead suit if you can');
        if (ui.selected === card.id) {
          ui.selected = null;
          ctx.act({ type: 'play', cardId: card.id });
        } else {
          ui.selected = card.id;
          ctx.rerender();
        }
        break;
      }
      case 'play':
        if (ui.selected) {
          const id = ui.selected;
          ui.selected = null;
          ctx.act({ type: 'play', cardId: id });
        }
        break;
      case 'pick':
        ui.bid = Number(el.dataset.n);
        ctx.rerender();
        break;
      case 'bid':
        if (ui.bid !== null) {
          const amount = ui.bid;
          ui.bid = null;
          ctx.act({ type: 'bid', amount });
        }
        break;
      case 'trump':
        ctx.act({ type: 'chooseTrump', suit: el.dataset.s });
        break;
      case 'scores':
        ui.scores = true;
        ctx.rerender();
        break;
      case 'rules':
        ctx.showRules();
        break;
      case 'closeScores':
        ui.scores = false;
        ctx.rerender();
        break;
      case 'next':
        ctx.act({ type: 'continue' });
        break;
      case 'again':
        ctx.rematch();
        break;
      case 'leave':
        ctx.leave();
        break;
    }
  }

  window.addEventListener('resize', () => { if (ui.ctx && ui.latest && document.querySelector('.wz')) ui.ctx.rerender(); });

  window.CardTable.register('wizard', { render });
})();
