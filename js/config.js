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

  // AI search depth.
  AI_DEPTH: 3,

  // Board size.
  BOARD_SIZE: 8,
};

// Export for Node (tests); in the browser CONFIG is a global.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CONFIG };
}
