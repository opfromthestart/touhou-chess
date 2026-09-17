# Porting Real Touhou Spell Cards to `bosses.js`

A runbook for turning a **real Touhou stage ECL script** into the pattern set
for one boss in `js/danmaku/bosses.js`, matching the original's spells — from
"game zip in hand" to "verified in the browser". This is the *mining* half of
the work. For the *authoring* half (phase/emitter fields, balance rules,
testing), read [`danmaku-engine.md`](./danmaku-engine.md) first — this doc
assumes you know how to write an emitter and focuses on getting the right data
out of the binary and proving it's the right data.

Two games are worked end-to-end here, each with its own ECL container format,
disassembler, opcode map, and rank-mask encoding:

| Game | Release | ECL source | Disassembler | Done? |
| --- | --- | --- | --- | --- |
| **EoSD** (Touhou 6) | 2002 | `eosd_extract/ecl/ecldataN.ecl` | Python struct walk | Rumia (S1), Yukari (S7) |
| **MoF** (Touhou 10) | 2005 | `mof_extract/ecl/stageNN.ecl` | `thecl -d 10 -j` | Nitori (S3) |

The process is identical; only the byte layout and opcode numbers differ. Every
claim below was verified against decompiled source or the THTK toolchain while
porting the reference bosses.

**Pipeline at a glance:**
1. Get the game archive → extract the stage ECL (§3)
2. Disassemble it (§4)
3. Identify which sub is the boss you want (§5)
4. **Verify the spells are the real ones** — match banners to the official card
   list, per difficulty (§6)
5. Read the byte format if you need raw access (§7)
6. Decode the patterns (§8–§9)
7. Translate to engine emits (§11) and verify (§13)

---

## 1. Where things live

### Shared
| Path | What it is |
| --- | --- |
| `refs/stages/spell_card_descriptions.md` | Official **spell names** per character — your card list / source of truth for *which* spells a boss has, their names, and their order. |
| `refs/stages/<Char>.html` | Per-character stage notes (which stage a boss appears on). |
| `js/danmaku/bosses.js` | Where you author. |
| `js/danmaku/engine.js` | Emit vocabulary (see engine doc §4.3). |
| `test-bosses.js`, `tmp-nitori-density.js`, `tmp-nitori-determinism.js` | Test harnesses (§13). |

### EoSD (Touhou 6)
| Path | What it is |
| --- | --- |
| `eosd_extract/ecl/ecldataN.ecl` | Raw binary ECL script for stage `N` (N = 1..7). |
| `eosd_extract/ecl/disasm/ecldataN.txt` | **Disassembly**: `sub SubX()` blocks + `Timeline0`. (`*_utf8.txt` = same with clean CJK spell names.) |
| `refs/EoSDecomp/src/EnemyController/run_ecl_decompiled.cpp` | The ECL VM — **authoritative for every opcode**. Shoot handler ≈ L724–795, laser ≈ L880–949, auto-refire loop ≈ L196–217. Instruction parse at L599–615. |
| `refs/EoSDecomp/src/BulletManager/shoot_bullets_decompiled.cpp` | Row/column loop (which count is outer vs inner). |
| `refs/EoSDecomp/src/BulletManager/shoot_one_bullet_decompiled.cpp` | Aim-mode angle math (per-bullet bearing + per-row speed peel). |
| `refs/EoSDecomp/src/BulletManager/shoot_lasers_decompiled.cpp` | Laser init: type 0 adds `angle_to_player`, type 1 is absolute. |
| `refs/EoSDecomp/src/BulletManager/on_tick_decompiled.cpp` | Laser tick state machine. |

### MoF (Touhou 10)
| Path | What it is |
| --- | --- |
| `refs/Touhou 10 - Mountain of Faith.zip` | The game archive (contains `th10.dat`). |
| `mof_extract/ecl/stageNN.ecl` | Raw binary ECL for stage `NN` (01..11 + extras). `stage03.ecl` = Nitori. |
| `mof_extract/disasm/stageNN.txt` | **Disassembly** from `thecl -d 10 -j`. Read it directly. |
| `refs/th10/src/EnemyEclDispatcher.cpp` | The Th10 dispatcher — **authoritative for opcodes 0x100–0x1B4** (enemy/pattern/laser ops). Pattern-slot handlers live here. |
| `refs/th10/src/EclVm.cpp` | The Th10 VM core — opcodes 0x00–0x57 (jumps, threads, arithmetic, `POLAR_TO_CARTESIAN`, `NORMALIZE_ANGLE`, `SUBTRACT_TIME`). |
| `thtk_source/thecl/thecl10.c` | The `thecl` disassembler source — **authoritative for the MoF container/instruction byte layout** and the `th10_fmts[]` per-opcode arg formats. |
| `thtk2026-09-15/` | The THTK toolchain (`thdat`, `thecl`, `libthtk.so.1`). |

---

## 2. Stage → boss mapping (verify, don't assume)

A stage file can hold **multiple bosses** (midboss + final). Split by identifying
each boss's container sub (§5), never by assuming one file = one boss. Cross-check
spell **names** against `refs/stages/spell_card_descriptions.md` (§6).

### EoSD (Touhou 6) — 7 stages
| ECL file | Stage | Boss(es) |
| --- | --- | --- |
| `ecldata1` | S1 | **Rumia** (done) |
| `ecldata2` | S2 | **Cirno** |
| `ecldata3` | S3 | **Urumi** (not Nitori) |
| `ecldata4` | S4 | Patchouli |
| `ecldata5` | S5 | Alice |
| `ecldata6` | S6 | Remilia |
| `ecldata7` | S7 + Final | Yuyuko, Yukari, Kaguya |

