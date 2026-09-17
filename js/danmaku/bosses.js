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

// Apply Lunatic scaling to a phase's emits.
function scalePhase(phase, diff) {
  const d = CONFIG.DIFFICULTY[diff];
  const emits = phase.emits.map(em => ({
    ...em,
    speedMul: (em.speedMul !== undefined ? em.speedMul : 1) * d.speed,
    densityMul: (em.densityMul || 1) * d.density,
  }));
  return { ...phase, emits };
}

// Build the phase list for a boss + difficulty.
function getPhases(bossId, difficulty) {
  const boss = BOSSES[bossId];
  if (!boss) return [];
  const base = boss.phases[difficulty === 'lunatic' ? 'lunatic' : 'normal'];
  return base.map(p => scalePhase(p, difficulty));
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
    color: '#c8b8ff', coreColor: '#ece8ff', shape: 'circle', r: 4
  },
  {
    t: 7.0, type: 'fan', count: 7, spread: 0.6283, speed: 1.4,
    angleOffset: 0.3, angleStep: -0.02, interval: 0.5, repeat: 12, period: 12,
    color: '#c8b8ff', coreColor: '#ece8ff', shape: 'circle', r: 4
  },
  // Sub3: narrow 5-bullet 15° fans, counter-sweeping on their own cycle.
  {
    t: 0.7, type: 'fan', count: 5, spread: 0.2618, speed: 1.4,
    angleOffset: -0.5, angleStep: 0.03, interval: 0.3, repeat: 14, period: 8.4,
    color: '#e0e4ff', coreColor: '#ffffff', shape: 'circle', r: 3
  },
  {
    t: 4.9, type: 'fan', count: 5, spread: 0.2618, speed: 1.4,
    angleOffset: 0.5, angleStep: -0.03, interval: 0.3, repeat: 14, period: 8.4,
    color: '#e0e4ff', coreColor: '#ffffff', shape: 'circle', r: 3
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
    color: '#fff8d0', coreColor: '#ffffff', shape: 'circle', r: 4
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
    colors: DEMARCATION_COLORS, shape: 'rice', r: 4, repeat: 1, period: 20
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
    colors: DEMARCATION_COLORS, shape: 'circle', r: 10, repeat: 1, period: 20
  },
  {
    t: 10.4, type: 'fanVolley', count: 13, center: true, spread: Math.PI, rows: 9,
    speed: 3.0, speed2: 1.0,
    colors: DEMARCATION_COLORS, shape: 'circle', r: 10, repeat: 1, period: 20
  },
  {
    t: 11.1, type: 'fanVolley', count: 13, center: true, spread: Math.PI, rows: 10,
    speed: 3.0, speed2: 1.0,
    colors: DEMARCATION_COLORS, shape: 'circle', r: 10, repeat: 1, period: 20
  },
  // Sub21: mirrored escalating streams — 10-bullet 73.8° fans, 2 rows
  // (second row half speed), +0.25 speed per shot, base ∓40.8° stepping
  // ∓8.2°/shot, 16 shots on a 10-frame cadence.
  {
    t: 14.4, type: 'fanVolley', count: 10, center: true, spread: 0.738, rows: 2,
    speed: 1.0, speed2: 0.3, speedStep: 0.25,
    angleOffset: -0.714, angleStep: 0.1428,
    colors: DEMARCATION_COLORS, shape: 'circle', r: 4,
    interval: 0.1667, repeat: 16, period: 20
  },
  {
    t: 17.1, type: 'fanVolley', count: 10, center: true, spread: 0.738, rows: 2,
    speed: 1.0, speed2: 0.3, speedStep: 0.25,
    angleOffset: 0.714, angleStep: -0.1428,
    colors: DEMARCATION_COLORS, shape: 'circle', r: 4,
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
    color: '#88ffcc', coreColor: '#eafff5', shape: 'circle', r: 4
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
    color: '#55ccff',
    bgTop: '#061420',
    bgBottom: '#020810',
    move: 'sine',
    moveAmp: 65,
    moveSpeed: 0.7,
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


  // ── Momiji — Knight (value 3). Shield-based, simple but fast. ──
  momiji: {
    name: 'Momiji',
    color: '#77aaff',
    bgTop: '#0a1020',
    bgBottom: '#04060c',
    move: 'sine',
    moveAmp: 45,
    moveSpeed: 1.1,
    phases: {
      normal: [
        {
          name: 'Non-spell',
          duration: 16,
          hp: 100,
          emits: [
            { t: 0, type: 'aimed', count: 4, spread: 0.25, speed: 3.2, color: '#aaccff', coreColor: '#e8f0ff', shape: 'diamond', interval: 0.4 },
            { t: 0.3, type: 'ring', count: 12, speed: 2, color: '#5588ff', coreColor: '#d0e0ff', shape: 'circle', interval: 1.4 },
          ],
        },
        {
          name: 'Shield Charge',
          duration: 17,
          hp: 120,
          emits: [
            { t: 0, type: 'aimed', count: 6, spread: 0.5, speed: 3.4, color: '#aaccff', coreColor: '#e8f0ff', shape: 'diamond', interval: 0.35 },
            { t: 0.2, type: 'ring', count: 16, speed: 2.2, color: '#77aaff', coreColor: '#d8e8ff', shape: 'circle', interval: 1.1 },
          ],
        },
        {
          name: 'Shield Wall',
          duration: 18,
          hp: 130,
          emits: [
            { t: 0, type: 'ring', count: 20, speed: 1.9, color: '#5588ff', coreColor: '#d0e0ff', shape: 'diamond', rotSpeed: 0.1, interval: 1.2 },
            { t: 0.4, type: 'aimed', count: 3, spread: 0.3, speed: 2.8, color: '#aaccff', coreColor: '#e8f0ff', shape: 'diamond', interval: 0.5 },
          ],
        },
      ],
      lunatic: [
        {
          name: 'Non-spell',
          duration: 16,
          hp: 110,
          emits: [
            { t: 0, type: 'aimed', count: 5, spread: 0.28, speed: 3.3, color: '#aaccff', coreColor: '#e8f0ff', shape: 'diamond', interval: 0.35 },
            { t: 0.3, type: 'ring', count: 16, speed: 2.1, color: '#5588ff', coreColor: '#d0e0ff', shape: 'circle', interval: 1.2 },
          ],
        },
        {
          name: 'Shield Charge',
          duration: 17,
          hp: 130,
          emits: [
            { t: 0, type: 'aimed', count: 8, spread: 0.55, speed: 3.5, color: '#aaccff', coreColor: '#e8f0ff', shape: 'diamond', interval: 0.3 },
            { t: 0.2, type: 'ring', count: 20, speed: 2.3, color: '#77aaff', coreColor: '#d8e8ff', shape: 'circle', interval: 0.95 },
          ],
        },
        {
          name: 'Shield Wall',
          duration: 18,
          hp: 140,
          emits: [
            { t: 0, type: 'ring', count: 24, speed: 2, color: '#5588ff', coreColor: '#d0e0ff', shape: 'diamond', rotSpeed: 0.12, interval: 1.05 },
            { t: 0.4, type: 'aimed', count: 4, spread: 0.32, speed: 2.9, color: '#aaccff', coreColor: '#e8f0ff', shape: 'diamond', interval: 0.45 },
          ],
        },
        {
          name: 'Shield Barrage',
          duration: 18,
          hp: 150,
          emits: [
            { t: 0, type: 'aimed', count: 6, spread: 0.4, speed: 3.5, color: '#aaccff', coreColor: '#e8f0ff', shape: 'diamond', interval: 0.3 },
            { t: 0.25, type: 'fan', count: 7, spread: 1.2, speed: 2.6, color: '#77aaff', coreColor: '#d8e8ff', shape: 'circle', interval: 0.8 },
          ],
        },
      ],
    },
  },

  // ── Patchouli — Bishop (value 3). Elemental magic. ──
  patchouli: {
    name: 'Patchouli',
    color: '#cc88ff',
    bgTop: '#140a20',
    bgBottom: '#08040e',
    move: 'sine',
    moveAmp: 40,
    moveSpeed: 0.7,
    phases: {
      normal: [
        {
          name: 'Non-spell',
          duration: 16,
          hp: 100,
          emits: [
            { t: 0, type: 'aimed', count: 4, spread: 0.4, speed: 2.8, color: '#ff8833', coreColor: '#ffe0c0', shape: 'circle', interval: 0.45 },
            { t: 0.3, type: 'aimed', count: 2, spread: 0.6, speed: 2.2, color: '#ff5533', coreColor: '#ffd0c0', shape: 'circle', interval: 0.7 },
          ],
        },
        {
          name: 'Agni Shine',
          duration: 17,
          hp: 120,
          emits: [
            { t: 0, type: 'aimed', count: 7, spread: 0.7, speed: 3.2, color: '#ff6622', coreColor: '#ffe8d0', shape: 'star', interval: 0.35 },
            { t: 0.4, type: 'ring', count: 14, speed: 2, color: '#ff8844', coreColor: '#ffe8d0', shape: 'circle', interval: 1.2 },
          ],
        },
        {
          name: 'Princess Undine',
          duration: 18,
          hp: 130,
          emits: [
            { t: 0, type: 'ring', count: 18, speed: 2.2, color: '#44aaff', coreColor: '#d0ecff', shape: 'circle', interval: 1 },
            { t: 0.3, type: 'aimed', count: 5, spread: 0.3, speed: 3.5, color: '#66ccff', coreColor: '#e0f4ff', shape: 'diamond', interval: 0.4 },
          ],
        },
      ],
      lunatic: [
        {
          name: 'Non-spell',
          duration: 16,
          hp: 110,
          emits: [
            { t: 0, type: 'aimed', count: 5, spread: 0.45, speed: 2.9, color: '#ff8833', coreColor: '#ffe0c0', shape: 'circle', interval: 0.4 },
            { t: 0.3, type: 'aimed', count: 3, spread: 0.65, speed: 2.3, color: '#ff5533', coreColor: '#ffd0c0', shape: 'circle', interval: 0.6 },
          ],
        },
        {
          name: 'Agni Shine',
          duration: 17,
          hp: 130,
          emits: [
            { t: 0, type: 'aimed', count: 9, spread: 0.75, speed: 3.3, color: '#ff6622', coreColor: '#ffe8d0', shape: 'star', interval: 0.3 },
            { t: 0.4, type: 'ring', count: 18, speed: 2.1, color: '#ff8844', coreColor: '#ffe8d0', shape: 'circle', interval: 1 },
          ],
        },
        {
          name: 'Princess Undine',
          duration: 18,
          hp: 140,
          emits: [
            { t: 0, type: 'ring', count: 22, speed: 2.3, color: '#44aaff', coreColor: '#d0ecff', shape: 'circle', interval: 0.85 },
            { t: 0.3, type: 'aimed', count: 6, spread: 0.32, speed: 3.6, color: '#66ccff', coreColor: '#e0f4ff', shape: 'diamond', interval: 0.35 },
          ],
        },
        {
          name: 'Metal Fatigue',
          duration: 18,
          hp: 150,
          emits: [
            { t: 0, type: 'aimed', count: 6, spread: 0.5, speed: 3, color: '#ccccdd', coreColor: '#ffffff', shape: 'diamond', interval: 0.4 },
            { t: 0.5, type: 'spiral', arms: 3, rotSpeed: 0.3, speed: 2.4, color: '#aabbcc', coreColor: '#eef0ff', shape: 'diamond', interval: 0.18 },
          ],
        },
      ],
    },
  },

  // ── Alice — Bishop (value 3). Dolls. ──
  alice: {
    name: 'Alice',
    color: '#cc66ff',
    bgTop: '#1a0a24',
    bgBottom: '#0a0410',
    move: 'sine',
    moveAmp: 50,
    moveSpeed: 0.8,
    phases: {
      normal: [
        {
          name: 'Non-spell',
          duration: 16,
          hp: 100,
          emits: [
            { t: 0, type: 'aimed', count: 5, spread: 0.5, speed: 2.8, color: '#ff99cc', coreColor: '#ffe0f0', shape: 'petal', interval: 0.4 },
            { t: 0.3, type: 'ring', count: 12, speed: 1.9, color: '#cc66ff', coreColor: '#f0d0ff', shape: 'circle', interval: 1.3 },
          ],
        },
        {
          name: 'Thousand Spear Dolls',
          duration: 17,
          hp: 120,
          emits: [
            { t: 0, type: 'ring', count: 20, speed: 2.4, color: '#ff99cc', coreColor: '#ffe0f0', shape: 'diamond', interval: 0.9 },
            { t: 0.3, type: 'aimed', count: 4, spread: 0.3, speed: 3, color: '#cc66ff', coreColor: '#f0d0ff', shape: 'star', interval: 0.5 },
          ],
        },
        {
          name: 'Dolls of War',
          duration: 18,
          hp: 130,
          emits: [
            { t: 0, type: 'spiral', arms: 4, rotSpeed: 0.35, speed: 2.5, color: '#ff99cc', coreColor: '#ffe0f0', shape: 'petal', interval: 0.14 },
            { t: 0.4, type: 'ring', count: 16, speed: 2, color: '#cc66ff', coreColor: '#f0d0ff', shape: 'circle', interval: 1.1 },
          ],
        },
      ],
      lunatic: [
        {
          name: 'Non-spell',
          duration: 16,
          hp: 110,
          emits: [
            { t: 0, type: 'aimed', count: 6, spread: 0.55, speed: 2.9, color: '#ff99cc', coreColor: '#ffe0f0', shape: 'petal', interval: 0.35 },
            { t: 0.3, type: 'ring', count: 16, speed: 2, color: '#cc66ff', coreColor: '#f0d0ff', shape: 'circle', interval: 1.1 },
          ],
        },
        {
          name: 'Thousand Spear Dolls',
          duration: 17,
          hp: 130,
          emits: [
            { t: 0, type: 'ring', count: 26, speed: 2.5, color: '#ff99cc', coreColor: '#ffe0f0', shape: 'diamond', interval: 0.75 },
            { t: 0.3, type: 'aimed', count: 5, spread: 0.32, speed: 3.1, color: '#cc66ff', coreColor: '#f0d0ff', shape: 'star', interval: 0.45 },
          ],
        },
        {
          name: 'Dolls of War',
          duration: 18,
          hp: 140,
          emits: [
            { t: 0, type: 'spiral', arms: 5, rotSpeed: 0.38, speed: 2.6, color: '#ff99cc', coreColor: '#ffe0f0', shape: 'petal', interval: 0.12 },
            { t: 0.4, type: 'ring', count: 20, speed: 2.1, color: '#cc66ff', coreColor: '#f0d0ff', shape: 'circle', interval: 0.95 },
          ],
        },
        {
          name: 'Explosive-laden Dolls',
          duration: 18,
          hp: 150,
          emits: [
            { t: 0, type: 'fan', count: 9, spread: 1.8, speed: 2.8, color: '#ff99cc', coreColor: '#ffe0f0', shape: 'petal', interval: 0.6, angle: Math.PI * 0.5 },
            { t: 0.3, type: 'aimed', count: 5, spread: 0.4, speed: 3.2, color: '#cc66ff', coreColor: '#f0d0ff', shape: 'star', interval: 0.4 },
          ],
        },
      ],
    },
  },

  // ── Remilia — Rook (value 5). Vampire final-boss pressure. ──
  remilia: {
    name: 'Remilia',
    color: '#ff3344',
    bgTop: '#1e0810',
    bgBottom: '#0a0406',
    move: 'sine',
    moveAmp: 60,
    moveSpeed: 0.85,
    phases: {
      normal: [
        {
          name: 'Non-spell',
          duration: 16,
          hp: 110,
          emits: [
            { t: 0, type: 'fan', count: 5, spread: 0.8, speed: 3, color: '#ff3344', coreColor: '#ffb0b8', shape: 'circle', interval: 0.5 },
            { t: 0.4, type: 'ring', count: 14, speed: 2.2, color: '#ff5566', coreColor: '#ffc0c8', shape: 'diamond', interval: 1.2 },
          ],
        },
        {
          name: 'Scarlet Shoot',
          duration: 17,
          hp: 130,
          emits: [
            { t: 0, type: 'fan', count: 5, spread: 0.6, speed: 3.8, color: '#ff2233', coreColor: '#ffb0b8', shape: 'circle', interval: 0.4, r: 6 },
            { t: 0.3, type: 'fan', count: 5, spread: 0.6, speed: 3.8, color: '#ff2233', coreColor: '#ffb0b8', shape: 'circle', interval: 0.4, r: 6, angle: Math.PI * 0.5 },
          ],
        },
        {
          name: 'Scarlet Netherworld',
          duration: 18,
          hp: 140,
          emits: [
            { t: 0, type: 'ring', count: 20, speed: 2.4, color: '#ff3344', coreColor: '#ffb0b8', shape: 'diamond', interval: 0.9 },
            { t: 0.4, type: 'aimed', count: 4, spread: 0.3, speed: 3.2, color: '#ff5566', coreColor: '#ffc0c8', shape: 'circle', interval: 0.5 },
          ],
        },
        {
          name: 'Spear the Gungnir',
          duration: 18,
          hp: 150,
          emits: [
            { t: 0, type: 'laser', count: 1, speed: 3.5, color: '#ff2233', coreColor: '#ffb0b8', shape: 'diamond', interval: 0.5, laserLen: 10 },
            { t: 0.3, type: 'ring', count: 16, speed: 2.2, color: '#ff5566', coreColor: '#ffc0c8', shape: 'circle', interval: 1 },
          ],
        },
      ],
      lunatic: [
        {
          name: 'Non-spell',
          duration: 16,
          hp: 120,
          emits: [
            { t: 0, type: 'fan', count: 6, spread: 0.85, speed: 3.1, color: '#ff3344', coreColor: '#ffb0b8', shape: 'circle', interval: 0.45 },
            { t: 0.4, type: 'ring', count: 18, speed: 2.3, color: '#ff5566', coreColor: '#ffc0c8', shape: 'diamond', interval: 1 },
          ],
        },
        {
          name: 'Scarlet Shoot',
          duration: 17,
          hp: 140,
          emits: [
            { t: 0, type: 'fan', count: 6, spread: 0.65, speed: 3.9, color: '#ff2233', coreColor: '#ffb0b8', shape: 'circle', interval: 0.35, r: 6 },
            { t: 0.3, type: 'fan', count: 6, spread: 0.65, speed: 3.9, color: '#ff2233', coreColor: '#ffb0b8', shape: 'circle', interval: 0.35, r: 6, angle: Math.PI * 0.5 },
          ],
        },
        {
          name: 'Scarlet Netherworld',
          duration: 18,
          hp: 150,
          emits: [
            { t: 0, type: 'ring', count: 26, speed: 2.5, color: '#ff3344', coreColor: '#ffb0b8', shape: 'diamond', interval: 0.75 },
            { t: 0.4, type: 'aimed', count: 5, spread: 0.32, speed: 3.3, color: '#ff5566', coreColor: '#ffc0c8', shape: 'circle', interval: 0.45 },
          ],
        },
        {
          name: 'Spear the Gungnir',
          duration: 18,
          hp: 160,
          emits: [
            { t: 0, type: 'laser', count: 1, speed: 3.6, color: '#ff2233', coreColor: '#ffb0b8', shape: 'diamond', interval: 0.4, laserLen: 12 },
            { t: 0.3, type: 'ring', count: 20, speed: 2.3, color: '#ff5566', coreColor: '#ffc0c8', shape: 'circle', interval: 0.85 },
          ],
        },
        {
          name: 'Star of David',
          duration: 18,
          hp: 170,
          emits: [
            { t: 0, type: 'laser', count: 1, speed: 3.5, color: '#ff2233', coreColor: '#ffb0b8', shape: 'diamond', interval: 0.45, laserLen: 10 },
            { t: 0.2, type: 'ring', count: 18, speed: 2.6, color: '#4488ff', coreColor: '#d0e0ff', shape: 'star', rotSpeed: 0.2, interval: 0.7 },
          ],
        },
      ],
    },
  },

  // ── Yuyuko — Rook (value 5). Death / butterfly / cherry-blossom. ──
  yuyuko: {
    name: 'Yuyuko',
    color: '#6688ff',
    bgTop: '#0a0e24',
    bgBottom: '#04060e',
    move: 'sine',
    moveAmp: 50,
    moveSpeed: 0.75,
    phases: {
      normal: [
        {
          name: 'Non-spell',
          duration: 16,
          hp: 110,
          emits: [
            { t: 0, type: 'ring', count: 16, speed: 2, color: '#6688ff', coreColor: '#d0dcff', shape: 'petal', rotSpeed: 0.1, interval: 1.1 },
            { t: 0.4, type: 'aimed', count: 3, spread: 0.3, speed: 2.6, color: '#88aaff', coreColor: '#e0e8ff', shape: 'circle', interval: 0.55 },
          ],
        },
        {
          name: 'Dance of the Dead Butterflies',
          duration: 17,
          hp: 130,
          emits: [
            { t: 0, type: 'ring', count: 18, speed: 2.2, color: '#6688ff', coreColor: '#d0dcff', shape: 'petal', rotSpeed: 0.15, interval: 0.9, angle: Math.PI * 0.3 },
            { t: 0.4, type: 'ring', count: 18, speed: 2.2, color: '#88aaff', coreColor: '#e0e8ff', shape: 'petal', rotSpeed: -0.15, interval: 0.9, angle: Math.PI * 0.7 },
          ],
        },
        {
          name: 'Ghost Spot',
          duration: 18,
          hp: 140,
          emits: [
            { t: 0, type: 'spiral', arms: 2, rotSpeed: 0.3, speed: 2.4, color: '#6688ff', coreColor: '#d0dcff', shape: 'petal', interval: 0.15 },
            { t: 0.5, type: 'aimed', count: 5, spread: 0.5, speed: 3, color: '#ff6688', coreColor: '#ffd0d8', shape: 'petal', interval: 0.5 },
            { t: 0.3, type: 'ring', count: 12, speed: 1.8, color: '#9966ff', coreColor: '#e0d0ff', shape: 'circle', interval: 1.3 },
          ],
        },
        {
          name: 'Eternal Sleep in Dreamland',
          duration: 18,
          hp: 150,
          emits: [
            { t: 0, type: 'spiral', arms: 4, rotSpeed: 0.35, speed: 2.6, color: '#6688ff', coreColor: '#d0dcff', shape: 'petal', interval: 0.12 },
            { t: 0.4, type: 'ring', count: 20, speed: 2, color: '#88aaff', coreColor: '#e0e8ff', shape: 'circle', interval: 1 },
          ],
        },
      ],
      lunatic: [
        {
          name: 'Non-spell',
          duration: 16,
          hp: 120,
          emits: [
            { t: 0, type: 'ring', count: 20, speed: 2.1, color: '#6688ff', coreColor: '#d0dcff', shape: 'petal', rotSpeed: 0.12, interval: 0.95 },
            { t: 0.4, type: 'aimed', count: 4, spread: 0.32, speed: 2.7, color: '#88aaff', coreColor: '#e0e8ff', shape: 'circle', interval: 0.5 },
          ],
        },
        {
          name: 'Dance of the Dead Butterflies',
          duration: 17,
          hp: 140,
          emits: [
            { t: 0, type: 'ring', count: 22, speed: 2.3, color: '#6688ff', coreColor: '#d0dcff', shape: 'petal', rotSpeed: 0.16, interval: 0.75, angle: Math.PI * 0.3 },
            { t: 0.4, type: 'ring', count: 22, speed: 2.3, color: '#88aaff', coreColor: '#e0e8ff', shape: 'petal', rotSpeed: -0.16, interval: 0.75, angle: Math.PI * 0.7 },
          ],
        },
        {
          name: 'Ghost Spot',
          duration: 18,
          hp: 150,
          emits: [
            { t: 0, type: 'spiral', arms: 3, rotSpeed: 0.32, speed: 2.5, color: '#6688ff', coreColor: '#d0dcff', shape: 'petal', interval: 0.13 },
            { t: 0.5, type: 'aimed', count: 6, spread: 0.55, speed: 3.1, color: '#ff6688', coreColor: '#ffd0d8', shape: 'petal', interval: 0.45 },
            { t: 0.3, type: 'ring', count: 16, speed: 1.9, color: '#9966ff', coreColor: '#e0d0ff', shape: 'circle', interval: 1.1 },
          ],
        },
        {
          name: 'Eternal Sleep in Dreamland',
          duration: 18,
          hp: 160,
          emits: [
            { t: 0, type: 'spiral', arms: 5, rotSpeed: 0.38, speed: 2.7, color: '#6688ff', coreColor: '#d0dcff', shape: 'petal', interval: 0.1 },
            { t: 0.4, type: 'ring', count: 24, speed: 2.1, color: '#88aaff', coreColor: '#e0e8ff', shape: 'circle', interval: 0.85 },
          ],
        },
        {
          name: 'Ageless Dream',
          duration: 18,
          hp: 170,
          emits: [
            // life: missed aimed bullets orbit the player and never leave
            // the screen, so they need a finite lifetime (see header note).
            { t: 0, type: 'aimed', count: 4, speed: 2.8, color: '#9966ff', coreColor: '#e0d0ff', shape: 'petal', turn: 0.04, interval: 0.7, life: 600 },
            { t: 0.3, type: 'spiral', arms: 3, rotSpeed: 0.3, speed: 2.4, color: '#6688ff', coreColor: '#d0dcff', shape: 'circle', interval: 0.15 },
          ],
        },
      ],
    },
  },

  // ── Yukari — Queen (value 9). Boundary manipulation, screen-control. ──
  yukari: {
    name: 'Yukari',
    color: '#8844cc',
    bgTop: '#120820',
    bgBottom: '#06040c',
    move: 'sine',
    moveAmp: 70,
    moveSpeed: 1,
    phases: {
      normal: [
        {
          name: 'Non-spell',
          duration: 16,
          hp: 120,
          emits: [
            { t: 0, type: 'aimed', count: 4, spread: 0.35, speed: 3, color: '#aa66ff', coreColor: '#e0d0ff', shape: 'circle', interval: 0.45 },
            { t: 0.4, type: 'ring', count: 14, speed: 2.2, color: '#8844cc', coreColor: '#d0b0ff', shape: 'diamond', interval: 1.2 },
          ],
        },
        {
          name: 'Curse of Dreams and Reality',
          duration: 17,
          hp: 140,
          emits: [
            { t: 0, type: 'spiral', arms: 3, rotSpeed: 0.25, speed: 2.4, color: '#44dddd', coreColor: '#d0ffff', shape: 'rice', interval: 0.14 },
            // life: missed aimed bullets orbit the player and never leave
            // the screen, so they need a finite lifetime (see header note).
            { t: 0.6, type: 'aimed', count: 3, speed: 2.6, color: '#44dddd', coreColor: '#d0ffff', shape: 'rice', turn: 0.035, interval: 0.8, life: 600 },
          ],
        },
        {
          name: 'Balance of Motion and Stillness',
          duration: 18,
          hp: 150,
          emits: [
            { t: 0, type: 'fan', count: 5, spread: 0.8, speed: 2.8, color: '#aa66ff', coreColor: '#e0d0ff', shape: 'circle', interval: 0.5 },
            { t: 0.3, type: 'spiral', arms: 4, rotSpeed: 0.3, speed: 2.5, color: '#8844cc', coreColor: '#d0b0ff', shape: 'diamond', interval: 0.13 },
          ],
        },
        {
          name: 'Mesh of Light and Darkness',
          duration: 18,
          hp: 160,
          emits: [
            { t: 0, type: 'ring', count: 16, speed: 2.4, color: '#ffcc44', coreColor: '#fff0d0', shape: 'circle', interval: 0.9 },
            { t: 0.2, type: 'ring', count: 16, speed: 2.4, color: '#4466ff', coreColor: '#d0d8ff', shape: 'circle', interval: 0.9, rot: Math.PI / 16 },
          ],
        },
      ],
      lunatic: [
        {
          name: 'Non-spell',
          duration: 16,
          hp: 130,
          emits: [
            { t: 0, type: 'aimed', count: 5, spread: 0.38, speed: 3.1, color: '#aa66ff', coreColor: '#e0d0ff', shape: 'circle', interval: 0.4 },
            { t: 0.4, type: 'ring', count: 18, speed: 2.3, color: '#8844cc', coreColor: '#d0b0ff', shape: 'diamond', interval: 1 },
          ],
        },
        {
          name: 'Curse of Dreams and Reality',
          duration: 17,
          hp: 150,
          emits: [
            { t: 0, type: 'spiral', arms: 4, rotSpeed: 0.28, speed: 2.5, color: '#44dddd', coreColor: '#d0ffff', shape: 'rice', interval: 0.12 },
            { t: 0.6, type: 'aimed', count: 4, speed: 2.7, color: '#44dddd', coreColor: '#d0ffff', shape: 'rice', turn: 0.04, interval: 0.65, life: 600 },
          ],
        },
        {
          name: 'Balance of Motion and Stillness',
          duration: 18,
          hp: 160,
          emits: [
            { t: 0, type: 'fan', count: 6, spread: 0.85, speed: 2.9, color: '#aa66ff', coreColor: '#e0d0ff', shape: 'circle', interval: 0.45 },
            { t: 0.3, type: 'spiral', arms: 5, rotSpeed: 0.32, speed: 2.6, color: '#8844cc', coreColor: '#d0b0ff', shape: 'diamond', interval: 0.11 },
          ],
        },
        {
          name: 'Mesh of Light and Darkness',
          duration: 18,
          hp: 170,
          emits: [
            { t: 0, type: 'ring', count: 20, speed: 2.5, color: '#ffcc44', coreColor: '#fff0d0', shape: 'circle', interval: 0.75 },
            { t: 0.2, type: 'ring', count: 20, speed: 2.5, color: '#4466ff', coreColor: '#d0d8ff', shape: 'circle', interval: 0.75, rot: Math.PI / 20 },
          ],
        },
        {
          name: 'Addictive Bait',
          duration: 18,
          hp: 180,
          emits: [
            { t: 0, type: 'aimed', count: 6, spread: 0.2, speed: 4.5, color: '#aa66ff', coreColor: '#e0d0ff', shape: 'rice', interval: 0.35 },
            { t: 0.3, type: 'ring', count: 18, speed: 2.4, color: '#8844cc', coreColor: '#d0b0ff', shape: 'diamond', interval: 0.9 },
          ],
        },
      ],
    },
  },

  // ── Kaguya — King (value ∞), the final boss. Eternity + Impossible Requests. ──
  kaguya: {
    name: 'Kaguya',
    color: '#ffdd88',
    bgTop: '#1a1428',
    bgBottom: '#0a0812',
    move: 'sine',
    moveAmp: 65,
    moveSpeed: 0.9,
    phases: {
      normal: [
        {
          name: 'Non-spell',
          duration: 17,
          hp: 130,
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
            { t: 2, type: 'ring', count: 32, speed: 1.1, rotStep: 0.1, color: '#ffdd88', coreColor: '#fff8e0', shape: 'star', interval: 1.6 },
            { t: 2.85, type: 'ring', count: 32, speed: 1.5, rotStep: -0.1, color: '#66aaff', coreColor: '#e0f0ff', shape: 'star', interval: 1.6 },
          ],
        },
        {
          name: "Buddha's Stone Bowl",
          duration: 25,
          hp: 160,
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
          emits: [
            // The Eternity Line (永命線, Sub67/68): the moon hurls a giant
            // 13-ray ring in two opposite, counter-rotating waves (the source
            // fires two 13/12-ray circles back-to-back, speed rows 3.0 -> 1.5).
            {
              t: 0, type: 'ring', count: 27, speed: 2.8, rotStep: 0.05, aimRing: true,
              color: '#ffdd88', coreColor: '#fff8e0', shape: 'circle', interval: 1.5, r: 14
            },
            {
              t: 0.75, type: 'ring', count: 27, speed: 2.2, rotStep: -0.05, rot: Math.PI / 13,
              color: '#ffeebb', coreColor: '#fffbe0', shape: 'circle', interval: 1.5, r: 14
            },
            // Life Spring Infinity (H/L, Sub69): the moon erupts a full-circle
            // laser burst (52 beams). Approximated as a fast-rotating 12-beam
            // laser wheel sweeping the screen.
            {
              t: 1.6, type: 'laser', count: 1, speed: 0, laserLen: 700, angleOffset: TAU_LOCAL / 36, interval: 3.2, warn: 1.0,
              color: '#66ffcc', coreColor: '#d8fff0', shape: 'diamond'
            },
            // The aimed laser wall (Sub66): a thick beam through the boss,
            // refired on a slow cadence.
            {
              t: 1.6, type: 'laser', count: 1, speed: 0, laserLen: 700, interval: 3.2, warn: 1, angleOffset: -TAU_LOCAL/36,
              color: '#ffdd88', coreColor: '#fff8e0', shape: 'diamond'
            },
            {t: 2.6, type: 'fan', count: 120, speed: 3, spread: TAU_LOCAL*17/18, r: 10, shape: 'rice', color: '#fe8080', interval: 3.2, period: 0.1, repeat: 5, angleOffset: TAU_LOCAL/2, aimTime: 1.6}
          ],
        },
        {
          name: 'Eternal Night Reversal',
          duration: 30,
          hp: 200,
          noBombs: true,
          emits: [
            // Penglai branch (Sub72-74): counter-rotating 16-ray rings in
            // dream colors (夢色の郷) — the "rainbow danmaku" (虹色の弾幕).
            {
              t: 0, type: 'ring', count: 16, speed: 2.2, rotStep: 0.06, aimRing: true,
              colors: ['#ff88bb', '#ffaa44', '#ffee44', '#66ff99', '#66aaff', '#bb88ff'], colorStep: 0.3,
              color: '#bb88ff', coreColor: '#efe0ff', shape: 'circle', interval: 1.1
            },
            {
              t: 0.55, type: 'ring', count: 16, speed: 2.2, rotStep: -0.06, rot: Math.PI / 16,
              colors: ['#66aaff', '#bb88ff', '#ff88bb', '#ffaa44', '#ffee44', '#66ff99'], colorStep: 0.3,
              color: '#66aaff', coreColor: '#e0ecff', shape: 'circle', interval: 1.1
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
            {
              t: 1.1, type: 'spiral', arms: 8, rotSpeed: 0.42, speed: 2.6,
              color: '#66ffcc', coreColor: '#d8fff0', shape: 'circle', interval: 0.07
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
  // Phantasm Stage boss of EoSD (Touhou 6). Mechanics mined from the REAL
  // EoSD stage-7 ECL script (eosd_extract/ecl/disasm/ecldata7_utf8.txt)
  // decoded against the decompiled ECL VM + BulletManager.
  //
  // 13 spell cards in the ECL (Sub22/23/24/33/36/39/44/48/50/54/57/60/68);
  // this port uses the most visually distinctive six:
  //   Moon Sign "Silent Serena" (月符「サイレントセレナ」, Sub22):
  //     random-angle slow rings + aimed 8-way fans, moonlight palette.
  //   Sun Sign "Royal Flare" (日符「ロイヤルフレア」, Sub23):
  //     rotating multi-directional streams that sweep the screen.
  //   Fire-Water-Wood-Metal-Earth Sign "Philosopher's Stone"
  //     (火水木金土符「賢者の石」, Sub24): five sub-entities each firing
  //     a different pattern (ring / aimed / spiral / ray / aimed).
  //   Forbidden "Kagome Kagome" (禁忌「カゴメカゴメ」, Sub44):
  //     spawning gap-traps that fire 9-bullet rings + aimed 3-way fans.
  //   Forbidden "Cranberry Trap" (禁忌「クランベリートラップ」, Sub33):
  //     wandering traps that dash and fire aimed streams.
  //   QED "Ripples of 495 Years" (ＱＥＤ「４９５年の波紋」, Sub68):
  //     massive 88-bullet ring waves — the finale.
  //
  // Barrage subs (Sub32/35/38/43/47/49/53/56/59) share a common pattern:
  //   ins_70(2, 2|6, 64|32, 2|3, 2.0|2.5|3.5, 1.0, -10005, 0, 513)
  //   = 64/32-ray ring, speed 2-3.5, refired every 30-60f, with the aim
  //     angle randomized each cycle (ins_9 random + ins_50 ±π range).
  //   Translated as a rotating ring with per-cycle angle jitter.

  yukari: {
    name: 'Yukari',
    color: '#bb88ff',
    bgTop: '#1a1028',
    bgBottom: '#0a0614',
    move: 'sine',
    moveAmp: 55,
    moveSpeed: 0.7,
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
              shape: 'circle', interval: 0.9
            },
            // Counter-sweep (Sub23: second loop, opposite direction).
            {
              t: 2.5, type: 'fan', count: 5, spread: 1.05, speed: 2.0,
              angleStep: -0.04, angleOffset: Math.PI,
              color: '#ffaa44', coreColor: '#ffe8c0', shape: 'circle', interval: 0.9
            },
            // Golden ring burst (Sub23: ins_121 13,3/5/6 → escalating).
            {
              t: 4, type: 'ring', count: 20, speed: 2.0, rotStep: 0.05,
              colors: ['#ffdd88', '#ffaa44', '#ffee44'], colorStep: 0.3,
              color: '#ffdd88', coreColor: '#fff8e0', shape: 'star', interval: 1.0
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
              color: '#ff5566', coreColor: '#ffd0d8', shape: 'circle', interval: 0.55
            },
            // Water (Sub26): 6×11 aimed, speed 3.0→2.6, angle 0.26.
            {
              t: 0.8, type: 'aimed', count: 11, spread: 0.52, speed: 2.8,
              color: '#66aaff', coreColor: '#e0ecff',
              shape: 'circle', interval: 1.1
            },
            // Wood (Sub27): 10×10 spiral, speed 2.0→0.3, angle π→-π.
            {
              t: 1.6, type: 'spiral', arms: 20, rotSpeed: 0.3, speed: 1.8,
              color: '#66ff99', coreColor: '#d8ffe8', shape: 'petal', interval: 0.24
            },
            // Metal (Sub28): 16-ray, speed 4.0→1.0, angle from var.
            {
              t: 2.4, type: 'ring', count: 16, speed: 2.6, rotStep: 0.06,
              color: '#cccccc', coreColor: '#ffffff', shape: 'diamond', interval: 0.8
            },
            // Earth (Sub29): 13-bullet aimed, speed 2.4→1.0, angle π/2.
            {
              t: 3.2, type: 'aimed', count: 13, spread: 0.8, speed: 2.2,
              angle: Math.PI / 2, angleOffset: 0.1,
              color: '#ffaa44', coreColor: '#ffe8c0', shape: 'rice', interval: 1.0
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
            // Final wave (Sub68: ins_121 16,0/1 → two ring variants).
            {
              t: 6, type: 'ring', count: 48, speed: 2.8, rotStep: 0.03, r: 2.0,
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
              shape: 'circle', interval: 0.7
            },
            {
              t: 2.2, type: 'fan', count: 7, spread: 1.2, speed: 2.3, centered: true,
              angleStep: -0.05, angleOffset: Math.PI,
              color: '#ffaa44', coreColor: '#ffe8c0', shape: 'circle', interval: 0.7
            },
            // L: denser golden ring.
            {
              t: 3.5, type: 'ring', count: 24, speed: 2.4, rotStep: 0.06,
              colors: ['#ffdd88', '#ffaa44', '#ffee44'], colorStep: 0.25,
              color: '#ffdd88', coreColor: '#fff8e0', shape: 'star', interval: 0.8
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
              color: '#ff5566', coreColor: '#ffd0d8', shape: 'circle', interval: 0.45
            },
            {
              t: 0.6, type: 'aimed', count: 13, spread: 0.6, speed: 3.0, centered: true,
              angleOffset: 0.26, color: '#66aaff', coreColor: '#e0ecff',
              shape: 'circle', interval: 0.9
            },
            {
              t: 1.4, type: 'spiral', arms: 12, rotSpeed: 0.35, speed: 2.0,
              color: '#66ff99', coreColor: '#d8ffe8', shape: 'petal', interval: 0.07
            },
            {
              t: 2.2, type: 'ring', count: 20, speed: 3.0, rotStep: 0.07,
              color: '#cccccc', coreColor: '#ffffff', shape: 'diamond', interval: 0.7
            },
            {
              t: 3.0, type: 'aimed', count: 15, spread: 0.9, speed: 2.5, centered: true,
              angle: Math.PI / 2, angleOffset: 0.1,
              color: '#ffaa44', coreColor: '#ffe8c0', shape: 'rice', interval: 0.8
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
              color: '#ff88bb', coreColor: '#ffccee', shape: 'circle', interval: 0.8
            },
            // Aimed 3-way fans (Sub44: ins_67 9×3, speed 3.6,
            // angle 1.57, offset -0.785): three 3-bullet fans at 45° offsets.
            {
              t: 0.5, type: 'aimed', count: 3, spread: 0.3, speed: 3.2,
              angle: Math.PI / 2, angleOffset: -0.785,
              color: '#bb88ff', coreColor: '#eeccff', shape: 'star', interval: 0.6
            },
            {
              t: 0.8, type: 'aimed', count: 3, spread: 0.3, speed: 3.2,
              angle: Math.PI / 2, angleOffset: 0.785,
              color: '#bb88ff', coreColor: '#eeccff', shape: 'star', interval: 0.6
            },
            {
              t: 1.1, type: 'aimed', count: 3, spread: 0.3, speed: 3.2,
              angle: Math.PI / 2,
              color: '#bb88ff', coreColor: '#eeccff', shape: 'star', interval: 0.6
            },
            // Escalating trap rings (Sub44: ins_118 17,6 → color cycling).
            {
              t: 3, type: 'ring', count: 12, speed: 2.2, rotStep: 0.1,
              colors: ['#ff88bb', '#bb88ff', '#eeeeff'], colorStep: 0.3,
              color: '#ff88bb', coreColor: '#ffccee', shape: 'circle', interval: 0.7
            },
            // Corner fans (Sub44: second half, 45° diagonal fans).
            {
              t: 5, type: 'fan', count: 5, spread: 0.9, angle: 0.785, speed: 2.8,
              angleStep: 0.06, color: '#ff88bb', coreColor: '#ffccee',
              shape: 'star', interval: 0.8
            },
            {
              t: 5, type: 'fan', count: 5, spread: 0.9, angle: -0.785, speed: 2.8,
              angleStep: -0.06, color: '#bb88ff', coreColor: '#eeccff',
              shape: 'star', interval: 0.8
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
