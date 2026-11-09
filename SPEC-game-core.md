# Spec: game-core

Module id: `game-core` · Path: `src/core/` · Depends on: nothing · Root spec: [SPEC.md](SPEC.md)

## Objective

The whole game as a pure function of `(seed, input log)`, with two guarantees everything else rests on:

- **Replay:** the same seed and the same per-tick inputs produce bit-identical state on every tick, in every engine (Node, Chromium, Firefox, WebKit, workerd).
- **Lane identity:** the same seed produces the same lane (every rat, gate and boss, at the same place in distance) **whatever the player does**.

Consumers:
- `client` renders it and verifies ghosts.
- `balance-sim` runs it headless.
- `ghost-api` uses its payload validator.

## Failure modes (tests are written against these first)

| # | Failure | What the player sees | Guard → test |
|---|---|---|---|
| F1 | Same seed + inputs → different state (engine float differences, ordering, hidden clock/random) | Ghost walks through rats | Determinism contract → T-replay, T-repeat, cross-engine e2e |
| F2 | Player behaviour changes the lane (RNG draws or positions depend on play, e.g. how long a boss took) | Friend's "same seed" lane differs | Rigid lane, per-segment RNG, overshoot-exact spawns, empty screen at boss → T-lane, T-warning |
| F3 | No passable corridor, or one the cat can't reach in time | Unavoidable hit | Corridor + free-window rule → T-corridor, T-config |
| F4 | Gates scroll past too fast to read | "What did I pick?" | Readability invariant → T-config |
| F5 | Pure-buff gate, or a DPS-only trade | Non-choice | Trade-off rule → T-gates |
| F6 | Boss readout lies | Unfair loss | Readout = `simulateBossFight` of the real fight code; at spawn, cooldown resets and in-flight projectiles are removed → T-boss-reset, T-S4, T-S4-gate (balance-sim) |
| F7 | Gate triggers twice or never | Double buff or missed gate | Crossing rule → T-once |
| F8 | Stats explode or collapse; NaN from yarn retarget | Frozen game | Clamps, zero-vector rule → T-clamps |
| F9 | Malformed ghost data hangs or crashes the decoder | Title freezes on a bad link | Strict canonical codec → T-codec |
| F10 | Weapon gate offers the held weapon | Dead gate | Pre-drawn fallback stat gate → T-gates |
| F11 | Behaviour change without a `CORE_VERSION` bump | Stored ghosts desync silently | Golden fixture → T-golden |
| F12 | Stats change after `bossWarning` | Stale readout | Clear zone by crossing distance → T-config, T-warning |
| F13 | Ghost re-simulation differs from what was recorded | Wrong ghost shown | Payload `score` + `ticks`; client pre-simulates (SPEC-client C9) → T-replay asserts `ended` tick and score |
| F14 | Projectile and rat pass each other inside one tick | Visible misses | Speed bound → T-config |
| F15 | A gate arrives with rats close enough to hit the cat as it passes (gates guarded by rats, an idea-doc Not Doing) | Forced hit to take a gate | Rigid lane + gate/rat clearance invariant → T-config |

## Determinism contract

1. **Fixed tick.** One `step()` is 1/60 s and consumes exactly one input level. No real time enters core.
2. **Numeric whitelist.** Numeric work uses only these:
   - Operators: `+ - * / %`, comparisons, `>>> >> << | & ^`.
   - Functions: `Math.floor`, `ceil`, `round`, `trunc`, `abs`, `min`, `max`, `sign`, `imul`.

   These are exact on IEEE-754 doubles, and JS has no fused multiply-add. ECMA-262 §21.3.2 marks `sin`, `cos`, `atan2`, `exp` and `log` as *implementation-approximated*, and `pow` / `**` are approximated too. `sqrt` is not: the spec defines it as 𝔽(the square root of ℝ(n)), which is exact. It's banned anyway, because nothing in core needs it and a small whitelist is easier to lint. Hence spread is velocity offsets and yarn uses the max-norm.
3. **Strings.** String operations (`charCodeAt`, concatenation) are allowed. `Number#toString` of **integers** (as in RNG keys like `seed + ":" + k`) is exact and allowed. It's never used on non-integers or for hashing, since ECMA-262 lets the last digit of non-integer output vary. `hashState` hashes the raw IEEE-754 bytes of each number (`DataView.setFloat64`, little-endian).
4. **No hidden inputs.** No `Math.random`, `Date`, `performance`, `crypto`, timers or globals. `tsconfig.core.json` has `lib: ["ES2022"]` with no DOM, and lint enforces the rest: `no-restricted-properties` for the banned `Math` members, `no-restricted-globals` for `Date`, `performance`, `crypto` and timers, and `no-restricted-syntax` for the `**` operator (`BinaryExpression[operator='**']`, `AssignmentExpression[operator='**=']`).
5. **Ordered iteration.** Arrays are kept sorted by id. Removal uses an order-preserving filter. Comparators are total and end in id. Logic never iterates object keys.
6. **Two id spaces.**
   - **Lane ids** come from content: `laneId = k × 64 + i`, where `i` is the index within segment k (gate pair `i = 0`, rats `1..63`). They never depend on play.
   - **Player ids** (projectiles) come from a run-local counter.
7. **Events are output only.** `step()` returns that tick's events; core never reads them back.
8. **`CORE_VERSION`** (an integer, starting at 1, in `version.ts`) bumps on any behaviour or `config.ts` change. Ghosts carry it, and a mismatch is refused.

## Units, anchors and motion

- **World:** `widthU` 540 × `heightU` 960, y down. **All x/y are entity centres**, and every AABB is centred on its entity. The cat's centre is at `catLineY` 880, so its top edge is at `catTopY = catLineY − cat.heightU / 2`.
- **Distance:** `distanceU` (world units) accumulates scroll; `distanceM = distanceU / 10`.
- **Scroll:** `min(scroll.maxUPerTick, scroll.baseUPerTick + scroll.rampPerM × distanceM)` outside a boss fight, 0 during one.
- **Rigid lane:** rats and gates store `baseY = spawnYU − dy − k × segU` at spawn, and in step 5 their position is **recomputed** as `y = baseY + distanceU` (not accumulated with `y += scroll`, which drifts in floating point). Rats don't walk. So the lane is a fixed picture in distance space, and its geometry (gaps, gate clearance, the empty screen at a boss) is exact arithmetic on `config`.
- **Projectiles:** `x += vx; y += vy`, with `vy = −weapon.speedU` at fire, unaffected by scroll. Yarn may change both components.
- **Boss:** `y += boss.speedUPerTick`.
- **Hit-stop:** while `freezeTicks > 0`, a tick consumes its input, increments `tick`, decrements `freezeTicks` and changes nothing else.

## Lane generation (F2, F3, F12, F15)

**Segments.** Segment `k ≥ 0` covers distance `[k × segU, (k + 1) × segU)`, with `segU = lane.segmentM × 10`. Its content is `generateSegment(seed, k)`, a pure function of `(seed, k, config)`. It uses its own RNG `sfc32(cyrb128(seed + ":" + k))` and the two corridor anchors (below), nothing else.