> ⚠️ **Earlier this doc wrongly listed `ecldata2` as Nitori.** It is **Cirno**.
> Nitori is **not in EoSD at all** — she is a MoF boss (below). Always confirm a
> stage's boss by reading its spell banners, not by position.

### MoF (Touhou 10) — 11 stages
| ECL file | Stage | Final boss | Notes |
| --- | --- | --- | --- |
| `stage01` | S1 | Cirno | |
| `stage02` | S2 | Urumi | |
| `stage03` | S3 | **Nitori** (done) | `Boss*` = final; `MBoss*` = midboss (separate, earlier fight) |
| `stage04` | S4 | Suika | |
| `stage05` | S5 | Marisa | |
| `stage06` | S6 | Sakuya | |
| `stage07` | S7 | Youmu | |
| `stage08` | S8 | Eirin | |
| `stage09` | S9 | Reisen | |
| `stage10` | S10 | Aya | |
| `stage11` | S11 | Marisa (final) | |

Within a stage the fight flow is: non-spell spawn sequences → midboss container →
final-boss container(s) → spell containers called by the final boss. In MoF the
final boss's sub is usually named `Boss`, with `Boss1`/`Boss2`/`Boss3` as the
three spell-card controllers and `BossN_at`/`BossN_at2` as the non-spell attacks
between cards. `ins_334(idx, hp, timeout, "CardSub")` is the spell-card interrupt:
it starts a card (or, at the last card, the death sub).

---

## 3. Getting the game data & extracting the ECL

### 3.1 MoF (Touhou 10) — via thdat
The game ships as a zip containing `th10.dat` (a packed archive). Use the THTK
toolchain's `thdat`:

```bash
# 1. Unzip the game (if not already): the .dat sits at the root or in a folder.
unzip "refs/Touhou 10 - Mountain of Faith.zip" -d tmp-th10/

# 2. Extract ALL resources (d = decompress everything) into mof_extract/.
LD_LIBRARY_PATH=thtk2026-09-15/lib \
  ./thtk2026-09-15/bin/thdat -x d "tmp-th10/.../th10.dat"
```
- thdat needs `libthtk.so.1` — always set `LD_LIBRARY_PATH=thtk2026-09-15/lib`
  or it fails with a missing-library error.
- The stage scripts land in `mof_extract/ecl/stageNN.ecl` (+ `.std` companions).
- To re-extract just one file after moving things, re-run with the same flags;
  thdat overwrites cleanly.

### 3.2 EoSD (Touhou 6)
The `ecldataN.ecl` files were extracted from the EoSD data archive the same way
(thdat supports Th6 with `-d 6`); they're already in `eosd_extract/ecl/`. If you
ever need to redo it: `thdat -x d <th6.dat>` and copy `ecl/ecldataN.ecl`.

### 3.3 General notes
- **Never work in `/tmp`** — it is not shared between bash tool calls. Write all
  extraction/disassembly output into the workspace (`mof_extract/`, etc.).
- Keep the raw `.ecl` files; the disassembly is derived and cheap to regenerate.

---

## 4. Disassembling

### 4.1 MoF — `thecl`
```bash
LD_LIBRARY_PATH=thtk2026-09-15/lib \
  ./thtk2026-09-15/bin/thecl -d 10 -j mof_extract/ecl/stage03.ecl > mof_extract/disasm/stage03.txt
```
- `-d 10` = Th10 dump mode (use `-d 6` for EoSD-era files when thecl supports them).
- **`-j` converts Shift-JIS ↔ UTF-8** — REQUIRED. Without it the output is raw
  CP932 and the `read` tool rejects it as invalid UTF-8.
- Output: one `void SubName(args)` block per sub, with rank prefixes (`!EN`, `!H`,
  …), frame labels (`+120: //120`), and `ins_NNN(...)` instructions (decimal
  opcode). Plus the sub table at the top.
- `thecl` handles the MoF container for you — no custom Python walker needed.

### 4.2 EoSD — Python struct walk
If a `disasm/ecldataN.txt` is ever missing, regenerate it with a Python struct
walk of the binary (layout in §7.1): each instruction = `time(u32 LE), id(u16),
size(u16), unused(u8), diffmask(u8), parammask(u16)` + `(size−12)` arg bytes;
terminator is `time=0xFFFFFFFF, id=0xFFFF`. Walk each `SubN` stream to its
terminator to get the sub offsets. (Already done for all 7 stages.)

---

## 5. Identifying the boss inside a stage

One stage file ≠ one boss. Find the right sub:

1. **Look for the container sub** — the one that spawns the boss sprite, sets a
   big life value, and chains the spell controllers. MoF naming: `Boss` (final)
   vs `MBoss` (midboss); EoSD naming: the sub whose `Timeline0` entry spawns the
   big sprite late in the stage.
2. **Check the life value.** MoF: `ins_331(8800)` in `Boss` vs `ins_331(2200)` in
   `MBoss` — the final boss carries the large pool. EoSD: the equivalent SET_LIFE
   op.
3. **Follow the card chain.** The container calls the card controllers
   (`Boss1`→`Boss2`→`Boss3` in MoF via `ins_334(…, "BossCardN")`). Each controller
   shows a card-name banner (§6) — that's your card list, in order.
4. **Midboss is separate.** In MoF S3, `MBoss*` runs its own card (Optical/Hydro
   Camouflage) *before* Nitori appears. Don't fold midboss patterns into the
   final boss's fight unless you intentionally want a combined fight.
5. **Helper subs** (`Girl00*`, `GGirl00*`, `SpCir*`, `RGirl00_at`, …) are spawned
   bullets/enemies with their own patterns — mine them too when a card spawns
   them (e.g. Card 1 spawns `BossCard1At` side shooters via `ins_257`).

