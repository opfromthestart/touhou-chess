# Danmaku Engine — Pattern Authoring Guide

Documentation for contributors who want to **replace existing bullet patterns (spell cards),
add new ones, or extend the engine**. The goal: you should be able to write a new spell card
as pure data, test it headlessly in Node, and playtest it in the browser — without reading
the whole engine.

**TL;DR**

- Patterns are **pure data** in `js/danmaku/bosses.js`. The engine (`js/danmaku/engine.js`)
  interprets them. A spell card = one *phase* = a list of timed *emitters*.
- **Never use `Math.random`** (or `Date.now`, etc.) in engine or pattern code. Every fight is
  seeded so replays, the AI's survival model, and multiplayer spectator copies stay
  reproducible. All randomness goes through the emitter jitter fields (see §3).
- Write at **Normal** values: Lunatic gets speed/density multipliers applied automatically
  (§5.3).
- Before opening a PR: `node tmp-engine-test2.js` (regression) + a density check
  (§7) + playtest in the browser.

---

## 1. Layout

| File | Role |
| --- | --- |
| `js/danmaku/engine.js` | The engine: loop, player, bullets, collision, bombs, beams, rendering, the emitter interpreter. ~1800 lines. |
| `js/danmaku/bosses.js` | **All 9 boss fight scripts as data** (`BOSSES` map) + `getPhases()` which applies difficulty scaling. This is where most PRs land. |
| `js/config.js` | `DANMAKU_STATS` (lives/bombs/hitbox per piece), `SHOT_PATTERNS` (player auto-fire per piece), `DIFFICULTY` multipliers, `SURVIVAL_PRIORS` (AI win-probability estimates), roster. |
| `js/ui/fight-ui.js` | Wires the engine into the game UI (`engine.start(...)` call, HUD, result). |
| `tmp-engine-test2.js` | Headless Node regression suite: engine features + determinism + all 9 bosses × 2 difficulties. Run with `node tmp-engine-test2.js`. |
| `tmp-nitori-density.js` | Headless full-duration density harness (max bullets on screen per phase). |
| `test-danmaku.html` | Browser tests for engine behavior (open directly in a tab). |
| `test-practice.html` | Browser tests for Practice Mode. |
| `index.html` | The game itself — Practice Mode is the fastest way to playtest a card by hand. |

There is **no build step**: plain ES2019-ish scripts loaded via `<script>` tags (CommonJS
`module.exports` guards make them loadable in Node too).

**Stage geometry & units.** The stage is a portrait canvas, **480 × 640 px**, fixed timestep
**60 fps** (one `update()` = exactly one frame = 1/60 s). In pattern data:

- times (`t`, `interval`, `duration`, `period`, …) are in **seconds**,
- speeds (`speed`, `cspeed`, …) are in **pixels per frame**,
- angles are in **radians**.

The player ship starts bottom-center (240, 580); the boss defaults to top-center (240, 90).

---

## 2. How a fight runs (mental model)

`DanmakuEngine.start(phases, boss, playerStats, playerPieceType, playerChar)` begins a fight:

1. **Phases are spell cards.** Each has a `duration` (seconds) and an HP gauge (`hp`). A card
   ends when its time elapses **or** its gauge is broken by player shots. On transition the
   whole bullet field is cleared, then the next card starts. Surviving the last card = win.