**RNG conventions.** `rng()` returns a value in `[0, 1)`.
- Uniform integer in `[0, n)`: `floor(rng() × n)`.
- Uniform real in `[a, b)`: `a + (b − a) × rng()`.
- Bernoulli(p): `rng() < p`.
- Weighted choice: walk the weights in their listed order and pick the first whose cumulative weight exceeds `rng() × total`.

**Draw order** (fixed; any change bumps `CORE_VERSION`). Fixed kinds (boss, clear zone, warm-up, gate mark) take no kind draw.
- **Boss segment:** draw 1 is boss x.
- **Gate segment:** draws follow the gate list under Rules.
- **Other segments:** draw 1 is the empty roll; if not empty, draw 2 is the formation choice, then that formation's draws in the order its row describes.

**Spawn.** Distance advances in step 5, and lane entities' `y = baseY + distanceU` is recomputed there. In step 9, `while (distanceU ≥ nextSegmentK × segU)` spawns segment `nextSegmentK` and increments it. At start values `scroll.max < segU`, so it's at most one per tick, but `while` keeps it correct for any tuning. Its entities get `baseY` and an initial `y = baseY + distanceU`, the same formula, so a new entity sits exactly where the lane says, whatever tick the crossing fell on. Gate crossing compares `baseY + prevDistanceU` with `baseY + distanceU`.

**Band.** Rat centres use `dy ∈ [0, lane.bandU − rat.sizeU]`. Rats occupy only the lower `bandU` of the segment, so between bands there's a rat-free strip of `segU − bandU` (100 U at start values).

**Marks** (n ≥ 1; nothing at distance 0):
- Boss `B = n × boss.everyM`.
- Gate marks at `n × gates.everyM`.
- **Clear zone of B:** segments starting in `[B − boss.clearM, B + lane.segmentM)` spawn nothing. That includes the boss segment itself, apart from the boss.
- **Warm-up:** segments starting in `[0, lane.warmupM)` spawn nothing.

**Content precedence:**
1. Boss segment → boss only.
2. Clear zone or warm-up → empty.
3. Gate mark → one gate pair at `dy = gates.dyU`, no rats.
4. **Gate buffer:** the segments directly before and after a gate segment that actually spawns a gate (k − 1, k + 1) are empty. A gate mark suppressed by a clear zone creates no buffers. That gives the cat time to cross the full width to either half, and back to the next corridor (F15, lateral).
5. Otherwise → empty with probability `lane.emptyChance(d) = max(0.1, 0.4 − d/2000)` (d = segment start in m); else one formation from `lane.formationWeights` (column 0.4, swarm 0.4, wall 0.2).

**Formations.** A rat is **in the corridor** if `|x − cx(k)| < corridorHalfU + rat.sizeU / 2`. Such positions are never used.

| Formation | Placement |
|---|---|
| `column` | `n = min(4, 3 + floor(d/500))` rats at one x, dy = 0, 34, 68, …. x uniform in `[rat.sizeU/2, widthU − rat.sizeU/2]`; up to 8 draws to find an x not in the corridor, else the segment is empty. |
| `wall` | One row at a uniform dy; slots at x = 17 + 34i for i = 0..14 (15 slots; the last at 493, so every rat stays inside the world), skipping any in the corridor. |
| `swarm` | `n = min(10, 4 + floor(d/300))` rats, each drawn as x (uniform in `[rat.sizeU/2, widthU − rat.sizeU/2]`) then dy, with up to 4 attempts. A draw is rejected if it's in the corridor or its AABB overlaps an already-placed rat; after 4 rejections, that rat is skipped. |

A segment whose formation places zero rats is `empty` and creates no horde. Lane ids count **placed** rats (`i = 1, 2, …` in placement order), not slots.

**Overlap is strict:** two AABBs overlap iff `|Δx| < (wa + wb)/2` and `|Δy| < (ha + hb)/2`, so touching edges don't overlap. The corridor test uses the same strict `<`, so a cat at the corridor edge, touching a rat, is safe.

**Corridor.** `corridorHalfU = cat.widthU / 2 + 16`. Anchors `A_j ~ U[margin, widthU − margin]`, with `margin = corridorHalfU + 20`, come from `sfc32(cyrb128(seed + ":anchor:" + j))`. Then:

`cx(k) = A_j + (A_{j+1} − A_j) × (k mod P) / P`, with `j = floor(k / P)` and `P = lane.anchorEverySegments`.

This is chain-free (two anchors per segment). The corridor shifts at most `(widthU − 2 × margin) / P` per segment.

**Reachability (F3):** the cat must leave corridor k only after it stops overlapping band k's rats vertically, and be inside corridor k + 1 before it overlaps band k + 1. The time for that is the **free window** `segU − bandU − cat.heightU` (strip between rat edges minus cat height). In that window, at max scroll and the `moveSpeedMult` floor (1.0: move speed can be buffed, never debuffed), the cat from rest must cover `shift − (2 × corridorHalfU − cat.widthU)`. That's the overlap two consecutive corridors don't share. At start values: window 52 U = 7 ticks, needed 10.8 U, reach 40.5 U.

**Reachability around gates (F15, lateral):** with one empty buffer segment on each side, the worst cases at max scroll and move speed 1.0, from rest, are listed below. "From rest" at the wall holds because `stepCat` zeroes `vx` when the x clamp binds (SPEC.md Code Style). Without that, a player holding ← into the wall keeps `vx = −9` invisibly, and the after-gate reach drops to 409.5 < 448 (round-8 script).
- **Before the gate:** from the edge of the extreme corridor to the far half (230 U: the corridor centre is ≥ 56, so the cat's centre can be at 40; the side is decided by the cat's centre, `x ≥ 270`), in the 60 ticks between the last contact with band g − 2 and the gate crossing. Reach 517.5 U.
- **After the gate:** from the world edge to inside the opposite extreme corridor (448 U), in the 54 ticks between the crossing and contact with band g + 2. Reach 463.5 U.

Without buffers these fail (193.5 < 230 and 139.5 < 448), and so does a 0.5 move-speed floor (238.5 < 448).

These are guarantees that a player **can** dodge, not that every state is safe: a cat at x = 40 already moving at −9 when it crosses reaches only x = 447.5 < 468 in time. "From rest at the wall" is the worst state a player chooses to be in while waiting, not the worst possible state.

**Rat HP:** `rat.baseHp × (1 + rat.hpRampPerM × d)`.

**Boss x:** uniform in `[boss.sizeU/2 + 20, widthU − boss.sizeU/2 − 20]`.

## Rules

**Cat.**
- AABB 40 × 48. Starts at `x = 270`, `vx = 0`, pencil, HP 3, `cooldown = 0` (so the first shot fires on tick 1), default `mods`.
- Input level `-4..4` sets the target `level/4 × maxSpeed × moveSpeedMult`. Velocity moves toward it by ≤ `accel` per tick; x is clamped to `[cat.widthU/2, widthU − cat.widthU/2]`, and when the clamp binds, `vx` is set to 0 (a cat pressed against a wall is at rest; F15 relies on it).
- **Contact:** a rat overlapping the cat while not invulnerable costs 1 HP and removes that rat (not counted in `ratsKilled`). It also sets `invulnTicks = cat.invulnTicks` and `freezeTicks = max(freezeTicks, cat.hitFreezeTicks)`. While invulnerable, overlapping rats pass through untouched.