---

## 6. Verifying the spells are correct

This is the step that catches wrong-boss / wrong-card mistakes **before** you
author anything. Do all four checks:

1. **Match the banners to the official card list.** Every spell-card controller
   contains a card-name banner instruction with the literal CJK name:
   - MoF: `ins_357(…, "洪水「ウーズフラッディング」")` (E/N line), `ins_359(…)`
     (H line), `ins_342(…)` (L line).
   - EoSD: the equivalent START_SPELL string op in the spell sub.
   Compare each against `refs/stages/spell_card_descriptions.md` for that
   character. If a banner doesn't appear in the character's official list, you're
   in the wrong sub (or the wrong stage file).
2. **Per-difficulty name variants are expected and must be kept distinct.**
   E/N usually share a name; H and/or L often get their own. Example (Nitori
   card 3): E/N 「お化けキューカンバー」, H 「のびーるアーム」, L 「スピン・ザ・
   セファリックプレート」. When H and L differ, the L card is a genuinely
   different pattern (its own `_at` subs) — port it as the Lunatic-only card.
3. **Check the card order and count.** The `ins_334(…, "NextSub")` chain defines
   the order: Nitori is Card1 → Card2 → Card3 → (L: Card3L instead of Card3) →
   BossDead. Confirm the count matches the official list (Nitori: 3 cards).
   Timeout values (3600 frames = 60 s in MoF) and per-card HP (2300/2100/2300)
   are good sanity checks — they should look like real card budgets, not noise.
4. **Confirm the character/stage itself.** `refs/stages/<Char>.html` says which
   stage the boss is on; the stage file number must agree (Nitori = MoF stage 3
   = `stage03.ecl`). This is exactly the class of bug that made this doc once
   claim "EoSD stage 2 = Nitori" — it isn't; EoSD S2 is Cirno.

Only proceed to pattern mining once all four checks pass. Record the verified
card table (names per difficulty + HP + timeout) in your notes/doc — it's the
contract the authored fight must match.

---

## 7. ECL container formats (raw byte level)

Pick per game. You rarely need these if `thecl`/the Python walk already gave you
a disassembly — use them when probing raw bytes or debugging a parse.

### 7.1 EoSD (Touhou 6)
Top-level: `count(u32)@0, timeline_off(u32)@4, pad(8)`, then a sub-offset table
at `0x10`. Each instruction:
```
time(u32 LE), id(u16), size(u16), unused(u8), diffmask(u8), parammask(u16), args[size-12]
```
Terminator: `time=0xFFFFFFFF, id=0xFFFF`. `size` includes the 12-byte header.
Observed `diffmask`: `0xFF`=all, `0x02`=!N, `0x04`=!H, `0x08`=!L, `0x0E`=!*.

### 7.2 MoF (Touhou 10) — authoritative from `thecl10.c`
- **`th10_header_t`** (32 B): `magic[4]="SCPT"`, `u16 unknown(=1)`,
  `u16 include_length`, `u32 include_offset(=32)`, `u32 zero`, `u32 sub_count`,
  `u32 zero[4]`.
- At `include_offset`: an **`ANIM`** list then an **`ECLI`** list — each
  `magic[4], u32 count, NUL-terminated strings (4-byte aligned)` — then a
  4-aligned `u32` **sub-offset table** (`sub_count` entries), then one
  NUL-terminated sub-name string per sub, then the sub bodies.
- **`th10_sub_t`**: `magic[4]="ECLH"`, `u32 data_offset(=16)`, `u32 zero[2]`,
  `data[]`.
- **`th10_instr_t`** (16-B header + `data[]`):
  ```
  time(u32), id(u16 opcode), size(u16 total; next instr at +size),
  param_mask(u16), rank_mask(u8), param_count(u8), zero(u32), data[]
  ```
  Arg bytes = `size − 16`; the walker advances by `size`. `param_mask` is one bit
  per parameter (set = stack/var ref, clear = literal). From TH13 on the trailing
  `zero` field becomes the stack-reference count.

Python struct formats: use explicit little-endian style like `<4sHHII` — bare
`HS` mixes are invalid (`struct.error: bad char in struct format`).

---

## 8. Reading the disassembly

### 8.1 Rank masks (the `!E !N !H !L !*` prefixes)
Each line may carry a difficulty gate. **The label lists the INCLUDED ranks** —
`!EN` means "E and N run this", `!HL` means "H and L run this".

- **EoSD** `diffmask` (u8): `0xFF`=all, `0x02`=!N, `0x04`=!H, `0x08`=!L, `0x0E`=!*.
- **MoF** `rank_mask` (u8), bits `1111LHNE` (E=0x01, N=0x02, H=0x04, L=0x08,
  upper nibble always 1). Value = `0xF0 | (OR of included rank bits)`:
  `!*`=0xFF, `!E`=0xF1, `!N`=0xF2, `!H`=0xF4, `!L`=0xF8, `!EN`=0xF3,
  `!NH`=0xF6, `!HL`=0xFC, `!NHL`=0xFE. An instruction runs when
  `(rank_mask & current_rank_bit) != 0`.

Verified against MoF card 1's banners: `!EN`→Ooze Flooding (E/N), `!H`→Deluvial
Mare (H), `!L`→Trauma… (L) — exactly the real per-difficulty card names.

**Map the game's difficulty → our game:**
- our **Normal** → the game's **N** value (and any `!EN` line, since E/N share it)
- our **Lunatic** → the game's **H/L** value (use H, or the distinct L line if the
  card has a separate Lunatic pattern — MoF card 3 does: see §14.2).

