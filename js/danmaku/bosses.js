// bosses.js — the 9 boss fight scripts, data-driven.
// Each boss has a set of phases (spell cards) for Normal and Lunatic.
// Lunatic = one extra phase + scaled-up parameters (speed, density, homing).
//
// Emit types: point, aimed, ring, spiral, fan, homing, curve, laser.
//   - aimed / fan: use ODD counts so one bullet is dead-center on the player.
//     An even count leaves the aim line open and the pattern is far weaker.
//   - curve: expanding spiral around the spawn point (bearing rotates by
//     `curve` rad/frame, radius grows at `speed`).
//   - laser: a beam `laserLen` px long along the aim line, drawn as bullets
//     `spacing` (default 8) px apart, refired every `interval`.
// Bullet shapes: circle, star, petal, cross, diamond, rice.
// Phase fields: name, duration (s), hp, noBombs (bool), emits[].
// Emit fields: t (start s), type, count, speed, spread, angle, arms,
//   rotSpeed, rot, turn, curve, laserLen, interval, repeat,
//   r, color, coreColor, shape, speedMul, densityMul.

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
    speedMul: (em.speedMul || 1) * d.speed,
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
// difficulty, so sharing the arrays is safe). Mechanics mined from real
// Danmakufu spell scripts (refs/extracted/SCC Ver1.10a .../spellcard/Rumia):
//   Spell01 — full-screen paired laser sweeps + accelerating tip volleys
//   Spell02 — counter-rotating 12-way rice rings + HP-tiered dark aimed shots
//   Spell03 — streams of accelerating 5-fans + orbiting laser shooters
//   Spell04 — expanding flower-of-flowers + accelerating single-laser sweep
// Flow principle: short bursts separated by breathing room, escalating
// within each card, mixed bullet layers (slow decorative + fast threat).

// Night Sign "Night Bird": flocks of 16-bullet arcs that bank outward like
// wings — left wing blue, right wing green, one crimson bullet dead-aimed
// in every flock. Four escalating sections: lone flocks -> paired flocks on
// a 2.8s beat -> flocks interleaved with an aimed fan -> climax of faster
// flocks plus red volleys.
const RUMIA_NIGHT_BIRD = [
  // Section 1 (0-28s): lone flocks every 1.2s.
  { t: 1.5, type: 'arc', count: 15, center: true, spread: 0.9, sideTurn: 0.02, speed: 2.4, angleJitter: 0.015,
    colorLeft: '#5588ff', colorRight: '#66dd88', colorCenter: '#ff4455',
    coreColor: '#ffd0dc', shape: 'circle', r: 4, interval: 1.2, repeat: 22 },
  // Section 2 (28-56s): paired flocks, 0.7s apart on a 2.8s beat.
  { t: 28, type: 'arc', count: 15, center: true, spread: 0.8, sideTurn: 0.022, speed: 2.6, angleJitter: 0.015,
    colorLeft: '#5588ff', colorRight: '#66dd88', colorCenter: '#ff4455',
    coreColor: '#ffd0dc', shape: 'circle', r: 4, interval: 2.8, repeat: 10 },
  { t: 28.7, type: 'arc', count: 15, center: true, spread: 0.8, sideTurn: 0.022, speed: 2.6, angleJitter: 0.015,
    colorLeft: '#5588ff', colorRight: '#66dd88', colorCenter: '#ff4455',
    coreColor: '#ffd0dc', shape: 'circle', r: 4, interval: 2.8, repeat: 10 },
  // Section 3 (56-84s): flocks + 9-way aimed fan on the off-beat.
  { t: 56, type: 'arc', count: 15, center: true, spread: 0.85, sideTurn: 0.024, speed: 2.8, angleJitter: 0.015,
    colorLeft: '#5588ff', colorRight: '#66dd88', colorCenter: '#ff4455',
    coreColor: '#ffd0dc', shape: 'circle', r: 4, interval: 2.8, repeat: 10 },
  { t: 57.4, type: 'fan', count: 9, spread: 0.7, speed: 2.2,
    color: '#ffaa44', coreColor: '#ffe8cc', shape: 'circle', r: 4, interval: 2.8, repeat: 10 },
  // Section 4 (84-105s): climax — faster flocks + red volleys.
  { t: 84, type: 'arc', count: 15, center: true, spread: 0.9, sideTurn: 0.026, speed: 3.0, angleJitter: 0.02,
    colorLeft: '#5588ff', colorRight: '#66dd88', colorCenter: '#ff4455',
    coreColor: '#ffd0dc', shape: 'circle', r: 4, interval: 1.4, repeat: 15 },
  { t: 84.5, type: 'volley', count: 8, speedMin: 1.5, speedMax: 4.0,
    color: '#ff5555', coreColor: '#ffd0d0', shape: 'circle', r: 4, interval: 2.8, repeat: 8 },
];

