# Catman

## Problem Statement

How might we make a one-thumb browser runner where every left/right step is a real choice (which weapon you use and where you stand) so a run with friends is worth replaying to try a different build?

## Recommended Direction

A vertical endless runner built in Phaser. A stickman cat moves freely left and right at the bottom of the screen and fires automatically straight up. Rat hordes stream down at it. Rats hurt on contact, so the core skill is staying in front of a rat column long enough to kill it, then slipping out before it reaches you.

Gates come in pairs, and **every gate is a trade-off** between things the DPS number can't compare: spread vs focus, range vs pierce, damage vs fire rate *only when another axis also changes*. A gate that only scales DPS ("×2 damage / −40% fire rate") is arithmetic, not a choice, so it is not allowed. Weapon gates are rarer and change how you have to position: **pencil** (short-range throw that pierces), **laser** (high DPS only directly in front of you), **yarn ball** (bounces between rats), **fishbone** (a wide, weak cone). A rat boss shows up on a timer as a DPS check, with HP that grows each time. Live DPS against the boss's HP per second is shown before it arrives, so a loss reads as your build choice, not bad luck.

Every run comes from a seed in the URL. Share a link and your friend plays the same lane, with your run shown as a ghost cat and your score to beat. The ghost's input log lives in Cloudflare KV behind a small Worker, so links stay short (`?s=8f3a&g=k2x9`). That's the social loop, and it's the reason a game for friends gets played more than twice.

## Key Assumptions to Validate

- [ ] **Free movement makes positioning a skill rather than a chore.** Test: two friends, 10 runs each. Do they line up the laser on purpose, or just drift?
- [ ] **You can read a gate's trade-off in about 1 second while moving.** Test: icons, not text. After a gate scrolls past, can a first-time player say what they picked? Pass: ≥4 out of 5.
- [ ] **The trade-offs are real choices, not solved math.** Test: a headless sim (game logic with no rendering) runs 1,000 seeded runs per build. Pass: no single build wins on both horde clear time and boss kill rate.
- [ ] **A DPS-check boss feels fair.** Test: after a boss death, ask "why did you lose?" Pass: the answer names a gate choice. Fail: "no idea".
- [ ] **Friends open seed links.** Test: send 5 links, count the runs played. Pass: ≥3 out of 5.

## MVP Scope

**In:**

- Free horizontal movement (keyboard plus tap or drag on the left/right halves), automatic firing straight up
- Rat hordes with HP; contact damage to the cat
- Paired trade-off gates (number gates and weapon gates), with icons
- 4 weapons: pencil, laser, yarn ball, fishbone
- 1 boss type: a DPS check with a timer and HP that grows each time it appears, plus a DPS readout before it arrives
- A seeded PRNG for **all** spawning (`?s=` in the URL); `Math.random()` is banned in game logic, or the ghost goes out of sync
- Ghost replay recorded as input over time, plus a score to beat
- Score, death screen, instant restart
- A headless balance sim that reuses the game-logic module, with deterministic tests
- Game feel: hit-stop, damage-number pops, screen shake
- Static Phaser build deployed on Cloudflare (Workers static assets or Pages; confirm which is the current recommendation at setup time)
- Ghost store: a Worker with `POST /ghost` → KV under a short id, `GET /ghost/:id` to fetch it
  - Payload size cap (a 3-minute input log should be a few KB), reject anything larger
  - Basic per-IP rate limit on `POST`
  - KV TTL: 30 days
  - If the ghost fetch fails, the run still plays with the seed alone, without the ghost. KV is eventually consistent, so a ghost written seconds ago may not have reached a friend's region yet: retry for at least 70 s (Cloudflare documents "up to 60 seconds or more"), then fall back. Schedule in SPEC-client.md.

**Build order** (one target, staged so each piece is fun on its own):

1. Movement and shooting feel
2. Hordes
3. Trade-off gates
4. Boss
5. The other 3 weapons
6. Seed + ghost (client side, then the Worker + KV)
7. Balance sim pass
8. Friend playtest against the assumptions above

**Measurable outcome:** friends replay a shared seed (≥3/5 links opened) and the sim shows no dominant build.

## Not Doing (and Why)

- **A crowd of cats / clones.** "One cat" is the identity, and power is DPS.
- **Purely good gates (×2 vs −50).** They're non-choices, and the trade-offs are the game.
- **Boss attack patterns.** Each one would cost real design time. A DPS check gives gate choices their payoff for a tenth of the work.
- **Handmade levels / campaign.** Endless plus seeds already gives you shareable runs.
- **Meta-progression, unlocks, currency.** Every run should be equal so the ghost comparison is fair.
- **Accounts, leaderboards, any backend beyond the ghost store.** Seed + ghost covers the social loop.
- **Art assets, music.** Stickmen drawn in code plus a few SFX; polish goes into game feel, not sprites.
- **Gates guarded by rats.** Trade-off gates carry the cost of the choice instead. Revisit if the sim shows a dominant build.
- **An "A-first" checkpoint.** Chosen on purpose: the full build is the target from day one, so the friend playtest in step 8 is the only place the core loop gets validated. Don't skip it.

## Open Questions

- ~~Weapon swap vs number buffs?~~ Resolved: buffs carry over fully (SPEC-game-core § Weapons).
- ~~Boss timing?~~ Resolved: scroll speed ramps, boss every 500 m (SPEC-game-core § Lane generation).
- ~~How fast does KV propagate?~~ Resolved: up to 60 s or more per Cloudflare docs; see SPEC-ghost-api.md A5.
- **Deviations recorded in the spec (2026-11-08):** touch input is "chase the finger" instead of tapping left/right halves (finer positioning for laser and corridors; check it in the playtest), and the ghost API lives at `/api/ghost` instead of `/ghost`. See SPEC-client.md § Input and SPEC-ghost-api.md.
- **Balance metric (2026-11-08):** "horde clear time" became "horde clear rate" in balance-sim, because clear time only counts cleared hordes and rewards builds that let hard ones escape. See SPEC-balance-sim.md § Metrics.
- **Build order (2026-11-08):** the spec builds game-core first and the client last, the reverse of "movement and shooting feel first" above. Ghosts, the sim and cross-engine determinism all depend on core. Feel risk is covered by a throwaway feel spike run in parallel. See SPEC.md § Capability Map.
