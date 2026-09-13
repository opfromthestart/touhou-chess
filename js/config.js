// config.js — values, roster, difficulty multipliers, survival priors, danmaku stats.
// No build step, no dependencies. Loaded as a plain <script>.

const CONFIG = {
  // Piece values (drive boss difficulty tier + AI evaluation).
  PIECE_VALUES: {
    p: 1,
    n: 3,
    b: 3,
    r: 5,
    q: 9,
    k: 100, // effectively infinite; king capture ends the game
  },

  // Roster: piece type -> { you (protagonists), ai (bosses) }.
  // The 9 AI boss characters are the ones you fight in danmaku.
  ROSTER: {
    k: { you: ['reimu'], ai: ['kaguya'] },
    q: { you: ['marisa'], ai: ['yukari'] },
    r: { you: ['sakuya', 'youmu'], ai: ['remilia', 'yuyuko'] },
    b: { you: ['sanae', 'reisen'], ai: ['patchouli', 'alice'] },
    n: { you: ['aya', 'hatate'], ai: ['nitori', 'momiji'] },
    p: { you: ['cirno'], ai: ['rumia'] },
  },

  // Display names per character id.
  CHARACTERS: {
    reimu: 'Reimu Hakurei',
    marisa: 'Marisa Kirisame',
    sakuya: 'Sakuya Izayoi',
    youmu: 'Youmu Konpaku',
    sanae: 'Sanae Kochiya',
    reisen: 'Reisen Udongein Inaba',
    aya: 'Aya Shameimaru',
    hatate: 'Hatate Himekaidou',
    cirno: 'Cirno',
    kaguya: 'Kaguya Houraisan',
    yukari: 'Yukari Yakumo',
    remilia: 'Remilia Scarlet',
    yuyuko: 'Yuyuko Saigyouji',
    patchouli: 'Patchouli Knowledge',
    alice: 'Alice Margatroid',
    nitori: 'Nitori Kawashiro',
    momiji: 'Momiji Inubashiri',
    rumia: 'Rumia',
  },

  // Danmaku player stats. Character strength scales with the piece's value:
  // a stronger piece means a stronger danmaku character (more lives, more bombs,
  // smaller hitbox). The danmaku character is the protagonist assigned to the
  // piece involved in the capture.
  DANMAKU_STATS: {
    k: { lives: 3, bombs: 3, hitbox: 6, focus: 1.5 },
    q: { lives: 3, bombs: 3, hitbox: 6, focus: 1.5 },
    r: { lives: 3, bombs: 2, hitbox: 7, focus: 2 },
    b: { lives: 2, bombs: 2, hitbox: 8, focus: 2 },
    n: { lives: 2, bombs: 2, hitbox: 8, focus: 2 },
    p: { lives: 1, bombs: 1, hitbox: 10, focus: 3 },
  },

  // Difficulty multipliers (Lunatic = AI initiated the capture).
  DIFFICULTY: {
    normal: { phaseCount: 3, speed: 1.0, density: 1.0, homing: 1.0 },
    lunatic: { phaseCount: 4, speed: 1.2, density: 1.35, homing: 1.3 },
  },

  // Player shot patterns, one per piece type. The protagonist assigned to the
  // piece involved in the capture fires with their signature pattern. Each
  // pattern auto-fires upward and damages the current spell card.
  //
  // Firepower scales with piece VALUE (the plan's "stronger piece = stronger
  // danmaku character"): king > queen > rook > bishop ~ knight > pawn. Rough
  // damage-per-second: k 50, q 30, r 24, b 17, n 15, p 6.7. A pawn must NOT
  // out-damage a king — Cirno gets a single weak ice shard.
  SHOT_PATTERNS: {
    k: { // Reimu — five-shot spread, the strongest firepower.
      interval: 6, count: 5, spread: 0.45, speed: 10, damage: 1, r: 3,
      color: '#ff5577', shape: 'circle',
    },
    q: { // Marisa — homing magic bullets (slow turn, high damage).
      interval: 12, count: 3, spread: 0.3, speed: 8, damage: 2, r: 4,
      color: '#ffaa33', shape: 'star', type: 'homing', turn: 0.05, rotSpeed: 0.15,
    },
    r: { // Sakuya / Youmu — fast, tight piercing stream.
      interval: 5, count: 2, spread: 0.08, speed: 12, damage: 1, r: 2.5,
      color: '#66ccff', shape: 'diamond',
    },
    b: { // Sanae / Reisen — straight lightning bolts. (The old curving bolts
      // drifted off the boss within a second and were basically unusable.)
      interval: 7, count: 2, spread: 0.1, speed: 11, damage: 1, r: 3,
      color: '#ff88cc', shape: 'cross',
    },
    n: { // Aya / Hatate — twin wing shots.
      interval: 8, count: 2, spread: 0.15, speed: 10, damage: 1, r: 3,
      color: '#cc99ff', shape: 'petal', rotSpeed: 0.1,
    },
    p: { // Cirno — one weak ice shard; a pawn shouldn't shred spell cards.
      interval: 9, count: 1, speed: 10, damage: 1, r: 3,
      color: '#66ddff', shape: 'diamond',
    },
  },

  // Boss hitbox radius (for player-shot collision).
  BOSS_HITBOX: 22,

  // Phase length in seconds (each phase ~15-25s).
  PHASE_SECONDS: 18,

  // Survival priors: P(you win the fight) per boss, per difficulty.
  // Adapted at runtime from actual fight results.
  SURVIVAL_PRIORS: {
    rumia: { normal: 0.90, lunatic: 0.36 },
    nitori: { normal: 0.80, lunatic: 0.32 },
    momiji: { normal: 0.80, lunatic: 0.32 },
    patchouli: { normal: 0.75, lunatic: 0.30 },
    alice: { normal: 0.75, lunatic: 0.30 },
    remilia: { normal: 0.60, lunatic: 0.24 },
    yuyuko: { normal: 0.60, lunatic: 0.24 },
    yukari: { normal: 0.45, lunatic: 0.18 },
    kaguya: { normal: 0.30, lunatic: 0.12 },
  },

  // AI search depth (default strength).
  AI_DEPTH: 3,

  // AI strengths selectable from the menu (plan §8): search depth per level.
  AI_STRENGTHS: {
    easy: { label: 'Easy', depth: 2 },
    normal: { label: 'Normal', depth: 3 },
    hard: { label: 'Hard', depth: 4 },
  },

  // Board size.
  BOARD_SIZE: 8,
};

// Export for Node (tests); in the browser CONFIG is a global.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CONFIG };
}
