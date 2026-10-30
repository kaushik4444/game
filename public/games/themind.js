/* The Mind table renderer: a shared pile, everybody's card counts, and your own sorted hand. Styles in themind.css. */
(() => {
  'use strict';
  const { esc, toast, pt } = window.CardTable;
  const ui = { ctx: null, latest: null, seq: null, shake: 0, flash: '', key: '', scores: false, keys: false };

  const tone = (n) => (n <= 33 ? 'lo' : n <= 66 ? 'mid' : 'hi');
  const numCard = (n, cls = '', attrs = '') => `<div class="tmc ${tone(n)} ${cls}" ${attrs}><span class="n">${n}</span></div>`;
  const heart = (full) => `<span class="tm-heart ${full ? '' : 'lost'}">${full ? '❤️' : '🖤'}</span>`;

  function eventText(v) {
    const e = v.event;
    if (!e) return '';
    const nm = (i) => esc(v.players[i].name);
    switch (e.type) {
      case 'play': return `${nm(e.by)} played <b>${e.card}</b>`;
      case 'mistake': return `<b class="neg">Too early!</b> ${nm(e.by)} played <b>${e.card}</b> but ${e.discards.map((d) => `${nm(d.player)} held <b>${d.card}</b>`).join(', ')}. Lost a life.`;
      case 'star': return `⭐ Throwing star: ${e.discards.map((d) => `${nm(d.player)} <b>${d.card}</b>`).join(', ')}`;
      case 'starPropose': return `⭐ ${nm(e.by)} suggests a throwing star`;
      case 'starCancel': return `${nm(e.by)} cancelled the throwing star`;
      case 'cleared': return `Level ${e.level} cleared!${e.bonus && e.bonus.life ? ' +1 life' : ''}${e.bonus && e.bonus.star ? ' +1 ⭐' : ''}`;
      case 'level': return `Level ${e.level}: play your cards in ascending order`;
      case 'won': return 'You did it!';
      case 'lost': return 'Out of lives';
      default: return '';
    }
  }

  function sizes(v) {
    const w = window.innerWidth;
    let cw = w < 480 ? 60 : w < 900 ? 78 : 92;
    const n = v.hand.length;
    const avail = Math.min(w, 980) - 24;
    let gap = 8;
    if (n > 1 && n * cw + (n - 1) * gap > avail) gap = Math.max(-cw * 0.55, Math.round((avail - cw * n) / (n - 1)));
    return { cw, gap };
  }

  function playersHTML(v, ctx) {
    return `<div class="tm-players">${v.players
      .map((p, i) => {
        const backs = Array.from({ length: Math.min(p.cards, 6) }, () => '<i></i>').join('');
        const more = p.cards > 6 ? `<em>+${p.cards - 6}</em>` : '';
        const status = v.phase === 'ready' || v.phase === 'levelEnd' ? (p.ready ? 'ready ✓' : 'not ready') : p.voted ? '⭐ agrees' : p.cards ? `${p.cards} card${p.cards === 1 ? '' : 's'}` : 'done ✓';
        const html = pt.seatHTML({ pid: p.id, name: p.name, avatar: pt.avatarOf(ctx.room, p.id), sub: status, turn: false, me: i === v.me, extra: '' });
        return `<div class="tm-p ${p.voted ? 'voted' : ''} ${p.cards === 0 && v.phase === 'playing' ? 'done' : ''}">${html}<div class="tm-backs">${backs}${more}</div></div>`;
      })
      .join('')}</div>`;
  }

  function pileHTML(v) {
    const top = v.pile.length ? v.pile[v.pile.length - 1] : null;
    const prev = v.pile.slice(-7, -1).map((p) => `<span class="tm-prev ${tone(p.card)}">${p.card}</span>`).join('');
    const lost = v.discarded.length ? `<div class="tm-disc"><span class="label">Discarded</span>${v.discarded.map((d) => `<span class="tm-prev ${d.why === 'mistake' ? 'bad' : 'star'}" title="${esc(v.players[d.player].name)}">${d.card}</span>`).join('')}</div>` : '';
    const centre = top ? numCard(top.card, 'pile ' + (ui.flash === 'mistake' ? 'bad' : 'pop'), `key="${v.pile.length}"`) : '<div class="tmc slot"><span class="n">?</span></div>';
    return `<div class="tm-pile ${ui.shake ? 'shake' : ''}"><div class="tm-trail">${prev}</div>${centre}<div class="tm-by">${top ? 'played by ' + esc(v.players[top.player].name) : v.phase === 'playing' ? 'Nothing played yet' : ''}</div>${lost}</div>`;
  }

  function handHTML(v, z) {
    if (v.me < 0) return '';
    if (!v.hand.length) return v.phase === 'playing' ? '<div class="tm-empty">You have no cards left. Wait for the others.</div>' : '';
    return `<div class="tm-hand"><div class="tm-hand-in" style="--cw:${z.cw}px">${v.hand
      .map((c, i) => numCard(c, i === 0 ? 'next' : 'wait', `style="margin-left:${i ? z.gap : 0}px"`))
      .join('')}</div></div>`;
  }

  function controlsHTML(v) {
    if (v.me < 0) return '';
    if (v.phase === 'ready' || v.phase === 'levelEnd') {
      const me = v.players[v.me];
      const lvl = v.nextLevel;
      const bon = v.upcomingBonus;
      const note = bon.life || bon.star ? `<p class="hint">Clear level ${lvl} to earn ${bon.life ? 'a life' : ''}${bon.life && bon.star ? ' and ' : ''}${bon.star ? 'a throwing star' : ''}.</p>` : '';
      const intro = v.phase === 'levelEnd' ? `<h3>Level ${v.level} cleared ${v.clearedBonus && (v.clearedBonus.life || v.clearedBonus.star) ? '🎉 ' + (v.clearedBonus.life ? '+1 ❤️ ' : '') + (v.clearedBonus.star ? '+1 ⭐' : '') : '🎉'}</h3>` : '<h3>Get ready</h3>';
      return `<div class="tm-ready panel">${intro}<p>Level <b>${lvl}</b> of ${v.maxLevel}: ${lvl} card${lvl === 1 ? '' : 's'} each. Focus, and do not talk about your numbers.</p>${note}
        <button class="btn big" data-tm="ready" ${me.ready ? 'disabled' : ''}>${me.ready ? 'Waiting for the others…' : 'Ready'}</button></div>`;
    }
    if (v.phase !== 'playing') return '';
    const low = v.hand[0];
    const star = v.options.shurikens
      ? v.starPending && v.players[v.me] && !v.players[v.me].voted && v.hand.length
        ? `<div class="tm-starvote"><span>⭐ Throw a star? Everyone discards their lowest card.</span><button class="btn small" data-tm="star">Agree</button><button class="btn ghost small" data-tm="cancelStar">No</button></div>`
        : v.starPending && v.players[v.me].voted
          ? `<div class="tm-starvote"><span>⭐ Waiting for the others to agree…</span><button class="btn ghost small" data-tm="cancelStar">Cancel</button></div>`
          : ''
      : '';
    return `${star}<div class="tm-actions"><button class="btn tm-play" data-tm="play" ${low === undefined ? 'disabled' : ''}>${low === undefined ? 'No cards left' : `Play ${low}`}</button>
      <button class="btn ghost tm-star" data-tm="star" ${v.canStar && !v.starPending ? '' : 'disabled'} aria-label="Propose a throwing star">⭐ ${v.stars}</button></div>`;
  }

  function overlayHTML(v) {
    if (ui.scores) {
      return `<div class="overlay" data-tm="closeScores"><div class="sheet" data-stop="1"><h2>How are we doing?</h2>${statsHTML(v)}<div class="row" style="margin-top:12px"><button class="btn" data-tm="closeScores">Close</button><button class="btn ghost" data-tm="rules">How to play</button></div></div></div>`;
    }
    if (v.phase !== 'gameOver') return '';
    const hands = v.finalHands && v.finalHands.some((h) => h.length)
      ? `<h3 style="margin:12px 0 6px">What was left</h3><ul class="tm-final">${v.finalHands.map((h, i) => `<li><b>${esc(v.players[i].name)}</b> ${h.length ? h.map((c) => `<span class="tm-prev ${tone(c)}">${c}</span>`).join('') : '<span class="hint">nothing</span>'}</li>`).join('')}</ul>` : '';
    return `<div class="overlay"><div class="sheet"><h2>${v.won ? 'You made it! 🎉' : 'Out of lives 💔'}</h2>
      <p>${v.won ? `All ${v.maxLevel} levels cleared together.` : `You got through ${v.stats.cleared} level${v.stats.cleared === 1 ? '' : 's'} and reached level ${v.level}.`}</p>${statsHTML(v)}${hands}
      <div class="row" style="margin-top:12px">${ui.ctx.isHost ? '<button class="btn" data-tm="again">Play again</button>' : '<span class="hint">Waiting for the host to start another game</span>'}<button class="btn ghost" data-tm="leave">Leave table</button></div></div></div>`;
  }

  const statsHTML = (v) => `<ul class="tm-stats"><li><span>Levels cleared</span><b>${v.stats.cleared} / ${v.maxLevel}</b></li><li><span>Mistakes</span><b>${v.stats.mistakes}</b></li><li><span>Stars used</span><b>${v.stats.starsUsed}</b></li><li><span>Lives left</span><b>${Math.max(0, v.lives)}</b></li></ul>`;

  function reactToEvent(v) {
    const e = v.event;
    const snd = window.CardTable.sound;
    if (ui.seq === null) { ui.seq = e ? e.seq : 0; return; } // first render (page load): do not replay an old event
    if (!e || e.seq === ui.seq) return;
    ui.seq = e.seq;
    ui.flash = '';
    if (e.type === 'play') snd && snd.play('card');
    else if (e.type === 'mistake') {
      ui.flash = 'mistake';
      ui.shake++;
      snd && snd.play('lose');
      try { navigator.vibrate && navigator.vibrate([90, 50, 90]); } catch { /* ignore */ }
      setTimeout(() => { ui.shake = 0; ui.flash = ''; ui.ctx && ui.ctx.rerender(); }, 900);
    } else if (e.type === 'star') snd && snd.play('collect');
    else if (e.type === 'cleared') snd && snd.play('win');
    else if (e.type === 'starPropose') snd && snd.play('chat');
  }

  function render(root, v, ctx) {
    ui.ctx = ctx;
    ui.latest = v;
    reactToEvent(v);
    const z = sizes(v);
    const lives = Array.from({ length: Math.max(v.startLives, v.lives) }, (_, i) => heart(i < v.lives)).join('');
    const stars = v.options.shurikens ? `<span class="tm-stars" title="Throwing stars">⭐ ${v.stars}</span>` : '';
    const dots = Array.from({ length: v.maxLevel }, (_, i) => `<i class="${i + 1 < (v.phase === 'levelEnd' ? v.level + 1 : v.level) ? 'done' : i + 1 === v.level ? 'cur' : ''}"></i>`).join('');
    const text = eventText(v);
    const handEl = root.querySelector('.tm-hand');
    const scroll = handEl ? handEl.scrollLeft : 0;
    root.innerHTML = `
    <div class="wz tm ${ui.flash === 'mistake' ? 'oops' : ''}">
      <div class="wz-top">
        <div class="wz-round"><b>Level ${v.phase === 'levelEnd' ? v.nextLevel : v.level}</b><span class="label"> / ${v.maxLevel}</span></div>
        <div class="row" style="gap:6px">${CardTable.sound.button()}${CardTable.chat.button()}<button class="btn ghost small" data-act="emotes" aria-label="Send a reaction">😀</button><button class="btn ghost small" data-tm="scores">Stats</button><button class="btn ghost small" data-tm="leave" aria-label="Leave table">✕</button></div>
      </div>
      <div class="tm-sub"><span class="tm-lives" title="Lives">${lives}</span><div class="tm-dots" aria-hidden="true">${dots}</div>${stars || '<span></span>'}</div>
      ${playersHTML(v, ctx)}
      ${pileHTML(v)}
      ${text || v.me < 0 ? `<div class="wz-status ${v.myTurn && v.phase === 'playing' ? 'mine' : ''} tm-status"><span>${text || 'Watching the team play'}</span></div>` : ''}
      ${handHTML(v, z)}
      ${controlsHTML(v)}
      ${overlayHTML(v)}
    </div>`;
    const h2 = root.querySelector('.tm-hand');
    if (h2) h2.scrollLeft = scroll;
    root.onclick = onClick;
  }

  function onClick(e) {
    if (e.target.closest('[data-stop]') && !e.target.closest('button')) return;
    const el = e.target.closest('[data-tm]');
    if (!el) return;
    const v = ui.latest;
    const ctx = ui.ctx;
    if (!v || !ctx) return;
    if (el.classList.contains('overlay') && e.target !== el) return;
    switch (el.dataset.tm) {
      case 'ready':
        ctx.act({ type: 'ready' });
        break;
      case 'play':
        playLowest();
        break;
      case 'star':
        ctx.act({ type: 'shuriken' });
        break;
      case 'cancelStar':
        ctx.act({ type: 'shuriken', cancel: true });
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
      case 'again':
        ctx.rematch();
        break;
      case 'leave':
        ctx.leave();
        break;
    }
  }

  /** Always plays your lowest card; the card number is sent so a stale tap cannot play a different card. */
  function playLowest() {
    const v = ui.latest;
    if (!v || v.phase !== 'playing' || !v.hand.length) return;
    ui.ctx.act({ type: 'play', card: v.hand[0] });
  }

  // desktop: Space plays your lowest card (not while typing in the chat box)
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (!document.querySelector('.tm') || !ui.latest || ui.latest.game !== 'themind' || document.querySelector('.overlay')) return;
    e.preventDefault();
    playLowest();
  });

  window.addEventListener('resize', () => { if (ui.ctx && ui.latest && ui.latest.game === 'themind' && document.querySelector('.tm')) ui.ctx.rerender(); });

  window.CardTable.register('themind', { render });
})();
