# Touhou Chess — Plan

A chess variant where **you command the protagonists** and the **AI commands the youkai bosses**.
Every capture is contested by a short, faithful **danmaku (bullet-hell) boss fight**: survive the
boss and the capture goes through; lose and *your* piece is the one captured.

> Note: the tier-list image in the workspace (`touhou-boss-difficulty-tier-list-...webp`) could not
> be read (no image input on this model). This plan is built from the roster table and the per-boss
> pattern notes provided in chat. If that image contains extra constraints, flag them and I'll fold
> them in.

---

## 1. Core concept

- Standard 8×8 board, standard piece movement (pawn / knight / bishop / rook / queen / king).
- **You = protagonists (white, move first).** **AI = youkai bosses (black).**
- **King-capture rules (the big twist):** there is **no check, no checkmate, no stalemate**. You never
  have to move out of check. The game ends **only when a king is captured**.
- **Captures are boss fights.** Any piece moving onto an enemy piece triggers a danmaku panel. The
  fight's outcome decides who actually gets captured.

### The capture rule (symmetric)

Whichever side initiates the capture, a boss fight plays out against **the AI piece's boss character**
(the AI piece is always the boss). You always play the danmaku.

| Who initiates | Difficulty | You survive (win) | You lose all lives |
|---|---|---|---|
| **Your** piece captures an AI piece | **Normal** | AI piece is removed (your capture succeeds) | **Your** capturing piece is removed |
| **AI** piece captures your piece | **Lunatic** | AI piece is removed (its attack is blocked) | **Your** piece is removed (AI capture succeeds) |

In both cases the rule is identical: **win the fight → the AI's piece dies; lose the fight → your
piece dies.** This is what "if you lose you get captured" means, and it makes the AI's aggression
genuinely risky (Lunatic is hard, but you can still win with skill).

- Capturing the **king** works the same way: it's a boss fight. Win it and the game ends.
- Because there's no check, **kings can stand adjacent**, and a king may capture any enemy piece
  (fight included). The only king constraints are the normal one-square movement and castling rights.

---

## 2. Full rules

**Movement** — standard chess.

**No check / no checkmate / no stalemate** — the king may move onto attacked squares; two kings may be
adjacent; a king may capture any piece.

**Win condition** — capture the enemy king (resolved by its boss fight).

**No draw conditions** — there are no draws at all (no 50-move rule, no threefold repetition, no
insufficient material). The game continues until a king is captured.

**Castling** — allowed under the standard rights (king + that rook unmoved, empty squares between).
No "passing through check" restriction, since check doesn't exist.

