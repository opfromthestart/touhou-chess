// sfx.js — synthesized WebAudio sound effects. No external assets: every sound
// is built from oscillators + a shared noise buffer, mixed through a master
// gain + compressor so overlapping sounds stay balanced and click-free.
//
// Loaded as a plain <script>; in Node (or without AudioContext) it degrades to
// a no-op. Call SFX.init() on the first user gesture (the browser blocks audio
// until then). Then SFX.play(name) fires a sound; it no-ops when disabled.
(function () {
  const SFX = {
    enabled: true,
    _ctx: null,
    _master: null,
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

  // Master output: a gain stage into a compressor. Keeps loud moments (bomb,
  // hit) from clipping when they land on top of rapid fire/graze ticks.
  function getMaster(ctx) {
    if (!SFX._master) {
      const g = ctx.createGain();
      g.gain.value = 0.6;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.knee.value = 24;
      comp.ratio.value = 8;
      comp.attack.value = 0.002;
      comp.release.value = 0.12;
      g.connect(comp);
      comp.connect(ctx.destination);
      SFX._master = g;
    }
    return SFX._master;
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

  // One enveloped tone. `o`: freq, dur, type, vol, when, slideTo (exponential
  // pitch ramp), attack (s, default 0.006). Routes through the master bus.
  function tone(ctx, o) {
    const { freq, dur = 0.1, type = 'sine', vol = 0.2, when = 0, slideTo = null, attack = 0.006 } = o;
    const t0 = ctx.currentTime + when;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(1, freq), t0);
    if (slideTo != null) osc.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, vol), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(getMaster(ctx));
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  // A filtered noise burst (impacts, bombs, whooshes).
  function noiseBurst(ctx, o) {
    const { dur = 0.2, vol = 0.3, when = 0, filterFreq = 1000, filterEnd = null, type = 'lowpass' } = o;
    const t0 = ctx.currentTime + when;
    const src = ctx.createBufferSource();
    src.buffer = getNoise(ctx);
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(filterFreq, t0);
    if (filterEnd != null) f.frequency.exponentialRampToValueAtTime(Math.max(20, filterEnd), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.max(0.0001, vol), t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(getMaster(ctx));
    src.start(t0);
    src.stop(t0 + dur + 0.05);
  }

  function play(name) {
    if (!SFX.enabled) return;
    const ctx = getCtx();
    if (!ctx) return;
    switch (name) {
      case 'move':
        // Soft wooden "tok" — a quick pitch dip, quiet.
        tone(ctx, { freq: 420, slideTo: 300, dur: 0.07, type: 'triangle', vol: 0.09 });
        break;

      case 'capture':
        // Whoosh up into an impact thump.
        noiseBurst(ctx, { dur: 0.22, vol: 0.14, filterFreq: 600, filterEnd: 2400, type: 'bandpass' });
        tone(ctx, { freq: 180, slideTo: 90, dur: 0.2, type: 'sine', vol: 0.2, when: 0.12 });
        noiseBurst(ctx, { dur: 0.12, vol: 0.12, filterFreq: 500, type: 'lowpass', when: 0.12 });
        break;

      case 'fire': {
        // Tiny magic zap, throttled + slightly randomized so the rapid
        // auto-fire reads as a shimmer, not a metronome.
        const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        if (now - SFX._lastFire < 40) return;
        SFX._lastFire = now;
        const f = 1250 * (0.96 + Math.random() * 0.08);
        tone(ctx, { freq: f, slideTo: f * 0.55, dur: 0.05, type: 'sine', vol: 0.03 });
        break;
      }

      case 'graze':
        // Bright airy "ting".
        tone(ctx, { freq: 2300, slideTo: 2900, dur: 0.06, type: 'sine', vol: 0.04 });
        break;

      case 'powerup':
        // Extra-bomb pickup: a bright two-note "ding-ding" rise.
        tone(ctx, { freq: 1046.5, dur: 0.12, type: 'triangle', vol: 0.12 });
        tone(ctx, { freq: 1567.98, dur: 0.18, type: 'triangle', vol: 0.12, when: 0.08 });
        tone(ctx, { freq: 3135.96, dur: 0.18, type: 'sine', vol: 0.04, when: 0.08 });
        break;

      case 'hit':
        // Deep thud with a descending body + low thump noise.
        tone(ctx, { freq: 240, slideTo: 60, dur: 0.32, type: 'sine', vol: 0.3 });
        tone(ctx, { freq: 120, slideTo: 45, dur: 0.3, type: 'triangle', vol: 0.18 });
        noiseBurst(ctx, { dur: 0.22, vol: 0.2, filterFreq: 800, filterEnd: 150, type: 'lowpass' });
        break;

      case 'bomb':
        // Big boom: sub drop + rumbling noise sweep + initial crack.
        tone(ctx, { freq: 130, slideTo: 28, dur: 0.7, type: 'sine', vol: 0.34 });
        noiseBurst(ctx, { dur: 0.55, vol: 0.26, filterFreq: 900, filterEnd: 90, type: 'lowpass' });
        noiseBurst(ctx, { dur: 0.06, vol: 0.18, filterFreq: 3000, type: 'highpass' });
        break;

      case 'spell':
        // Spell-card announcement: a two-note chime (A5 -> C#6) with a soft
        // octave shimmer, like the games' card banners.
        tone(ctx, { freq: 880, dur: 0.22, type: 'triangle', vol: 0.12 });
        tone(ctx, { freq: 1760, dur: 0.22, type: 'sine', vol: 0.04 });
        tone(ctx, { freq: 1108.73, dur: 0.3, type: 'triangle', vol: 0.12, when: 0.09 });
        tone(ctx, { freq: 2217.46, dur: 0.3, type: 'sine', vol: 0.04, when: 0.09 });
        break;

      case 'break':
        // Spell-card BREAK (gauge destroyed by damage): a bright glassy
        // shatter + ascending sparkle notes. Distinct from 'spell' (card start)
        // — this is the reward for aggressive play.
        noiseBurst(ctx, { dur: 0.3, vol: 0.2, filterFreq: 4200, filterEnd: 1600, type: 'highpass' });
        tone(ctx, { freq: 1567.98, slideTo: 3135.96, dur: 0.35, type: 'sine', vol: 0.12 });
        [2093, 2637, 3135.96].forEach((f, i) =>
          tone(ctx, { freq: f, dur: 0.26, type: 'triangle', vol: 0.07, when: 0.05 + i * 0.05 }));
        break;

      case 'join':
        // "Ding-dong" doorbell: the guest joined the host's room. Two bright
        // descending bell notes with a soft octave shimmer.
        tone(ctx, { freq: 1318.5, dur: 0.4, type: 'sine', vol: 0.16 });
        tone(ctx, { freq: 2637, dur: 0.25, type: 'sine', vol: 0.04 });
        tone(ctx, { freq: 987.77, dur: 0.55, type: 'sine', vol: 0.16, when: 0.18 });
        tone(ctx, { freq: 1975.5, dur: 0.35, type: 'sine', vol: 0.04, when: 0.18 });
        break;

      case 'win':
        // Ascending major arpeggio (C-E-G-C-E) ending on a bright chord.
        [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => {
          tone(ctx, { freq: f, dur: 0.16, type: 'triangle', vol: 0.13, when: i * 0.11 });
          tone(ctx, { freq: f * 2, dur: 0.16, type: 'sine', vol: 0.035, when: i * 0.11 });
        });
        [1046.5, 1318.5, 1567.98].forEach((f) =>
          tone(ctx, { freq: f, dur: 0.55, type: 'triangle', vol: 0.07, when: 0.58 }));
        break;

      case 'lose':
        // Descending minor phrase (A-F-D-A) with a long fading tail.
        [440, 349.23, 293.66, 220].forEach((f, i) => {
          tone(ctx, { freq: f, dur: 0.2, type: 'sine', vol: 0.13, when: i * 0.15 });
          tone(ctx, { freq: f / 2, dur: 0.2, type: 'triangle', vol: 0.05, when: i * 0.15 });
        });
        tone(ctx, { freq: 220, slideTo: 110, dur: 0.7, type: 'sine', vol: 0.1, when: 0.6 });
        break;
    }
  }

  SFX.init = function () { getCtx(); };
  SFX.play = play;

  if (typeof window !== 'undefined') window.SFX = SFX;
  if (typeof module !== 'undefined' && module.exports) module.exports = SFX;
})();
