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

  let noiseBuf = null;
  /** Band-passed noise whose centre frequency sweeps from f0 to f1: the "swish" of a card moving through air. */
  function swish(t0, dur, { vol = 0.3, f0 = 3000, f1 = 900, q = 1 } = {}) {
    const a = ac();
    if (!a) return;
    if (!noiseBuf) {
      noiseBuf = a.createBuffer(1, a.sampleRate, a.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const s = a.createBufferSource();
    const f = a.createBiquadFilter();
    const g = a.createGain();
    const t = a.currentTime + t0;
    s.buffer = noiseBuf;
    f.type = 'bandpass';
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + Math.min(0.012, dur / 3));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(a.destination);
    s.start(t, Math.random() * 0.5);
    s.stop(t + dur + 0.03);
  }

  const SOUNDS = {
    // refined tactile card play: crisp tactile swish with warm wood/felt thud
    card: () => {
      swish(0, 0.09, { vol: 0.28, f0: 3200, f1: 1100, q: 0.8 });
      tone(110, 0.015, 0.09, { type: 'sine', vol: 0.22, slide: 0.45 });
      tone(65, 0.03, 0.06, { type: 'triangle', vol: 0.15 });
    },
    // deal: smooth riffle cascade
    deal: () => {
      for (let i = 0; i < 5; i++) {
        swish(i * 0.06, 0.06, { vol: 0.22, f0: 4000, f1: 1500, q: 0.9 });
        tone(140 + i * 15, i * 0.06 + 0.02, 0.05, { type: 'sine', vol: 0.08 });
      }
    },
    // collect: graceful sweep into winner's pile
    collect: () => {
      swish(0, 0.28, { vol: 0.32, f0: 800, f1: 2800, q: 0.75 });
      tone(261.63, 0.02, 0.15, { type: 'triangle', vol: 0.08, slide: 1.5 });
      tone(329.63, 0.08, 0.18, { type: 'triangle', vol: 0.08, slide: 1.4 });
    },
    chat: () => { tone(523.25, 0, 0.06, { type: 'sine', vol: 0.1 }); tone(659.25, 0.05, 0.08, { type: 'sine', vol: 0.1 }); },
    tick: () => tone(587.33, 0, 0.05, { type: 'sine', vol: 0.08 }),
    turn: () => { tone(523.25, 0, 0.12, { type: 'triangle', vol: 0.15 }); tone(659.25, 0.1, 0.18, { type: 'triangle', vol: 0.18 }); tone(783.99, 0.2, 0.25, { type: 'triangle', vol: 0.22 }); },
    win: () => {
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, i * 0.08, 0.25, { type: 'triangle', vol: 0.18 }));
    },
    lose: () => tone(220, 0, 0.25, { type: 'triangle', vol: 0.15, slide: 0.6 }),
    round: () => { tone(392, 0, 0.15, { type: 'triangle', vol: 0.15 }); tone(523.25, 0.12, 0.25, { type: 'triangle', vol: 0.18 }); },
    fanfare: () => {
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, i * 0.12, 0.35, { type: 'triangle', vol: 0.2 }));
      tone(1046.5, 0.5, 0.6, { type: 'sine', vol: 0.18, slide: 1.05 });
    },
    emote: () => tone(783.99, 0, 0.1, { type: 'sine', vol: 0.12, slide: 1.3 }),
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