**Castle "en passant"** — when a king castles it passes through the middle square (e1→g1 passes
through f1; e1→c1 passes through d1). If an enemy piece could have captured the king on that middle
square (i.e. it attacks the middle square), then **the following turn** that piece gains a special
"en passant" capture right: it may capture the king on the square the king is now on (the destination
square), regardless of whether it normally attacks that square. The right lasts exactly one turn and
is consumed by the capture (which, like all captures, is resolved by the king's boss fight).

**En passant** — standard; it's a capture, so it triggers a boss fight vs the pawn that just double-stepped.

**Promotion** — a pawn reaching the last rank promotes to **any of your own non-king piece types**
(you pick from queen / rook / bishop / knight via a small picker; the AI picks contextually, default
queen). This keeps the roster thematic — a Cirno pawn can become a Marisa queen, etc.

**Turn flow**
1. A side makes a move.
2. If it's a capture, the board **freezes** and the **boss-fight panel** opens.
3. The fight resolves (win/lose).
4. The board updates per the capture rule, then play continues.

---

## 3. Roster (final)

Piece values follow standard chess (1/3/3/5/9/∞) and **drive boss difficulty tier**: low-value pieces
are easy early-game bosses, high-value pieces are hard final bosses.

| Piece | Value | You (protagonists) | AI (bosses) | Why the pairing |
|---|---|---|---|---|
| **King** | ∞ | **Reimu Hakurei** | **Kaguya Houraisan** | Main character vs immortal final boss. Special piece. |
| **Queen** | 9 | **Marisa Kirisame** | **Yukari Yakumo** | Strongest, most versatile. |
| **Rook** ×2 | 5 | **Sakuya Izayoi**, **Youmu Konpaku** | **Remilia Scarlet**, **Yuyuko Saigyouji** | Strong close-range servants vs final bosses. |
| **Bishop** ×2 | 3 | **Sanae Kochiya**, **Reisen Udongein Inaba** | **Patchouli Knowledge**, **Alice Margatroid** | Ranged/magic users, mid-final bosses. |
| **Knight** ×2 | 3 | **Aya Shameimaru**, **Hatate Himekaidou** | **Nitori Kawashiro**, **Momiji Inubashiri** | Fast/mobile tengu vs mountain mid-bosses. |
| **Pawn** ×8 | 1 | **Cirno** (all 8 identical) | **Rumia** (all 8 identical) | Weak, popular, early-game. |

- All 8 of your pawns are **Cirno**; all 8 AI pawns are **Rumia** (identical per side, as requested).
- The two rooks, two bishops, and two knights are **similar-themed pairs** (servants, magic users,
  tengu), as requested.
- The 9 **AI boss characters** are the ones you fight in danmaku: Kaguya, Yukari, Remilia, Yuyuko,
  Patchouli, Alice, Nitori, Momiji, Rumia.

> Lore note: Kaguya first appears as the **true Stage 6 boss of *Imperishable Night*** (2nd), and
> subsequently in many print works (notably *Touhou Bougetsushou*). Her Last Spell is *named*
> "End of Imperishable Night." The fight design below uses her moveset.

---

## 4. Boss-fight (danmaku) design

**Stage** — a portrait bullet-hell stage (classic Touhou aspect, ~480×640) shown in a centered modal
over the frozen board. This is the "Touhou panel."

**Player** — the danmaku character is the protagonist assigned to the piece involved in the capture
(attacker when you capture, defender when the AI captures). **Character strength scales with the
piece's value**: a stronger piece means a stronger danmaku character (more lives, more bombs,
smaller hitbox). Graze adds score and a small bomb-gauge refill. Controls: arrows/WASD to move,
Space/Z to bomb, X focus.

| Piece | Value | Character(s) | Lives | Bombs | Hitbox | Focus |
|---|---|---|---|---|---|---|
| King | ∞ | Reimu | 3 | 3 | 6px | 1.5px |
| Queen | 9 | Marisa | 3 | 3 | 6px | 1.5px |
| Rook | 5 | Sakuya / Youmu | 3 | 2 | 7px | 2px |
| Bishop | 3 | Sanae / Reisen | 2 | 2 | 8px | 2px |
| Knight | 3 | Aya / Hatate | 2 | 2 | 8px | 2px |
| Pawn | 1 | Cirno | 1 | 1 | 10px | 3px |

**Fight structure** — each fight is a sequence of **phases** like a real boss fight:
a non-spell phase, then named **spell-card** phases (banner shows the card name, Touhou-style).
**Survive all phases = you win.** Lose all lives before the end = you lose.

- **Normal** (you initiated): **3 phases**, ~15–25s each.
- **Lunatic** (AI initiated): **4 phases** (one extra spell card) **and** scaled-up parameters
  (bullet speed ×~1.2, density ×~1.3–1.4, stronger homing, tighter safe space).

**Fidelity** — patterns are built from the actual moves you listed, using the real spell-card names,
bullet types/colors, and the boss's movement style. A shared **pattern DSL** (emitters + bullet
primitives: straight, aimed, ring, spiral, fan, laser, homing, wave, curve) makes each fight a
data-driven script, so the 9 bosses × 2 difficulties are authored as data, not code.

### Per-boss fight scripts

**Rumia — Pawn (value 1), easiest.** Stationary, simple aimed danmaku.
1. Non-spell: aimed red lines + aimed blue rings (her non-spell set).
2. Spell *"Night Bird"*: alternating arm swings → half-circle "wing" bursts.
3. Spell *"Demarcation"*: weaving circle spreads + aimed waves (more aimed shots the longer it runs).
4. *(Lunatic only)* Spell *"Moonlight Ray"*: V-formation continuous lasers + rings of small orbs.

**Nitori — Knight (value 3).** Water/gadget themes.
1. Non-spell: aimed bubble shots + slow "Bubble Dragon" gun bubbles.
2. Spell *"Ooze Flooding"*: ooze walls flood in from the sides + aimed bubbles.
3. Spell *"Diluvial Mere"*: bending danger-currents flood in from the sides.
4. *(Lunatic only)* Spell *"Optical Camouflage"*: curving eye-shaped bullet walls (a trap).