// Darkness Sign "Demarcation": a deep field of counter-rotating rice rings
// (the "darkness" lattice — Spell02 style, each ring offset from the last
// and gently decelerating), double rings of 16 that expand, freeze, then
// drift perpendicular, and dark aimed shots that escalate with the fight
// (single -> 5-way -> 8-way ring, Spell02 TDark tiers). One field-freeze at
// 65s: everything halts white, then releases outward.
const RUMIA_DEMARCATION_FREEZES = [
  { t: 65, hold: 1.2, release: { mode: 'outward', speed: 1.5 } },
];
const RUMIA_DEMARCATION = [
  // Background lattice: two counter-rotating 12-way rice rings.
  { t: 2, type: 'ring', count: 12, rotStep: 0.105, speed: 1.5, retention: 0.995, life: 300,
    color: '#66dd88', coreColor: '#e0ffe8', shape: 'rice', r: 4, interval: 0.7, repeat: -1 },
  { t: 2.35, type: 'ring', count: 12, rotStep: -0.126, speed: 1.2, retention: 0.995, life: 300,
    color: '#ffcc44', coreColor: '#fff2cc', shape: 'rice', r: 4, interval: 0.8, repeat: -1 },
  // Double rings: expand -> hold -> drift perpendicular (tangent).
  { t: 4, type: 'ring', count: 16, releaseTangent: true, flyDur: 1, holdDur: 0.4, releaseSpeed: 0.9, speed: 2.2,
    color: '#5588ff', colorAlt: '#66dd88', coreColor: '#d0e0ff', shape: 'rice', r: 4, life: 1800, interval: 9, repeat: 14 },
  { t: 4.3, type: 'ring', count: 16, releaseTangent: true, flyDur: 1.2, holdDur: 0.4, releaseSpeed: 0.9, speed: 2.2,
    color: '#5588ff', colorAlt: '#ff6688', coreColor: '#d0e0ff', shape: 'rice', r: 4, life: 1800, interval: 9, repeat: 14 },
  // Dark aimed shots, escalating tiers (deep purple).
  { t: 6, type: 'aimed', count: 1, speed: 1.8,
    color: '#8855cc', coreColor: '#e0d0ff', shape: 'circle', r: 5, interval: 7.5, repeat: 6 },
  { t: 45, type: 'fan', count: 5, spread: 2.09, speed: 2.0,
    color: '#8855cc', coreColor: '#e0d0ff', shape: 'circle', r: 5, interval: 7.5, repeat: 5 },
  { t: 85, type: 'ring', count: 8, speed: 2.2,
    color: '#8855cc', coreColor: '#e0d0ff', shape: 'circle', r: 5, interval: 6, repeat: 7 },
];