- `invulnTicks` decrements by 1 in step 2 of every unfrozen tick, floored at 0.

**Firing.**
- Shots start at `(cat.x, catTopY)`.
- Projectile weapons: `cooldown -= 1; while (cooldown <= 0) { fire(); cooldown += 60 / (weapon.rate × fireRateMult); }`. Cooldown carries across swaps.
- **Laser has no cooldown:** its beams are on every unfrozen tick, and `cooldown` stays untouched while the laser is held, so swapping back resumes exactly where it was.
- Projectile `i` of `n` gets `vx = (i − (n − 1)/2) × weapon.spreadVx`.

**Hits.**
- Collision is a discrete AABB overlap after movement.
- In step 4, beams resolve first (beam index order, left to right), then projectiles in id order.
- A rat reaching hp ≤ 0 emits `ratKilled` and is removed at the end of step 4, so later hits in the same step skip it.
- A projectile overlapping one or more rats hits them in lane-id order, at most one hit per rat per projectile (`hitIds`). Each hit spends one unit of `hitsLeft`; at 0 the projectile is removed.
  - Pencil and fishbone start with `hitsLeft = 1 + effPierce`.
  - Yarn starts with `1 + effBounces`, where `effBounces = max(0, weapon.bounces + pierceAdd)`. For yarn, `pierceAdd` means extra bounces. After each rat hit with `hitsLeft > 0`, it retargets: the nearest live rat not in `hitIds`, by squared distance ≤ 250², ties by lane id. New velocity: `(dx, dy) × speedU / max(|dx|, |dy|)`. If there's no target, or `dx = dy = 0`, it keeps its velocity.
- **Boss:** a projectile overlapping the boss deals its damage once and is **removed**, whatever `hitsLeft` is. Pierce and bounces don't apply to the boss. A projectile checks rats first, then the boss; the screen is empty during a fight, so the order only matters for a crafted test scenario.
- **Snapshot at fire time:** a projectile records `weapon`, `damage` (with `damageMult` applied), `w`, `h`, `speedU`, `rangeU` (with `rangeMult` applied) and `hitsLeft` when fired. A later weapon swap or gate never changes shots already in flight. A pencil fired before a swap to yarn stays a pencil and never retargets.
- **Range:** a projectile is removed once `travelled = Σ max(|vx|, |vy|)` exceeds its snapshotted `rangeU`.

**Weapons** (base profiles in config; `mods` carry over fully on a swap):

| Weapon | Kind | Specifics |
|---|---|---|
| pencil | projectile | 6 × 16, pierce 2 |
| laser | beam | Width `beamWidthU`; each extra projectile adds a beam at `beamSpacingU` offsets centred on the cat. Each tick, each beam damages the first `1 + effPierce` overlapping targets with the largest y, ties by lane id. The boss counts as one target. Damage per target per tick: `dps × damageMult × fireRateMult / 60`. Beam length: `range × rangeMult` from `catTopY`, capped at y = 0. |
| yarn | projectile | 12 × 12, bounces as above |
| fishbone | projectile | 8 × 12, 5 projectiles, wide `spreadVx` |

**Stats and clamps (F8).**
- `mods` start at `damageMult` 1, `fireRateMult` 1, `rangeMult` 1, `pierceAdd` 0, `projectilesAdd` 0, `moveSpeedMult` 1.
- Gate multipliers multiply; adds add. Clamps after every gate: `moveSpeedMult` `[1, 3]` (buff-only: the reach invariants assume speed 1.0), other multipliers `[0.25, 20]`, `pierceAdd` `[0, 8]`, `projectilesAdd` `[0, 6]`. Additive stats are buff-only, so their floors never bind.
- Effective pierce ≥ 0; effective projectiles in `[1, 9]`.

**Gates (F5, F7, F10).**
- A pair spans the full width, split at `widthU / 2`; each half is `gates.heightU` tall.
- It resolves on the tick its centre crosses the cat line (`prevY < catLineY ≤ y`), exactly once (`resolved`). Side: `cat.x < widthU/2` → left, else right.
- **Stat gate:** one buff and one debuff on two different stats, not both on the **DPS axis** `{damageMult, fireRateMult, projectilesAdd}` (**trade-off rule**). `projectilesAdd` is on the DPS axis because, for pencil, yarn and laser, extra shots and beams barely spread (beam spacing 22 U on a 120 U boss, `spreadVx` 0.6–0.8), so they multiply single-target DPS. For fishbone, the widest spread, side shots only hit the boss once it's close; the simulated readout (below) counts that exactly.
  - **Debuffs only target `damageMult`, `fireRateMult` or `rangeMult`**; buffs may target any of the 6.
  - So any DPS-axis buff (including +projectiles) always comes paired with a range debuff.
  - **Why no additive debuffs:** −1 pierce or −1 projectile does nothing at base stats (F5).
  - **Why no move-speed debuffs:** the reach invariants need speed ≥ 1.0 (F3, F15).
  - Remaining debuffs (×0.7–0.8) bite from base 1.0. They can go slack in two earned cases:
    - a stat has been debuffed to its 0.25 floor;
    - a range buff has pushed effective range past what matters: the laser beyond the screen top, or any weapon beyond `walkU` for the boss readout.

    In both cases the player already paid or invested. Gate contents can't depend on player state without breaking lane identity (F2), and balance-sim's gate pick counts show whether slack debuffs matter in practice.
  - Buffs go slack the same way, at a clamp: `moveSpeedMult` at 3, `pierceAdd` at 8, `projectilesAdd` at 6, a mult at 20, or the laser's range once past `catTopY`. That half of the gate is then a pure cost. It's the same earned case (the player stacked that stat), and it's accepted for the same lane-identity reason. The T-config buff-side row guarantees only that no buff is slack **at pickup**.
- **Draws, in order:**
  1. `isWeaponPair` (probability `gates.weaponChance`).
  2. If true: `weaponSide` (a bit), `weapon` (uniform over 4), then that half's `fallback` stat gate.
  3. Each remaining stat half, left first:
     - buff stat uniform over the 6;
     - debuff stat uniform over the stats allowed with it: from `{damageMult, fireRateMult, rangeMult}`, ≠ buff, and not both on the DPS axis (a DPS-axis buff forces `rangeMult`).
  - Index mapping: stats in `StatKey` declaration order, weapons in `WeaponId` order, side bit 0 = left / 1 = right.

  Magnitudes come from the distance tier:

  | Tier (gate mark distance, m) | Buff mult | Buff add | Debuff mult |
  |---|---|---|---|
  | `[0, 1000)` | ×1.3 | +1 | ×0.8 (first balance pass: ×0.85) |
  | `[1000, 3000)` | ×1.4 | +1 | ×0.75 |
  | `≥ 3000` | ×1.5 | +2 | ×0.7 |

  Buff mult applies to `damageMult`, `fireRateMult`, `rangeMult` and `moveSpeedMult`; buff add applies to `pierceAdd` and `projectilesAdd`. The tier is chosen by the gate mark's distance, not the crossing distance.
