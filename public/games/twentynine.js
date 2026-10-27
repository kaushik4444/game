/* 29 table renderer. Shares table.css with Wizard. */
(() => {
  'use strict';
  const { esc, toast } = window.CardTable;

  // 4-colour suits: the CSS classes suit-R/Y/G/B are shared with Wizard.
  const SUITS = {
    S: { sym: '♠', name: 'Spades', cls: 'suit-B' },
    H: { sym: '♥', name: 'Hearts', cls: 'suit-R' },
    D: { sym: '♦', name: 'Diamonds', cls: 'suit-Y' },
    C: { sym: '♣', name: 'Clubs', cls: 'suit-G' },
  };
  const ui = { selected: null, bid: null, scores: false, shownKey: null, timer: null, prevTrick: new Set(), ctx: null, latest: null, hand: 0 };
  const POINTS = { J: 3, 9: 2, A: 1, 10: 1 };

  function cardHTML(c, { tag = 'div', cls = '', attrs = '' } = {}) {
    const s = SUITS[c.suit];
    const pts = c.pts ? `<span class="cpts" title="${c.pts} point${c.pts > 1 ? 's' : ''}">${c.pts}</span>` : '';
    return `<${tag} class="card ${s.cls} ${cls}" aria-label="${esc(c.rank + ' of ' + s.name)}${c.pts ? ', ' + c.pts + ' points' : ''}" ${attrs}><span class="rk">${esc(c.rank)}<i>${s.sym}</i></span><span class="pip">${s.sym}</span>${pts}<span class="rk br">${esc(c.rank)}<i>${s.sym}</i></span></${tag}>`;
  }
  const suitPill = (s) => `<span class="pill ${SUITS[s].cls}"><b>${SUITS[s].sym}</b> ${SUITS[s].name}</span>`;
  const teamOf = (i) => i % 2;

  function sizes(v) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    let cw = w < 480 ? 62 : w < 900 ? 78 : 90;
    if (h < 620) cw = Math.min(cw, 56);
    const n = v.hand.length;
    const avail = Math.min(w, 980) - 20;
    let overlap = -6;
    if (n > 1 && n * cw + (n - 1) * 6 > avail) overlap = Math.round(cw - Math.max((avail - cw) / (n - 1), cw * 0.34));
    return { cw, overlap };
  }

  function relation(v, i) {
    if (i === v.me) return 'You';
    return teamOf(i) === teamOf(v.me) ? 'Partner' : 'Opponent';
  }

  function statusText(v) {
    const name = (i) => esc(v.players[i].name);
    switch (v.phase) {
      case 'bidding':
        return v.myTurn ? `Your bid: ${v.minBid} to ${v.maxBid}, or pass` : `${name(v.turn)} is bidding…`;
      case 'chooseTrump':
        return v.myTurn ? 'You won the bid. Choose your trump suit (kept secret).' : `${name(v.highBidder)} is choosing trump…`;
      case 'playing':
        if (v.myTurn) {
          if (v.canReveal) return 'You can’t follow suit. Show the trump, or discard.';
          if (v.mustTrump) return 'Trump is shown. Play a trump card.';
          return ui.selected ? 'Tap the card again, or press Play' : 'Your turn. Pick a card.';
        }
        return `${name(v.turn)} is playing…`;
      case 'handEnd':
        return 'Hand complete';
      default:
        return 'Game over';
    }
  }

  function trumpHTML(v) {
    if (v.trumpSuit) return `<div><span class="label">Trump${v.trumpRevealed ? '' : ' · secret'}</span><div>${suitPill(v.trumpSuit)}</div></div>`;
    if (v.trumpSet) return '<div><span class="label">Trump</span><div><b>🔒 Hidden</b></div></div>';
    return '<div><span class="label">Trump</span><div><b>Not chosen</b></div></div>';
  }

  function scoreStrip(v) {
    const mine = teamOf(v.me);
    const us = mine, them = 1 - mine;
    const bid = v.highBidder >= 0 && v.phase !== 'bidding' ? `<span class="bidinfo">Bid ${v.highBid} by ${esc(v.players[v.highBidder].name)}</span>` : '';
    return `<div class="t29-strip">
      <div class="tbox us"><span class="label">Your team</span><b>${v.teamScore[us]}</b><small>game pts · hand ${v.handPoints[us]}</small></div>
      ${bid}
      <div class="tbox them"><span class="label">Opponents</span><b>${v.teamScore[them]}</b><small>game pts · hand ${v.handPoints[them]}</small></div>
    </div>`;
  }

  function playersHTML(v) {
    const order = [];
    for (let k = 0; k < 4; k++) order.push((Math.max(v.me, 0) + k) % 4);
    return order
      .map((i) => {
        const p = v.players[i];
        const turn = v.turn === i;
        const b = v.bids[i];
        const line = v.phase === 'bidding' ? (b === null ? (turn ? 'bidding…' : 'waiting') : b === 'pass' ? 'passed' : `bid ${b}`) : v.highBidder === i ? `bidder · ${v.highBid}` : relation(v, i);
        return `<div class="chip t${teamOf(i) === teamOf(v.me) ? 'us' : 'them'} ${turn ? 'turn' : ''} ${i === v.me ? 'me' : ''}">
          <div class="nm">${esc(p.name)}${i === v.me ? ' (you)' : ''}${i === v.dealer ? '<span class="dbadge" title="Dealer">D</span>' : ''}</div>
          <div class="st">${esc(line)}</div>
          <div class="sc">${v.phase === 'bidding' ? relation(v, i) : p.cards + ' cards'}</div>
        </div>`;
      })
      .join('');
  }

  function trickHTML(v) {
    const live = v.trick.length > 0;
    const shown = live ? v.trick : v.lastTrick ? v.lastTrick.cards : [];
    const ids = new Set(shown.map((t) => t.card.id));
    let html;
    if (!shown.length) {
      const msg = v.phase === 'bidding' ? 'Bidding: highest bid picks the trump' : v.phase === 'chooseTrump' ? 'Waiting for trump…' : 'Lead the first card';
      html = `<div class="hint">${esc(msg)}</div>`;
    } else {
      const winner = !live && v.lastTrick ? v.lastTrick.winner : -1;
      const cards = shown
        .map((t) => `<div class="tslot ${t.player === winner ? 'win' : ''}">${cardHTML(t.card, { cls: live && !ui.prevTrick.has(t.card.id) ? 'pop' : '' })}<span class="who">${esc(v.players[t.player].name)}</span></div>`)
        .join('');
      const cap = !live && v.lastTrick ? `<div class="hint">${esc(v.players[v.lastTrick.winner].name)} won the trick${v.lastTrick.points ? ` · ${v.lastTrick.points} point${v.lastTrick.points > 1 ? 's' : ''}` : ''}</div>` : '';
      html = `${cap}<div class="trick">${cards}</div>`;
    }
    ui.prevTrick = ids;
    return html;
  }

  function controlsHTML(v) {
    if (v.phase === 'chooseTrump' && v.myTurn) {
      const mine = [...new Set(v.hand.map((c) => c.suit))];
      return `<div class="bidbox"><div class="label">Choose trump (only suits you hold)</div><div class="bidgrid">${mine
        .map((s) => `<button class="suitbtn ${SUITS[s].cls}" data-t9="trump" data-s="${s}"><b>${SUITS[s].sym}</b> ${SUITS[s].name}</button>`)
        .join('')}</div></div>`;
    }
    if (v.phase === 'bidding' && v.myTurn) {
      const btns = [];
      for (let i = v.minBid; i <= v.maxBid; i++) btns.push(`<button class="bidbtn ${ui.bid === i ? 'on' : ''}" data-t9="pick" data-n="${i}">${i}</button>`);
      return `<div class="bidbox"><div class="row" style="justify-content:space-between"><span class="label">${v.highBidder >= 0 ? `Current bid: ${v.highBid}` : 'No bid yet'}</span>
        <span class="row" style="gap:6px"><button class="btn ghost small" data-t9="pass" ${v.canPass ? '' : 'disabled'}>Pass</button>
        <button class="btn small" data-t9="bid" ${ui.bid === null ? 'disabled' : ''}>${ui.bid === null ? 'Pick a bid' : `Bid ${ui.bid}`}</button></span></div>
        <div class="bidgrid">${btns.join('')}</div>${v.canPass ? '' : '<div class="hint">Everyone passed, so as dealer you must bid.</div>'}</div>`;
    }
    return '';
  }

  function handHTML(v, z) {
    const can = v.phase === 'playing' && v.myTurn;
    const legal = new Set(v.legal);
    return v.hand
      .map((c, i) => {
        const cls = [can && legal.has(c.id) ? 'playable' : '', can && !legal.has(c.id) ? 'dim' : '', ui.selected === c.id ? 'sel' : ''].join(' ');
        return cardHTML(c, { tag: 'button', cls: 'hc ' + cls, attrs: `data-t9="card" data-id="${c.id}" style="${i ? `margin-left:${-z.overlap}px` : ''}"` });
      })
      .join('');
  }

  function historyTable(v) {
    const mine = teamOf(v.me);
    const rows = v.history
      .map((h) => {
        const t = teamOf(h.bidder);
        return `<tr><td>#${h.hand}</td><td>${esc(v.players[h.bidder].name)}</td><td>${h.bid}</td><td>${SUITS[h.trumpSuit].sym}</td><td>${h.points[mine]}–${h.points[1 - mine]}</td><td class="${h.made ? 'pos' : 'neg'}">${t === mine ? (h.made ? '+1 us' : '−1 us') : h.made ? '+1 them' : '−1 them'}</td></tr>`;
      })
      .join('');
    return `<div class="score-wrap"><table class="score"><thead><tr><th>Hand</th><th>Bidder</th><th>Bid</th><th>Trump</th><th>Points (us–them)</th><th>Result</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="hint">No hands finished yet</td></tr>'}</tbody></table></div>`;
  }

  function overlayHTML(v) {
    if (ui.scores) {
      return `<div class="overlay" data-t9="closeScores"><div class="sheet" data-stop="1"><h2>Scoreboard</h2>${scoreStrip(v)}${historyTable(v)}<div class="row" style="margin-top:12px"><button class="btn" data-t9="closeScores">Close</button><button class="btn ghost" data-t9="rules">How to play</button></div></div></div>`;
    }
    const key = v.phase + ':' + v.handNo;
    if ((v.phase !== 'handEnd' && v.phase !== 'gameOver') || ui.shownKey !== key) return '';
    const h = v.history[v.history.length - 1];
    const mine = teamOf(v.me);
    const bidderMine = teamOf(h.bidder) === mine;
    const result = `<p><b>${esc(v.players[h.bidder].name)}</b> (${bidderMine ? 'your team' : 'opponents'}) bid <b>${h.bid}</b> with trump ${SUITS[h.trumpSuit].sym} and took <b>${h.points[teamOf(h.bidder)]}</b> points: <b class="${h.made ? 'pos' : 'neg'}">${h.made ? 'bid made' : 'bid failed'}</b>.</p>
      <p>Hand points: your team ${h.points[mine]}, opponents ${h.points[1 - mine]}.<br>Game points: your team <b>${h.score[mine]}</b>, opponents <b>${h.score[1 - mine]}</b>.</p>`;
    if (v.phase === 'handEnd') {
      return `<div class="overlay"><div class="sheet"><h2>Hand ${v.handNo} complete</h2>${result}<div class="row" style="margin-top:12px"><button class="btn" data-t9="next">Next hand</button><span class="hint">Starts automatically in a few seconds</span></div></div></div>`;
    }
    const won = v.winnerTeam === mine;
    return `<div class="overlay"><div class="sheet"><h2>${won ? 'Your team won! 🎉' : 'Your team lost'}</h2>${result}
      <div class="row">${ui.ctx.isHost ? '<button class="btn" data-t9="again">Play again</button>' : '<span class="hint">Waiting for the host to start another game</span>'}
      <button class="btn ghost" data-t9="scores">Full scoreboard</button><button class="btn ghost" data-t9="leave">Leave table</button></div></div></div>`;
  }

  function render(root, v, ctx) {
    ui.ctx = ctx;
    ui.latest = v;
    if (v.handNo !== ui.hand) {
      ui.hand = v.handNo;
      ui.bid = null;
      ui.selected = null;
      ui.prevTrick = new Set();
    }
    if (!v.myTurn || v.phase !== 'playing' || !v.hand.some((c) => c.id === ui.selected)) ui.selected = null;
    if (!v.myTurn || v.phase !== 'bidding' || (ui.bid !== null && ui.bid < v.minBid)) ui.bid = null;

    const key = v.phase + ':' + v.handNo;
    if ((v.phase === 'handEnd' || v.phase === 'gameOver') && ui.shownKey !== key && !ui.timer) {
      ui.timer = setTimeout(() => {
        ui.timer = null;
        const cur = ui.latest;
        if (cur && cur.phase + ':' + cur.handNo === key) {
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
    <div class="wz t29" style="--cw:${z.cw}px">
      <div class="wz-top">
        <div class="wz-round"><b>Hand ${v.handNo}</b><span class="label"> · to ${v.options.target}</span></div>
        <div class="wz-trump">${trumpHTML(v)}</div>
        <div class="row" style="gap:6px"><button class="btn ghost small" data-t9="scores">Scores</button><button class="btn ghost small" data-t9="leave" aria-label="Leave table">✕</button></div>
      </div>
      ${scoreStrip(v)}
      <div class="wz-players four">${playersHTML(v)}</div>
      <div class="wz-table">${trickHTML(v)}</div>
      <div class="wz-status ${v.myTurn ? 'mine' : ''}"><span>${statusText(v)}</span>
        ${v.canReveal ? '<button class="btn small" data-t9="reveal">Show trump</button>' : ''}
        ${canPlay ? '<button class="btn small" data-t9="play">Play</button>' : ''}</div>
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
    const el = e.target.closest('[data-t9]');
    if (!el) return;
    const v = ui.latest;
    const ctx = ui.ctx;
    if (!v || !ctx) return;
    if (el.classList.contains('overlay') && e.target !== el) return;
    switch (el.dataset.t9) {
      case 'card': {
        const card = v.hand.find((c) => c.id === el.dataset.id);
        if (!card) return;
        if (v.phase !== 'playing') return toast(v.phase === 'bidding' ? 'Bidding comes first' : v.phase === 'chooseTrump' ? 'Trump is being chosen' : 'Wait for the next hand');
        if (!v.myTurn) return toast('Not your turn yet');
        if (!v.legal.includes(card.id)) return toast(v.mustTrump ? 'You must play a trump card' : 'You must follow the lead suit if you can');
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
      case 'reveal':
        ctx.act({ type: 'reveal' });
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
      case 'pass':
        ctx.act({ type: 'bid', pass: true });
        break;
      case 'trump':
        ctx.act({ type: 'chooseTrump', suit: el.dataset.s });
        break;
      case 'scores':
        ui.scores = true;
        ctx.rerender();
        break;
      case 'closeScores':
        ui.scores = false;
        ctx.rerender();
        break;
      case 'rules':
        ctx.showRules();
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

  window.addEventListener('resize', () => { if (ui.ctx && ui.latest && ui.latest.game === 'twentynine' && document.querySelector('.t29')) ui.ctx.rerender(); });

  window.CardTable.register('twentynine', { render });
})();
