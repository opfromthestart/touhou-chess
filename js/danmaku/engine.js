// engine.js — the danmaku (bullet-hell) engine.
// Fixed-timestep 60fps loop on a portrait canvas. Player ship with lives/bombs/
// hitbox/focus, a pooled bullet system, collision + graze, and a data-driven
// pattern engine. Each boss fight is a sequence of phases (spell cards).

const TAU = Math.PI * 2;

// Bullet pool.
function makeBullet(x, y, vx, vy, opts = {}) {
  return {
    x, y, vx, vy,
    r: opts.r || 4,
    color: opts.color || '#ff5555',
    type: opts.type || 'normal', // normal | homing | curve | laser
    life: opts.life !== undefined ? opts.life : 600, // frames
    turn: opts.turn || 0, // homing turn rate
    curve: opts.curve || 0, // curve acceleration
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

  start(phases, boss, playerStats) {
    this.phases = phases;
    this.boss = {
      x: this.W / 2,
      y: 90,
      ...boss,
    };
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
    this.phaseIndex = 0;
    this.phaseTime = 0;
    this.time = 0;
    this.frame = 0;
    this.result = null;
    this.score = 0;
    this.graze = 0;
    this.bombGauge = 0;
    this.running = true;
    this._announcePhase(0);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    this._last = performance.now();
    this._acc = 0;
    this._loop();
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
  }

  _announcePhase(i) {
    if (i < this.phases.length) this.onPhase(this.phases[i]);
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
    this._checkCollisions();

    // Phase progression.
    const phase = this.phases[this.phaseIndex];
    if (phase && this.phaseTime >= phase.duration) {
      this.phaseIndex++;
      this.phaseTime = 0;
      if (this.phaseIndex >= this.phases.length) {
        this._end('win');
      } else {
        this._announcePhase(this.phaseIndex);
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
      ...extra,
    });
    this.bullets.push(b);
  }

  _updateBullets() {
    const p = this.player;
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
      b.x += b.vx;
      b.y += b.vy;
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

  _checkCollisions() {
    const p = this.player;
    if (!p.alive) return;
    const hb = p.focus ? p.focusHitbox : p.hitbox;
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
    if (this.bombGauge < 1 && p.bombs > 1) return; // need full gauge for extra bombs
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
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, TAU);
      ctx.fillStyle = b.color;
      ctx.fill();
    }

    // Player.
    this._drawPlayer(ctx);

    ctx.restore();
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
    // Placeholder boss: a glowing orb with the boss's color (art comes in M6).
    const pulse = 1 + Math.sin(this.time * 3) * 0.08;
    ctx.save();
    ctx.translate(b.x, b.y);
    const grad = ctx.createRadialGradient(0, 0, 5, 0, 0, 40 * pulse);
    grad.addColorStop(0, b.color || '#ffffff');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, 40 * pulse, 0, TAU);
    ctx.fill();
    ctx.fillStyle = b.color || '#ffffff';
    ctx.beginPath();
    ctx.arc(0, 0, 18 * pulse, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  _drawPlayer(ctx) {
    const p = this.player;
    if (!p.alive) return;
    // Blink during invulnerability.
    if (p.invuln > 0 && Math.floor(this.frame / 4) % 2 === 0) return;
    ctx.save();
    ctx.translate(p.x, p.y);
    // Ship (triangle) in the player's color.
    ctx.fillStyle = this.playerColor || '#ff5577';
    ctx.beginPath();
    ctx.moveTo(0, -12);
    ctx.lineTo(9, 10);
    ctx.lineTo(0, 5);
    ctx.lineTo(-9, 10);
    ctx.closePath();
    ctx.fill();
    // Hitbox (red dot) — visible, Touhou-style.
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