- **Same weapon (F10):** if the cat holds the offered weapon, the half applies its `fallback` instead. The client shows the fallback's icons while you hold it.

**Boss.**
- **Spawn (step 9):** when `distanceU ≥ B × 10`, the boss spawns at `y = −sizeU/2` with `hp = bossHpFor(index)` = `baseHp × hpGrowth^index` (iterated multiplication; `index` = bosses spawned before), emits `bossSpawned`, and scroll is 0 from the next tick. In the same step, `cat.cooldown` resets to 0 and **every live projectile is removed** (beams are recomputed each tick, so they carry nothing over).
- **Killed** (HP ≤ 0, step 8, outside probe mode): removed, `bossKilled { index }`, `bossesKilled += 1`, `freezeTicks = max(freezeTicks, boss.killFreezeTicks)`.
- **Scroll** for a tick is computed once, in step 5, from that moment's state: 0 if a boss is alive, else the ramp formula. So the tick that kills the boss has already moved at scroll 0, and scrolling resumes on the first unfrozen tick after the freeze.
- **Reaches the cat:** when `y + sizeU/2 ≥ catTopY`, the run ends with `'boss'`. No attacks.

**Readout (F6, F12): simulated, not estimated.**
- `bossWarning` fires in step 12, on the tick `distanceM` first reaches `B − warningM`, using post-step-7 mods. It gets the boss's x from `generateSegment(seed, B / segmentM).bossX` (lane data, known before spawn) and its HP from `bossHpFor(bossesSpawned)`. It carries `needDps`, `haveDps`, `onPace` and `etaTicks = ceil((B×10 − distanceU) / scroll)` (display only).
- **Rule that makes it exact:** on `bossSpawned`, `cat.cooldown` resets to 0 and all projectiles are removed. Without the removal, shots fired before spawn are still climbing when the boss appears and add damage the readout never counted (round-8 script: yarn at ×1.3 range, +56 on 420, +13%). So every fight starts from the same state: no shots in flight, cooldown 0, no rats, no gates.
- **`simulateBossFight(mods, weapon, bossHp, bossX)`** calls the game's own tick function, all 13 steps, on a private scratch `RunState`. It doesn't re-implement or pick steps, so range cleanup (step 11), firing, hits and boss movement are exactly the game's:
  - the scratch state is what the spawn step leaves: the cat at `x = bossX` with `vx = 0`, the given `mods` and `weapon`, full HP, cooldown 0; no projectiles, rats or gates (the guaranteed-empty screen, F2 invariant); a boss at the spawn y with `hp = bossHp`; `tick = 0` and `freezeTicks = 0`. Its counters are fixed and don't depend on the caller's run: `B = boss.everyM` (the first mark), `distanceU = B × 10`, `nextSegmentK = B / segmentM + 1` (past the boss segment, so step 9 spawns nothing while scroll is 0), `bossesSpawned = 1`, `warnedForBoss = 0` (boss 0 already warned, and the next warning is at `2B − warningM`, which a scroll of 0 never reaches). None of these feed the fight: boss HP comes from the argument, and a boss's movement doesn't depend on its index;
  - input is 0 every tick (a statue cat standing under the boss);
  - the one difference is a flag passed to the internal tick function (`stepState(state, input, { probe: true })`; the public `step()` always passes `probe: false`). With `probe`, step 8 doesn't remove the boss when `hp ≤ 0`: it records the first such tick as `killTick` and emits nothing, so the walk continues. Probe mode also skips step 12's warning outright, so `simulateBossFight` can never call itself, even if a counter above were wrong;
  - it stops on the tick step 13 first sees the boss reach the cat (`y + sizeU/2 ≥ catTopY`). That's `reachTick`, counted in ticks after spawn. The scratch `tick` starts at 0, so timeout can't fire inside 714 ticks.

  It returns `killTick` (or `null`), `reachTick` and `damageByReach = bossHp − hp` at `reachTick`: the total damage the build can deal before the boss arrives. Because the kill check runs before the reach check, a kill on the reach tick counts as a kill.
- `walkSeconds = reachTick / 60`.
  - `needDps = bossHp / walkSeconds`.
  - `haveDps = damageByReach / walkSeconds`.
  - `onPace = killTick !== null`.

  The boss dies, for a cat standing still under it, **iff** `onPace`. That holds by construction: the same tick function, the same subtractions in the same order on the same HP, from the same state. There's no closed-form approximation of closing speed, spread or range, and no `Σd ≥ hp` comparison that could round differently from the game. Up to `killTick`, a probe tick and a real tick do the same thing; they differ only after it.
  - The one gap left: a fight that straddles `run.maxTicks` ends `'timeout'` even when `onPace` is true. That only happens after 20 minutes of play, and the readout ignores it.
- The readout assumes a centred cat. A player who drifts off-centre does less damage, and the HUD's "stand under the boss" cue is the client's job.
- **Cost:** at most `ceil(walkU / boss.speedUPerTick)` ≈ 714 scratch ticks once per boss, ≈ 14.3 ms at the 50k ticks/s bench floor (once per boss, during the warning tick).
- HUD live DPS (SPEC-client) uses the same function with the next boss's HP.

**Hordes.** A horde is one segment's formation. It emits exactly one of:
- `hordeEscaped { segmentK }` when **any** of its rats' top edge goes `> heightU` alive (the first one to do so);
- `hordeCleared { segmentK, ticksAlive }` when it has no rats left (by player kills or contact) and none escaped.

`ratsKilled` counts player kills only. A horde leaves `hordes` in step 10 on the tick it emits its event. Rats of an escaped horde stay in `rats` until cleanup, can still be killed (counted in `ratsKilled`), and emit no further horde events.

**Score.** `floor(distanceM) + ratsKilled + 250 × bossesKilled`.

**End.**
- `tick` starts at 0, and each `step()` first increments it.
- The run ends on the step where HP hits 0 (`'rats'`), the boss reaches the cat (`'boss'`) or `tick === maxTicks` (`'timeout'`). That step emits `ended { cause, score, tick }`, so a finished run's log has exactly `tick` entries.
- Later `step()` calls return `[]` and change nothing.

**Tick order** (changing it bumps `CORE_VERSION`):
1. Increment `tick`. If `freezeTicks > 0`: decrement it and **jump to step 13**, so timeout is still checked on frozen ticks.
2. Cat move; `invulnTicks` decrement.
3. Firing.
4. Beams, then projectiles: move and hit; dead rats removed.
5. Compute scroll; `distanceU += scroll` **first**, then every lane entity's `y = baseY + distanceU`; the boss moves.
6. Cat contact, rats in lane-id order. The first overlapping rat hits and starts invulnerability, so later overlapping rats on the same tick pass through.
7. Gate crossing.
8. Boss kill, checked **before** boss-reaches-cat, so a kill on the last tick wins.
9. Spawner (segments, boss).
10. Horde accounting.
11. Cleanup:
    - projectiles whose bottom edge is above y = 0, whose centre leaves `[−20, widthU + 20]`, or that are past range;
    - rats whose top edge is `> heightU`;
    - gate pairs whose top edge is `> heightU`.

    A projectile past its range is removed here, after step 4, so it can still hit on the step it crosses its range.
