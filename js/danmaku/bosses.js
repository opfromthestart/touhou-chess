// bosses.js — the 9 boss fight scripts, data-driven.
// Each boss has a set of phases (spell cards) for Normal and Lunatic.
// Lunatic = one extra phase + scaled-up parameters (speed, density, homing).
// M3 ships Rumia (the reference); the other 8 are added in M5.

const TAU_LOCAL = Math.PI * 2;

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

const BOSSES = {
  // Rumia — Pawn (value 1), easiest. Stationary, simple aimed danmaku.
  rumia: {
    name: 'Rumia',
    color: '#9a8cff',
    bgTop: '#0b0b1e',
    bgBottom: '#04040a',
    move: 'still',
    phases: {
      normal: [
        {
          name: 'Non-spell',
          duration: 16,
          emits: [
            { t: 0, type: 'aimed', count: 3, spread: 0.35, speed: 3, color: '#ff5555', interval: 0.55 },
            { t: 0.6, type: 'ring', count: 10, speed: 2, color: '#5577ff', interval: 1.3 },
          ],
        },
        {
          name: 'Night Bird',
          duration: 17,
          emits: [
            // Alternating arm swings: fans from below-left and below-right.
            { t: 0, type: 'fan', count: 7, spread: 1.3, speed: 2.6, color: '#ff8855', interval: 0.9, angle: Math.PI * 0.75 },
            { t: 0.45, type: 'fan', count: 7, spread: 1.3, speed: 2.6, color: '#ff8855', interval: 0.9, angle: Math.PI * 0.25 },
            // Half-circle "wing" bursts.
            { t: 0.3, type: 'ring', count: 14, speed: 2.1, color: '#ffaa55', interval: 1.1 },
          ],
        },
        {
          name: 'Demarcation',
          duration: 18,
          emits: [
            // Weaving circle spreads (spirals).
            { t: 0, type: 'spiral', arms: 2, rotSpeed: 0.35, speed: 2.6, color: '#55ffff', interval: 0.16 },
            // Aimed waves (more aimed as it runs).
            { t: 0.5, type: 'aimed', count: 5, spread: 0.5, speed: 3.1, color: '#ffffff', interval: 0.6 },
          ],
        },
      ],
      lunatic: [
        // Same three, plus the Lunatic-only Last Spell.
        {
          name: 'Non-spell',
          duration: 16,
          emits: [
            { t: 0, type: 'aimed', count: 3, spread: 0.35, speed: 3, color: '#ff5555', interval: 0.5 },
            { t: 0.6, type: 'ring', count: 12, speed: 2.1, color: '#5577ff', interval: 1.1 },
          ],
        },
        {
          name: 'Night Bird',
          duration: 17,
          emits: [
            { t: 0, type: 'fan', count: 8, spread: 1.4, speed: 2.7, color: '#ff8855', interval: 0.8, angle: Math.PI * 0.75 },
            { t: 0.4, type: 'fan', count: 8, spread: 1.4, speed: 2.7, color: '#ff8855', interval: 0.8, angle: Math.PI * 0.25 },
            { t: 0.3, type: 'ring', count: 16, speed: 2.2, color: '#ffaa55', interval: 0.95 },
          ],
        },
        {
          name: 'Demarcation',
          duration: 18,
          emits: [
            { t: 0, type: 'spiral', arms: 3, rotSpeed: 0.4, speed: 2.7, color: '#55ffff', interval: 0.14 },
            { t: 0.5, type: 'aimed', count: 6, spread: 0.55, speed: 3.2, color: '#ffffff', interval: 0.5 },
          ],
        },
        {
          name: 'Moonlight Ray',
          duration: 18,
          emits: [
            // V-formation continuous lasers.
            { t: 0, type: 'laser', count: 1, speed: 3, color: '#ff3333', interval: 0.45, laserLen: 8 },
            // Rings of small orbs.
            { t: 0.3, type: 'ring', count: 18, speed: 2.2, color: '#ffff55', interval: 0.8, r: 3 },
          ],
        },
      ],
    },
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { BOSSES, getPhases, scalePhase };
}
