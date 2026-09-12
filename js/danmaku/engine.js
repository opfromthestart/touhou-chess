// engine.js — the danmaku (bullet-hell) engine.
// Fixed-timestep 60fps loop on a portrait canvas. Player ship with lives/bombs/
// hitbox/focus, a pooled bullet system, collision + graze, and a data-driven
// pattern engine. Each boss fight is a sequence of phases (spell cards).

const TAU = Math.PI * 2;

// Play a sound effect if the SFX module is loaded (it no-ops when disabled or
// unavailable — e.g. in Node tests).
function sfxPlay(name) {
  if (typeof SFX !== 'undefined' && SFX) SFX.play(name);
}

// Bullet pool.
function makeBullet(x, y, vx, vy, opts = {}) {
  return {
    x, y, vx, vy,
    r: opts.r || 4,
    color: opts.color || '#ff5555',
    coreColor: opts.coreColor || null,
    shape: opts.shape || 'circle', // circle | star | petal | cross | diamond
    type: opts.type || 'normal', // normal | homing | curve | laser
    life: opts.life !== undefined ? opts.life : 600, // frames
    turn: opts.turn || 0, // homing turn rate
    curve: opts.curve || 0, // curve acceleration
    rot: opts.rot || 0, // current rotation (rad)
    rotSpeed: opts.rotSpeed || 0, // rotation per frame
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
    this.onEnd = opts.onEnd || (() => {});
    this.onPhase = opts.onPhase || (() => {});
    this.onHud = opts.onHud || (() => {});

    this.player = null;
    this.boss = null;
    this.bullets = [];
    this.playerShots = [];
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
    this.keys = {};
    this._raf = null;
    this._last = 0;
    this._acc = 0;
    this.step = 1000 / 60; // fixed timestep (ms)

    this._onKeyDown = (e) => this._key(e, true);
    this._onKeyUp = (e) => this._key(e, false);
  }

  _key(e, down) {
    const k = e.key.toLowerCase();
    this.keys[k] = down;
    // Prevent page scroll on arrows/space.
    if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) {
      e.preventDefault();
    }
    if (down && (k === ' ' || k === 'z')) this.bomb();
    if (down && k === 'x') this.player.focus = !this.player.focus;
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
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
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
    this._updateBullets();
    this._updateShots();
    this._checkCollisions();

    // Phase progression: a spell card ends when its time elapses (timeout) or
    // its HP gauge is broken (depleted by player shots). Either way we advance.
    const phase = this.phases[this.phaseIndex];
    if (phase && (this.phaseTime >= phase.duration || this.phaseHp <= 0)) {
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
    p.x += dx * p.speed;
    p.y += dy * p.speed;
    p.x = Math.max(10, Math.min(this.W - 10, p.x));
    p.y = Math.max(10, Math.min(this.H - 10, p.y));
  }

  _updateBoss() {
    // Boss movement: gentle sine bob (overridable per boss).
    const b = this.boss;
    if (b.move === 'sine' || !b.move) {
      b.x = this.W / 2 + Math.sin(this.time * (b.moveSpeed || 0.8)) * (b.moveAmp || 60);
    } else if (b.move === 'still') {
      b.x = this.W / 2;
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
        if (em.repeat !== undefined && em.repeat !== -1) {
          em._count = (em._count || 0) + 1;
          if (em._count >= em.repeat) { em._done = true; continue; }
        }
        em._next += interval;
      }
    }
  }

  _fireEmitter(em) {
    const b = this.boss;
    const p = this.player;
    const speedMul = em.speedMul || 1;
    const densityMul = em.densityMul || 1;
    const count = Math.max(1, Math.round((em.count || 1) * densityMul));
    const speed = (em.speed || 2) * speedMul;
    const baseAngle = em.angle !== undefined ? em.angle : Math.atan2(p.y - b.y, p.x - b.x);

    switch (em.type) {
      case 'point': {
        this._add(b.x, b.y, baseAngle, speed, em);
        break;
      }
      case 'aimed': {
        const spread = em.spread || 0;
        for (let i = 0; i < count; i++) {
          const a = baseAngle + (count > 1 ? (i / (count - 1) - 0.5) * spread : 0);
          this._add(b.x, b.y, a, speed, em);
        }
        break;
      }
      case 'ring': {
        const rot = em.rot || 0;
        for (let i = 0; i < count; i++) {
          const a = rot + (i / count) * TAU;
          this._add(b.x, b.y, a, speed, em);
        }
        break;
      }
      case 'spiral': {
        const arms = em.arms || 1;
        const rot = (em.rotSpeed || 0.3) * this.phaseTime;
        for (let a = 0; a < arms; a++) {
          const ang = rot + (a / arms) * TAU;
          this._add(b.x, b.y, ang, speed, em);
        }
        break;
      }
      case 'fan': {
        const spread = em.spread || 0.6;
        for (let i = 0; i < count; i++) {
          const a = baseAngle + (i / (count - 1) - 0.5) * spread;
          this._add(b.x, b.y, a, speed, em);
        }
        break;
      }
      case 'homing': {
        for (let i = 0; i < count; i++) {
          const a = baseAngle + (i - (count - 1) / 2) * 0.2;
          this._add(b.x, b.y, a, speed, em, { type: 'homing', turn: em.turn || 0.05 });
        }
        break;
      }
      case 'curve': {
        for (let i = 0; i < count; i++) {
          const a = baseAngle + (i - (count - 1) / 2) * 0.3;
          this._add(b.x, b.y, a, speed, em, { type: 'curve', curve: em.curve || 0.05 });
        }
        break;
      }
      case 'laser': {
        // A laser is a dense line of bullets fired over several ticks.
        const a = baseAngle;
        for (let i = 0; i < (em.laserLen || 6); i++) {
          this._add(b.x, b.y, a, speed * 1.6, em, { r: em.r || 5, color: em.color || '#ff3333' });
        }
        break;
      }
      default: {
        this._add(b.x, b.y, baseAngle, speed, em);
      }
    }
  }

  _add(x, y, angle, speed, em, extra = {}) {
    if (this.bullets.length > 1200) return; // cap
    const b = makeBullet(x, y, Math.cos(angle) * speed, Math.sin(angle) * speed, {
      r: em.r, color: em.color,
      coreColor: em.coreColor, shape: em.shape, rotSpeed: em.rotSpeed,
      ...extra,
    });
    this.bullets.push(b);
  }

  _updateBullets() {
    const p = this.player;
    // Focus slows bullet movement to 40% (player moves at normal speed).
    const slow = p.focus ? 0.4 : 1;
    for (const b of this.bullets) {
      if (!b.active) continue;
      if (b.type === 'homing' && p.alive) {
        const desired = Math.atan2(p.y - b.y, p.x - b.x);
        let cur = Math.atan2(b.vy, b.vx);
        let diff = desired - cur;
        while (diff > Math.PI) diff -= TAU;
        while (diff < -Math.PI) diff += TAU;
        const turn = Math.max(-b.turn, Math.min(b.turn, diff));
        const spd = Math.hypot(b.vx, b.vy);
        cur += turn;
        b.vx = Math.cos(cur) * spd;
        b.vy = Math.sin(cur) * spd;
      }
      if (b.type === 'curve') {
        const cur = Math.atan2(b.vy, b.vx);
        const spd = Math.hypot(b.vx, b.vy);
        const newCur = cur + b.curve;
        b.vx = Math.cos(newCur) * spd;
        b.vy = Math.sin(newCur) * spd;
      }
      if (b.rotSpeed) b.rot += b.rotSpeed * slow;
      b.x += b.vx * slow;
      b.y += b.vy * slow;
      b.life--;
      if (b.life <= 0 || b.x < -20 || b.x > this.W + 20 || b.y < -20 || b.y > this.H + 20) {
        b.active = false;
      }
    }
    // Remove inactive bullets (in-place).
    if (this.bullets.some(b => !b.active)) {
      this.bullets = this.bullets.filter(b => b.active);
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

    // Fire (auto).
    if (p.alive && this.phaseMaxHp > 0 && this.frame % S.interval === 0) {
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
      if (Math.hypot(s.x - b.x, s.y - b.y) < CONFIG.BOSS_HITBOX + s.r) {
        s.active = false;
        this.phaseHp -= S.damage;
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

  _hitPlayer() {
    const p = this.player;
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

  bomb() {
    const p = this.player;
    if (!p.alive || p.bombs <= 0) return;
    const phase = this.phases[this.phaseIndex];
    if (phase && phase.noBombs) return; // bombs disabled this phase (e.g. Kaguya Last Spell)
    if (this.bombGauge < 1 && p.bombs > 1) return; // need full gauge for extra bombs
    sfxPlay('bomb');
    p.bombs--;
    this.bombGauge = 0;
    // Bomb clears all bullets and gives brief invulnerability.
    for (const b of this.bullets) b.active = false;
    p.invuln = 120;
    this.score += 1000;
    this.shake = 8;
  }

  _end(result) {
    if (this.result) return;
    this.result = result;
    this.running = false;
    sfxPlay(result === 'win' ? 'win' : 'lose');
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    this.onEnd(result);
  }

  render() {
    const ctx = this.ctx;
    ctx.save();
    // Screen shake.
    if (this.shake > 0) {
      ctx.translate((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake);
      this.shake *= 0.9;
      if (this.shake < 0.5) this.shake = 0;
    }
    // Background.
    ctx.fillStyle = this.boss.bg || '#0a0a1a';
    ctx.fillRect(0, 0, this.W, this.H);
    this._drawBackground(ctx);

    // Boss.
    this._drawBoss(ctx);

    // Bullets.
    for (const b of this.bullets) {
      if (!b.active) continue;
      this._drawBullet(ctx, b);
    }

    // Player shots.
    for (const s of this.playerShots) {
      if (!s.active) continue;
      this._drawBullet(ctx, s);
    }

    // Player.
    this._drawPlayer(ctx);

    ctx.restore();
  }

  // Render a bullet with a soft glow + bright core, and an optional shape.
  _drawBullet(ctx, b) {
    const r = b.r;
    const color = b.color || '#ff5555';
    const shape = b.shape || 'circle';
    // Fast path for plain circles (no save/restore/rotate).
    if (shape === 'circle' && !b.rot) {
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(b.x, b.y, r * 1.9, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = b.coreColor || '#ffffff';
      ctx.beginPath();
      ctx.arc(b.x, b.y, r * 0.7, 0, TAU);
      ctx.fill();
      return;
    }
    ctx.save();
    ctx.translate(b.x, b.y);
    if (b.rot) ctx.rotate(b.rot);
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.9, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;
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
    // Simple per-boss tinted gradient + subtle stars.
    const g = ctx.createLinearGradient(0, 0, 0, this.H);
    g.addColorStop(0, this.boss.bgTop || '#141428');
    g.addColorStop(1, this.boss.bgBottom || '#05050c');
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
    // Hitbox (red dot) — visible, Touhou-style; yellow when focused.
    const hb = p.focus ? p.focusHitbox : p.hitbox;
    ctx.fillStyle = p.focus ? '#ffff00' : '#ff0000';
    ctx.beginPath();
    ctx.arc(0, 0, Math.max(1.5, hb / 2), 0, TAU);
    ctx.fill();
    ctx.restore();
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DanmakuEngine, makeBullet, TAU };
}