12. Score; `bossWarning`.
13. End check. A tick is **unfrozen** if `freezeTicks` was 0 at step 1. On unfrozen ticks: HP 0 → `'rats'`, boss reached → `'boss'`. On every tick: `tick === maxTicks` → `'timeout'`. So the contact that takes the last HP ends the run on that same tick, even though it also sets `freezeTicks`.

## Types and public API

```ts
// src/core/types.ts: field order here is the hashState order
export type InputLevel = -4 | -3 | -2 | -1 | 0 | 1 | 2 | 3 | 4;
export type EndCause = 'rats' | 'boss' | 'timeout';
export type WeaponId = 'pencil' | 'laser' | 'yarn' | 'fishbone';
export type StatKey = 'damageMult' | 'fireRateMult' | 'rangeMult' | 'pierceAdd' | 'projectilesAdd' | 'moveSpeedMult';
export type Mods = Record<StatKey, number>;
export type StatGate = { kind: 'stat'; buff: { stat: StatKey; value: number }; debuff: { stat: StatKey; value: number } };
export type WeaponGate = { kind: 'weapon'; weapon: WeaponId; fallback: StatGate };
export type Gate = StatGate | WeaponGate;
export type Cat = { x: number; vx: number; hp: number; invulnTicks: number; weapon: WeaponId; mods: Mods; cooldown: number };
export type Rat = { laneId: number; segmentK: number; x: number; baseY: number; y: number; hp: number };
export type GatePair = { laneId: number; baseY: number; y: number; left: Gate; right: Gate; resolved: boolean };
export type Projectile = {
  id: number; weapon: Exclude<WeaponId, 'laser'>; x: number; y: number; vx: number; vy: number;
  w: number; h: number; speedU: number; damage: number; rangeU: number; travelled: number; hitsLeft: number; hitIds: number[];
};
export type Boss = { index: number; x: number; y: number; hp: number; maxHp: number };
export type Horde = { segmentK: number; alive: number; spawnTick: number };
export type RunState = {
  seed: string; tick: number; distanceU: number; freezeTicks: number; over: EndCause | null;
  cat: Cat; rats: Rat[]; gates: GatePair[]; projectiles: Projectile[]; boss: Boss | null; hordes: Horde[];
  nextSegmentK: number; nextProjectileId: number; bossesSpawned: number; bossesKilled: number;
  ratsKilled: number; score: number; warnedForBoss: number;   // index of the last boss warned; starts at −1
};
export type SegmentContent = {
  k: number; kind: 'empty' | 'gate' | 'column' | 'swarm' | 'wall' | 'boss'; corridorX: number;
  rats: { laneId: number; x: number; dy: number; hp: number }[]; gate: GatePair | null; bossX: number | null;
};
export type DeepReadonly<T> = { readonly [K in keyof T]: DeepReadonly<T[K]> };

// src/core/index.ts: the only import path for src/sim and src/client.
// Re-exports every type in types.ts, plus:
export const CORE_VERSION: number;
export const config: Readonly<CoreConfig>;            // CoreConfig = typeof the object in config.ts
export type CoreEvent =
  | { t: 'ratKilled'; laneId: number; segmentK: number; x: number; y: number }
  | { t: 'damage'; x: number; y: number; amount: number }   // one per projectile hit (rat or boss); a beam emits one per target it touches on ticks with `tick % 10 === 0`, amount = that tick's beam damage × 10 (display only: events aren't state, so there's no accumulator to hash)
  | { t: 'catHit'; hp: number }
  | { t: 'gateTaken'; side: 'left' | 'right'; gate: Gate; applied: StatGate | WeaponId }
  | { t: 'weaponChanged'; weapon: WeaponId }
  | { t: 'hordeCleared'; segmentK: number; ticksAlive: number } | { t: 'hordeEscaped'; segmentK: number }
  | { t: 'bossWarning'; haveDps: number; needDps: number; onPace: boolean; etaTicks: number }
  | { t: 'bossSpawned'; index: number; hp: number } | { t: 'bossKilled'; index: number }
  | { t: 'ended'; cause: EndCause; score: number; tick: number };
declare const runBrand: unique symbol;
export type Run = { readonly [runBrand]: true };      // opaque handle
export function createRun(seed: string): Run;         // throws if !isSeed(seed); every counter starts at 0 (tick, nextSegmentK, nextProjectileId, bosses*, ratsKilled, score) except warnedForBoss (−1)
export function step(run: Run, input: InputLevel): CoreEvent[];   // the only state change
export function view(run: Run): DeepReadonly<RunState>;           // see setFrozenViews
export function setFrozenViews(on: boolean): void;
//   default false (returns the state itself); true returns a deep-frozen copy made by
//   core's own copyState() (plain recursive copy: no structuredClone, which isn't in lib ES2022),
//   so a stray write throws (the client's dev/e2e entry turns it on)
export function hashState(run: Run): string;
//   FNV-1a 32 over RunState in types.ts field order; 8 hex chars. Encoding:
//   number → f64 LE bytes (NaN canonicalised to 0x7FF8000000000000; NaN should never occur, see assertFiniteState)
//   string → length (f64) + UTF-16 code units (u16 LE)
//   null → 0x00, false → 0x01, true → 0x02
//   array → length (f64) + each element
//   object → its fields in the declared order of its concrete type (for Gate: `kind` first, then that variant's fields;
//            for Mods, a Record: `StatKey` declaration order)
export function scrollFor(state: DeepReadonly<RunState>): number;   // the scroll step 5 would use this tick (0 while a boss is alive); for bots
export function bossHpFor(index: number): number;    // baseHp × hpGrowth^index by iterated multiplication; the game and the client both use it
export function simulateBossFight(mods: Mods, weapon: WeaponId, bossHp: number, bossX: number):
  { damageByReach: number; killTick: number | null; reachTick: number };   // deterministic, pure (scratch state); ticks counted from spawn
export function validateGate(gate: Gate): { ok: true } | { ok: false; reason: string };
export function generateSegment(seed: string, k: number): SegmentContent;
//   gate.baseY = gates.spawnYU − gates.dyU − k × segU; gate.y = baseY + k × segU (its zero-overshoot spawn y); resolved = false
export function createRng(key: string): () => number; // sfc32(cyrb128(key)) → [0, 1); for balance-sim bots
//   cyrb128 and sfc32 as published in bryc's PRNG notes (github.com/bryc/code, jshash/PRNGs.md); sfc32 seeded with cyrb128's four 32-bit words, output (x >>> 0) / 2^32

// src/core/ghost.ts, re-exported from index.ts: all boundary validators.
// It also re-exports CORE_VERSION (from version.ts), since the worker may import only this file.
export { CORE_VERSION } from './version.ts';
export function isSeed(s: string): boolean;           // /^[0-9a-z]{4,12}$/
export function isGhostId(s: string): boolean;        // /^[0-9A-Za-z]{8}$/
export function createRecorder(): { push(level: InputLevel): void; ticks(): number; bytes(): Uint8Array };
export function encodeInputLog(levels: readonly InputLevel[]): Uint8Array;
export function decodeInputLog(bytes: Uint8Array): InputLevel[];  // throws GhostDecodeError
export function toBase64(bytes: Uint8Array): string;
export function fromBase64(s: string): Uint8Array;                // throws GhostDecodeError
export class GhostDecodeError extends Error { code: GhostErrorCode }
export type GhostPayload = { v: 1; coreVersion: number; seed: string; score: number; ticks: number; inputs: string };
export type GhostErrorCode =
  | 'not_object' | 'bad_field' | 'bad_version' | 'version_mismatch' | 'bad_seed' | 'bad_score' | 'bad_ticks'
  | 'bad_base64' | 'inputs_too_large' | 'bad_level' | 'zero_run' | 'truncated' | 'varint_overflow'
  | 'non_canonical' | 'too_many_ticks' | 'ticks_mismatch';
export function validateGhostPayload(x: unknown):
  | { ok: true; payload: GhostPayload; levels: InputLevel[] }
  | { ok: false; code: GhostErrorCode; field?: string };
export function canonicalGhostJson(p: GhostPayload): string;      // keys in GhostPayload order, no whitespace
export const ghostLimits: { maxInputBytes: 32768; maxBodyBytes: 49152 };
```

