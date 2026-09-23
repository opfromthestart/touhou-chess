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
    n: { you: ['aya', 'hatate'], ai: ['nitori', 'hina'] },
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
    hina: 'Hina Kagiyama',
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

  // Deathbomb window: number of frames the player has to cancel a hit they
  // just took by pressing the bomb key. In Touhou games this is typically 6-8
  // frames (0.1-0.13s at 60fps). During this window the hit is held (no life
  // lost yet) and the player can still move and bomb; if they bomb, the hit
  // is negated and the bomb's invincibility frames are granted. If the window
  // expires, the hit goes through normally.
  DEATHBOMB_FRAMES: 8,

  // Phase length in seconds (each phase ~15-25s).
  PHASE_SECONDS: 18,

  // Survival priors: P(you win the fight) per boss, per difficulty.
  // Adapted at runtime from actual fight results (see ai.js adaptSurvival,
  // which blends these seeds 50/50 with observed outcomes).
  //
  // These seeds are MEASURED, not hand-tuned: they are the per-boss win rates
  // from the headless fairness simulator (tests/tmp-danmaku-sim.js), 10 trials
  // x 6 piece types per boss, after the per-boss `tune` calibration (bosses.js).
  // The sim bot is a strong dodger, so treat these as an upper bound on a
  // casual human's win rate; runtime adaptation corrects for the gap.
  // Re-measure and update here whenever a card's difficulty changes meaningfully
  // (docs/danmaku-engine.md rule 8). Difficulty ladder (Normal): Kaguya/Yukari
  // hardest -> Rumia/Hina/Nitori easiest; Alice is the gentlest (easiest).
  SURVIVAL_PRIORS: {
    rumia:     { normal: 0.78, lunatic: 0.08 },
    nitori:    { normal: 0.78, lunatic: 0.13 },
    hina:      { normal: 0.82, lunatic: 0.10 },
    patchouli: { normal: 0.77, lunatic: 0.15 },
    alice:     { normal: 1.00, lunatic: 0.22 },
    remilia:   { normal: 0.63, lunatic: 0.22 },
    yuyuko:    { normal: 0.78, lunatic: 0.15 },
    yukari:    { normal: 0.68, lunatic: 0.18 },
    kaguya:    { normal: 0.62, lunatic: 0.15 },
  },

  // AI king-danger penalties (see ai.js kingDangerScore). This game has no
  // check rule, so the search gets no "check" signal; king danger is modeled
  // directly. A "doomed" king (attacked, no safe escape, no answer) is a
  // near-win, so it is worth a lot — but NOT so much that the AI becomes a
  // pure king-hunter that ignores development. (The old hardcoded value was
  // 100000, which made the AI a relentless king-rusher.)
  //
  // Tuned with tests/tmp-selfplay.js (AI vs AI self-play, `--ai-white`):
  //   - doomed=400, dev=0.4  -> ~50% AI wins, avg ~60-70 plies (balanced,
  //     enough captures for a healthy number of danmaku fights).
  //   - doomed=100000, dev=0 -> AI wins ~70%, avg ~100 plies (too aggressive,
  //     games drag).
  // The AI is still challenging vs a casual human (it wins most games) but
  // beatable by a strong player (self-play is ~50/50). Use AI_STRENGTHS to
  // adjust the search depth for easier/harder play.
  AI_KING_PENALTIES: {
    attacked: 3,   // king attacked but answerable (safe escape or can take attacker)
    doomed: 400,   // king attacked with no escape and no answer
  },

  // AI development incentive (see ai.js positionalBonus). Rewards pieces that
  // have moved off the back rank, so the AI develops before launching a king
  // attack. Keeps games balanced and the AI's play more reasonable.
  AI_DEV_BONUS: 0.4,

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