2. **The player auto-fires** their piece's signature pattern straight up
   (`CONFIG.SHOT_PATTERNS[pieceType]`: Reimu homing orbs, Marisa's continuous laser, …).
   Shots damage the current card's gauge and can destroy *destructible* bullets.
3. **Bombs** (Space / X) clear all bullets and bombable beams, grant 2 s of invulnerability.
   Extra bombs (beyond the first) require a full bomb gauge, which graze fills (+0.02 per
   graze). A phase may set `noBombs: true` (Kaguya's last spell).
4. **Hits** cost one life, grant 1.5 s invulnerability, and clear bullets within 60 px of the
   ship (a small mercy). Losing all lives = lose.
5. **Graze** (a bullet passing through the 10 px band just outside its collision envelope with
   the ship) scores points and fills the bomb gauge (+0.02 per graze).
6. **Bullets despawn when they leave the screen or the card ends** — not on a timer (Touhou
   convention). Do not use `life` to kill bullets mid-screen; it exists for special cases only
   (§4.2): laser segments, homing/stationary bullets that never reach the screen edge, and
   `fadeOut` camouflage.

Player stats (lives, bombs, hitbox size) come from `CONFIG.DANMAKU_STATS[pieceType]` — a pawn
fight gives 1 life / 1 bomb / a big 10 px hitbox; a king gives 3/3/6. Your pattern must be
dodgeable by a *pawn* player, because that is the weakest possible protagonist.

---

## 3. Determinism (read this first)

All randomness inside a fight flows through a seeded PRNG (`mulberry32`), re-seeded at the
start of every fight from a stable hash of the fight identity:

```
seed = FNV1a(`${boss.charId}|${playerPieceType}|${playerChar}`)
```

So the **same fight, fought again, produces the exact same bullet field**. This is what makes
replays work, lets the chess AI learn survival probabilities from fights, and keeps the
multiplayer "spectate both screens" feature fair. Consequences for your PR:

- **No `Math.random`, no `Date.now`, no unseeded loops.** If you need randomness in a pattern
  (e.g. "foam bursts at random points"), use the emitter jitter fields below — every draw
  comes from the fight's seeded stream.
- The seed does **not** include the difficulty: Normal and Lunatic use the *same* RNG stream;
  they differ only through the `speedMul`/`densityMul` scaling in `getPhases()`.
- You can verify determinism yourself: run two identical fights headlessly and compare bullet
  snapshots (see §7).

**Seeded jitter fields** (any emitter may set these; Taisei `rng_dir`/`rng_range` equivalents):

| Field | Meaning |
| --- | --- |
| `speedJitter` | ± fraction of speed per bullet (0.5 ⇒ 0.5×…1.5×) |
| `angleJitter` | ± radians per bullet |
| `colorJitter` | ± hue degrees around the base color (hex base only) |

---

## 4. Writing a spell card

### 4.1 The phase object

A spell card is a plain object inside `boss.phases.normal` / `boss.phases.lunatic`:

```js
{
  name: 'Darkness Sign "Demarcation"', // shown in the spell banner; "Non-spell" for openers
  duration: 25,                         // seconds the card lasts (house rule: 15–25s even for
                                        // faithful recreations — patterns loop on their own cycles)
  hp: 160,                              // HP gauge; breaking it ends the card early
  bgTop: '#120a1e', bgBottom: '#05030a', // optional per-card sky gradient (overrides boss colors)
  noBombs: false,                       // optional: disable bombs for this card
  emits: [ ... ],                       // REQUIRED: the pattern (see 4.2)
  beams: [ ... ],                       // optional: persistent laser columns (see 4.4)
  freezes: [ ... ],                     // optional: Perfect-Freeze moments (see 4.5)
}
```

### 4.2 Emitters — common fields

An **emitter** fires one or more bullets from the boss position at scheduled times. Every
emitter supports these fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `t` | s | Phase time at which the emitter first fires. |
| `type` | string | One of the emitter types in §4.3. |
| `count` | int | Bullets per fire (rounded after `densityMul`). |
| `interval` | s | Seconds between fires. Default `0.2`. |
| `repeat` | int | Number of fires. Omitted or `-1` = forever. With `period`, becomes a repeating block. |
| `period` | s | After `repeat` fires, re-arm at the next multiple of `period` — a repeating EoSD-style spell body. Per-fire evolution (`angleStep`/`speedStep`/`colors`/`rotStep`) resets each cycle. |
| `speed` | px/f | Base bullet speed. |
| `speedStep` | px/f | Speed added **per fire** (fire index, 0-based) — accelerating streams (Night Bird). |
| `spread` | rad | Total angular width across an `aimed`/`fan` group. |
| `angle` | rad | Absolute base angle; overrides aiming at the player. |
| `angleOffset` | rad | Static offset from the aim line (swinging streams start here). |
| `angleStep` | rad | Rotation added **per fire** — rotating beams / swinging aim. |
| `colors` | string[] | Color cycled **per fire** (all bullets of one fire share it) — Demarcation's white→blue→green→red cycle. |
| `color` / `coreColor` | hex | Bullet rim color / bright core color. Touhou convention: saturated rim + pale core. |
| `colorAlt` | hex | `ring` only: odd-index bullets get this color. |
| `r` | px | Bullet radius (default 4). |
| `shape` | enum | `circle` (default), `star`, `petal`, `cross`, `diamond`, `rice`. |
| `rotSpeed` | rad/f | Bullet self-rotation. |
| `speedMul` / `densityMul` | float | Multipliers on speed/count; **also multiplied by the difficulty scaling** (§5.3). |
| `aimRing` | bool | `ring` only: rotate the ring so exactly one bullet flies dead at the player (EoSD `aim_mode 2`). |
| `rot` / `rotStep` | rad | `ring` only: static rotation offset / rotation added per fire (spiral rings). |
| `life` | frames | Bullet lifetime. **Default: persists until the bullet leaves the screen or the card ends** (Touhou convention). Set it explicitly only for: laser segments (beam tail length + density budget), homing / retention / stationary bullets (they never reach the screen edge and would accumulate to the bullet cap), and `fadeOut` camouflage (the fade ramps over the remaining life). |
| `speedJitter` / `angleJitter` / `colorJitter` | float | Seeded per-bullet randomness (§3). |

**Aiming note:** unless `angle` is set, every emitter aims along the line from its origin to
the player's position *at fire time* (it is not homing). `aimed`/`fan` with `count > 1` spread
around that aim line.

**Per-bullet physics passthrough.** Any emitter may also set these fields, which are copied
onto every bullet it creates (Taisei `MoveParams` + hazard/visual vocabulary):

| Field | Meaning |
| --- | --- |
| `accelX` / `accelY` | Constant acceleration (px/frame²). |
| `retention` | `vel *= retention` each frame (<1 damp, >1 grow). |
| `attraction` / `attractPoint` / `attractExp` | Spring pull toward a point: `'player'` \| `'boss'` \| `{x,y}` \| `[x,y]`; `attractExp` is the distance exponent. |
| `speedOscAmp` / `speedOscFreq` / `speedOscBase` | Oscillating speed factor: `speed × (base + amp·sin(freq·t))` (Walachia-style modulated movers). |
| `maxDist` | Remove the bullet once this far from its *spawn* point. |
| `fadeIn` / `fadeOut` | Frames to ramp opacity in / out ("invisible until close" camouflage bullets). |
| `rainbow` | bool — cycle hue over the bullet's life. |
| `gravity` | Downward acceleration (icicle fall). |
| `turn` | Constant banking turn (rad/frame) for non-homing bullets. |
| `freeze` | Frames the bullet sits still at spawn before moving. |
| `releaseAngle` / `releaseSpeed` | On release, adopt this direction/speed instead of keeping velocity (rings that "turn perpendicular"). |
| `trail` | bool — comet-tail motion trail. |
| `destructible` / `hp` / `maxHp` | Player shots can damage/remove it (default hp 3 when destructible). |
| `spawnEvery` / `spawnEmits` | Every N frames, fire `spawnEmits` (an emitter or array) from the bullet's position — large hazards that shed children. |
| `spawnCount` | Cap on shed bursts (0 = unlimited). |
| `inheritVel` | Children inherit the parent's velocity (moving shooters). |
| `deathBurst` | Emitter fired when the bullet is destroyed. |
| `script` | Motion script shared by all bullets of this emitter (§4.6). |

### 4.3 Emitter types

| `type` | What it does | Key extra fields |
| --- | --- | --- |
| `point` | One bullet along the base angle. | — |
| `aimed` | `count` bullets fanned around the aim line. **Use ODD counts** (even counts leave the aim line open — see §6). | `spread` |
| `ring` | Full ring of `count` bullets. | `rot`, `rotStep`, `aimRing`, `colorAlt`, `releaseTangent` + `flyDur`/`holdDur`/`releaseSpeed`/`tangentDir` (Demarcation-style: fly out, hold, then drift tangent, alternating per bullet) |
| `ringRing` | Flower of flowers: `count` mini-rings (`per` bullets each) placed on a circle of radius `radius` — the classic expanding-flower. Mini-rings inherit speed/physics from the emitter, so `retention`/`accel` shapes the bloom. | `radius`, `per`, `rot`, `rotStep` |
| `spiral` | `arms` bullets per fire, base angle rotating at `rotSpeed` (rad/s) with phase time — a continuous spiral. | `arms`, `rotSpeed` |
| `fan` | Like `aimed`, but designed for staged trajectories; supports a shared `script`. **Prefer ODD counts.** | `spread`, `script` |
| `homing` | `count` bullets that steer toward the player at `turn` rad/frame. | `turn` (default 0.05) |
| `curve` | Expanding spiral: each bullet's bearing rotates by `curve` rad/frame while its radius from the spawn point grows at `speed`. | `curve` (default 0.05) |
| `laser` | A beam built from bullets laid along the aim line (`laserLen` px long, `spacing` px apart, default 8), refired every `interval` so segments overlap into a continuous beam. With `sweep`, the beam rotates in place around the fire origin while alive (searchlight). With `count > 1`, each firing lays `count` beams evenly around the origin (a 360° laser ring); combined with `sweep`, every refired copy lands exactly on the previous one, so the ring spins smoothly at `sweep` rad/s (no `angleStep` needed) — keep `life` at ~1–2 intervals (plus the warn extension) so copies overlap and the beam never flickers. `count` is not density-scaled — gap geometry stays dodgeable on every rank. Laser bullets carry `minLife = life` by default: off-screen culling never removes them while alive, because a rotating ring's bullets can start off-screen and orbit back into view (override with `minLife`). | `laserLen`, `spacing`, `life` (default 120), `minLife` (default = `life`), `sweep` (rad/s), `warn` (default 1.5), `count` (beams per ring) |
| `volley` | `count` bullets fired simultaneously, same direction (aimed), **different speeds** so they peel apart into a stretching line. | `speeds` (list, cycled) or `speedMin`/`speedMax` |
| `ringFan` | `count` clusters arranged in a ring; each cluster is a small `per`-way fan pointing outward. "16 3-fans" ⇒ `count: 16, per: 3`. Per-cluster speeds can vary. | `per`, `cSpread`, `rot`, `rotStep`, `speeds` |
| `arc` | A fan whose wings **bank outward** (scatter like birds), colored per side. Even counts leave the aim line open; set `center` to add one dead-aimed bullet. | `spread`, `sideTurn`, `colorLeft`/`colorRight`/`colorCenter`, `center` |
| `wall` | A curtain of bullets laid along a line, entering from one edge and sweeping across (tidal waves, rolling curtains). Optional gap the player threads. | `side` (`top`/`bottom`/`left`/`right`), `len`, `spacing`, `cxn`/`cyn` (normalized center), `gapSize`, `gapPos` (0..1), `gapPosStep` (shifts the gap per fire) |
| `edge` | Bullets growing inward from a screen edge (ooze, crystals, creep). | `side`, `spacing` |
| `column` | Steady falling column(s) from the top edge at fixed x positions. | `xs` (px) and/or `xn` (normalized 0..1) |
| `gap` | A burst from an arbitrary point on screen (Yukari's gaps). | `x`/`y` or `xn`/`yn`, `inner` (burst type, default `ring`) |
| `splash` | A burst from a **random (seeded)** position within a region, every fire — water drips, foam, "emergence from nowhere". | `xn0/xn1/yn0/yn1` (or px `x0/x1/y0/y1`), `inner` |
| `spawnBullet` | Large hazard bullets that shed children (`spawnEvery`/`spawnEmits`) and/or can be shot down. | `hp`, `spawnEvery`, `spawnEmits`, `spawnCount`, `inheritVel`, `deathBurst` |
| `doll` | Destructible shooter entity (Alice's dolls): a big bullet that flies, fires its own pattern (`shoot`) repeatedly, and can be shot down to stop it. | `shoot` (an emitter, fired every `interval` s, default 0.4), `hp` (default 5) |

Unknown types fall back to `point` — a typo will not crash, it will just look wrong, so read
your output carefully when testing.

**Worked example** (from Nitori's *Optical Camouflage* — invisible streams + banked flocks +
a gapped droplet wall + random foam bursts):

```js
emits: [
  // Invisible streams: fade in 0.6s after leaving her, fade out as they arrive.
  { t: 0, type: 'aimed', count: 5, spread: 0.5, speed: 2.4,
    color: '#e8fbff', coreColor: '#ffffff', shape: 'circle', r: 3,
    fadeIn: 35, fadeOut: 30, life: 260, interval: 0.6 },
  // Banked flocks: wings curve outward and open like a current.
  { t: 0.5, type: 'arc', count: 9, spread: 1.0, sideTurn: 0.015, speed: 2.2,
    colorLeft: '#7fe8d8', colorRight: '#66b8ff', colorCenter: '#ffffff',
    shape: 'petal', rotSpeed: 0.08, center: true, interval: 1.1 },
  // Droplet waves: a curtain falls from the top with a gap that shifts each wave.
  { t: 1.0, type: 'wall', side: 'top', cxn: 0.5, spacing: 18, speed: 1.6, r: 4,
    color: '#9fe8ff', coreColor: '#e8fbff', shape: 'circle',
    gapSize: 90, gapPos: 0.5, gapPosStep: 0.13, interval: 1.8 },
  // Foam bursts: small rings emerging at seeded-random points in the upper field.
  { t: 1.6, type: 'splash', inner: 'ring', count: 10, speed: 1.8,
    color: '#d8f6ff', coreColor: '#ffffff', shape: 'circle', r: 3,
    fadeIn: 20, fadeOut: 40, life: 160,
    xn0: 0.15, xn1: 0.85, yn0: 0.2, yn1: 0.55, interval: 1.6 },
],
```

### 4.4 Beams (persistent lasers)

Phase-level laser columns — thick, always-on (within their time window), damaging on contact,
grazeable, and bombable (unless `unclearable`). This is how Moonlight Ray's closing moonbeams
and the Cephalic Plate's searchlight work.

```js
beams: [
  { t: 2, dur: 14, width: 26, angle: -Math.PI / 2, sweep: 0.35,
    color: '#66ffcc', coreColor: '#e0fff5' },
],
```

| Field | Meaning |
| --- | --- |
| `t` | When the beam appears (s). Default 0. |
| `dur` | How long it stays (s). Omitted = until the card ends. |
| `period` | With `dur`: repeating window — active during `[t + k·period, t + k·period + dur]` (sweep 2 s, rest 1 s, repeat). |
| `x` / `xn` | Centerline x position (px / normalized 0..1). Default screen center. |
| `y0` / `y1` | Centerline extent (px). Default full screen height. |
| `width` | Collision width in px (default 40). The drawn glow is wider than the hitbox. |
| `angle` | Rotation around the beam's midpoint (rad). |
| `sweep` | Constant rotation rate (rad/s) starting at `t` — a searchlight. Collision and drawing always agree. |
| `color` / `coreColor` | Body / bright-core colors. |
| `unclearable` | bool — survives bombs (Taisei `l->unclearable`). |

### 4.5 Field freezes (Perfect-Freeze style)

At a scheduled time, halt **every** bullet (recolor white); when the hold elapses, release
them with fresh velocities.

```js
freezes: [ { t: 8, hold: 1.2, release: { mode: 'aim', speed: 2 } } ],
```

`release.mode`: `'random'` (default, seeded) | `'aim'` (at the player) | `'outward'`
(from the boss). `release.speed` defaults to 2.

### 4.6 Motion scripts (staged trajectories)

A bullet can walk through an ordered list of motion segments — e.g. *fan out → stop → aim at
the player*:

```js
script: [
  { dur: 60,  mode: 'fly' },    // keep current velocity for 60 frames
  { dur: 30,  mode: 'hold' },   // freeze in place
  { dur: 999999, mode: 'aim', speed: 2.5 }, // then fly straight at the player
],
```

Modes: `fly` (keep velocity), `hold` (zero velocity), `aim` (capture the player's position
**once** at entry, then fly straight — not homing), `homing` (`turn`), `spin` (bank at
`turn`), `gravity` (`gravity`), `tangent` (drift perpendicular to the radius from the spawn
point; `dir: ±1`, `speed`). When the script is exhausted the bullet holds position.

### 4.7 General physics mode (Taisei integrator)

Setting **any** of `accelX`/`accelY`/`retention`(!=1)/`attraction`/`speedOscAmp` switches the
bullet to the Taisei `move.c` integrator:

```
pos += vel · osc
vel  = accel + retention · vel
vel += attraction · (point − pos)          [attractExp == 1]
vel += attraction · (point − pos)·|d|^(exp−1)   [attractExp != 1]
```

This one model subsumes `move_linear`, `move_accelerated`, `move_asymptotic(_simple/_halflife)`,
`move_towards(_exp)`, `move_dampen`, `move_stop` — so any Taisei spell translates directly.
Handy fact: with constant `accel` and `retention < 1`, terminal velocity is
`accel / (1 − retention)`.

---

## 5. Modifying bosses

### 5.1 Replacing an existing pattern

Edit the `emits` array of the target phase in `js/danmaku/bosses.js`. Keep or adjust
`name`/`duration`/`hp` as needed. Shared emitter arrays (like `RUMIA_NIGHT_BIRD`) are copied
per difficulty by `scalePhase`, so sharing them between Normal/Lunatic is safe.

### 5.2 Adding a new spell card

Add a phase object to **both** `phases.normal` and `phases.lunatic` (Lunatic conventionally
has one extra card — usually a stronger finale, sometimes with `noBombs: true`). Follow the
existing comment style: each card gets a header comment explaining the concept, and each
emitter gets a one-line comment saying what it does.

### 5.3 Difficulty scaling — author at Normal

`getPhases(bossId, difficulty)` wraps every emitter:

```js
speedMul:   (em.speedMul   || 1) * CONFIG.DIFFICULTY[diff].speed    // normal 1.0, lunatic 1.2
densityMul: (em.densityMul || 1) * CONFIG.DIFFICULTY[diff].density  // normal 1.0, lunatic 1.35
```

So **write your pattern at Normal values**; Lunatic automatically gets ~20% faster and ~35%
denser. If you want a Lunatic-only card, just don't put it in `phases.normal`.

### 5.4 Boss movement

The boss object (top level of each `BOSSES` entry) controls where the emitters originate:

| `move` | Behavior | Params |
| --- | --- | --- |
| `sine` (default) | Gentle horizontal bob around top-center. | `moveAmp` (px, default 60), `moveSpeed` (rad/s, default 0.8) |
| `still` | Fixed at top-center (Rumia). | — |
| `circle` | Orbit around a center point. | `moveAmp` (radius), `moveSpeed` (angular), `cy` (center y), `moveYScale` (vertical squash, default 0.4) |
| `erratic` | Taisei-style free roam: damped velocity pulled by a spring toward a drifting target, re-aimed every 40–90 frames with the seeded RNG. | `wanderDist` (default 100), `retention` (default 0.9), `attraction` (default 0.015), `accelX`/`accelY` |

Also on the boss object: `name`, `color` (aura), `bgTop`/`bgBottom` (default sky), and
`charId` — set by the caller (`fight-ui.js`), used for the sprite and the RNG seed.

### 5.5 Adding a whole new boss (bigger PR)

Beyond a `BOSSES` entry with both difficulty lists, you need:

1. `CONFIG.CHARACTERS` — display name for the char id.
2. `CONFIG.ROSTER` — which piece type fights this boss (`ai` list).
3. `CONFIG.SURVIVAL_PRIORS` — P(you win) per difficulty; the chess AI uses this to weigh
   captures, so estimate it from playtesting.
4. Character art in `js/art/characters.js` (the boss sprite + a player protagonist if new).
5. Update `tmp-engine-test2.js`'s regression section if it asserts a specific boss count
   (it currently asserts 9).

---

## 6. Balance rules (what makes a card *good*)

These are the house rules encoded in the existing cards. Violating them is the most common
reason a pattern PR gets bounced:

1. **Odd counts for `aimed`/`fan`.** With an even count no bullet sits on the aim line, so the
   player can camp dead-center under the boss and take nothing. (Use `arc` + `center: true` if
   you want an even-symmetric shape with a dead-center bullet.)
2. **Dodgeable by a pawn.** 1 life, 1 bomb, 10 px hitbox, slow ship. If the card is unwinnable
   for a pawn, it's too hard — the pawn is the weakest protagonist in the game.
3. **Respect the bullet cap.** The engine silently drops new bullets past **2000** on screen.
   Check your peak density with the harness in §7; the existing cards peak well below the cap
   (densest: Rumia Lunatic Demarcation, ~1200+).
4. **Size HP gauges to the card's duration.** Player DPS scales with piece value, but the
   range stays within 2-3x (king vs pawn) so no piece can skip a card:
   king ≈ 12, queen ≈ 10, rook ≈ 9.2, bishop ≈ 8, knight ≈ 7.1, pawn ≈ 5 damage/s.
   Rule of thumb: HP ≈ duration x 8 (mid-tier DPS) — a mid-tier piece just barely breaks the
   card before it times out, the king breaks it early (the reward for firepower), and the pawn
   endures the full duration (pure survival). E.g. Rumia's 25 s *Moonlight Ray* carries 200 HP:
   ~17 s for a king, and a pawn (5 dps) never breaks it, surviving the whole card.
5. **Cards are 15–25 s** (`CONFIG.PHASE_SECONDS` = 18 is the nominal length), even for faithful
   EoSD recreations — the patterns loop on their own cycles, so the clock is compressed, not
   the design.
6. **Force movement.** Good danmaku is about reading and dodging, not camping. Mix aimed
   threats (that punish sitting still) with radial/wall threats (that punish cornering).
7. **Readable colors.** Saturated rim + pale/white core (`color` + `coreColor`); use distinct
   colors per emitter so the player can tell layers apart.
8. **If you change a card's difficulty meaningfully, update `CONFIG.SURVIVAL_PRIORS`** for
   that boss — otherwise the chess AI keeps mispricing captures.
9. **Last spells** of a boss can be special: Kaguya's *End of Imperishable Night* sets
   `noBombs: true` and has the highest HP.

---

## 7. Testing your changes

### 7.1 Headless regression (required)

```sh
node tmp-engine-test2.js
```

Covers: determinism, the physics/script/freeze machinery, every emitter type, beams, jitter,
full-duration Rumia fights, practice stats, and a **regression pass of all bosses × both
difficulties** (each phase runs 12 s; fails on crashes or empty fields). Exits non-zero on
failure. New bosses are picked up automatically via `Object.keys(BOSSES)`.

### 7.2 Density check (required for new/changed patterns)

Run a full-duration fight with an invulnerable, non-shooting player and record the max bullet
count per phase — the pattern in `tmp-nitori-density.js`:

```js
global.window = { addEventListener() {}, removeEventListener() {} };
global.performance = { now: () => 0 };
global.requestAnimationFrame = () => 0;
const { BOSSES, getPhases } = require('./js/danmaku/bosses.js');
const { DanmakuEngine } = require('./js/danmaku/engine.js');

function fakeCanvas(w, h) { /* Proxy ctx, every method a no-op — copy from tmp-nitori-density.js */ }

for (const diff of ['normal', 'lunatic']) {
  const e = new DanmakuEngine(fakeCanvas(480, 640), {});
  const phases = getPhases('YOUR_BOSS', diff);
  const boss = { ...BOSSES.YOUR_BOSS, charId: 'YOUR_BOSS' };
  e.start(phases, boss, CONFIG.DANMAKU_STATS['p'], 'p', 'YOUR_BOSS');
  e.player.lives = 999; e.player.bombs = 99;
  e.shotPattern = { type: 'normal', count: 0, spread: 0, speed: 6, r: 3, color: '#fff',
                    damage: 1, interval: 999999 }; // no auto-fire: cards end by timeout
  let frames = 0, maxBullets = 0;
  while (!e.result && frames < 60 * 120) { e.update(); frames++; maxBullets = Math.max(maxBullets, e.bullets.length); }
  console.log(diff, 'max bullets:', maxBullets, 'result:', e.result);
}
```

Notes: `interval: 999999` disables auto-fire so phases run their full duration instead of being
broken early; `lives: 999` keeps the player alive so you measure the whole card.

### 7.3 Determinism check

Two identical fights must produce identical bullet fields (this is what `tmp-engine-test2.js`
asserts for Rumia; replicate it for anything you touch):

```js
const snap = e => e.bullets.map(x => [x.x.toFixed(3), x.y.toFixed(3), x.vx.toFixed(3), x.vy.toFixed(3), x.color].join('|')).join(';');
// run freshFight twice, 600 frames each, assert snap(a) === snap(b)
```

### 7.4 Playtest in the browser

- Open `test-danmaku.html` — engine-behavior tests, results printed top-left.
- Open `test-practice.html` — Practice Mode tests.
- Open `index.html` → **Practice Mode** — actually *play* your card. This is the real review:
  can a human read the pattern? Is there a fair dodge? Does it fit the character's theme?

---

## 8. PR checklist

- [ ] Pattern is pure data in `bosses.js` (no engine changes unless the PR is explicitly about the engine).
- [ ] **No `Math.random` / `Date.now` / unseeded state** anywhere in the change.
- [ ] Both `normal` and `lunatic` variants exist (Lunatic = scaled + usually one extra card).
- [ ] ODD counts for `aimed`/`fan` (or a deliberate reason in a comment).
- [ ] Every emitter has a one-line comment; the card has a header comment (match existing style).
- [ ] Dodgeable by a pawn; peak bullet count checked with the density harness (cap is 2000).
- [ ] `node tmp-engine-test2.js` passes (regression includes all bosses × difficulties).
- [ ] `CONFIG.SURVIVAL_PRIORS` updated if the card's difficulty changed meaningfully.
- [ ] Playtested in Practice Mode; screenshot/GIF of the card attached to the PR.
- [ ] If adding a boss: roster, priors, art, and the boss-count assertion in the regression test.

---

## 9. Where to look for inspiration

- **Rumia** (`RUMIA_MOONLIGHT`, `RUMIA_NIGHT_BIRD`, `RUMIA_DEMARCATION` in `bosses.js`) — the
  reference for *faithful recreation*: mechanics mined from the real EoSD (Touhou 6) ECL script
  (`eosd_extract/ecl/disasm/ecldata1_utf8.txt`) decoded against the decompiled ECL VM +
  BulletManager (`refs/EoSDecomp/`). Shows `period` blocks, `speedStep` streams, `colors`
  cycling, `aimRing`, sweeping beams, and a field freeze.
- **Nitori** — the reference for *gadget-driven* design: shootable bubbles/cucumbers
  (`spawnBullet` + `deathBurst`), walls with shifting gaps, seeded `splash`, `volley`,
  `ringFan`, `arc`, fading camouflage bullets, and a sweeping searchlight beam.
- **Kaguya** — the final boss; her Lunatic finale shows `noBombs` last-spell design.
- **Taisei** (`taisei/`, gitignored) — if you're porting a real spell, its `src/move.c` and
  `src/spells/` are the source of truth for the physics vocabulary; the engine's general
  physics mode (§4.7) mirrors `move_update` exactly.
- **Spell-card descriptions** — `refs/stages/spell_card_descriptions.md` (verified video
  analysis; currently only Rumia's section is verified) and the per-character wiki pages in
  `refs/`.
