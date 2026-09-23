// bosses.js — the 9 boss fight scripts, data-driven.
// Each boss has a set of phases (spell cards) for Normal and Lunatic.
// Lunatic = one extra phase + scaled-up parameters (speed, density, ).
//
// Contributing patterns? Read docs/danmaku-engine.md — the full authoring guide
// (emitter reference, determinism rules, balance rules, testing, PR checklist).
//
// Emit types: point, aimed, ring, spiral, fan, , curve, laser.
//   - aimed / fan: use ODD counts so one bullet is dead-center on the player.
//     An even count leaves the aim line open and the pattern is far weaker.
//   - curve: expanding spiral around the spawn point (bearing rotates by
//     `curve` rad/frame, radius grows at `speed`).
//   - laser: a beam `laserLen` px long along the aim line, drawn as bullets
//     `spacing` (default 8) px apart, refired every `interval`. With
//     `sweep` (rad/s) the beam rotates in place around the fire origin while
//     it is alive (searchlight); each new segment starts where the last one
//     has rotated to, so they stack into one continuous spinning ray —
//     don't also set angleStep. With `count > 1` each firing lays `count`
//     beams evenly around the origin (a 360° laser ring); with sweep every
//     refired copy lands exactly on the previous one, so the ring spins
//     smoothly at `sweep` (no angleStep needed). Two styles: refire every
//     `interval` and keep life ~1-2 intervals so copies overlap, or fire
//     single-shot rings (repeat: 1) on an alternating period cycle (Kaguya's
//     Brilliant Dragon Barrette). Laser bullets are never off-screen culled
//     while alive (minLife = life): a rotating beam can start off-screen
//     and orbit back into view.
// Bullet shapes: circle, star, petal, cross, diamond, rice.
// Phase fields: name, duration (s), hp, noBombs (bool), emits[].
// Emit fields: t (start s), type, count, speed, spread, angle, arms,
//   rotSpeed, rot, turn, curve, laserLen, spacing, sweep, warn, minLife,
//   interval, repeat, period,
//   r, color, colors, coreColor, shape, speedMul, densityMul,
//   angleOffset, angleStep, speedStep, aimRing.
//   - period: loop a finite `repeat` cycle every N seconds (EoSD spell
//     bodies are repeating blocks); per-fire evolution restarts each cycle.
//   - angleOffset/angleStep: static/per-fire offset from the aim line
//     (swinging aimed streams, rotating beams).
//   - speedStep: per-fire speed increment (accelerating streams).
//   - aimRing: ring starts at the aim line — one bullet dead on the player
//     (EoSD aim_mode 2).
//   - colors: list cycled per fire (EoSD ins_118 color sequences).
//   - Lifetime: bullets despawn when they leave the screen or the card ends
//     (Touhou default) — do NOT set `life` to kill bullets mid-screen. The
//     only legitimate `life` uses: laser segments (beam tail length + density
//     budget), / retention / stationary bullets (they never reach the
//     screen edge and would accumulate), and fadeOut camouflage (the fade
//     ramps over the remaining life).

const TAU_LOCAL = Math.PI * 2;

// In Node.js, make CONFIG available (it's a global in the browser).
if (typeof CONFIG === 'undefined' && typeof module !== 'undefined' && module.exports) {
  global.CONFIG = require('../config.js').CONFIG;
}

// Apply Lunatic scaling to a phase's emits. A boss may override the global
// Lunatic multipliers with its own `lunaticScale` (e.g. Alice's Lunatic cards
// are tuned harder than the default 1.2x / 1.35x). The override is merged over
// the global so any field it omits (e.g. homing) falls back to the default.
//
// When a boss overrides the scale, its DOLL sub-emitters are densified too.
// The global scale only touches top-level emits, but Alice's spell cards put
// their bullets in the doll's nested `shoot` — so without this, the doll cards
// (French/Dutch/Bunraku) barely changed on Lunatic and felt too easy. Density
// is the difficulty lever (more bullets at once); the nested speed defaults to
// 1.0 (same as Normal) because faster bullets are easier to dodge. A top-level
// emit with `noLunaticScale: true` (Bunraku) is skipped — it's tuned by its own
// shoot-budget cap instead of by density.
function scalePhase(phase, diff, boss) {
  const global = CONFIG.DIFFICULTY[diff];
  const override = (boss && boss.lunaticScale && diff === 'lunatic')
    ? boss.lunaticScale : null;
  const d = override ? { ...global, ...override } : global;
  // Nested-pattern (doll bullet) multipliers.
  const nDensity = override
    ? (override.nestedDensity !== undefined ? override.nestedDensity : d.density)
    : d.density;
  const nSpeed = override
    ? (override.nestedSpeed !== undefined ? override.nestedSpeed : 1)
    : d.speed;
  // Scale a bullet pattern's count (density) and speed. A spawnBullet's own
  // count is the number of parent hazards, not the bullet field — leave it and
  // scale only what it spawns (the French arrowhead stays 1, its split densifies).
  const scalePattern = (pat) => {
    if (!pat || typeof pat !== 'object') return pat;
    const out = { ...pat };
    if (pat.type !== 'spawnBullet' && pat.count !== undefined) {
      out.count = Math.max(1, Math.round(pat.count * nDensity));
    }
    if (pat.speed !== undefined) out.speed = pat.speed * nSpeed;
    if (Array.isArray(pat.spawnEmits)) out.spawnEmits = pat.spawnEmits.map(scalePattern);
    return out;
  };
  // Scale a doll's shoot pattern (the bullets it fires), leaving the doll emit
  // itself (count 1) untouched.
  const scaleDollShoot = (doll) => {
    if (!doll || doll.type !== 'doll' || !doll.shoot) return doll;
    return { ...doll, shoot: scalePattern(doll.shoot) };
  };
  const scaleEmit = (em) => {
    const out = {
      ...em,
      speedMul: (em.speedMul !== undefined ? em.speedMul : 1) * d.speed,
      densityMul: (em.densityMul || 1) * d.density,
    };
    if (override && !em.noLunaticScale) {
      if (em.type === 'doll') return scaleDollShoot(out);
      // A bubble whose spawnEmits are dolls (Bunraku) — scale each doll's shoot.
      if (Array.isArray(out.spawnEmits)) out.spawnEmits = out.spawnEmits.map(scaleDollShoot);
    }
    return out;
  };
  const emits = phase.emits.map(scaleEmit);
  return { ...phase, emits };
}

// Per-boss, per-difficulty balance tuning. Each boss may declare a `tune`
// object with a sub-object per difficulty ('normal' / 'lunatic'), each holding
// multipliers applied ON TOP of the default difficulty scaling:
//   - durationMul: scale every phase's duration (shorter = less bullet
//     exposure = easier). This is the main lever for low-DPS pieces, who
//     endure the full card duration instead of breaking it early.
//   - densityMul: scale every emit's density (bullet counts) relative to the
//     default for that difficulty. 1.0 = default; <1 sparser/easier, >1
//     denser/harder. Composes with the global Lunatic density scale.
//   - hpMul: scale every phase's HP gauge (lower = stronger pieces break the
//     card faster = shorter fight).
// Because the two difficulties are tuned independently, Lunatic stays harder
// than Normal even when Normal is eased. These are the balance knobs used to
// hit the per-boss win-rate targets (docs/danmaku-engine.md §6); the authored
// pattern data stays EoSD-faithful.
function applyTune(phase, tune, difficulty) {
  const t = (tune && tune[difficulty]) || null;
  if (!t) return phase;
  let out = phase;
  if (t.durationMul !== undefined) out = { ...out, duration: out.duration * t.durationMul };
  if (t.hpMul !== undefined) out = { ...out, hp: out.hp * t.hpMul };
  if (t.densityMul !== undefined) {
    const m = t.densityMul;
    const scalePat = (pat) => {
      if (!pat || typeof pat !== 'object') return pat;
      const o = { ...pat };
      if (o.count !== undefined) o.count = Math.max(1, Math.round(o.count * m));
      if (Array.isArray(o.spawnEmits)) o.spawnEmits = o.spawnEmits.map(scalePat);
      return o;
    };
    const scaleEm = (em) => {
      if (!em || typeof em !== 'object') return em;
      const o = { ...em, densityMul: (em.densityMul || 1) * m };
      if (Array.isArray(em.spawnEmits)) o.spawnEmits = em.spawnEmits.map(scaleEm);
      if (em.type === 'doll' && em.shoot) o.shoot = scalePat(em.shoot);
      return o;
    };
    out = { ...out, emits: out.emits.map(scaleEm) };
  }
  return out;
}

// Build the phase list for a boss + difficulty.
function getPhases(bossId, difficulty) {
  const boss = BOSSES[bossId];
  if (!boss) return [];
  const base = boss.phases[difficulty === 'lunatic' ? 'lunatic' : 'normal'];
  return base.map(p => scalePhase(applyTune(p, boss.tune, difficulty), difficulty, boss));
}

// ── Shared Rumia patterns ─────────────────────────────────────────────────
// Used by both Normal and Lunatic (scalePhase copies each emitter per
// difficulty, so sharing the arrays is safe). Mechanics mined from the REAL
// EoSD (Touhou 6) stage-1 ECL script (eosd_extract/ecl/disasm/ecldata1_utf8.txt)
// decoded against the decompiled ECL VM + BulletManager
// (refs/EoSDecomp/src/EnemyController/run_ecl_decompiled.cpp,
// refs/EoSDecomp/src/BulletManager/shoot_*_decompiled.cpp). Shoot args are
// (sprite, count_1, count_2, speed_1, speed_2, angle_1, angle_2, flags, sfx);
// aim_mode = opcode - 0x43. Mode 0 = aimed fan centered on player+angle_1;
// mode 2 (fallthrough to 3) = `count_1` rays spanning 90° FROM the aim line,
// each row (count_2) peeling in speed speed_1 -> speed_2.
//   Non-spell (Sub0-Sub3, all ranks): the night-bird swarm attack — single
//     aimed streams (speed 3, 120f cadence) whose aim drifts in wide arcs
//     (~112° out and back; Sub0/Sub1 mirrored), per-rank aimed fans
//     (E/N/H/L: 3/7/9/11 bullets over 45/36/22.5/9°, speed 1.4) from
//     shooters that spin after firing (ins_46 0.0524 rad), and narrow
//     5-bullet 15° fans (Sub3) with the same spin.
//   Moon Sign "Moonlight Ray" (月符「ムーンライトレイ」, midboss, H/L only):
//     repeating 42/48-way fans aimed at the player. EoSD fires a 90° fan
//     starting AT the aim line (H: 42 rays @ 2.5 every 40f, L: 48 @ 2.8
//     every 25f); here the span is widened to a 180° half-circle CENTERED
//     on the aim line (the EoSD 90° fan was too dense to dodge), plus two
//     thick beams (ins_85, width 32, 500px rays from the boss) starting
//     22.5°/157.5° from horizontal, sweeping toward vertical at
//     ±0.00827 rad/frame for 120 frames, rest 60 frames.
//   Night Sign "Night Bird" (夜符「ナイトバード」): four sections per pass —
//     5/7/6/8-bullet aimed fans (step 3.75°), bases at ∓32.7°/∓45° stepping
//     ∓8.2°/∓11.25° per shot over 16 shots, speed accelerating 1.0 -> 4.0;
//     sections B and D fire on a slow 10-frame cadence. Two passes, then a
//     drift gap, repeat (spell 25s).
//   Darkness Sign "Demarcation" (闇符「ディマーケイション」): a barrage
//     machine (Sub18->19->20->21 chained) whose bullets color-cycle on a
//     global clock white -> blue-gray -> green -> red (ins_118, 2f/color):
//     10-bullet 50° peeling fan (8 rows, 3.0->1.0) + a horizontal laser
//     wall through the boss (ins_86, width 16, six 8f-spaced segments);
//     10-ray 90° comet fans (36/28/36 rows, 2.0/2.6->1.0); 13-bullet
//     180° half-circle fans (8/9/10 rows, 3.0->1.0); and mirrored
//     escalating 10-bullet 74° streams (2 rows, +0.25 speed/shot, bases at
//     ∓40.8° stepping ∓8.2°, 16 shots @ 10f).
const DEMARCATION_COLORS = ['#ffffff', '#8080ff', '#80ff80', '#ff8080', '#e8e8e8'];

// Non-spell "Nocturnal Danmaku" (EoSD Sub0-Sub3): the night-bird swarm.
// In EoSD these are many small enemies each running one motif; here the
// boss runs all of them at once on slow repeating cycles.
const RUMIA_NONSPELL = [
  // Sub0: single aimed stream (speed 3), aim sweeping out ~50° over 16
  // shots, then back — a 6.4s ping-pong (EoSD drift -0.0245 rad/f x80f
  // then +0.0196 x100f, net zero).
  {
    t: 0, type: 'aimed', count: 1, speed: 3.0,
    angleStep: 0.056, interval: 0.2, repeat: 16, period: 6.4,
    color: '#d8dcff', coreColor: '#ffffff', shape: 'circle', r: 3
  },
  {
    t: 3.2, type: 'aimed', count: 1, speed: 3.0,
    angleOffset: 0.84, angleStep: -0.056, interval: 0.2, repeat: 16, period: 6.4,
    color: '#d8dcff', coreColor: '#ffffff', shape: 'circle', r: 3
  },
  // Sub1: mirrored swing, offset half a beat.
  {
    t: 0.4, type: 'aimed', count: 1, speed: 3.0,
    angleStep: -0.056, interval: 0.2, repeat: 16, period: 6.4,
    color: '#d8dcff', coreColor: '#ffffff', shape: 'circle', r: 3
  },
  {
    t: 3.6, type: 'aimed', count: 1, speed: 3.0,
    angleOffset: -0.84, angleStep: 0.056, interval: 0.2, repeat: 16, period: 6.4,
    color: '#d8dcff', coreColor: '#ffffff', shape: 'circle', r: 3
  },
  // Sub2: per-rank aimed fans (N rank: 7 bullets over 36°), speed 1.4,
  // sweeping left<->right as the shooter spins (ins_46 after firing).
  {
    t: 1.0, type: 'fan', count: 7, spread: 0.6283, speed: 1.4,
    angleOffset: -0.3, angleStep: 0.02, interval: 0.5, repeat: 12, period: 12,
    color: '#c8b8ff', coreColor: '#ece8ff', shape: 'circle', r: 3.5
  },
  {
    t: 7.0, type: 'fan', count: 7, spread: 0.6283, speed: 1.4,
    angleOffset: 0.3, angleStep: -0.02, interval: 0.5, repeat: 12, period: 12,
    color: '#c8b8ff', coreColor: '#ece8ff', shape: 'circle', r: 3.5
  },
  // Sub3: narrow 5-bullet 15° fans, counter-sweeping on their own cycle.
  {
    t: 0.7, type: 'fan', count: 5, spread: 0.2618, speed: 1.4,
    angleOffset: -0.5, angleStep: 0.03, interval: 0.3, repeat: 14, period: 8.4,
    color: '#e0e4ff', coreColor: '#ffffff', shape: 'circle', r: 3.5
  },
  {
    t: 4.9, type: 'fan', count: 5, spread: 0.2618, speed: 1.4,
    angleOffset: 0.5, angleStep: -0.03, interval: 0.3, repeat: 14, period: 8.4,
    color: '#e0e4ff', coreColor: '#ffffff', shape: 'circle', r: 3.5
  },
];

// Moon Sign "Moonlight Ray": repeating 42-way 180° fan CENTERED ON the aim
// line (em.center: the half-circle is aimed at the player, ±90° either side
// of the aim line). EoSD fires a 42-ray 90° fan starting AT the aim line
// (aim_mode 2 -> 3, first bullet dead on the player), but that density was
// too tight to dodge here, so the span is widened to a 180° half-circle
// around the player instead. EoSD H fires 42 rays @ 2.5 every 40f, L fires
// 48 @ 2.8 every 25f; base = H values, Lunatic scaling (density x1.35 ->
// 57 rays, speed x1.2) approximates L.
const RUMIA_MOONLIGHT = [
  {
    t: 0.5, type: 'fanVolley', count: 42, spread: Math.PI, center: true, rows: 1,
    speed: 2.5,
    interval: 0.667, repeat: -1,
    color: '#fff8d0', coreColor: '#ffffff', shape: 'circle', r: 4.5
  },
];

// Night Sign "Night Bird": four sweeping fan streams, one 10.1s cycle
// (6.4s pass + 3.7s drift gap, EoSD: 220 frames). Spreads are 3.75° per
// step: 5 bullets = 15°, 7 = 22.5°, 6 = 18.7°, 8 = 26.2°.
const RUMIA_NIGHT_BIRD = [
  // A: fast sweep, base -32.7° rising 8.2°/shot, 2-frame cadence.
  {
    t: 0, type: 'fan', count: 5, spread: 0.2618, speed: 1.0, speedStep: 0.2,
    angleOffset: -0.5712, angleStep: 0.1428,
    interval: 0.0333, repeat: 16, period: 10.1,
    color: '#ffe9b0', coreColor: '#fffbe8', shape: 'circle', r: 4
  },
  // B: slow mirror, base +32.7° falling 8.2°/shot, 10-frame cadence.
  {
    t: 0.533, type: 'fan', count: 7, spread: 0.3927, speed: 1.0, speedStep: 0.2,
    angleOffset: 0.5712, angleStep: -0.1428,
    interval: 0.1667, repeat: 16, period: 10.1,
    color: '#ffe9b0', coreColor: '#fffbe8', shape: 'circle', r: 4
  },
  // C: fast wide sweep, base -45° rising 11.25°/shot, 2-frame cadence.
  {
    t: 3.2, type: 'fan', count: 6, spread: 0.3272, speed: 1.0, speedStep: 0.2,
    angleOffset: -0.7854, angleStep: 0.1963,
    interval: 0.0333, repeat: 16, period: 10.1,
    color: '#fff2cc', coreColor: '#fffbe8', shape: 'circle', r: 4
  },
  // D: slow wide mirror, base +45° falling 11.25°/shot, 10-frame cadence.
  {
    t: 3.733, type: 'fan', count: 8, spread: 0.4581, speed: 1.0, speedStep: 0.2,
    angleOffset: 0.7854, angleStep: -0.1963,
    interval: 0.1667, repeat: 16, period: 10.1,
    color: '#fff2cc', coreColor: '#fffbe8', shape: 'circle', r: 4
  },
];
// Night Sign "Night Bird": four sweeping fan streams, one 10.1s cycle
// (6.4s pass + 3.7s drift gap, EoSD: 220 frames). Spreads are 3.75° per
// step: 5 bullets = 15°, 7 = 22.5°, 6 = 18.7°, 8 = 26.2°.
const RUMIA_NIGHT_BIRD_LUN = [
  // A: fast sweep, base -32.7° rising 8.2°/shot, 2-frame cadence.
  {
    t: 0, type: 'fan', count: 5, spread: 0.2618, speed: 1.0, speedStep: 0.2,
    angleOffset: -0.5712, angleStep: 0.1428,
    interval: 0.0333, repeat: 16, period: 7.1,
    color: '#ffe9b0', coreColor: '#fffbe8', shape: 'circle', r: 4
  },
  // B: slow mirror, base +32.7° falling 8.2°/shot, 10-frame cadence.
  {
    t: 0.53, type: 'fan', count: 7, spread: 0.3927, speed: 1.0, speedStep: 0.2,
    angleOffset: 0.5712, angleStep: -0.1428,
    interval: 0.1667, repeat: 16, period: 7.1,
    color: '#ffe9b0', coreColor: '#fffbe8', shape: 'circle', r: 4
  },
  // C: fast wide sweep, base -45° rising 11.25°/shot, 2-frame cadence.
  {
    t: 2.5, type: 'fan', count: 6, spread: 0.3272, speed: 1.0, speedStep: 0.2,
    angleOffset: -0.7854, angleStep: 0.1963,
    interval: 0.0333, repeat: 16, period: 7.1,
    color: '#fff2cc', coreColor: '#fffbe8', shape: 'circle', r: 4
  },
  // D: slow wide mirror, base +45° falling 11.25°/shot, 10-frame cadence.
  {
    t: 3.03, type: 'fan', count: 8, spread: 0.4581, speed: 1.0, speedStep: 0.2,
    angleOffset: 0.7854, angleStep: -0.1963,
    interval: 0.1667, repeat: 16, period: 7.1,
    color: '#fff2cc', coreColor: '#fffbe8', shape: 'circle', r: 4
  },
];