When a construct has separate `!E/!N/!H/!L` lines, each carries its own
counts/speeds — take the N line for Normal and the H/L line for Lunatic. Don't
hand-tune Lunatic separately: `scalePhase` multiplies `speedMul`/`densityMul` per
difficulty.

### 8.2 Variable references
Negative integer args are variable refs, not literals.

- **EoSD:** `-10005…-10010` are the common ones; `-1` means `-1.0f`. Resolved via
  `ecl_get_var`/`ecl_get_float`. A value that changes per shot (accelerating
  speed, sweeping angle) is a var ref updated by a sibling instruction nearby.
- **MoF:** the high-negative globals are shared per-enemy state. Confirmed
  meanings: `[-9999]` = own facing/orientation angle; `[-9998]` = **angle to the
  player**; `[-9989]` = a stored base angle; `[-9981]`/`[-9980]`/`[-9979]` = local
  angle accumulators. `%A`/`%B`/… are float locals, `$A`/`$B`/… are int locals
  (declared `var A, B;`). `ins_356(%v, e, n, h, l)` selects a per-rank float;
  `ins_355($v, e, n, h, l)` selects a per-rank int. `ins_81` =
  `POLAR_TO_CARTESIAN`, `ins_82` = `NORMALIZE_ANGLE`, `ins_83` = `SUBTRACT_TIME`
  (a wait on the frame clock), `ins_50` = `ADD_INT`, `ins_43` = `STORE_INT`.

### 8.3 Opcode decoding
`ins_NNN(...)` where NNN is the **decimal opcode**.
- **EoSD:** shoot `0x43`–`0x4b` (`ins_67`…`ins_75`, aim_mode = opcode − 0x43),
  lasers `0x55`/`0x56` (+ `0x57`–`0x5a` handle ops), auto-refire `0x4c`/`0x4d`.
  Authority: `run_ecl_decompiled.cpp`.
- **MoF:** VM core `0x00`–`0x57` (authority: `EclVm.cpp`); enemy/pattern/laser
  ops `0x100`–`0x1B4` (authority: `EnemyEclDispatcher.cpp`). Key ones:
  `ins_334`=SET_INTERRUPT (starts a spell card / routes to a sub), `ins_347`=life
  marker, `ins_344`=SET_CHAPTER, `ins_357/359/342`=card-name banner (E+N / H / L),
  `ins_360`=SET_SPELL_TIMEOUT, `ins_257`=spawn sub at `(x, y, w, h, …)`,
  `ins_256`=spawn named effect, `ins_292`=wait/move helper, `ins_322/320/321`=
  hitbox sizing, `ins_281/284/285`=position/polar/motion interp, `ins_335`=invuln
  timer, `ins_336`=timer scale, `ins_21`=STOP_ALL_THREADS, `ins_17`=STOP_THREAD,
  `ins_1`=TERMINATE.

---

## 9. Core constructs

### 9.1 EoSD shoot (`0x43`–`0x4b`)
Disasm arg order: `(sprite, count_1, count_2, speed_1, speed_2, angle_1,
angle_2, flags, sfx)`. **`aim_mode = opcode − 0x43`** (modes 0–8).

Semantics (verified in `shoot_bullets` / `shoot_one_bullet`):
- **`count_2` = outer loop (rows), `count_1` = inner (bullets per row).**
  ⚠️ Easy to transpose — the #1 bug (§12).
- **Per-row speed peel:** row `i` of `count_2` fires at
  `speed_1 − (speed_1−speed_2)·(i/count_2)` — a "comet fan" of stretched speed
  lines from `speed_1` down to `speed_2`.
- Counts/speeds are rank-scaled at runtime (`bullet_rank_amount`/`bullet_rank_speed`
  low/high × rank). The per-rank lines carry the base literals.
- **Aim modes** (get these right):
  - **Mode 0** (`0x43`): aimed fan **centered on the player** (+ `angle_1`).
    Odd `count_1` puts one bullet dead-center.
  - **Modes 2→3** (`0x45`/`0x46`, fall through): `count_1` rays spanning **90°
    starting AT the aim line** (first ray dead on the player), each row peeling in
    speed. `angle_2` is the per-ray step, `angle_1` a base offset.
  - Modes 6/7/8: random variants.

### 9.2 EoSD laser (`0x55`/`0x56`)
Disasm arg order: `(sprite, color, angle, speed, start_offset, end_offset,
start_length, width, start_time, duration, stop_time, graze_delay, graze_distance,
flags)`.
- **`0x55` → type 1 (thick, absolute angle).** **`0x56` → type 0 (thin, angle
  relative to the player)** — `shoot_lasers` adds `angle_to_player` for type 0.
- Lasers are rays FROM the shooter: position = enemy pos + shoot_offset,
  `start_offset` (usually 0) to `end_offset`, length `start_length`. **Not**
  full-field columns. When porting to our `beams[]`, anchor at the boss
  (`y0` = boss y, `pivot:'top'`) — see §12.
- `0x57` stores the laser into a handle; `0x58` rotates by Δ; `0x59` aims at
  player + Δ; `0x5a` repositions. Sweeping beam = fire once (`0x55`) then
  repeatedly `0x58`-rotate on a timer.

### 9.3 EoSD auto-refire (`0x4c`/`0x4d` = `ins_76`/`ins_77`)
`shoot_interval` makes the enemy keep firing its last `bullet_data` every N
frames until changed (loop at L196–217). A shoot followed by `ins_77(N)` repeats
every N frames. In our engine: an emitter with `interval` + `repeat: -1` (or a
`period` if the block is finite and loops).

### 9.4 MoF pattern-slot system (`ins_4xx`, opcodes 0x190–0x1AB)
MoF has **no per-shot `shoot` opcode**. Instead each enemy owns a bank of
**bullet-pattern slots** (0x210 bytes each at `runtimeAddress + slot*0x210`),
configured with setters and fired with `FIRE_PATTERN`. The setters map 1:1 onto
the EoSD shoot fields:

