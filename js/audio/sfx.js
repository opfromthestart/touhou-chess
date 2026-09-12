// sfx.js — lightweight WebAudio sound effects. No external assets: every sound
// is synthesized from oscillators + a shared noise buffer. Loaded as a plain
// <script>; in Node (or without AudioContext) it degrades to a no-op.
//
// Call SFX.init() on the first user gesture (the browser blocks audio until
// then). Then SFX.play(name) fires a sound; it no-ops when disabled.
(function () {
  const SFX = {
    enabled: true,
    _ctx: null,
    _noise: null,
    _lastFire: 0,
  };

  function getCtx() {
    if (typeof window === 'undefined') return null;
    if (!SFX._ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { SFX._ctx = new AC(); } catch (e) { return null; }
    }
    if (SFX._ctx.state === 'suspended') SFX._ctx.resume();
    return SFX._ctx;
  }

  function getNoise(ctx) {
    if (!SFX._noise) {
      const len = Math.floor(ctx.sampleRate * 1);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      SFX._noise = buf;
    }
    return SFX._noise;
  }

  // One enveloped tone (exponential attack/release so there are no clicks).
  function tone(ctx, o) {
    const { freq, dur = 0.1, type = 'sine', vol = 0.2, when = 0, slideTo = null } = o;
    const t0 = ctx.currentTime + when;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo != null) osc.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  }

  // A filtered noise burst (impacts, bombs, whooshes).
  function noiseBurst(ctx, o) {
    const { dur = 0.2, vol = 0.3, when = 0, filterFreq = 1000, type = 'lowpass' } = o;
    const t0 = ctx.currentTime + when;
    const src = ctx.createBufferSource();
    src.buffer = getNoise(ctx);
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = filterFreq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(ctx.destination);
    src.start(t0);
    src.stop(t0 + dur + 0.03);
  }

  function play(name) {
    if (!SFX.enabled) return;
    const ctx = getCtx();
    if (!ctx) return;
    switch (name) {
      case 'move':
        tone(ctx, { freq: 320, dur: 0.06, type: 'triangle', vol: 0.1 });
        break;
      case 'capture':
        noiseBurst(ctx, { dur: 0.28, vol: 0.16, filterFreq: 1800, type: 'bandpass' });
        tone(ctx, { freq: 380, dur: 0.28, type: 'sawtooth', vol: 0.07, slideTo: 900 });
        break;
      case 'fire': {
        const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        if (now - SFX._lastFire < 45) return; // throttle the rapid auto-fire
        SFX._lastFire = now;
        tone(ctx, { freq: 900, dur: 0.03, type: 'square', vol: 0.028 });
        break;
      }
      case 'graze':
        tone(ctx, { freq: 1500, dur: 0.05, type: 'sine', vol: 0.05 });
        break;
      case 'hit':
        tone(ctx, { freq: 150, dur: 0.3, type: 'sine', vol: 0.32, slideTo: 55 });
        noiseBurst(ctx, { dur: 0.2, vol: 0.18, filterFreq: 700, type: 'lowpass' });
        break;
      case 'bomb':
        noiseBurst(ctx, { dur: 0.6, vol: 0.32, filterFreq: 520, type: 'lowpass' });
        tone(ctx, { freq: 95, dur: 0.6, type: 'sine', vol: 0.28, slideTo: 40 });
        break;
      case 'spell':
        tone(ctx, { freq: 660, dur: 0.12, type: 'sine', vol: 0.11 });
        tone(ctx, { freq: 990, dur: 0.16, type: 'sine', vol: 0.11, when: 0.08 });
        break;
      case 'win':
        [523, 659, 784, 1047].forEach((f, i) =>
          tone(ctx, { freq: f, dur: 0.18, type: 'triangle', vol: 0.15, when: i * 0.12 }));
        break;
      case 'lose':
        [440, 349, 294, 220].forEach((f, i) =>
          tone(ctx, { freq: f, dur: 0.2, type: 'sine', vol: 0.15, when: i * 0.14 }));
        break;
    }
  }

  SFX.init = function () { getCtx(); };
  SFX.play = play;

  if (typeof window !== 'undefined') window.SFX = SFX;
  if (typeof module !== 'undefined' && module.exports) module.exports = SFX;
})();