**Momiji — Knight (value 3).** Shield-based, simple but fast (few real spell cards).
1. Non-spell: fast aimed shots (Sakuya-like range) + a shield-rim ring.
2. Spell *"Shield Charge"* (adapted from her melee ram): a dash across the screen leaving a bullet trail.
3. Spell *"Shield Wall"* (adapted from her Double Spoiler shield danmaku): a rotating shield-shaped
   wall that opens and closes.
4. *(Lunatic only)* a faster mixed aimed barrage.

**Patchouli — Bishop (value 3).** Elemental magic.
1. Non-spell: elemental fireballs (aimed + spread).
2. Spell *"Agni Shine"*: fireball volley.
3. Spell *"Princess Undine"*: a waterway appears at your position + a high-pressure water spout.
4. *(Lunatic only)* Spell *"Metal Fatigue"*: a volley of metal swords (delayed, shapeshifting).

**Alice — Bishop (value 3).** Dolls.
1. Non-spell: doll-archer arrows (scattered, dense, from behind you).
2. Spell *"Thousand Spear Dolls"*: dolls form a ring around her and spear outward.
3. Spell *"Dolls of War"*: a dense spinning doll formation that traps you.
4. *(Lunatic only)* Spell *"Explosive-laden Dolls"*: a column of dolls marches along the bottom and
   erupts into wide spreads.

**Remilia — Rook (value 5).** Vampire final-boss pressure.
1. Non-spell: aimed red fans + rings.
2. Spell *"Scarlet Shoot"*: two 5-way fans of large fast red bullets aimed at you.
3. Spell *"Scarlet Netherworld"*: rings of bullets fall into lanes + a circle around her.
4. Spell *"Spear the Gungnir"*: a massive piercing spear aura.
5. *(Lunatic only)* Spell *"Star of David"*: red laser lattice; joints fire large blue bullets
   (peripheral random, central 5-way star).

**Yuyuko — Rook (value 5).** Death/butterfly/cherry-blossom themes.
1. Non-spell: blue butterfly circles (stationary).
2. Spell *"Dance of the Dead Butterflies"*: butterfly circles that alternate left/right each wave.
3. Spell *"Ghost Spot"*: two counter-rotating blue circles → expanding red butterfly lines + five
   purple circles at random spots.
4. Spell *"Eternal Sleep in Dreamland"*: a spiraling storm of butterfly shots around her.
5. *(Lunatic only)* Spell *"Ageless Dream"*: a phantom that tracks you and drains (adapted from the
   possession effect).

**Yukari — Queen (value 9).** Boundary manipulation, screen-control.
1. Non-spell: aimed shots + gaps that open and fire from random positions.
2. Spell *"Curse of Dreams and Reality"*: a bubble bursts into a slow spiraling cyan rice-bullet
   pattern that stops, then homes in.
3. Spell *"Balance of Motion and Stillness"*: 3-way bubble spread; the middle spawns an invisible
   emitter at your position firing a dense spiral.
4. Spell *"Mesh of Light and Darkness"*: two colors of bullets fired in near-simultaneous alternation.
5. *(Lunatic only)* Aerial Bait *"Addictive Bait"*: high-speed objects pass through gaps across the screen.

**Kaguya — King (value ∞), the final boss.** Eternity + the Impossible Requests. Longest fight.
1. Non-spell: aimed "jellybean" stream + slow rice bullets + *"Meteor Shower"* (random salvos that
   stop and change direction; keeps going through her movement).
2. Spell *"Jewel from the Dragon's Neck"*: lasers centered on you + unaimed orbs each shot.
3. Spell *"Buddha's Stone Bowl"*: random lasers in all directions + a targeted star barrage.
4. Spell *"Swallow's Cowrie Shell"*: a magic circle beams in all directions, then releases two
   counter-rotating rings of star bullets.
5. Spell *"Brilliant Dragon Bullet"*: fixed aimed laser barrage + rainbow balls at alternating heights.
6. *(Lunatic only)* **Last Spell *"End of Imperishable Night"***: a moon-phase series (New Moon →
   Crescent → 1st Quarter → Paschal Moon). **Bombs are disabled** for this phase, faithful to the original.