**Validation order** (first failure wins):
- not a plain object → `not_object`
- missing field or wrong JS type → `bad_field` (+`field`); extra fields ignored
- `v !== 1` → `bad_version`
- `coreVersion !== CORE_VERSION` → `version_mismatch`
- `!isSeed` → `bad_seed`
- score not an integer in `0..1e9` → `bad_score`
- ticks not an integer in `1..maxTicks` → `bad_ticks`
- `inputs` length: `decodedLen = floor(len/4) × 3 − p`, where `p` is the number of trailing `=` (0–2, counted only when `len % 4 === 0`); `decodedLen > maxInputBytes` → `inputs_too_large`. Checked **before** decoding, so an oversized string never gets decoded, and exact, so the cap really is 32,768 bytes (32,768 passes, 32,769 fails). Then strict base64 → `bad_base64`. The client runs this same validator on its own payload before `POST` (SPEC-client, Share run)
- codec errors
- decoded run sum ≠ `ticks` → `ticks_mismatch`

**Codec (F9, canonical):**
- Runs of `[level + 4: u8][length: unsigned LEB128]`.
- Rejected:
  - level byte > 8 → `bad_level`
  - length 0 → `zero_run`
  - input ending mid-run → `truncated`
  - a varint over 4 bytes → `varint_overflow`
  - a non-minimal varint, or adjacent runs with equal levels → `non_canonical`
  - running sum > `maxTicks` → `too_many_ticks`
- Base64: RFC 4648 standard alphabet. Padding required. Whitespace and non-zero trailing bits rejected.
- Decoding is a single pass that never reads past the input.

**Test helpers** (`src/core/testing.ts`; importable only from `*.test.ts` and `tools/**`, SPEC.md dependency rule 5):
- `runFromScenario({ seed, distanceM, weapon, mods, hp, catX?, tick?, rats?, boss?, nextBossHp?, gates? })`. `distanceM` must be a multiple of `segmentM`; `catX` defaults to 270.
  - `rats` places crafted rats (`{ x, y, hp }`), with synthetic lane ids from 10⁹ up so they never collide with real ones, `segmentK = −1` and `baseY = y − distanceU`. They belong to no horde.
  - `boss` places a crafted boss (`{ x, y, hp }`).
  - `gates: false` makes gate segments spawn nothing (the segment stays empty, so lane ids and every other segment are unchanged). Only the bench uses it.
  - `nextBossHp` overrides the HP of the next naturally spawned boss, and the matching `bossWarning`'s `needDps`/`onPace` use it (readout honesty tests).
  - These make T-hits, T-clamps (yarn) and the T-end hit-stop case buildable.
  - The run starts at `distanceU = distanceM × 10` exactly, with `nextSegmentK = distanceM / segmentM`, an empty screen, and `bossesSpawned = bossesKilled = floor(distanceM / boss.everyM)`. So a `distanceM` exactly on a boss mark counts that boss as already spawned and killed, and nothing spawns on tick 1.
  - `warnedForBoss` is the index of the last boss whose warning distance `B − warningM` is ≤ `distanceM`, or −1 if none.
  - Its lane offsets are exact multiples of `segU`, so scenario runs match each other, but not necessarily a natural run's sub-unit overshoot. **Tests compare scenario to scenario only.**
