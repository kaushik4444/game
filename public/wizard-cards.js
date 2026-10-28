/* Original card art for the Wizard deck, drawn as SVG for this project (no third-party artwork).
 * Four suits with distinct shapes as well as colours: Flames (red), Suns (yellow), Leaves (green), Moons (blue). */
(() => {
  'use strict';

  const SUITS = {
    R: { name: 'Flames', one: 'Flame' },
    Y: { name: 'Suns', one: 'Sun' },
    G: { name: 'Leaves', one: 'Leaf' },
    B: { name: 'Moons', one: 'Moon' },
  };

  let rays = '';
  for (let i = 0; i < 12; i++) {
    const a = (i * Math.PI) / 6;
    const pt = (r, d) => `${(50 + r * Math.cos(a + d)).toFixed(1)},${(50 + r * Math.sin(a + d)).toFixed(1)}`;
    rays += `<polygon points="${pt(29, -0.17)} ${pt(47, 0)} ${pt(29, 0.17)}"/>`;
  }

  const SPRITE = `
<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">
  <symbol id="wz-R" viewBox="0 0 100 100">
    <path fill="currentColor" d="M52 5C55 22 74 34 76 58C78 78 66 94 50 94C34 94 22 80 24 62C25 50 32 42 38 34C39 44 43 48 47 49C44 36 46 18 52 5Z"/>
    <path fill="#fff" fill-opacity=".45" d="M50 94C41 94 35 86 36 76C37 66 45 62 48 52C53 60 62 66 62 78C62 87 57 94 50 94Z"/>
  </symbol>
  <symbol id="wz-Y" viewBox="0 0 100 100">
    <g fill="currentColor">${rays}<circle cx="50" cy="50" r="23"/></g>
    <circle cx="50" cy="50" r="14" fill="#fff" fill-opacity=".4"/>
  </symbol>
  <symbol id="wz-G" viewBox="0 0 100 100">
    <path fill="currentColor" d="M50 4C86 22 94 62 52 96C8 62 14 22 50 4Z"/>
    <path d="M50 20V88M50 40L34 28M50 52L66 38M50 64L33 52M50 75L65 63" stroke="#fff" stroke-opacity=".6" stroke-width="3.5" fill="none" stroke-linecap="round"/>
  </symbol>
  <symbol id="wz-B" viewBox="0 0 100 100">
    <path fill="currentColor" d="M60 6A45 45 0 1 0 94 68A37 37 0 1 1 60 6Z"/>
    <path fill="#fff" fill-opacity=".7" d="M76 20l3.2 7.4 8 .8-6 5.3 1.7 7.9-6.9-4-6.9 4 1.7-7.9-6-5.3 8-.8z"/>
  </symbol>

  <symbol id="wz-wizard" viewBox="0 0 100 130">
    <g fill="#ffe9a8"><circle cx="13" cy="24" r="1.7"/><circle cx="87" cy="32" r="1.4"/><circle cx="19" cy="76" r="1.3"/><circle cx="86" cy="84" r="1.7"/><circle cx="79" cy="11" r="1.3"/><circle cx="9" cy="50" r="1.1"/></g>
    <path d="M12 130C14 100 31 90 50 90C69 90 86 100 88 130Z" fill="#6a3fb5"/>
    <path d="M50 90L41 130M50 90L59 130" stroke="#e7c35a" stroke-width="3" fill="none"/>
    <ellipse cx="50" cy="60" rx="15" ry="14" fill="#f1c59b"/>
    <path d="M29 62C27 92 40 110 50 115C60 110 73 92 71 62C63 73 37 73 29 62Z" fill="#f4f1ea"/>
    <path d="M38 82C42 90 46 94 50 94M62 82C58 90 54 94 50 94" stroke="#cfc8b8" stroke-width="2" fill="none" stroke-linecap="round"/>
    <ellipse cx="50" cy="63" rx="4.2" ry="3.2" fill="#e2a47a"/>
    <circle cx="43.5" cy="56" r="1.8" fill="#2b1b4d"/><circle cx="56.5" cy="56" r="1.8" fill="#2b1b4d"/>
    <path d="M40 52Q43.5 50 47 52M53 52Q56.5 50 60 52" stroke="#f4f1ea" stroke-width="2.4" fill="none" stroke-linecap="round"/>
    <path d="M53 3Q67 8 62 22Q72 36 80 50L20 50Q32 38 40 24Q48 14 53 3Z" fill="#4a2f9c"/>
    <path d="M53 3Q57 4 58 8Q50 17 46 31Q42 41 34 50L20 50Q32 38 40 24Q48 14 53 3Z" fill="#fff" fill-opacity=".13"/>
    <ellipse cx="50" cy="50" rx="34" ry="7" fill="#3a2480"/>
    <path d="M31 44Q50 53 69 44L70 48.5Q50 58 30 48.5Z" fill="#e7c35a"/>
    <path fill="#ffe9a8" d="M57 29l2.1 4.6 5 .6-3.7 3.4 1 5-4.4-2.5-4.4 2.5 1-5-3.7-3.4 5-.6z"/>
  </symbol>

  <symbol id="wz-jester" viewBox="0 0 100 130">
    <path d="M22 130L28 96H72L78 130Z" fill="#c43d3d"/>
    <path d="M50 96L61 113L50 130L39 113Z" fill="#2aa198"/>
    <path d="M26 90L32 102L38 90L44 102L50 90L56 102L62 90L68 102L74 90Z" fill="#fff" stroke="#c9c9c9" stroke-width="1"/>
    <circle cx="50" cy="64" r="19" fill="#f6d2ab"/>
    <circle cx="42.5" cy="61" r="2.2" fill="#2b2b2b"/><circle cx="57.5" cy="61" r="2.2" fill="#2b2b2b"/>
    <circle cx="39" cy="69" r="3.6" fill="#e9777a" fill-opacity=".55"/><circle cx="61" cy="69" r="3.6" fill="#e9777a" fill-opacity=".55"/>
    <circle cx="50" cy="67" r="3.4" fill="#d9534f"/>
    <path d="M40 74Q50 84 60 74" stroke="#7a2b2b" stroke-width="2.4" fill="none" stroke-linecap="round"/>
    <path d="M33 53Q14 49 8 23Q6 15 14 18Q30 27 50 41Z" fill="#2aa198"/>
    <path d="M67 53Q86 49 92 23Q94 15 86 18Q70 27 50 41Z" fill="#d94a4a"/>
    <path d="M40 49Q36 23 50 9Q64 23 60 49Z" fill="#f0b429"/>
    <path d="M31 53Q50 61 69 53L70 47.5Q50 56 30 47.5Z" fill="#fff"/>
    <g fill="#f0b429" stroke="#9a6b00" stroke-width="1.2"><circle cx="12" cy="18" r="5"/><circle cx="88" cy="18" r="5"/><circle cx="50" cy="8" r="4.5"/></g>
  </symbol>

  <symbol id="wz-back" viewBox="0 0 100 140">
    <rect width="100" height="140" fill="#2a1f66"/>
    <g fill="none" stroke="#e7c35a" stroke-width="1.6">
      <rect x="8" y="8" width="84" height="124" rx="8"/>
      <rect x="14" y="14" width="72" height="112" rx="5" stroke-opacity=".55"/>
    </g>
    <g fill="#e7c35a" fill-opacity=".18"><path d="M50 22L74 70L50 118L26 70Z"/></g>
    <path fill="#e7c35a" d="M50 44L57 62L77 64L62 77L67 97L50 86L33 97L38 77L23 64L43 62Z"/>
    <g fill="#e7c35a" fill-opacity=".7"><circle cx="24" cy="26" r="2.2"/><circle cx="76" cy="26" r="2.2"/><circle cx="24" cy="114" r="2.2"/><circle cx="76" cy="114" r="2.2"/></g>
  </symbol>
</svg>`;

  if (!document.getElementById('wz-sprite')) {
    const holder = document.createElement('div');
    holder.id = 'wz-sprite';
    holder.innerHTML = SPRITE;
    document.body.prepend(holder);
  }

  const use = (id, cls) => `<svg class="${cls}" viewBox="0 0 100 100" aria-hidden="true"><use href="#${id}"/></svg>`;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** Markup for one card. c = {id,type:'num'|'wizard'|'jester'|'back',suit,rank}. */
  function cardHTML(c, { tag = 'div', cls = '', attrs = '' } = {}) {
    if (c.type === 'back') {
      return `<${tag} class="card wc back ${cls}" aria-label="Hidden card" ${attrs}><svg class="art" viewBox="0 0 100 140" preserveAspectRatio="none" aria-hidden="true"><use href="#wz-back"/></svg></${tag}>`;
    }
    if (c.type === 'wizard') {
      return `<${tag} class="card wc wizard ${cls}" aria-label="Wizard" ${attrs}><span class="wc-in"><span class="wc-rk tl">W</span><svg class="art" viewBox="0 0 100 130" aria-hidden="true"><use href="#wz-wizard"/></svg><span class="wc-rk br">W</span></span></${tag}>`;
    }
    if (c.type === 'jester') {
      return `<${tag} class="card wc jester ${cls}" aria-label="Jester" ${attrs}><span class="wc-in"><span class="wc-rk tl">J</span><svg class="art" viewBox="0 0 100 130" aria-hidden="true"><use href="#wz-jester"/></svg><span class="wc-rk br">J</span></span></${tag}>`;
    }
    const name = `${SUITS[c.suit].one} ${c.rank}`;
    return `<${tag} class="card wc suit-${c.suit} ${cls}" aria-label="${esc(name)}" ${attrs}><span class="wc-in">
      <span class="wc-rk tl">${c.rank}${use('wz-' + c.suit, 'em')}</span>${use('wz-' + c.suit, 'big')}<span class="wc-rk br">${c.rank}${use('wz-' + c.suit, 'em')}</span></span></${tag}>`;
  }

  const suitIcon = (s, cls = 'sico') => use('wz-' + s, cls);

  window.WizardCards = { SUITS, cardHTML, suitIcon };
})();
