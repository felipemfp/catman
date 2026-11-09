# Spec: balance-sim

Module id: `balance-sim` · Path: `src/sim/` · Depends on: `game-core` (via `src/core/index.ts`; tests may also use `src/core/testing.ts`) · Root spec: [SPEC.md](SPEC.md)

## Objective

Answer "is any build simply the best?" and "is the readout honest?" with numbers instead of gut feel. It runs game-core headless across many fixed seeds per build, with scripted bots, and writes a report.

It's a tuning tool. Its outputs live in `/tmp/catman-sim/`, never in the repo.

## Failure modes (tests are written against these first)

| # | Failure | Effect | Guard → test |
|---|---|---|---|
| S1 | Not reproducible (bot randomness, thread scheduling) | Tuning chases noise | Bot RNG per run via `createRng`; rows sorted before writing → T-S1 |
| S2 | Builds compared on different seeds | Lane differences mistaken for build differences | Paired design: seed `i` is identical across builds → T-S2 |
| S3 | Bot too dumb or too good | Sim measures the bot | Sanity floor → T-S3 (periodic); playtest beats sim (SPEC.md Open Question 3) |
| S4 | Readout misleading (game-core F6) | Unfair boss losses | Simulated readout (game-core) + exact agreement → T-S4, T-S4-gate |
| S5 | Sweep too slow to run before a balance PR | Nobody runs it | `worker_threads` across cores; budget → T-S5 (periodic) |
| S6 | Dominance check wrong, or reporting noise as signal | False verdicts | Margins on both axes, `random` excluded → T-S6 |

## CLI

```bash
node src/sim/cli.ts --builds all|pencil,laser,... --runs 1000 [--out DIR] [--check] [--threads N]
```

| Flag | Default | Meaning |
|---|---|---|
| `--builds` | `all` | `pencil`, `laser`, `yarn`, `fishbone`, `random`. |
| `--runs` | `1000` | Seeds per build. Seed `i` = `"sim" + i.toString(36).padStart(3, "0")` (always a valid seed). |
| `--out` | `/tmp/catman-sim/<ISO timestamp>/` | Output directory. A path inside the repo is refused (exit 2). |
| `--check` | off | After writing, evaluate the targets and exit 1 if any fails. |
| `--threads` | `os.availableParallelism()` | Worker threads. `.ts` worker files run under Node 22.22 type stripping; checked locally with a `.ts` worker importing a `.ts` module. |

Progress goes to stdout every 5 s: done/total, runs/s, ETA, computed from completed-run counts.

## Bots (`src/sim/bots.ts`)

A bot is `(view: DeepReadonly<RunState>, rng: () => number) => InputLevel`. The view comes from `view(run)`, and `rng` from `createRng("bot:" + seed)`, which is separate from the lane streams by construction.

**Movement (all builds):**
1. Candidate target x values are the 26 points `20, 40, …, 520` (the cat clamp is `[20, 520]`).
2. Discard any whose cat AABB would overlap a rat within the next 30 ticks (rats projected at `scrollFor(view)`, core's exported scroll formula, so the bot doesn't re-derive it; the lane is rigid).
3. Of the rest, pick the one with the most rats in the firing column (x within `halfSpreadU + shotW/2` of the candidate, where `halfSpreadU = ((n − 1)/2) × spreadVx × (rangeU / speedU)` is the widest lateral drift over the shot's range, or the beam offsets' half-span for the laser; and within effective range); ties go to the nearest current x.
4. During a boss fight, target the boss's x.
5. If nothing survives step 2, target the corridor centre (`generateSegment` exposes it).
6. Input = the level that moves toward the target without overshooting at the current accel.

**Gate choice per build** (the bot steers to the chosen half once a gate pair is on screen):
- **Weapon builds** (`pencil`, `laser`, `yarn`, `fishbone`): always take their weapon gate. Otherwise take the stat gate whose buff is on the build's preferred axis (laser: DPS; fishbone, yarn: shape; pencil: `rangeMult`, then `pierceAdd`). A higher-ranked buff wins over a lower one on either half; equal ranks fall back to the left half.
- **`random`:** a coin flip from the bot RNG.

## Metrics

