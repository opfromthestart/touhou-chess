# agent.md — Touhou Chess

Guide for coding agents working in this repository. Read this first, then
`PLAN.md` (design source of truth) and `docs/danmaku-engine.md` (pattern
authoring rules) before touching code.

## What this project is

A chess variant where you command the protagonists (white) and an AI commands
the youkai bosses (black). **Every capture is contested by a short danmaku
(bullet-hell) boss fight** against the AI piece's boss character: win the
fight and the AI piece is removed; lose all lives and *your* piece is removed.
There is **no check, no checkmate, no stalemate, and no draws** — the game
ends only when a king is captured (via its boss fight).

- Player-initiated capture → **Normal** fight (3 phases).
- AI-initiated capture → **Lunatic** fight (4 phases, scaled-up parameters).
- King capture works the same way: win Kaguya's fight and the game ends.

## Stack & hard constraints

- **Plain HTML5 + Canvas + vanilla JS. No build step, no package manager, no
  dependencies** (except `vendor/peerjs.min.js`, vendored for multiplayer).
  The game runs by opening `index.html` directly or via any static server.
- Scripts load via `<script>` tags in a fixed order (see `index.html`).
  Each module ends with a CommonJS `module.exports` guard so the same files
  load in Node for headless testing. **Preserve those guards.**
- **Determinism is sacred in the danmaku layer.** Never call `Math.random`
  (or `Date.now`, etc.) in `js/danmaku/engine.js` or pattern data. All engine
  randomness goes through the seeded PRNG (`mulberry32`, re-seeded per fight
  from a hash of the fight identity) and emitter jitter fields. Fights must be
  reproducible for replays, the AI's survival model, and multiplayer
  spectators. The chess/AI layer may use `Math.random`.
- **Stage geometry:** portrait canvas **480 × 640 px**, fixed timestep
  **60 fps** (one `update()` = one frame = 1/60 s). In pattern data: times in
  **seconds**, speeds in **pixels per frame**, angles in **radians**. Player
  starts at (240, 580); boss defaults to (240, 90).
- Author patterns at **Normal** values; Lunatic scaling is applied
  automatically by `getPhases()` in `js/danmaku/bosses.js`.

## File map (actual)

```
index.html              — the game (board UI, menus, practice mode, MP screens)
css/style.css           — all styling
js/config.js            — CONFIG: piece values, roster, characters, danmaku
                          stats, shot patterns, difficulty multipliers,
                          survival priors, AI depth
js/main.js              — bootstrap + top-level state machine
                          (player-turn -> ai-turn -> boss-fight -> game-over),
                          undo, AI strength
js/multiplayer.js       — peerjs two-player mode (Flower View style: each side
                          fights the other's boss, both panels shown side-by-side)
js/chess/board.js       — board state + move generation (king-capture rules,
                          castling, en passant, promotion)
js/chess/ai.js          — minimax + alpha-beta + capture-risk model
js/danmaku/engine.js    — ~1900-line engine: loop, player, bullets, collision,
                          bombs, beams, rendering, emitter interpreter
js/danmaku/bosses.js    — ALL 9 boss fight scripts as data (BOSSES map) +
                          getPhases() difficulty scaling. Most pattern work lands here.
js/art/characters.js    — 18 chibi canvas sprites (piece icons + ships + bosses)
js/audio/sfx.js         — synthesized WebAudio SFX (no audio assets)
js/ui/board-ui.js       — board render, click-to-move, highlights
js/ui/fight-ui.js       — fight modal, HUD (lives/bombs/score/phase/banner)
js/ui/practice-ui.js    — practice mode: fight any boss as any piece
js/net/peer.js          — thin peerjs wrapper
js/debug/log.js         — replayable game-log recording
js/debug/replay.js      — offline replay of recorded logs
vendor/peerjs.min.js    — vendored dependency (do not regenerate)
refs/stages/            — saved wiki pages + spell_card_descriptions.md (source
                          of truth for real spell names/order per boss)
```

Note: `PLAN.md` §7 shows an idealized layout (e.g. separate `rules.js`,
`screens.js`) that never materialized — trust the tree above.

## Tests (all run from the repo root with plain `node`)

Node-based (no browser needed):

- `node test-board.js` — chess core sanity (move gen, castling, en passant…).
- `node test-ai.js` — AI makes valid moves, games progress.
- `node test-balance.js` — headless danmaku balance probe (stationary
  immortal player; reports per-card duration/end reason).
- `node test-bosses.js` — validates all 9 boss scripts.
- `node test-replay.js` — debug log + offline replay round-trip.
- `node tmp-engine-test2.js` — **main regression suite**: engine features +
  determinism + all 9 bosses × 2 difficulties. Run this after engine/pattern
  changes.
- `node tmp-nitori-density.js` — full-duration density harness (max bullets
  on screen per phase); the pattern of what a density check looks like.