// Darkness Sign "Demarcation": the barrage machine. One 22s cycle mirroring
// the EoSD Sub18->19->20->21 chain (each sub starts with a 60f drift move =
// the breathing gaps below). Every bullet color-cycles on the global clock.
const RUMIA_DEMARCATION = [
  // Sub18: 10-bullet fan (50.4° span), 8 rows peeling 3.0 -> 1.0.
  {
    t: 1.2, type: 'fanVolley', count: 10, center: true, spread: 0.504, rows: 8,
    speed: 3.0, speed2: 1.0,
    colors: DEMARCATION_COLORS, shape: 'rice', r: 3.5, repeat: 1, period: 20
  },
  // Sub18: thin laser wall through the boss (ins_86, width 16) — six
  // segments 8 frames apart. Aims at the player and stretches to the screen
  // edge (no laserLen); like all laser emitters it telegraphs as a thin
  // harmless line for 1.5s (em.warn to change) before growing to full width.
  {
    t: 1.2, type: 'laser', spacing: 14, speed: 0, life: 40,
    color: '#9966ff', coreColor: '#e0d0ff', r: 8,
    interval: 0.1333, repeat: 6, period: 20
  },
  // Sub19: 10-ray 90° comet fans — 36 rows @ 2.0->1.0, then 28 @ 2.6->1.0,
  // then 36 again (EoSD N-tier counts; H/L use 48 rows).
  {
    t: 4.7, type: 'fanVolley', count: 11, spread: Math.PI / 2, rows: 36,
    speed: 2.0, speed2: 1.0,
    colors: DEMARCATION_COLORS, shape: 'rice', r: 4, repeat: 1, period: 20, center: true
  },
  {
    t: 6.2, type: 'fanVolley', count: 11, spread: Math.PI / 2, rows: 28,
    speed: 2.6, speed2: 1.0,
    colors: DEMARCATION_COLORS, shape: 'rice', r: 4, repeat: 1, period: 20, center: true
  },
  {
    t: 7.7, type: 'fanVolley', count: 11, spread: Math.PI / 2, rows: 36,
    speed: 2.0, speed2: 1.0,
    colors: DEMARCATION_COLORS, shape: 'rice', r: 4, repeat: 1, period: 20, center: true
  },
  // Sub20: 13-bullet 180° half-circle fans, rows 8/9/10, 3.0 -> 1.0.
  {
    t: 9.7, type: 'fanVolley', count: 13, center: true, spread: Math.PI, rows: 8,
    speed: 3.0, speed2: 1.0,
    colors: DEMARCATION_COLORS, shape: 'circle', r: 4, repeat: 1, period: 20
  },
  {
    t: 10.4, type: 'fanVolley', count: 13, center: true, spread: Math.PI, rows: 9,
    speed: 3.0, speed2: 1.0,
    colors: DEMARCATION_COLORS, shape: 'circle', r: 4, repeat: 1, period: 20
  },
  {
    t: 11.1, type: 'fanVolley', count: 13, center: true, spread: Math.PI, rows: 10,
    speed: 3.0, speed2: 1.0,
    colors: DEMARCATION_COLORS, shape: 'circle', r: 4, repeat: 1, period: 20
  },
  // Sub21: mirrored escalating streams — 10-bullet 73.8° fans, 2 rows
  // (second row half speed), +0.25 speed per shot, base ∓40.8° stepping
  // ∓8.2°/shot, 16 shots on a 10-frame cadence.
  {
    t: 14.4, type: 'fanVolley', count: 10, center: true, spread: 0.738, rows: 2,
    speed: 1.0, speed2: 0.3, speedStep: 0.25,
    angleOffset: -0.714, angleStep: 0.1428,
    colors: DEMARCATION_COLORS, shape: 'circle', r: 3.5,
    interval: 0.1667, repeat: 16, period: 20
  },
  {
    t: 17.1, type: 'fanVolley', count: 10, center: true, spread: 0.738, rows: 2,
    speed: 1.0, speed2: 0.3, speedStep: 0.25,
    angleOffset: 0.714, angleStep: -0.1428,
    colors: DEMARCATION_COLORS, shape: 'circle', r: 3.5,
    interval: 0.1667, repeat: 16, period: 20
  },
];

// ── Nitori — Knight (value 3). Water / gadget themes. ──
// Pattern mechanics mined from the REAL MoF (Touhou 10) stage-3 ECL script
// (mof_extract/disasm/stage03.txt, `thecl -d 10 -j`), decoded against the
// Th10 RE (refs/th10/src/EnemyEclDispatcher.cpp pattern-slot opcodes
// ins_400–421, refs/th10/src/EclVm.cpp) and thecl10.c. Card list verified
// against the spell banners in the disasm (see docs/porting-eosd-spells.md
// §6 + §14.2): final boss `Boss` -> `Boss1/2/3` -> `BossDead`; `BossN_at`
// subs are the non-spell interludes; `MBoss*` is a separate midboss fight.
//   Normal:  Water Stream (non-spell), Flood "Ooze Flooding",
//            Water Sign "Kappa's Pororoca", Kappa "Monster Cucumber"
//   Lunatic: same, but card 3 becomes the distinct Lunatic card
//            Kappa "Spin the Cephalic Plate" (MoF rank-L BossCard3L), and
//            cards 1-2 take their Hard names (Deluvial Mare / Flash Flood).
// MoF pattern slots map to our emitters: aim mode 3 (player-aimed) ->
// aimed/fan/fanVolley; aim mode 1 (fixed screen angle) -> absolute `angle`;
// aim mode 0 (symmetric) -> fan/ring; ins_409 flag 8192 curving droplets ->
// `curve`; ins_412 short laser volleys -> fast fans.
// Bullet SIZE: MoF resolves each pattern's bullet from an ins_402 sprite
// index into the bullet-sprite ANM table (th10's bullet ANM, NOT extracted),
// so exact pixel sizes can't be read from the disasm — the radii below are a
// best-effort match. The Cucumber's rolling barrage (the card's signature
// large bullet) is r5; the streams/needles/droplets are small (r3-4) as in
// the original.
const NITORI_NONSPELL = [
  // Three slow streams splaying downward (Boss2_at: three mode-1 single-shot
  // streams, per-rank speed E/N/H/L = 2.0/2.5/3.5/3.5 -> Normal 2.5), each
  // drifting 0.004134 rad per shot over 80 shots (8 groups x 10), 2-frame
  // cadence, then the drift flips — a slow ping-pong sweep.
  {
    t: 0, type: 'aimed', count: 1, speed: 2.5, angleOffset: -0.5236,
    angleStep: 0.004134, interval: 1 / 30, repeat: 80, period: 5.33,
    color: '#88ddff', coreColor: '#e0f5ff', shape: 'circle', r: 3
  },
  {
    t: 2.67, type: 'aimed', count: 1, speed: 2.5, angleOffset: -0.5236,
    angleStep: -0.004134, interval: 1 / 30, repeat: 80, period: 5.33,
    color: '#88ddff', coreColor: '#e0f5ff', shape: 'circle', r: 3
  },
  {
    t: 0, type: 'aimed', count: 1, speed: 2.5,
    angleStep: 0.004134, interval: 1 / 30, repeat: 80, period: 5.33,
    color: '#88ddff', coreColor: '#e0f5ff', shape: 'circle', r: 3
  },
  {
    t: 2.67, type: 'aimed', count: 1, speed: 2.5,
    angleStep: -0.004134, interval: 1 / 30, repeat: 80, period: 5.33,
    color: '#88ddff', coreColor: '#e0f5ff', shape: 'circle', r: 3
  },
  {
    t: 0, type: 'aimed', count: 1, speed: 2.5, angleOffset: 0.5236,
    angleStep: 0.004134, interval: 1 / 30, repeat: 80, period: 5.33,
    color: '#88ddff', coreColor: '#e0f5ff', shape: 'circle', r: 3
  },
  {
    t: 2.67, type: 'aimed', count: 1, speed: 2.5, angleOffset: 0.5236,
    angleStep: -0.004134, interval: 1 / 30, repeat: 80, period: 5.33,
    color: '#88ddff', coreColor: '#e0f5ff', shape: 'circle', r: 3
  },
  // Slow 5-way fan (Boss2_at2: mode-0, 5 bullets over 22.5°, speed 1.6,
  // 20-frame cadence; runs on N/H/L).
  {
    t: 0.5, type: 'fan', count: 5, spread: 0.3927, speed: 1.6,
    interval: 1 / 3, repeat: -1,
    color: '#55ccff', coreColor: '#d0f0ff', shape: 'circle', r: 4
  },
];

const NITORI_OOZE = [
  // Ooze drippers at both screen edges (BossCard1: ins_257 side shooters at
  // x = ±208 running BossCard1At): a single slow bullet aimed at the player
  // (aim mode 3, angle [-9998]) every 20 frames, 15 shots per shooter,
  // speed 1.3. In steady state both edges drip at once.
  {
    t: 0, type: 'gap', xn: 0.067, yn: 0.14, inner: 'aimed', count: 1, speed: 1.3,
    interval: 1 / 3, repeat: 15, period: 5,
    color: '#7fe8c8', coreColor: '#d8fff0', shape: 'circle', r: 4
  },
  {
    t: 0.33, type: 'gap', xn: 0.933, yn: 0.14, inner: 'aimed', count: 1, speed: 1.3,
    interval: 1 / 3, repeat: 15, period: 5,
    color: '#7fe8c8', coreColor: '#d8fff0', shape: 'circle', r: 4
  },
  // Central 9-way fan bursts (BossCard1 main loop: mode-0, 9 bullets over
  // 11.25°, speed 2.0, six shots at 20 frames, on a 220-frame cycle).
  {
    t: 1.0, type: 'fan', count: 9, spread: 0.19635, speed: 2.0,
    interval: 1 / 3, repeat: 6, period: 3.67,
    color: '#55ccff', coreColor: '#d0f0ff', shape: 'circle', r: 4
  },
];

// Kappa's Pororoca spout: a metronome near the top edge firing one slow
// bullet every 6 frames, sweeping 135° -> 45° (2.8° per shot, 32 shots)
// and back (Boss2Et_at2: mode-1, %B oscillates 2.356 <-> 0.785 by
// 0.049087, EN speed 1.4). The sweep endpoints are baked into `angle`
// (an absolute angle ignores em.angleOffset — engine _emitAt), so the
// out-sweep starts at 3PI/4 and the return-sweep at PI/4; 32 shots x
// 0.049087 rad = exactly PI/2, so each sweep spans the full arc. Two
// emitters per spout cover the out-sweep and the return-sweep on
// alternating half-cycles (period 6.4s, offset 3.2s).
function nitoriSpout(xn, t) {
  return [
    {
      t, type: 'gap', xn, yn: 0.14, inner: 'aimed', count: 1,
      angle: 3 * Math.PI / 4, angleStep: -0.049087,
      speed: 1.4, interval: 0.1, repeat: 32, period: 6.4,
      color: '#66ccff', coreColor: '#d8f2ff', shape: 'circle', r: 3
    },
    {
      t: t + 3.2, type: 'gap', xn, yn: 0.14, inner: 'aimed', count: 1,
      angle: Math.PI / 4, angleStep: 0.049087,
      speed: 1.4, interval: 0.1, repeat: 32, period: 6.4,
      color: '#66ccff', coreColor: '#d8f2ff', shape: 'circle', r: 3
    },
  ];
}
const NITORI_POROROCA = [];
// Six wave-emitters along the top in the original (x = ±160/±96/±32, or
// ±128/0/-128); five here to stay under the bullet cap (docs §12).
[[0.167, 0], [0.3, 0.13], [0.5, 0.26], [0.7, 0.39], [0.833, 0.52]]
  .forEach(([xn, t]) => NITORI_POROROCA.push(...nitoriSpout(xn, t)));

const NITORI_CUCUMBER = [
  // Rolling aimed barrage (BossCard3: mode-3 player-aimed, 32 rays over
  // 11.25°, 2 rows peeling speed 2.5 -> 1.0, one volley every 120 frames) —
  // the thick rolling "cucumber" of bullets.
  {
    t: 0.5, type: 'fanVolley', count: 32, rows: 2, spread: 0.19635, center: true,
    speed: 2.5, speed2: 1.0,
    interval: 2.0, repeat: -1,
    color: '#88ffcc', coreColor: '#eafff5', shape: 'circle', r: 5
  },
  // Counter-rotating 9-ray laser fans (BossCard3_at: ins_412 short laser
  // volleys, 9 rays, EN speed 2.8, rotating 180° CCW over 16 shots then
  // 180° CW, 10-frame cadence, 320-frame cycle).
  {
    t: 0, type: 'fan', count: 9, spread: 0.3927, speed: 2.8,
    angleStep: -0.19635, interval: 0.1667, repeat: 16, period: 5.33,
    color: '#aef7ff', coreColor: '#ffffff', shape: 'circle', r: 3
  },
  {
    t: 2.67, type: 'fan', count: 9, spread: 0.3927, speed: 2.8,
    angleStep: 0.19635, interval: 0.1667, repeat: 16, period: 5.33,
    color: '#aef7ff', coreColor: '#ffffff', shape: 'circle', r: 3
  },
];

const NITORI_SPIN_PLATE = [
  // Dense spinning aimed needles (BossCard3L_at: mode-3, 56 bullets in a
  // near-line, speed 4.0 -> 3.0 -> 2.5 over three shots at 10 frames, spin
  // ±0.008727 rad/shot alternating direction per volley).
  {
    t: 0.5, type: 'fan', count: 56, spread: 0.02, speed: 4.0, speedStep: -0.5,
    angleStep: 0.008727, interval: 0.1667, repeat: 3, period: 5.33,
    color: '#b0f0ff', coreColor: '#ffffff', shape: 'circle', r: 3
  },
  {
    t: 3.17, type: 'fan', count: 56, spread: 0.02, speed: 4.0, speedStep: -0.5,
    angleStep: -0.008727, interval: 0.1667, repeat: 3, period: 5.33,
    color: '#b0f0ff', coreColor: '#ffffff', shape: 'circle', r: 3
  },
  // Thin slow drift (BossCard3L_at2: single slow bullet toward the player,
  // refired every 100 frames, aim converging slowly on the player).
  {
    t: 0, type: 'aimed', count: 1, speed: 1.3,
    angleStep: 0.013, interval: 1.667, repeat: -1,
    color: '#7fd8ff', coreColor: '#e0f5ff', shape: 'circle', r: 3
  },
  // Curving droplets (the card's ins_409 flag-8192 bullets, turn ~0.75°/f).
  {
    t: 1, type: 'curve', count: 3, speed: 2.2, curve: 0.013,
    interval: 0.5, repeat: -1,
    color: '#9fe8ff', coreColor: '#ffffff', shape: 'circle', r: 3
  },
  {
    t: 1.5, type: 'curve', count: 3, speed: 2.2, curve: -0.013,
    interval: 0.5, repeat: -1,
    color: '#9fe8ff', coreColor: '#ffffff', shape: 'circle', r: 3
  },
];

// ── Hina Kagiyama — Knight (value 3). Misfortune-doll (nagashi-bina) themes. ──
// Pattern mechanics mined from the REAL MoF (Touhou 10) stage-2 ECL script
// (mof_extract/disasm/stage02.txt, `thecl -d 10 -j`), decoded against the
// Th10 RE (refs/th10/src/EnemyEclDispatcher.cpp pattern-slot opcodes
// ins_400–421, refs/th10/src/EclVm.cpp) and thecl10.c. Card list verified
// against the spell banners in the disasm (see docs/porting-eosd-spells.md
// §6 + §14.5): final boss `Boss` -> `Boss1` (non-spell) -> `BossCard1` ->
// `Boss2` (non-spell) -> `BossCard2` -> `BossCard3` -> `BossDead`. The
// `MBoss*` subs are a SEPARATE midboss (a nagashi-bina doll with its own
// "Bad Fortune" card) — not part of the final fight.
//   Normal:  Non-spell, Broken Amulet, Misfortune's Wheel, Pain Flow
//   Lunatic: Non-spell, Broken Charm of Protection, Old Lady Ohgane's Fire,
//            Exiled Doll
//            (the H/L banner names; the patterns are the same constructs,
//            scaled up by the engine's Lunatic multipliers).
// MoF pattern slots map to our emitters: aim mode 3 (player-aimed) ->
// aimed/fan; aim mode 1 (fixed screen angle) -> absolute `angle`; the
// side-shooter `ins_256` spawns (BossAtEnemy* / Boss1CardAtEnemy) -> `gap`
// emitters placed around the boss; ins_409 flag 32768 large hazard bullets
// -> big `r`.
// Bullet SIZE: MoF resolves each pattern's bullet from an ins_402 sprite
// index into the bullet-sprite ANM table (th10's bullet ANM, NOT extracted),
// so exact pixel sizes can't be read from the disasm — the radii below are a
// best-effort match (the Wheel's large hazard bullets are bumped to r6).
const HINA_NONSPELL = [
  // Two side-shooters (Boss1 spawns BossAtEnemy at angle 0 and π): player-
  // aimed streams tracking the player, one from each side of the doll. The
  // real pattern uses a 2-way and a 6-way stream; here 3 and 5 (odd, so one
  // bullet sits dead on the aim line).
  {
    t: 0, type: 'gap', xn: 0.34, yn: 0.16,
    inner: 'aimed', count: 3, spread: 0.35, speed: 1.8,
    interval: 0.14, repeat: -1,
    color: '#ff8899', coreColor: '#ffd8de', shape: 'circle', r: 4
  },
  {
    t: 0.2, type: 'gap', xn: 0.66, yn: 0.16,
    inner: 'aimed', count: 5, spread: 0.5, speed: 1.8,
    interval: 0.18, repeat: -1,
    color: '#ff8899', coreColor: '#ffd8de', shape: 'circle', r: 4
  },
  // 32-shot aimed burst (Boss1: aim mode 3, count 32, speed 2.0) — five dense
  // aimed fans in a row (a thick wall dead on the player), then a rest,
  // looping.
  {
    t: 0.6, type: 'aimed', count: 32, spread: 0.18, speed: 2.0,
    interval: 0.16, repeat: 5, period: 3.5,
    color: '#ff6677', coreColor: '#ffe0e5', shape: 'diamond', r: 5
  },
];

// Broken Amulet (疵符「ブロークンアミュレット」, MoF S2 spell #1, E/N): a
// ring of eight side-shooters (BossCard1: ins_256 "Boss1CardAtEnemy" x8,
// 45° apart on N-rank) around the boss, each firing a slow 5-way player-aimed
// fan (Boss1CardAtEnemyAt: aim mode 3, count 5, speed 1.0) — the broken
// amulet's shards raining in from all sides.
const HINA_BROKEN_AMULET = [];
{
  const DOLL_R = 0.18; // normalized radius of the side-shooter ring (wide arc,
  // so the shards rain in from across the top of the screen, not a tight
  // cluster around the boss)
  const bx = 0.5, by = 0.14; // boss position (normalized)
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const xn = bx + Math.cos(a) * DOLL_R;
    const yn = Math.min(0.85, Math.max(0.02, by + Math.sin(a) * DOLL_R));
    HINA_BROKEN_AMULET.push({
      t: i * 0.12, type: 'gap', xn, yn,
      // Wide 5-way fan (0.55 rad ≈ 31°) so each shooter's shards cover a
      // broad arc instead of converging on one point; the real card's slow
      // speed (1.0) lets the shards drift across the playfield.
      inner: 'aimed', count: 5, spread: 0.55, speed: 1.0,
      interval: 0.5, repeat: -1,
      color: '#ff99aa', coreColor: '#ffe0e5', shape: 'circle', r: 4
    });
  }
}

// Misfortune's Wheel (悪霊「ミスフォーチュンズホイール」, MoF S2 spell #2,
// E/N): two counter-rotating rings of large curving bullets (BossCard2: two
// alternating waves of side-shooters orbiting the aim point, each a slow
// curving large bullet — ins_409 flag 32768, turn ~0.013 rad/frame — one wave
// +1°/shot, the other -1°/shot). Approximated with two counter-rotating
// `spin` rings of large bullets. Each ring is a continuous wall (16 bullets,
// 22.5° apart; the two walls interleave by a half-step → ~110px gaps at the
// player's distance) — tight enough that standing still is not an option
// (the walls sweep around you), but with room to breathe for a Normal card.
// The slow aimed hub keeps gentle center pressure.
const HINA_WHEEL = [
  // Wheel 1: 16 large bullets spiraling out clockwise around the boss.
  {
    t: 0, type: 'ring', count: 16, speed: 1.2, spin: 0.35,
    interval: 1.0,
    color: '#ffcc44', coreColor: '#fff0d0', shape: 'circle', r: 6
  },
  // Wheel 2: same wall spiraling counter-clockwise (offset half a step, 11.25°,
  // so the two walls interleave instead of overlapping).
  {
    t: 0.5, type: 'ring', count: 16, speed: 1.2, spin: -0.35, rot: 0.1963,
    interval: 1.0,
    color: '#ff8844', coreColor: '#ffe0c0', shape: 'diamond', r: 6
  },
  // Aimed hub: a 3-way fan dead on the player at the wheel's center —
  // gentle aimed pressure that nudges you to reposition between the walls.
  {
    t: 0.5, type: 'aimed', count: 3, spread: 0.3, speed: 1.6,
    interval: 0.7,
    color: '#ffaa55', coreColor: '#fff0d0', shape: 'circle', r: 4
  },
];