---

## 5. Art (all self-made, recognizable)

No external assets. Everything is hand-authored **vector (SVG/canvas)** in a consistent style:
flat colors, bold outlines, strong silhouettes + signature item, so each character reads at small
sizes. One art spec per character, reused at multiple sizes.

**Deliverables**
- **Chess-piece icons** (~64×64): stylized bust (head + shoulders + signature item) for all 18 characters.
- **Danmaku player sprites** (~16×24): small bullet-hell ship in the character's colors + item.
- **Boss sprites** (~96×128): standing portrait with a gentle idle animation (bob / wing-flap).
- **Board skin**: a subtle Gensokyo-themed board (shrine / cherry-blossom tint) or clean wood.
- **Stage backgrounds** for the danmaku panel (simple, per-boss tint).

**Recognizability cheat-sheet (color + item per character)**

| Character | Signature look |
|---|---|
| Reimu | red/white miko, red hair + white ribbon, wind bell |
| Marisa | black hat with white star, orange hair, broom |
| Sakuya | white/blue maid, gold pocket watch |
| Youmu | black/white half-and-half, sword |
| Sanae | white/blue shrine maiden, red hair, gohei |
| Reisen | blue outfit, rabbit ears |
| Aya | black outfit, bat wings, red magazine |
| Hatate | white/blue tengu, glasses, feather, clipboard |
| Cirno | blue outfit, pink hair, ice-crystal hair ornament |
| Kaguya | white/gold kimono, long black hair, hairpin |
| Yukari | purple jacket, white shirt, black skirt, "holes" |
| Remilia | red dress, long red hair, bat wings, red eyes |
| Yuyuko | white kimono w/ blue pattern, black hair, butterfly |
| Patchouli | purple hair, glasses, white robe, book |
| Alice | black dress, purple hair, white ribbon, doll strings |
| Nitori | blue kappa outfit, gill-fins, backpack |
| Momiji | white wolf, blue/white outfit, shield |
| Rumia | black/white outfit, black hair, bat wings |