Headless Chromium (spawn their own static server + Chromium over CDP):

- `node mp_smoke.js` — multiplayer page loads clean (console/exception check).
- `node mp_desync_test.js`, `mp_p2p_test.js`, `mp_p2p_race_test.js`,
  `mp_race_resolution_test.js`, `mp_resolve_order_test.js` — multiplayer
  protocol/determinism checks.
- `node cdp_eval.js <url> <expression> [settleMs]` — generic CDP driver:
  serve workspace, evaluate an expression in the page, print JSON. Use it to
  poke at any page (e.g. `test-danmaku.html`, `mp_engine_test.html`).
- `node tmp-kaguya-playtest.js` — frame-stepped playtest of a fight with
  per-spell-card screenshots (the pattern for visual playtests).

Browser (open directly in a tab):

- `index.html` — the game itself; **Practice Mode is the fastest way to
  playtest a spell card by hand** (pick boss, piece, difficulty).
- `test-danmaku.html`, `test-practice.html` — browser test pages.

Before declaring pattern/engine work done: `node tmp-engine-test2.js`
(regression) + a density check + a manual/playtest pass in the browser.

## Game rules to preserve (don't "fix" these)

- Standard chess movement, but **no check/checkmate/stalemate**; kings may be
  adjacent; a king may capture anything. Win = capture the enemy king.
- **No draw conditions at all** (no 50-move rule, no threefold repetition, no
  insufficient material).
- Castling allowed under standard rights, with the custom **"castle en
  passant"** rule (see PLAN.md §2): if an enemy piece attacks the square the
  king passes through, it gains a one-turn special capture right on the
  destination square.
- En passant is standard and triggers a boss fight vs the pawn that
  double-stepped.
- Promotion: pick any of your own non-king piece types (AI defaults to queen).
- Capture outcome is symmetric: win the fight → AI's piece dies; lose → your
  piece dies (regardless of who initiated).
- Danmaku stats scale with piece value (lives/bombs/hitbox/focus per piece —
  see `CONFIG.DANMAKU_STATS`).
- Kaguya's Lunatic last spell ("End of Imperishable Night") disables bombs,
  faithful to the original.

## Roster (quick reference)

| Piece | You (protagonists) | AI (bosses you fight) |
|---|---|---|
| King | Reimu Hakurei | Kaguya Houraisan |
| Queen | Marisa Kirisame | Yukari Yakumo |
| Rook ×2 | Sakuya Izayoi, Youmu Konpaku | Remilia Scarlet, Yuyuko Saigyouji |
| Bishop ×2 | Sanae Kochiya, Reisen Udongein Inaba | Patchouli Knowledge, Alice Margatroid |
| Knight ×2 | Aya Shameimaru, Hatate Himekaidou | Nitori Kawashiro, Momiji Inubashiri |
| Pawn ×8 | Cirno (all 8) | Rumia (all 8) |

## Conventions & gotchas

- `CONFIG` is a free global in browser code; Node tests set
  `global.CONFIG = require('./js/config.js').CONFIG` before requiring modules
  that use it. Follow the existing pattern when adding Node-loadable modules.
- New spell cards/phases are **pure data** in `js/danmaku/bosses.js` — no new
  engine code unless a genuinely new bullet primitive is needed. The emitter
  field reference and balance rules live in `docs/danmaku-engine.md`; read it
  before authoring patterns.
- To port a **real** Touhou spell card from a game's ECL script, follow
  `docs/porting-eosd-spells.md` (EoSD/MoF disassembly pipeline) and use
  `refs/stages/spell_card_descriptions.md` as the card-name source of truth.
  `spellcard_workflow` (root) is the video-analysis procedure used to build
  that reference.
- Real game assets extracted from TH06/TH08/EoSD/MoF (`.anm`, `.mid`, `.std`,
  `.ecl`, `.wav`, …) sit loose in the repo root and are **gitignored** — they
  are reference material, not shipped assets. All shipped art is self-made
  canvas/SVG in `js/art/characters.js`. Do not commit extracted game files.
- `tmp-*.js` / `tmp-*.html` at the root are **scratch/playtest scripts**
  (some are load-bearing, e.g. `tmp-engine-test2.js` is the regression suite
  — check `docs/danmaku-engine.md` and git history before deleting any).
- `touhou-chess-log-*.json` are exported debug logs (gitignored);
  `runs/`, `share/`, `taisei/`, `bin/`, `lib/` are toolchain/scratch dirs
  (gitignored).
- Milestones M1–M10 are done (see git log: core, AI, engine, integration, all
  9 bosses, sprite library, focus, polish, practice mode, character-faithful
  player shots). Multiplayer (peerjs, Flower View style) is the current
  active work stream.
- The UI is deliberately themed (ZUN-style doujin look, neon-geometry bullets
  on dark backgrounds) — see the art notes at the end of `PLAN.md`. Don't
  regress it to a generic look.