const BOSSES = {
  // ── Rumia — Pawn (value 1). Top-center, nocturnal danmaku. ──
  // Spell names from the VERIFIED video analysis in
  // refs/stages/spell_card_descriptions.md (only Rumia's section is
  // verified); pattern mechanics rebuilt from real Danmakufu spell scripts
  // (SCC Ver1.10a Rumia Spell01-04) for proper flow.
  //   Normal:  Night Sign "Night Bird", Darkness Sign "Demarcation"
  //   Lunatic: + Moon Sign "Moonlight Ray" (midboss spell, Hard/Lunatic only)
  rumia: {
    name: 'Rumia',
    color: '#9a8cff',
    bgTop: '#0b0b1e',
    bgBottom: '#04040a',
    move: 'still',
    phases: {
      normal: [
        {
          // Night Sign "Night Bird" (夜符「ナイトバード」, ~105s): flocks of
          // 16-bullet arcs banking outward like wings (blue left, green
          // right, one crimson dead-aimed in each flock), in four escalating
          // sections with breathing room between. Dark smoky-brown sky.
          name: 'Night Sign "Night Bird"',
          duration: 105,
          hp: 130,
          bgTop: '#1a120c',
          bgBottom: '#0a0604',
          emits: RUMIA_NIGHT_BIRD,
        },
        {
          // Darkness Sign "Demarcation" (闇符「ディマーケイション」, ~130s):
          // counter-rotating rice lattice + double tangent-drift rings +
          // escalating dark aimed shots + one field-freeze. Deep
          // purple-black sky.
          name: 'Darkness Sign "Demarcation"',
          duration: 130,
          hp: 140,
          bgTop: '#120a1e',
          bgBottom: '#05030a',
          freezes: RUMIA_DEMARCATION_FREEZES,
          emits: RUMIA_DEMARCATION,
        },
      ],
      lunatic: [
        {
          // Moon Sign "Moonlight Ray" (月符「ムーンライトレイ」, ~90s,
          // midboss spell, Hard/Lunatic only): a massive white-gold vertical
          // beam from above, flanked by neat falling columns of pale-green
          // dots. Steady volleys of 8 red bullets aimed straight at the
          // player (same time, same direction, different speeds), punctuated
          // by a ring of 16 red 3-fans of rice (cluster speeds vary) with a
          // circle of 16 blue circles riding along at the slowest fan's
          // speed, then a 16-bullet green near-volley arc. Deep navy night
          // sky.
          name: 'Moon Sign "Moonlight Ray"',
          duration: 90,
          hp: 150,
          bgTop: '#0a0f2e',
          bgBottom: '#03040c',
          beams: [
            // Delayed activation: the beam sits over the player's spawn lane,
            // so it must NOT drop at t=0 — 3s to get out of the center.
            { t: 3, xn: 0.5, width: 56, color: '#fff3b0', coreColor: '#ffffff' },
          ],
          emits: [
            // Neat falling columns of small green dots either side of the beam.
            { t: 0, type: 'column', xn: [0.38, 0.43, 0.57, 0.62], speed: 2.2, color: '#88ffaa', coreColor: '#e0ffe8', shape: 'circle', r: 3, interval: 0.25, repeat: -1 },
            // 8-bullet red volleys aimed straight at the player; each bullet a
            // different speed so the volley peels apart into a stretching line.
            { t: 0.5, type: 'volley', count: 8, speedMin: 1.5, speedMax: 4.5, color: '#ff5555', coreColor: '#ffd0d0', shape: 'circle', r: 4, interval: 1.5, repeat: -1 },
            // Ring of 16 red 3-fans of rice; cluster speeds vary 1.5..3.0.
            { t: 13, type: 'ringFan', count: 16, per: 3, cSpread: 0.3, speeds: [1.5, 2.0, 2.5, 3.0], color: '#ff5555', coreColor: '#ffd0d0', shape: 'rice', r: 4, interval: 15.5, repeat: 6 },
            // Circle of 16 blue circles riding along with the slowest fan.
            { t: 13, type: 'ring', count: 16, speed: 1.5, color: '#5588ff', coreColor: '#d0e0ff', shape: 'circle', r: 4, interval: 15.5, repeat: 6 },
            // 16-bullet green arc: almost a volley, slight rotation between
            // bullets.
            { t: 14.5, type: 'fan', count: 16, spread: 0.18, speed: 2.6, color: '#66dd88', coreColor: '#e0ffe8', shape: 'circle', r: 4, interval: 15.5, repeat: 6 },
          ],
        },
        {
          // Night Sign "Night Bird" (Lunatic): same card as Normal; Lunatic
          // scaling (speed/density multipliers) makes it denser and faster.
          name: 'Night Sign "Night Bird"',
          duration: 105,
          hp: 140,
          bgTop: '#1a120c',
          bgBottom: '#0a0604',
          emits: [
            // 16 bullets per arc: 7 blue (bank left), 7 green (bank right),
            // and one crimson bullet dead-aimed at the player.
            { t: 0, type: 'arc', count: 15, center: true, spread: 0.9, sideTurn: 0.02, speed: 2.6,
              colorLeft: '#5588ff', colorRight: '#66dd88', colorCenter: '#ff4455',
              coreColor: '#ffd0dc', shape: 'circle', r: 4, interval: 1.1, repeat: -1 },
          ],
        },
        {
          // Darkness Sign "Demarcation" (Lunatic): same card as Normal,
          // scaled up.
          name: 'Darkness Sign "Demarcation"',
          duration: 130,
          hp: 150,
          bgTop: '#120a1e',
          bgBottom: '#05030a',
          emits: [
            { t: 0, type: 'ring', count: 16, releaseTangent: true, flyDur: 1, holdDur: 0.3, releaseSpeed: 0.8, speed: 2.2, color: '#5588ff', colorAlt: '#66dd88', coreColor: '#d0e0ff', shape: 'rice', r: 4, life: 1800, interval: 26, repeat: 5 },
            { t: 0.25, type: 'ring', count: 16, releaseTangent: true, flyDur: 1.2, holdDur: 0.3, releaseSpeed: 0.8, speed: 2.2, color: '#5588ff', colorAlt: '#ff6688', coreColor: '#d0e0ff', shape: 'rice', r: 4, life: 1800, interval: 26, repeat: 5 },
            { t: 4.5, type: 'ring', count: 16, releaseTangent: true, flyDur: 1, holdDur: 0.3, releaseSpeed: 0.8, speed: 2.2, color: '#5588ff', colorAlt: '#66dd88', coreColor: '#d0e0ff', shape: 'rice', r: 4, life: 1800, interval: 26, repeat: 5 },
            { t: 4.75, type: 'ring', count: 16, releaseTangent: true, flyDur: 1.2, holdDur: 0.3, releaseSpeed: 0.8, speed: 2.2, color: '#5588ff', colorAlt: '#ff6688', coreColor: '#d0e0ff', shape: 'rice', r: 4, life: 1800, interval: 26, repeat: 5 },
            { t: 9, type: 'ring', count: 16, releaseTangent: true, flyDur: 1, holdDur: 0.3, releaseSpeed: 0.8, speed: 2.2, color: '#5588ff', colorAlt: '#66dd88', coreColor: '#d0e0ff', shape: 'rice', r: 4, life: 1800, interval: 26, repeat: 5 },
            { t: 9.25, type: 'ring', count: 16, releaseTangent: true, flyDur: 1.2, holdDur: 0.3, releaseSpeed: 0.8, speed: 2.2, color: '#5588ff', colorAlt: '#ff6688', coreColor: '#d0e0ff', shape: 'rice', r: 4, life: 1800, interval: 26, repeat: 5 },
            { t: 14, type: 'fan', count: 15, spread: 0.8, speed: 2.4, color: '#5588ff', coreColor: '#d0e0ff', shape: 'circle', r: 4, script: [{ dur: 90, mode: 'fly' }, { dur: 30, mode: 'hold' }, { dur: 999999, mode: 'aim', speed: 2.5 }], interval: 26, repeat: 5 },
            { t: 17.5, type: 'fan', count: 15, spread: 0.8, speed: 2.4, color: '#5588ff', coreColor: '#d0e0ff', shape: 'circle', r: 4, script: [{ dur: 90, mode: 'fly' }, { dur: 30, mode: 'hold' }, { dur: 999999, mode: 'aim', speed: 2.5 }], interval: 26, repeat: 5 },
            { t: 21, type: 'fan', count: 15, spread: 0.8, speed: 2.4, color: '#5588ff', coreColor: '#d0e0ff', shape: 'circle', r: 4, script: [{ dur: 90, mode: 'fly' }, { dur: 30, mode: 'hold' }, { dur: 999999, mode: 'aim', speed: 2.5 }], interval: 26, repeat: 5 },
            { t: 24.5, type: 'fan', count: 15, spread: 0.8, speed: 2.4, color: '#5588ff', coreColor: '#d0e0ff', shape: 'circle', r: 4, script: [{ dur: 90, mode: 'fly' }, { dur: 30, mode: 'hold' }, { dur: 999999, mode: 'aim', speed: 2.5 }], interval: 26, repeat: 5 },
          ],
        },
      ],
    },
  },

  // ── Nitori — Knight (value 3). Water / gadget themes. ──
  // Card list follows EoSD Stage 3 (refs/stages/Nitori.html). Every card is
  // built around a distinct water "gadget" — movement, transformation and
  // interaction rather than static aimed/ring barrages:
  //   Normal  — River Drift (non-spell): shootable bubbles drift down and
  //             pop into droplets. Optical Camouflage: streams that
  //             materialize in mid-air (invisible until close), banked
  //             flocks that scatter like currents, and a droplet curtain
  //             with a shifting gap. Ooze Flooding: rotating dense rings,
  //             stretching volleys, curtains sweeping in from the sides,
  //             and ooze blobs that shed aimed droplets. Monster Cucumber:
  //             big rolling cucumbers drift across the field shedding rings
  //             of seeds — shoot them down for a seed burst.
  //   Lunatic — Hydro Camouflage: the camouflage toolkit, denser, with
  //             fading spirals. Kappa's Pororoca: tidal bore — waves surge
  //             from opposite edges, each with a single shifting gap to
  //             thread. Spin the Cephalic Plate: counter-rotating spirals,
  //             a rotating web of fans, and a sweeping searchlight beam.
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
          // River Drift (non-spell): a calm current. Slow bubbles drift down
          // the screen and pop into little rings of droplets; steady 3-way
          // streams and soft rings keep the field readable. Bubbles are
          // shootable — popping them early is worth the score.
          name: 'River Drift',
          duration: 16,
          hp: 100,
          emits: [
            { t: 0, type: 'aimed', count: 3, spread: 0.3, speed: 2.5, color: '#88ddff', coreColor: '#e0f5ff', shape: 'circle', interval: 0.5 },
            { t: 0.4, type: 'ring', count: 12, speed: 1.7, color: '#55ccff', coreColor: '#d0f0ff', shape: 'circle', interval: 1.4 },
            // Bubbles: big, slow, shootable. They shed a droplet ring as they
            // drift and dissolve into one when they reach the bottom or are
            // shot down.
            { t: 0.6, type: 'edge', side: 'top', spacing: 160, speed: 0.8, r: 7,
              color: '#99e6ff', coreColor: '#eaffff', shape: 'circle',
              life: 800, fadeOut: 40, destructible: true, hp: 2,
              spawnEvery: 200,
              spawnEmits: [{ type: 'ring', count: 6, speed: 1.1, color: '#bfefff', coreColor: '#ffffff', shape: 'circle', r: 3, life: 110 }],
              deathBurst: { type: 'ring', count: 8, speed: 1.5, color: '#bfefff', coreColor: '#ffffff', shape: 'circle', r: 3, life: 100 },
              repeat: 1 },
          ],
        },
        {
          // Optical Camouflage (Th10SC028): she hides in plain sight. Streams
          // of white droplets materialize in mid-air (invisible until close)
          // and dissolve before they reach you; banked flocks scatter outward
          // like water currents; a curtain of droplets falls in waves with a
          // single shifting gap; foam bursts emerge from nowhere.
          name: 'Optical Camouflage',
          duration: 17,
          hp: 120,
          emits: [
            // Invisible streams: fade in 0.6s after leaving her, fade out as
            // they arrive — you can't tell where they came from.
            { t: 0, type: 'aimed', count: 5, spread: 0.5, speed: 2.4,
              color: '#e8fbff', coreColor: '#ffffff', shape: 'circle', r: 3,
              fadeIn: 35, fadeOut: 30, life: 260, interval: 0.6 },
            // Banked flocks: wings curve outward and open like a current
            // scattering around an obstacle.
            { t: 0.5, type: 'arc', count: 9, spread: 1.0, sideTurn: 0.015, speed: 2.2,
              colorLeft: '#7fe8d8', colorRight: '#66b8ff', colorCenter: '#ffffff',
              shape: 'petal', rotSpeed: 0.08, center: true, interval: 1.1 },
            // Droplet waves: a curtain falls from the top with a gap that
            // shifts along the wave every time — thread the hole.
            { t: 1.0, type: 'wall', side: 'top', cxn: 0.5, spacing: 18, speed: 1.6, r: 4,
              color: '#9fe8ff', coreColor: '#e8fbff', shape: 'circle',
              gapSize: 90, gapPos: 0.5, gapPosStep: 0.13, interval: 1.8 },
            // Foam bursts: small rings emerging at random points in the upper
            // field (seeded — deterministic per fight).
            { t: 1.6, type: 'splash', inner: 'ring', count: 10, speed: 1.8,
              color: '#d8f6ff', coreColor: '#ffffff', shape: 'circle', r: 3,
              fadeIn: 20, fadeOut: 40, life: 160,
              xn0: 0.15, xn1: 0.85, yn0: 0.2, yn1: 0.55, interval: 1.6 },
          ],
        },
        {
          // Ooze Flooding (Th10SC032): the river overflows. Dense blue rings
          // rotate slowly as they expand; volleys stretch into peeling lines;
          // curtains of ooze sweep in from the left and right edges (always
          // visible coming in); big ooze blobs drift down shedding aimed
          // droplets, and pop into a ring when shot down.
          name: 'Ooze Flooding',
          duration: 17,
          hp: 120,
          emits: [
            { t: 0, type: 'ring', count: 18, rotStep: 0.05, speed: 1.8,
              color: '#88ddff', coreColor: '#e0f5ff', shape: 'circle', r: 6, interval: 0.7 },
            { t: 0.4, type: 'volley', count: 7, speedMin: 1.2, speedMax: 2.8,
              color: '#cdefff', coreColor: '#ffffff', shape: 'circle', r: 3, interval: 1.4 },
            // Curtains sweep in from the edges — you always see them coming.
            { t: 0.8, type: 'wall', side: 'left', cyn: 0.5, spacing: 26, speed: 1.4, r: 5,
              color: '#66ccee', coreColor: '#d8f4ff', shape: 'circle', interval: 4.5 },
            { t: 3.05, type: 'wall', side: 'right', cyn: 0.5, spacing: 26, speed: 1.4, r: 5,
              color: '#66ccee', coreColor: '#d8f4ff', shape: 'circle', interval: 4.5 },
            // Ooze blobs: big, slow, shootable; shed a 3-way aimed spray as
            // they drift down; pop into a ring when destroyed.
            { t: 0.3, type: 'edge', side: 'top', spacing: 150, speed: 1.0, r: 9,
              color: '#5fc8e8', coreColor: '#c8efff', shape: 'circle',
              life: 640, fadeOut: 30, trail: true, destructible: true, hp: 3,
              spawnEvery: 90,
              spawnEmits: [{ type: 'aimed', count: 3, spread: 0.35, speed: 1.6, color: '#9fe8ff', coreColor: '#ffffff', shape: 'circle', r: 3, life: 220 }],
              deathBurst: { type: 'ring', count: 10, speed: 1.8, color: '#9fe8ff', coreColor: '#ffffff', shape: 'circle', r: 3, life: 110 },
              repeat: 1 },
          ],
        },
        {
          // Monster Cucumber (Th10SC036): oversized cucumbers roll across the
          // field, trailing wakes and shedding rings of seeds that carry
          // their drift. Shoot a cucumber to pop it into a seed burst.
          name: 'Monster Cucumber',
          duration: 18,
          hp: 130,
          emits: [
            { t: 0, type: 'ring', count: 16, speed: 1.5,
              color: '#88ddff', coreColor: '#e0f5ff', shape: 'circle', r: 4, interval: 1.0 },
            { t: 0.3, type: 'aimed', count: 3, spread: 0.35, speed: 2.2,
              color: '#bfefff', coreColor: '#ffffff', shape: 'circle', r: 3, interval: 0.8 },
            // Cucumbers drifting in from the left edge (centered mid-field so
            // all three enter on-screen).
            { t: 0.5, type: 'edge', side: 'left', cyn: 0.45, spacing: 200, speed: 1.1, r: 14,
              color: '#77dd88', coreColor: '#e0ffe8', shape: 'rice', rotSpeed: 0.04,
              life: 600, trail: true, destructible: true, hp: 4,
              spawnEvery: 70, spawnCount: 6, inheritVel: true,
              spawnEmits: [{ type: 'ring', count: 5, speed: 1.4, color: '#a8f0b0', coreColor: '#eaffe8', shape: 'circle', r: 3, life: 130 }],
              deathBurst: { type: 'ring', count: 12, speed: 2.2, color: '#a8f0b0', coreColor: '#ffffff', shape: 'circle', r: 3, life: 100 },
              repeat: 1 },
            // ...and from the right, a couple of seconds later.
            { t: 2.5, type: 'edge', side: 'right', cyn: 0.45, spacing: 200, speed: 1.1, r: 14,
              color: '#77dd88', coreColor: '#e0ffe8', shape: 'rice', rotSpeed: -0.04,
              life: 600, trail: true, destructible: true, hp: 4,
              spawnEvery: 70, spawnCount: 6, inheritVel: true,
              spawnEmits: [{ type: 'ring', count: 5, speed: 1.4, color: '#a8f0b0', coreColor: '#eaffe8', shape: 'circle', r: 3, life: 130 }],
              deathBurst: { type: 'ring', count: 12, speed: 2.2, color: '#a8f0b0', coreColor: '#ffffff', shape: 'circle', r: 3, life: 100 },
              repeat: 1 },
          ],
        },
      ],
      lunatic: [
        {
          name: 'River Drift',
          duration: 16,
          hp: 110,
          emits: [
            { t: 0, type: 'aimed', count: 5, spread: 0.35, speed: 2.6, color: '#88ddff', coreColor: '#e0f5ff', shape: 'circle', interval: 0.45 },
            { t: 0.4, type: 'ring', count: 14, speed: 1.8, color: '#55ccff', coreColor: '#d0f0ff', shape: 'circle', interval: 1.2 },
            { t: 0.6, type: 'edge', side: 'top', spacing: 120, speed: 0.9, r: 7,
              color: '#99e6ff', coreColor: '#eaffff', shape: 'circle',
              life: 700, fadeOut: 40, destructible: true, hp: 2,
              spawnEvery: 160,
              spawnEmits: [{ type: 'ring', count: 8, speed: 1.2, color: '#bfefff', coreColor: '#ffffff', shape: 'circle', r: 3, life: 110 }],
              deathBurst: { type: 'ring', count: 10, speed: 1.6, color: '#bfefff', coreColor: '#ffffff', shape: 'circle', r: 3, life: 100 },
              repeat: 1 },
          ],
        },
        {
          // Hydro Camouflage (Th10SC030): the full camouflage toolkit. A
          // fading 4-arm spiral wraps the field; invisible aimed streams
          // materialize and dissolve; banked flocks scatter wider; the
          // droplet curtain's gap is narrower and shifts faster; foam bursts
          // are more frequent.
          name: 'Hydro Camouflage',
          duration: 17,
          hp: 130,
          emits: [
            { t: 0, type: 'spiral', arms: 4, rotSpeed: 0.6, speed: 2.3,
              color: '#e8f6ff', coreColor: '#ffffff', shape: 'circle', r: 3,
              fadeIn: 30, fadeOut: 40, interval: 0.12 },
            { t: 0.3, type: 'aimed', count: 7, spread: 0.6, speed: 2.6,
              color: '#e8fbff', coreColor: '#ffffff', shape: 'circle', r: 3,
              fadeIn: 30, fadeOut: 30, life: 250, interval: 0.5 },
            { t: 0.6, type: 'arc', count: 11, spread: 1.2, sideTurn: 0.02, speed: 2.4,
              colorLeft: '#7fe8d8', colorRight: '#66b8ff', colorCenter: '#ffffff',
              shape: 'petal', rotSpeed: 0.08, center: true, interval: 1.0 },
            { t: 1.0, type: 'wall', side: 'top', cxn: 0.5, spacing: 16, speed: 1.8, r: 4,
              color: '#9fe8ff', coreColor: '#e8fbff', shape: 'circle',
              gapSize: 70, gapPos: 0.5, gapPosStep: 0.11, interval: 1.6 },
            { t: 1.4, type: 'splash', inner: 'ring', count: 12, speed: 2.0,
              color: '#d8f6ff', coreColor: '#ffffff', shape: 'circle', r: 3,
              fadeIn: 20, fadeOut: 40, life: 150,
              xn0: 0.1, xn1: 0.9, yn0: 0.15, yn1: 0.6, interval: 1.2 },
          ],
        },
        {
          // Kappa's Pororoca (Th10SC038): a tidal bore. Waves surge up from
          // the bottom edge and down from the top, each a full curtain with a
          // single shifting gap — thread the bore as it rolls past. Stretching
          // volleys and rotating rings fill the space between.
          name: "Kappa's Pororoca",
          duration: 18,
          hp: 140,
          emits: [
            // The bore: waves rising from below, gap shifting each wave.
            { t: 0, type: 'wall', side: 'bottom', cxn: 0.5, spacing: 16, speed: 2.0, r: 5,
              color: '#66d8f0', coreColor: '#d8f8ff', shape: 'circle',
              gapSize: 80, gapPos: 0.5, gapPosStep: 0.16, interval: 1.6 },
            // Counter-surge from above, offset, gap drifting the other way.
            { t: 0.8, type: 'wall', side: 'top', cxn: 0.5, spacing: 18, speed: 1.7, r: 4,
              color: '#8ce8ff', coreColor: '#eafcff', shape: 'circle',
              gapSize: 90, gapPos: 0.3, gapPosStep: -0.13, interval: 2.0 },
            { t: 0.4, type: 'volley', count: 9, speedMin: 1.4, speedMax: 3.0,
              color: '#cdefff', coreColor: '#ffffff', shape: 'circle', r: 3, interval: 1.0 },
            { t: 0.2, type: 'ring', count: 20, rotStep: 0.08, speed: 1.7,
              color: '#88ddff', coreColor: '#e0f5ff', shape: 'circle', r: 5, interval: 0.6 },
          ],
        },
        {
          // Spin the Cephalic Plate (Th10SC042): her head-plate spins. Two
          // counter-rotating spirals trace the plate's edge, a web of fans
          // rotates through the middle, a pale band rings the outside — and
          // a searchlight beam sweeps the field.
          name: 'Spin the Cephalic Plate',
          duration: 18,
          hp: 150,
          beams: [
            { t: 2, dur: 14, width: 26, angle: -Math.PI / 2, sweep: 0.35,
              color: '#66ffcc', coreColor: '#e0fff5' },
          ],
          emits: [
            { t: 0, type: 'spiral', arms: 2, rotSpeed: 0.5, speed: 2.0,
              color: '#aaffcc', coreColor: '#e8ffe8', shape: 'circle', r: 4, interval: 0.14 },
            { t: 0, type: 'spiral', arms: 2, rotSpeed: -0.5, speed: 2.0,
              color: '#ffffff', coreColor: '#ffffff', shape: 'circle', r: 4, interval: 0.14 },
            // Rotating web: 8 triple-fans on a ring, the whole web turning.
            { t: 0.3, type: 'ringFan', count: 8, per: 3, cSpread: 0.3, rotStep: 0.05, speed: 1.9,
              color: '#ccffe8', coreColor: '#f0fff5', shape: 'circle', r: 3, interval: 0.4 },
            // Pale outer band.
            { t: 0.6, type: 'ring', count: 24, speed: 1.5,
              color: '#88ffe0', coreColor: '#eafff8', shape: 'circle', r: 7, interval: 0.6 },
          ],
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
            { t: 0, type: 'homing', count: 4, speed: 2.8, color: '#9966ff', coreColor: '#e0d0ff', shape: 'petal', turn: 0.04, interval: 0.7 },
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
            { t: 0.6, type: 'homing', count: 3, speed: 2.6, color: '#44dddd', coreColor: '#d0ffff', shape: 'rice', turn: 0.035, interval: 0.8 },
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
            { t: 0.6, type: 'homing', count: 4, speed: 2.7, color: '#44dddd', coreColor: '#d0ffff', shape: 'rice', turn: 0.04, interval: 0.65 },
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
            { t: 0, type: 'aimed', count: 3, spread: 0.2, speed: 3.2, color: '#ffdd88', coreColor: '#fff8e0', shape: 'rice', interval: 0.4 },
            { t: 0.3, type: 'ring', count: 14, speed: 1.8, color: '#ffcc66', coreColor: '#fff0d0', shape: 'circle', interval: 1.3 },
            { t: 0.6, type: 'aimed', count: 5, spread: 0.8, speed: 2.5, color: '#ffaa44', coreColor: '#ffe8c0', shape: 'star', interval: 0.7 },
          ],
        },
        {
          name: "Jewel from the Dragon's Neck",
          duration: 18,
          hp: 150,
          emits: [
            { t: 0, type: 'laser', count: 1, speed: 3.5, color: '#ffdd88', coreColor: '#fff8e0', shape: 'diamond', interval: 0.5, laserLen: 10 },
            { t: 0.3, type: 'ring', count: 16, speed: 2.4, color: '#ffcc66', coreColor: '#fff0d0', shape: 'circle', interval: 0.9 },
          ],
        },
        {
          name: "Buddha's Stone Bowl",
          duration: 18,
          hp: 160,
          emits: [
            { t: 0, type: 'laser', count: 1, speed: 3.2, color: '#ffaa44', coreColor: '#ffe8c0', shape: 'diamond', interval: 0.45, laserLen: 8 },
            { t: 0.2, type: 'aimed', count: 6, spread: 0.6, speed: 3, color: '#ffdd88', coreColor: '#fff8e0', shape: 'star', interval: 0.4 },
          ],
        },
        {
          name: "Swallow's Cowrie Shell",
          duration: 18,
          hp: 170,
          emits: [
            { t: 0, type: 'ring', count: 20, speed: 2.6, color: '#ffdd88', coreColor: '#fff8e0', shape: 'star', rotSpeed: 0.2, interval: 0.8 },
            { t: 0.3, type: 'ring', count: 20, speed: 2.6, color: '#ffaa44', coreColor: '#ffe8c0', shape: 'star', rotSpeed: -0.2, interval: 0.8, rot: Math.PI / 20 },
          ],
        },
        {
          name: 'Brilliant Dragon Bullet',
          duration: 18,
          hp: 180,
          emits: [
            { t: 0, type: 'laser', count: 1, speed: 3.5, color: '#ffdd88', coreColor: '#fff8e0', shape: 'diamond', interval: 0.4, laserLen: 12 },
            { t: 0.25, type: 'ring', count: 18, speed: 2.5, color: '#ff6688', coreColor: '#ffd0d8', shape: 'circle', interval: 0.7 },
            { t: 0.5, type: 'ring', count: 18, speed: 2.5, color: '#66ccff', coreColor: '#d0e8ff', shape: 'circle', interval: 0.7, rot: Math.PI / 18 },
          ],
        },
      ],
      lunatic: [
        {
          name: 'Non-spell',
          duration: 17,
          hp: 140,
          emits: [
            { t: 0, type: 'aimed', count: 4, spread: 0.22, speed: 3.3, color: '#ffdd88', coreColor: '#fff8e0', shape: 'rice', interval: 0.35 },
            { t: 0.3, type: 'ring', count: 18, speed: 1.9, color: '#ffcc66', coreColor: '#fff0d0', shape: 'circle', interval: 1.1 },
            { t: 0.6, type: 'aimed', count: 6, spread: 0.85, speed: 2.6, color: '#ffaa44', coreColor: '#ffe8c0', shape: 'star', interval: 0.6 },
          ],
        },
        {
          name: "Jewel from the Dragon's Neck",
          duration: 18,
          hp: 160,
          emits: [
            { t: 0, type: 'laser', count: 1, speed: 3.6, color: '#ffdd88', coreColor: '#fff8e0', shape: 'diamond', interval: 0.4, laserLen: 12 },
            { t: 0.3, type: 'ring', count: 20, speed: 2.5, color: '#ffcc66', coreColor: '#fff0d0', shape: 'circle', interval: 0.75 },
          ],
        },
        {
          name: "Buddha's Stone Bowl",
          duration: 18,
          hp: 170,
          emits: [
            { t: 0, type: 'laser', count: 1, speed: 3.3, color: '#ffaa44', coreColor: '#ffe8c0', shape: 'diamond', interval: 0.35, laserLen: 10 },
            { t: 0.2, type: 'aimed', count: 7, spread: 0.65, speed: 3.1, color: '#ffdd88', coreColor: '#fff8e0', shape: 'star', interval: 0.35 },
          ],
        },
        {
          name: "Swallow's Cowrie Shell",
          duration: 18,
          hp: 180,
          emits: [
            { t: 0, type: 'ring', count: 24, speed: 2.7, color: '#ffdd88', coreColor: '#fff8e0', shape: 'star', rotSpeed: 0.22, interval: 0.65 },
            { t: 0.3, type: 'ring', count: 24, speed: 2.7, color: '#ffaa44', coreColor: '#ffe8c0', shape: 'star', rotSpeed: -0.22, interval: 0.65, rot: Math.PI / 24 },
          ],
        },
        {
          name: 'Brilliant Dragon Bullet',
          duration: 18,
          hp: 190,
          emits: [
            { t: 0, type: 'laser', count: 1, speed: 3.6, color: '#ffdd88', coreColor: '#fff8e0', shape: 'diamond', interval: 0.35, laserLen: 14 },
            { t: 0.25, type: 'ring', count: 22, speed: 2.6, color: '#ff6688', coreColor: '#ffd0d8', shape: 'circle', interval: 0.55 },
            { t: 0.5, type: 'ring', count: 22, speed: 2.6, color: '#66ccff', coreColor: '#d0e8ff', shape: 'circle', interval: 0.55, rot: Math.PI / 22 },
          ],
        },
        {
          name: 'End of Imperishable Night',
          duration: 20,
          hp: 200,
          noBombs: true,
          emits: [
            { t: 0, type: 'ring', count: 24, speed: 2.8, color: '#ffdd88', coreColor: '#fff8e0', shape: 'circle', interval: 0.6 },
            { t: 0.3, type: 'spiral', arms: 4, rotSpeed: 0.3, speed: 2.6, color: '#ffcc66', coreColor: '#fff0d0', shape: 'rice', interval: 0.1 },
            { t: 0.6, type: 'aimed', count: 6, spread: 0.5, speed: 3.2, color: '#ffaa44', coreColor: '#ffe8c0', shape: 'star', interval: 0.4 },
            { t: 0.9, type: 'laser', count: 1, speed: 3.5, color: '#ffdd88', coreColor: '#fff8e0', shape: 'diamond', interval: 0.45, laserLen: 12 },
          ],
        },
      ],
    },
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { BOSSES, getPhases, scalePhase };
}
