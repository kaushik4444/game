/* Shared poker-table layout: seats sit around an oval table, each player's played card lies in front of them.
 * Games call CardTable.pt.tableHTML(...) and provide the markup for each seat and card. */
(() => {
  'use strict';
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const RX = 37; // seat ellipse radii, in % of the table area
  const RY = 38;
  const CARD_K = 0.5; // played cards lie halfway between the centre and the seat

  /** Positions for n players, with player `me` at the bottom and the turn order running clockwise. */
  function layout(n, me) {
    const m = Math.max(me, 0);
    const out = [];
    for (let i = 0; i < n; i++) {
      const k = (i - m + n) % n;
      const a = ((90 + (k * 360) / n) * Math.PI) / 180;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      const cx = 50 + CARD_K * RX * cos;
      const cy = 50 + CARD_K * RY * sin;
      out.push({
        sx: +(50 + RX * cos).toFixed(2),
        sy: +(50 + RY * sin).toFixed(2),
        cx: +cx.toFixed(2),
        cy: +cy.toFixed(2),
        fx: +(cos * 240).toFixed(0), // where a played card flies in from (in % of its own size)
        fy: +(sin * 150).toFixed(0),
      });
    }
    return out;
  }

  const avatarColor = (s) => {
    let h = 0;
    for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return `hsl(${h} 45% 32%)`;
  };

  /** One player's seat: avatar disc, name plate and a status line. */
  function seatHTML(o) {
    const face = o.avatar ? esc(o.avatar) : esc([...o.name][0] || '?').toUpperCase();
    return `<div class="pseat ${o.first ? 'first' : ''} ${o.turn ? 'turn' : ''} ${o.me ? 'me' : ''} ${o.team !== undefined ? 'team' + o.team : ''}" data-pid="${esc(o.pid)}">
      <div class="badges">${o.dealer ? '<span class="bdg d" title="Dealer">Dealer</span>' : ''}${o.first ? '<span class="bdg f" title="Bids and leads first this round">1st</span>' : ''}</div>
      <div class="av" style="--avbg:${avatarColor(o.name)}"><span class="face">${face}</span>${o.extra || ''}</div>
      <div class="plate"><b>${esc(o.name)}</b><span>${esc(o.sub || '')}</span></div>
    </div>`;
  }

  /**
   * opts: { n, me, seat(i) -> html, card(i) -> {html, win?} | null, center: html, info?: html }
   */
  function tableHTML(opts) {
    const L = layout(opts.n, opts.me);
    let out = '<div class="pt"><div class="pt-felt"></div>';
    if (opts.info) out += `<div class="pt-info">${opts.info}</div>`;
    if (opts.center) out += `<div class="pt-center">${opts.center}</div>`;
    if (opts.corner) out += `<div class="pt-corner">${opts.corner}</div>`;
    for (let i = 0; i < opts.n; i++) {
      const c = opts.card(i);
      if (c) out += `<div class="pt-card ${c.win ? 'win' : ''}" style="left:${L[i].cx}%;top:${L[i].cy}%;--fx:${L[i].fx}%;--fy:${L[i].fy}%">${c.html}</div>`;
    }
    for (let i = 0; i < opts.n; i++) out += `<div class="pt-seat" style="left:${L[i].sx}%;top:${L[i].sy}%">${opts.seat(i)}</div>`;
    return out + '</div>';
  }

  /** Avatar emoji for a player id, from the room's member list. */
  const avatarOf = (room, id) => {
    const m = room && room.members.find((x) => x.id === id);
    return m ? m.avatar : '';
  };

  window.CardTable = window.CardTable || {};
  window.CardTable.pt = { layout, seatHTML, tableHTML, avatarOf, avatarColor };
})();