- `assertFiniteState(run)`.
- `corridorFollower(view): InputLevel`: the T-corridor bot (steers to `cx(k)` of the band it's about to enter, then to the nearer gate half). Also used by the bench.

**Fixtures** (`src/core/fixtures/`, regenerated by `tools/regen-fixtures.ts` via `npm run fixture:regen`):
Both fixtures share one schema:

```ts
type Fixture = { coreVersion: number; seed: string; levels: InputLevel[]; ticks: number; hash: string;
                 ended: { cause: EndCause; score: number; tick: number } | null };
```

- `replay.json`: seed `golden1`, **pattern 0** (a repeating 240-tick cycle: 60 × `+4`, 60 × `0`, 60 × `−4`, 60 × `0`), 3,600 ticks or until `ended`. `ended` is `null` if the run survived.
- `dies.json`: the first seed in `die000 … die999` where the all-zeros log ends with `'rats'` within 3,600 ticks. `levels` is cut at `ended.tick`, so `ticks === ended.tick`. Used by client e2e as a real ghost.

## Starting tunables (`src/core/config.ts`)

Starting values only. balance-sim tunes them, no test pins them, and any change bumps `CORE_VERSION`. T-config asserts the invariants below for whatever values are present.

| Group | Keys → start |
|---|---|
| world | `widthU` 540 · `heightU` 960 · `catLineY` 880 |
| scroll | `baseUPerTick` 3 · `maxUPerTick` 7 · `rampPerM` 0.004 |
| lane | `segmentM` 25 · `bandU` 150 · `warmupM` 50 · `anchorEverySegments` 10 · `formationWeights` column 0.4 / swarm 0.4 / wall 0.2 |
| cat | `widthU` 40 · `heightU` 48 · `maxSpeedUPerTick` 9 · `accelUPerTick2` 1.5 · `hp` 3 · `invulnTicks` 60 · `hitFreezeTicks` 6 |
| rat | `sizeU` 28 · `spawnYU` −14 · `baseHp` 20 · `hpRampPerM` 0.004 |
| gates | `everyM` 150 · `heightU` 40 · `spawnYU` −20 · `dyU` 75 · `weaponChance` 0.25 |
| boss | `everyM` 500 · `clearM` 150 · `warningM` 30 · `sizeU` 120 · `speedUPerTick` 1.2 · `baseHp` 800 (balance passes: 375, then 390) · `hpGrowth` 1.6 · `killFreezeTicks` 12 |
| pencil | dmg 10 (first balance pass: 13) · rate 4/s · proj 1 · pierce 2 · range 520 U · speed 14 · spreadVx 0.6 · 6×16 |
| laser | dps 150 · beams 1 (+`projectilesAdd`) · beamWidthU 14 · beamSpacingU 22 · range 700 U · pierce 0 |
| yarn | dmg 14 · rate 2.5/s · proj 1 · bounces 3 · range 700 U · speed 10 · spreadVx 0.8 · 12×12 |
| fishbone | dmg 5 · rate 3/s · proj 5 · pierce 0 · range 300 U · speed 12 · spreadVx 1.2 · 8×12 |
| run | `maxTicks` 72000 |
| lane shape | `emptyChance` floor 0.1 · start 0.4 · fall over 2000 m · column `n` 3 + floor(d/500), cap 4 · swarm `n` 4 + floor(d/300), cap 10 · wall slot spacing 34, origin 17 · corridor half-width margin 16 · corridor edge margin 20 |
| yarn | `retargetRadiusU` 250 |

The formulas in Lane generation and Rules name these keys; the numbers written inline there are their start values, not separate constants.

**Invariants (T-config).** Start values in brackets were computed by script (round-4 and round-5 verification runs; the round-5 failures listed are the counterexamples, expected to fail).

| Invariant | Prevents |
|---|---|
| `(catLineY − (gates.spawnYU − gates.dyU)) / scroll.max ≥ 90` ticks [139.3] | F4 |
| `rat.spawnYU − (bandU − rat.sizeU) + (clearM + segmentM) × 10 − rat.sizeU/2 > heightU` [1600 > 960] | F2: screen empty at boss |
| `(catLineY − (gates.spawnYU − gates.dyU)) / 10 − clearM − segmentM ≤ −(warningM + 5)` [−77.5] | F12; also leaves the last gate's centre at y 1655 at boss spawn, so cleanup has removed it |
| `boss.everyM`, `gates.everyM`, `clearM`, `warmupM` are multiples of `segmentM` | Marks align with segments |
| Free window `segU − bandU − cat.heightU > 0` [52 U]; reach from rest at the `moveSpeedMult` floor in `floor(window / scroll.max)` ticks ≥ `shift − (2 × corridorHalfU − cat.widthU)` [40.5 ≥ 10.8]. The same check on round-3 values fails (13.5 < 28.4), which proves it bites. | F3 |
| Lateral reach around gates with one buffer segment each side, at move speed 1.0 and max scroll: before [517.5 ≥ 230], after [463.5 ≥ 448] | F15 (lateral) |
| `gates.everyM ≥ 3 × segmentM` (gate, two buffers) and at least one horde segment between gate buffers [150 m → 3 horde segments] | Lane density |
| Gate-centre-to-rat-centre clearance to neighbouring bands ≥ `cat.heightU/2 + rat.sizeU/2 + gates.heightU/2` [169 ≥ 58] | F15 |
| `weapon.speedU + scroll.max < rat.sizeU + projectile.heightU` per weapon (strict: overlap is strict, so equality would let them pass) [max 21 < 44] | F14 |
| Every allowed debuff value is < 1 and above its clamp floor at base 1.0, and no debuff targets an additive stat or `moveSpeedMult` | F5, F3 |
| **Buff side:** for every weapon at base mods and every tier, each buff alone strictly raises its effective stat. In particular `range × buffMult` must raise `min(range, cap)`, so the laser's base range must be < `catTopY` [700 < 856]. Otherwise a range buff is slack from pickup, and a gate pairing it with a debuff is a pure loss. | F5 |

**Sanity on the start values** (script-checked, not a test). These use a range-fraction approximation (damage × in-range share of the walk), which **understates** the real readout: it ignores closing speed and late side-shot hits. They're lower bounds for orientation only; the game uses `simulateBossFight`.
- First boss (index 0): `walkU` 856 → `ceil(856 / 1.2)` = 714 ticks (11.9 s), need ≈ 67 DPS.
- Laser: 150 × inRange 700/856 = 123, beating the first boss from pickup. With one, two or three ×0.8 range debuffs, its readout drops to 98, 79 and 63. Its range sits below `catTopY` on purpose, so a range buff helps it from pickup (T-config buff-side row); after enough range buffs it saturates, an earned slack.
- Pencil: 40 × inRange 0.61 = 24. Gates before the first boss are at 150 and 300 m. Two ×1.3 DPS buffs give ≈41 before their paired range debuffs, ≈33 with one of them, and ≈26 with both. See Open Questions.

## Tests

**Gate lane** (`vitest --project core`; sizes chosen so all simulated ticks across core + sim gate tests total ≈ 70k by tally of the gate sizes in these tables (including one 714-tick scratch fight per `bossWarning`), ≈ 1.4 s at the 50k ticks/s floor). Full sizes run with `CATMAN_FULL=1`.

| Test | Checks | Gate / full |
|---|---|---|
| T-replay (F1, F13) | Patterns 0–3 (cycle, hold-right, idle, seeded jitter): record → encode → decode → re-simulate. Hashes are equal every 600 ticks, and `ended` comes on the same tick with the same score. | 4 seeds × ≤1,200 ticks / 50 seeds, full runs |
| T-repeat (F1) | Same seed and log twice → identical event streams | 2 × 1,200 / 20 full |
| T-lane (F2) | Two runs from the **same** `runFromScenario` at 450 m (just before boss 0), with `catX` set to the boss x from `generateSegment`. One has mods that kill the boss fast, the other mods that kill it slowly (kill times differ > 3×). Statue input. Both runs must visit the same `distanceU` values (boss pauses add exactly 0). Checkpoints stop as soon as either run ends. At every 10 m checkpoint after both resume: identical `(laneId, x, y)` for every lane entity present in both, and the same set of spawned lane ids. | 2 seeds × through 700 m / 200 seeds × 5 bosses |
| T-corridor (F3) | `generateSegment`: no rat in its corridor; shift bound holds. Full size only: a corridor-follower bot (steers to `cx(k)` of the band it's about to enter, then to the nearer gate half, at the default and floor `moveSpeedMult` 1.0) runs 3,000 m with zero `catHit` | 100 seeds × 3,000 m (generation only) / 200 seeds incl. the bot, started via `runFromScenario({ distanceM: 0, mods: { damageMult: 20 } })` so bosses never stop it |
| T-config (F2–F4, F12, F14, F15) | Every invariant above on the live `config` | — |
| T-gates (F5, F10) | Every generated gate and fallback passes `validateGate`. `validateGate` rejects a hand-built pure buff, a DPS-only trade and an additive debuff. Effective-stat property (both sides), **stat gates only** (weapon gates are trades by nature, and their fallback is a stat gate): for each weapon at base mods, applying the gate's **debuff alone** strictly lowers the debuffed effective stat. That's `effDamage = damage × damageMult`, `effFireRate = rate × fireRateMult` (laser: `dps × fireRateMult`), or `effRange = min(range × rangeMult, cap)`, where `cap` is `catTopY` for the laser (screen top) and unbounded for projectiles. And applying the **buff alone** strictly raises the buffed effective stat (the same caps; pierce, projectiles and move speed by their effective values). Together, every half of every stat gate both costs and gives something for every weapon at pickup. Holding the offered weapon applies the fallback. | 100 seeds × first 3,000 m / 1,000 seeds × first 3,000 m |
| T-warning (F2, F12) | Scenario at 250 m, heading into boss 0 (the 300 m gate spawns and must cross before the warning at 470 m): no `gateTaken` between `bossWarning` and `bossSpawned`; at `bossSpawned`, `rats` and `gates` are empty | 4 seeds / 1,000 × 20 bosses |
| T-boss-reset (F6) | Yarn at ×1.3 range and pencil at ×1.69 range, statue cat under the boss from 450 m: at `bossSpawned`, `projectiles` is empty and `cat.cooldown` is 0; the boss's damage taken up to the kill or reach tick equals what `simulateBossFight` applied up to that tick | 2 builds × 2 seeds / 20 seeds |
| T-wall-rest (F15) | `stepCat` holding −4 at `x = 20` for 10 ticks leaves `vx = 0`. A bot holds into the left wall through a left gate half, then steers to the far-right corridor from the crossing tick: no `catHit` before band g + 2 clears, at move speed 1.0 and max scroll | 4 seeds × 3 gates / 100 seeds |
| T-once (F7) | Cat parked at x = 269, 270, 271; a crossing between ticks at max scroll → one `gateTaken` per pair | — |
| T-clamps (F8) | 50 max buff and 50 max debuff gates → `assertFiniteState`, every stat at its clamp; yarn hitting a rat at its own position keeps its velocity | — |
| T-hits | Pencil with pierce 2 hits 3 stacked rats, then is removed; one pencil on the boss deals one hit and is removed; yarn bounces `effBounces` times (and +1 per `pierceAdd`); laser with pierce 0 hits only the lowest rat; laser → pencil swap keeps `cooldown` unchanged and fires again; a rat killed by a beam isn't hit by a projectile in the same step | — |
| T-codec (F9) | Round trip; every error code reachable; random bytes decode or throw within bounds; non-minimal varint and adjacent equal runs → `non_canonical` | 1,000 strings / 10,000 |
| T-end | Every `EndCause`. Timeout via `runFromScenario({ tick: maxTicks − 10 })`: after exactly 10 more steps, `ended { cause: 'timeout', tick: maxTicks }`. (Natural-run log length equals `ended.tick` is covered by T-replay.) Timeout during hit-stop: scenario at `maxTicks − 3` with a crafted rat overlapping the cat → contact on the next tick, then `ended` on tick `maxTicks` while frozen. Post-end `step()` returns `[]` with the hash unchanged. | — |
| T-golden (F11) | First, each fixture's `coreVersion` equals `CORE_VERSION`; then `replay.json` and `dies.json` hashes, plus `dies`' `ended` tick and score. On failure: "Core behaviour changed. Bump CORE_VERSION in src/core/version.ts and run `npm run fixture:regen`." | — |

**Periodic:** `npm run bench` and `npm run sim:periodic`.

**The bench** (`tools/core.bench.ts`) times only busy ticks. Two scenarios, each over 12 seeds (`bench00`…`bench11`):
- **projectiles:** pencil with `{ projectilesAdd: 6, fireRateMult: 5 }`: 7 shots every 3 ticks, each removed on its 38th tick once it passes range 520 at speed 14, so about 88 in flight before hits remove some;
- **beams:** laser with `{ projectilesAdd: 2 }` (3 beams).

Each seed:
- starts at `runFromScenario({ distanceM: 1525, hp: 1e9, weapon, mods, gates: false })`. Without `gates: false`, the 1,650 m gate crosses the cat line on tick 318, inside the timed window, for every seed: each stat half carries a debuff and about 9% of seeds swap weapon, so the load would change mid-window (round-12 model). 1,525 m is the first metre after boss 2's clear zone (`[1350, 1525)`), and swarms there have 9 rats;
- input comes from `corridorFollower`, so the cat dodges rats instead of standing in them;
- warms up for 140 ticks (one screen height at scroll 7), then times the next 260 ticks;
- after 400 ticks it's at 1,805 m, short of the next clear zone at 1,850 m, so no timed tick has a boss, a clear zone or an ended run.

Every timed tick is asserted to start with `freezeTicks === 0`, `boss === null` and `over === null`, and to emit no `gateTaken` or `weaponChanged`. A seed that breaks this (a hit-stop from a contact) is dropped and reported, and the bench fails if more than 2 of the 12 are dropped. That keeps cheap frozen or ended ticks out of the timing by construction.

Output:
- ticks/s for each scenario, over 3,120 timed ticks when no seed is dropped;
- mean live rats and projectiles per timed tick, and the share of timed ticks where a beam touches a rat, as evidence of the load (the corridor follower dodges, so in the beams scenario that share is low: a median of 0.33 in the round-12 model);
- `os.cpus()[0].model`.

The floor applies to the slower scenario.

**Cross-engine:** SPEC-client E2E 7.

## Success Criteria

- [ ] All tests pass at gate size within the shared <2 s gate budget, and at full size under `CATMAN_FULL=1`.
- [ ] `npm run bench` reports ≥ 50,000 ticks/s for both scenarios on Felipe's dev machine (CPU model in the PR).
- [ ] The fixture hashes are identical in Node, Chromium, Firefox and WebKit.
- [ ] `src/core` type-checks under `tsconfig.core.json`, with zero banned-API lint hits.
- [ ] `index.ts` is the only import surface outside tests.

## Open Questions

- **Pencil vs boss 0 (answered 2026-11-09: "rest is good", so pencil stays the horde weapon and the first balance pass lifts it to beat boss 0 on base stats):** pencil-only reaches about 26–41 of the 67 DPS needed. At start values the laser also beats the pencil on everything except pierce, so expect the first balance sweep to fail the dominance target; that's balance-sim's job to surface. Is that the intended push to swap (pencil as the horde weapon), or should pencil stand on its own? The sim says how often; this is about intent.
- **Kills count only for score.** Power comes from gates, so a careful player can hide in the corridor. Is beating the ghost's score reason enough to fight? MVP: yes.
- **Rats ride the lane rigidly** (they no longer walk). That makes lane geometry exact and gates never guarded, at the cost of rats feeling less alive. If the playtest says they feel static, a walk animation in the client costs nothing; real walking would reopen F2 and F15.
- Boss with no attacks: revisit after the playtest.
- **Ghost size vs run length.** `maxInputBytes` (32 KB) holds 4.5 min if the level changes every tick (2 B per run), or longer than the 20-min `maxTicks` at one change per 8 ticks (≈36 min of capacity; script-checked). Real touch play sits somewhere in between and is unmeasured. Runs over the cap can't be shared as ghosts; the client says so (SPEC-client C7). Measure real log sizes in the playtest before deciding whether to raise the cap (that's Ask first: wire format).