// Pain Flow (創符「ペインフロー」, MoF S2 spell #3, E/N): a fast-rotating
// 5-way fan (BossCard3 main loop: aim mode 1, count 5, spread 22.5°, speed
// 1.5, angle -7.5°/fire) plus four side-shooters at the cardinal directions
// (BossAtEnemy3 at 0/90/180/-90) — a flowing, layered barrage.
const HINA_PAIN_FLOW = [
  // Fast-rotating 5-way fan (the card's signature flowing spiral).
  {
    t: 0, type: 'fan', count: 5, spread: 0.3927, speed: 1.5,
    angle: Math.PI / 2, angleStep: -0.08,
    interval: 0.1, repeat: -1,
    color: '#cc66ff', coreColor: '#e8d0ff', shape: 'circle', r: 4
  },
  // A slower counter-rotating 5-way fan (the card's layered flow).
  {
    t: 0.3, type: 'fan', count: 5, spread: 0.3927, speed: 1.3,
    angle: Math.PI / 2, angleStep: 0.05,
    interval: 0.14, repeat: -1,
    color: '#aa88ff', coreColor: '#e0d0ff', shape: 'diamond', r: 4
  },
  // Four side-shooters at the cardinal directions (slow aimed streams).
  { t: 0.5, type: 'gap', xn: 0.62, yn: 0.14, inner: 'aimed', count: 1, speed: 1.4, interval: 1 / 6, repeat: -1, color: '#bb99ff', coreColor: '#e8d8ff', shape: 'circle', r: 3 },
  { t: 0.7, type: 'gap', xn: 0.38, yn: 0.14, inner: 'aimed', count: 1, speed: 1.4, interval: 1 / 6, repeat: -1, color: '#bb99ff', coreColor: '#e8d8ff', shape: 'circle', r: 3 },
  { t: 0.9, type: 'gap', xn: 0.5, yn: 0.26, inner: 'aimed', count: 1, speed: 1.4, interval: 1 / 6, repeat: -1, color: '#bb99ff', coreColor: '#e8d8ff', shape: 'circle', r: 3 },
  { t: 1.1, type: 'gap', xn: 0.5, yn: 0.04, inner: 'aimed', count: 1, speed: 1.4, interval: 1 / 6, repeat: -1, color: '#bb99ff', coreColor: '#e8d8ff', shape: 'circle', r: 3 },
];

// ── Remilia — Rook (value 5). Vampire final-boss pressure. ──
// Pattern mechanics mined from the REAL EoSD (Touhou 6) stage-6 ECL script
// (eosd_extract/ecl/disasm/ecldata6_utf8.txt), decoded against the decompiled
// ECL VM + BulletManager (refs/EoSDecomp/src/...). Remilia is the stage-6 FINAL
// boss (Sub15 -> Sub16 -> Sub17, life 13000); the midboss (Sakuya, Sub8,
// life 6000) is separate and not folded in. Card banners verified in the
// disasm (see docs/porting-eosd-spells.md §6 + §14.4):
//   Non-spell (Sub18), Star of David (Sub30), Young Demon Lord (Sub31,
//   Hard/Lunatic), Scarlet Netherworld (Sub32), Mountain of a Thousand
//   Needles (Sub33), Curse of Vlad Dracula (Sub34), Vampire Fantasy (Sub35),
//   Scarlet Shoot (Sub38), Scarlet Meister (Sub39), Red Magic (Sub43),
//   Scarlet Gensokyo (Sub44, Lunatic finale).
// This port uses six of them:
//   Normal:  Non-spell, Star of David, Scarlet Netherworld, Scarlet Shoot
//   Lunatic: Non-spell, Star of David, Young Demon Lord, Scarlet Netherworld,
//            Scarlet Gensokyo (finale)
// EoSD shoot ops map to our emitters: aim_mode 1 (ins_68) -> aimed/fan with
// angleStep (rotating fans); aim_mode 3 (ins_70) -> ring; ins_118 sets the
// bullet color (Remilia's cards are red #ff8080). EoSD speeds are px/frame.
//
// BULLET SIZES: the shoot op's FIRST arg is the sprite index into
// bullet_types_templates[16] (each a pre-built ANM with its own pixel size,
// baked into etama.anm — see refs/EoSDecomp/src/BulletManager/). Remilia's
// cards use sprites 1-9 (Rumia tops out at 3), so her bullets are genuinely
// larger than Rumia's. Sprite-index -> radius (px) mapping, calibrated to
// the codebase's "large" references (Demarcation circles r:10, laser r:8):
//   0:3   1:3.5  2:4   3:4.5  4:5   5:5.5  6:6.5  7:7   8:7.5  9:8
// Per-card sprite usage (from the ECL shoot ops):
//   Non-spell Sub18: 3-way->3, 9-way->9, 6-way->6
//   Star of David Sub30: all->6
//   Young Demon Lord Sub31: 10/12-ring->9, 14-ring->6
//   Netherworld Sub32: 24-rings->2, 16-rings->5
//   Scarlet Shoot Sub36: fast->9, mid->6, slow->1
//   Scarlet Gensokyo Sub44: all->9
const REMILIA_NONSPELL = [
  // EoSD Sub18 (non-spell): three interlocking rotating fans. Stream A:
  // 3-way fan (aim_mode 1, N-rank count 3), speed 1.8, sweeping 36° per
  // volley (ins_20 -10005 +0.6283). Red.
  {
    t: 0, type: 'aimed', count: 3, spread: 0.1, speed: 1.9,
    angleStep: 0.6283, interval: 0.2,
    color: '#ff4455', coreColor: '#ffd0d8', shape: 'circle', r: 4.5
  },
  // Stream B: 9-way fan (count 9), speed 3.5, sweeping 22.5° per volley.
  {
    t: 0.13, type: 'aimed', count: 9, spread: 1.0472, speed: 3.2,
    angleStep: 0.3927, interval: 0.26,
    color: '#ff5566', coreColor: '#ffd8de', shape: 'diamond', r: 8
  },
  // Stream C: 6-way fan (count 6 -> 7 for the odd-count house rule), speed
  // 2.5, sweeping 9° per volley.
  {
    t: 0.26, type: 'aimed', count: 7, spread: 0.7854, speed: 2.5,
    angleStep: 0.1571, interval: 0.26,
    color: '#ff6677', coreColor: '#ffe0e5', shape: 'circle', r: 6.5
  },
];

// Heaven's Punishment "Star of David" (天罰「スターオブダビデ」, EoSD spell
// Sub30): two counter-rotating triangles (3-bullet rings at 120° intervals)
// interlock into a hexagram; a 12-bullet hexagon ring forms the web. Slow
// red bullets (EoSD speed 0.2) with blue accents at the joints.
const REMILIA_STAR_OF_DAVID = [
  // Triangle 1: points at 0°/120°/240°, rotating CW.
  {
    t: 0, type: 'ring', count: 3, speed: 1.4, rotSpeed: 0.03,
    color: '#ff4455', coreColor: '#ffd0d8', shape: 'star', r: 6.5, interval: 0.9
  },
  // Triangle 2: offset 60°, rotating CCW — the two triangles make the star.
  {
    t: 0, type: 'ring', count: 3, speed: 1.4, rotSpeed: -0.03, rot: 1.0472,
    color: '#ff5566', coreColor: '#ffd8de', shape: 'star', r: 6.5, interval: 0.9
  },
  // The web: a 12-bullet hexagon, slowly rotating, in blue.
  {
    t: 0, type: 'ring', count: 12, speed: 1.6, rotSpeed: 0.02,
    color: '#6688ff', coreColor: '#d0dcff', shape: 'circle', r: 6.5, interval: 1.1
  },
  // Aimed fill: slow 3-way fans converging on the player (the "star" bullets).
  {
    t: 0.4, type: 'aimed', count: 3, spread: 0.4, speed: 1.8,
    angleStep: 0.5236, interval: 0.7,
    color: '#ff6677', coreColor: '#ffe0e5', shape: 'circle', r: 6.5
  },
];

// Divine Punishment "Young Demon Lord" (神罰「幼きデーモンロード」, EoSD
// spell Sub31, Hard/Lunatic): rotating red rings (12 bullets, rot 0.196 rad/f)
// + a 6-bullet ring (rot 0.098) + aimed fans. Aggressive.
const REMILIA_DEMON_LORD = [
  {
    t: 0, type: 'ring', count: 12, speed: 1.6, rotSpeed: 0.1963,
    color: '#ff4455', coreColor: '#ffd0d8', shape: 'circle', r: 8, interval: 0.5
  },
  {
    t: 0.2, type: 'ring', count: 6, speed: 1.5, rotSpeed: 0.0982,
    color: '#ff5566', coreColor: '#ffd8de', shape: 'diamond', r: 6.5, interval: 0.5
  },
  {
    t: 0.1, type: 'aimed', count: 5, spread: 0.3, speed: 2.5,
    angleStep: 0.3, interval: 0.5,
    color: '#ff6677', coreColor: '#ffe0e5', shape: 'circle', r: 8
  },
];

// Nether Sign "Scarlet Netherworld" (冥符「紅色の冥界」, EoSD spell Sub32):
// two counter-rotating 24-bullet rings (rot ±0.0245 rad/f) + two 16-bullet
// rings (rot ±0.02 rad/f). The classic rotating red-ring barrage.
const REMILIA_NETHERWORLD = [
  {
    t: 0, type: 'ring', count: 24, speed: 1.8, rotSpeed: 0.0245,
    color: '#ff4455', coreColor: '#ffd0d8', shape: 'circle', r: 4, interval: 0.7
  },
  {
    t: 0, type: 'ring', count: 24, speed: 1.8, rotSpeed: -0.0245,
    color: '#ff5566', coreColor: '#ffd8de', shape: 'circle', r: 4, interval: 0.7
  },
  {
    t: 0.35, type: 'ring', count: 16, speed: 2.2, rotSpeed: 0.02,
    color: '#ff6677', coreColor: '#ffe0e5', shape: 'diamond', r: 5.5, interval: 0.7
  },
  {
    t: 0.7, type: 'ring', count: 16, speed: 2.2, rotSpeed: -0.02,
    color: '#ff7788', coreColor: '#ffe8ec', shape: 'diamond', r: 5.5, interval: 0.7
  },
];

// Scarlet Sign "Scarlet Shoot" (紅符「スカーレットシュート」, EoSD spell
// Sub38): three fast aimed streams (Sub36: 9-way @ 6.0, 6-way @ 4.0, 5-way
// @ 3.0) that sweep across the screen on a slow angleStep and loop for the
// whole card. Red.
const REMILIA_SCARLET_SHOOT = [
  {
    t: 0, type: 'aimed', count: 9, spread: 0.15, speed: 4.0,
    angleStep: 0.1, interval: 0.3,
    color: '#ff4455', coreColor: '#ffd0d8', shape: 'circle', r: 8
  },
  {
    t: 0.15, type: 'aimed', count: 7, spread: 0.15, speed: 3.5,
    angleOffset: 0.7854, angleStep: -0.1, interval: 0.3,
    color: '#ff5566', coreColor: '#ffd8de', shape: 'circle', r: 6.5
  },
  {
    t: 0.3, type: 'aimed', count: 5, spread: 0.15, speed: 3.0,
    angleOffset: -0.7854, angleStep: 0.1, interval: 0.3,
    color: '#ff6677', coreColor: '#ffe0e5', shape: 'circle', r: 3.5
  },
];

// "Scarlet Gensokyo" (「紅色の幻想郷」, EoSD spell Sub44, Lunatic finale):
// rotating rings (10, 12, 17, 12 bullets) with drift, red. The grand finale.
const REMILIA_SCARLET_GENSO = [
  {
    t: 0, type: 'ring', count: 10, speed: 3.0, rotSpeed: 0.023,
    color: '#ff4455', coreColor: '#ffd0d8', shape: 'circle', r: 8, interval: 0.8
  },
  {
    t: 0.2, type: 'ring', count: 12, speed: 2.5, rotSpeed: -0.0245,
    color: '#ff5566', coreColor: '#ffd8de', shape: 'circle', r: 8, interval: 0.8
  },
  {
    t: 0.4, type: 'ring', count: 17, speed: 2.0, rotSpeed: 0.02,
    color: '#ff6677', coreColor: '#ffe0e5', shape: 'diamond', r: 8, interval: 0.8
  },
  {
    t: 0.6, type: 'ring', count: 12, speed: 1.5, rotSpeed: -0.02,
    color: '#ff7788', coreColor: '#ffe8ec', shape: 'circle', r: 8, interval: 0.8
  },
];

// ── Alice — Bishop (value 3). Dolls. ─────────────────────────────────────
// Pattern mechanics mined from the REAL PCCB (Touhou 7) stage-3 ECL script
// (pcb_extract/disasm/ecldata3.txt), decoded against the PCCB ECL VM. Alice is
// the stage-3 boss; her cards are the doll cards. Card banners verified in the
// disasm (ins_90 banner strings):
//   Otome Bunraku (Sub27, "操符「乙女文楽」"), Hakuai no Furansu Ningyou
//   (Sub42, "蒼符「博愛の仏蘭西人形」", the French Dolls), Hakuai no Orurean
//   Ningyou (Sub46, "紅符「紅毛の和蘭人形」", the Dutch Dolls).
// PCCB shoot ops map to our emitters: ins_54 sets the aim (mode 4 = player,
// speed); ins_64/ins_65/ins_67 are the shoot ops (aim_mode, count, ..., speed,
// spread, ..., angleStep); ins_52 is a random angle in [-π, π]; ins_27 is a
// "change over time" op that drives the dolls' orbit radius/speed (the
// CopyMainBossMovement orbit). The doll count is read from a var per difficulty
// (Sub42: E 4 / N 6 / H 10 / L 8; Sub46: 8).
// This port uses four of them, simplified to the engine's emitter vocabulary:
//   Normal:  Non-spell, Maiden's Bunraku, French Dolls
//   Lunatic: Non-spell, Maiden's Bunraku, French Dolls, Dutch Dolls
// Alice's palette is blue (#66aaff / #88ccff) with purple (#cc66ff) and red
// (#ff6666) accents (her dolls wear blue dresses; the red/green waves are the
// Dutch Dolls' rings).
//
// NOTE on one-shot vs repeating emits: a phase emit with no `interval` defaults
// to interval 0.2 (engine.js _emitPattern), so a doll emit must carry
// `repeat: 1` to fire exactly once (otherwise it re-spawns a new doll every
// 0.2s and the field saturates to the 2000-bullet cap).

// PCCB Sub3 (non-spell): two counter-rotating aimed fans sweeping across the
// screen (ins_64 !H: count 6, speed 1.3, spread 0.5, angleStep 0.6283 = 36°;
// ins_64 !L: count 4, speed 2.1, spread 0.5, angleStep 0.3927 = 22.5°) plus a
// slow expanding ring (ins_54, π/2). Blue — Alice's signature. Odd counts per
// the house rule.
const ALICE_NONSPELL = [
  {
    t: 0, type: 'aimed', count: 5, spread: 0.5, speed: 1.6,
    angleStep: 0.6283, interval: 0.2,
    color: '#66aaff', coreColor: '#e0f0ff', shape: 'circle', r: 5
  },
  // Counter-rotating fan (the second stream of the non-spell).
  {
    t: 0.1, type: 'aimed', count: 5, spread: 0.5, speed: 1.4,
    angleStep: -0.3927, interval: 0.22,
    color: '#88ccff', coreColor: '#e8f4ff', shape: 'diamond', r: 4
  },
  // Slow expanding ring (purple, Alice's secondary).
  {
    t: 0.3, type: 'ring', count: 14, speed: 1.3, rotSpeed: 0.02,
    interval: 1.0,
    color: '#cc66ff', coreColor: '#f0d0ff', shape: 'petal', r: 5
  },
];

// Build `count` one-shot doll emits evenly spaced around a full circle. Used
// for the French/Dutch orbiting dolls (as phase emits) and the Bunraku bubble
// burst (as a spawnEmits list). `o.orbitRadius`/`o.orbitSpeed` make the dolls
// orbit the boss (CopyMainBossMovement); omit them for straight-flyers.
// `o.destructible: false` makes the dolls invulnerable spell emitters (the
// orbiting French/Dutch dolls — see the engine 'doll' case for why).
function aliceDollEmits(count, o) {
  const arr = [];
  for (let i = 0; i < count; i++) {
    arr.push({
      t: (o.t0 || 0) + i * (o.stagger || 0.12),
      type: 'doll',
      count: 1,
      angle: (i / count) * TAU_LOCAL, // even full-circle start positions
      repeat: 1,                       // fire ONCE (see the note above)
      speed: o.speed !== undefined ? o.speed : 0,
      orbitRadius: o.orbitRadius,
      orbitSpeed: o.orbitSpeed,
      hp: o.hp || 3,
      r: o.r || 10,
      shape: 'petal',
      interval: o.interval,
      color: o.color,
      coreColor: o.coreColor,
      shoot: o.shoot,
      deathBurst: o.deathBurst,
      destructible: o.destructible,    // undefined = destructible (default)
      // Cap on how many times the doll fires its shoot (undefined = unlimited).
      // The orbiting French/Dutch dolls fire for the whole card; the straight-
      // flying Bunraku dolls are capped so they stop shooting before reaching
      // the bottom (see ALICE_BUNRAKU).
      spawnCount: o.spawnCount,
    });
  }
  return arr;
}

// Puppeteer Sign "Maiden's Bunraku" (操符「乙女文楽」, PCCB Sub27, simplified):
// a large blue bubble sits at Alice and, after a beat, bursts into 8 dolls
// flying outward in all directions (Sub28/29: ~10 dolls fly random directions).
// Each doll fires straight 3-way fans of blue bullets at the player and pops
// into a red burst on destruction (the card's red-bullet rain). The real card
// also fires a red laser per doll — dropped here for the simplified port.
const ALICE_BUNRAKU = [
  {
    t: 0, type: 'spawnBullet', count: 1, speed: 0,
    r: 18, shape: 'circle', color: '#66aaff', coreColor: '#d0e8ff',
    hp: 3,
    repeat: 4, interval: 4,            // four bubbles across the card (batches overlap)
    spawnEvery: 45, spawnCount: 1,     // burst 0.75s after appearing
    life: 60,                          // the bubble is gone right after bursting
    // This card is already on the hard side (its dolls fire to the bottom), so
    // it's excluded from the Lunatic density bump and tuned by a shoot-budget
    // cap instead: each doll fires 3 fans, then stops shooting and drifts off
    // harmlessly. (See scalePhase's `noLunaticScale` handling.)
    noLunaticScale: true,
    spawnEmits: aliceDollEmits(8, {
      speed: 1.0,                      // straight-flyers, no orbit
      interval: 0.8,
      spawnCount: 3,                   // fire 3 fans then stop (was: fired the whole card)
      color: '#88ccff', coreColor: '#e8f4ff',
      // Straight 3-way fan of blue bullets at the player (the doll's
      // "straight lines of blue bullets").
      shoot: { type: 'fan', count: 3, spread: 0.3, speed: 2.0,
               color: '#66aaff', coreColor: '#e0f0ff', shape: 'circle', r: 4 },
      // The red-bullet burst on destruction.
      deathBurst: { type: 'ring', count: 10, speed: 1.6,
                    color: '#ff6666', coreColor: '#ffd0d0', shape: 'circle', r: 4 },
    }),
  },
];

// Soufu "French Dolls" (蒼符「博愛の仏蘭西人形」, PCCB Sub42): N dolls (E 4 /
// N 6 / H 10 / L 8) orbit Alice (ins_27 drives orbit radius ~96 + orbit speed
// ~0.052 rad/f, CopyMainBossMovement). Each doll fires a single blue arrowhead
// OUTWARD (aimFrom:'boss'); the arrowhead then splits into white + purple
// bullets that fly back toward the player — the card's signature "outward
// bullets that split inward." (The real card aims the inward split at Alice;
// we aim at the player so the card stays a real threat.)
const ALICE_FRENCH = aliceDollEmits(6, {
  orbitRadius: 90, orbitSpeed: 0.02,   // 6 dolls (E 4 / N 6 / H 10 / L 8)
  speed: 0, interval: 0.8,
  color: '#88ccff', coreColor: '#e8f4ff',
  // The orbiting dolls are the spell's emitters (PCCB Sub43 entities), not
  // hazards: invulnerable. They circle on the shot line to the boss, and
  // player shots are consumed by destructible bullets — shootable dolls let
  // the player's own fire kill all six (~14s into the 22s card) and the
  // field runs dry for the last ~8s. (The arrowheads they fire stay
  // shootable, so shooting down the split before it happens still works.)
  destructible: false,
  // The blue arrowhead flies OUTWARD (aimFrom:'boss'); after 0.5s it splits
  // (spawnEvery 30, spawnCount 1) into the inward white + purple split, then
  // the arrowhead itself fades (life 45).
  shoot: {
    type: 'spawnBullet', count: 1, speed: 2.0, aimFrom: 'boss',
    r: 6, shape: 'star', color: '#66aaff', coreColor: '#d0e8ff',
    spawnEvery: 30, spawnCount: 1, life: 45,
    spawnEmits: [
      // The inward white split (the "split inward" mechanic): the bullets fly
      // back TOWARD Alice (aimAt:'boss'), converging on her from the outward
      // arrowheads — the card's signature.
      { type: 'fan', count: 5, spread: 0.8, speed: 1.6, aimAt: 'boss',
        color: '#ffffff', coreColor: '#ffffff', shape: 'circle', r: 4 },
      // Direct aimed pressure at the player (keeps the card a real threat).
      { type: 'aimed', count: 3, spread: 0.3, speed: 1.8,
        color: '#cc66ff', coreColor: '#f0d0ff', shape: 'diamond', r: 4 },
    ],
  },
});

