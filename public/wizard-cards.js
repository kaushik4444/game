/* Authentic original Wizard card game deck artwork (Amigo / Ken Fisher edition).
 * Characters:
 * - Wizard (Z): The Archmage holding the golden chalice / cup against medieval mountain landscape
 * - Jester (N): The wild jester crouching amidst mystical gnarled trees
 * Four ancient elemental suits:
 * - Red (R - Humans / Knights): Ancient winged staff / double axe emblem (red shield / volcanic crag)
 * - Yellow (Y - Dwarves): Celtic horned ring / ancient key-tau rune (warm gold / stone halls)
 * - Green (G - Elves): Tri-pronged trident / sacred spear emblem (deep emerald twilight forest)
 * - Blue (B - Giants): Curved battle trident / runic fork emblem (azure skies / alpine peaks)
 *
 * Card backs: Classic matte black border with central crackling flame box, "wizard" rune title in yellow/green,
 * and the 4 suit symbols (Green trident, Blue rune, Yellow ring, Red tau).
 */
(() => {
  'use strict';

  const SUITS = {
    R: { name: 'Humans', one: 'Human' },
    Y: { name: 'Dwarves', one: 'Dwarf' },
    G: { name: 'Elves', one: 'Elf' },
    B: { name: 'Giants', one: 'Giant' },
  };

  const SPRITE = `
<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">
  <defs>
    <!-- Suit gradients -->
    <linearGradient id="wz-grad-R" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#ff6b6b"/>
      <stop offset="50%" stop-color="#d63031"/>
      <stop offset="100%" stop-color="#8b1818"/>
    </linearGradient>
    <linearGradient id="wz-grad-Y" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#ffeaa7"/>
      <stop offset="45%" stop-color="#fdcb6e"/>
      <stop offset="100%" stop-color="#d39e00"/>
    </linearGradient>
    <linearGradient id="wz-grad-G" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#55efc4"/>
      <stop offset="50%" stop-color="#00b894"/>
      <stop offset="100%" stop-color="#006241"/>
    </linearGradient>
    <linearGradient id="wz-grad-B" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#74b9ff"/>
      <stop offset="50%" stop-color="#0984e3"/>
      <stop offset="100%" stop-color="#0c4294"/>
    </linearGradient>
    <linearGradient id="wz-chalice" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#fff4cc"/>
      <stop offset="50%" stop-color="#f1c40f"/>
      <stop offset="100%" stop-color="#996515"/>
    </linearGradient>
  </defs>

  <!-- SUIT R: RED (Humans) - Celtic Cross / Winged Staff Tau Emblem -->
  <symbol id="wz-R" viewBox="0 0 100 100">
    <g fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round">
      <!-- Main vertical staff -->
      <line x1="50" y1="12" x2="50" y2="90"/>
      <!-- Cross bar -->
      <line x1="24" y1="36" x2="76" y2="36"/>
      <!-- Downward curved wings / hooks -->
      <path d="M24 36 C24 56 36 64 50 64 C64 64 76 56 76 36"/>
      <!-- Top ring crown -->
      <circle cx="50" cy="24" r="12" fill="none" stroke="currentColor" stroke-width="6"/>
    </g>
    <circle cx="50" cy="24" r="5" fill="currentColor"/>
    <circle cx="50" cy="90" r="4.5" fill="currentColor"/>
  </symbol>

  <!-- SUIT Y: YELLOW (Dwarves) - Horned Sun-Ring / Tau Rune -->
  <symbol id="wz-Y" viewBox="0 0 100 100">
    <!-- Outer ring with central bar -->
    <circle cx="50" cy="46" r="28" fill="none" stroke="currentColor" stroke-width="7"/>
    <!-- Central sun disc -->
    <circle cx="50" cy="46" r="11" fill="currentColor"/>
    <!-- Bottom anchor stem -->
    <line x1="50" y1="74" x2="50" y2="94" stroke="currentColor" stroke-width="7" stroke-linecap="round"/>
    <line x1="38" y1="94" x2="62" y2="94" stroke="currentColor" stroke-width="7" stroke-linecap="round"/>
    <!-- Top horns / crest -->
    <path d="M26 30 C34 14 50 12 50 12 C50 12 66 14 74 30" fill="none" stroke="currentColor" stroke-width="6.5" stroke-linecap="round"/>
  </symbol>

  <!-- SUIT G: GREEN (Elves) - Tri-pronged Sacred Spear / Trident Rune -->
  <symbol id="wz-G" viewBox="0 0 100 100">
    <g fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round">
      <!-- Central spear shaft -->
      <line x1="50" y1="8" x2="50" y2="92"/>
      <!-- Left crescent prong -->
      <path d="M22 28 C22 58 42 66 50 66"/>
      <!-- Right crescent prong -->
      <path d="M78 28 C78 58 58 66 50 66"/>
      <!-- Crossguard ring -->
      <line x1="32" y1="78" x2="68" y2="78"/>
    </g>
    <!-- Arrowhead points -->
    <polygon points="50,6 43,22 57,22" fill="currentColor"/>
    <polygon points="22,26 16,38 27,36" fill="currentColor"/>
    <polygon points="78,26 84,38 73,36" fill="currentColor"/>
  </symbol>

  <!-- SUIT B: BLUE (Giants) - Forked Runic Battle Crescent -->
  <symbol id="wz-B" viewBox="0 0 100 100">
    <g fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round">
      <!-- Main stem -->
      <line x1="50" y1="18" x2="50" y2="92"/>
      <!-- Wide twin scythe horns -->
      <path d="M18 20 Q50 62 82 20"/>
      <!-- Inner rune loop -->
      <circle cx="50" cy="40" r="12" fill="none" stroke="currentColor" stroke-width="6"/>
      <!-- Base crossbar -->
      <line x1="36" y1="92" x2="64" y2="92"/>
    </g>
    <circle cx="18" cy="20" r="4.5" fill="currentColor"/>
    <circle cx="82" cy="20" r="4.5" fill="currentColor"/>
    <circle cx="50" cy="18" r="4.5" fill="currentColor"/>
  </symbol>

  <!-- WIZARD (Z) - Archmage with Holy Chalice / Goblet (Original Ken Fisher / Amigo Card) -->
  <symbol id="wz-wizard" viewBox="0 0 100 130">
    <!-- Mountain and sky background of the original wizard card -->
    <rect width="100" height="130" fill="#4c1d95"/>
    <!-- Distant mountain peaks -->
    <polygon points="0,75 30,48 55,70 80,45 100,68 100,130 0,130" fill="#3b1673"/>
    <polygon points="0,85 24,68 45,86 75,64 100,82 100,130 0,130" fill="#220a47"/>

    <!-- Archmage Robe (Royal purple with gold collar) -->
    <path d="M10 130 C12 88 32 80 50 80 C68 80 88 88 90 130 Z" fill="#7e22ce"/>
    <path d="M30 80 L36 130 M70 80 L64 130" stroke="#f1c40f" stroke-width="2.5" fill="none"/>
    <polygon points="50,80 44,92 56,92" fill="#f1c40f"/>

    <!-- Head and Long Beard -->
    <ellipse cx="50" cy="44" rx="14" ry="15" fill="#f5c296"/>
    <!-- Serious wise eyes -->
    <circle cx="44" cy="42" r="1.8" fill="#1e293b"/>
    <circle cx="56" cy="42" r="1.8" fill="#1e293b"/>
    <!-- Dark grey / brown hair and beard matching original -->
    <path d="M36 34 C36 22 64 22 64 34 C64 42 66 52 64 64 C60 76 54 82 50 84 C46 82 40 76 36 64 C34 52 36 42 36 34 Z" fill="#64748b"/>
    <path d="M42 54 C46 64 50 72 50 78 C50 72 54 64 58 54 C54 58 46 58 42 54 Z" fill="#94a3b8"/>
    <!-- Golden Crown / Circlet of the Wizard -->
    <path d="M35 30 L40 22 L45 28 L50 18 L55 28 L60 22 L65 30 Z" fill="url(#wz-chalice)"/>
    <rect x="35" y="28" width="30" height="4" fill="#d97706"/>
    <circle cx="50" cy="30" r="1.5" fill="#e11d48"/>

    <!-- Raised Hands holding the Iconic Golden Chalice / Cup -->
    <!-- Sleeves -->
    <path d="M22 130 C20 105 32 94 38 90" stroke="#7e22ce" stroke-width="12" stroke-linecap="round" fill="none"/>
    <path d="M78 130 C80 105 68 94 62 90" stroke="#7e22ce" stroke-width="12" stroke-linecap="round" fill="none"/>
    <!-- Hands -->
    <circle cx="40" cy="88" r="5" fill="#f5c296"/>
    <circle cx="60" cy="88" r="5" fill="#f5c296"/>

    <!-- The Golden Wizard Chalice -->
    <g transform="translate(50, 78)">
      <!-- Cup Bowl -->
      <path d="M-12,-8 C-12,8 12,8 12,-8 Z" fill="url(#wz-chalice)" stroke="#b45309" stroke-width="1"/>
      <ellipse cx="0" cy="-8" rx="12" ry="3.5" fill="#fde68a" stroke="#b45309" stroke-width="1"/>
      <!-- Glowing Magenta Liquid Inside Chalice -->
      <ellipse cx="0" cy="-8" rx="10" ry="2.6" fill="#f0abfc"/>
      <!-- Chalice Stem & Foot -->
      <rect x="-2" y="8" width="4" height="12" fill="#b45309"/>
      <ellipse cx="0" cy="20" rx="9" ry="3.5" fill="url(#wz-chalice)" stroke="#b45309" stroke-width="1"/>
      <!-- Sparkle from chalice -->
      <polygon points="0,-18 2,-11 9,-9 2,-7 0,0 -2,-7 -9,-9 -2,-11" fill="#ffffff" opacity=".95"/>
    </g>
  </symbol>

  <!-- JESTER / NARR (N) - Wild Court Fool in the Twilight Forest (Original Ken Fisher Card) -->
  <symbol id="wz-jester" viewBox="0 0 100 130">
    <!-- Forest Twilight Landscape (Green/Dark Forest with twisted trees) -->
    <rect width="100" height="130" fill="#064e3b"/>
    <!-- Distant twisted pines -->
    <polygon points="0,60 14,35 28,60" fill="#022c22"/>
    <polygon points="72,55 86,30 100,55" fill="#022c22"/>
    <polygon points="18,65 30,42 42,65" fill="#065f46"/>
    <polygon points="58,62 70,38 82,62" fill="#065f46"/>
    <!-- Forest floor -->
    <path d="M0 80 Q50 70 100 80 L100 130 L0 130 Z" fill="#022c22"/>

    <!-- Crouching Wild Jester in Red / Turquoise Doublet -->
    <!-- Harlequin Legs crouched -->
    <path d="M22 130 L32 105 L45 118" stroke="#dc2626" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <path d="M78 130 L68 105 L55 118" stroke="#0d9488" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>

    <!-- Jester Body leaning forward -->
    <ellipse cx="50" cy="94" rx="18" ry="16" fill="#b91c1c"/>
    <path d="M34 94 C34 94 45 80 50 94 C55 80 66 94 66 94" fill="#0f766e"/>

    <!-- Jester Head with expressive theatrical expression -->
    <circle cx="50" cy="62" r="15" fill="#fcd34d"/>
    <!-- Eyes, nose and wide grin -->
    <circle cx="44" cy="59" r="2.2" fill="#18181b"/>
    <circle cx="56" cy="59" r="2.2" fill="#18181b"/>
    <circle cx="50" cy="65" r="2.5" fill="#e11d48"/>
    <path d="M40 70 Q50 82 60 70" stroke="#991b1b" stroke-width="2.6" fill="none" stroke-linecap="round"/>
    <path d="M43 71 Q50 78 57 71" fill="#ffffff"/>

    <!-- Wild Spiked Jester Hair / Jester Cap with Ringing Bells -->
    <!-- Wild Hair Spikes (Iconic green/yellow wild hair of the original Narr) -->
    <path d="M32 54 L18 42 L32 46 L20 28 L38 38 L32 18 L46 32 L50 12 L54 32 L68 18 L62 38 L80 28 L68 46 L82 42 L68 54 Z" fill="#84cc16"/>
    <path d="M36 50 L26 40 L36 44 L28 30 L42 36 L38 22 L48 32 L50 18 L52 32 L62 22 L58 36 L72 30 L64 44 L74 40 L64 50 Z" fill="#eab308" opacity=".8"/>

    <!-- Little brass bells jingling on his collar and wrists -->
    <circle cx="34" cy="80" r="3" fill="#facc15" stroke="#a16207" stroke-width="1"/>
    <circle cx="50" cy="82" r="3.2" fill="#facc15" stroke="#a16207" stroke-width="1"/>
    <circle cx="66" cy="80" r="3" fill="#facc15" stroke="#a16207" stroke-width="1"/>

    <!-- Hands gesticulating playfully -->
    <circle cx="28" cy="92" r="4.5" fill="#fcd34d"/>
    <circle cx="72" cy="92" r="4.5" fill="#fcd34d"/>
  </symbol>

  <!-- AUTHENTIC ORIGINAL CARD BACK (Black Border, Fiery Crackle Panel, "wizard" Gothic Title, 4 Suit Runes) -->
  <symbol id="wz-back" viewBox="0 0 100 140">
    <!-- Solid Black Outer Border of original Wizard card -->
    <rect width="100" height="140" fill="#000000"/>
    <!-- Inner border frame -->
    <rect x="6" y="6" width="88" height="128" rx="4" fill="#0a0a14" stroke="#4a5568" stroke-width="1.2"/>

    <!-- Crackling Fire / Lightning Panel in Center -->
    <rect x="10" y="10" width="80" height="120" rx="3" fill="#070c18"/>
    <!-- Molten Fire Veins in the rock texture -->
    <path d="M12 40 Q25 45 40 32 T70 38 T88 28" stroke="#ff4757" stroke-width="1.8" fill="none" opacity=".8"/>
    <path d="M14 85 Q30 75 50 88 T86 78" stroke="#ffa502" stroke-width="1.8" fill="none" opacity=".75"/>
    <path d="M25 10 Q32 30 28 60 T35 110 T25 125" stroke="#ff6348" stroke-width="1.5" fill="none" opacity=".7"/>
    <path d="M72 15 Q68 45 74 75 T66 125" stroke="#eccc68" stroke-width="1.5" fill="none" opacity=".65"/>

    <!-- Gothic / Runic "wizard" Title in Center Header -->
    <g transform="translate(50, 32)">
      <!-- Glowing drop shadow of text -->
      <text x="0" y="0" text-anchor="middle" font-family="'Cinzel', 'Times New Roman', Georgia, serif" font-weight="900" font-size="19" letter-spacing="0.06em" fill="#000" stroke="#f1c40f" stroke-width="2.5">wizard</text>
      <text x="0" y="0" text-anchor="middle" font-family="'Cinzel', 'Times New Roman', Georgia, serif" font-weight="900" font-size="19" letter-spacing="0.06em" fill="#ffeaa7">wizard</text>
    </g>

    <!-- The 4 Authentic Suit Emblems Displayed on the Card Back -->
    <!-- 1. Green Trident (Elves) - Top Left -->
    <g transform="translate(30, 62) scale(0.28)">
      <circle cx="0" cy="0" r="42" fill="#064e3b" stroke="#00b894" stroke-width="4"/>
      <!-- Spear symbol -->
      <line x1="0" y1="-32" x2="0" y2="34" stroke="#55efc4" stroke-width="9" stroke-linecap="round"/>
      <path d="M-22 -12 C-22 14 -8 22 0 22 C8 22 22 14 22 -12" fill="none" stroke="#55efc4" stroke-width="9" stroke-linecap="round"/>
      <polygon points="0,-36 -8,-20 8,-20" fill="#55efc4"/>
    </g>

    <!-- 2. Blue Battle Crescent (Giants) - Top Right -->
    <g transform="translate(70, 62) scale(0.28)">
      <circle cx="0" cy="0" r="42" fill="#0c4a6e" stroke="#0284c7" stroke-width="4"/>
      <line x1="0" y1="-28" x2="0" y2="34" stroke="#7dd3fc" stroke-width="9" stroke-linecap="round"/>
      <path d="M-24 -18 Q0 18 24 -18" fill="none" stroke="#7dd3fc" stroke-width="9" stroke-linecap="round"/>
      <circle cx="0" cy="-2" r="10" fill="none" stroke="#7dd3fc" stroke-width="7"/>
    </g>

    <!-- 3. Yellow Sun-Tau (Dwarves) - Bottom Left -->
    <g transform="translate(30, 102) scale(0.28)">
      <circle cx="0" cy="0" r="42" fill="#78350f" stroke="#d97706" stroke-width="4"/>
      <circle cx="0" cy="-4" r="22" fill="none" stroke="#fde047" stroke-width="9"/>
      <circle cx="0" cy="-4" r="8" fill="#fde047"/>
      <line x1="0" y1="18" x2="0" y2="34" stroke="#fde047" stroke-width="9" stroke-linecap="round"/>
    </g>

    <!-- 4. Red Winged Cross (Humans) - Bottom Right -->
    <g transform="translate(70, 102) scale(0.28)">
      <circle cx="0" cy="0" r="42" fill="#7f1d1d" stroke="#dc2626" stroke-width="4"/>
      <line x1="0" y1="-32" x2="0" y2="34" stroke="#fca5a5" stroke-width="9" stroke-linecap="round"/>
      <line x1="-18" y1="-12" x2="18" y2="-12" stroke="#fca5a5" stroke-width="9" stroke-linecap="round"/>
      <path d="M-18 -12 C-18 8 -8 16 0 16 C8 16 18 8 18 -12" fill="none" stroke="#fca5a5" stroke-width="8"/>
      <circle cx="0" cy="-20" r="6" fill="#fca5a5"/>
    </g>
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

  /**
   * Authentic Wizard card corners:
   * - Wizard displays 'Z' (Zauberer) in the corners
   * - Jester displays 'N' (Narr) in the corners
   * - Numbered cards display 1..13 with the suit symbol directly beside or below the rank
   */
  function cardHTML(c, { tag = 'div', cls = '', attrs = '' } = {}) {
    if (c.type === 'back') {
      return `<${tag} class="card wc back ${cls}" aria-label="Hidden card" ${attrs}><svg class="art" viewBox="0 0 100 140" preserveAspectRatio="none" aria-hidden="true"><use href="#wz-back"/></svg></${tag}>`;
    }
    if (c.type === 'wizard') {
      return `<${tag} class="card wc wizard ${cls}" aria-label="Wizard" ${attrs}><span class="wc-in"><span class="wc-rk tl"><span class="orig-corner">Z</span></span><svg class="art" viewBox="0 0 100 130" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><use href="#wz-wizard"/></svg><span class="wc-banner">Wizard</span><span class="wc-rk br"><span class="orig-corner">Z</span></span></span></${tag}>`;
    }
    if (c.type === 'jester') {
      return `<${tag} class="card wc jester ${cls}" aria-label="Jester" ${attrs}><span class="wc-in"><span class="wc-rk tl"><span class="orig-corner">N</span></span><svg class="art" viewBox="0 0 100 130" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><use href="#wz-jester"/></svg><span class="wc-banner">Jester</span><span class="wc-rk br"><span class="orig-corner">N</span></span></span></${tag}>`;
    }
    const name = `${SUITS[c.suit].one} ${c.rank}`;
    return `<${tag} class="card wc suit-${c.suit} ${cls}" aria-label="${esc(name)}" ${attrs}><span class="wc-in">
      <span class="wc-rk tl"><span class="orig-rk">${c.rank}</span>${use('wz-' + c.suit, 'em')}</span>
      <div class="wc-scene suit-${c.suit}">
        ${use('wz-' + c.suit, 'big')}
      </div>
      <span class="wc-banner">${esc(SUITS[c.suit].name)} ${c.rank}</span>
      <span class="wc-rk br"><span class="orig-rk">${c.rank}</span>${use('wz-' + c.suit, 'em')}</span>
    </span></${tag}>`;
  }

  const suitIcon = (s, cls = 'sico') => use('wz-' + s, cls);

  window.WizardCards = { SUITS, cardHTML, suitIcon };
})();