| Opcode | Mnemonic | Args | Sets |
| --- | --- | --- | --- |
| `ins_400` | INIT_PATTERN | `(slot)` | reset the slot |
| `ins_401` | FIRE_PATTERN | `(slot)` | fire the configured volley |
| `ins_402` | SET_SPRITES | `(slot, sprite, sub)` | bullet sprite |
| `ins_403` | SET_OFFSET | `(slot, x, y)` | spawn offset from boss |
| `ins_404` | SET_ANGLE | `(slot, a1, a2)` | `angle_1` (base), `angle_2` (per-bullet step/spread) |
| `ins_405` | SET_SPEED | `(slot, s1, s2)` | `speed_1` (launch), `speed_2` (terminal/retention target) |
| `ins_406` | SET_COUNT | `(slot, c1, c2)` | `count_1` (bullets/rays), `count_2` (rows) |
| `ins_407` | SET_AIM_MODE | `(slot, mode)` | aim mode (below) |
| `ins_408` | SET_SOUND | `(slot, …)` | sfx |
| `ins_409` | SET_EXTRA | `(slot, idx, flag, type, x, y, vx, vy)` | per-bullet override for bullet `idx` |
| `ins_411` | (laser link) | `(slot, …)` | attach a laser to a slot |
| `ins_412` | FIRE_LASER_A | `(slot, count, angle, speed, ?, len, ?, ?)` | fire a laser volley from the slot |
| `ins_413` | straight laser | `(slot, …)` | single straight laser |
| `ins_414`–`419` | laser offset/angle/speed/count/aim/sound | | laser modifiers |
| `ins_420` | CANCEL_BULLET_PATTERN | `(len)` | cancel-all-bullets family |
| `ins_421` | CLEAR | `(len)` | clear patterns |

**Aim modes** (`ins_407`), inferred from usage across `stage03`:
- **Mode 0** — symmetric ring/fan centered on `angle_1` (a full 360° ring when
  `count_1` is large; used for ring barrages).
- **Mode 1** — fixed-angle stream/fan at explicit `angle_1` (spread `angle_2`),
  **not** player-aimed (used for rotating streams at screen angles like `PI/2`).
- **Mode 3** — **player-aimed** fan: `count_1` bullets centered on the player
  direction (`angle_1` = `[-9998]`), spread by `angle_2` (used for aimed barrages).

**`ins_409` per-bullet extras** (the `type` field): `1`/`2`/`4`/`8` mark special
bullets (e.g. a large "parent" bullet that sheds children); `16` = timed release;
`32` = curving bullet with turn `vy`; `64` = a second property; **`8192`** =
curving droplet (turn ≈ ±0.01308997 rad/frame ≈ 0.75°/frame); `32768` = a
large/hazard bullet. Negative `-999999` args mean "unused/inherit".

---

## 10. Step-by-step process (any game)

1. **Extract** the stage ECL from the game archive (§3).
2. **Disassemble** (§4): `thecl -d <ver> -j` for MoF; Python walk for EoSD.
3. **Identify the boss** container sub and its card chain (§5).
4. **Verify the spells** — banners vs official list, per-difficulty variants,
   order/count, character/stage agreement (§6). Record the verified card table.
5. **For each spell**, read its container sub + the barrage subs it chains to.
   Decode every construct: EoSD shoot/laser (opcode → aim mode, `count_1`/
   `count_2`, speeds, angles) or MoF pattern-slot sequence (the `ins_4xx` setters
   + `FIRE_PATTERN` cadence), plus rank masks, var refs, and any auto-refire /
   `SUBTRACT_TIME` waits.
6. **Choose the difficulty values**: Normal ← N-rank line; Lunatic ← H/L-rank
   line. Don't hand-tune Lunatic separately — `scalePhase` applies the multipliers.
7. **Translate to engine emits** (table in §11). Use `period` + `repeat` to loop
   a finite repeating block (spell bodies are repeating cycles). Author at Normal.
8. **Add non-spell phase(s)** so the phase-count test passes: **Normal ≥ 3 phases,
   Lunatic ≥ 4** (`test-bosses.js`). Fights open with a non-spell swarm — mine the
   `BossN_at` interlude subs (single falling streams, per-rank aimed fans) for it.
9. **Verify** (§13): `node test-bosses.js`, then headless probes + playtest.

---

## 11. Construct → engine emit

| Original construct | Engine emit | Notes |
| --- | --- | --- |
| Mode-0 aimed fan (odd `count_1`) | `fan` with odd `count`, `spread` = total span | One bullet on the aim line. |
| Mode-2/3 comet fan (`count_1` rays × `count_2` rows, speed peel) | `fanVolley` with `count`=rays, `rows`=count_2, `spread`=π/2, `speed`/`speed2` | First ray dead on player; `center:true` to re-center. |
| Single aimed stream (MoF mode 3 / EoSD mode 0, `count_1`=1) | `aimed` with `count:1` | Add `angleStep` for a swinging aim. |
| Ring aligned to player | `ring` with `aimRing:true` | One bullet dead on player. |
| Rotating ring | `ring` + `rotStep` | Offset per fire. |
| Spiral | `spiral` | |
| Thick/thin laser (EoSD `0x55`/`0x56`) | phase-level `beams[]` | Anchor at boss: `y0`=boss y, `pivot:'top'`. Sweep with `sweep` (rad/s) + `dur`/`period`. |
| MoF `ins_412` laser volley (rotating dual lasers) | two `laser` emitters with opposing `angleStep`, or `beams[]` | Counter-rotating beams. |
| Sweeping beam (fire + rotate) | `beams[]` with `sweep` | |
| Repeating barrage block | emitter with `period` + `repeat` | `period` re-arms the cycle; per-fire evolution restarts each cycle. |
| Accelerating stream (var speed) | `speedStep` | Adds speed per fire. |
| Swinging aim (var angle) | `angleStep` | Adds radians per fire. |
| Color-cycling field (EoSD `ins_118`) | `colors:[…]` + `colorStep` | Global phase clock; all bullets share a color per step. |
| Curving droplets (MoF `ins_409` flag 8192) | `curve` emitter | Expanding spiral around the spawn point. |
| Side shooters at fixed offsets (MoF `ins_257` at ±x) | `gap` with `inner:'aimed'`/`'curve'` at `xn` | Emit from an arbitrary point, aim at the player. |
| Tidal wall with a shifting gap (MoF Card 2) | `wall` with `side`, `gapSize`, `gapPosStep` | Bullets enter from an edge, sweep across, one moving hole. |
| Falling columns (MoF Card 2 side streams) | `column` with `xs`/`xn` | Neat vertical streams from the top edge. |