// Soufu "Dutch Dolls" (紅符「紅毛の和蘭人形」, PCCB Sub46): eight dolls
// (ins_4([10029], 8)) orbit Alice at a small radius (ins_5([10036], 0.0218)
// rotation, ins_5([10004], 32) radius), each firing a ring (Sub47, 20 bullets)
// that is spun red -> green (the card's red -> green wave). Simplified to
// orbiting dolls firing rotating red/green-alternating rings.
const ALICE_DUTCH = aliceDollEmits(8, {
  orbitRadius: 70, orbitSpeed: 0.025,  // 8 dolls
  speed: 0, interval: 0.8,
  color: '#ff8888', coreColor: '#ffd0d0',
  // Same as French: the orbiting dolls are the spell's emitters, not hazards
  // — invulnerable, so the player's fire can't empty the card by shooting
  // down every emitter (see the ALICE_FRENCH note).
  destructible: false,
  // A rotating ring of red bullets, alternating green (the card's red -> green
  // "spun" wave).
  shoot: { type: 'ring', count: 12, speed: 1.8, rotSpeed: 0.03,
           color: '#ff6666', coreColor: '#ffd0d0', colorAlt: '#66cc66',
           shape: 'circle', r: 4 },
});

// ── Patchouli — Bishop (value 3). Elemental magic. ────────────────────────
// Pattern mechanics mined from the REAL EoSD (Touhou 6) stage-4 ECL script
// (eosd_extract/ecl/disasm/ecldata4_utf8.txt), decoded against the EoSD ECL
// VM (refs/EoSDecomp). Patchouli is the stage-4 boss; her fight is a chain of
// elemental spell cards (Fire/Water/Wood/Earth/Metal), each with an EN-rank
// and an H/L-rank variant, dispatched by the boss controller (Sub37, life
// 16000) via ins_115/ins_116 (timeout + sub). Card banners verified in the
// disasm (ins_93 banner strings):
//   Fire   Agni Shine (Sub42, "火符「アグニシャイン」") / Agni Shine Advanced
//          (Sub43) / Agni Radiance (Sub44)
//   Water  Princess Undine (Sub45, "水符「プリンセスウンディネ」") / Berry in
//          Lake (Sub46)
//   Wood   Sylph Horn (Sub47) / Green Storm (Sub49)
//   Earth  Lazy Trilliton (Sub50) / Trilliton Shake (Sub52)
//   Metal  Metal Fatigue (Sub53, "金符「メタルファティーグ」") / Silver Dragon
//          (Sub54)
// EoSD shoot ops map to our emitters: aim_mode 0/1 (ins_67/ins_68) →
// aimed/fan with angleStep; aim_mode 3 (ins_70) → ring; the ins_82 angle
// sweep (±0.0245 rad/f) → per-fire rotStep (rotating rings); ins_20/ins_21
// angle steps → rotating streams. EoSD speeds are px/frame.
// This port uses a representative set, simplified to the engine's emitter
// vocabulary (EN-rank cards for Normal, H/L-rank cards for Lunatic):
//   Normal:  Non-spell, Agni Shine, Princess Undine, Metal Fatigue
//   Lunatic: Non-spell, Agni Shine Advanced, Berry in Lake, Silver Dragon,
//            Agni Radiance
// The non-spell (Sub39) spawns the five elemental entities; simplified to a
// five-element barrage. Palette: fire (orange), water (blue), wood (green),
// earth (gold), metal (silver), with Patchouli's purple (#cc88ff) signature.
//
// WAVE STRUCTURE (the EoSD "setup -> attack" shape, NOT one flat pattern held
// for the whole card). Every card is built as distinct timed WAVES:
//   W1 "Setup"  t=0..~3s    low-density priming / telegraph (the tell before
//                           the barrage — a single slow ring or aimed stream)
//   W2 "Attack" t~3..~10s   the card's SIGNATURE barrage (the ring/spiral/
//                           aimed fan that defines the card)
//   W3 "Turn"   t~10..~14s  the pattern CHANGES — a second, distinct barrage
//                           (EoSD's "then change angle and expand the circle
//                           outwards"; lasers, faster rings, swinging fans)
//   W4 "Tail"   t~14..end   a final, calmer burst as the card winds down
// Waves are contiguous (no empty field) and use the engine's `t` offsets,
// finite `repeat` + `period` (repeating attack blocks with a breather),
// `rotStep` (rotating rings), `angleStep` (swinging aim), and laser `warn`
// (telegraphs). This mirrors the real EoSD card shape: 120f setup move ->
// N attack passes -> 120f tail.

// Non-spell (Sub39, simplified): the five elemental entities' barrage, in
// waves — gather (five-color ring + purple stream) -> fire+water barrage ->
// purple signature fan over wood -> five-color scatter over metal.
const PATCHOULI_NONSPELL = [
  // W1 Setup: the five elements gather — a slow five-color ring and a single
  // slow purple aimed stream (Patchouli's signature).
  { t: 0, type: 'ring', count: 10, speed: 1.2, rotStep: 0.08, interval: 1.0,
    colors: ['#ff8844', '#44aaff', '#66cc66', '#ffcc44', '#ccccdd'], colorStep: 0.6,
    color: '#ff8844', coreColor: '#fff0d0', shape: 'circle', r: 5 },
  { t: 0.5, type: 'aimed', count: 1, speed: 1.6, interval: 0.9,
    color: '#cc88ff', coreColor: '#f0d0ff', shape: 'star', r: 5 },
  // W2 Attack: the element barrage — counter-rotating fire + water rings.
  { t: 3, type: 'ring', count: 16, speed: 2.0, rotStep: 0.12, interval: 0.7,
    color: '#ff8844', coreColor: '#ffe8d0', shape: 'circle', r: 5 },
  { t: 3.3, type: 'ring', count: 16, speed: 1.7, rotStep: -0.14, interval: 0.8,
    color: '#44aaff', coreColor: '#d0ecff', shape: 'circle', r: 5 },
  // W3 Turn: the purple aimed fan (her signature) swings, over a wood ring.
  { t: 9, type: 'aimed', count: 5, spread: 0.5, speed: 2.4, angleStep: 0.4,
    interval: 0.5, color: '#cc88ff', coreColor: '#f0d0ff', shape: 'star', r: 5 },
  { t: 9.2, type: 'ring', count: 12, speed: 1.4, rotStep: 0.1, interval: 1.0,
    color: '#66cc66', coreColor: '#e0ffe0', shape: 'diamond', r: 5 },
  // W4 Tail: the five elements scatter — a five-color ring over a slow metal ring.
  { t: 13, type: 'ring', count: 20, speed: 2.2, rotStep: 0.06, interval: 0.9,
    colors: ['#ff8844', '#44aaff', '#66cc66', '#ffcc44', '#ccccdd'], colorStep: 0.3,
    color: '#ff8844', coreColor: '#fff0d0', shape: 'circle', r: 5 },
  { t: 13.3, type: 'ring', count: 12, speed: 1.0, rotStep: -0.08, interval: 1.1,
    color: '#ccccdd', coreColor: '#ffffff', shape: 'circle', r: 4 },
];

// Fire Sign "Agni Shine" (火符「アグニシャイン」, EoSD Sub42, EN): "waves of
// fireballs that circle around her, then change angle and expand the circle
// outwards." Waves: a single slow fire ring circles her (setup) -> the
// signature three counter-rotating fire rings (speeds 2.2/1.5/0.7, ins_82
// sweep -> rotStep) -> the circle changes angle and expands (fast ring +
// swinging fan) -> a slow ember ring settles (tail).
const PATCHOULI_AGNI_SHINE = [
  // W1 Setup: a single slow fire ring circles her — the circle the attack
  // will expand.
  { t: 0, type: 'ring', count: 12, speed: 1.0, rotStep: 0.1, interval: 1.0,
    color: '#ffaa66', coreColor: '#fff0e0', shape: 'circle', r: 4 },
  // W2 Attack: the signature — three counter-rotating fire rings.
  { t: 3, type: 'ring', count: 18, speed: 2.2, rotStep: 0.16, interval: 0.9,
    color: '#ff8844', coreColor: '#ffe8d0', shape: 'circle', r: 5 },
  { t: 3.3, type: 'ring', count: 18, speed: 1.5, rotStep: -0.16, interval: 1.0,
    color: '#ff6622', coreColor: '#ffe0c0', shape: 'star', r: 5 },
  { t: 3.6, type: 'ring', count: 14, speed: 0.7, rotStep: 0.12, interval: 1.2,
    color: '#ffaa66', coreColor: '#fff0e0', shape: 'circle', r: 4 },
  // W3 Turn: the circle changes angle and expands outward — a fast expanding
  // fire ring plus a swinging fire fan.
  { t: 10, type: 'ring', count: 22, speed: 2.8, rotStep: 0.1, interval: 0.6,
    color: '#ff8844', coreColor: '#ffe8d0', shape: 'circle', r: 5 },
  { t: 10.2, type: 'fan', count: 7, spread: 0.6, speed: 2.4, angleStep: 0.3,
    interval: 0.5, color: '#ffaa66', coreColor: '#fff0e0', shape: 'circle', r: 4 },
  // W4 Tail: the fire settles — a slow ember ring.
  { t: 14, type: 'ring', count: 16, speed: 1.4, rotStep: -0.08, interval: 1.0,
    color: '#ff6622', coreColor: '#ffe0c0', shape: 'circle', r: 4 },
];

// Fire Sign "Agni Shine Advanced" (火符「アグニシャイン上級」, EoSD Sub43,
// H/L): the Agni Shine shape, denser + faster (two counter-rotating fire
// rings, speed 2.0 / L 2.5). Waves: a fast ring primes -> two counter-
// rotating fire rings -> a fast expanding ring + swinging fan -> a fast
// ember ring.
const PATCHOULI_AGNI_ADV = [
  // W1 Setup: a fast single fire ring primes.
  { t: 0, type: 'ring', count: 14, speed: 1.6, rotStep: 0.14, interval: 0.8,
    color: '#ffaa66', coreColor: '#fff0e0', shape: 'circle', r: 4 },
  // W2 Attack: two counter-rotating fire rings (speeds 2.0 / 2.5).
  { t: 3, type: 'ring', count: 22, speed: 2.0, rotStep: 0.18, interval: 0.8,
    color: '#ff8844', coreColor: '#ffe8d0', shape: 'circle', r: 5 },
  { t: 3.3, type: 'ring', count: 22, speed: 2.5, rotStep: -0.18, interval: 0.8,
    color: '#ff5522', coreColor: '#ffe0c0', shape: 'star', r: 5 },
  // W3 Turn: a fast expanding fire ring + a swinging fire fan.
  { t: 10, type: 'ring', count: 26, speed: 3.0, rotStep: 0.12, interval: 0.55,
    color: '#ff8844', coreColor: '#ffe8d0', shape: 'circle', r: 5 },
  { t: 10.2, type: 'fan', count: 9, spread: 0.7, speed: 2.6, angleStep: 0.35,
    interval: 0.45, color: '#ffaa66', coreColor: '#fff0e0', shape: 'circle', r: 4 },
  // W4 Tail: a fast ember ring.
  { t: 14, type: 'ring', count: 18, speed: 2.0, rotStep: -0.1, interval: 0.8,
    color: '#ff6622', coreColor: '#ffe0c0', shape: 'circle', r: 4 },
];

// Water Sign "Princess Undine" (水符「プリンセスウンディネ」, EoSD Sub45,
// EN): an aimed fan (ins_67 mode 0, speed 3.5, spread 0.35) + a rotating
// spiral (ins_21) + 3-way thin lasers (ins_86). Waves: a slow aimed stream +
// ring prime the lake -> the signature spiral + aimed fan -> 3-way thin
// lasers sweep over a faster spiral -> the lake recedes (slow ring + fan).
const PATCHOULI_UNDINE = [
  // W1 Setup: a slow aimed water stream + a slow water ring — the lake stills.
  { t: 0, type: 'aimed', count: 3, spread: 0.3, speed: 1.8, interval: 0.8,
    color: '#88ddff', coreColor: '#e0f4ff', shape: 'circle', r: 4 },
  { t: 0.5, type: 'ring', count: 12, speed: 1.0, rotStep: 0.08, interval: 1.1,
    color: '#44aaff', coreColor: '#d0ecff', shape: 'circle', r: 4 },
  // W2 Attack: the signature — a rotating water spiral over an aimed water
  // fan. (Normal tuning: the spiral fires a touch slower than the Lunatic
  // Berry in Lake version, so the field stays readable.)
  { t: 3, type: 'spiral', arms: 6, rotSpeed: 0.35, speed: 2.5, interval: 0.16,
    color: '#66ccff', coreColor: '#e0f4ff', shape: 'diamond', r: 4 },
  { t: 3.2, type: 'aimed', count: 7, spread: 0.35, speed: 3.5, interval: 0.4,
    color: '#44aaff', coreColor: '#d0ecff', shape: 'circle', r: 5 },
  // W3 Turn: the 3-way thin lasers (EoSD ins_86) sweep, over a faster spiral.
  // Each firing telegraphs (warn) then goes solid; repeat+period gives the
  // attack-block / breather / attack-block rhythm. (Normal tuning: slower
  // sweep + longer refire gap + shorter beam life than Berry in Lake, so the
  // three beams read as distinct sweeps with a clear gap between them.)
  { t: 10, type: 'laser', count: 3, speed: 0, sweep: 0.35,
    interval: 0.7, repeat: 3, period: 4, warn: 1.0, life: 24,
    color: '#66ccff', coreColor: '#e0f4ff', shape: 'diamond', r: 4 },
  { t: 10.3, type: 'spiral', arms: 6, rotSpeed: 0.45, speed: 2.6, interval: 0.14,
    color: '#88ddff', coreColor: '#e0f4ff', shape: 'diamond', r: 4 },
  // W4 Tail: the lake recedes — a slow water ring and a final aimed fan.
  { t: 14, type: 'ring', count: 16, speed: 1.2, rotStep: -0.08, interval: 1.0,
    color: '#44aaff', coreColor: '#d0ecff', shape: 'circle', r: 4 },
  { t: 14.3, type: 'aimed', count: 5, spread: 0.4, speed: 2.2, interval: 0.6,
    color: '#66ccff', coreColor: '#e0f4ff', shape: 'circle', r: 4 },
];

// Water Sign "Berry in Lake" (水符「ベリーインレイク」, EoSD Sub46, H/L): the
// Princess Undine shape, denser + faster (aimed fan ins_69 mode 2, speed 3.0,
// spread 0.4). Waves: a denser stream + ring -> a denser spiral + aimed fan
// -> 2 rotating lasers over a faster spiral -> a denser recede.
const PATCHOULI_BERRY = [
  // W1 Setup: a denser aimed water stream + a water ring.
  { t: 0, type: 'aimed', count: 3, spread: 0.35, speed: 2.0, interval: 0.7,
    color: '#88ddff', coreColor: '#e0f4ff', shape: 'circle', r: 4 },
  { t: 0.5, type: 'ring', count: 14, speed: 1.2, rotStep: 0.1, interval: 0.9,
    color: '#44aaff', coreColor: '#d0ecff', shape: 'circle', r: 4 },
  // W2 Attack: a denser aimed fan + a faster spiral.
  { t: 3, type: 'spiral', arms: 8, rotSpeed: 0.45, speed: 2.8, interval: 0.1,
    color: '#66ccff', coreColor: '#e0f4ff', shape: 'diamond', r: 4 },
  { t: 3.2, type: 'aimed', count: 9, spread: 0.4, speed: 3.0, interval: 0.35,
    color: '#44aaff', coreColor: '#d0ecff', shape: 'circle', r: 5 },
  // W3 Turn: 2 rotating lasers (EoSD) over a faster spiral.
  { t: 10, type: 'laser', count: 2, speed: 0, sweep: 0.6,
    interval: 0.35, repeat: 3, period: 4, warn: 1.0, life: 30,
    color: '#66ccff', coreColor: '#e0f4ff', shape: 'diamond', r: 4 },
  { t: 10.3, type: 'spiral', arms: 10, rotSpeed: 0.55, speed: 3.0, interval: 0.09,
    color: '#88ddff', coreColor: '#e0f4ff', shape: 'diamond', r: 4 },
  // W4 Tail: a denser water ring + aimed fan.
  { t: 14, type: 'ring', count: 18, speed: 1.4, rotStep: -0.1, interval: 0.9,
    color: '#44aaff', coreColor: '#d0ecff', shape: 'circle', r: 4 },
  { t: 14.3, type: 'aimed', count: 7, spread: 0.45, speed: 2.4, interval: 0.55,
    color: '#66ccff', coreColor: '#e0f4ff', shape: 'circle', r: 4 },
];

// Metal Sign "Metal Fatigue" (金符「メタルファティーグ」, EoSD Sub53, EN): a
// fast rotating ring (ins_70 mode 3, speed 4.0) whose base angle steps by π/4
// each pass (ins_20) — a "rotating stream" of silver bullets. Waves: a slow
// steel ring primes -> the signature fast silver ring (π/4 per-fire step) ->
// a counter-rotating steel ring over a swinging metal fan -> a slow steel
// ring settles.
const PATCHOULI_METAL_FATIGUE = [
  // W1 Setup: a slow steel ring primes.
  { t: 0, type: 'ring', count: 12, speed: 1.6, rotStep: 0.2, interval: 0.9,
    color: '#aabbcc', coreColor: '#eef0ff', shape: 'circle', r: 4 },
  // W2 Attack: the signature — a fast silver ring whose base angle steps π/4
  // per firing (EoSD ins_20, 8 passes). 18 bullets (not a multiple of 8) so
  // the π/4 rotation is visible.
  { t: 3, type: 'ring', count: 18, speed: 4.0, rotStep: 0.7854, interval: 0.5,
    color: '#ccccdd', coreColor: '#ffffff', shape: 'diamond', r: 5 },
  // W3 Turn: a counter-rotating steel ring over a swinging metal fan.
  { t: 10, type: 'ring', count: 16, speed: 2.4, rotStep: -0.4, interval: 0.6,
    color: '#aabbcc', coreColor: '#eef0ff', shape: 'circle', r: 4 },
  { t: 10.2, type: 'fan', count: 7, spread: 0.5, speed: 2.6, angleStep: 0.4,
    interval: 0.5, color: '#ccccdd', coreColor: '#ffffff', shape: 'diamond', r: 4 },
  // W4 Tail: a slow steel ring.
  { t: 14, type: 'ring', count: 14, speed: 1.6, rotStep: 0.15, interval: 0.9,
    color: '#aabbcc', coreColor: '#eef0ff', shape: 'circle', r: 4 },
];

// Metal Sign "Silver Dragon" (金符「シルバードラゴン」, EoSD Sub54, H/L): a
// very fast rotating ring (ins_70 mode 3, speed 6.0) — the "silver dragon"
// stream. Waves: a fast steel ring primes -> the signature very fast silver
// ring -> a counter-rotating fast ring over a swinging metal fan -> a fast
// steel ring.
const PATCHOULI_SILVER_DRAGON = [
  // W1 Setup: a fast steel ring primes.
  { t: 0, type: 'ring', count: 14, speed: 2.4, rotStep: 0.3, interval: 0.7,
    color: '#aabbcc', coreColor: '#eef0ff', shape: 'circle', r: 4 },
  // W2 Attack: the "silver dragon" — a very fast rotating silver ring.
  { t: 3, type: 'ring', count: 18, speed: 6.0, rotStep: 0.5, interval: 0.4,
    color: '#ccccdd', coreColor: '#ffffff', shape: 'diamond', r: 5 },
  // W3 Turn: a counter-rotating fast ring over a swinging metal fan.
  { t: 10, type: 'ring', count: 16, speed: 3.5, rotStep: -0.3, interval: 0.5,
    color: '#aabbcc', coreColor: '#eef0ff', shape: 'circle', r: 4 },
  { t: 10.2, type: 'fan', count: 9, spread: 0.6, speed: 3.0, angleStep: 0.45,
    interval: 0.45, color: '#ccccdd', coreColor: '#ffffff', shape: 'diamond', r: 4 },
  // W4 Tail: a fast steel ring.
  { t: 14, type: 'ring', count: 16, speed: 2.8, rotStep: 0.2, interval: 0.7,
    color: '#aabbcc', coreColor: '#eef0ff', shape: 'circle', r: 4 },
];