From core events:
- `hordeClearRate = cleared / (cleared + escaped)` over `hordeCleared` / `hordeEscaped` events.
  - This replaces the earlier "mean horde clear time" axis. Clear time is only defined for cleared hordes, so it rewards builds that ignore hard hordes (they escape and drop out of the mean). Clear rate counts every horde.
- `bossKillRate[k]` = share of runs that reached boss `k` and killed it.
- `bossKillRateHolding[k]` = the same rate, restricted to runs whose cat held the build's weapon when boss `k` spawned. Only two gates come before boss 0, so many weapon-build runs reach it still holding the pencil. This conditional rate is what says something about the weapon; both go in `summary.json`, along with `n`.

Per-run output: `distanceM`, `score`, `cause`, `bossesKilled`, `gatesTaken`, `finalWeapon`.

## Outputs

| File | Content |
|---|---|
| `runs.csv` | `build,seedIndex,seed,ticks,distanceM,score,cause,bossesKilled,reachedBoss0,killedBoss0,hordesCleared,hordesEscaped,gatesTaken,finalWeapon`, sorted by `(build, seedIndex)` |
| `summary.json` | Per build: median/p10/p90 `distanceM`, `hordeClearRate`, `bossKillRate[0..4]` and `bossKillRateHolding[0..4]` (each with its `n`), `cause` distribution, gate pick counts per `(buff stat, debuff stat)` pair |
| `dominance.json` | Every ordered pair of **weapon builds** (A, B) where A beats B by both `hordeClearRate` ≥ 0.05 **and** `bossKillRate[0]` ≥ 0.05. `random` is excluded: losing to a focused build is expected. |
| `check.txt` | With `--check`: each target, its value, pass/fail |

The 0.05 margins aren't arbitrary. With 1,000 runs per build, the standard error of a difference between two rates is at most √(2 × 0.25/1000) ≈ 0.022, so 0.05 is ≈2.24 SE on each axis. Dominance needs both axes, so two equal builds trip it with probability ≈1.6 × 10⁻⁴ per ordered pair. That's approximate: it uses the normal approximation, assumes the two axes are independent (they come from the same runs, so they're likely correlated, which raises it) and n = 1,000. `bossKillRate[0]` uses only runs that reached boss 0 (≥90% per T-S3; with n = 900 on that axis it's ≈2.1 × 10⁻⁴, and ≈2.9 × 10⁻⁴ if both axes had n = 900), and `hordeClearRate` is a pooled ratio rather than a per-run binomial. It's an order of magnitude, script-checked, not an exact false-alarm rate.

**Balance targets** (`src/sim/targets.ts`, the frozen rubric for any balance pass; changing them is **Ask first**):
1. `dominance.json` is empty.
2. Each weapon build's median `distanceM` is within `[0.75, 1.33] ×` the median of the weapon-build medians.
3. Each weapon build's `bossKillRate[0]` is in `[0.80, 0.98]` (casual profile; was `[0.60, 0.90]`).
4. Each weapon build's `bossKillRateHolding[0]` ≥ 0.75, checked when n ≥ 30: no weapon is a trap at the first boss.
5. Each weapon build's `bossKillRate[1]` ≥ 0.50.
6. Each weapon build's `ratKillRate` (rats killed / rats that appeared, pooled; `ratsSeen` and `ratsKilled` in runs.csv) ≥ 0.60.
7. Each weapon build's median `distanceM` ≥ 1500.

## Tests

**Gate lane** (`vitest --project sim`, inside the shared <2 s budget):