Odd counts for `aimed`/`fan` (one bullet on the aim line — even counts let the
player camp center). No `Math.random` in emits (determinism, engine doc §3).

---

## 12. Gotchas (bugs actually hit while porting)

- **Transposed `count_1`/`count_2`.** Moonlight Ray's `ins_69(…,42,1,…)` is
  **42 rays × 1 row**, not "6 rays × 36 rows". Always check which count is the
  ray count vs the row count against `shoot_bullets` (outer=count_2,
  inner=count_1).
- **Boss-anchored rays.** Lasers originate at the shooter and extend past the
  screen edge. `beams[]` entries are one-way rays: set `y0` + `pivot:'top'` so
  the ray is anchored at the boss and extends forward only — never backwards
  behind the shooter (length isn't configurable — the ray always reaches the
  screen edge). Sweeping, non-aimed beams are solid immediately; set `warn`
  (seconds) only on beams that aim at the player. Separately, `type:'laser'`
  EMITTERS telegraph by default — a thin harmless line for the first 1.5s
  (`em.warn` to change) before growing to full width — and stretch to the screen
  edge when `laserLen` is omitted.
- **Even counts leave the aim line open.** Use odd `count` for aimed/fan.
- **Phase-count test.** Normal needs ≥3, Lunatic ≥4. If you only port the spells,
  add a non-spell opener (and the Lunatic-only last card) to hit the bar.
- **Don't hand-tune Lunatic.** Author Normal; `scalePhase` applies the ×1.2 speed
  / ×1.35 density multipliers.
- **Absolute `em.angle` ignores `em.angleOffset`.** In `_emitAt` the aim line
  (and any offset on it) is only consulted when `em.angle === undefined`. For a
  player-aimed fan with a fixed swing use `angleOffset` WITHOUT `angle`; for a
  fixed screen-angle sweep, bake the start angle into `em.angle` itself. (The
  Nitori Pororoca spouts originally had `angle: PI/2` + `angleOffset: ±PI/4` and
  silently swept from straight-down instead of starting at 135°.)
- **Variable refs read as literals.** A negative arg is a ref, not a number; find
  the instruction that updates it.
- **Bullet cap.** Keep concurrent bullets well under ~1200; if a volley is too
  dense, halve rows/rays and rely on `densityMul`/Lunatic scaling.
- **Wrong boss attribution.** Confirm a stage's boss by its spell banners, not by
  file position (this doc originally mislabeled EoSD `ecldata2` as Nitori — it's
  Cirno; Nitori is a MoF boss).
- **`thecl` without `-j`.** Output is raw Shift-JIS (CP932) and fails UTF-8 reads.
  Always pass `-j` and write to the workspace (`/tmp` is not shared between bash
  calls).
- **thdat missing library.** `thdat`/`thecl` need `libthtk.so.1` — set
  `LD_LIBRARY_PATH=thtk2026-09-15/lib` or they fail to load.
- **Python struct formats.** Use explicit little-endian styles like `<4sHHII`;
  mixed `HS`-style formats raise `struct.error: bad char in struct format`.

---

## 13. Verification

1. **`node test-bosses.js`** — must pass (phase counts, valid fields,
   `getPhases` consistency, kaguya noBombs).
2. **Headless probe** (reuse the harness in `tmp-nitori-density.js` /
   `test-balance.js`): run a real `DanmakuEngine` fight with a stationary
   immortal player, log per-card `lasted` / `minDist` / `hits`, and track
   **max concurrent bullets** and **per-volley birth counts**. Sanity checks:
   - volley size matches the intended ray×row count,
   - aim-relative span matches (mode-2/3 → [0°, 90°] from the aim line),
   - `minDist` is small (bullets actually threaten the player),
   - max concurrent bullets stays under the cap.
3. **Beam geometry check**: call `_beamAngle`/`_beamGeom`/`_beamDist` at a
   mid-sweep time; confirm the pivot is at the boss (dist 0) and the sweep rate
   is right. For `type:'laser'` emitters, also confirm the telegraph: no
   damage/graze during the first `warn` seconds, full damage after.
4. **Determinism check** (`tmp-nitori-determinism.js`): two identical runs produce
   identical bullet trajectories (no hidden randomness).
5. **Browser playtest** (engine doc §7.4) — feel-check the card.

---

## 14. Worked examples