// Fire Sign "Agni Radiance" (火符「アグニレイディアンス」, EoSD Sub44, H/L
// finale): two counter-rotating fire rings (speeds 1.5/2.0) + large
// random-angle fire bullets (ins_75). Waves: a slow fire ring + a single
// large bullet prime -> two counter-rotating fire rings -> large fire
// bullets at sweeping angles over a swinging fan -> a slow fire ring + fan
// settle.
const PATCHOULI_AGNI_RADIANCE = [
  // W1 Setup: a slow fire ring + a single large fire bullet.
  { t: 0, type: 'ring', count: 12, speed: 1.2, rotStep: 0.1, interval: 1.0,
    color: '#ffaa66', coreColor: '#fff0e0', shape: 'circle', r: 4 },
  { t: 0.5, type: 'aimed', count: 1, speed: 2.0, interval: 1.2,
    color: '#ffcc44', coreColor: '#fff0d0', shape: 'star', r: 6 },
  // W2 Attack: two counter-rotating fire rings (speeds 1.5 / 2.0).
  { t: 3, type: 'ring', count: 16, speed: 1.5, rotStep: 0.14, interval: 0.9,
    color: '#ff8844', coreColor: '#ffe8d0', shape: 'circle', r: 5 },
  { t: 3.3, type: 'ring', count: 16, speed: 2.0, rotStep: -0.14, interval: 0.9,
    color: '#ff6622', coreColor: '#ffe0c0', shape: 'star', r: 5 },
  // W3 Turn: large fire bullets at sweeping angles (EoSD ins_75) over a
  // swinging fire fan.
  { t: 10, type: 'aimed', count: 3, spread: 0.3, speed: 3.0, angleStep: 0.5,
    interval: 0.8, color: '#ffcc44', coreColor: '#fff0d0', shape: 'star', r: 6 },
  { t: 10.2, type: 'fan', count: 7, spread: 0.6, speed: 2.4, angleStep: 0.35,
    interval: 0.55, color: '#ffaa66', coreColor: '#fff0e0', shape: 'circle', r: 4 },
  // W4 Tail: a slow fire ring + a slow aimed fan.
  { t: 14, type: 'ring', count: 18, speed: 1.4, rotStep: -0.08, interval: 1.0,
    color: '#ff8844', coreColor: '#ffe8d0', shape: 'circle', r: 4 },
  { t: 14.3, type: 'aimed', count: 5, spread: 0.5, speed: 2.2, angleStep: 0.35,
    interval: 0.6, color: '#ffaa66', coreColor: '#fff0e0', shape: 'star', r: 5 },
];

// ── Yuyuko — Rook (value 5). Death / butterfly / cherry-blossom. ──────────
// Pattern mechanics mined from the REAL PCCB (Touhou 7) stage-6 ECL script
// (pcb_extract/disasm/ecldata6.txt), decoded against the PCCB ECL VM. TH07
// reuses the EoSD ECL engine; opcode authority is refs/th07/src/th07/
// EclManager.hpp (ECL_* enum) + refs/EoSDecomp. Yuyuko is the stage-6 boss
// and main antagonist of PCCB. Card banners verified in the disasm (ins_90
// banner strings; rank 0 = non-spell, 3 = spell, -1 = final spell):
//   Rikudōken "Ichinen Mugyōkō" (Sub23, "六道剣「一念無量劫」", non-spell),
//   Bō "Bōgakyō" (Sub43-47, "亡郷「亡我郷」"), Bōbu "Seishasha Hitsumetsu no
//   Kotowari" (Sub50-51, "亡舞「生者必滅の理」"), Karei "Ghost Butterfly"
//   (Sub52-54, "華霊「ゴーストバタフライ」"), Yūkyoku "Repository of Hirokawa"
//   (Sub55-57, "幽曲「リポジトリ・オブ・ヒロカワ」"), Ōfu "Kanzen naru
//   Sumizome no Sakura" (Sub58-59, "桜符「完全なる墨染の桜」"), Hankondō
//   (Sub62-68, "「反魂蝶」", final spell).
// PCCB shoot ops map to our emitters: ins_54 sets the aim (mode 4 = player,
// speed); ins_64/ins_65/ins_67 are the shoot ops (aim_mode, count, ..., speed,
// spread, ..., angleStep); ins_52 is a random angle in [-π, π]; ins_79
// (ECL_INIT_BULLET_CMD) sets per-group bullet physics (the angle/speed
// acceleration that makes Bōgakyō's bullets curve); ins_93/ins_92 spawn the
// sub-enemies (the butterflies); ins_100 spawns the decorative effects.
// This port uses five of them, simplified to the engine's emitter vocabulary:
//   Normal:  Non-spell, Bō "Bōgakyō", Bōbu "Seishasha Hitsumetsu no Kotowari",
//            Karei "Ghost Butterfly"
//   Lunatic: + Hankondō (final spell)
// Yuyuko's palette is cold blue (#6688ff / #88aaff) with violet (#9966ff) and
// pink cherry-blossom (#ff99cc) accents.
//
// NOTE: Yuyuko stays `move: 'still'` — her PCCB patterns fire from a
// mostly-static position (the boss drifts a few px via ins_55, but the cards
// are authored around a fixed origin), so a static boss keeps the patterns
// true to the source.

// Build `count` one-shot butterfly (doll) emits evenly spaced around a full
// circle. Used for the Karei/Hankondō butterfly swarms. `o.orbitRadius`/
// `o.orbitSpeed` make the butterflies orbit Yuyuko (the PCCB butterflies circle
// the boss); omit them for straight-flyers.
function yuyukoButterflyEmits(count, o) {
  const arr = [];
  for (let i = 0; i < count; i++) {
    arr.push({
      t: (o.t0 || 0) + i * (o.stagger || 0.15),
      type: 'doll',
      count: 1,
      angle: (i / count) * TAU_LOCAL, // even full-circle start positions
      repeat: 1,                       // fire ONCE (see the note above)
      speed: o.speed !== undefined ? o.speed : 0,
      orbitRadius: o.orbitRadius,
      orbitSpeed: o.orbitSpeed,
      hp: o.hp || 3,
      r: o.r || 10,
      shape: 'petal',
      interval: o.interval,
      color: o.color,
      coreColor: o.coreColor,
      shoot: o.shoot,
      deathBurst: o.deathBurst,
      destructible: o.destructible,
    });
  }
  return arr;
}

// Rikudōken "Ichinen Mugyōkō" (六道剣「一念無量劫」, PCCB Sub19-22, non-spell):
// a rotating 29-bullet ring (Sub20: each ring offset 5.6° from the last,
// expanding radially) plus a 6-bullet aimed fan (Sub21, 22.5° spread) and a
// 2-bullet aimed stream (Sub22, 30° spread), the aim re-randomized between
// bursts (ins_52/ins_54). Simplified to a rotating ring + two aimed streams.
const YUYUKO_NONSPELL = [
  // Rotating 29-bullet ring (Sub20): the signature expanding spiral.
  { t: 0, type: 'ring', count: 29, speed: 2.0, rotStep: 0.098, interval: 0.35,
    color: '#6688ff', coreColor: '#d0dcff', shape: 'petal', r: 5 },
  // 6-bullet aimed fan (Sub21, 22.5° spread) — 5 per the house rule.
  { t: 0.3, type: 'aimed', count: 5, spread: 0.39, speed: 3.5, angleStep: 0.42,
    interval: 0.3, color: '#88aaff', coreColor: '#e0e8ff', shape: 'circle', r: 4 },
  // 2-bullet aimed stream (Sub22, 30° spread) — 3 per the house rule.
  { t: 0.6, type: 'aimed', count: 3, spread: 0.52, speed: 3.5, angleStep: -0.42,
    interval: 0.3, color: '#9966ff', coreColor: '#e0d0ff', shape: 'diamond', r: 4 },
];

// Bō "Bōgakyō" (亡郷「亡我郷」, PCCB Sub43-47): the curved-bullet card. Four
// bullet groups (ins_79) each with a different angle/speed acceleration, fired
// as rotating 8-10-way fans (30° spread, speed 3.7-4.2) whose whole fan rotates
// (angle += 2.25°/fire). `turn` banks each bullet (the card's signature curve).
// NOTE: turn must be GENTLE (0.004, not 0.02) — a 0.02 bank at speed 3.8 is a
// 190px-radius circle, so each bullet curves ~105° before reaching the player's
// y-level and sweeps off to the side (the card then reads "close 224px /
// moved 0px" — a non-threat). 0.004 keeps a visible curve while the bullets
// still reach the player. A straight aimed layer guarantees the threat.
const YUYUKO_BO_GA_KYO = [
  // Rotating curved fan (Sub44-47): 9 curved bullets, gentle bank.
  { t: 0, type: 'fan', count: 9, spread: 0.52, speed: 3.8, turn: 0.004,
    angleStep: 0.039, interval: 0.3,
    color: '#6688ff', coreColor: '#d0dcff', shape: 'petal', r: 5 },
  // Counter-rotating curved fan (the second group).
  { t: 0.15, type: 'fan', count: 11, spread: 0.52, speed: 3.8, turn: -0.004,
    angleStep: -0.039, interval: 0.3,
    color: '#88aaff', coreColor: '#e0e8ff', shape: 'circle', r: 4 },
  // Straight aimed stream (the card's "aimed" layer — guarantees a real
  // threat, since the curved fans drift off the aim line).
  { t: 0.3, type: 'aimed', count: 3, spread: 0.3, speed: 3.5,
    interval: 0.4, color: '#9966ff', coreColor: '#e0d0ff', shape: 'diamond', r: 4 },
  // A slower straight ring for depth (the outer layer).
  { t: 0.5, type: 'ring', count: 18, speed: 2.2, rotStep: 0.06,
    interval: 0.6, color: '#6688ff', coreColor: '#d0dcff', shape: 'petal', r: 5 },
];

// Bōbu "Seishasha Hitsumetsu no Kotowari" (亡舞「生者必滅の理」, PCCB Sub50-51):
// the accelerating-bullet card. Rings and aimed volleys that build in speed
// (the ins_79 groups accelerate the bullets; here approximated with speedStep,
// each volley faster than the last) — the "inevitable death of the living"
// build.
const YUYUKO_SEISHASHA = [
  // Accelerating aimed volley (Sub51, speed 3.4/3.7).
  { t: 0, type: 'aimed', count: 5, spread: 0.52, speed: 2.2, speedStep: 0.05,
    interval: 0.4, color: '#6688ff', coreColor: '#d0dcff', shape: 'petal', r: 5 },
  // Slow expanding ring (Sub51, ins_67 count 4, speed 1.4) that builds.
  { t: 0.2, type: 'ring', count: 14, speed: 1.4, speedStep: 0.04, rotStep: 0.08,
    interval: 0.5, color: '#88aaff', coreColor: '#e0e8ff', shape: 'circle', r: 4 },
  // Counter-rotating ring (the card's second layer).
  { t: 0.4, type: 'ring', count: 16, speed: 1.8, speedStep: 0.05, rotStep: -0.08,
    interval: 0.55, color: '#9966ff', coreColor: '#e0d0ff', shape: 'diamond', r: 4 },
];

// Karei "Ghost Butterfly" (華霊「ゴーストバタフライ」, PCCB Sub52-54): the
// butterfly card. A butterfly hovers near Yuyuko and fires curved 8-bullet
// rings/spreads (Sub53: two 8-rings at speed 0.8/1.46 curving ±4.5°/fire, two
// narrow 8-spreads at 11.25° and speed 2.4/3.2 curving ±5.1°/fire), plus a
// periodic 7-bullet ring that re-fires every second with its base angle
// advancing 1.5°/s (Sub54, speed 2.0 N / 2.5 L). Simplified to 6 orbiting
// butterflies (dolls) that each shed a ring AND an aimed fan every 0.7s
// (the real card's narrow 11.25° 8-spreads are effectively aimed lines —
// the card's main threat — flattened to a 3-way aimed fan), plus the Sub54
// rotating 7-ring from the boss.
// NOTE: a blind ring alone made this card a non-threat (a stationary player
// sits between the 8 ring spokes and takes nothing — "close 86px, moved 0px").
// The aimed fan is what forces movement.
const YUYUKO_GHOST_BUTTERFLY = [
  ...yuyukoButterflyEmits(6, {
    orbitRadius: 90, orbitSpeed: 0.02,   // 6 butterflies circle Yuyuko
    speed: 0, interval: 0.7,
    color: '#88ccff', coreColor: '#e8f4ff',
    // The orbiting butterflies are the spell's emitters (PCCB Sub53 entities),
    // not hazards: invulnerable, so the player's fire can't empty the card by
    // shooting them down (the bullets they fire stay shootable).
    destructible: false,
    // Each butterfly sheds TWO patterns per tick (the doll emitter accepts an
    // array of shoot emits): the "butterfly transforms into bullets" ring
    // (Sub53's 8-ring) and an aimed 3-fan (Sub53's narrow 8-spreads).
    shoot: [
      { type: 'ring', count: 8, speed: 1.6,
        color: '#6688ff', coreColor: '#d0dcff', shape: 'petal', r: 4 },
      { type: 'aimed', count: 3, spread: 0.25, speed: 2.2,
        color: '#88ccff', coreColor: '#e8f4ff', shape: 'diamond', r: 4 },
    ],
  }),
  // The periodic 7-bullet rotating ring (Sub54: re-fires every 1s, base angle
  // +1.5°/s, speed 2.0 N / 2.5 L — the card's slow sweeping layer).
  { t: 0.3, type: 'ring', count: 7, speed: 2.0, rotStep: 0.026, interval: 0.8,
    color: '#88ccff', coreColor: '#e8f4ff', shape: 'petal', r: 4 },
];

// Hankondō (「反魂蝶」, PCCB Sub62-68, final spell): the Butterfly
// Reincarnation survival card. Butterflies circle Yuyuko and burst into rings,
// while a rotating laser (Sub67/68, the "butterfly transforms into a laser"
// mechanic) sweeps the screen and cherry-blossom petals drift (the
// "reincarnation" theme). The butterflies shed the same ring + aimed-fan pair
// as Ghost Butterfly (faster, 10-wide rings) so the Lunatic finale keeps the
// aimed threat.
const YUYUKO_HANKONDO = [
  // Butterflies (Sub62): orbiting dolls that burst into rings + aimed fans.
  ...yuyukoButterflyEmits(6, {
    orbitRadius: 100, orbitSpeed: 0.025,
    speed: 0, interval: 0.6,
    color: '#88ccff', coreColor: '#e8f4ff',
    destructible: false,
    shoot: [
      { type: 'ring', count: 10, speed: 1.8,
        color: '#6688ff', coreColor: '#d0dcff', shape: 'petal', r: 4 },
      { type: 'aimed', count: 3, spread: 0.25, speed: 2.4,
        color: '#88ccff', coreColor: '#e8f4ff', shape: 'diamond', r: 4 },
    ],
  }),
  // The butterfly-laser (Sub67/68): a rotating laser that sweeps the screen.
  { t: 0.5, type: 'laser', count: 1, speed: 2.0, laserLen: 80, sweep: 0.6,
    warn: 0.4, life: 90, interval: 0.5,
    color: '#6688ff', coreColor: '#d0dcff', shape: 'petal' },
  // Cherry-blossom ring (the "reincarnation" petals).
  { t: 0.3, type: 'ring', count: 20, speed: 1.6, rotStep: 0.1, interval: 0.8,
    color: '#ff99cc', coreColor: '#ffd0e8', shape: 'petal', r: 5 },
];

