/* Poker (Texas Hold'em) table renderer. Uses the shared oval table from table-ui.js; styles in poker.css. */
(() => {
  'use strict';
  const { esc, toast, pt } = window.CardTable;

  const SUIT = {
    S: { sym: '♠', name: 'Spades', cls: 'ps' },
    H: { sym: '♥', name: 'Hearts', cls: 'ph' },
    D: { sym: '♦', name: 'Diamonds', cls: 'pd' },
    C: { sym: '♣', name: 'Clubs', cls: 'pc' },
  };
  const RANKS = '23456789TJQKA';
  const ui = { raiseTo: 0, key: '', standings: false, ctx: null, latest: null, snap: null, hand: 0 };

  const fmt = (n) => Number(n).toLocaleString('en-US');
  const rankLabel = (r) => (r === 'T' ? '10' : r);
  const fromId = (id) => ({ id, rank: RANKS.indexOf(id[0]) + 2, r: id[0], suit: id[1] });

  function cardHTML(c, cls = '') {
    const r = c.r || RANKS[c.rank - 2];
    const s = SUIT[c.suit];
    return `<div class="pkc ${s.cls} ${cls}" aria-label="${esc(rankLabel(r) + ' of ' + s.name)}"><span class="r">${rankLabel(r)}</span><span class="s">${s.sym}</span></div>`;
  }
  const backHTML = (cls = '') => `<div class="pkc back ${cls}" aria-hidden="true"></div>`;

  function sizes() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    let board = w < 480 ? 42 : w < 900 ? 58 : 70;
    let hand = w < 480 ? 74 : w < 900 ? 92 : 104;
    if (h < 640) { board = Math.min(board, 38); hand = Math.min(hand, 64); }
    return { board, hand };
  }

  // ------------------------------------------------------------------ pieces
  function statusText(v) {
    const name = (i) => esc(v.players[i].name);
    if (v.phase === 'gameOver') return 'Game over';
    if (v.phase === 'handEnd') return `Hand ${v.handNo} complete`;
    if (v.me < 0) return v.turn >= 0 ? `${name(v.turn)} to act…` : 'Watching';
    const me = v.players[v.me];
    if (!me.inHand) return v.turn >= 0 ? `You are out. ${name(v.turn)} to act…` : 'You are out';
    if (me.folded) return `You folded. ${v.turn >= 0 ? name(v.turn) + ' to act…' : ''}`;
    if (v.myTurn) return v.canCheck ? 'Your turn. Check or bet.' : `Your turn. ${fmt(v.toCall)} to call.`;
    if (me.allIn) return 'You are all-in. Good luck!';
    return v.turn >= 0 ? `${name(v.turn)} to act…` : '';
  }

  function seatHTML(v, ctx, i) {
    const p = v.players[i];
    const inHandNow = p.inHand && v.phase !== 'gameOver';
    const turn = v.turn === i && v.phase === 'betting';
    const winAmt = v.phase !== 'betting' && v.result ? (v.result.winners.find((w) => w.player === i) || {}).amount : 0;
    let sub;
    if (p.out) sub = 'Out';
    else if (p.allIn && p.inHand && !p.folded) sub = `${fmt(p.chips + p.bet)} · all-in`;
    else sub = fmt(p.chips);
    const badges =
      (inHandNow && i === v.sbIdx ? '<span class="bdg b" title="Small blind">SB</span>' : '') + (inHandNow && i === v.bbIdx ? '<span class="bdg b" title="Big blind">BB</span>' : '');
    let extra = '';
    let under = '';
    if (p.inHand && !p.folded && i !== v.me) {
      if (p.cards) under = `<div class="pk-show">${p.cards.map((c) => cardHTML(c, 'mini')).join('')}</div>`;
      else extra = `<span class="pk-hole">${backHTML('mini')}${backHTML('mini')}</span>`;
    }
    if (winAmt) under += `<div class="pk-won">+${fmt(winAmt)}</div>`;
    else if (p.last && v.phase === 'betting') under += `<div class="pk-act ${/^(All-in)/.test(p.last) ? 'allin' : /^Fold/.test(p.last) ? 'fold' : ''}">${esc(p.last)}</div>`;
    const html = pt.seatHTML({ pid: p.id, name: p.name, avatar: pt.avatarOf(ctx.room, p.id), sub, turn, dealer: inHandNow && i === v.dealer, me: i === v.me, extra, badges, under });
    return `<div class="pk-s ${p.folded ? 'pk-fold' : ''} ${p.out ? 'pk-out' : ''} ${winAmt ? 'pk-win' : ''}">${html}</div>`;
  }

  function centerHTML(v, z) {
    const slots = [];
    for (let k = 0; k < 5; k++) slots.push(v.board[k] ? cardHTML(v.board[k], k >= (ui.snap ? ui.snap.board : 0) ? 'deal' : '') : '<div class="pkc slot"></div>');
    const win = v.result && v.phase !== 'betting' && v.result.showdown ? new Set(v.result.winners.flatMap((w) => w.best || [])) : null;
    const board = v.board.map((c) => cardHTML(c, win && win.has(c.id) ? 'hl' : win ? 'dimc' : ''));
    const cards = slots.map((s, k) => (k < v.board.length ? board[k] : s));
    const street = { preflop: 'Pre-flop', flop: 'Flop', turn: 'Turn', river: 'River' }[v.street] || '';
    return `<div class="pk-center" style="--bw:${z.board}px"><div class="pk-pot"><i class="chip"></i><b>${fmt(v.pot)}</b><span>${v.phase === 'betting' ? street : ''}</span></div><div class="pk-board">${cards.join('')}</div></div>`;
  }

  function tableHTML(v, ctx, z) {
    return pt.tableHTML({
      n: v.players.length,
      me: v.me,
      seat: (i) => seatHTML(v, ctx, i),
      center: centerHTML(v, z),
      card: (i) => {
        const p = v.players[i];
        return p.bet > 0 && v.phase === 'betting' ? { html: `<div class="pk-bet"><i class="chip"></i>${fmt(p.bet)}</div>` } : null;
      },
    });
  }

  function raiseSizes(v) {
    const base = v.currentBet + v.pot + v.toCall; // a pot-sized raise
    const clamp = (x) => Math.max(v.minRaiseTo, Math.min(v.maxRaiseTo, Math.round(x)));
    const frac = (f) => clamp(v.currentBet + f * (v.pot + v.toCall));
    return [
      ['Min', v.minRaiseTo],
      ['½ pot', frac(0.5)],
      ['¾ pot', frac(0.75)],
      ['Pot', clamp(base)],
      ['All-in', v.maxRaiseTo],
    ];
  }

  function controlsHTML(v) {
    if (v.me < 0 || v.phase !== 'betting') return '';
    const me = v.players[v.me];
    if (!v.myTurn) {
      if (!me.inHand || me.folded) return '';
      return '<div class="pk-wait">Waiting for the other players…</div>';
    }
    const callLabel = v.canCheck ? 'Check' : v.toCall >= me.chips ? `All-in ${fmt(v.toCall)}` : `Call ${fmt(v.toCall)}`;
    let raiseBox = '';
    let raiseBtn = '';
    if (v.canRaise) {
      const to = ui.raiseTo;
      const verb = v.currentBet === 0 ? 'Bet' : 'Raise to';
      const sizes2 = raiseSizes(v);
      raiseBox = `<div class="pk-raise">
        <div class="pk-sizes">${sizes2.map(([l, val]) => `<button type="button" class="pk-size ${val === to ? 'on' : ''}" data-pk="size" data-v="${val}">${l}</button>`).join('')}</div>
        <div class="pk-slide"><button type="button" class="pk-step" data-pk="step" data-d="-1" aria-label="Less">−</button>
          <input type="range" min="${v.minRaiseTo}" max="${v.maxRaiseTo}" step="1" value="${to}" data-pk="slider" aria-label="Raise amount">
          <button type="button" class="pk-step" data-pk="step" data-d="1" aria-label="More">+</button></div></div>`;
      raiseBtn = `<button class="btn pk-raise-btn" data-pk="raise">${to >= v.maxRaiseTo ? 'All-in ' + fmt(to) : verb + ' <b data-pk-amt>' + fmt(to) + '</b>'}</button>`;
    }
    return `<div class="pk-actions">${raiseBox}<div class="pk-btns"><button class="btn ghost pk-fold-btn" data-pk="fold">Fold</button><button class="btn pk-call" data-pk="${v.canCheck ? 'check' : 'call'}">${callLabel}</button>${raiseBtn}</div></div>`;
  }

  function handHTML(v) {
    if (v.me < 0 || !v.hand.length) return '';
    const me = v.players[v.me];
    const dead = me.folded || !me.inHand;
    return `<div class="pk-hand ${dead ? 'dead' : ''}"><div class="pk-cards">${v.hand.map((c) => cardHTML(c, 'big')).join('')}</div>${v.myHand && !dead ? `<div class="pk-hname">${esc(v.myHand)}</div>` : ''}</div>`;
  }

  function resultHTML(v, ctx) {
    const r = v.result;
    if (!r || v.phase !== 'handEnd') return '';
    const winners = r.winners
      .map((w) => {
        const p = v.players[w.player];
        const cards = r.showdown && w.best ? `<div class="pk-best">${w.best.map((id) => cardHTML(fromId(id), 'mini')).join('')}</div>` : '';
        return `<li><span class="pk-wn"><b>${esc(p.name)}</b>${w.player === v.me ? ' (you)' : ''} wins <b class="pos">${fmt(w.amount)}</b></span>${w.hand ? `<span class="pk-wh">${esc(w.hand)}</span>` : '<span class="pk-wh">everyone else folded</span>'}${cards}</li>`;
      })
      .join('');
    const hands = r.showdown && r.hands.length > r.winners.length ? `<p class="hint">${r.hands.map((h) => `${esc(v.players[h.player].name)}: ${esc(h.hand)}`).join(' · ')}</p>` : '';
    const side = r.pots.length > 1 ? `<p class="hint">${r.pots.length} pots: ${r.pots.map((p) => fmt(p.amount)).join(' + ')}</p>` : '';
    return `<div class="pk-result"><h3>Hand ${r.handNo}</h3><ul>${winners}</ul>${side}${hands}
      <div class="row" style="justify-content:space-between"><span class="hint">Next hand starts automatically</span><button class="btn small" data-pk="next">Next hand</button></div></div>`;
  }

  function standingsHTML(v) {
    const order = v.players.map((p, i) => ({ p, i })).sort((a, b) => b.p.chips - a.p.chips);
    const max = Math.max(1, ...order.map((o) => o.p.chips));
    const rows = order
      .map((o) => `<li class="${o.p.out ? 'out' : ''}"><span class="nm">${esc(o.p.name)}${o.i === v.me ? ' (you)' : ''}</span><span class="bar"><i style="width:${Math.round((o.p.chips / max) * 100)}%"></i></span><b>${o.p.out ? 'out' : fmt(o.p.chips)}</b></li>`)
      .join('');
    const hist = v.history.slice().reverse().map((h) => `<tr><td>#${h.hand}</td><td>${fmt(h.pot)}</td><td>${h.winners.map((w) => `${esc(v.players[w.player].name)} +${fmt(w.amount)}${w.hand ? ' (' + esc(w.hand) + ')' : ''}`).join(', ')}</td></tr>`).join('');
    return `<ul class="pk-stand">${rows}</ul>${hist ? `<h3 style="margin:14px 0 6px">Recent hands</h3><div class="score-wrap"><table class="score pk-hist"><thead><tr><th>Hand</th><th>Pot</th><th>Winner</th></tr></thead><tbody>${hist}</tbody></table></div>` : ''}`;
  }

  function overlayHTML(v) {
    if (v.phase === 'gameOver') {
      const rows = v.standings
        .map((s) => `<li><span>${s.rank === 1 ? '🏆' : s.rank + '.'}</span><span>${esc(v.players[s.player].name)}</span><span class="pts">${fmt(s.chips)}</span></li>`)
        .join('');
      const champ = v.standings[0].player;
      const title = v.me === champ ? 'You won! 🎉' : `${esc(v.players[champ].name)} wins!`;
      return `<div class="overlay"><div class="sheet"><h2>${title}</h2><ol class="podium">${rows}</ol>
        <div class="row">${ui.ctx.isHost ? '<button class="btn" data-pk="again">Play again</button>' : '<span class="hint">Waiting for the host to start another game</span>'}
        <button class="btn ghost" data-pk="leave">Leave table</button></div></div></div>`;
    }
    if (ui.standings) {
      return `<div class="overlay" data-pk="closeStand"><div class="sheet" data-stop="1"><h2>Chip counts</h2>${standingsHTML(v)}<div class="row" style="margin-top:12px"><button class="btn" data-pk="closeStand">Close</button><button class="btn ghost" data-pk="rules">How to play</button></div></div></div>`;
    }
    return '';
  }

  // ------------------------------------------------------------------ sounds
  function playSounds(v) {
    const snd = window.CardTable.sound;
    const prev = ui.snap;
    const cur = { phase: v.phase, hand: v.handNo, board: v.board.length, bets: v.players.reduce((s, p) => s + p.bet, 0), pot: v.pot, folds: v.players.filter((p) => p.folded).length, allin: v.players.filter((p) => p.allIn).length };
    ui.snap = cur;
    if (!snd || !prev || prev.hand > cur.hand) return;
    if (cur.hand !== prev.hand) return snd.play('deal');
    if (cur.board > prev.board) snd.play('card');
    else if (cur.allin > prev.allin) snd.play('allin');
    else if (cur.pot > prev.pot) snd.play('chip');
    else if (cur.folds > prev.folds) snd.play('fold');
    if (v.phase === 'handEnd' && v.result && v.result.winners.some((w) => w.player === v.me) && prev.phase !== 'handEnd') setTimeout(() => snd.play('win'), 250);
  }

  // ------------------------------------------------------------------ render
  function render(root, v, ctx) {
    ui.ctx = ctx;
    ui.latest = v;
    if (v.handNo !== ui.hand) {
      ui.hand = v.handNo;
      ui.key = '';
    }
    const key = `${v.handNo}:${v.street}:${v.currentBet}:${v.myTurn}`;
    if (key !== ui.key) {
      ui.key = key;
      ui.raiseTo = v.myTurn && v.canRaise ? v.minRaiseTo : 0;
    }
    if (v.myTurn && v.canRaise) ui.raiseTo = Math.max(v.minRaiseTo, Math.min(v.maxRaiseTo, ui.raiseTo));
    playSounds(v);
    const z = sizes();
    const b = v.blinds;
    const rise = b.next && b.handsLeft ? ` · up to ${b.next[0]}/${b.next[1]} in ${b.handsLeft} hand${b.handsLeft === 1 ? '' : 's'}` : '';
    const limit = v.limit ? ` · of ${v.limit}` : '';
    root.innerHTML = `
    <div class="wz pk" style="--bw:${z.board}px;--hw:${z.hand}px">
      <div class="wz-top">
        <div class="wz-round"><b>Hand ${v.handNo}</b><span class="label">${limit}</span></div>
        <div class="pk-blinds"><span class="label">Blinds</span> <b>${b.sb} / ${b.bb}</b><small>${rise}</small></div>
        <div class="row" style="gap:6px">${CardTable.sound.button()}${CardTable.chat.button()}<button class="btn ghost small" data-act="emotes" aria-label="Send a reaction">😀</button><button class="btn ghost small" data-pk="standings">Chips</button><button class="btn ghost small" data-pk="leave" aria-label="Leave table">✕</button></div>
      </div>
      ${tableHTML(v, ctx, z)}
      ${handHTML(v)}
      <div class="wz-status ${v.myTurn ? 'mine' : ''}"><span>${statusText(v)}</span></div>
      ${v.phase === 'handEnd' ? resultHTML(v, ctx) : controlsHTML(v)}
      ${overlayHTML(v)}
    </div>`;
    root.onclick = onClick;
    root.oninput = onInput;
  }

  function onInput(e) {
    const el = e.target.closest('[data-pk="slider"]');
    if (!el) return;
    setRaise(Number(el.value), false);
  }

  function setRaise(val, rerender) {
    const v = ui.latest;
    if (!v) return;
    ui.raiseTo = Math.max(v.minRaiseTo, Math.min(v.maxRaiseTo, Math.round(val)));
    if (rerender) return ui.ctx.rerender();
    const btn = document.querySelector('.pk-raise-btn');
    if (btn) btn.innerHTML = ui.raiseTo >= v.maxRaiseTo ? 'All-in ' + fmt(ui.raiseTo) : (v.currentBet === 0 ? 'Bet' : 'Raise to') + ' <b data-pk-amt>' + fmt(ui.raiseTo) + '</b>';
    document.querySelectorAll('.pk-size').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === ui.raiseTo));
  }

  function onClick(e) {
    if (e.target.closest('[data-stop]') && !e.target.closest('button')) return;
    const el = e.target.closest('[data-pk]');
    if (!el || el.dataset.pk === 'slider') return;
    const v = ui.latest;
    const ctx = ui.ctx;
    if (!v || !ctx) return;
    if (el.classList.contains('overlay') && e.target !== el) return;
    switch (el.dataset.pk) {
      case 'fold':
        ctx.act({ type: 'fold' });
        break;
      case 'check':
        ctx.act({ type: 'check' });
        break;
      case 'call':
        ctx.act({ type: 'call' });
        break;
      case 'raise': {
        if (!v.myTurn || !v.canRaise) return;
        const to = ui.raiseTo;
        ctx.act(to >= v.maxRaiseTo ? { type: 'allin' } : { type: 'raise', to });
        break;
      }
      case 'size':
        setRaise(Number(el.dataset.v), true);
        break;
      case 'step': {
        const bb = v.blinds.bb;
        setRaise(ui.raiseTo + Number(el.dataset.d) * bb, true);
        break;
      }
      case 'next':
        ctx.act({ type: 'continue' });
        break;
      case 'standings':
        ui.standings = true;
        ctx.rerender();
        break;
      case 'closeStand':
        ui.standings = false;
        ctx.rerender();
        break;
      case 'rules':
        ctx.showRules();
        break;
      case 'again':
        ctx.rematch();
        break;
      case 'leave':
        ctx.leave();
        break;
    }
  }

  window.addEventListener('resize', () => { if (ui.ctx && ui.latest && ui.latest.game === 'poker' && document.querySelector('.pk')) ui.ctx.rerender(); });

  window.CardTable.register('poker', { render });
})();