| Test | Checks |
|---|---|
| T-S1 | Three in-process sweeps of 2 builds × 2 runs, each run capped at 600 ticks: two with 2 threads and one with 1 thread. All three give byte-identical `runs.csv` and `summary.json` |
| T-S2 | Each build's rows have the same `seed` column, in order |
| T-S6 | `dominates()` on hand-built summaries: a margin ≥ 0.05 on both axes is dominance; 0.049 on either is not; a missing `bossKillRate[0]` (no runs reached it) is not; `random` never appears |
| T-S4-gate | Readout honesty at gate size, 10 fights in two groups. **Group 1 (8 fights):** 4 weapons × base mods × boss HP at 0.9× and 1.1× of `simulateBossFight(...).damageByReach`. **Group 2 (2 fights), shots in flight at spawn:** yarn at ×1.3 range with HP at 0.95× and 1.05× `damageByReach`. Without the spawn-time projectile removal, the boss dies while `onPace` is false (round 8's counterexample). Every fight is a real run: `runFromScenario` at 450 m with `catX` = the boss x from `generateSegment(seed, 500 / segmentM).bossX`, statue input, boss HP set through the scenario's `nextBossHp` (not its `boss` field: that places a crafted boss at the start, which holds scroll at 0 so the warning never fires). Assert that the `bossWarning.onPace` value equals "the boss died", **every time** (it's deterministic, so no percentage). |

**Periodic lane** (`npm run sim:periodic`, defined in SPEC.md Commands, plus the sweep `npm run sim -- --builds all --runs 1000 --check`):

| Test | Checks |
|---|---|
| T-S4 | The same assertion at full size: 4 weapons × mod sets {base, ×1.3 range, ×0.64 range, +1 projectile, +1 pierce, ×1.69 damage with ×0.64 range} × HP at {0.8, 0.9, 0.99, 1.01, 1.1, 1.25}× `damageByReach` × 20 seeds. 100% agreement required. One mismatch means the readout and the game diverged, a bug, not noise. |
| T-S3 | On seeds 0..99, the `pencil` bot reaches boss 0 in ≥90% of runs |
| T-S5 | Not a separate run: the `--check` sweep itself prints elapsed time and CPU model, and `--check` fails if elapsed > 300 s. The periodic lane runs one sweep, not two. |

## Success Criteria

- [ ] Gate-lane tests pass inside the shared 2 s gate budget.
- [ ] Periodic tests pass on Felipe's dev machine (CPU model printed by T-S5, recorded in the balance PR).
- [ ] Same arguments → byte-identical `runs.csv` and `summary.json`.
- [ ] `--check` exits 0 on the tuned `config.ts` before the client ships.
- [ ] `--out` inside the repo exits 2.

## First balance pass (2026-11-09, CORE_VERSION 2)

Changed in `config.ts`: boss `baseHp` 800 → 375, pencil damage 10 → 13, tier-0 debuff ×0.8 → ×0.85. `--runs 1000 --check` on an i7-13700T, 4.4 s:

| Target | Start values | After |
|---|---|---|
| dominance.json empty | pass | pass |
| median distance in band | pass (all 500 m) | pass (laser 1.25×, others 1.0×) |
| bossKillRate[0] pencil / laser / yarn / fishbone | 0.04 / 0.11 / 0.05 / 0.05 | 0.83 / **0.96** / 0.81 / 0.79 |

**Still failing: the laser build at 0.96 > 0.90.** Most laser-bot runs still hold the pencil at boss 0 (only two gates come first), and the laser bot takes DPS buffs, which are exactly the boss stat. The pencil bot takes pierce, usually paid with a damage or fire-rate debuff, and about a third of its runs land on one identical boss damage. So the kill rates jump in steps as boss HP moves, and no HP puts both bots inside a 0.30-wide band without splitting that group on a single HP point (351 passes three targets and fails laser at 0.908; 352 fails pencil at 0.594). Tuning to one HP point would be fitting the fixed seeds, not balance. Options (targets and bots are Felipe's call): widen the boss-0 band, have the pencil bot prefer range (which helps it on bosses), or add a third gate before boss 0.

## Second balance pass (2026-11-09, CORE_VERSION 3)

Felipe picked "pencil bot prefers range". The pencil bot now ranks `rangeMult` above `pierceAdd` instead of taking whichever preferred buff sits on the left. On its own that moved pencil from 0.83 to 0.84 and left laser at 0.965, since the laser bot's picks are unchanged. What it bought is room on boss HP: there is now a window (about 388–396) where all four builds pass, where before there was none. Changed in `config.ts`: boss `baseHp` 375 → 390.

| bossKillRate[0] | pencil | laser | yarn | fishbone |
|---|---|---|---|---|
| 375, old bot (1000 runs) | 0.83 | **0.965** | 0.81 | 0.79 |
| 390, range bot (1000 runs) | 0.753 | 0.874 | 0.724 | 0.702 |
| 390, range bot (3000 runs: 2000 seeds unused in tuning) | 0.737 | 0.863 | 0.711 | 0.690 |

Every `--check` target passes at both sizes. The rates still move in steps: 391 drops pencil, yarn and fishbone to 0.62–0.66 at once, and 387 pushes laser back to 0.945. 390 was picked as the HP that keeps every build at least 0.037 inside the band on the held-out seeds. Watch the laser margin (0.863 vs 0.90) on the next tuning change.

## Casual retune (2026-11-09, CORE_VERSION 4)

Felipe's first real run: the scroll gets fast quickly, rats can't be killed, only one build beats the boss. He wants a game to kill free time with. The sim agreed: at CORE_VERSION 3 the bots cleared about 11% of hordes, and a run holding fishbone at boss 0 killed it 22% of the time (yarn 54%). Targets 3–7 above were written before any tuning.

One target was changed mid-pass, in the open: `hordeClearRate ≥ 0.6` became `ratKillRate ≥ 0.6`. A horde only counts as cleared if every rat dies, and walls are dodge-through-the-corridor by design: bots cleared 0–12 walls out of 300–700. Even with 1-HP rats the bots' ceiling is 0.63–0.74 of all rats killed, so 0.6 is near the top of what a dodge-first bot can do.

| Key | v3 | v4 |
|---|---|---|
| scroll base / max / ramp per m | 3 / 7 / 0.004 (max at 1000 m) | 2.5 / 5 / 0.001 (max at 2500 m) |
| formations column / swarm / wall | 0.4 / 0.4 / 0.2 | 0.5 / 0.4 / 0.1 |
| rat baseHp / ramp per m | 20 / 0.004 | 12 / 0.0003 |
| gate debuffs by tier | ×0.85 / 0.75 / 0.7 | ×0.9 / 0.85 / 0.8 |
| boss baseHp / growth | 390 / ×1.6 | 650 / ×1.1 |
| pencil dmg, rate | 13, 4/s | 16, 5/s |
| laser dps | 150 | 70 |
| yarn dmg, rate | 14, 2.5/s | 20, 3.5/s |
| fishbone dmg, rate, range, spread | 5, 3/s, 300, 1.2 | 14, 3.5/s, 420, 0.9 |

Results (1000 runs; 3000 runs agree within 0.04):

| build | median m | rats killed | boss 0 / 1 / 2 / 3 | boss 0 holding own weapon |
|---|---|---|---|---|
| pencil | 1820 | 0.67 | 0.87 / 0.77 / 0.84 / 0.91 | 0.87 (n 890) |
| laser | 3796 | 0.64 | 0.96 / 0.97 / 0.99 / 1.00 | 0.80 (n 113) |
| yarn | 2392 | 0.62 | 0.87 / 0.90 / 0.94 / 0.97 | 1.00 (n 91) |
| fishbone | 2262 | 0.59 | 0.87 / 0.91 / 0.95 / 0.97 | 1.00 (n 115) |

**Still failing:**
- **Laser median distance 1.63× (band 1.33×).** The laser build's lead is the laser bot's DPS-greedy gate picks, not the weapon. Cutting laser dps from 70 to 55 dropped laser-holding boss-0 kills to 0.23 without moving the build's distance, and trimming every gate's multiplier hurt all builds equally. DPS gates beat shape gates (pierce, projectiles, range) on bosses, and bosses are what end the other builds' runs (55–63% of deaths, against 8% for laser). Open for Felipe: give shape buffs boss value, cap DPS stacking, or accept that DPS picks are the strong line and widen the band for it.
- **Fishbone ratKillRate 0.59 (0.587 on 3000 runs).** It's 0.01 short and didn't move with damage or fire rate; a wide spread from a bot that dodges.

## Tuna (CORE_VERSION 5)

Bots: when hurt, a bot steers to a tuna between 0 and 400 U above the cat line, if that x is safe. 1000-run sweep: about 0.38 heals per 1000 m. Pencil, yarn and fishbone change little, since bosses end their runs. Laser's median goes from 3796 to 8500 m, 25% of laser runs hit the 20-minute cap, and dominance trips (laser > fishbone). Tuna amplifies the open DPS-stacking issue from § Casual retune; it doesn't create it. A rarer tuna (chance 0.5: laser median 6114, dominance still tripped) doesn't fix it, so the designed rate stays until the DPS question is decided.