**MVP fallback** — if per-character danmaku sprites get heavy, all danmaku fights use **Reimu** as the
player ship (she's the series face and your king). Per-character ships are a stretch milestone.

---

## 6. AI opponent

The AI plays black (the bosses) with a twist-aware evaluation.

**Search** — minimax with alpha-beta pruning, depth 3–4, plus a quiescence extension on captures.

**Capture-risk model (the key twist).** Because captures are contested by fights, the AI weights
captures by the *probability the fight goes its way*:
- An **AI piece you can capture** is worth less than its face value: expected loss =
  `value × P(you win Normal vs that boss)`.
- An **AI capture of your piece** is worth less than a normal capture: expected gain =
  `value × P(you lose Lunatic vs that boss)`.

**Survival priors** (your chance to win the fight), tuned per boss tier and **adapted at runtime**
from actual fight results (moving-average / Bayesian update), so the AI learns how you actually play:

| Boss | P(you win **Normal**) | P(you win **Lunatic**) |
|---|---|---|
| Rumia (pawn) | 0.90 | 0.36 |
| Nitori / Momiji (knight) | 0.80 | 0.32 |
| Patchouli / Alice (bishop) | 0.75 | 0.30 |
| Remilia / Yuyuko (rook) | 0.60 | 0.24 |
| Yukari (queen) | 0.45 | 0.18 |
| Kaguya (king) | 0.30 | 0.12 |

Net effect: the AI **avoids leaving pieces en prise** (you'll usually win Normal) and **aggressively
pounces** when a Lunatic capture is on (you'll usually lose), while still playing solid positional
chess (mobility, center, king distance).

**Legality** — the AI uses the same no-check rules: it may sit adjacent to your king and may capture
into "check"; it only cares about the fight odds.

**Opening** — a small opening book / randomized sane opening to avoid blundering the first moves.

---

## 7. Technical architecture

**Stack** — plain **HTML5 + Canvas + SVG**, vanilla JS, **no build step, no dependencies**. Runs by
opening `index.html` (or a local static server).

- **Board** — DOM/SVG grid (crisp, easy hit-testing, accessible) with SVG piece icons.
- **Danmaku** — a dedicated `<canvas>` with a fixed-timestep 60fps loop, a pooled bullet system, and
  the data-driven pattern engine.
- **Pattern engine** — a small DSL: emitters (point, ring, spiral, aimed, laser, homing, wave, curve)
  + timing + phase scripts. Each boss fight is data.
- **State machine** — `player-turn → ai-turn → boss-fight → game-over`, with the board frozen during fights.
- **Audio** — synthesized **WebAudio** SFX (no assets): bullet fire, graze, hit, bomb, victory/defeat
  jingles. Optional but on-theme.

**File layout**
```
touhou_chess/
  index.html
  css/style.css
  js/
    main.js              — bootstrap, top-level state machine
    config.js            — values, roster, difficulty multipliers, survival priors
    chess/
      board.js           — board state + move generation (king-capture rules)
      rules.js           — legality, en passant, castling, promotion, 50-move, threefold
      ai.js              — minimax + alpha-beta + capture-risk model
    danmaku/
      engine.js          — loop, player, lives/bombs, collision, graze
      patterns.js        — pattern DSL + bullet primitives
      bosses.js          — 9 fight scripts (Normal + Lunatic), data-driven
      player.js          — player ship(s)
    art/
      characters.js      — SVG art library (18 characters)
      board-skin.js      — board + stage backgrounds
    ui/
      board-ui.js        — board render, click/drag, highlights
      fight-ui.js        — modal panel, HUD (lives/bombs/score/phase/spell-card banner)
      screens.js         — main menu, game over, how-to-play
    audio/sfx.js         — WebAudio synth
  PLAN.md
```

---

## 8. UI / UX

- **Main screen** — centered board, turn indicator, captured-piece trays, a fight log, and a
  "How to play" (explains the boss-fight capture rule).
- **Boss-fight panel** — centered portrait stage over the frozen board: boss portrait + name,
  spell-card banner, HUD (lives, bombs, score, graze, phase), bomb button (Space), pause.
- **Result** — on win, the AI piece is removed with a little animation; on loss, your piece is
  removed. Then play resumes.
- **Game over** — king captured → victory/defeat screen with a summary (pieces lost, fights won/lost).
- **Menu** — AI strength, sound toggle, how-to-play.
- **Controls** — click-to-select/move (or drag) on the board; arrows/WASD + Space/Z (bomb) + X (focus)
  in danmaku.

---

## 9. Milestones

1. **M1 — Chess core**: board, king-capture rules, move generation, click-to-move (player vs AI).
2. **M2 — AI**: alpha-beta opponent with the capture-risk model.
3. **M3 — Danmaku engine**: loop, player, lives/bombs, pattern DSL, and the **Rumia** fight
   (Normal + Lunatic) as the reference implementation.
4. **M4 — Integration**: capture → fight → result applied to the board; AI's Lunatic fights wired in.
5. **M5 — All boss fights**: the remaining 8 fight scripts (from the pattern notes above).
6. **M6 — Art**: the 18-character SVG library, board skin, stage backgrounds, boss idle animations.
7. **M7 — Polish**: WebAudio SFX, UI screens (menu/game-over/how-to), adaptive survival rates,
   save/load, bullet-pool performance.
8. **M8 — Tuning & testing**: balance pass (AI strength, fight length), bug hunt, playtest.

---

## 10. Open decisions (defaults chosen — confirm or override)

1. **Danmaku player character** — *default: the player piece involved in the capture* (attacker when
   you capture, defender when the AI captures), so each protagonist gets a danmaku appearance.
   Fallback: always Reimu.
2. **Promotion** — *default: pick any of your own non-king piece types.*
3. **Fight length** — *default: 3 phases (Normal) / 4 phases (Lunatic), ~15–25s each.*
4. **Kaguya Last Spell** — *default: include it, with bombs disabled, faithful to the original.*
5. **Draws** — *none. The game continues until a king is captured (no 50-move, no threefold, no
   insufficient material).*
6. **Sound** — *default: include synthesized WebAudio SFX.*

---

## 11. Two-player mode (post-1-player — build only after the 1-player version works)

A local two-player mode where **both sides are human**. This is a stretch goal: it is built
**after** the 1-player (vs AI) version is fully working.

- **Side-by-side** — the two danmaku panels are shown **side-by-side**, so each player sees their
  own fight at the same time.
- **Lives decide the winner** — each player has a pool of lives; **whichever player runs out of
  lives first loses** the game.
- **You fight the other player's boss** — when a capture happens, the capturing player fights the
  danmaku boss that is the **other player's piece** (the captured piece's boss character). I.e. each
  player has to play the boss that would be the other player's piece.

  peer using peerjs maybe
Official Touhou art style—especially ZUN’s original games—has a distinct handmade doujin look. Character art is flat and cel-shaded, with thick outlines, saturated colors, simple shading, big eyes, and often slightly wonky proportions. It’s charming rather than polished: ribbons, frills, hats, and exaggerated silhouettes are common. Backgrounds are often dark, abstract, or low-poly 3D scrolls, which makes the characters and bullets pop. The PC-98 games are darker and more limited; the Windows games are smoother, brighter, and more colorful.

The bullets are the real visual signature. Touhou danmaku doesn’t use realistic projectiles—it uses simple geometric icons that read instantly. Common bullet shapes include small round pellets, rice/oval bullets, large orbs, stars, amulets/talismans, knives/kunai, butterflies, swords, ice shards, bubbles, notes, and lasers. They usually have a bright white or pale core, a saturated colored rim, and some glow, transparency, or pulse. Against dark backgrounds they look like neon geometry.

Pattern-wise, Touhou bullets are arranged like fireworks, flowers, kaleidoscopes, and curtains. You see rings, spirals, petals, webs, waves, mazes, aimed shots, random spray, and sweeping walls. Boss spell cards often match bullet shape and color to the character’s theme: Reimu uses red-and-white amulets and yin-yang orbs; Marisa uses stars and huge lasers; Sakuya uses knives; Remilia uses red bats/spears; Yuyuko uses butterflies; Cirno uses ice shards. Lasers often appear as thin warning lines that become thick beams.

Technically, the style prioritizes readability and elegance: a tiny player hitbox, clear bullet silhouettes, high contrast, limited palettes per pattern, symmetry, repetition, and bullet-cancel effects when a boss is defeated. The result is dense but readable, dangerous but beautiful—less about realistic projectiles, more about abstract geometry and choreography.
Sure. In Touhou, the player’s shots are the visual and mechanical opposite of enemy danmaku: they’re fast, sparse, functional, and readable. They exist to deal damage and give feedback, not to create a bullet maze. That’s why they usually look like small, bright, low-detail sprites—white or pale cores with a colored rim, little glow, and simple shapes. They’re often layered under enemy bullets so they don’t hide danger.

Common player shot archetypes:

- **Concentrated forward shots** — narrow streams for boss damage. Often needles, knives, sword slashes, or tight lasers.
- **Spread/wide shots** — fans or multiple angles for clearing enemies. Usually weaker per bullet but cover more space.
- **Homing shots** — amulets, orbs, or small spirits that curve toward enemies. Great for mobile play, lower direct DPS.
- **Piercing/laser shots** — thin beams or lasers that go through enemies. Often associated with Marisa.
- **Melee/short-range shots** — Youmu’s sword slashes or similar, high damage but risky positioning.
- **Option-based shots** — small “options” or familiars that fire extra bullets. Their placement changes when you focus.

The focus/unfocus system is central. Holding Shift slows you down and usually tightens your options into a concentrated forward pattern. Releasing Shift spreads them out for wider coverage. So the same character can switch between “wide, casual” and “narrow, boss-killer” shot patterns just by holding a key.

Character themes show up clearly:

- **Reimu**: ofuda/amulets, yin-yang orbs, needles. Red-and-white, purifying, often homing or spread.
- **Marisa**: stars, magic missiles, lasers. High speed, high damage, often narrow or piercing.
- **Sakuya**: throwing knives. Rapid, spread or focused, very clean and linear.
- **Youmu**: sword slashes and phantom spirits. Close-range, high damage, slash-like arcs.
- **Sanae**: frogs, snakes, onbashira. Wide, homing, or miracle-themed.
- **Reisen**: lunatic guns and spread shots. Often wave-like or disruptive.
- Others like Cirno, Aya, etc., follow the same rule: shot shape and color match the character’s motif.

Visually, player shots are designed to contrast with enemy bullets. Enemy bullets are ornate, slow, geometric, and dense. Player shots are small, fast, repetitive, and cool-toned or white. They usually don’t have big glows or intricate animation. They fire in steady streams, fans, homing arcs, or piercing lines, with a rhythmic “shot” sound and small impact effects.

In the main games, player shots are not really “danmaku patterns” in the same way enemy spell cards are. They’re more like conventional shoot-’em-up weapons: predictable, symmetrical, and optimized for DPS and positioning. In spinoff versus games like *Phantasmagoria of Flower View* or the fighting games, player attacks become more danmaku-like—charged shots, specials, and spell-card-style patterns—but they still keep that simple, character-coded visual language.
Here’s a breakdown of Aya Shameimaru, Hatate Himekaidou, and Cirno, focusing on their visual design, bullet patterns, and shooting styles within the *Touhou Project*.

### 🖋️ Aya Shameimaru
Aya is a crow tengu reporter with a classic, traditional aesthetic that contrasts with Hatate's modern look.

*   **Visual Design**: She has semi-long black hair, red eyes, and pointed ears. Her signature outfit is a small red **tokin hat** with pompoms, a white collared shirt with a black ribbon, a black short skirt, and black wings.
*   **Bullet Patterns & Shooting**: Aya's danmaku is defined by **speed and wind**. In *Phantasmagoria of Flower View*, her bullets are described as **fast, arc-shaped, and slightly waving**. Her spell cards include **"Tengu Gale Bullet,"** a large bullet that bounces off screen edges, and **"Wind God's Fan,"** which creates stacks of bullets that spread into lines. In the photography games (*Shoot the Bullet*), she doesn't use traditional shots, but a **camera** to "snap" and erase bullet patterns. She is a fast, agile character focused on rapid, wind-based offense.

### 🖋️ Hatate Himekaidou
Hatate is a more modern crow tengu reporter who serves as a rival to Aya, representing a new generation.

*   **Visual Design**: Her design is more contemporary. She has long brown hair in pigtails with purple ribbons and pointed ears. She wears a **pinkish shirt** with purple trim and a thin black tie. Her most distinct feature is her **camera**, which is shaped like a modern cell phone with a checker pattern and a brush charm.
*   **Bullet Patterns & Shooting**: Hatate's abilities are based on **spirit photography**. In *Double Spoiler*, her gameplay differs from Aya's: she has a **faster recharge speed** for her camera but **inferior zoom functionality**, and she takes **panoramic photos** instead of standard ones. Her attacks are framed as photography skills, such as **"Reporting Training," "Candid Shot,"** and **"Rapid Shot"**. Her style is fast-paced and tech-oriented, utilizing rapid-fire photography to capture and erase danmaku.

### 🧊 Cirno
Cirno is an ice fairy with a simple, iconic design that reflects her powers and her well-known "⑨" nickname (associated with the number 9 and a certain simplicity).

*   **Visual Design**: She has aqua-colored eyes and hair, usually styled in twin-tails. She wears a blue ribbon, a **light pink blouse**, a blue jumper dress, and has **icicle-shaped wings**.
*   **Bullet Patterns & Shooting**: Cirno's danmaku is all about **ice**. She is noted as the first Windows-era boss to use **random bullets**. Her patterns include firing **icicles**, creating expanding circles of dot and ice bullets, and using her signature spell card, **"Perfect Freeze,"** which can **freeze and erase all bullets on screen**. In *Fairy Wars*, this freezing mechanic is central to the gameplay. Her shots are typically ice shards, icicles, or hail, with a focus on free-form patterns and the ability to freeze and control the battlefield.

If you'd like a deeper dive into any specific spell card or game appearance, feel free to ask.

The site looks very generic, aka looks like every AI generated site, give it some polish/theme. Here is an example UI that you may want to use.

When you focus, it removes the hitbox circle, where it should probably be the other way around. There is also no timer to tell when a spell card would end if you dont do enough damage.

Add multiplayer using peerjs I think, it should be like phantasmagoria of flower view where each plays the boss of the other, and whoever loses first has their piece removed. It should stay similar to the AI version, in that the white pieces should just use the black piece bosses for black. It should show both screens to both players, so they can see how the other is doing. It should have some way of increasing difficulty over time so eventually one player must lose.