const BOSSES = {
  // ── Rumia — Pawn (value 1). Top-center, nocturnal danmaku. ──
  // Pattern mechanics mined from the REAL EoSD (Touhou 6) stage-1 ECL script
  // (eosd_extract/ecl/disasm/ecldata1_utf8.txt), decoded against the
  // decompiled ECL VM + BulletManager (refs/EoSDecomp/src/...). Card list
  // follows the EoSD fight order: non-spell first, then the midboss spell
  // (Hard/Lunatic only), Night Bird, Demarcation.
  //   Normal:  Nocturnal Danmaku (non-spell), Night Sign "Night Bird",
  //            Darkness Sign "Demarcation"
  //   Lunatic: + Moon Sign "Moonlight Ray" (midboss spell, Hard/Lunatic only)
  rumia: {
    name: 'Rumia',
    // Balance tuning (applyTune): per-difficulty multipliers on top of the
    // default scaling. Targets: Normal ~78% win, Lunatic ~15% win.
    tune: {
      normal:  { durationMul: 0.75, densityMul: 0.75 },
      lunatic: { durationMul: 0.8,  densityMul: 0.8 },
    },
    color: '#9a8cff',
    bgTop: '#0b0b1e',
    bgBottom: '#04040a',
    move: 'still',
    // Every card runs ~25s (house rule: spell cards stay in the 15-25s
    // window, even faithful EoSD recreations — the patterns loop on their
    // own cycles, so the clock is compressed, not the design). Gauges are
    // sized to that duration: strong pieces (king/queen) break a card well
    // before it times out (the reward for firepower); knight/pawn endure
    // the full 25s (pure survival).
    phases: {
      normal: [
        {
          // Nocturnal Danmaku (non-spell, EoSD Sub0-Sub3): the night-bird
          // swarm — swinging single-aim streams (speed 3), sweeping
          // 7-bullet 36° aimed fans (N rank) and narrow counter-sweeping
          // 5-bullet 15° fans, all on slow 6-12s cycles. Dark blue-black
          // night sky.
          name: 'Nocturnal Danmaku (non-spell)',
          duration: 25,
          hp: 160,
          bgTop: '#0c0e24',
          bgBottom: '#04050e',
          emits: RUMIA_NONSPELL,
        },
        {
          // Night Sign "Night Bird" (夜符「ナイトバード」, EoSD spell #1):
          // four sweeping streams of single aimed shots — bases at
          // ∓32.7°/∓45° stepping ∓8.2°/∓11.25° per shot, speed accelerating
          // 1.0 -> 3.8 within each stream, two streams on a slow 10-frame
          // cadence. The 4-block pass repeats with a drift gap. Dark
          // smoky-brown night sky.
          name: 'Night Sign "Night Bird"',
          duration: 25,
          hp: 180,
          bgTop: '#1a120c',
          bgBottom: '#0a0604',
          emits: RUMIA_NIGHT_BIRD,
        },
        {
          // Darkness Sign "Demarcation" (闇符「ディマーケイション」, EoSD
          // spell #2): the barrage machine — color-cycling bullets (white
          // -> blue-gray -> green -> red) mixing player-aligned ring pairs,
          // single-aim sweeps, small aimed fans + thin laser, big
          // player-aligned rings, 28-way aimed streams, wide fans and
          // escalating aimed streams. Deep purple-black sky.
          name: 'Darkness Sign "Demarcation"',
          duration: 25,
          hp: 200,
          bgTop: '#120a1e',
          bgBottom: '#05030a',
          emits: RUMIA_DEMARCATION,
        },
      ],
      lunatic: [
        {
          // Nocturnal Danmaku (non-spell, Lunatic): same card as Normal,
          // scaled up (denser fans, faster streams).
          name: 'Nocturnal Danmaku (non-spell)',
          duration: 25,
          hp: 190,
          bgTop: '#0c0e24',
          bgBottom: '#04050e',
          emits: RUMIA_NONSPELL,
        },
        {
          // Moon Sign "Moonlight Ray" (月符「ムーンライトレイ」, EoSD
          // midboss spell #0, Hard/Lunatic only): 42-way 90° fans starting
          // at the aim line (first bullet dead on the player) every 40
          // frames, plus two thick moonbeams (width 32) radiating from the
          // boss 67.5° off vertical on each side, sweeping toward each
          // other at 0.496 rad/s for 2s, rest 1s, repeat. Deep navy night
          // sky.
          name: 'Moon Sign "Moonlight Ray"',
          duration: 25,
          hp: 200,
          bgTop: '#0a0f2e',
          bgBottom: '#03040c',
          beams: [
            // Two closing moonbeams (EoSD ins_85: rays from the boss,
            // start 22.5°/157.5° from horizontal, ±0.00827 rad/frame =
            // 0.496 rad/s, 120f on / 60f off). In beam-model angles (from
            // vertical): ±67.5°, sweeping toward each other; pivot at the
            // boss so they radiate from her like the original. Infinitely
            // long rays, solid immediately (they don't aim at the player).
            {
              t: 1, angle: 1.1781, sweep: -0.496, dur: 2, period: 3, width: 32,
              y0: 90, pivot: 'top',
              color: '#fff3b0', coreColor: '#ffffff'
            },
            {
              t: 1, angle: -1.1781, sweep: 0.496, dur: 2, period: 3, width: 32,
              y0: 90, pivot: 'top',
              color: '#fff3b0', coreColor: '#ffffff'
            },
          ],
          emits: RUMIA_MOONLIGHT,
        },
        {
          // Night Sign "Night Bird" (Lunatic): same card as Normal; Lunatic
          // scaling (speed/density multipliers) makes it faster.
          name: 'Night Sign "Night Bird"',
          duration: 25,
          hp: 210,
          bgTop: '#1a120c',
          bgBottom: '#0a0604',
          emits: RUMIA_NIGHT_BIRD_LUN,
        },
        {
          // Darkness Sign "Demarcation" (Lunatic): same card as Normal,
          // scaled up (denser rings/fans, faster streams).
          name: 'Darkness Sign "Demarcation"',
          duration: 25,
          hp: 220,
          bgTop: '#120a1e',
          bgBottom: '#05030a',
          emits: RUMIA_DEMARCATION,
        },
      ],
    },
  },

  nitori: {
    name: 'Nitori',
    // Nitori's aimed patterns are intrinsically dense — ease Normal a lot so
    // low-DPS pieces can survive the full card duration. Targets: Normal ~85%
    // win, Lunatic ~15% win.
    tune: {
      // Nitori is a KNIGHT's boss — one of the EASIEST (with Rumia/Hina). Her
      // oozing patterns are intrinsically dense, so Normal is eased well below
      // authored values; Lunatic stays tuned independently.
      normal:  { durationMul: 0.33, densityMul: 0.28 },
      lunatic: { durationMul: 0.6,  densityMul: 0.6 },
    },
    color: '#55ccff',
    bgTop: '#061420',
    bgBottom: '#020810',
    move: 'slide',
    holdDur: 2.5, slideDur: 0.5, slideDist: 150,
    phases: {
      normal: [
        {
          // Non-spell (MoF Boss2_at/Boss2_at2 interlude): three slow streams
          // splaying downward that ping-pong-sweep, plus a steady 5-way fan.
          // Dark river water.
          name: 'Water Stream (non-spell)',
          duration: 25,
          hp: 100,
          bgTop: '#061420',
          bgBottom: '#020810',
          emits: NITORI_NONSPELL,
        },
        {
          // Flood "Ooze Flooding" (洪水「ウーズフラッディング」, MoF card 1,
          // E/N): slow ooze drips from both screen edges aimed at the player,
          // with central 9-way fan bursts. Greenish flood water.
          name: 'Flood "Ooze Flooding"',
          duration: 25,
          hp: 120,
          bgTop: '#0a1a14',
          bgBottom: '#030a06',
          emits: NITORI_OOZE,
        },
        {
          // Water Sign "Kappa's Pororoca" (水符「河童のポロロッカ」, MoF card
          // 2, E/N): a tidal bore — metronome spouts along the top whose slow
          // bullets sweep back and forth across the lower half of the field.
          // Stormy deep blue.
          name: 'Water Sign "Kappa\'s Pororoca"',
          duration: 25,
          hp: 130,
          bgTop: '#081828',
          bgBottom: '#02060c',
          emits: NITORI_POROROCA,
        },
        {
          // Kappa "Monster Cucumber" (河童「お化けキューカンバー」, MoF card
          // 3, E/N): the rolling 32-ray aimed barrage (2-row speed peel) plus
          // counter-rotating 9-ray laser fans. Swampy teal.
          name: 'Kappa "Monster Cucumber"',
          duration: 25,
          hp: 140,
          bgTop: '#0a1a1a',
          bgBottom: '#030808',
          emits: NITORI_CUCUMBER,
        },
      ],
      lunatic: [
        {
          // Non-spell (Lunatic): same card as Normal, scaled up (faster
          // streams, denser fan).
          name: 'Water Stream (non-spell)',
          duration: 25,
          hp: 120,
          bgTop: '#061420',
          bgBottom: '#020810',
          emits: NITORI_NONSPELL,
        },
        {
          // Flood "Deluvial Mare" (洪水「デリューヴィアルメア」, MoF card 1,
          // Hard): the Ooze Flooding pattern at Lunatic scale — the Hard
          // variant adds curving droplets (ins_409 flag 8192), approximated
          // by the density/speed scaling.
          name: 'Flood "Deluvial Mare"',
          duration: 25,
          hp: 140,
          bgTop: '#0a1a14',
          bgBottom: '#030a06',
          emits: NITORI_OOZE,
        },
        {
          // Water Sign "Kappa's Flash Flood" (水符「河童のフラッシュフラッド」,
          // MoF card 2, Hard): the Pororoca bore at Lunatic scale — the Hard
          // variant's curving bullets and higher speed come from the scaling.
          name: 'Water Sign "Kappa\'s Flash Flood"',
          duration: 25,
          hp: 150,
          bgTop: '#081828',
          bgBottom: '#02060c',
          emits: NITORI_POROROCA,
        },
        {
          // Kappa "Spin the Cephalic Plate" (河童「スピン・ザ・セファリック
          // プレート」, MoF card 3, Lunatic-only — rank L runs BossCard3L
          // instead of BossCard3): dense spinning 56-bullet aimed needles
          // (speed 4.0 -> 2.5), a thin slow drift, and curving droplets.
          // Bright cyan.
          name: 'Kappa "Spin the Cephalic Plate"',
          duration: 25,
          hp: 160,
          bgTop: '#0a2030',
          bgBottom: '#031018',
          emits: NITORI_SPIN_PLATE,
        },
      ],
    },
  },


  // ── Hina Kagiyama — Knight (value 3). Misfortune-doll (nagashi-bina) ──
  // themes: streams of bad luck, a wheel of misfortune, and a flowing
  // barrage. Real MoF (TH10) stage-2 final-boss patterns — see the
  // HINA_* constants above for the full decode.
  hina: {
    name: 'Hina',
    // Hina's Normal is about right; her Lunatic was over-hardened (1.7%) —
    // ease it back toward ~15%. Targets: Normal ~80% win, Lunatic ~15% win.
    tune: {
      normal:  { durationMul: 0.7,  densityMul: 0.7 },
      lunatic: { durationMul: 1.0,  densityMul: 1.1 },
    },
    color: '#ff8899',
    bgTop: '#1a0a10',
    bgBottom: '#08030a',
    move: 'slide',
    holdDur: 3, slideDur: 0.6, slideDist: 120,
    phases: {
      normal: [
        {
          // Non-spell (MoF Boss1/Boss1At): a continuous 8-way aimed stream
          // of misfortune plus five dense 32-shot aimed bursts in a row.
          // Dark misfortune red.
          name: 'Misfortune (non-spell)',
          duration: 16,
          hp: 110,
          bgTop: '#1a0a10',
          bgBottom: '#08030a',
          emits: HINA_NONSPELL,
        },
        {
          // Broken Amulet (疵符「ブロークンアミュレット」, MoF card 1, E/N):
          // a ring of eight side-shooters around the doll, each raining a
          // slow 5-way player-aimed fan. Pale broken-ward pink.
          name: 'Broken Amulet',
          duration: 18,
          hp: 130,
          bgTop: '#1c0a12',
          bgBottom: '#08030a',
          emits: HINA_BROKEN_AMULET,
        },
        {
          // Misfortune's Wheel (悪霊「ミスフォーチュンズホイール」, MoF card
          // 2, E/N): two counter-rotating rings of large curving bullets
          // (the wheel of misfortune) with a slow aimed hub. Golden wheel.
          name: 'Misfortune\'s Wheel',
          duration: 18,
          hp: 140,
          bgTop: '#180e04',
          bgBottom: '#080402',
          emits: HINA_WHEEL,
        },
        {
          // Pain Flow (創符「ペインフロー」, MoF card 3, E/N): fast- and
          // counter-rotating 5-way fans plus four cardinal side-shooters —
          // a flowing, layered barrage. Violet flow.
          name: 'Pain Flow',
          duration: 18,
          hp: 150,
          bgTop: '#140a1c',
          bgBottom: '#060308',
          emits: HINA_PAIN_FLOW,
        },
      ],
      lunatic: [
        {
          // Non-spell (Lunatic): same card as Normal, scaled up (faster
          // streams, denser bursts).
          name: 'Misfortune (non-spell)',
          duration: 16,
          hp: 120,
          bgTop: '#1a0a10',
          bgBottom: '#08030a',
          emits: HINA_NONSPELL,
        },
        {
          // Broken Charm of Protection (疵痕「壊されたお守り」, MoF card 1,
          // H/L): the Broken Amulet pattern at Lunatic scale.
          name: 'Broken Charm of Protection',
          duration: 18,
          hp: 140,
          bgTop: '#1c0a12',
          bgBottom: '#08030a',
          emits: HINA_BROKEN_AMULET,
        },
        {
          // Old Lady Ohgane's Fire (悲運「大鐘婆の火」, MoF card 2, H/L):
          // the Misfortune's Wheel pattern at Lunatic scale.
          name: 'Old Lady Ohgane\'s Fire',
          duration: 18,
          hp: 150,
          bgTop: '#180e04',
          bgBottom: '#080402',
          emits: HINA_WHEEL,
        },
        {
          // Exiled Doll (創符「流刑人形」, MoF card 3, H/L): the Pain Flow
          // pattern at Lunatic scale.
          name: 'Exiled Doll',
          duration: 18,
          hp: 160,
          bgTop: '#140a1c',
          bgBottom: '#060308',
          emits: HINA_PAIN_FLOW,
        },
      ],
    },
  },

  // ── Patchouli — Bishop (value 3). Elemental magic. ──
  // Real EoSD (Touhou 6) stage-4 elemental cards, mined from ecldata4 (see
  // the PATCHOULI_* constants above for the disasm provenance).
  patchouli: {
    name: 'Patchouli',
    // Normal is about right; Lunatic was a touch over-hardened (5%) — ease it
    // toward ~18%. Targets: Normal ~77% win, Lunatic ~18% win.
    tune: {
      normal:  { durationMul: 0.85, densityMul: 0.9 },
      lunatic: { durationMul: 0.9,  densityMul: 1.0 },
    },
    color: '#cc88ff',
    bgTop: '#140a20',
    bgBottom: '#08040e',
    move: 'still',
    phases: {
      normal: [
        { name: 'Non-spell', duration: 16, hp: 100, emits: PATCHOULI_NONSPELL },
        { name: 'Fire Sign "Agni Shine"', duration: 17, hp: 120, emits: PATCHOULI_AGNI_SHINE },
        { name: 'Water Sign "Princess Undine"', duration: 18, hp: 130, emits: PATCHOULI_UNDINE },
        { name: 'Metal Sign "Metal Fatigue"', duration: 18, hp: 140, emits: PATCHOULI_METAL_FATIGUE },
      ],
      lunatic: [
        { name: 'Non-spell', duration: 16, hp: 110, emits: PATCHOULI_NONSPELL },
        { name: 'Fire Sign "Agni Shine Advanced"', duration: 17, hp: 130, emits: PATCHOULI_AGNI_ADV },
        { name: 'Water Sign "Berry in Lake"', duration: 18, hp: 140, emits: PATCHOULI_BERRY },
        { name: 'Metal Sign "Silver Dragon"', duration: 18, hp: 150, emits: PATCHOULI_SILVER_DRAGON },
        { name: 'Fire Sign "Agni Radiance"', duration: 18, hp: 160, emits: PATCHOULI_AGNI_RADIANCE },
      ],
    },
  },

  // ── Alice — Bishop (value 3). Dolls. ──
  alice: {
    name: 'Alice',
    // Alice's doll cards are intrinsically sparse — the bot dodges them at any
    // density up to ~1.5x (a hard 100% -> 43% cliff, no clean middle), so she
    // stays at authored Normal density: she's the EASIEST boss (Normal ~100%),
    // which is thematically right for the gentle puppeteer. Her Lunatic is
    // hardened via the densityMul 1.4 (Normal ~100% / Lunatic ~22%).
    tune: {
      normal:  { durationMul: 1.0, densityMul: 1.0 },
      lunatic: { durationMul: 1.0, densityMul: 1.4 },
    },
    color: '#cc66ff',
    bgTop: '#1a0a24',
    bgBottom: '#0a0410',
    move: 'slide',
    holdDur: 3, slideDur: 0.6, slideDist: 130,
    // Alice's Lunatic spell cards are tuned harder than the global default.
    // The doll cards (French/Dutch/Bunraku) put their bullets in the doll's
    // nested `shoot`, which the global scale never reached — so they barely
    // changed on Lunatic and felt too easy. `nestedDensity` densifies those
    // bullet patterns (more bullets at once); `nestedSpeed: 1.0` keeps them at
    // Normal speed (faster bullets are easier to dodge, not harder). Bunraku is
    // already on the hard side (its dolls fire to the bottom), so it's excluded
    // via `noLunaticScale` and tuned by its own shoot-budget cap instead.
    lunaticScale: { nestedDensity: 1.5, nestedSpeed: 1.0 },
    phases: {
      normal: [
        { name: 'Non-spell', duration: 16, hp: 100, emits: ALICE_NONSPELL },
        { name: 'Puppeteer Sign "Maiden\'s Bunraku"', duration: 20, hp: 130, emits: ALICE_BUNRAKU },
        { name: 'Soufu "French Dolls"', duration: 22, hp: 140, emits: ALICE_FRENCH },
      ],
      lunatic: [
        { name: 'Non-spell', duration: 16, hp: 110, emits: ALICE_NONSPELL },
        { name: 'Puppeteer Sign "Maiden\'s Bunraku"', duration: 20, hp: 130, emits: ALICE_BUNRAKU },
        { name: 'Soufu "French Dolls"', duration: 22, hp: 140, emits: ALICE_FRENCH },
        { name: 'Soufu "Dutch Dolls"', duration: 22, hp: 150, emits: ALICE_DUTCH },
      ],
    },
  },

  // ── Remilia — Rook (value 5). Vampire final-boss pressure. ──
  remilia: {
    name: 'Remilia',
    // Normal is a touch low (68%) — ease slightly. Lunatic is about right
    // (22%). Targets: Normal ~72% win, Lunatic ~20% win.
    tune: {
      normal:  { durationMul: 0.8,  densityMul: 0.85 },
      lunatic: { durationMul: 1.0,  densityMul: 1.5 },
    },
    color: '#ff3344',
    bgTop: '#1e0810',
    bgBottom: '#0a0406',
    move: 'slide',
    holdDur: 2.5, slideDur: 0.55, slideDist: 140,
    phases: {
      normal: [
        {
          name: 'Non-spell',
          duration: 16,
          hp: 110,
          emits: REMILIA_NONSPELL,
        },
        {
          name: 'Heaven\'s Punishment "Star of David"',
          duration: 20,
          hp: 130,
          emits: REMILIA_STAR_OF_DAVID,
        },
        {
          name: 'Nether Sign "Scarlet Netherworld"',
          duration: 22,
          hp: 140,
          emits: REMILIA_NETHERWORLD,
        },
        {
          name: 'Scarlet Sign "Scarlet Shoot"',
          duration: 20,
          hp: 150,
          emits: REMILIA_SCARLET_SHOOT,
        },
      ],
      lunatic: [
        {
          name: 'Non-spell',
          duration: 16,
          hp: 120,
          emits: REMILIA_NONSPELL,
        },
        {
          // Real HL slot-1 card (Sub31); Star of David is the EN version of
          // this slot and stays in the Normal move-set only.
          name: 'Divine Punishment "Young Demon Lord"',
          duration: 22,
          hp: 140,
          emits: REMILIA_DEMON_LORD,
        },
        {
          // Real slot-2 card; the EN banner is "Scarlet Netherworld" (Sub32),
          // the HL banner "Mountain of a Thousand Needles" (Sub33). We port
          // the Sub32 pattern and keep the EN name for both difficulties.
          name: 'Nether Sign "Scarlet Netherworld"',
          duration: 22,
          hp: 155,
          emits: REMILIA_NETHERWORLD,
        },
        {
          name: '"Scarlet Gensokyo"',
          duration: 24,
          hp: 165,
          emits: REMILIA_SCARLET_GENSO,
        },
      ],
    },
  },

  // ── Yuyuko — Rook (value 5). Death / butterfly / cherry-blossom. ──
  // Real PCCB (Touhou 7) stage-6 cards, mined from ecldata6 (see the
  // YUYUKO_* constants above for the disasm provenance).
  yuyuko: {
    name: 'Yuyuko',
    // Normal is about right (78%); Lunatic was over-hardened (1.7%) — ease it
    // back toward ~18%. Targets: Normal ~78% win, Lunatic ~18% win.
    tune: {
      normal:  { durationMul: 0.85, densityMul: 0.95 },
      lunatic: { durationMul: 0.9,  densityMul: 1.0 },
    },
    color: '#6688ff',
    bgTop: '#0a0e24',
    bgBottom: '#04060e',
    move: 'still',
    phases: {
      normal: [
        { name: 'Non-spell', duration: 16, hp: 110, emits: YUYUKO_NONSPELL },
        { name: 'Bō "Bōgakyō"', duration: 18, hp: 130, emits: YUYUKO_BO_GA_KYO },
        { name: 'Bōbu "Seishasha Hitsumetsu no Kotowari"', duration: 18, hp: 140, emits: YUYUKO_SEISHASHA },
        { name: 'Karei "Ghost Butterfly"', duration: 18, hp: 150, emits: YUYUKO_GHOST_BUTTERFLY },
      ],
      lunatic: [
        { name: 'Non-spell', duration: 16, hp: 120, emits: YUYUKO_NONSPELL },
        { name: 'Bō "Bōgakyō"', duration: 18, hp: 135, emits: YUYUKO_BO_GA_KYO },
        { name: 'Bōbu "Seishasha Hitsumetsu no Kotowari"', duration: 18, hp: 145, emits: YUYUKO_SEISHASHA },
        { name: 'Karei "Ghost Butterfly"', duration: 18, hp: 155, emits: YUYUKO_GHOST_BUTTERFLY },
        { name: 'Hankondō', duration: 20, hp: 160, emits: YUYUKO_HANKONDO },
      ],
    },
  },

  // ── Kaguya — King (value ∞), the final boss. Eternity + Impossible Requests. ──
  // Bullet SIZE: TH08 resolves each shot's bullet from a `bulletType` index
  // into BulletManager::bulletTypeSprites (th08's bullet ANM, NOT extracted),
  // so exact pixel sizes can't be read from the disasm — the radii below are
  // a best-effort match. The signature large bullets (Eternity Line r14,
  // Cowrie Shell fan r10, Dragon's Neck rain r12) are already large; the
  // counter-rotating rings (Penglai, Dragon's Neck) are r5; the rest stay
  // small (r4) as in the original.
  kaguya: {
    name: 'Kaguya',
    // Kaguya is the hardest boss — Normal ~62% is fine. Her Lunatic is
    // intrinsically brutal (0% even for the king); ease it a bit more so it's
    // winnable but still the hardest. Targets: Normal ~62% win, Lunatic ~12% win.
    tune: {
      normal:  { durationMul: 0.6,  densityMul: 0.55 },
      lunatic: { durationMul: 0.55, densityMul: 0.5 },
    },
    color: '#ffdd88',
    bgTop: '#1a1428',
    bgBottom: '#0a0812',
    // Slide (not sine): the Cowrie Shell coordinates its t=1.6 lasers with
    // the t=2.6 aimTime fan, so the boss must be static during that opening
    // volley. holdDur 3 keeps it still until both have fired.
    move: 'slide',
    holdDur: 3, slideDur: 0.6, slideDist: 120,
    phases: {
      normal: [
        {
          name: 'Non-spell',
          duration: 17,
          hp: 130,
          holdDur: 2.0, // light intro: short holds keep it moving
          emits: [
            { t: 0, type: 'aimed', count: 5, spread: 0.24, speed: 3.0, color: '#ffdd88', coreColor: '#fff8e0', shape: 'rice', interval: 0.4 },
            { t: 0.4, type: 'ring', count: 16, speed: 1.8, color: '#eeeeff', coreColor: '#ffffff', shape: 'circle', interval: 1.1 },
            { t: 0.8, type: 'point', count: 1, speed: 2.4, angleStep: 0.14, color: '#bb88ff', coreColor: '#eeccff', shape: 'petal', trail: true, interval: 0.3 },
          ],
        },
        {
          name: "Jewel from the Dragon's Neck",
          duration: 25,
          hp: 150,
          holdDur: 3.0, // let the spinning laser cross settle, then slide
          emits: [
            // Five-color laser cross (Sub52): four beams at 90°, each cycling
            // the five dragon colors as it spins.
            {
              t: 0, type: 'laser', count: 1, speed: 2.2, laserLen: 80, angleStep: 0.45, interval: 0.4, warn: 0.35, life: 120,
              colors: ['#6699ff', '#ff88bb', '#ffaa44', '#bb88ff', '#cc88ff'], colorStep: 0.3,
              color: '#6699ff', coreColor: '#e0ecff', shape: 'diamond'
            },
            {
              t: 0, type: 'laser', count: 1, speed: 2.2, laserLen: 80, angleOffset: TAU_LOCAL / 4, angleStep: 0.45, interval: 0.4, warn: 0.35, life: 120,
              colors: ['#ff88bb', '#ffaa44', '#bb88ff', '#cc88ff', '#6699ff'], colorStep: 0.3,
              color: '#ff88bb', coreColor: '#ffe0ef', shape: 'diamond'
            },
            {
              t: 0, type: 'laser', count: 1, speed: 2.2, laserLen: 80, angleOffset: TAU_LOCAL / 2, angleStep: 0.45, interval: 0.4, warn: 0.35, life: 120,
              colors: ['#ffaa44', '#bb88ff', '#cc88ff', '#6699ff', '#ff88bb'], colorStep: 0.3,
              color: '#ffaa44', coreColor: '#fff0d8', shape: 'diamond'
            },
            {
              t: 0, type: 'laser', count: 1, speed: 2.2, laserLen: 80, angleOffset: 3 * TAU_LOCAL / 4, angleStep: 0.45, interval: 0.4, warn: 0.35, life: 120,
              colors: ['#bb88ff', '#cc88ff', '#6699ff', '#ff88bb', '#ffaa44'], colorStep: 0.3,
              color: '#bb88ff', coreColor: '#efe0ff', shape: 'diamond'
            },
            // Arcing rainbow rain (Sub53): hurled upward, falling back with
            // gravity (source accel 0.0192/frame).
            {
              t: 1, type: 'fan', count: 9, spread: 2.4, angle: -Math.PI / 2, speed: 1.5, gravity: 0.03,
              colors: ['#ff5566', '#ffaa44', '#ffee44', '#66ff99', '#66aaff', '#bb88ff'], colorStep: 0.3,
              color: '#ffdd88', coreColor: '#fff8e0', shape: 'circle', interval: 1.0
            },
            // Rotating double rings (Sub54): speeds 1.1 / 1.5, counter-spin.
            { t: 2, type: 'ring', count: 32, speed: 1.1, rotStep: 0.1, color: '#ffdd88', coreColor: '#fff8e0', shape: 'star', interval: 1.6, r: 5 },
            { t: 2.85, type: 'ring', count: 32, speed: 1.5, rotStep: -0.1, color: '#66aaff', coreColor: '#e0f0ff', shape: 'star', interval: 1.6, r: 5 },
          ],
        },
        {
          name: "Buddha's Stone Bowl",
          duration: 25,
          hp: 160,
          holdDur: 3.2, // hold through one full beam re-aim cycle (3.2s)
          emits: [
            // Stop-moon laser sweeps (Sub55-57): a red beam held by the
            // stone moons, re-aimed 22.5° (TAU/16) each firing.
            {
              t: 0, type: 'laser', count: 1, speed: 0, laserLen: 440, angleStep: TAU_LOCAL / 16, interval: 3.2, warn: 1.0,
              color: '#ff5566', coreColor: '#ffd0d8', shape: 'diamond'
            },
            {
              t: 2.0, type: 'laser', count: 1, speed: 0, laserLen: 440, angleStep: -TAU_LOCAL / 16, interval: 3.2, warn: 1.0,
              color: '#ff5566', coreColor: '#ffd0d8', shape: 'diamond'
            },
            // Escalating micro-spirals (Sub58): two bullets, polar growth.
            {
              t: 1, type: 'spiral', arms: 2, rotSpeed: 0.45, speed: 1.8, speedStep: 0.02, interval: 0.06,
              colors: ['#ffdd88', '#ffffff'], colorStep: 0.4,
              color: '#ffdd88', coreColor: '#fff8e0', shape: 'circle'
            },
            // The unbreakable will (砕けぬ意思): a fast ring that decays
            // from 4.0 down toward 0.8.
            {
              t: 3, type: 'ring', count: 32, speed: 4.0, retention: 0.985, interval: 0.8,
              color: '#8866ff', coreColor: '#ddccff', shape: 'circle', life: 210
            },
          ],
        },
        {
          name: "Fire Rat's Leather Robe",
          duration: 25,
          hp: 170,
          holdDur: 3.0, // stay put so the aimed-at-player beams are fair
          emits: [
            // Corner-moon telegraphed lasers (Sub61/64/65): white beams
            // aimed at the player, fanned across the screen.
            {
              t: 0, type: 'laser', count: 1, speed: 0, laserLen: 800, interval: 3.0, warn: 1.2,
              color: '#ffffff', coreColor: '#fff8e0', shape: 'diamond'
            },
            {
              t: 1.0, type: 'laser', count: 1, speed: 0, laserLen: 800, angleOffset: 0.3, interval: 3.0, warn: 1.2,
              color: '#ffffff', coreColor: '#fff8e0', shape: 'diamond'
            },
            {
              t: 2.0, type: 'laser', count: 1, speed: 0, laserLen: 800, angleOffset: -0.3, interval: 3.0, warn: 1.2,
              color: '#ffffff', coreColor: '#fff8e0', shape: 'diamond'
            },
            // The heart that does not burn (焦れぬ心, Sub62/63): two
            // three-bullet flame streams that accelerate, then decay.
            {
              t: 1, type: 'aimed', count: 3, spread: 0.3, speed: 2.6, angleStep: 0.2, interval: 0.12,
              color: '#ffaa44', coreColor: '#ffe8c0', shape: 'star', trail: true
            },
            {
              t: 1.1, type: 'aimed', count: 3, spread: 0.3, speed: 2.6, angleStep: -0.2, interval: 0.12,
              color: '#ff5566', coreColor: '#ffd0d8', shape: 'star', trail: true
            },
            {
              t: 1, type: 'aimed', count: 3, spread: 0.3, speed: 2.6, angleOffset: TAU_LOCAL / 4, angleStep: 0.2, interval: 0.12,
              color: '#ffaa44', coreColor: '#ffe8c0', shape: 'star', trail: true
            },
            {
              t: 1.1, type: 'aimed', count: 3, spread: 0.3, speed: 2.6, angleOffset: TAU_LOCAL / 4, angleStep: -0.2, interval: 0.12,
              color: '#ff5566', coreColor: '#ffd0d8', shape: 'star', trail: true
            },
          ],
        },
        {
          name: "Swallow's Cowrie Shell",
          duration: 25,
          hp: 180,
          holdDur: 3.6, // MUST be static: t=1.6 lasers + t=2.6 aimTime fan coordinate on the boss position
          emits: [
            // The Eternity Line (永命線, Sub67/68): the moon hurls two big
            // counter-rotating rings (the source fires two circles
            // back-to-back, speed rows 3.0 -> 1.5). Each ring SPINS as it
            // expands: one clockwise, one counterclockwise. The second ring
            // is offset by half a bullet-spacing (PI/27) so its 27 bullets
            // interleave exactly between the first ring's.
            {
              t: 0, type: 'ring', count: 27, speed: 1.4, spin: 0.25, aimRing: true,
              color: '#ffdd88', coreColor: '#fff8e0', shape: 'circle', interval: 1.5, r: 14
            },
            {
              t: 0.75, type: 'ring', count: 27, speed: 1.2, spin: -0.25, rot: Math.PI / 27,
              color: '#ffeebb', coreColor: '#fffbe0', shape: 'circle', interval: 1.5, r: 14
            },
            // Life Spring Infinity (H/L, Sub69): the moon erupts a full-circle
            // laser burst (52 beams). Approximated as a fast-rotating 12-beam
            // laser wheel sweeping the screen.
            {
              t: 1.6, type: 'laser', count: 1, speed: 0, laserLen: 700, angleOffset: TAU_LOCAL / 36, interval: 3.8, warn: 1.0,
              color: '#66ffcc', coreColor: '#d8fff0', shape: 'diamond'
            },
            // The aimed laser wall (Sub66): a thick beam through the boss,
            // refired on a slow cadence.
            {
              t: 1.6, type: 'laser', count: 1, speed: 0, laserLen: 700, interval: 3.8, warn: 1, angleOffset: -TAU_LOCAL/36,
              color: '#ffdd88', coreColor: '#fff8e0', shape: 'diamond'
            },
            // The red fan (Sub66): a 120-bullet fan covering 17/18 of the
            // circle, centered on the anti-player direction so its 1/18-TAU
            // GAP lines up with the corridor between the two lasers. The
            // lasers fire at t=1.6 and refire every 3.2s, RE-AIMING at the
            // player's current position each time; the fan fires 1.0s after
            // each laser volley, so aimTime: 1.0 (a LOOKBACK delay) makes
            // every fan volley aim at the player's position from the moment
            // its paired laser fired — the gap stays aligned with the laser
            // corridor on ALL refires, not just the first. A second
            // identical fan (staggered 0.1s) is shifted by exactly HALF A
            // BULLET-PITCH (spread/(count-1)/2 = TAU/252), so every one of
            // its bullets lands dead-center in a gap of the first fan. It
            // uses aimTime: 1.1 so it looks back to the SAME snapshot as the
            // first fan (its extra 0.1s of flight time is compensated),
            // keeping the two waves perfectly interlocked. Together they
            // form one 240-bullet fan whose gaps are half as wide — much
            // harder to thread — while the big safe pocket at the aim point
            // stays open (~18.6° instead of 20°).
            {t: 2.6, type: 'fan', count: 120, speed: 5, spread: TAU_LOCAL*17/18, r: 10, shape: 'rice', color: '#fe8080', interval: 3.8, angleOffset: TAU_LOCAL/2, aimTime: 1.0},
            {t: 2.7, type: 'fan', count: 120, speed: 5, spread: TAU_LOCAL*17/18, r: 10, shape: 'rice', color: '#fe8080', interval: 3.8, angleOffset: TAU_LOCAL/2 + TAU_LOCAL/252, aimTime: 1.1}
          ],
        },
        {
          name: 'Eternal Night Reversal',
          duration: 30,
          hp: 200,
          holdDur: 3.5, // long card: slightly longer holds
          noBombs: true,
          emits: [
            // Penglai branch (Sub72-74): counter-rotating 16-ray rings in
            // dream colors (夢色の郷) — the "rainbow danmaku" (虹色の弾幕).
            {
              t: 0, type: 'ring', count: 16, speed: 2.2, rotStep: 0.06, aimRing: true,
              colors: ['#ff88bb', '#ffaa44', '#ffee44', '#66ff99', '#66aaff', '#bb88ff'], colorStep: 0.3,
              color: '#bb88ff', coreColor: '#efe0ff', shape: 'circle', interval: 1.1, r: 5
            },
            {
              t: 0.55, type: 'ring', count: 16, speed: 2.2, rotStep: -0.06, rot: Math.PI / 16,
              colors: ['#66aaff', '#bb88ff', '#ff88bb', '#ffaa44', '#ffee44', '#66ff99'], colorStep: 0.3,
              color: '#66aaff', coreColor: '#e0ecff', shape: 'circle', interval: 1.1, r: 5
            },
            // First Moon / Rat Hour (Sub78/81): 8-way aimed circles aimed at
            // the player, over a 6-arm rotating spiral.
            {
              t: 1.2, type: 'spiral', arms: 8, rotSpeed: 0.35, speed: 2.4,
              color: '#66ffcc', coreColor: '#d8fff0', shape: 'circle', interval: 0.24
            },
            {
              t: 1.2, type: 'aimed', count: 9, spread: 0.5, speed: 2.8, angleStep: 0.05, interval: 0.5,
              color: '#ffdd88', coreColor: '#fff8e0', shape: 'star', trail: true
            },
            // Ox Hour / Tiger Hour (Sub83/85): fast accelerating rings — the
            // "tiger hour" surge (source speed 5.0).
            {
              t: 2.4, type: 'ring', count: 22, speed: 3.2, speedStep: 0.03, rotStep: 0.04,
              color: '#ff5566', coreColor: '#ffd0d8', shape: 'circle', interval: 0.9
            },
            {
              t: 2.4, type: 'fan', count: 11, spread: 1.2, angle: Math.PI / 2, speed: 2.6, angleStep: 0.09, interval: 1.4,
              color: '#ffaa44', coreColor: '#ffe8c0', shape: 'rice', trail: true
            },
            // Morning Mist / Dawn (Sub88): a storm of drifting random-angle
            // bullets, escalating in speed (2.0 -> 3.4).
            {
              t: 3.6, type: 'aimed', count: 5, speed: 2.6, turn: 0.03, interval: 0.35,
              color: '#eeeeff', coreColor: '#ffffff', shape: 'circle', life: 200
            },
            {
              t: 3.6, type: 'ring', count: 18, speed: 2.4, rotStep: 0.02, speedStep: 0.02,
              colors: ['#ffffff', '#bb88ff', '#66aaff', '#ff88bb'], colorStep: 0.25,
              color: '#ffffff', coreColor: '#ffffff', shape: 'circle', interval: 0.7
            },
          ],
        },
      ],
      lunatic: [
        {
          name: 'Non-spell',
          duration: 17,
          hp: 150,
          emits: [
            { t: 0, type: 'aimed', count: 5, spread: 0.24, speed: 3.2, color: '#ffdd88', coreColor: '#fff8e0', shape: 'rice', interval: 0.4 },
            { t: 0.4, type: 'ring', count: 18, speed: 1.8, color: '#eeeeff', coreColor: '#ffffff', shape: 'circle', interval: 1.1 },
            { t: 0.8, type: 'point', count: 1, speed: 2.4, angleStep: 0.14, color: '#bb88ff', coreColor: '#eeccff', shape: 'petal', trail: true, interval: 0.3 },
          ],
        },
        {
          name: 'Brilliant Dragon Barrette',
          duration: 25,
          hp: 170,
          emits: [
            // Two counter-rotating laser RINGS (H/L): eight beams each —
            // ring A (gold) spins clockwise, ring B (blue-violet)
            // counter-clockwise, both from the same base angle. They
            // ALTERNATE on a 2.4 s cycle: A fires at t=0, B at t=1.2,
            // repeat. Each copy lives 1.5 s (life 30 + the 1.0 s warn
            // extension), so consecutive wheels overlap by 0.3 s and the
            // field never goes empty. While alive each wheel sweeps
            // ~PI/12 * 1.5 = PI/8 ≈ 0.39 rad (~22.5°), so the player
            // shuffles back and forth between two nearby sectors instead
            // of orbiting the boss; the thin-line telegraph between solid
            // wheels is the breather, while the rain and star rings keep
            // up the pressure. Each firing lays the FULL ring and every bullet
            // orbits the origin via `curve`, so the wheel spins smoothly
            // (see the laser-ring note in engine.js). Fixed `angle` so the
            // ring phase doesn't chase the player's aim line.
            {
              t: 0, type: 'laser', count: 8, speed: 0, angle: -Math.PI / 2 + TAU_LOCAL / 16,
              laserLen: 700, spacing: 12, sweep: Math.PI / 12,
              interval: 0.4, repeat: 1, period: 2.4, warn: 1.0, life: 30,
              colors: ['#ffdd88', '#fff0c0', '#ffcc44', '#ffe8a0', '#fffbe0'], colorStep: 0.3,
              color: '#ffdd88', coreColor: '#fff8e0', shape: 'diamond'
            },
            {
              t: 1.2, type: 'laser', count: 8, speed: 0, angle: -Math.PI / 2 + TAU_LOCAL / 16,
              laserLen: 700, spacing: 12, sweep: -Math.PI / 12,
              interval: 0.8, repeat: 1, period: 2.4, warn: 1.0, life: 30,
              colors: ['#6699ff', '#bb88ff', '#88aaff', '#cc88ff', '#e0ecff'], colorStep: 0.3,
              color: '#6699ff', coreColor: '#e0ecff', shape: 'diamond'
            },
            // Arcing rainbow rain (H/L: wider, faster fall).
            {
              t: 1, type: 'fan', count: 13, spread: 3.0, angle: -Math.PI / 2, speed: 1.7, gravity: 0.03, r: 12,
              colors: ['#ff5566', '#ffaa44', '#ffee44', '#66ff99', '#66aaff', '#bb88ff'], colorStep: 0.25,
              color: '#ffdd88', coreColor: '#fff8e0', shape: 'circle', interval: 0.8
            },
            // Rotating double rings (H/L: 40-ring, faster).
            { t: 2, type: 'ring', count: 40, speed: 1.3, rotStep: 0.12, color: '#ffdd88', coreColor: '#fff8e0', shape: 'star', interval: 1.4 },
            { t: 2.85, type: 'ring', count: 40, speed: 1.7, rotStep: -0.12, color: '#66aaff', coreColor: '#e0f0ff', shape: 'star', interval: 1.4 },
          ],
        },
        {
          name: 'Buddhist Diamond',
          duration: 25,
          hp: 180,
          emits: [
            // Stop-moon laser sweeps (H/L: longer range, faster).
            {
              t: 0, type: 'laser', count: 1, speed: 0, laserLen: 460, angleStep: TAU_LOCAL / 16, interval: 3.2, warn: 0.9,
              color: '#ff5566', coreColor: '#ffd0d8', shape: 'diamond'
            },
            {
              t: 1.9, type: 'laser', count: 1, speed: 0, laserLen: 460, angleStep: -TAU_LOCAL / 16, interval: 3.2, warn: 0.9,
              color: '#ff5566', coreColor: '#ffd0d8', shape: 'diamond'
            },
            // Escalating micro-spirals (H/L: 3 arms, faster growth).
            {
              t: 1, type: 'spiral', arms: 3, rotSpeed: 0.5, speed: 2.0, speedStep: 0.03, interval: 0.05,
              colors: ['#ffdd88', '#ffffff'], colorStep: 0.3,
              color: '#ffdd88', coreColor: '#fff8e0', shape: 'circle'
            },
            // The unbreakable will (H/L: faster decay ring).
            {
              t: 3, type: 'ring', count: 40, speed: 4.4, retention: 0.985, interval: 0.7,
              color: '#8866ff', coreColor: '#ddccff', shape: 'circle', life: 210
            },
          ],
        },
        {
          name: 'Salamander Shield',
          duration: 25,
          hp: 190,
          emits: [
            // Corner-moon telegraphed lasers (H/L: 4 beams, faster).
            {
              t: 0, type: 'laser', count: 1, speed: 0, laserLen: 240, interval: 1.6, warn: 1.0,
              color: '#ffffff', coreColor: '#fff8e0', shape: 'diamond'
            },
            {
              t: 0.7, type: 'laser', count: 1, speed: 0, laserLen: 240, angleOffset: 1.05, interval: 1.6, warn: 1.0,
              color: '#ffffff', coreColor: '#fff8e0', shape: 'diamond'
            },
            {
              t: 1.4, type: 'laser', count: 1, speed: 0, laserLen: 240, angleOffset: -1.05, interval: 1.6, warn: 1.0,
              color: '#ffffff', coreColor: '#fff8e0', shape: 'diamond'
            },
            // The heart that does not burn (H/L: 5-bullet fans, faster).
            {
              t: 1, type: 'aimed', count: 5, spread: 0.34, speed: 2.9, angleStep: 0.22, interval: 0.1,
              color: '#ffaa44', coreColor: '#ffe8c0', shape: 'star', trail: true
            },
            {
              t: 1.1, type: 'aimed', count: 5, spread: 0.34, speed: 2.9, angleStep: -0.22, interval: 0.1,
              color: '#ff5566', coreColor: '#ffd0d8', shape: 'star', trail: true
            },
          ],
        },
        {
          name: 'Life Spring Infinity',
          duration: 25,
          hp: 200,
          emits: [
            // The Eternity Line (H/L: 17-ray, faster waves).
            {
              t: 0, type: 'ring', count: 17, speed: 3.2, rotStep: 0.06, aimRing: true,
              color: '#ffdd88', coreColor: '#fff8e0', shape: 'circle', interval: 1.2
            },
            {
              t: 0.75, type: 'ring', count: 17, speed: 2.5, rotStep: -0.06, rot: Math.PI / 17,
              color: '#ffeebb', coreColor: '#fffbe0', shape: 'circle', interval: 1.2
            },
            // Life Spring Infinity (H/L: 16-beam laser wheel, faster).
            {
              t: 1.6, type: 'laser', count: 1, speed: 0, laserLen: 360, angleStep: TAU_LOCAL / 16, interval: 2.0, warn: 0.9,
              color: '#66ffcc', coreColor: '#d8fff0', shape: 'diamond'
            },
            // The aimed laser wall (H/L: faster).
            {
              t: 2.4, type: 'laser', count: 1, speed: 0, laserLen: 460, interval: 2.6, warn: 1.0,
              color: '#ffdd88', coreColor: '#fff8e0', shape: 'diamond'
            },
          ],
        },
        {
          name: 'Eternal Night Reversal',
          duration: 30,
          hp: 220,
          noBombs: true,
          emits: [
            // Penglai Jade Branch (H/L: 20-ray dream-color rings, faster).
            {
              t: 0, type: 'ring', count: 20, speed: 2.5, rotStep: 0.07, aimRing: true,
              colors: ['#ff88bb', '#ffaa44', '#ffee44', '#66ff99', '#66aaff', '#bb88ff'], colorStep: 0.25,
              color: '#bb88ff', coreColor: '#efe0ff', shape: 'circle', interval: 0.9
            },
            {
              t: 0.5, type: 'ring', count: 20, speed: 2.5, rotStep: -0.07, rot: Math.PI / 20,
              colors: ['#66aaff', '#bb88ff', '#ff88bb', '#ffaa44', '#ffee44', '#66ff99'], colorStep: 0.25,
              color: '#66aaff', coreColor: '#e0ecff', shape: 'circle', interval: 0.9
            },
            // First Moon / Rat Hour (H/L: 8-arm spiral + 11-way aimed).
            // interval 0.12 = 2x the Normal 0.24 (a proper Lunatic escalation);
            // the original 0.07 (114 bullets/sec) was an unwinnable wall — even
            // the king died here, so it broke the "dodgeable by a pawn" rule.
            {
              t: 1.1, type: 'spiral', arms: 8, rotSpeed: 0.42, speed: 2.6,
              color: '#66ffcc', coreColor: '#d8fff0', shape: 'circle', interval: 0.12
            },
            {
              t: 1.1, type: 'aimed', count: 11, spread: 0.55, speed: 3.0, angleStep: 0.06, interval: 0.4,
              color: '#ffdd88', coreColor: '#fff8e0', shape: 'star', trail: true
            },
            // Ox / Tiger Hour (H/L: faster accelerating rings + fans).
            {
              t: 2.2, type: 'ring', count: 26, speed: 3.6, speedStep: 0.04, rotStep: 0.05,
              color: '#ff5566', coreColor: '#ffd0d8', shape: 'circle', interval: 0.75
            },
            {
              t: 2.2, type: 'fan', count: 13, spread: 1.4, angle: Math.PI / 2, speed: 2.9, angleStep: 0.1, interval: 1.2,
              color: '#ffaa44', coreColor: '#ffe8c0', shape: 'rice', trail: true
            },
            // Morning Mist / Dawn (H/L: denser random storm).
            {
              t: 3.4, type: 'aimed', count: 7, speed: 2.9, turn: 0.035, interval: 0.28,
              color: '#eeeeff', coreColor: '#ffffff', shape: 'circle', life: 200
            },
            {
              t: 3.4, type: 'ring', count: 22, speed: 2.7, rotStep: 0.03, speedStep: 0.03,
              colors: ['#ffffff', '#bb88ff', '#66aaff', '#ff88bb'], colorStep: 0.2,
              color: '#ffffff', coreColor: '#ffffff', shape: 'circle', interval: 0.6
            },
          ],
        },
      ],
    },
  },

  // ── Yukari Yakumo ────────────────────────────────────────────────────────
  // PROVENANCE (corrected): these patterns were mined from the EoSD (Touhou 6)
  // EXTRA-stage ECL script (eosd_extract/ecl/disasm/ecldata7_utf8.txt — the
  // file is mislabeled "stage 7"; it actually holds the extra stage). That
  // script carries 13 spell-card banners: 3 belong to Patchouli Knowledge and
  // 10 to Flandre Scarlet. This port uses six of them — three Patchouli cards
  // and three Flandre cards — as the moveset for OUR game's Yukari boss. They
  // are NOT Yukari's original cards: canonically Yukari debuts as the Phantasm
  // Stage boss of Perfect Cherry Blossom (TH07), whose spell cards are
  // different (see refs/stages/Yukari.html). Card names/patterns below are
  // kept as ported; only the attribution is corrected here.
  //
  // The six used (ECL sub in the extra-stage script), with their true owners:
  //   Moon Sign "Silent Serena" (月符「サイレントセレナ」, Sub22) — Patchouli:
  //     random-angle slow rings + aimed 8-way fans, moonlight palette.
  //   Sun Sign "Royal Flare" (日符「ロイヤルフレア」, Sub23) — Patchouli:
  //     rotating multi-directional streams that sweep the screen.
  //   Fire-Water-Wood-Metal-Earth Sign "Philosopher's Stone"
  //     (火水木金土符「賢者の石」, Sub24) — Patchouli: five sub-entities each
  //     firing a different pattern (ring / aimed / spiral / ray / aimed).
  //   Forbidden "Kagome Kagome" (禁忌「カゴメカゴメ」, Sub44) — Flandre:
  //     spawning gap-traps that fire 9-bullet rings + aimed 3-way fans.
  //   Forbidden "Cranberry Trap" (禁忌「クランベリートラップ」, Sub33) — Flandre:
  //     wandering traps that dash and fire aimed streams.
  //   QED "Ripples of 495 Years" (ＱＥＤ「４９５年の波紋」, Sub68) — Flandre:
  //     massive 88-bullet ring waves — the finale.
  //
  // Barrage subs (Sub32/35/38/43/47/49/53/56/59) share a common pattern:
  //   ins_70(2, 2|6, 64|32, 2|3, 2.0|2.5|3.5, 1.0, -10005, 0, 513)
  //   = 64/32-ray ring, speed 2-3.5, refired every 30-60f, with the aim
  //     angle randomized each cycle (ins_9 random + ins_50 ±π range).
  //   Translated as a rotating ring with per-cycle angle jitter.

  yukari: {
    name: 'Yukari',
    // Second-hardest boss — Normal was too low (37%) — ease it toward ~60%.
    // Lunatic is about right (18%). Targets: Normal ~60% win, Lunatic ~18% win.
    tune: {
      // Yukari is the QUEEN's boss — the second-hardest (after Kaguya). Her
      // EoSD patterns (Flandre/Patchouli ports) are intrinsically sparse, so
      // Normal is hardened (duration + density up) to sit her near the top of
      // the difficulty ladder; Lunatic stays tuned independently.
      normal:  { durationMul: 0.7,  densityMul: 0.65 },
      lunatic: { durationMul: 0.6,  densityMul: 0.55 },
    },
    color: '#bb88ff',
    bgTop: '#1a1028',
    bgBottom: '#0a0614',
    move: 'slide',
    holdDur: 3, slideDur: 0.6, slideDist: 160,
    phases: {
      normal: [
        {
          name: 'Non-spell',
          duration: 17,
          hp: 130,
          emits: [
            // Barrage ring (Sub32/35): 64-ray ring, speed 2.0, refire 60f.
            {
              t: 0, type: 'ring', count: 32, speed: 1.8, rotStep: 0.03,
              color: '#bb88ff', coreColor: '#eeccff', shape: 'circle', interval: 1.0
            },
            // Aimed stream with wide arc drift (ins_102: ±1.1 rad swing).
            {
              t: 0.4, type: 'aimed', count: 5, spread: 0.28, speed: 2.8,
              angleStep: 0.12, color: '#eeccff', coreColor: '#ffffff',
              shape: 'petal', trail: true, interval: 0.35
            },
            // Secondary ring (Sub38: 32-ray, speed 3.0).
            {
              t: 1.2, type: 'ring', count: 24, speed: 2.4, rotStep: -0.04,
              color: '#ff88bb', coreColor: '#ffccee', shape: 'star', interval: 1.2
            },
          ],
        },
        {
          name: 'Silent Serena',
          duration: 25,
          hp: 150,
          emits: [
            // Moonlight rings (Sub22 loop): random-angle 6-bullet rings,
            // speed ~0 (very slow drift). Translated as slow 12-way rings.
            {
              t: 0, type: 'ring', count: 12, speed: 1.0, rotStep: 0.02,
              color: '#eeeeff', coreColor: '#ffffff', shape: 'circle', interval: 1.4
            },
            // Aimed 8-way fan (Sub22: ins_68 2×8, speed 2.7→2.0,
            // angle -π/2, offset 0.26 rad). Odd count → 9.
            {
              t: 1.5, type: 'aimed', count: 9, spread: 0.52, speed: 2.4,
              angle: Math.PI / 2, angleOffset: 0.26,
              color: '#bb88ff', coreColor: '#eeccff', shape: 'rice',
              interval: 1.2
            },
            // Silent moonbeam (Sub22: ins_82 96f, angle 0.02→0.005):
            // a single slow bullet that drifts sideways.
            {
              t: 0.8, type: 'point', count: 1, speed: 1.6, angleStep: 0.04,
              color: '#eeeeff', coreColor: '#ffffff', shape: 'petal',
              trail: true, interval: 0.8
            },
            // Escalating ring (Sub22: ins_17 rank 32 → more bullets).
            {
              t: 4, type: 'ring', count: 16, speed: 1.4, rotStep: 0.03,
              colors: ['#eeeeff', '#bb88ff', '#ff88bb'], colorStep: 0.3,
              color: '#eeeeff', coreColor: '#ffffff', shape: 'circle', interval: 1.1, r: 9
            },
          ],
        },
        {
          name: 'Royal Flare',
          duration: 25,
          hp: 160,
          emits: [
            // Rotating stream pair (Sub23: ins_68 1×2, speed 0,
            // angle offset 0.52 rad, refire 120f). Two counter-rotating
            // point streams.
            {
              t: 0, type: 'point', count: 1, speed: 2.2, angleStep: 0.052,
              color: '#ffdd88', coreColor: '#fff8e0', shape: 'star',
              trail: true, interval: 0.2
            },
            {
              t: 0, type: 'point', count: 1, speed: 2.2, angleStep: -0.052,
              angleOffset: Math.PI,
              color: '#ffaa44', coreColor: '#ffe8c0', shape: 'star',
              trail: true, interval: 0.2
            },
            // Sweeping fan (Sub23: ins_68 1×2, speed 0, angle offset 1.05).
            // A 5-way fan that rotates across the screen.
            {
              t: 1.5, type: 'fan', count: 5, spread: 1.05, speed: 2.0,
              angleStep: 0.04, color: '#ffdd88', coreColor: '#fff8e0',
              shape: 'circle', interval: 0.9, r: 4.5
            },
            // Counter-sweep (Sub23: second loop, opposite direction).
            {
              t: 2.5, type: 'fan', count: 5, spread: 1.05, speed: 2.0,
              angleStep: -0.04, angleOffset: Math.PI,
              color: '#ffaa44', coreColor: '#ffe8c0', shape: 'circle', interval: 0.9, r: 4.5
            },
            // Golden ring burst (Sub23: ins_121 13,3/5/6 → escalating).
            {
              t: 4, type: 'ring', count: 20, speed: 2.0, rotStep: 0.05,
              colors: ['#ffdd88', '#ffaa44', '#ffee44'], colorStep: 0.3,
              color: '#ffdd88', coreColor: '#fff8e0', shape: 'star', interval: 1.0, r: 4.5
            },
          ],
        },
        {
          name: "Philosopher's Stone",
          duration: 25,
          hp: 170,
          emits: [
            // Fire (Sub25): 2×10 ring, speed 2.0, refire 32f.
            {
              t: 0, type: 'ring', count: 10, speed: 2.0,
              color: '#ff5566', coreColor: '#ffd0d8', shape: 'circle', interval: 0.55, r: 5.5
            },
            // Water (Sub26): 6×11 aimed, speed 3.0→2.6, angle 0.26.
            {
              t: 0.8, type: 'aimed', count: 11, spread: 0.52, speed: 2.8,
              color: '#66aaff', coreColor: '#e0ecff',
              shape: 'circle', interval: 1.1, r: 5.5
            },
            // Wood (Sub27): 10×10 spiral, speed 2.0→0.3, angle π→-π.
            {
              t: 1.6, type: 'spiral', arms: 20, rotSpeed: 0.3, speed: 1.8,
              color: '#66ff99', coreColor: '#d8ffe8', shape: 'petal', interval: 0.24, r: 5.5
            },
            // Metal (Sub28): 16-ray, speed 4.0→1.0, angle from var.
            {
              t: 2.4, type: 'ring', count: 16, speed: 2.6, rotStep: 0.06,
              color: '#cccccc', coreColor: '#ffffff', shape: 'diamond', interval: 0.8, r: 5.5
            },
            // Earth (Sub29): 13-bullet aimed, speed 2.4→1.0, angle π/2.
            {
              t: 3.2, type: 'aimed', count: 13, spread: 0.8, speed: 2.2,
              angle: Math.PI / 2, angleOffset: 0.1,
              color: '#ffaa44', coreColor: '#ffe8c0', shape: 'rice', interval: 1.0, r: 5.5
            },
          ],
        },
        {
          name: 'Ripples of 495 Years',
          duration: 30,
          hp: 200,
          noBombs: true,
          emits: [
            // The 88-bullet ring (Sub68: ins_70 6×88, speed 1→var,
            // angle random ±π). Translated as a massive 44-way ring.
            {
              t: 0, type: 'ring', count: 44, speed: 2.0, rotStep: 0.02,
              colors: ['#bb88ff', '#eeeeff', '#ff88bb', '#ffdd88'], colorStep: 0.25,
              color: '#bb88ff', coreColor: '#eeccff', shape: 'circle', interval: 0.8
            },
            // Counter-ring (Sub68: second wave, opposite rotation).
            {
              t: 0.8, type: 'ring', count: 44, speed: 1.6, rotStep: -0.02,
              rot: Math.PI / 44,
              colors: ['#eeeeff', '#bb88ff', '#ff88bb', '#ffdd88'], colorStep: 0.25,
              color: '#eeeeff', coreColor: '#ffffff', shape: 'circle', interval: 1.0
            },
            // Boundary ripple (the gap closing in): accelerating rings.
            {
              t: 3, type: 'ring', count: 32, speed: 2.4, speedStep: 0.02,
              rotStep: 0.04, color: '#bb88ff', coreColor: '#eeccff',
              shape: 'star', interval: 1.2
            },
            // Final wave (Sub68: ins_121 16,0/1 → two ring variants). The
            // ins_121 helper sets its own sprite (not readable from the
            // disasm); matched to the card's main sprite 2 size (r4).
            {
              t: 6, type: 'ring', count: 48, speed: 2.8, rotStep: 0.03, r: 4,
              colors: ['#ff88bb', '#bb88ff', '#eeeeff'], colorStep: 0.3,
              color: '#ff88bb', coreColor: '#ffccee', shape: 'circle', interval: 1.4
            },
          ],
        },
      ],
      lunatic: [
        {
          name: 'Non-spell',
          duration: 17,
          hp: 150,
          emits: [
            // Denser barrage ring (L: 64-ray → 32-way, faster).
            {
              t: 0, type: 'ring', count: 32, speed: 2.2, rotStep: 0.04,
              color: '#bb88ff', coreColor: '#eeccff', shape: 'circle', interval: 0.8
            },
            // Faster aimed stream.
            {
              t: 0.3, type: 'aimed', count: 7, spread: 0.3, speed: 3.0,
              angleStep: 0.14, color: '#eeccff', coreColor: '#ffffff',
              shape: 'petal', trail: true, interval: 0.3
            },
            // Secondary ring (L: faster).
            {
              t: 1.0, type: 'ring', count: 28, speed: 2.8, rotStep: -0.05,
              color: '#ff88bb', coreColor: '#ffccee', shape: 'star', interval: 1.0
            },
          ],
        },
        {
          name: 'Silent Serena',
          duration: 25,
          hp: 170,
          emits: [
            // L: faster rings, more bullets.
            {
              t: 0, type: 'ring', count: 14, speed: 1.3, rotStep: 0.03,
              color: '#eeeeff', coreColor: '#ffffff', shape: 'circle', interval: 1.1
            },
            // L: wider aimed fan.
            {
              t: 1.2, type: 'aimed', count: 11, spread: 0.6, speed: 2.6,
              angle: Math.PI / 2, angleOffset: 0.26,
              color: '#bb88ff', coreColor: '#eeccff', shape: 'rice', interval: 1.0
            },
            // L: faster moonbeam.
            {
              t: 0.6, type: 'point', count: 1, speed: 2.0, angleStep: 0.05,
              color: '#eeeeff', coreColor: '#ffffff', shape: 'petal',
              trail: true, interval: 0.6
            },
            // L: denser escalating ring.
            {
              t: 3.5, type: 'ring', count: 20, speed: 1.8, rotStep: 0.04,
              colors: ['#eeeeff', '#bb88ff', '#ff88bb'], colorStep: 0.25,
              color: '#eeeeff', coreColor: '#ffffff', shape: 'circle', interval: 0.9, r: 12
            },
          ],
        },
        {
          name: 'Royal Flare',
          duration: 25,
          hp: 180,
          emits: [
            // L: faster counter-rotating streams.
            {
              t: 0, type: 'point', count: 1, speed: 2.6, angleStep: 0.06,
              color: '#ffdd88', coreColor: '#fff8e0', shape: 'star',
              trail: true, interval: 0.15
            },
            {
              t: 0, type: 'point', count: 1, speed: 2.6, angleStep: -0.06,
              angleOffset: Math.PI,
              color: '#ffaa44', coreColor: '#ffe8c0', shape: 'star',
              trail: true, interval: 0.15
            }, {
              t: 0, type: 'point', count: 1, speed: 2.6, angleStep: 0.06,
              color: '#ffdd88', coreColor: '#fff8e0', shape: 'star',
              angleOffset: TAU_LOCAL / 4,
              trail: true, interval: 0.15
            },
            {
              t: 0, type: 'point', count: 1, speed: 2.6, angleStep: -0.06,
              angleOffset: -Math.PI,
              color: '#ffaa44', coreColor: '#ffe8c0', shape: 'star',
              trail: true, interval: 0.15
            },
            // L: wider sweeping fans.
            {
              t: 1.2, type: 'fan', count: 7, spread: 1.2, speed: 2.3, centered: true,
              angleStep: 0.05, color: '#ffdd88', coreColor: '#fff8e0',
              shape: 'circle', interval: 0.7, r: 4.5
            },
            {
              t: 2.2, type: 'fan', count: 7, spread: 1.2, speed: 2.3, centered: true,
              angleStep: -0.05, angleOffset: Math.PI,
              color: '#ffaa44', coreColor: '#ffe8c0', shape: 'circle', interval: 0.7, r: 4.5
            },
            // L: denser golden ring.
            {
              t: 3.5, type: 'ring', count: 24, speed: 2.4, rotStep: 0.06,
              colors: ['#ffdd88', '#ffaa44', '#ffee44'], colorStep: 0.25,
              color: '#ffdd88', coreColor: '#fff8e0', shape: 'star', interval: 0.8, r: 4.5
            },
          ],
        },
        {
          name: "Philosopher's Stone",
          duration: 25,
          hp: 190,
          emits: [
            // L: all five elements, denser.
            {
              t: 0, type: 'ring', count: 12, speed: 2.4,
              color: '#ff5566', coreColor: '#ffd0d8', shape: 'circle', interval: 0.45, r: 5.5
            },
            {
              t: 0.6, type: 'aimed', count: 13, spread: 0.6, speed: 3.0, centered: true,
              angleOffset: 0.26, color: '#66aaff', coreColor: '#e0ecff',
              shape: 'circle', interval: 0.9, r: 5.5
            },
            {
              t: 1.4, type: 'spiral', arms: 12, rotSpeed: 0.35, speed: 2.0,
              color: '#66ff99', coreColor: '#d8ffe8', shape: 'petal', interval: 0.07, r: 5.5
            },
            {
              t: 2.2, type: 'ring', count: 20, speed: 3.0, rotStep: 0.07,
              color: '#cccccc', coreColor: '#ffffff', shape: 'diamond', interval: 0.7, r: 5.5
            },
            {
              t: 3.0, type: 'aimed', count: 15, spread: 0.9, speed: 2.5, centered: true,
              angle: Math.PI / 2, angleOffset: 0.1,
              color: '#ffaa44', coreColor: '#ffe8c0', shape: 'rice', interval: 0.8, r: 5.5
            },
          ],
        },
        {
          name: 'Kagome Kagome',
          duration: 25,
          hp: 200,
          emits: [
            // Gap-trap rings (Sub44: ins_68 1×9, speed 0, refire 6f):
            // 9-bullet rings spawned at various positions.
            {
              t: 0, type: 'ring', count: 9, speed: 1.8, rotStep: 0.08,
              color: '#ff88bb', coreColor: '#ffccee', shape: 'circle', interval: 0.8, r: 8
            },
            // Aimed 3-way fans (Sub44: ins_67 9×3, speed 3.6,
            // angle 1.57, offset -0.785): three 3-bullet fans at 45° offsets.
            {
              t: 0.5, type: 'aimed', count: 3, spread: 0.3, speed: 3.2,
              angle: Math.PI / 2, angleOffset: -0.785,
              color: '#bb88ff', coreColor: '#eeccff', shape: 'star', interval: 0.6, r: 8
            },
            {
              t: 0.8, type: 'aimed', count: 3, spread: 0.3, speed: 3.2,
              angle: Math.PI / 2, angleOffset: 0.785,
              color: '#bb88ff', coreColor: '#eeccff', shape: 'star', interval: 0.6, r: 8
            },
            {
              t: 1.1, type: 'aimed', count: 3, spread: 0.3, speed: 3.2,
              angle: Math.PI / 2,
              color: '#bb88ff', coreColor: '#eeccff', shape: 'star', interval: 0.6, r: 8
            },
            // Escalating trap rings (Sub44: ins_118 17,6 → color cycling).
            {
              t: 3, type: 'ring', count: 12, speed: 2.2, rotStep: 0.1,
              colors: ['#ff88bb', '#bb88ff', '#eeeeff'], colorStep: 0.3,
              color: '#ff88bb', coreColor: '#ffccee', shape: 'circle', interval: 0.7, r: 8
            },
            // Corner fans (Sub44: second half, 45° diagonal fans).
            {
              t: 5, type: 'fan', count: 5, spread: 0.9, angle: 0.785, speed: 2.8,
              angleStep: 0.06, color: '#ff88bb', coreColor: '#ffccee',
              shape: 'star', interval: 0.8, r: 8
            },
            {
              t: 5, type: 'fan', count: 5, spread: 0.9, angle: -0.785, speed: 2.8,
              angleStep: -0.06, color: '#bb88ff', coreColor: '#eeccff',
              shape: 'star', interval: 0.8, r: 8
            },
          ],
        },
        {
          name: 'Ripples of 495 Years',
          duration: 30,
          hp: 220,
          noBombs: true,
          emits: [
            // L: denser 88-ring (48-way), faster.
            {
              t: 0, type: 'ring', count: 48, speed: 1.4, rotStep: 0.03,
              colors: ['#bb88ff', '#eeeeff', '#ff88bb', '#ffdd88'], colorStep: 0.2,
              color: '#bb88ff', coreColor: '#eeccff', shape: 'circle', interval: 1.3, r: 8
            },
            // L: counter-ring, faster.
            {
              t: 0.6, type: 'ring', count: 48, speed: 1.0, rotStep: -0.03,
              rot: Math.PI / 48,
              colors: ['#eeeeff', '#bb88ff', '#ff88bb', '#ffdd88'], colorStep: 0.2,
              color: '#eeeeff', coreColor: '#ffffff', shape: 'circle', interval: 1.3, r:12
            },
            // L: faster accelerating rings.
            {
              t: 2.5, type: 'ring', count: 36, speed: 1.8, speedStep: 0.03,
              rotStep: 0.05, color: '#bb88ff', coreColor: '#eeccff',
              shape: 'star', interval: 1.0
            },
            // L: final wave, denser.
            {
              t: 5, type: 'ring', count: 52, speed: 2.2, rotStep: 0.04,
              colors: ['#ff88bb', '#bb88ff', '#eeeeff'], colorStep: 0.25,
              color: '#ff88bb', coreColor: '#ffccee', shape: 'circle', interval: 1.1
            },
          ],
        },
      ],
    },
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { BOSSES, getPhases, scalePhase };
}