### 14.1 Rumia "Moonlight Ray" (EoSD, stage 1, Sub9)
Disasm:
```
!*  ins_69(0, 6, 42, 1, 2.5f, 0.0f, 0.0f, 0.0f, 4)   // H: 42 rays, 1 row, speed 2.5
!L  ins_69(0, 6, 48, 1, 2.8f, 0.0f, 0.0f, 0.0f, 4)   // L: 48 rays, 1 row, speed 2.8
...
    ins_85(0, 6, 0.3926991f, ...)   // 0x55 thick laser, abs angle 22.5° from horiz
    ins_88(...)                     // 0x58 rotate by ±0.00827 rad/frame
```
Decode:
- `ins_69` = `0x45` = aim_mode **2** → 90° fan starting at the aim line.
  `count_1`=42 (rays), `count_2`=1 (row), `speed_1`=2.5. So **42-way 90° fan,
  first bullet dead on the player.** (Not 6×36.)
- H line → Normal base (42 @ 2.5); L line approximated by Lunatic's ×1.35 / ×1.2.
- `ins_85`+`ins_88` = thick beam anchored at the boss sweeping toward vertical.

Emitted (`bosses.js`):
```js
const RUMIA_MOONLIGHT = [
  { t: 0.5, type: 'fanVolley', count: 42, spread: Math.PI / 2, rows: 1,
    speed: 2.5, life: 240, interval: 0.667, repeat: -1,
    color: '#fff8d0', coreColor: '#ffffff', shape: 'circle', r: 4 },
];
// + phase.beams: two boss-anchored rays (y0=90, pivot:'top'),
//   angle ±1.1781, sweep ∓0.496 rad/s, dur 2 / period 3.
```
Verified headlessly: 57 bullets/volley (42·1.35 Lunatic), aim-relative span
exactly [0°, 90°], beam root at boss, correct sweep rate.

### 14.2 Nitori (MoF, stage 3, `stage03.ecl`)
Final-boss subs: `Boss` (setup: bounds 0/96/280/64, life 8800) → `Boss1/2/3`
(spell controllers, `ins_334` timeout 3600 each) → `BossDead`. `BossN_at`/`_at2`
are the non-spell interludes. `MBoss*` is a **separate midboss** (its own
Optical/Hydro Camouflage card) — not part of the Nitori final fight.

Spell cards (banners verified in the disasm, §6):
| Card | E/N | H | L |
| --- | --- | --- | --- |
| 1 | 洪水「ウーズフラッディング」 Ooze Flooding | 洪水「デリューヴィアルメア」 Deluvial Mare | 漂溺「光り輝く水底のトラウマ」 Trauma of the Glowing Seafloor |
| 2 | 水符「河童のポロロッカ」 Kappa's Pororoca | 水符「河童のフラッシュフラッド」 Kappa's Flash Flood | 水符「河童の幻想大瀑布」 Kappa's Fantasy Waterfall |
| 3 | 河童「お化けキューカンバー」 Monster Cucumber | 河童「のびーるアーム」 Stretching Arm | 河童「スピン・ザ・セファリックプレート」 Spin the Cephalic Plate |

Pattern mining (pattern-slot opcodes, §9.4):
- **Non-spell** (`Boss2_at`/`Boss2_at2`): three single-shot streams at screen
  angles `PI/2`, `−PI/3`, `−2PI/3` (aim mode 1, speed 2.0/2.5/3.5/3.5 by rank)
  that ping-pong-rotate, plus a 5-way symmetric fan (aim mode 0, speed 1.6).
- **Card 1 — Ooze Flooding** (`BossCard1` + `BossCard1At/H/H2`): two side
  shooters at ±208px firing slow player-aimed streams (aim mode 3, speed 1.3,
  15 shots @ 20f); H/L add **curving droplets** (`ins_409` flag 8192,
  ±0.01308997 rad/frame). A central 9-way ring (aim mode 0, speed 2.0) fires in
  bursts.
- **Card 2 — Kappa's Pororoca** (`BossCard2` + `Boss2Et_at2`): 6–7 wave-emitters
  along the top (x = ±160/±96/±32 or ±128/0), each a single downward stream
  (aim mode 1, base `PI/2`) whose angle sweeps 135°→45° and back — a tidal-bore
  wall of falling water. H/L add curving bullets.
- **Card 3 — Monster Cucumber** (`BossCard3` + `BossCard3_at`): a player-aimed
  16/32-way ring (aim mode 3, `angle_1=[-9998]`, spread 11.25°, speed 2.5, 2
  rows) every 120f, plus **two counter-rotating 9-way laser volleys**
  (`ins_412`, EN speed 2.8 / HL 4.0) sweeping around the boss.
- **Card 3L — Spin the Cephalic Plate** (`BossCard3L` + `_at/_at2`): a dense
  56-way player-aimed volley (aim mode 3, speed peels 4.0→1.0 over 3 shots) that
  **spins** (angle `[±0.008727]` alternating), with curving bullets, plus a
  slowly rotating thin ring (`ins_404` `[-9998]/16`).

Emitted (`bosses.js`, the `nitori:` block + top-level `NITORI_*` arrays): one
shared pattern array per card, Normal-authored, Lunatic scaled by `scalePhase`.
Phases (house rule: 25s cards, odd aimed counts, no `Math.random`):
- **Normal** (4): Water Stream (non-spell, hp100) → Flood "Ooze Flooding"
  (hp120) → Water Sign "Kappa's Pororoca" (hp130) → Kappa "Monster Cucumber"
  (hp140).
- **Lunatic** (4): same opener + cards 1–2 take their Hard names (Deluvial
  Mare / Flash Flood, hp140/150) and the last card is the distinct rank-L
  design, Kappa "Spin the Cephalic Plate" (hp160) — matching MoF where L runs
  `BossCard3L` instead of `BossCard3`.

Construct → emitter mapping used (all existing emitters, no new engine code):
- Non-spell streams → `aimed` count-1 with per-fire `angleStep` ping-pong
  (`repeat`+`period` re-arm); 5-way fan → `fan`.
