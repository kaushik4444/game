/* Small synthesized sound effects (Web Audio, no audio files). Mute is remembered per browser. */
(() => {
  'use strict';
  let ctx = null;
  let muted = false;
  try { muted = localStorage.getItem('ct_mute') === '1'; } catch { /* ignore */ }

  function ac() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone(freq, t0, dur, { type = 'sine', vol = 0.18, slide = 0 } = {}) {
    const a = ac();
    if (!a) return;
    const o = a.createOscillator();
    const g = a.createGain();
    const t = a.currentTime + t0;
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(a.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  function noise(t0, dur, vol = 0.2, hp = 1800) {
    const a = ac();
    if (!a) return;
    const buf = a.createBuffer(1, Math.floor(a.sampleRate * dur), a.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const s = a.createBufferSource();
    const f = a.createBiquadFilter();
    const g = a.createGain();
    f.type = 'highpass';
    f.frequency.value = hp;
    g.gain.value = vol;
    s.buffer = buf;
    s.connect(f).connect(g).connect(a.destination);
    s.start(a.currentTime + t0);
  }

  const SOUNDS = {
    card: () => { noise(0, 0.07, 0.35, 1500); tone(180, 0, 0.08, { type: 'triangle', vol: 0.12, slide: 0.6 }); },
    deal: () => { for (let i = 0; i < 4; i++) noise(i * 0.07, 0.05, 0.22, 2200); },
    tick: () => tone(740, 0, 0.07, { type: 'square', vol: 0.06 }),
    turn: () => { tone(660, 0, 0.16, { vol: 0.2 }); tone(880, 0.12, 0.22, { vol: 0.2 }); },
    win: () => { tone(523, 0, 0.14, { type: 'triangle' }); tone(659, 0.09, 0.14, { type: 'triangle' }); tone(784, 0.18, 0.24, { type: 'triangle' }); },
    lose: () => tone(300, 0, 0.3, { type: 'triangle', vol: 0.14, slide: 0.7 }),
    round: () => { tone(440, 0, 0.18, { type: 'triangle' }); tone(587, 0.16, 0.3, { type: 'triangle' }); },
    fanfare: () => { [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.14, 0.32, { type: 'triangle', vol: 0.22 })); tone(1047, 0.6, 0.7, { type: 'sine', vol: 0.18 }); },
    emote: () => tone(900, 0, 0.12, { vol: 0.12, slide: 1.5 }),
  };

  window.CardTable = window.CardTable || {};
  window.CardTable.sound = {
    play(name) { if (muted || !SOUNDS[name]) return; try { SOUNDS[name](); } catch { /* ignore */ } },
    toggle() {
      muted = !muted;
      try { localStorage.setItem('ct_mute', muted ? '1' : '0'); } catch { /* ignore */ }
      if (!muted) SOUNDS.tick();
      return muted;
    },
    isMuted: () => muted,
    button: () => `<button class="btn ghost small sound-btn" data-act="sound" aria-label="${muted ? 'Turn sound on' : 'Turn sound off'}">${muted ? '🔇' : '🔊'}</button>`,
  };

  // browsers only allow audio after a user gesture
  const unlock = () => { ac(); window.removeEventListener('pointerdown', unlock); };
  window.addEventListener('pointerdown', unlock);
})();
