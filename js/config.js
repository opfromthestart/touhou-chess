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
  // danmaku character"): king > queen > rook > bishop > knight > pawn, and the
  // RANGE stays within 2-3x (king vs pawn) so no piece can skip a card — even
  // Reimu must survive real danmaku before her shots end the fight.
  // Rough damage-per-second: k 12, q 10, r 9.2, b 8, n 7.1, p 5.
  SHOT_PATTERNS: {
    k: { // Reimu — five homing Dream-Seal orbs, the strongest firepower.
      // Her normal shot is "usually with homing properties" (wiki): the
      // ofuda/orbs chase the boss on their own.
      interval: 25, count: 5, spread: 0.5, speed: 9, damage: 1, r: 3,
      color: '#ff5577', shape: 'circle', type: 'homing', turn: 0.06,
    },
    q: { // Marisa — a continuous laser straight up from the ship (her
      // Illusion Laser / Stream Laser skills; Master Spark lineage). The
      // beam does most of the damage: while it overlaps the boss it deals
      // `damage` per frame (0.1 x 60 = 6 DPS). She also fires a 5-star fan
      // spread +-0.2 rad around straight-up every 60 frames: the stars'
      // lateral drift (0 / 48 / 99 px out to the boss) tiles the 0-125 px
      // off-axis range, so while she dodges away from under the beam the
      // angled stars are her second damage source (verified: ~1 DPS
      // off-axis where the laser can't reach; ~7 DPS combined on-axis,
      // below Reimu's 12 — queen < king).
      type: 'laser', damage: 0.1, width: 8,
      color: '#ffaa33', shape: 'laser',
      starInterval: 60, starCount: 5, starSpread: 0.4,
      starSpeed: 10, starDamage: 1, starR: 4,
      starColor: '#ffcc55', starRotSpeed: 0.15,
    },
    r: { // Sakuya / Youmu — fast, tight piercing stream.
      interval: 13, count: 2, spread: 0.08, speed: 12, damage: 1, r: 2.5,
      color: '#66ccff', shape: 'diamond',
    },
    b: { // Sanae / Reisen — straight lightning bolts. (The old curving bolts
      // drifted off the boss within a second and were basically unusable.)
      // Spread 0.08 keeps both bolts inside the boss hitbox over the full
      // field height (wider spreads drift past a centered boss and miss).
      interval: 15, count: 2, spread: 0.08, speed: 11, damage: 1, r: 3,
      color: '#ff88cc', shape: 'cross',
    },
    n: { // Aya / Hatate — twin wing shots. Spread 0.1: at 0.15 both wings
      // drifted ~37px off-axis over the field height and never touched a
      // centered boss, so Aya dealt effectively zero damage.
      interval: 17, count: 2, spread: 0.1, speed: 10, damage: 1, r: 3,
      color: '#cc99ff', shape: 'petal', rotSpeed: 0.1,
    },
    p: { // Cirno — one weak ice shard; a pawn shouldn't shred spell cards.
      interval: 12, count: 1, speed: 10, damage: 1, r: 3,
      color: '#66ddff', shape: 'diamond',
    },
  },

  // Boss hitbox radius (for player-shot collision).
  BOSS_HITBOX: 22,

  // Phase length in seconds (each phase ~15-25s).
  PHASE_SECONDS: 18,

  // Survival priors: P(you win the fight) per boss, per difficulty.
  // Adapted at runtime from actual fight results. Seeds were lowered after
  // the firepower nerfs: bullet exposure (and death risk) is far higher
  // than in the original build.
  SURVIVAL_PRIORS: {
    // Rumia's EoSD-faithful cards are compressed to the ~25s house window
    // (3 cards Normal / 4 Lunatic => ~75-100s of bullet exposure), but her
    // patterns are the densest in the game — seeded slightly below
    // Nitori/Momiji, who have similar total exposure with simpler patterns.
    rumia: { normal: 0.60, lunatic: 0.18 },
    nitori: { normal: 0.65, lunatic: 0.22 },
    momiji: { normal: 0.65, lunatic: 0.22 },
    patchouli: { normal: 0.60, lunatic: 0.20 },
    alice: { normal: 0.60, lunatic: 0.20 },
    remilia: { normal: 0.45, lunatic: 0.15 },
    yuyuko: { normal: 0.45, lunatic: 0.15 },
    yukari: { normal: 0.30, lunatic: 0.10 },
    kaguya: { normal: 0.18, lunatic: 0.07 },
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

  // Multiplayer: how often (ms) a player relays its danmaku input state to the
  // opponent so they can run a live spectator copy of your fight.
  MP_INPUT_INTERVAL_MS: 33,

  // Countdown (ms) shown INSIDE the danmaku fight window before the fight
  // actually starts. The window opens immediately when a capture lands and
  // shows a 3-2-1 countdown; the engines (and the game clock) start when the
  // countdown finishes. Without it the defender is blindsided — the bullets
  // are already on screen the instant their piece is captured. The delay is
  // applied symmetrically before the game clock starts, so it does not affect
  // race resolution or cross-client sync.
  DANMAKU_START_DELAY_MS: 3000,
};

// Export for Node (tests); in the browser CONFIG is a global.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CONFIG };
}