- Ooze side shooters → `gap` at xn 0.067/0.933 with `inner:'aimed'` (player-
  aimed slow drip); central bursts → `fan` count 9.
- Pororoca spouts → `gap` near the top edge with `inner:'aimed'`, sweep baked
  into absolute `angle` (3π/4 out, π/4 back, `angleStep` ±0.049087, 32 shots,
  `period` 6.4s) — 5 spouts (original has 6–7) to stay under the bullet cap.
- Monster Cucumber rolling barrage → `fanVolley` (32 rays × 2 rows, speed peel
  2.5→1.0); counter-rotating laser volleys → fast 9-way `fan` with ±`angleStep`
  (no laser telegraph needed at this density).
- Spin the Cephalic Plate → dense 56-way `fan` with per-fire `angleStep` spin
  and `speedStep` peel; thin drift → `aimed`; droplets → `curve`.

Verified: `node test-bosses.js` 396/0, `tmp-nitori-determinism.js` 10/0
(spout geometry + repeat/period re-arm through the real fire path),
`tmp-nitori-density.js` max concurrent bullets 435 (normal) / 393 (lunatic),
`tmp-engine-test2.js` 92/0.

### 14.3 Yukari (EoSD, stage 7, `ecldata7.ecl`)
Phantasm Stage boss. All 13 spell-card banners live in `ecldata7_utf8.txt`
(Sub22/23/24/33/36/39/44/48/50/54/57/60/68). The boss container is Sub16→Sub17
(intro) → Sub18/19 (barrage controllers) → Sub20/21 (death). The remaining
cards are scheduled by the barrage subs (Sub32/35/38/43/47/49/53/56/59) via
`ins_115`/`ins_116` (spell-card timeout + sub).

Spell cards used in this port (6 of 13, most visually distinctive):
| Card | ECL sub | Key constructs |
| --- | --- | --- |
| Moon Sign "Silent Serena" | Sub22 | random-angle slow rings (ins_75 2×6, speed 0), aimed 8-way fan (ins_68 2×8, speed 2.7→2.0, angle −π/2) |
| Sun Sign "Royal Flare" | Sub23 | rotating stream pairs (ins_68 1×2, speed 0, angle offset 0.52/1.05), escalating ring bursts (ins_121 13,3/5/6) |
| Fire-Water-Wood-Metal-Earth "Philosopher's Stone" | Sub24 | five sub-entities (Sub25–29) each firing a different pattern: ring (ins_70 2×10), aimed (ins_67 6×11), spiral (ins_75 10×10), ray (ins_70 16), aimed (ins_75 13) |
| Forbidden "Kagome Kagome" | Sub44 | spawning gap-traps (ins_95 Sub45 ×15) that fire 9-bullet rings (ins_68 1×9) + aimed 3-way fans (ins_67 9×3, speed 3.6, angle ±0.785) |
| Forbidden "Cranberry Trap" | Sub33 | wandering traps (ins_95 Sub34 ×10) that dash and fire aimed streams (ins_67 3×6 / ins_68 1×4) |
| QED "Ripples of 495 Years" | Sub68 | massive 88-bullet ring (ins_70 6×88, speed 1→var, angle random ±π), two counter-rotating waves (ins_121 16,0/1) |

Barrage subs (shared non-spell pattern):
```
ins_70(2, 2|6, 64|32, 2|3, 2.0|2.5|3.5, 1.0, -10005, 0, 513)
ins_76(30|60)          // refire every 30–60f
ins_9(-10005, π, -π)   // randomize aim angle each cycle
ins_50(-π, π)          // ±π range
```
= 64/32-ray ring, speed 2–3.5, refired with per-cycle angle jitter.
Translated as a rotating ring with `rotStep`.

Emitted (`bosses.js`, the `yukari:` block): Normal-authored, Lunatic scaled
by `scalePhase`. Phases:
- **Normal** (5): Non-spell (hp130) → Silent Serena (hp150) → Royal Flare
  (hp160) → Philosopher's Stone (hp170) → Ripples of 495 Years (hp200, noBombs).
- **Lunatic** (6): same opener + Silent Serena/Royal Flare/Philosopher's Stone
  (hp170/180/190) + Kagome Kagome (hp200) + Ripples of 495 Years (hp220,
  noBombs).

Construct → emitter mapping:
- Barrage rings → `ring` count 32/24, `rotStep` ±0.03–0.05, refire 0.8–1.2s.
- Silent Serena slow rings → `ring` count 12, speed 1.0, `rotStep` 0.02.
- Silent Serena aimed fan → `aimed` count 9, spread 0.52, angle −π/2,
  `angleOffset` 0.26.
- Royal Flare rotating streams → `point` count 1, `angleStep` ±0.052,
  counter-rotating pair.
- Royal Flare sweeping fans → `fan` count 5, spread 1.05, `angleStep` ±0.04.
- Philosopher's Stone five elements → five distinct emitters: `ring` 10,
  `aimed` 11, `spiral` arms 10, `ring` 16, `aimed` 13.
- Kagome Kagome trap rings → `ring` count 9, `rotStep` 0.08; aimed 3-way
  fans → `aimed` count 3 at three 45° offsets.
- Ripples 88-ring → `ring` count 44, `rotStep` 0.02, color-cycled;
  counter-wave → second `ring` with `rot: π/44`, opposite `rotStep`.

Verified: `node tests/test-bosses.js` 408/0, `tests/tmp-engine-test2.js` 92/0,
density probe max 550 (normal) / 632 (lunatic) concurrent bullets
(Philosopher's Stone peak), determinism PASS (171 bullets compared, 300 frames).
