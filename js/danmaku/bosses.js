// bosses.js — the 9 boss fight scripts, data-driven.
// Each boss has a set of phases (spell cards) for Normal and Lunatic.
// Lunatic = one extra phase + scaled-up parameters (speed, density, homing).
//
// Emit types: point, aimed, ring, spiral, fan, homing, curve, laser.
// Bullet shapes: circle, star, petal, cross, diamond, rice.
// Phase fields: name, duration (s), hp, noBombs (bool), emits[].
// Emit fields: t (start s), type, count, speed, spread, angle, arms,
//   rotSpeed, rot, turn, curve, laserLen, interval, repeat,
//   r, color, coreColor, shape, speedMul, densityMul.

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
  // ── Rumia — Pawn (value 1), easiest. Stationary, simple aimed danmaku. ──
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
          hp: 100,
          emits: [
            { t: 0, type: 'aimed', count: 3, spread: 0.35, speed: 3, color: '#ff5555', coreColor: '#ffd0d0', shape: 'circle', interval: 0.55 },
            { t: 0.6, type: 'ring', count: 10, speed: 2, color: '#5577ff', coreColor: '#d0e0ff', shape: 'diamond', rotSpeed: 0.12, interval: 1.3 },
          ],
        },
        {
          name: 'Night Bird',
          duration: 17,
          hp: 120,
          emits: [
            { t: 0, type: 'fan', count: 7, spread: 1.3, speed: 2.6, color: '#ff8855', coreColor: '#ffe0c0', shape: 'petal', rotSpeed: 0.2, interval: 0.9, angle: Math.PI * 0.75 },
            { t: 0.45, type: 'fan', count: 7, spread: 1.3, speed: 2.6, color: '#ff8855', coreColor: '#ffe0c0', shape: 'petal', rotSpeed: 0.2, interval: 0.9, angle: Math.PI * 0.25 },
            { t: 0.3, type: 'ring', count: 14, speed: 2.1, color: '#ffaa55', coreColor: '#fff0d0', shape: 'star', rotSpeed: 0.15, interval: 1.1 },
          ],
        },
        {
          name: 'Demarcation',
          duration: 18,
          hp: 130,
          emits: [
            { t: 0, type: 'spiral', arms: 2, rotSpeed: 0.35, speed: 2.6, color: '#55ffff', coreColor: '#e0ffff', shape: 'circle', interval: 0.16 },
            { t: 0.5, type: 'aimed', count: 5, spread: 0.5, speed: 3.1, color: '#ffffff', coreColor: '#ffffff', shape: 'cross', rotSpeed: 0.1, interval: 0.6 },
          ],
        },
      ],
      lunatic: [
        {
          name: 'Non-spell',
          duration: 16,
          hp: 110,
          emits: [
            { t: 0, type: 'aimed', count: 3, spread: 0.35, speed: 3, color: '#ff5555', coreColor: '#ffd0d0', shape: 'circle', interval: 0.5 },
            { t: 0.6, type: 'ring', count: 12, speed: 2.1, color: '#5577ff', coreColor: '#d0e0ff', shape: 'diamond', rotSpeed: 0.14, interval: 1.1 },
          ],
        },
        {
          name: 'Night Bird',
          duration: 17,
          hp: 130,
          emits: [
            { t: 0, type: 'fan', count: 8, spread: 1.4, speed: 2.7, color: '#ff8855', coreColor: '#ffe0c0', shape: 'petal', rotSpeed: 0.22, interval: 0.8, angle: Math.PI * 0.75 },
            { t: 0.4, type: 'fan', count: 8, spread: 1.4, speed: 2.7, color: '#ff8855', coreColor: '#ffe0c0', shape: 'petal', rotSpeed: 0.22, interval: 0.8, angle: Math.PI * 0.25 },
            { t: 0.3, type: 'ring', count: 16, speed: 2.2, color: '#ffaa55', coreColor: '#fff0d0', shape: 'star', rotSpeed: 0.16, interval: 0.95 },
          ],
        },
        {
          name: 'Demarcation',
          duration: 18,
          hp: 140,
          emits: [
            { t: 0, type: 'spiral', arms: 3, rotSpeed: 0.4, speed: 2.7, color: '#55ffff', coreColor: '#e0ffff', shape: 'circle', interval: 0.14 },
            { t: 0.5, type: 'aimed', count: 6, spread: 0.55, speed: 3.2, color: '#ffffff', coreColor: '#ffffff', shape: 'cross', rotSpeed: 0.12, interval: 0.5 },
          ],
        },
        {
          name: 'Moonlight Ray',
          duration: 18,
          hp: 150,
          emits: [
            { t: 0, type: 'laser', count: 1, speed: 3, color: '#ff3333', coreColor: '#ffb0b0', shape: 'diamond', rotSpeed: 0.2, interval: 0.45, laserLen: 8 },
            { t: 0.3, type: 'ring', count: 18, speed: 2.2, color: '#ffff55', coreColor: '#ffffd0', shape: 'star', rotSpeed: 0.18, interval: 0.8, r: 3 },
          ],
        },
      ],
    },
  },

  // ── Nitori — Knight (value 3). Water / gadget themes. ──
  nitori: {
    name: 'Nitori',
    color: '#55ccff',
    bgTop: '#061420',
    bgBottom: '#020810',
    move: 'sine',
    moveAmp: 55,
    moveSpeed: 0.9,
    phases: {
      normal: [
        {
          name: 'Non-spell',
          duration: 16,
          hp: 100,
          emits: [
            { t: 0, type: 'aimed', count: 3, spread: 0.3, speed: 2.5, color: '#88ddff', coreColor: '#e0f5ff', shape: 'circle', interval: 0.5 },
            { t: 0.4, type: 'aimed', count: 1, speed: 1.6, color: '#55ccff', coreColor: '#d0f0ff', shape: 'circle', interval: 0.85 },
          ],
        },
        {
          name: 'Ooze Flooding',
          duration: 17,
          hp: 120,
          emits: [
            { t: 0, type: 'ring', count: 16, speed: 1.8, color: '#88ff88', coreColor: '#e0ffe0', shape: 'circle', interval: 1.2 },
            { t: 0.3, type: 'aimed', count: 3, spread: 0.3, speed: 2.5, color: '#88ddff', coreColor: '#e0f5ff', shape: 'circle', interval: 0.5 },
          ],
        },
        {
          name: 'Diluvial Mere',
          duration: 18,
          hp: 130,
          emits: [
            { t: 0, type: 'curve', count: 4, speed: 2.2, color: '#55aaff', coreColor: '#d0eaff', shape: 'circle', curve: 0.04, interval: 0.7 },
            { t: 0.4, type: 'ring', count: 14, speed: 1.8, color: '#88ddff', coreColor: '#e0f5ff', shape: 'circle', interval: 1.3 },
          ],
        },
      ],
      lunatic: [
        {
          name: 'Non-spell',
          duration: 16,
          hp: 110,
          emits: [
            { t: 0, type: 'aimed', count: 4, spread: 0.35, speed: 2.6, color: '#88ddff', coreColor: '#e0f5ff', shape: 'circle', interval: 0.45 },
            { t: 0.4, type: 'aimed', count: 2, speed: 1.7, color: '#55ccff', coreColor: '#d0f0ff', shape: 'circle', interval: 0.7 },
          ],
        },
        {
          name: 'Ooze Flooding',
          duration: 17,
          hp: 130,
          emits: [
            { t: 0, type: 'ring', count: 20, speed: 1.9, color: '#88ff88', coreColor: '#e0ffe0', shape: 'circle', interval: 1.05 },
            { t: 0.3, type: 'aimed', count: 4, spread: 0.35, speed: 2.6, color: '#88ddff', coreColor: '#e0f5ff', shape: 'circle', interval: 0.45 },
          ],
        },
        {
          name: 'Diluvial Mere',
          duration: 18,
          hp: 140,
          emits: [
            { t: 0, type: 'curve', count: 6, speed: 2.3, color: '#55aaff', coreColor: '#d0eaff', shape: 'circle', curve: 0.045, interval: 0.6 },
            { t: 0.4, type: 'ring', count: 18, speed: 1.9, color: '#88ddff', coreColor: '#e0f5ff', shape: 'circle', interval: 1.1 },
          ],
        },
        {
          name: 'Optical Camouflage',
          duration: 18,
          hp: 150,
          emits: [
            { t: 0, type: 'curve', count: 8, speed: 2.4, color: '#aaffee', coreColor: '#e0fff8', shape: 'petal', curve: 0.05, interval: 0.55 },
            { t: 0.3, type: 'ring', count: 22, speed: 2.1, color: '#88ddff', coreColor: '#e0f5ff', shape: 'circle', interval: 0.9 },
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
