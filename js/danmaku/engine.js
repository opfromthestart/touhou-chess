// engine.js — the danmaku (bullet-hell) engine.
// Fixed-timestep 60fps loop on a portrait canvas. Player ship with lives/bombs/
// hitbox/focus, a pooled bullet system, collision + graze, and a data-driven
// pattern engine. Each boss fight is a sequence of phases (spell cards).

const TAU = Math.PI * 2;

// ── Deterministic randomness ────────────────────────────────────────────────
// All randomness inside the danmaku engine goes through a seeded PRNG
// (mulberry32), re-seeded at the start of every fight from a stable hash of
// the fight's identity. No Math.random anywhere in here: the same fight,
// fought again, produces the exact same bullet field — which makes replays,
// the AI's survival-model learning, and PVP fairness reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Small string hash (FNV-1a) -> uint32, used to derive a per-fight seed.
function hashStr(s) {
  let h = 0x811C9DC5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Play a sound effect if the SFX module is loaded (it no-ops when disabled or
// unavailable — e.g. in Node tests).
function sfxPlay(name) {
  if (typeof SFX !== 'undefined' && SFX) SFX.play(name);
}

// Bullet pool.
//
// A bullet is a small, data-driven object. Beyond position/velocity it carries
// an optional MOTION SCRIPT (staged trajectories like "fan out -> stop -> aim"),
// a freeze countdown (spawn frozen, then release), gravity, a banking turn
// (constant arc), rainbow cycling, a motion trail, a spawn timer (large bullets
// that emit children), and destructibility (player shots can destroy it).
// Every field is optional; plain bullets only set the basics.
function makeBullet(x, y, vx, vy, opts = {}) {
  return {
    x, y, vx, vy,
    r: opts.r || 4,
    color: opts.color || '#ff5555',
    coreColor: opts.coreColor || null,
    shape: opts.shape || 'circle', // circle | star | petal | cross | diamond | rice
    type: opts.type || 'normal', // normal | homing | curve | laser
    // Touhou convention: a bullet despawns only when it leaves the screen or
    // its card ends — NOT on a timer. The default lifetime is therefore
    // effectively infinite; off-screen culling (see _updateBullets) and the
    // phase-end field clear do the actual work. Set `life` explicitly only
    // where a finite one is load-bearing: laser segments (beam tail length +
    // density budget), homing / retention / stationary bullets (they never
    // reach the screen edge and would accumulate to the bullet cap), and
    // fadeOut camouflage (the fade ramps over the remaining life).
    life: opts.life !== undefined ? opts.life : 1e7, // frames
    turn: opts.turn || 0, // homing turn rate OR constant banking (rad/frame)
    curve: opts.curve || 0, // curve acceleration (type==='curve')
    rot: opts.rot || 0, // current rotation (rad)
    rotSpeed: opts.rotSpeed || 0, // rotation per frame
    // Curve-bullet (expanding spiral) state: the spiral center (cx, cy),
    // current bearing (sa) and radius (sr), and radius growth rate (cspeed,
    // px/frame). Only used when type === 'curve'.
    cx: opts.cx !== undefined ? opts.cx : 0,
    cy: opts.cy !== undefined ? opts.cy : 0,
    sa: opts.sa || 0,
    sr: opts.sr || 0,
    cspeed: opts.cspeed || 0,
    // --- New capabilities (all optional) -----------------------------------
    // Frames the bullet stays put at its spawn point before it starts moving.
    // On release it may adopt a new direction/speed (releaseAngle/releaseSpeed)
    // — e.g. rings that "turn perpendicular" after a beat of stillness.
    freeze: opts.freeze || 0,
    releaseAngle: opts.releaseAngle, // rad; undefined = keep current velocity
    releaseSpeed: opts.releaseSpeed, // px/frame; undefined = keep current speed
    // Downward acceleration (px/frame^2) added to vy each frame (icicle fall).
    gravity: opts.gravity || 0,
    // ── General physics mode (mirrors Taisei's MoveParams integrator) ──
    // When ANY of these is set, the bullet integrates like Taisei does:
    //   pos += vel;  vel = accel + retention*vel;  vel += attraction*(point-pos)^exp
    // This single model subsumes move_linear / move_accelerated /
    // move_asymptotic(_simple/_halflife) / move_towards(_exp) / move_dampen /
    // move_stop, so any Taisei spell translates directly.
    accelX: opts.accelX || 0,          // constant acceleration x (px/frame^2)
    accelY: opts.accelY || 0,          // constant acceleration y
    retention: opts.retention || 1,    // vel *= retention each frame (<1 damp, >1 grow)
    attraction: opts.attraction || 0,  // spring pull strength toward attractPoint
    attractPoint: opts.attractPoint || null, // 'player' | 'boss' | {x,y} | [x,y]
    attractExp: opts.attractExp !== undefined ? opts.attractExp : 1, // distance exponent
    // Oscillating speed factor on top of the base velocity (Walachia-style
    // modulated movers): effective speed = speed * (speedOscBase + speedOscAmp*sin(f*t)).
    speedOscAmp: opts.speedOscAmp || 0,
    speedOscFreq: opts.speedOscFreq || 0,
    speedOscBase: opts.speedOscBase !== undefined ? opts.speedOscBase : 1,
    oscT: 0,
    // Fade in/out over the bullet's life (pdraw_timeout_scalefade equivalent).
    // NOTE: fadeOut ramps over the REMAINING life, so it only works with an
    // explicit finite `life` (camouflage bullets); the default lifetime is
    // effectively infinite.
    fadeIn: opts.fadeIn || 0,          // frames to ramp opacity 0->1
    fadeOut: opts.fadeOut || 0,        // frames to ramp opacity 1->0 at end of life
    opacity: 1,
    trail: !!opts.trail,               // motion trail (comet tail) behind the bullet
    // Destructible: player shots can damage/remove it. hp defaults to 3.
    destructible: !!opts.destructible,
    hp: opts.hp !== undefined ? opts.hp : (opts.destructible ? 3 : 0),
    maxHp: opts.maxHp !== undefined ? opts.maxHp : (opts.destructible ? (opts.hp !== undefined ? opts.hp : 3) : 0),
    // Spawn children: every `spawnEvery` frames fire `spawnEmits` from this
    // bullet's position (large hazards that shed smaller bullets / shooters).
    // `spawnCount` caps the number of spawn bursts (0 = unlimited); `inheritVel`
    // adds the parent's velocity to each child (moving shooters).
    spawnEvery: opts.spawnEvery || 0,
    spawnEmits: opts.spawnEmits || null,
    spawnCount: opts.spawnCount || 0,
    inheritVel: !!opts.inheritVel,
    spawnT: 0,
    spawnN: 0,
    deathBurst: opts.deathBurst || null, // emitter fired when destroyed
    // Laser telegraph: bullets of one laser instance share {solidAt} (global
    // time in seconds). Until then they render as a thin line and deal no
    // damage / grant no graze (see _checkCollisions / _drawBullet).
    laserGroup: opts.laserGroup || null,
    // Staged trajectory: an ordered list of motion segments, each
    // {dur (frames), mode, ...}. Modes: fly | hold | aim | homing | spin |
    // gravity. The bullet walks through them over its life (fan -> stop -> aim).
    script: opts.script || null,
    scriptIndex: 0,
    scriptT: 0,
    age: 0, // frames alive (drives fade in/out)
    // Remove once this far from the SPAWN point (Taisei max_viewport_dist).
    maxDist: opts.maxDist || 0,
    // Off-screen culling grace: the bullet is never culled for leaving the
    // screen until this many frames have elapsed (see _updateBullets). Used
    // by rotating laser rings, whose bullets can start off-screen and orbit
    // back into view. minLife >= life means "never culled while alive".
    minLife: opts.minLife || 0,
    sx: x,
    sy: y,
    grazed: false,
    active: true,
  };
}

class DanmakuEngine {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.W = canvas.width;
    this.H = canvas.height;
    this.onEnd = opts.onEnd || (() => { });
    this.onPhase = opts.onPhase || (() => { });
    this.onHud = opts.onHud || (() => { });

    this.player = null;
    this.boss = null;
    this.bullets = [];
    this.playerShots = [];
    this._playerHistory = [];
    this._playerHistIdx = 0;
    this.phaseHp = 0;
    this.phaseMaxHp = 0;
    this.shotPattern = null;
    this.phases = [];
    this.phaseIndex = 0;
    this.phaseTime = 0;
    this.time = 0;
    this.frame = 0;
    this.running = false;
    this.result = null; // 'win' | 'lose' | null
    this.score = 0;
    this.graze = 0;
    this.bombGauge = 0;
    this.shake = 0;
    this.fieldFreeze = null; // active field-freeze window (or null)
    this._rng = mulberry32(0x9e3779b9); // re-seeded per fight in start()
    this.keys = {};
    this.deathbombTimer = 0; // frames remaining in deathbomb window (0 = inactive)
    this._raf = null;
    this._last = 0;
    this._acc = 0;
    this.step = 1000 / 60; // fixed timestep (ms)
    // ── External (remote) input support ────────────────────────────────────
    // When `externalInput` is true the engine does NOT bind window keyboard
    // listeners; instead a caller feeds it a compact input state each frame via
    // applyRemoteInput(). This lets a client run a *spectator* copy of the
    // opponent's danmaku fight (driven by the opponent's synced input) while
    // also running its own locally-controlled fight — both at once, for the
    // multiplayer "see both screens" view.
    this.externalInput = false;
    // Monotonic count of bomb presses (the *intent* to bomb), used to relay
    // bomb edge-events across the network without dropping quick taps.
    this.bombSeq = 0;

    this._onKeyDown = (e) => this._key(e, true);
    this._onKeyUp = (e) => this._key(e, false);
    // If the window loses focus mid-fight, release every key: otherwise a key
    // held while the user clicked away would stay "pressed" when they return.
    this._onBlur = () => {
      this.keys = {};
      if (this.player) this.player.focus = false;
    };
  }

  _key(e, down) {
    const k = e.key.toLowerCase();
    const wasDown = this.keys[k];
    this.keys[k] = down;
    // Prevent page scroll on arrows/space.
    if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) {
      e.preventDefault();
    }
    // Bomb only on a FRESH press: holding the key fires keydown repeatedly
    // (auto-repeat), which would drain the bomb stock.
    if (down && !wasDown && (k === ' ' || k === 'x')) {
      this.bombSeq++; // relay the intent to any remote spectator
      this.bomb();
    }
    // Focus is hold-to-focus (like the real games): while Shift is held the
    // ship moves slower and the hitbox shrinks; bullets keep their normal speed.
    if (k === 'shift' && this.player) this.player.focus = down;
  }

  // ── External input (multiplayer) ─────────────────────────────────────────
  // The current compact input state, for sending to the opponent so they can
  // run a live spectator copy of THIS fight. `bombSeq` carries the bomb
  // edge-events (see applyRemoteInput).
  getInputState() {
    const k = this.keys;
    return {
      up: !!(k['arrowup'] || k['w']),
      down: !!(k['arrowdown'] || k['s']),
      left: !!(k['arrowleft'] || k['a']),
      right: !!(k['arrowright'] || k['d']),
      focus: !!(k['shift']),
      bombSeq: this.bombSeq,
    };
  }

  // Feed a remote input state into this (spectator) engine. `state` is the
  // shape returned by getInputState(). Movement + focus are applied as levels;
  // a bomb is fired when the remote bombSeq advances past ours (edge-detected,
  // so quick taps aren't dropped even across a laggy link).
  applyRemoteInput(state) {
    if (!state) return;
    const k = this.keys;
    k['arrowup'] = !!state.up; k['w'] = !!state.up;
    k['arrowdown'] = !!state.down; k['s'] = !!state.down;
    k['arrowleft'] = !!state.left; k['a'] = !!state.left;
    k['arrowright'] = !!state.right; k['d'] = !!state.right;
    k['shift'] = !!state.focus;
    if (this.player) this.player.focus = !!state.focus;
    if (typeof state.bombSeq === 'number' && state.bombSeq > this.bombSeq) {
      this.bombSeq = state.bombSeq;
      this.bomb();
    }
  }

  start(phases, boss, playerStats, playerPieceType, playerChar) {
    this.phases = phases;
    this.boss = {
      x: this.W / 2,
      y: 90,
      ...boss,
    };
    // The protagonist fighting (drives the player ship sprite).
    this.playerChar = playerChar || null;
    this.player = {
      x: this.W / 2,
      y: this.H - 60,
      speed: 4.2,
      lives: playerStats.lives,
      bombs: playerStats.bombs,
      hitbox: playerStats.hitbox,
      focusHitbox: playerStats.focus,
      focus: false,
      invuln: 0, // invulnerability frames after a hit
      alive: true,
    };
    this.bullets = [];
    this.playerShots = [];
    // Player position history ring buffer: stores { time, x, y } snapshots so
    // emitters can aim at where the player WAS at a specific past time (aimTime).
    this._playerHistory = [];
    this._playerHistIdx = 0;
    this.fieldFreeze = null;
    // Per-spell-card stats (tracked in every fight, shown in Practice Mode):
    // total pixels the player moved, and the time-average of the distance to
    // the closest bullet. `avgDist` is finalized when the card ends.
    this.phaseStats = phases.map(ph => ({
      name: ph.name,
      moved: 0,        // px moved during this card
      distSum: 0,      // sum of per-frame min distances to a bullet
      distSamples: 0,  // frames where at least one bullet was on screen
      avgDist: 0,
    }));
    // Deterministic per-fight randomness: same fight identity -> same bullet
    // field, every time. (The chess/AI layer keeps its own Math.random.)
    const seedStr = `${boss.charId || boss.name || 'boss'}|${playerPieceType}|${playerChar || ''}`;
    this._rng = mulberry32(hashStr(seedStr));
    // Fresh key state for every fight: a key still held from the previous
    // fight (e.g. released while the result overlay was up) must not carry
    // over into this one.
    this.keys = {};
    this.bombSeq = 0;
    this.deathbombTimer = 0;
    this.shotPattern =
      CONFIG.SHOT_PATTERNS[playerPieceType] || CONFIG.SHOT_PATTERNS.p;
    this.phaseIndex = 0;
    this.phaseTime = 0;
    this.time = 0;
    this.frame = 0;
    this.result = null;
    this.score = 0;
    this.graze = 0;
    this.bombGauge = 0;
    this.running = true;
    this._startPhase(0);
    // Local fights bind the keyboard; spectator (external) fights are driven
    // by applyRemoteInput() and must NOT react to the local player's keys.
    if (!this.externalInput) {
      window.addEventListener('keydown', this._onKeyDown);
      window.addEventListener('keyup', this._onKeyUp);
      window.addEventListener('blur', this._onBlur);
    }
    this._last = performance.now();
    this._acc = 0;
    this._loop();
  }

  // Begin a phase: set its HP gauge and announce it.
  _startPhase(i) {
    const phase = this.phases[i];
    if (!phase) return;
    this.phaseMaxHp = phase.hp || 0;
    this.phaseHp = this.phaseMaxHp;
    sfxPlay('spell');
    this.onPhase(phase);
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
  }

  _loop() {
    if (!this.running) return;
    const now = performance.now();
    let dt = now - this._last;
    this._last = now;
    if (dt > 200) dt = 200; // clamp after tab switch
    this._acc += dt;
    while (this._acc >= this.step) {
      this.update();
      this._acc -= this.step;
    }
    this.render();
    this.onHud(this._hud());
    if (this.running) this._raf = requestAnimationFrame(() => this._loop());
  }

  _hud() {
    const st = this.phaseStats ? this.phaseStats[this.phaseIndex] : null;
    return {
      lives: this.player.lives,
      bombs: this.player.bombs,
      score: this.score,
      graze: this.graze,
      bombGauge: this.bombGauge,
      phase: this.phaseIndex,
      phaseCount: this.phases.length,
      phaseName: this.phases[this.phaseIndex] ? this.phases[this.phaseIndex].name : '',
      phaseHp: this.phaseHp,
      phaseMaxHp: this.phaseMaxHp,
      phaseTime: this.phaseTime,
      phaseDuration: this.phases[this.phaseIndex] ? this.phases[this.phaseIndex].duration : 0,
      // Deathbomb window: >0 means the player is in a grace period where
      // pressing bomb will negate the imminent death.
      deathbombTimer: this.deathbombTimer,
      // Live per-card practice stats (current spell card only).
      phaseMoved: st ? st.moved : 0,
      phaseAvgDist: st && st.distSamples > 0 ? st.distSum / st.distSamples : null,
    };
  }

  update() {
    if (this.result) return;
    this.frame++;
    this.time += this.step / 1000;
    this.phaseTime += this.step / 1000;

    this._updatePlayer();
    this._updateBoss();
    this._emitPattern();
    this._updateFieldFreeze();
    this._updateBullets();
    this._updateShots();
    this._updateBeams();
    this._checkCollisions();
    this._updateDeathbomb();
    this._sampleProximity();

    // Phase progression: a spell card ends when its time elapses (timeout) or
    // its HP gauge is broken (depleted by player shots). Either way we advance.
    const phase = this.phases[this.phaseIndex];
    if (phase && (this.phaseTime >= phase.duration || this.phaseHp <= 0)) {
      this._finalizePhase(this.phaseIndex);
      this.phaseIndex++;
      this.phaseTime = 0;
      if (this.phaseIndex >= this.phases.length) {
        this._end('win');
      } else {
        // Clear the field for a clean transition into the next card.
        for (const b of this.bullets) b.active = false;
        this.bullets = [];
        this._startPhase(this.phaseIndex);
      }
    }
  }

  _updatePlayer() {
    const p = this.player;
    if (!p.alive) return;
    if (p.invuln > 0) p.invuln--;
    let dx = 0, dy = 0;
    if (this.keys['arrowleft'] || this.keys['a']) dx -= 1;
    if (this.keys['arrowright'] || this.keys['d']) dx += 1;
    if (this.keys['arrowup'] || this.keys['w']) dy -= 1;
    if (this.keys['arrowdown'] || this.keys['s']) dy += 1;
    if (dx !== 0 && dy !== 0) { dx *= 0.7071; dy *= 0.7071; }
    // Focus (holding X) slows the ship to half speed in exchange for the
    // smaller hitbox — the bullets are NOT slowed.
    const spd = p.speed * (p.focus ? 0.5 : 1);
    const px0 = p.x, py0 = p.y;
    p.x += dx * spd;
    p.y += dy * spd;
    p.x = Math.max(10, Math.min(this.W - 10, p.x));
    p.y = Math.max(10, Math.min(this.H - 10, p.y));
    // Record player position into the history ring buffer (capacity 600 = 10 s
    // at 60 fps — plenty for any aimTime offset). Entries are overwritten in
    // circular fashion so memory stays bounded.
    const MAX_HIST = 600;
    if (this._playerHistory.length < MAX_HIST) {
      this._playerHistory.push({ time: this.time, x: p.x, y: p.y });
    } else {
      this._playerHistory[this._playerHistIdx] = { time: this.time, x: p.x, y: p.y };
    }
    this._playerHistIdx = (this._playerHistIdx + 1) % MAX_HIST;
    // Practice stat: total distance moved this spell card (px). Measured
    // AFTER the edge clamp so pressing into a wall doesn't count as motion.
    const st = this.phaseStats ? this.phaseStats[this.phaseIndex] : null;
    if (st) st.moved += Math.hypot(p.x - px0, p.y - py0);
  }

  // Practice stat: distance from the player to the closest active bullet,
  // sampled once per frame. Frames with no bullets on screen are not
  // sampled (the average is over frames where a bullet existed). Beams are
  // not counted — this measures the bullet field only.
  _sampleProximity() {
    const p = this.player;
    const st = this.phaseStats ? this.phaseStats[this.phaseIndex] : null;
    if (!p || !p.alive || !st) return;
    let best = Infinity;
    for (const b of this.bullets) {
      if (!b.active) continue;
      const ddx = b.x - p.x, ddy = b.y - p.y;
      const d2 = ddx * ddx + ddy * ddy;
      if (d2 < best) best = d2;
    }
    if (best !== Infinity) {
      st.distSum += Math.sqrt(best);
      st.distSamples++;
    }
  }

  // Freeze a card's stats once it ends (timeout, HP broken, or fight end).
  _finalizePhase(i) {
    const st = this.phaseStats ? this.phaseStats[i] : null;
    if (!st) return;
    st.avgDist = st.distSamples > 0 ? st.distSum / st.distSamples : 0;
  }

  _updateBoss() {
    // Boss movement modes:
    //  sine    — gentle horizontal bob (default)
    //  still   — fixed at top-center
    //  slide   — Touhou-style: hold still while shooting, then quickly slide
    //            to a new position and hold again. The cycle restarts at
    //            every spell card, so each card opens with the boss static
    //            (stable origin for the opening volley — e.g. Kaguya's
    //            Cowrie Shell lasers + aimTime fan). Targets come from the
    //            seeded RNG, so a fight always slides identically. The boss
    //            always stays inside the top quarter of the screen and keeps
    //            a 12.5%-of-width margin from the left/right edges.
    //            Params (each resolved per-card, falling back to the boss,
    //            then a built-in): holdDur (s, default 3) — how long the
    //            boss holds still before sliding; slideDur (s, default 0.6)
    //            — how long the slide takes; slideDist (px, default 140) —
    //            how far it travels. Set them on a spell card (phase object)
    //            to tune that card's rhythm, or on the boss for a whole-fight
    //            default.
    //  circle  — orbit around a center point (Rumia / Cirno style)
    //  erratic — Taisei-style free roam: a damped velocity is pulled by a
    //            spring toward a drifting target (move_from_towards +
    //            retention), re-aimed every beat with the seeded RNG.
    const b = this.boss;
    if (!b.move || b.move === 'sine') {
      b.x = this.W / 2 + Math.sin(this.time * (b.moveSpeed || 0.8)) * (b.moveAmp || 60);
    } else if (b.move === 'still') {
      b.x = this.W / 2;
    } else if (b.move === 'slide') {
      // The sliding boss always stays clear of the side edges (12.5%
      // margin each side) and inside the top quarter of the screen.
      const mx = this.W * 0.125;
      const topY = this.H * 0.25;
      // Re-arm the hold/slide cycle at every phase change (phaseIndex flip)
      // so each card starts with the boss holding still at its current spot.
      if (!b._sl || b._sl.pi !== this.phaseIndex) {
        const cx = Math.max(mx, Math.min(this.W - mx, b.x));
        const cy = Math.min(b.y, topY);
        b._sl = {
          pi: this.phaseIndex, x: cx, y: cy, t: 0, holding: true,
          sx: cx, sy: cy, tx: cx, ty: cy
        };
      }
      const s = b._sl;
      // Resolve the slide pacing for THIS card: the current phase may override
      // each param, else fall back to the boss, else a built-in default. Each
      // card can therefore be tuned to its own rhythm.
      const ph = this.phases[this.phaseIndex];
      const pick = (key, def) =>
        (ph && ph[key] !== undefined) ? ph[key]
          : (b[key] !== undefined) ? b[key] : def;
      const holdDur = pick('holdDur', 3);
      const slideDur = pick('slideDur', 0.6);
      const dist = pick('slideDist', 200);
      s.t += this.step / 1000;
      if (s.holding) {
        b.x = s.x; b.y = s.y;
        if (s.t >= holdDur) {
          s.sx = s.x; s.sy = s.y;
          s.tx = Math.max(mx, Math.min(this.W - mx, s.x + (this._rnd() * 2 - 1) * dist));
          s.ty = Math.max(20, Math.min(topY, s.y + (this._rnd() * 2 - 1) * dist * 0.4));
          s.t = 0;
          s.holding = false;
        }
      } else {
        const k = Math.min(1, s.t / slideDur);
        const e = k * k * (3 - 2 * k); // smoothstep: eases out of the hold
        b.x = s.sx + (s.tx - s.sx) * e;
        b.y = s.sy + (s.ty - s.sy) * e;
        if (k >= 1) {
          s.x = s.tx; s.y = s.ty;
          s.t = 0;
          s.holding = true;
        }
      }
    } else if (b.move === 'circle') {
      const r = b.moveAmp || 60;
      const w = b.moveSpeed || 0.8;
      const cx = this.W / 2, cy = b.cy !== undefined ? b.cy : this.H * 0.22;
      b.x = cx + Math.cos(this.time * w) * r;
      b.y = cy + Math.sin(this.time * w) * r * (b.moveYScale || 0.4);
    } else if (b.move === 'erratic') {
      if (!b._mv) b._mv = { x: b.x, y: b.y, vx: 0, vy: 0, tx: b.x, ty: b.y, t: 0 };
      const m = b._mv;
      m.t--;
      if (m.t <= 0) {
        const dist = b.wanderDist || 100;
        m.tx = Math.max(20, Math.min(this.W - 20, m.x + (this._rnd() * 2 - 1) * dist));
        m.ty = Math.max(20, Math.min(this.H * 0.5, m.y + (this._rnd() * 2 - 1) * dist * 0.5));
        m.t = 40 + this._rnd() * 50;
      }
      // Same integrator as bullets: pos += vel; vel = accel + ret*vel;
      // vel += attraction*(target-pos).
      m.x += m.vx; m.y += m.vy;
      const ret = b.retention !== undefined ? b.retention : 0.9;
      m.vx = (b.accelX || 0) + ret * m.vx;
      m.vy = (b.accelY || 0) + ret * m.vy;
      const att = b.attraction || 0.015;
      m.vx += att * (m.tx - m.x);
      m.vy += att * (m.ty - m.y);
      b.x = Math.max(20, Math.min(this.W - 20, m.x));
      b.y = Math.max(20, Math.min(this.H * 0.55, m.y));
    }
  }

  _emitPattern() {
    const phase = this.phases[this.phaseIndex];
    if (!phase) return;
    const t = this.phaseTime;
    for (const em of phase.emits) {
      if (em._done) continue;
      if (t < em.t) continue;
      if (em._next === undefined) em._next = em.t;
      if (t >= em._next) {
        this._fireEmitter(em);
        const interval = em.interval || 0.2;
        // Fire count is tracked for ALL emitters (finite or infinite) so
        // patterns can evolve per shot (e.g. ring rotStep rotation).
        em._count = (em._count || 0) + 1;
        if (em.repeat !== undefined && em.repeat !== -1 && em._count >= em.repeat) {
          if (em.period) {
            // Loop the cycle: re-arm at the next period boundary (EoSD spell
            // bodies are repeating blocks). _count resets so per-fire
            // evolution (angleStep/speedStep/colors) restarts each cycle.
            const k = Math.max(1, Math.ceil((t - em.t) / em.period));
            em._next = em.t + k * em.period;
            em._count = 0;
            continue;
          }
          em._done = true; continue;
        }
        em._next += interval;
      }
    }
  }

  // Fire a phase emitter from the boss. Delegates to _emitAt (which fires from
  // an arbitrary origin) so spawned sub-patterns can reuse the same logic.
  _fireEmitter(em) {
    this._emitAt(this.boss.x, this.boss.y, em);
  }

  // Look up the player's position at a specific past time (seconds ago).
  // Used by emitters with `aimTime` to aim at where the player WAS, not where
  // they are now — critical for coordinated laser+bullet patterns.
  _playerAt(targetTime) {
    const hist = this._playerHistory;
    if (hist.length === 0) return { x: this.player.x, y: this.player.y };
    // Binary search for the entry closest to targetTime.
    let lo = 0, hi = hist.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (hist[mid].time < targetTime) lo = mid + 1;
      else hi = mid;
    }
    return hist[lo];
  }

  // Fire an emitter from an arbitrary origin (ox, oy). Aim is computed toward
  // the player from that origin. This is the single home for every emitter
  // type, so both the boss and any spawned sub-source share the vocabulary.
  _emitAt(ox, oy, em) {
    const p = this.player;
    const speedMul = em.speedMul !== undefined ? em.speedMul : 1;
    const densityMul = em.densityMul || 1;
    const count = Math.max(1, Math.round((em.count || 1) * densityMul));
    // em.speedStep adds speed PER FIRE (fire index = em._count): EoSD streams
    // whose bullets accelerate shot over shot (Night Bird / Demarcation).
    // Note: `!== undefined`, not `|| 2` — an EXPLICIT speed: 0 is legal and
    // means "stationary" (static laser segments); only an UNSET speed falls
    // back to the default 2.
    const speed = ((em.speed !== undefined ? em.speed : 2) + (em.speedStep || 0) * (em._count || 0)) * speedMul;
    // Base bearing: em.angle (absolute) or the aim line to the player.
    // em.angleOffset adds a STATIC offset to the aim line — EoSD fans aim at
    // the player plus a fixed swing base (Night Bird's ∓33°/∓45° bases).
    // em.angleStep adds radians PER FIRE (fire index = em._count, 0-based):
    // a rotating beam (Moonlight Ray's counter-rotating lasers) or a swinging
    // aim (Night Bird / Demarcation streams).
    // em.aimTime (seconds): if set, aim at the player's position that many
    // seconds BEFORE THIS FIRE (a lookback delay, not an absolute time).
    // This coordinates re-firing emitters: a fan that fires 1.0s after a
    // laser wall (aimTime: 1.0) tracks the wall's LATEST aim on every refire,
    // so the two stay aligned for the whole card — not just the first volley.
    let aimX = p.x, aimY = p.y;
    if (em.aimTime !== undefined) {
      const snap = this._playerAt(this.time - em.aimTime);
      aimX = snap.x;
      aimY = snap.y;
    }
    const aimAngle = Math.atan2(aimY - oy, aimX - ox);
    const baseAngle = (em.angle !== undefined ? em.angle : aimAngle + (em.angleOffset || 0))
      + (em.angleStep || 0) * (em._count || 0);
    // Color cycling on a GLOBAL phase clock (EoSD ins_118: a spell-wide color
    // state advances every few frames, so ALL bullets fired at the same moment
    // share a color and the whole field cycles together — Demarcation's
    // white -> blue-gray -> green -> red wave). em.colorStep = seconds per
    // color (EoSD: 2 frames = 1/30 s).
    if (Array.isArray(em.colors) && em.colors.length) {
      const step = em.colorStep || 1 / 30;
      em._cycColor = em.colors[Math.floor(this.phaseTime / step) % em.colors.length];
    }

    switch (em.type) {
      case 'point': {
        this._add(ox, oy, baseAngle, speed, em);
        break;
      }
      case 'aimed': {
        // NOTE: use ODD counts for aimed patterns. With an even count no
        // bullet sits on the aim line, so the player can camp dead-center on
        // the boss and take nothing — the pattern stops being a real threat.
        // (Same rule for 'fan'.)
        const spread = em.spread || 0;
        for (let i = 0; i < count; i++) {
          const a = baseAngle + (count > 1 ? (i / (count - 1) - 0.5) * spread : 0);
          this._add(ox, oy, a, speed, em);
        }
        break;
      }
      case 'ring': {
        // em.rot: static offset (rad). em.rotStep: rotation added PER FIRE
        // (rad) — makes a "rotating ring" (Taisei/Danmakufu spiral rings:
        // each full ring is offset from the last, e.g. +6° per emission).
        // em.aimRing: start the ring at the aim line (baseAngle), so exactly
        // one bullet flies dead at the player — EoSD aim_mode 2 rings.
        // em.spin (rad/s): the ring ROTATES IN PLACE as it expands — each
        // bullet orbits the fire origin (a 'curve' mover) while its radius
        // grows at `speed`, so the whole ring spins (Kaguya's Eternity Line
        // counter-rotates two rings: spin +0.4 / -0.4). Positive = clockwise
        // on screen. Do not combine with em.script (the script wins).
        const rot = (em.aimRing ? baseAngle : (em.rot || 0)) + (em.rotStep || 0) * (em._count || 0);
        for (let i = 0; i < count; i++) {
          const a = rot + (i / count) * TAU;
          const extra = {};
          if (em.spin) {
            // Orbit the fire origin, starting at radius 0 (all bullets spawn
            // on the boss and peel off into the spinning ring).
            // A spinning bullet can leave the screen and rotate back in, so
            // off-screen culling must not remove it while its orbit still
            // intersects the playfield. Every orbit point sits exactly `sr`
            // from the fire origin, and the farthest point of the (cull-band
            // extended) playfield is `far` away — so once sr > far the bullet
            // can never re-enter and culling is safe again. That crossing
            // is the minLife. em.minLife can override it.
            const m = 20; // matches the off-screen cull margin in _updateBullets
            const far = Math.max(
              Math.hypot(ox + m, oy + m), Math.hypot(this.W - ox + m, oy + m),
              Math.hypot(ox + m, this.H - oy + m), Math.hypot(this.W - ox + m, this.H - oy + m),
            );
            Object.assign(extra, {
              type: 'curve', curve: em.spin / 60,
              cx: ox, cy: oy, sa: a, sr: 0, cspeed: speed,
              minLife: em.minLife !== undefined ? em.minLife : Math.ceil(far / speed),
            });
          } else if (em.releaseTangent !== undefined) {
            // Demarcation-style ring: fly outward, hold, then drift
            // PERPENDICULAR to the radius (tangent), alternating direction
            // per bullet (even index one way, odd the other).
            extra.script = [
              { dur: Math.round((em.flyDur !== undefined ? em.flyDur : 1) * 60), mode: 'fly' },
              { dur: Math.round((em.holdDur !== undefined ? em.holdDur : 0.3) * 60), mode: 'hold' },
              {
                dur: 999999, mode: 'tangent', speed: em.releaseSpeed || 0.8,
                dir: (i % 2 === 0 ? 1 : -1) * (em.tangentDir || 1)
              },
            ];
          } else if (em.script) {
            extra.script = em.script;
          }
          // Per-bullet color alternation (odd bullets get em.colorAlt).
          if (em.colorAlt && i % 2 === 1) extra.color = em.colorAlt;
          this._add(ox, oy, a, speed, em, extra);
        }
        break;
      }
      case 'ringRing': {
        // Flower of flowers: `count` mini-rings placed on a circle of radius
        // em.radius around the origin; each mini-ring is `em.per` bullets
        // fired as a full ring from its own center. The classic Touhou
        // expanding-flower pattern (Danmakufu CreateRoundShotA2 rings on a
        // circle, e.g. SCC Rumia TPattern1). Mini-rings inherit speed/color/
        // physics from em, so retention/accel deceleration shapes the bloom.
        const radius = em.radius || 100;
        const per = Math.max(1, em.per || 5);
        const rot = (em.rot || 0) + (em.rotStep || 0) * (em._count || 0);
        for (let c = 0; c < count; c++) {
          const ca = rot + (c / count) * TAU;
          const gx = ox + Math.cos(ca) * radius;
          const gy = oy + Math.sin(ca) * radius;
          const inner = Object.assign({}, em, { type: 'ring', count: per });
          delete inner.radius; delete inner.per;
          this._emitAt(gx, gy, inner);
        }
        break;
      }
      case 'spiral': {
        const arms = em.arms || 1;
        const rot = (em.rotSpeed || 0.3) * this.phaseTime;
        // em.rotSpeed here is the ARM SWEEP rate, not a per-bullet visual
        // spin — strip it so _add doesn't copy it onto every bullet
        // (other emitters use em.rotSpeed as genuine in-place spin).
        const emNoSpin = Object.assign({}, em, { rotSpeed: undefined });
        for (let a = 0; a < arms; a++) {
          const ang = rot + (a / arms) * TAU;
          this._add(ox, oy, ang, speed, emNoSpin);
        }
        break;
      }
      case 'fan': {
        // NOTE: prefer ODD counts — see the 'aimed' note (even counts leave
        // the aim line open). `em.script` gives every bullet a shared staged
        // trajectory (e.g. fan out -> stop -> aim at the player).
        const spread = em.spread || 0.6;
        const extra = em.script ? { script: em.script } : {};
        for (let i = 0; i < count; i++) {
          const a = baseAngle + (i / (count - 1) - 0.5) * spread;
          this._add(ox, oy, a, speed, em, extra);
        }
        break;
      }
      case 'fanVolley': {
        // EoSD aim_mode 0/2 barrage: `count` RAYS spanning `em.spread`
        // (default 90°, starting AT the aim line — the first ray is dead on
        // the player; em.center re-centers the span on the aim line), each
        // ray holding `em.rows` bullets whose speeds peel linearly from
        // em.speed to em.speed2 (EoSD speed_1 -> speed_2 per row). This is
        // the signature Moonlight Ray / Demarcation "comet fan": dense rays
        // that stretch into long speed lines.
        const rays = count;
        const rows = Math.max(1, Math.round((em.rows || 1) * densityMul));
        const spread = em.spread !== undefined ? em.spread : Math.PI / 2;
        // em.speedStep: whole volley accelerates per fire (EoSD Demarcation
        // Sub21 streams: +0.25 speed shot over shot).
        const s1 = ((em.speed !== undefined ? em.speed : 2) + (em.speedStep || 0) * (em._count || 0)) * speedMul;
        const s2 = (em.speed2 !== undefined ? em.speed2 : s1) * speedMul;
        const off = em.center ? -spread / 2 : 0;
        for (let r = 0; r < rays; r++) {
          const a = baseAngle + off + (rays > 1 ? (r / (rays - 1)) * spread : 0);
          for (let k = 0; k < rows; k++) {
            const sp = rows > 1 ? s1 - (s1 - s2) * (k / (rows - 1)) : s1;
            this._add(ox, oy, a, sp, em);
          }
        }
        break;
      }
      case 'homing': {
        for (let i = 0; i < count; i++) {
          const a = baseAngle + (i - (count - 1) / 2) * 0.2;
          this._add(ox, oy, a, speed, em, { type: 'homing', turn: em.turn || 0.05 });
        }
        break;
      }
      case 'curve': {
        // Expanding spiral: each bullet keeps its distance from the spawn
        // point (the origin at fire time) growing while its bearing rotates —
        // see the 'curve' branch in _moveBullet.
        for (let i = 0; i < count; i++) {
          const a = baseAngle + (i - (count - 1) / 2) * 0.3;
          this._add(ox, oy, a, speed, em, {
            type: 'curve', curve: em.curve || 0.05,
            cx: ox, cy: oy, sa: a, sr: 0, cspeed: speed,
          });
        }
        break;
      }
      case 'laser': {
        // A laser is a line of bullets laid out ALONG the beam (offset from
        // the origin), refired every `interval` so successive segments overlap
        // into a continuous beam. Bullets sit `spacing` px apart and live
        // `life` frames (default 120). Length is `laserLen` px, or — when
        // omitted — out to the screen edge along the beam: lasers read as
        // infinitely long rays (EoSD beams extend past the playfield; the
        // off-screen tail is culled at the border).
        // Telegraph (EoSD laser warning): for the first `warn` seconds
        // (default 1.5, per-emitter override) the beam is a thin line that
        // does no damage and grants no graze; then it grows to full width.
        // EACH FIRING telegraphs independently — its own group, solid `warn`
        // seconds after THIS spawn, so a segment that fires later doesn't
        // inherit the first segment's countdown. Bullet lifetimes are
        // extended so they survive until the beam is solid, plus their
        // normal life after.
        // Sweep (em.sweep, rad/s): the beam ROTATES IN PLACE around the fire
        // origin while it lives — a true searchlight, not a static segment
        // (see Danmakufu laser-sweep patterns). Each bullet orbits the origin
        // at its fixed distance along the beam (a zero-growth 'curve' mover),
        // and EACH NEW SEGMENT starts sweep*interval further around, exactly
        // where the previous one has rotated to — so refired segments stack
        // into ONE continuous ray spinning at `sweep` (no fanning, no
        // snap-back). For a single beam do NOT also set angleStep: the
        // per-fire advance is automatic.
        // Multi-beam rings (em.count > 1): each firing lays `count` beams
        // evenly spaced around the origin — a full 360° "laser ring". With
        // `sweep`, every beam orbits the origin, and beam j of firing m sits
        // at angle + j*TAU/count + sweep*t REGARDLESS of m — every refired
        // copy lands exactly on top of the previous one, so the ring stacks
        // into ONE smoothly spinning wheel at `sweep` rad/s (no fanning, no
        // snap-back, and NO angleStep needed). Keep `life` at roughly one or
        // two `interval`s (plus the automatic warn extension) so a couple of
        // copies overlap and the beam never flickers. count is deliberately
        // NOT scaled by densityMul: the gap geometry must stay dodgeable on
        // every rank; density only thickens the beams. The per-firing
        // telegraph reads as an initial `warn` seconds of thin line, then a
        // solid spinning wheel (Kaguya's Brilliant Dragon Barrette).
        const beams = Math.max(1, em.count || 1);
        let a = baseAngle;
        const sweep = em.sweep || 0;
        if (sweep) a += sweep * (em.interval || 0.2) * (em._count || 0);
        const spacing = em.spacing || 8;
        const warn = em.warn !== undefined ? em.warn : 1.5;
        const grp = { solidAt: this.time + warn };
        const baseLife = em.life !== undefined ? em.life : 120;
        const life = Math.max(baseLife, Math.ceil(warn * 60) + baseLife);
        for (let j = 0; j < beams; j++) {
          const aj = a + (j / beams) * TAU;
          const len = em.laserLen !== undefined ? em.laserLen : this._edgeDist(ox, oy, aj) + 30;
          const n = Math.max(1, Math.round((len / spacing) * densityMul));
          for (let i = 0; i < n; i++) {
            const d = i * spacing;
            // minLife = full lifetime: a rotating beam's bullets may start
            // off-screen (e.g. pointing away from the field) and orbit back
            // into view, so off-screen culling must never remove them early.
            // em.minLife can shorten this for non-rotating long beams.
            const extra = {
              r: em.r || 5, color: em._cycColor || em.color || '#ff3333', life,
              minLife: em.minLife !== undefined ? em.minLife : life, laserGroup: grp
            };
            if (sweep) {
              // Orbit the fire origin at fixed radius d, turning `sweep` rad/s.
              Object.assign(extra, {
                type: 'curve', curve: sweep / 60,
                cx: ox, cy: oy, sa: aj, sr: d, cspeed: 0,
              });
            }
            this._add(
              ox + Math.cos(aj) * d, oy + Math.sin(aj) * d,
              aj, speed * 1.6, em, extra,
            );
          }
        }
        break;
      }

      // ── New emitter types (added for the spell-card recreation engine) ──

      case 'volley': {
        // A volley = a set of bullets fired at the SAME time in the SAME
        // direction (aimed at the player) but each with a DIFFERENT speed, so
        // they peel apart into a stretching line. Speeds come from em.speeds
        // (a list, cycled) or are spread across [speedMin, speedMax].
        const speeds = this._volleySpeeds(em, count);
        for (let i = 0; i < count; i++) {
          const sp = speeds[i % speeds.length] * speedMul;
          this._add(ox, oy, baseAngle, sp, em);
        }
        break;
      }
      case 'ringFan': {
        // `count` clusters arranged in a ring around the origin; each cluster
        // is a small K-way fan (em.per) pointing outward. "16 3-fans" =>
        // count=16, per=3. Cluster speeds can vary (em.speeds, cycled) so a
        // companion ring can "ride along with the slowest fan".
        const per = Math.max(1, em.per || 3);
        const cSpread = em.cSpread || 0.35;
        const ringRot = (em.rot || 0) + (em.rotStep || 0) * (em._count || 0);
        const speeds = Array.isArray(em.speeds) && em.speeds.length ? em.speeds : null;
        for (let c = 0; c < count; c++) {
          const ca = ringRot + (c / count) * TAU;
          const sp = (speeds ? speeds[c % speeds.length] : speed) * speedMul;
          for (let k = 0; k < per; k++) {
            const a = ca + (per > 1 ? (k / (per - 1) - 0.5) * cSpread : 0);
            this._add(ox, oy, a, sp, em);
          }
        }
        break;
      }
      case 'arc': {
        // A fan where each bullet banks (curves) in a direction set by which
        // side of the aim line it sits on, and is colored by that side. Makes
        // flocks that scatter outward like birds (Night Bird): left side one
        // way/color, right side the other. With an EVEN count no bullet lands
        // on the aim line; set em.center to add one extra dead-aimed bullet
        // (colorCenter) — "each arc contains one bullet aimed directly at
        // the player".
        const spread = em.spread || 0.8;
        const sideTurn = em.sideTurn || 0.02;
        for (let i = 0; i < count; i++) {
          const off = count > 1 ? (i / (count - 1) - 0.5) : 0; // -0.5..0.5
          const a = baseAngle + off * spread;
          // Bank so the wings open OUTWARD (away from the aim line).
          const turn = -off * (sideTurn * 2);
          let color = em.color;
          if (off < -0.001) color = em.colorLeft || em.color;
          else if (off > 0.001) color = em.colorRight || em.color;
          else color = em.colorCenter || em.color;
          this._add(ox, oy, a, speed, em, { turn, color });
        }
        if (em.center) {
          this._add(ox, oy, baseAngle, speed, em, { color: em.colorCenter || em.color });
        }
        break;
      }
      case 'wall': {
        // A curtain of bullets laid along a line, entering from one edge and
        // sweeping across (tidal waves, rolling curtains). em.side picks the
        // entry edge; the curtain moves perpendicular into the screen.
        // Optional gap: a hole the player threads — em.gapSize px wide at
        // em.gapPos (0..1 along the span); em.gapPosStep shifts the gap per
        // fire so each wave's opening is elsewhere (Kappa's Pororoca).
        // em.cxn/em.cyn center the curtain at a normalized screen point
        // (default: the boss position) so a full-height wall covers the field.
        const spacing = em.spacing || 14;
        const span = em.len || ((em.side === 'left' || em.side === 'right') ? this.H : this.W);
        const n = Math.max(1, Math.round(span / spacing));
        const cx = em.cxn !== undefined ? em.cxn * this.W : null;
        const cy = em.cyn !== undefined ? em.cyn * this.H : null;
        let moveA, ax, ay;
        if (em.side === 'top') { moveA = Math.PI / 2; ax = cx !== null ? cx : ox; ay = -6; }
        else if (em.side === 'bottom') { moveA = -Math.PI / 2; ax = cx !== null ? cx : ox; ay = this.H + 6; }
        else if (em.side === 'left') { moveA = 0; ax = -6; ay = cy !== null ? cy : oy; }
        else { moveA = Math.PI; ax = this.W + 6; ay = cy !== null ? cy : oy; }
        const perp = moveA + Math.PI / 2;
        const hasGap = em.gapSize > 0;
        const gapBase = em.gapPos !== undefined ? em.gapPos : 0.5;
        // Safe modulo: JS % keeps the sign, so a negative gapPosStep would
        // otherwise drift the gap off-span.
        const gapPos = (((gapBase + (em.gapPosStep || 0) * (em._count || 0)) % 1) + 1) % 1;
        const gapCenter = (gapPos - 0.5) * span;
        for (let i = 0; i < n; i++) {
          const d = (i - (n - 1) / 2) * spacing;
          if (hasGap && Math.abs(d - gapCenter) < em.gapSize / 2) continue;
          this._add(ax + Math.cos(perp) * d, ay + Math.sin(perp) * d, moveA, speed, em);
        }
        break;
      }
      case 'edge': {
        // Bullets growing inward from a screen edge (ooze, crystals, creep).
        // Each starts just outside the edge and moves straight into the field.
        const side = em.side || 'bottom';
        const spacing = em.spacing || 16;
        const horizontal = side === 'top' || side === 'bottom';
        const span = horizontal ? this.W : this.H;
        const n = Math.max(1, Math.round(span / spacing));
        for (let i = 0; i < n; i++) {
          const t = (i + 0.5) * (span / n);
          let px, py, a;
          if (side === 'bottom') { px = t; py = this.H + 6; a = -Math.PI / 2; }
          else if (side === 'top') { px = t; py = -6; a = Math.PI / 2; }
          else if (side === 'left') { px = -6; py = t; a = 0; }
          else { px = this.W + 6; py = t; a = Math.PI; }
          this._add(px, py, a, speed, em);
        }
        break;
      }
      case 'column': {
        // Steady falling column(s) of bullets from the top edge at fixed x
        // position(s) — "neat columns" trailing down either side of a beam.
        // em.xs: absolute x positions; em.xn: normalized (0..1) positions.
        const xs = [];
        if (Array.isArray(em.xs)) for (const x of em.xs) xs.push(x);
        if (Array.isArray(em.xn)) for (const xn of em.xn) xs.push(xn * this.W);
        if (!xs.length) xs.push(ox);
        for (const cx of xs) {
          this._add(cx, -6, Math.PI / 2, speed, em); // straight down
        }
        break;
      }
      case 'gap': {
        // Emit a burst from an arbitrary point on screen (Yukari's gaps).
        // Position via em.x/em.y (px) or em.xn/em.yn (normalized 0..1); the
        // burst itself is em.inner (default 'ring'), fired from that point.
        const gx = em.xn !== undefined ? em.xn * this.W : (em.x !== undefined ? em.x : ox);
        const gy = em.yn !== undefined ? em.yn * this.H : (em.y !== undefined ? em.y : oy);
        const inner = Object.assign({}, em);
        delete inner.x; delete inner.y; delete inner.xn; delete inner.yn;
        inner.type = em.inner || 'ring';
        this._emitAt(gx, gy, inner);
        break;
      }
      case 'splash': {
        // A burst from a RANDOM (seeded) position within a region, on every
        // fire — water drips, splashes, foam, and "emergence from nowhere"
        // (Optical/Hydro Camouflage: you can't tell where it came from).
        // Region via xn0/xn1/yn0/yn1 (normalized 0..1) or x0/x1/y0/y1 (px).
        // The burst itself is em.inner (default 'ring'), fired from that point.
        const x0 = em.xn0 !== undefined ? em.xn0 * this.W : (em.x0 !== undefined ? em.x0 : 0);
        const x1 = em.xn1 !== undefined ? em.xn1 * this.W : (em.x1 !== undefined ? em.x1 : this.W);
        const y0 = em.yn0 !== undefined ? em.yn0 * this.H : (em.y0 !== undefined ? em.y0 : 0);
        const y1 = em.yn1 !== undefined ? em.yn1 * this.H : (em.y1 !== undefined ? em.y1 : this.H);
        const sx = this._rndRange(x0, x1);
        const sy = this._rndRange(y0, y1);
        const inner = Object.assign({}, em);
        delete inner.xn0; delete inner.xn1; delete inner.yn0; delete inner.yn1;
        delete inner.x0; delete inner.x1; delete inner.y0; delete inner.y1;
        inner.type = em.inner || 'ring';
        this._emitAt(sx, sy, inner);
        break;
      }
      case 'spawnBullet': {
        // Fire a large hazard bullet that can shed children (spawnEmits every
        // spawnEvery frames) and/or be destroyed by player shots.
        for (let i = 0; i < count; i++) {
          const a = baseAngle + (count > 1 ? (i / (count - 1) - 0.5) * (em.spread || 0.3) : 0);
          this._add(ox, oy, a, speed, em, {
            destructible: true,
            hp: em.hp || 3,
            r: em.r || 10,
            spawnEvery: em.spawnEvery || 0,
            spawnEmits: em.spawnEmits || null,
            deathBurst: em.deathBurst || null,
          });
        }
        break;
      }
      case 'doll': {
        // A destructible shooter entity (Alice's dolls): a big bullet that
        // flies, fires its own pattern repeatedly (em.shoot), and can be shot
        // down to stop it.
        const shoot = em.shoot || { type: 'aimed', count: 3, spread: 0.6, speed: 2.5 };
        const intervalFrames = Math.max(1, Math.round((em.interval || 0.4) * 60));
        for (let i = 0; i < count; i++) {
          const a = baseAngle + (count > 1 ? (i / (count - 1) - 0.5) * (em.spread || 0.5) : 0);
          this._add(ox, oy, a, speed, em, {
            destructible: true,
            hp: em.hp || 5,
            r: em.r || 12,
            shape: em.shape || 'petal',
            spawnEvery: intervalFrames,
            spawnEmits: [Object.assign({ interval: 0 }, shoot)],
            deathBurst: em.deathBurst || null,
          });
        }
        break;
      }
      default: {
        this._add(ox, oy, baseAngle, speed, em);
      }
    }
  }

  // Resolve the per-bullet speeds for a 'volley' emitter (same direction,
  // different speeds). Returns a list of `count` values.
  _volleySpeeds(em, count) {
    if (Array.isArray(em.speeds) && em.speeds.length) return em.speeds;
    const base = em.speed !== undefined ? em.speed : 2;
    const min = em.speedMin !== undefined ? em.speedMin : base * 0.6;
    const max = em.speedMax !== undefined ? em.speedMax : base * 1.4;
    const out = [];
    for (let i = 0; i < count; i++) {
      out.push(count > 1 ? min + (i / (count - 1)) * (max - min) : (min + max) / 2);
    }
    return out;
  }

  // Distance from (x, y) to the nearest screen edge along direction `a`
  // (rad). Used to stretch lasers out to the border of the playfield so they
  // read as infinitely long.
  _edgeDist(x, y, a) {
    const c = Math.cos(a), s = Math.sin(a);
    let d = Infinity;
    if (c > 1e-9) d = Math.min(d, (this.W - x) / c);
    else if (c < -1e-9) d = Math.min(d, -x / c);
    if (s > 1e-9) d = Math.min(d, (this.H - y) / s);
    else if (s < -1e-9) d = Math.min(d, -y / s);
    return d === Infinity ? 0 : d;
  }

  _add(x, y, angle, speed, em, extra = {}) {
    // Cap (raised from 1200: Touhou-style persistent bullets make dense cards
    // like Demarcation legitimately peak above 1200).
    if (this.bullets.length > 2000) return;
    // Per-bullet seeded jitter (Taisei rng_dir / rng_range equivalents):
    // every draw comes from this._rng, so the whole fight is deterministic.
    angle = this._jitterAngle(em, angle);
    speed = this._jitterSpeed(em, speed);
    const color = this._jitterColor(em, em._cycColor || em.color);
    // Optional per-emitter bullet fields (Taisei MoveParams + visuals).
    // Without this passthrough, pattern data could not express acceleration,
    // retention, attraction, speed oscillation, max distance, fades, rainbow
    // cycling, gravity or custom lifetimes — only the few fields listed here.
    const phys = {};
    for (const k of [
      'accelX', 'accelY', 'retention', 'attraction', 'attractPoint', 'attractExp',
      'speedOscAmp', 'speedOscFreq', 'speedOscBase', 'maxDist',
      'fadeIn', 'fadeOut', 'rainbow', 'gravity', 'turn',
      'freeze', 'releaseAngle', 'releaseSpeed', 'life', 'minLife',
      // Hazard + visual fields: let ANY emitter create bullets that shed
      // children (spawnEvery/spawnEmits), can be shot down (destructible/hp),
      // burst on death (deathBurst), or leave a motion trail (trail). This is
      // what lets water "ooze" (falling bubbles that pop) and "cucumbers"
      // (shootable drifting hazards) work from plain edge/column/wall emits.
      'trail', 'spawnEvery', 'spawnEmits', 'spawnCount', 'inheritVel',
      'deathBurst', 'destructible', 'hp', 'maxHp',
    ]) {
      if (em[k] !== undefined) phys[k] = em[k];
    }
    const b = makeBullet(x, y, Math.cos(angle) * speed, Math.sin(angle) * speed, {
      r: em.r, color,
      coreColor: em.coreColor, shape: em.shape, rotSpeed: em.rotSpeed,
      ...phys,
      ...extra,
    });
    this.bullets.push(b);
  }

  // Field freezes (Perfect-Freeze style): at a scheduled time, halt every
  // bullet (recolor white); when the hold elapses, release them with fresh
  // velocities. Driven by phase.freezes = [{t, hold, release:{mode,speed}}].
  _updateFieldFreeze() {
    const phase = this.phases[this.phaseIndex];
    if (!phase || !phase.freezes) return;
    for (const fz of phase.freezes) {
      if (!fz._done && this.phaseTime >= fz.t) {
        fz._done = true;
        this.fieldFreeze = {
          until: fz.t + (fz.hold !== undefined ? fz.hold : 1),
          release: fz.release || { mode: 'random' },
        };
        // Recolor the whole field white while it is frozen.
        for (const b of this.bullets) {
          if (!b.active) continue;
          if (!b._fc) { b._fc = b.color; b._fcc = b.coreColor; }
          b.color = '#ffffff';
          b.coreColor = '#ffffff';
        }
      }
    }
    if (this.fieldFreeze && this.phaseTime >= this.fieldFreeze.until) {
      this._releaseField(this.fieldFreeze.release);
      this.fieldFreeze = null;
    }
  }

  _updateBullets() {
    const p = this.player;
    // Bullets always move at full speed — focus slows the PLAYER, not them.
    // A global FIELD FREEZE (Perfect-Freeze style) halts every bullet at once;
    // while active we skip all motion and recolor the field white.
    const frozen = !!this.fieldFreeze;
    for (const b of this.bullets) {
      if (!b.active) continue;

      // Rotation + rainbow cycling happen regardless of motion state.
      if (b.rotSpeed) b.rot += b.rotSpeed;
      if (b.rainbow) {
        b.hue = (b.hue + 2) % 360;
        b.color = `hsl(${b.hue}, 90%, 62%)`;
        b.coreColor = `hsl(${b.hue}, 90%, 88%)`;
      }

      // Large bullets that shed children (cucumbers, bubbles, shooters).
      if (b.spawnEvery > 0 && !frozen) {
        b.spawnT++;
        if (b.spawnT >= b.spawnEvery) {
          b.spawnT = 0;
          this._fireSpawn(b);
        }
      }

      // Per-bullet freeze (spawn still, then release — optionally re-aimed).
      if (b.freeze > 0) {
        b.freeze--;
        if (b.freeze === 0 && b.releaseAngle !== undefined) {
          const sp = b.releaseSpeed !== undefined ? b.releaseSpeed : Math.hypot(b.vx, b.vy);
          b.vx = Math.cos(b.releaseAngle) * sp;
          b.vy = Math.sin(b.releaseAngle) * sp;
        }
      } else if (!frozen) {
        this._moveBullet(b, p);
      }

      b.life--;
      b.age++;
      // Fade in/out over the bullet's life (pdraw_timeout_scalefade).
      if (b.fadeIn || b.fadeOut) {
        let op = 1;
        if (b.fadeIn) op = Math.min(1, b.age / b.fadeIn);
        if (b.fadeOut) op = Math.min(op, Math.max(0, b.life) / b.fadeOut);
        b.opacity = op;
      }
      // Distance cap from spawn (Taisei max_viewport_dist): some spells only
      // want their bullets to live out to a fixed radius.
      if (b.maxDist && Math.hypot(b.x - b.sx, b.y - b.sy) > b.maxDist) {
        b.active = false;
      }
      if (b.life <= 0) {
        b.active = false;
      } else if (b.x < -20 || b.x > this.W + 20 || b.y < -20 || b.y > this.H + 20) {
        // Off-screen cull — but only after `minLife` frames have passed.
        // Rotating bullets (laser rings) can start off-screen and orbit
        // back into view before their life expires, so they must not be
        // culled early. minLife === life means "never cull while alive".
        if (!b.minLife || b.age >= b.minLife) b.active = false;
      }
    }
    // Remove inactive bullets (in-place).
    if (this.bullets.some(b => !b.active)) {
      this.bullets = this.bullets.filter(b => b.active);
    }
  }

  // Apply one frame of motion to a bullet, honoring its script / type /
  // banking / gravity. This is the single place where a bullet's position
  // changes, so every movement flavor funnels through here.
  _moveBullet(b, p) {
    // Staged trajectory: walk an ordered list of motion segments.
    if (b.script && b.script.length) {
      const st = b.script[b.scriptIndex];
      if (!st) return; // script exhausted: hold position
      if (b.scriptT === 0) this._enterStage(b, st, p);
      switch (st.mode) {
        case 'hold': break;            // v zeroed at entry; stay put
        case 'aim': break;             // v set toward player at entry; fly straight
        case 'homing': this._homingStep(b, p, st.turn || b.turn || 0.05); break;
        case 'spin': this._bank(b, st.turn || b.turn || 0.04); break;
        case 'gravity': b.vy += (st.gravity !== undefined ? st.gravity : (b.gravity || 0.12)); break;
        default: break;                // 'fly': keep current velocity
      }
      b.x += b.vx;
      b.y += b.vy;
      b.scriptT++;
      if (b.scriptT >= st.dur) { b.scriptIndex++; b.scriptT = 0; }
      return;
    }

    // General physics mode (Taisei MoveParams equivalent): active when any of
    // accel / retention(!=1) / attraction is set. Integrates exactly like
    // taisei/src/move.c::move_update:
    //   pos += vel
    //   vel = accel + retention * vel
    //   vel += attraction * (point - pos)          [exp == 1]
    //   vel += attraction * (point - pos) * |d|^(exp-1)   [exp != 1]
    // This one model covers move_linear, move_accelerated,
    // move_asymptotic(_simple/_halflife), move_towards(_exp), move_dampen,
    // move_stop — so any Taisei spell translates directly.
    const hasPhysics = b.accelX || b.accelY || b.retention !== 1 || b.attraction || b.speedOscAmp;
    if (hasPhysics) {
      const osc = b.speedOscAmp
        ? (b.speedOscBase + b.speedOscAmp * Math.sin(b.speedOscFreq * b.oscT))
        : 1;
      b.oscT++;
      b.x += b.vx * osc;
      b.y += b.vy * osc;
      b.vx = b.accelX + b.retention * b.vx;
      b.vy = b.accelY + b.retention * b.vy;
      if (b.attraction) {
        const pt = this._resolveAttract(b, p);
        const ax = pt.x - b.x, ay = pt.y - b.y;
        let mul = b.attraction;
        if (b.attractExp !== 1) {
          const d = Math.hypot(ax, ay);
          if (d > 0) mul *= Math.pow(d, b.attractExp - 1);
        }
        b.vx += mul * ax;
        b.vy += mul * ay;
      }
      return;
    }

    if (b.type === 'homing' && p.alive) {
      this._homingStep(b, p, b.turn || 0.05);
      b.x += b.vx;
      b.y += b.vy;
    } else if (b.type === 'curve') {
      // Expanding spiral: the bearing turns by `curve` rad/frame while the
      // radius from the spawn point grows by `cspeed` px/frame. (Rotating
      // the velocity alone would just orbit the boss in a circle.)
      b.sa += b.curve;
      b.sr += b.cspeed;
      const nx = b.cx + Math.cos(b.sa) * b.sr;
      const ny = b.cy + Math.sin(b.sa) * b.sr;
      // Keep vx/vy as the ACTUAL per-frame displacement so the bullet's
      // heading (rice orientation, motion trails) follows the orbit instead
      // of pointing along the frozen spawn direction.
      b.vx = nx - b.x;
      b.vy = ny - b.y;
      b.x = nx;
      b.y = ny;
    } else {
      if (b.turn) this._bank(b, b.turn);   // constant banking arc
      if (b.gravity) b.vy += b.gravity;    // icicle / parabolic fall
      b.x += b.vx;
      b.y += b.vy;
    }
  }

  // Steer a bullet toward the player by at most `turn` rad this frame.
  _homingStep(b, p, turn) {
    const desired = Math.atan2(p.y - b.y, p.x - b.x);
    let cur = Math.atan2(b.vy, b.vx);
    let diff = desired - cur;
    while (diff > Math.PI) diff -= TAU;
    while (diff < -Math.PI) diff += TAU;
    const t = Math.max(-turn, Math.min(turn, diff));
    const spd = Math.hypot(b.vx, b.vy);
    cur += t;
    b.vx = Math.cos(cur) * spd;
    b.vy = Math.sin(cur) * spd;
  }

  // Rotate a bullet's velocity by a fixed `turn` rad (a banking arc).
  _bank(b, turn) {
    const cur = Math.atan2(b.vy, b.vx);
    const spd = Math.hypot(b.vx, b.vy);
    const nc = cur + turn;
    b.vx = Math.cos(nc) * spd;
    b.vy = Math.sin(nc) * spd;
  }

  // Enter a motion-script stage: do its one-time setup (zero v for 'hold',
  // aim at the player for 'aim', perpendicular drift for 'tangent').
  _enterStage(b, st, p) {
    switch (st.mode) {
      case 'hold':
        b.vx = 0;
        b.vy = 0;
        break;
      case 'aim': {
        // Capture the player's position ONCE at entry (not homing).
        const sp = st.speed !== undefined ? st.speed : (Math.hypot(b.vx, b.vy) || 2);
        const a = Math.atan2(p.y - b.y, p.x - b.x);
        b.vx = Math.cos(a) * sp;
        b.vy = Math.sin(a) * sp;
        break;
      }
      case 'tangent': {
        // Drift perpendicular to the radius from the SPAWN point (the ring
        // center). dir=+1 => left of the radial direction (-ry, rx);
        // dir=-1 => right (ry, -rx). Used by Demarcation's rings, which
        // "turn perpendicular" after expanding.
        const rx = b.x - b.sx, ry = b.y - b.sy;
        const d = Math.hypot(rx, ry) || 1;
        const s = st.speed !== undefined ? st.speed : 1;
        const dir = st.dir || 1;
        b.vx = (-ry / d) * s * dir;
        b.vy = (rx / d) * s * dir;
        break;
      }
      default:
        break;
    }
  }

  // Fire a large bullet's child emitters from its current position.
  _fireSpawn(b) {
    const emits = b.spawnEmits;
    if (!emits) return;
    // Cap the number of shed bursts (spawnCount > 0): after this many, the
    // hazard keeps drifting but stops shedding (e.g. a cucumber that has
    // spent its seeds still rolls across the field).
    if (b.spawnCount > 0 && b.spawnN >= b.spawnCount) return;
    b.spawnN++;
    const before = this.bullets.length;
    for (const em of (Array.isArray(emits) ? emits : [emits])) {
      this._emitAt(b.x, b.y, em);
    }
    // Children inherit the parent's drift (moving shooters): the shed bullets
    // keep the hazard's own velocity, so a drifting cucumber carries its spray.
    if (b.inheritVel) {
      for (let i = before; i < this.bullets.length; i++) {
        const c = this.bullets[i];
        c.vx += b.vx;
        c.vy += b.vy;
      }
    }
  }

  // ── Seeded randomness (the ONLY randomness in the engine) ──────────────
  // Emitters can request per-bullet jitter (rng_dir / rng_range equivalents):
  //   speedJitter:  ± fraction of speed (e.g. 0.5 => 0.5x..1.5x)
  //   angleJitter:  ± radians
  //   colorJitter:  hue spread around the base color (hex -> hsl)
  // All draws come from this._rng, so a fight is fully deterministic.
  _rnd() { return this._rng(); }
  _rndRange(min, max) { return min + (max - min) * this._rng(); }
  _rndAngle() { return this._rng() * TAU; }
  _jitterSpeed(em, base) {
    if (!em.speedJitter) return base;
    return base * (1 + (this._rng() * 2 - 1) * em.speedJitter);
  }
  _jitterAngle(em, base) {
    if (!em.angleJitter) return base;
    return base + (this._rng() * 2 - 1) * em.angleJitter;
  }
  // Resolve a bullet's attraction point: 'player' | 'boss' | {x,y} | [x,y].
  _resolveAttract(b, p) {
    const pt = b.attractPoint;
    if (pt === 'player') return { x: p.x, y: p.y };
    if (pt === 'boss') return { x: this.boss.x, y: this.boss.y };
    if (Array.isArray(pt)) return { x: pt[0], y: pt[1] };
    if (pt && typeof pt === 'object') return pt;
    return { x: this.boss.x, y: this.boss.y };
  }

  _jitterColor(em, base) {
    if (!em.colorJitter || !base || typeof base !== 'string' || base[0] !== '#') return base;
    // hex -> hsl-ish shift: parse rgb, rotate hue by ±colorJitter degrees.
    const n = parseInt(base.slice(1), 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const mx = Math.max(r, g, b) / 255, mn = Math.min(r, g, b) / 255;
    const l = (mx + mn) / 2;
    let h = 0, s = 0;
    if (mx !== mn) {
      const d = mx - mn;
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      if (r === mx * 255) h = (g - b) / d + (g < b ? 6 : 0);
      else if (g === mx * 255) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    h = (h + (this._rng() * 2 - 1) * em.colorJitter + 360) % 360;
    return `hsl(${h.toFixed(0)}, ${(s * 100).toFixed(0)}%, ${(l * 100).toFixed(0)}%)`;
  }

  // Release a field-frozen set of bullets: give each a fresh velocity.
  _releaseField(rel) {
    const p = this.player;
    for (const b of this.bullets) {
      if (!b.active) continue;
      const s = rel.speed !== undefined ? rel.speed : 2;
      let a;
      if (rel.mode === 'aim') a = Math.atan2(p.y - b.y, p.x - b.x);
      else if (rel.mode === 'outward') a = Math.atan2(b.y - this.boss.y, b.x - this.boss.x);
      else a = this._rndAngle(); // 'random' (default) — seeded
      b.vx = Math.cos(a) * s;
      b.vy = Math.sin(a) * s;
      // Restore the pre-freeze colors.
      if (b._fc) { b.color = b._fc; b.coreColor = b._fcc; b._fc = null; }
    }
  }

  // Player auto-fire: fire the piece's signature pattern upward, move the
  // shots (homing/curve/rotation), and damage the current spell card on boss
  // contact. Breaking the card's HP gauge ends it early.
  _updateShots() {
    if (this.result) return;
    const p = this.player;
    const b = this.boss;
    const S = this.shotPattern;
    if (!S) return;

    // Laser (Marisa): a continuous beam straight up from the ship, not a
    // stream of bullets. The beam does most of the damage: while it overlaps
    // the boss it deals damage every frame. She also always fires star shots
    // spread at angles around straight-up, so she still lands hits when the
    // boss is not directly overhead (where the beam is off-axis).
    if (S.type === 'laser' && p.alive && this.phaseMaxHp > 0) {
      const halfW = (S.width || 8) / 2;
      if (b.y < p.y && Math.abs(b.x - p.x) < CONFIG.BOSS_HITBOX + halfW) {
        this.phaseHp -= S.damage;
        if (this.phaseHp < 0) this.phaseHp = 0;
        this.score += S.damage * 10; // same 10 points per damage as bullets
      }
      if (this.frame % (S.starInterval || 12) === 0) {
        sfxPlay('fire');
        const n = S.starCount || 2;
        const spread = S.starSpread || 0.9;
        for (let i = 0; i < n; i++) {
          const a = n > 1
            ? -Math.PI / 2 + (i / (n - 1) - 0.5) * spread
            : -Math.PI / 2;
          this.playerShots.push({
            x: p.x,
            y: p.y - 10,
            vx: Math.cos(a) * (S.starSpeed || 10),
            vy: Math.sin(a) * (S.starSpeed || 10),
            r: S.starR || 4,
            color: S.starColor || S.color,
            coreColor: '#ffffff',
            shape: 'star',
            type: 'normal',
            damage: S.starDamage || 1,
            rot: 0,
            rotSpeed: S.starRotSpeed || 0.15,
            active: true,
          });
        }
      }
    }

    // Fire (auto). The laser pattern fires its own stars above.
    if (S.type !== 'laser' && p.alive && this.phaseMaxHp > 0 && this.frame % S.interval === 0) {
      sfxPlay('fire');
      const baseAngle = -Math.PI / 2; // straight up
      for (let i = 0; i < S.count; i++) {
        const a = S.count > 1
          ? baseAngle + (i / (S.count - 1) - 0.5) * S.spread
          : baseAngle;
        this.playerShots.push({
          x: p.x,
          y: p.y - 10,
          vx: Math.cos(a) * S.speed,
          vy: Math.sin(a) * S.speed,
          r: S.r,
          color: S.color,
          coreColor: '#ffffff',
          shape: S.shape || 'circle',
          type: S.type || 'normal',
          turn: S.turn || 0,
          curve: S.curve || 0,
          rot: 0,
          rotSpeed: S.rotSpeed || 0,
          active: true,
        });
      }
    }

    // Move + collide with the boss.
    for (const s of this.playerShots) {
      if (!s.active) continue;
      if (s.type === 'homing') {
        const desired = Math.atan2(b.y - s.y, b.x - s.x);
        let cur = Math.atan2(s.vy, s.vx);
        let diff = desired - cur;
        while (diff > Math.PI) diff -= TAU;
        while (diff < -Math.PI) diff += TAU;
        const turn = Math.max(-s.turn, Math.min(s.turn, diff));
        const spd = Math.hypot(s.vx, s.vy);
        cur += turn;
        s.vx = Math.cos(cur) * spd;
        s.vy = Math.sin(cur) * spd;
      }
      if (s.type === 'curve') {
        const cur = Math.atan2(s.vy, s.vx);
        const spd = Math.hypot(s.vx, s.vy);
        const newCur = cur + s.curve;
        s.vx = Math.cos(newCur) * spd;
        s.vy = Math.sin(newCur) * spd;
      }
      if (s.rotSpeed) s.rot += s.rotSpeed;
      s.x += s.vx;
      s.y += s.vy;
      if (s.y < -20 || s.x < -20 || s.x > this.W + 20 || s.y > this.H + 20) {
        s.active = false;
        continue;
      }
      // Destructible bullets (shooting hazards / dolls): shots damage them;
      // at 0 hp they vanish and fire their deathBurst if any.
      for (const eb of this.bullets) {
        if (!eb.active || !eb.destructible) continue;
        if (Math.hypot(s.x - eb.x, s.y - eb.y) < eb.r + s.r) {
          s.active = false;
          // Per-shot damage (Marisa's stars carry their own) falls back to
          // the pattern's damage for ordinary patterns.
          eb.hp -= s.damage || S.damage || 1;
          if (eb.hp <= 0) {
            eb.active = false;
            this.score += 500;
            if (eb.deathBurst) this._emitAt(eb.x, eb.y, eb.deathBurst);
          }
          break;
        }
      }
      if (!s.active) continue;
      if (Math.hypot(s.x - b.x, s.y - b.y) < CONFIG.BOSS_HITBOX + s.r) {
        s.active = false;
        this.phaseHp -= s.damage || S.damage || 1;
        if (this.phaseHp < 0) this.phaseHp = 0;
        this.score += 10;
      }
    }
    if (this.playerShots.some(s => !s.active)) {
      this.playerShots = this.playerShots.filter(s => s.active);
    }
  }

  _checkCollisions() {
    const p = this.player;
    if (!p.alive) return;
    // Hitbox RADIUS. The config value is a diameter and the rendered dot uses
    // hb/2, so collision must use the same radius or the hitbox is 2x the size
    // of what's visible.
    const hb = (p.focus ? p.focusHitbox : p.hitbox) / 2;
    for (const b of this.bullets) {
      if (!b.active) continue;
      // Laser telegraph: while the beam is still its thin warning line it
      // neither hits nor grazes.
      if (b.laserGroup && this.time < b.laserGroup.solidAt) continue;
      const dx = b.x - p.x;
      const dy = b.y - p.y;
      const dist = Math.hypot(dx, dy);
      // Graze: bullet passes near but doesn't hit.
      if (!b.grazed && dist < hb + b.r + 10 && dist > hb + b.r) {
        b.grazed = true;
        this.graze++;
        this.score += 100;
        this.bombGauge = Math.min(1, this.bombGauge + 0.02);
        sfxPlay('graze');
      }
      // Hit.
      if (p.invuln <= 0 && dist < hb + b.r) {
        this._hitPlayer();
        b.active = false;
      }
    }
  }

  // ── Phase-level persistent beams (Moonlight Ray / taisei lasers) ────────
  // A phase can declare `beams: [{t, dur, x|xn, width, y0, y1, angle,
  // color, coreColor, unclearable, warn}]`. Each is a laser ray that exists
  // for its time window and damages the player on contact, just like a
  // bullet. Beams are one-way RAYS: they start at their pivot and extend
  // forward (toward the segment's y1 end) well past every screen edge —
  // never backwards behind the shooter — so the player can't slip around
  // the end of one. Beams are solid immediately by default (sweeping, non-aimed
  // beams like Moonlight Ray's moonbeams need no warning); set `warn` (sec)
  // on a beam that aims at the player to make it telegraph first as a thin
  // pulsing line that does no damage and grants no graze.
  // `unclearable` beams survive bombs (taisei l->unclearable).
  _activeBeams() {
    const phase = this.phases[this.phaseIndex];
    if (!phase || !phase.beams) return [];
    const out = [];
    for (const bm of phase.beams) {
      if (bm._cleared) continue;
      const t0 = bm.t || 0;
      if (this.phaseTime < t0) continue;
      if (bm.period) {
        // Repeating window: active during [t0 + k*period, t0 + k*period + dur]
        // (EoSD Moonlight Ray: beams sweep for 2s, rest for 1s, repeat).
        const cyc = (this.phaseTime - t0) % bm.period;
        if (cyc >= (bm.dur || Infinity)) continue;
      } else {
        const t1 = bm.dur ? t0 + bm.dur : Infinity;
        if (this.phaseTime >= t1) continue;
      }
      out.push(bm);
    }
    return out;
  }

  _updateBeams() {
    const p = this.player;
    if (!p.alive) return;
    const hb = (p.focus ? p.focusHitbox : p.hitbox) / 2;
    for (const bm of this._activeBeams()) {
      if (this._beamInWarn(bm)) continue; // thin telegraph line: no damage, no graze
      const d = this._beamDist(bm, p.x, p.y);
      const halfW = (bm.width || 40) / 2;
      if (!bm._grazed && d < halfW + hb + 10 && d > halfW + hb) {
        bm._grazed = true;
        this.graze++;
        this.score += 100;
        this.bombGauge = Math.min(1, this.bombGauge + 0.02);
        sfxPlay('graze');
      } else if (d > halfW + hb + 14) {
        bm._grazed = false; // re-arm graze once clear
      }
      if (p.invuln <= 0 && d < halfW + hb) {
        this._hitPlayer();
      }
    }
  }

  // Effective beam angle at the current phase time. `bm.sweep` (rad/s) adds
  // a constant rotation rate starting at bm.t — a searchlight-style sweeping
  // beam (Danmakufu laser-sweep patterns). Collision and drawing must agree.
  _beamAngle(bm) {
    let dt = this.phaseTime - (bm.t || 0);
    if (bm.period && dt >= 0) dt = dt % bm.period; // restart the sweep each cycle
    return (bm.angle || 0) + (bm.sweep ? bm.sweep * dt : 0);
  }
  // Beam geometry: a RAY starting at the PIVOT and extending in ONE
  // direction — toward the segment's y1 end (local +y) or away from it
  // (local -y) — rotated by _beamAngle. y0/y1 no longer cap the beam
  // length; they only select the pivot point and the ray's direction:
  // default pivot is the midpoint of the field; 'top' / 'bottom' pivot at
  // y0 / y1 — EoSD lasers are rays anchored at the shooter (Moonlight Ray's
  // beams sweep from the boss, never through the field center), so the
  // beam must not extend backwards behind the shooter.
  _beamGeom(bm) {
    const x = bm.xn !== undefined ? bm.xn * this.W : (bm.x !== undefined ? bm.x : this.W / 2);
    const y0 = bm.y0 !== undefined ? bm.y0 : -10;
    const y1 = bm.y1 !== undefined ? bm.y1 : this.H + 10;
    const py = bm.pivot === 'top' ? y0 : bm.pivot === 'bottom' ? y1 : (y0 + y1) / 2;
    const dir = y1 >= y0 ? 1 : -1; // ray direction along the local axis
    return { px: x, py, dir };
  }
  // Length used to draw/extend a ray past its pivot — just needs to cover
  // the whole field at any rotation angle.
  _rayLen() { return Math.hypot(this.W, this.H) + 40; }
  _beamDist(bm, px, py) {
    const g = this._beamGeom(bm);
    let lx = px - g.px, ly = py - g.py;
    const ang = this._beamAngle(bm);
    if (ang) {
      const c = Math.cos(-ang), s = Math.sin(-ang);
      const nx = lx * c - ly * s;
      const ny = lx * s + ly * c;
      lx = nx; ly = ny;
    }
    // Ray, not line: points behind the pivot are outside the beam, so their
    // distance falls back to the distance to the pivot itself.
    if (g.dir * ly < 0) return Math.hypot(lx, ly);
    return Math.abs(lx);
  }
  // Time since the beam's current active window began (for repeating windows,
  // the start of the current cycle's on-phase).
  _beamAge(bm) {
    const t0 = bm.t || 0;
    if (bm.period) {
      const cyc = (this.phaseTime - t0) % bm.period;
      return cyc;
    }
    return this.phaseTime - t0;
  }
  // Warning (telegraph) phase: for the first `warn` seconds of each active
  // window the beam is a thin, harmless line (EoSD telegraphs aimed lasers
  // before they grow). Default 0 (solid immediately — sweeping beams that
  // don't aim at the player need no warning); opt in via bm.warn.
  _beamInWarn(bm) {
    const warn = bm.warn !== undefined ? bm.warn : 0;
    // Epsilon: phaseTime is a float accumulation, so a beam exactly at its
    // warn boundary must count as solid, not still-warning.
    return this._beamAge(bm) < warn - 1e-6;
  }

  _hitPlayer() {
    const p = this.player;
    // Deathbomb window: if this hit would kill the player AND they have bombs,
    // open an 8-frame grace window where they can press bomb to negate the
    // death. The player stays at their current life count during the window
    // (lives are NOT decremented yet) so they can still move and act.
    if (p.lives <= 1 && p.bombs > 0 && this.deathbombTimer === 0) {
      this.deathbombTimer = CONFIG.DEATHBOMB_FRAMES;
      p.invuln = CONFIG.DEATHBOMB_FRAMES; // brief invuln to prevent multi-hit
      this.shake = 8;
      sfxPlay('hit');
      // Clear nearby bullets on hit (a small mercy).
      for (const b of this.bullets) {
        if (Math.hypot(b.x - p.x, b.y - p.y) < 60) b.active = false;
      }
      return; // don't decrement lives yet — deathbomb window is open
    }
    // Normal hit: decrement lives and grant invulnerability.
    p.lives--;
    p.invuln = 90; // 1.5s invulnerability
    this.shake = 12;
    sfxPlay('hit');
    // Clear nearby bullets on hit (a small mercy).
    for (const b of this.bullets) {
      if (Math.hypot(b.x - p.x, b.y - p.y) < 60) b.active = false;
    }
    if (p.lives <= 0) {
      p.alive = false;
      this._end('lose');
    }
  }

  // Tick the deathbomb timer. Called each frame from update(). If the timer
  // expires without a bomb, the player actually dies (lives are decremented
  // and the fight ends). The timer is also cleared if the player bombs
  // successfully (handled in bomb()).
  _updateDeathbomb() {
    if (this.deathbombTimer <= 0) return;
    this.deathbombTimer--;
    if (this.deathbombTimer <= 0) {
      // Window expired without a bomb — the death goes through.
      const p = this.player;
      p.lives--;
      this.shake = 15;
      if (p.lives <= 0) {
        p.alive = false;
        this._end('lose');
      }
    }
  }

  bomb() {
    const p = this.player;
    if (!p.alive || p.bombs <= 0) return;
    const phase = this.phases[this.phaseIndex];
    if (phase && phase.noBombs) return; // bombs disabled this phase (e.g. Kaguya Last Spell)
    const isDeathbomb = this.deathbombTimer > 0;
    // Normal bombs require a full gauge for extra bombs; deathbombs bypass
    // this check (the player earned the grace by being on their last life).
    if (!isDeathbomb && this.bombGauge < 1 && p.bombs > 1) return;
    sfxPlay('bomb');
    p.bombs--;
    this.bombGauge = 0;
    // Cancel the deathbomb window if active.
    if (isDeathbomb) {
      this.deathbombTimer = 0;
      this.score += 2000; // bonus for a successful deathbomb
    }
    // Bomb clears all bullets and gives brief invulnerability.
    for (const b of this.bullets) b.active = false;
    // ...and any bombable beams (unclearable ones persist through bombs).
    if (phase && phase.beams) {
      for (const bm of phase.beams) if (!bm.unclearable) bm._cleared = true;
    }
    p.invuln = 120;
    this.score += 1000;
    this.shake = 8;
  }

  _end(result) {
    if (this.result) return;
    this.result = result;
    this.running = false;
    // The last card's stats end here too.
    this._finalizePhase(this.phaseIndex);
    // Release any held keys so they can't carry into the next fight.
    this.keys = {};
    if (this.player) this.player.focus = false;
    sfxPlay(result === 'win' ? 'win' : 'lose');
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    this.onEnd(result);
  }

  render() {
    const ctx = this.ctx;
    ctx.save();
    // Screen shake.
    if (this.shake > 0) {
      ctx.translate((this._rnd() - 0.5) * this.shake, (this._rnd() - 0.5) * this.shake);
      this.shake *= 0.9;
      if (this.shake < 0.5) this.shake = 0;
    }
    // Background.
    ctx.fillStyle = this.boss.bg || '#0a0a1a';
    ctx.fillRect(0, 0, this.W, this.H);
    this._drawBackground(ctx);

    // Player shots.
    for (const s of this.playerShots) {
      if (!s.active) continue;
      this._drawBullet(ctx, s);
    }

    // Player.
    this._drawPlayer(ctx);


    // Boss.
    this._drawBoss(ctx);

    // Bullets.
    for (const b of this.bullets) {
      if (!b.active) continue;
      this._drawBullet(ctx, b);
    }

    // Phase-level persistent beams (drawn over bullets, under the player).
    this._drawBeams(ctx);

    // Player laser beam (continuous; the laser pattern emits no bullets).
    const S = this.shotPattern;
    if (S && S.type === 'laser' && this.player.alive && !this.result && this.phaseMaxHp > 0) {
      const w = S.width || 8;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(this.player.x, this.player.y - 10);
      ctx.lineTo(this.player.x, 0);
      ctx.globalAlpha = 0.3;
      ctx.strokeStyle = S.color;
      ctx.lineWidth = w * 2.2;
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = w * 0.45;
      ctx.stroke();
      ctx.restore();
    }

    // Deathbomb window overlay: a pulsing red vignette that intensifies as
    // the window shrinks, signaling the urgency to press bomb. The flash
    // frequency increases toward the end to heighten tension.
    if (this.deathbombTimer > 0) {
      const t = this.deathbombTimer / CONFIG.DEATHBOMB_FRAMES; // 1 → 0
      const pulse = 0.15 + 0.25 * Math.sin(this.frame * 0.8) * t;
      ctx.save();
      // Red radial vignette: bright center fade, heavier at edges.
      const grad = ctx.createRadialGradient(
        this.W / 2, this.H / 2, this.W * 0.2,
        this.W / 2, this.H / 2, this.W * 0.7,
      );
      grad.addColorStop(0, 'rgba(255,0,0,0)');
      grad.addColorStop(1, `rgba(255,0,0,${pulse})`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, this.W, this.H);
      ctx.restore();
    }

    ctx.restore();
  }

  // Draw the active phase-level beams: a soft outer glow, a solid body
  // (the collision width), and a bright core stripe — each a one-way ray
  // from its pivot (never backwards). During the warning phase the beam is
  // a thin pulsing telegraph ray instead.
  _drawBeams(ctx) {
    const R = this._rayLen();
    for (const bm of this._activeBeams()) {
      const g = this._beamGeom(bm);
      const w = bm.width || 40;
      const color = bm.color || '#fff8c0';
      const core = bm.coreColor || '#ffffff';
      ctx.save();
      ctx.translate(g.px, g.py);
      const ang = this._beamAngle(bm);
      if (ang) ctx.rotate(ang);
      const top = g.dir === 1 ? 0 : -R; // ray extends forward from the pivot only
      if (this._beamInWarn(bm)) {
        // Telegraph: thin pulsing ray, no hitbox yet.
        const pulse = 0.55 + 0.45 * Math.sin(this.phaseTime * 12);
        ctx.globalAlpha = pulse;
        ctx.fillStyle = color;
        ctx.fillRect(-1.5, top, 3, R);
        ctx.restore();
        continue;
      }
      // Outer glow (wider than the hitbox — visual only).
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = color;
      ctx.fillRect(-w, top, w * 2, R);
      // Body (matches the collision width).
      ctx.globalAlpha = 0.8;
      ctx.fillRect(-w / 2, top, w, R);
      // Bright core.
      ctx.globalAlpha = 1;
      ctx.fillStyle = core;
      ctx.fillRect(-w * 0.18, top, w * 0.36, R);
      ctx.restore();
    }
  }

  // Render a bullet with a soft glow + bright core, and an optional shape.
  _drawBullet(ctx, b) {
    // Laser telegraph: while the beam is still warning it renders as a thin
    // line (and is disabled in _checkCollisions); once solid it draws full.
    const r = (b.laserGroup && this.time < b.laserGroup.solidAt) ? b.r * 0.25 : b.r;
    const color = b.color || '#ff5555';
    const shape = b.shape || 'circle';
    const op = b.opacity !== undefined ? b.opacity : 1;
    // Motion trail (comet tail) behind fast bullets.
    if (b.trail) {
      const spd = Math.hypot(b.vx, b.vy);
      if (spd > 0.5) {
        const k = Math.min(14, 6 + spd * 1.5); // tail length (frames of motion)
        ctx.save();
        ctx.globalAlpha = 0.35 * op;
        ctx.strokeStyle = color;
        ctx.lineWidth = r * 1.3;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(b.x - b.vx * k, b.y - b.vy * k);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.restore();
      }
    }
    // Fast path for plain circles (no save/restore/rotate).
    if (shape === 'circle' && !b.rot) {
      ctx.globalAlpha = 0.3 * op;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(b.x, b.y, r * 1.9, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = op;
      ctx.fillStyle = b.coreColor || '#ffffff';
      ctx.beginPath();
      ctx.arc(b.x, b.y, r * 0.7, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 1;
      return;
    }
    ctx.save();
    ctx.translate(b.x, b.y);
    if (shape === 'rice') {
      // Rice grains always point along their direction of travel (the
      // ellipse is elongated along local +Y, hence -PI/2). Stationary
      // bullets fall back to b.rot.
      const spd = Math.hypot(b.vx, b.vy);
      if (spd > 0.01) ctx.rotate(Math.atan2(b.vy, b.vx) - Math.PI / 2);
      else if (b.rot) ctx.rotate(b.rot);
    } else if (b.rot) ctx.rotate(b.rot);
    ctx.globalAlpha = 0.3 * op;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.9, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = op;
    ctx.fillStyle = b.coreColor || '#ffffff';
    switch (shape) {
      case 'star': this._pathStar(ctx, r); break;
      case 'petal': this._pathPetal(ctx, r); break;
      case 'cross': this._pathCross(ctx, r); break;
      case 'diamond': this._pathDiamond(ctx, r); break;
      case 'rice': this._pathRice(ctx, r); break;
      default: ctx.beginPath(); ctx.arc(0, 0, r * 0.7, 0, TAU);
    }
    ctx.fill();
    ctx.restore();
  }

  _pathStar(ctx, r) {
    const n = 4, outer = r * 1.15, inner = r * 0.45;
    ctx.beginPath();
    for (let i = 0; i < n * 2; i++) {
      const rad = i % 2 === 0 ? outer : inner;
      const a = (i / (n * 2)) * TAU - Math.PI / 2;
      const x = Math.cos(a) * rad, y = Math.sin(a) * rad;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  _pathPetal(ctx, r) {
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 0.5, r * 1.25, 0, 0, TAU);
  }

  _pathCross(ctx, r) {
    const t = r * 0.42;
    ctx.beginPath();
    ctx.rect(-t, -r * 1.1, t * 2, r * 2.2);
    ctx.rect(-r * 1.1, -t, r * 2.2, t * 2);
  }

  _pathDiamond(ctx, r) {
    ctx.beginPath();
    ctx.moveTo(0, -r * 1.25);
    ctx.lineTo(r * 0.8, 0);
    ctx.lineTo(0, r * 1.25);
    ctx.lineTo(-r * 0.8, 0);
    ctx.closePath();
  }

  _pathRice(ctx, r) {
    // Elongated grain shape (Touhou-style rice bullet).
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 0.35, r * 1.1, 0, 0, TAU);
  }

  _drawBackground(ctx) {
    // Simple per-boss tinted gradient + subtle stars. A phase may override
    // the boss's palette (each Rumia card has its own sky).
    const ph = this.phases[this.phaseIndex];
    const g = ctx.createLinearGradient(0, 0, 0, this.H);
    g.addColorStop(0, (ph && ph.bgTop) || this.boss.bgTop || '#141428');
    g.addColorStop(1, (ph && ph.bgBottom) || this.boss.bgBottom || '#05050c');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.W, this.H);
  }

  _drawBoss(ctx) {
    const b = this.boss;
    const pulse = 1 + Math.sin(this.time * 3) * 0.08;
    ctx.save();
    ctx.translate(b.x, b.y);
    // Aura behind the boss.
    const grad = ctx.createRadialGradient(0, 0, 5, 0, 0, 55 * pulse);
    grad.addColorStop(0, b.color || '#ffffff');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, 55 * pulse, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;
    // Boss sprite (the same character art used on the board). Falls back to
    // a colored orb if the sprite is missing.
    const bob = Math.sin(this.time * 2) * 3;
    if (b.charId && typeof drawCharacter === 'function' && drawCharacter(ctx, b.charId, -55, -55 + bob, 1.1)) {
      // drawn
    } else {
      ctx.fillStyle = b.color || '#ffffff';
      ctx.beginPath();
      ctx.arc(0, 0, 18 * pulse, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  _drawPlayer(ctx) {
    const p = this.player;
    if (!p.alive) return;
    // Blink during invulnerability.
    if (p.invuln > 0 && Math.floor(this.frame / 4) % 2 === 0) return;
    ctx.save();
    ctx.translate(p.x, p.y);
    // Player ship: the protagonist's character sprite (same art as the
    // board piece). Falls back to a triangle if the sprite is missing.
    const ok = this.playerChar && typeof drawCharacter === 'function'
      ? drawCharacter(ctx, this.playerChar, -26, -26, 0.52)
      : false;
    if (!ok) {
      ctx.fillStyle = this.playerColor || '#ff5577';
      ctx.beginPath();
      ctx.moveTo(0, -12);
      ctx.lineTo(9, 10);
      ctx.lineTo(0, 5);
      ctx.lineTo(-9, 10);
      ctx.closePath();
      ctx.fill();
    }
    // Hitbox (red dot) — always clearly visible, Touhou-style. The dot
    // tracks the hitbox size but never shrinks below a visible 3px, so
    // focusing reads as "slightly smaller" rather than the dot vanishing.
    const hb = p.focus ? p.focusHitbox : p.hitbox;
    ctx.fillStyle = '#ff0000';
    ctx.beginPath();
    ctx.arc(0, 0, Math.max(3, hb / 2), 0, TAU);
    ctx.fill();
    ctx.restore();
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DanmakuEngine, makeBullet, TAU };
}
