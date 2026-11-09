# Spec: client

Module id: `client` · Path: `src/client/`, `index.html` · Depends on: `game-core`, `ghost-api` (HTTP) · Root spec: [SPEC.md](SPEC.md)

## Objective

The part people touch. It renders game-core state with Phaser 4 and turns keyboard and touch into input levels. It also makes hits feel good, shows the boss DPS check honestly, and runs the seed → ghost → share loop.

All game rules live in core. If the client decides something that affects the outcome, that's a bug.

## Failure modes (tests are written against these first)

| # | Failure | Effect | Guard → test |
|---|---|---|---|
| C1 | Client logic changes the outcome | Ghost desync; the sim measures a different game | State changes only via `step()`; reads via `view()` (deep-frozen copy in non-prod builds, so writes throw) → E2E 7b |
| C2 | A frame-time spike runs hundreds of catch-up ticks | Teleporting, an unseen death | `advance()` caps 5 ticks per frame; hidden tab resets → U-loop |
| C3 | Ghost fetch gives up before KV propagates | "No ghost" on a fresh link | Retry schedule through 70 s; Play never waits → U-retry, E2E 5 |
| C4 | Ghost from another `CORE_VERSION` replayed | Ghost walks through walls | `version_mismatch` → message → E2E 6 |
| C5 | Gate meaning shown only by colour | Colour-blind players can't read gates | Every half renders an icon + a `+`/`−` sign → U-labels |
| C6 | Test hooks ship to production | Anyone can script inputs or read internals | Hooks exist only in the `e2e` and dev builds → E2E 8 |
| C7 | Share fails silently | Friend gets a seed-only link without anyone knowing | Visible error plus a seed-only copy fallback → E2E 9 |
| C8 | Per-frame allocation in hot paths | GC stutter on phones | Pools keyed by entity id; pool sizes stay flat → E2E 10 |
| C9 | A ghost that re-simulates differently from what was recorded | Wrong ghost shown | Pre-simulate on load; require `ended` at exactly `ticks` with `score` matching → U-ghostcheck, E2E 6 |

## Builds

| Build | Command | Output | Hooks |
|---|---|---|---|
| Production | `npm run build` (`npm run typecheck && vite build`, as in SPEC.md) | `dist/` | none |
| E2E | `npm run build:e2e` (`vite build --mode e2e --outDir dist-e2e`) | `dist-e2e/` | `window.__catman` |
| Dev | `npm run dev` | Vite dev server, `/api` proxied to `http://localhost:8787` | `window.__catman` |

In dev, ghosts need `npm run dev:worker` running in another terminal; without it, ghost status shows `unavailable`.

`src/client/dev-hooks.ts` is loaded by a dynamic `import()` behind `if (import.meta.env.MODE !== 'production')`, which Vite removes from the production bundle. It calls `setFrozenViews(true)` and installs the hooks below. It imports only `src/core/index.ts`.

## Screens and flow

```
Boot ─▶ Title ──Play──▶ Run ──ended──▶ Death ──Again──▶ Run (same seed, same ghost if ready)
          ▲                                  └──New seed──▶ Title (new seed, ghost dropped, g removed from URL)
```

**Boot.** Parse the URL.
- `s` must pass `isSeed`. Otherwise generate 6 base36 chars (`crypto.getRandomValues`) and `history.replaceState` it in.
- If `isGhostId(g)`, start the ghost fetch in the background.

**Title.** Shows the seed, the ghost status and Play. Play is always enabled.

| Ghost status | Meaning |
|---|---|
| `none` | No `g` in the URL |
| `loading…` | Fetching or retrying |
| `checking…` | Pre-simulating (below) |
| `ready: 4,312 to beat` | Verified, will attach on Play (scores formatted by `formatScore`, in the HUD, `ghostStatus()` and `ui()` alike) |
| `ready (next run)` | Verified after Play was already pressed; attaches on the next Again |
| `unavailable` | Gave up, or 4xx other than 404 |
| `older version` | `version_mismatch` |
| `different seed` | Payload seed ≠ `s` (only possible with a hand-edited URL, since the share link always pairs them) |
| `doesn't match` | Pre-simulation failed (C9) |

**Run.** Shows:
- The playfield.
- HUD: score, HP, weapon icon, live single-target DPS (`simulateBossFight(mods, weapon, bossHpFor(view(run).bossesSpawned), 270)`, shown as `damageByReach / (reachTick / 60)`, recomputed only when mods or weapon change), and the ghost delta once attached.
- Boss warning panel on `bossWarning`: `BOSS · YOU 140/s · NEED 165/s · ON PACE` or `TOO WEAK`. Green or red, with the words so colour isn't the only signal.

**Death.** Shows score, cause, and the result against the ghost. Buttons:
- **Share run**: first build the payload and run `validateGhostPayload` on it. If that fails (in practice `inputs_too_large`: each input run costs at least 2 bytes, so passing 32,768 bytes within the 72,000-tick cap takes at least 16,165 runs (round-12 script, allowing for runs of 128+ ticks costing 3 bytes): an input change on average more than once every 4.5 ticks for the full 20 minutes), skip the `POST`, set `errorText` to "This run is too long to share as a ghost" and offer the seed-only link, the same fallback as E2E 9. Otherwise `POST /api/ghost`. On success, the link is `${origin}/?s=${seed}&g=${id}`, sent via `navigator.share` if present, else `navigator.clipboard.writeText`, and always shown as selectable text. The id is added to `localStorage["catman.myGhosts"]` (try/catch) so later fetches of it send `X-Catman-Own: 1`.
- **Again**: same seed; attaches the ghost if it's ready.
- **New seed**: back to Title with a new seed.

## Ghost fetch and verification (C3, C4, C9)

- `GET /api/ghost/:id` at t = 0, 2, 5, 10, 20, 40 and 70 s.
  - 404, any 5xx (including ghost-api's 503 `store_unavailable`), or a network error → wait for the next slot.
  - Other 4xx → `unavailable`.
  - 200 → validate.
  - After the 70 s attempt fails → `unavailable`.
- **Validate:** `validateGhostPayload`.
  - `version_mismatch` → `older version`.
  - Other failures → `unavailable`.
  - Seed ≠ `s` → `different seed`.
- **Pre-simulate (`checking…`):** a pure helper, `createGhostCheck(payload, levels)` in `src/client/ghostcheck.ts` (imports only `src/core/index.ts`, no Phaser or DOM), runs `createRun(seed)` plus `step()` over all `levels`. Its `advance(maxTicks)` call runs at most that many ticks and returns `{ done, verdict? }`; the Title scene calls it with 2,000 per frame so the screen stays responsive. Record the cat x for every tick into a `Float32Array` and the score every 60 ticks.
  - Require that `ended` fires on step `ticks` exactly, with `score === payload.score`; otherwise `doesn't match`.
  - During a run, the ghost cat is drawn from the recorded track, so no second core steps at render time. Past the ghost's last tick, its marker stays at its death x with its final score.

Worst case: 72,000 ticks at the ≥50k ticks/s core floor is under 1.5 s of chunked work on a desktop. On phones that's **unverified** (the bench floor is a desktop number). Measure it in the phone manual check, and if it's over 3 s, show a progress percent during `checking…`.

## Game loop (C1, C2)

`advance(accMs, deltaMs, hidden) → { steps, accMs }` is a pure helper in `src/client/loop.ts`:
- `acc += delta`.
- `steps = min(5, floor(acc / (1000/60)))`.
- `acc −= steps × (1000/60)`.
- If more than 5 steps were owed, `acc` resets to 0.
- `hidden` resets `acc` to 0 and returns 0 steps.

Each step: sample input → `step(run, level)` → `recorder.push(level)` → queue the events for juice. Once a step returns `ended`, the frame runs no further steps and the recorder is closed, so the log length equals `ended.tick`. Then render the latest `view(run)`. No interpolation in the MVP.

## Input

- **Keyboard:** `←`/`A` → −4, `→`/`D` → +4, both or neither → 0.
- **Pointer (touch, or mouse drag):** while held, `level = clamp(round((pointerXU − cat.x) / 60 × 4), −4, 4)`.
- The last-used device wins.
- **Deviation from the idea doc, on purpose:** the idea said "tap or drag on the left/right halves". Halves only give full-speed left or right, which makes fine positioning (lining up the laser, threading the corridor) clumsy on a phone. Chase-the-finger gives the same one-thumb feel with precise stops. Recorded in the idea doc's Open Questions for the playtest.
- **Mute:** `M` or a 🔇 button, persisted in `localStorage` (try/catch, defaults to on if storage throws).

## Rendering and feel

- **Canvas:** logical 540 × 960, fit-to-screen scaling with auto-centre, portrait. No image or audio files. That's `Phaser.Scale.FIT`, which exists in the `phaser@4.2.1` types (checked: a stub client using it type-checks in the round-11 scratch project).
- **Drawn with Graphics:**
  - Stickman cat: head circle, ear triangles, stick body and legs, a curved tail.
  - Stickman rats: round ears, a tail line. The boss is the same rat at 4× with a crown.
  - Weapons: yellow pencil stick, cyan beam, red yarn circle with a trail line, grey fishbone spine with ribs.
- **Gates (C5):** `gateLabel(gate, heldWeapon) → { icons: IconId[]; signs: ('+' | '−')[]; text: string }`, a pure function in `src/client/labels.ts`.
  - Every half gets ≥1 icon, and each stat change gets a sign.
  - A weapon half shows the weapon silhouette. If you hold that weapon, it shows the fallback's icons instead (core F10).
  - Colours (green buff, red debuff) are extra.
- **Juice (driven by core events; none of it changes state):**
  - Pooled damage numbers (max 40 alive, 400 ms life).
  - Kill puffs.
  - Camera shake on `catHit` (4 px, 120 ms) and `bossKilled` (10 px, 300 ms).
  - A white flash on `catHit` (80 ms).
  - Hit-stop is core's `freezeTicks`: the client renders the frozen state, so frozen frames are visible by construction.
- `prefers-reduced-motion: reduce` turns off shake and flash.
- **SFX:** at most 5 (shoot, hit, gate, boss warning, death), synthesised with Web Audio `OscillatorNode` and gain envelopes. The audio context unlocks on first input.

## Test hooks (e2e and dev builds only)

`window.__catman = { seed, tick(), hash(), catX(), ghostStatus(), poolStats(), ui(), playLog(levels), coreReplay(seed, levels) }`

- `playLog(levels)` starts a **fresh run on the current seed** (exactly what Play does) with keyboard and pointer input replaced by the log. It runs through the real client frame handler: the same `advance()` with its cap of 5 steps per frame, rendering and juice on, but fed a synthetic `delta` of 5 ticks per animation frame so it doesn't take real minutes. It resolves with `{ hash, ended }` once the log runs out or the run ends. Played with the `dies` fixture, it produces a **real** death through inputs alone, so the recorded log is a valid ghost.
- `coreReplay(seed, levels)` is headless: `createRun` + `step` in the page, no rendering. It returns `hashState`.
- `poolStats()` returns live and allocated counts per pool.
- `ui()` returns the canvas UI as data: `{ screen, deathScore, shareLink, errorText, ghostLine }`. E2E reads this, not pixels. Numbers are formatted by one helper, `formatScore(n)` (`Intl.NumberFormat('en-US')`, so 4312 → `4,312`), used by both the display and `ui()`.

There is no "force death" hook. A death that isn't in the input log would produce a ghost that can never verify (C9).

## Tests

**Unit** (`vitest --project client`, Node, no DOM; pure helpers only, in the gate lane):

| Test | Checks |
|---|---|
| U-url | Seed parsing and generation, `g` handling, link builder |
| U-pointer | Pointer → level mapping, including clamps and the dead centre |
| U-loop (C2) | `advance` with delta 16.67 → 1 step; 100 → 5 steps and `acc` reset; hidden → 0 steps and reset; 1,000 random deltas never give > 5 steps |
| U-retry (C3) | The fetch state machine with a fake clock and a scripted response list: four 404s then 200 → `ready`; all 404 → `unavailable` after the 70 s attempt; 403 → `unavailable` immediately |
| U-labels (C5) | `gateLabel` for every gate from `generateSegment` over seeds `0..99` × first 3,000 m (the same sample as core's T-gates at gate size): each half has ≥1 icon and one sign per stat change; holding the offered weapon returns the fallback's icons |
| U-ghostcheck (C9) | Runs `createGhostCheck` in Node on `src/core/fixtures/dies.json` (imported `with { type: 'json' }`): the fixture as-is gives `ok`; with `score` off by 1, or `ticks` one short (levels cut to match), it gives `doesn't match` |

**E2E** (`e2e/*.spec.ts`, Playwright. `webServer.command`: `npm run build:e2e && npx wrangler dev --env e2e --port 8787`. Runs in Chromium, Firefox, WebKit):

1. **Boot:** `/` loads, a canvas exists, no console errors, URL gains a valid `s`.
2. **Seed:** `/?s=abcd` → `__catman.seed === 'abcd'`; `/?s=BAD!` is replaced with a valid seed.
3. **Input:** holding `ArrowRight` 500 ms increases `catX()`; releasing stops it within 10 ticks.
4. **Share round trip:** open `/?s=<dies.seed>` → `playLog(dies.levels)` (which starts the run itself; no Play click) → `ui().deathScore === dies.ended.score` → click Share → `ui().shareLink` has `g=` → open in a new context → `ghostStatus()` becomes `ready: ${new Intl.NumberFormat('en-US').format(dies.ended.score)} to beat` within 10 s. The test repeats `formatScore`'s one-line definition rather than importing client code (dependency rule 4).
5. **Ghost retry (C3, ghost-api A5):** route `/api/ghost/*` to 404 four times, then a payload built from the `dies` fixture; `page.clock` fast-forwards; status ends `ready`. All 404s → `unavailable`.
6. **Version mismatch and bad ghosts (C4, C9):** `dies` payloads routed with `coreVersion: 0` → `older version`, and with `ended.score + 1` as `score` → `doesn't match`; Play still works in both cases.
7. **Determinism:**
   Fixture names: `golden` = `src/core/fixtures/replay.json`, `dies` = `src/core/fixtures/dies.json`, both imported into the spec files `with { type: 'json' }`. The names carry no version (the version is inside), so a `CORE_VERSION` bump doesn't touch these imports.
   - **(a)** `coreReplay(golden.seed, golden.levels)` equals `golden.hash`.
   - **(b) (C1)** `playLog(golden.levels)` on `/?s=golden1` through the live loop with rendering equals the same hash. `view()` is a frozen copy in this build, so a client write during render throws and fails the test.
8. **Prod bundle (C6):** reads the `dist/` that `npm run check` builds before e2e (SPEC.md), and fails if `dist/` is missing. No file may contain `__catman`, `playLog` or `coreReplay`.
9. **Share failure (C7):** `POST` routed to 429 → `ui().errorText` is non-empty, and the "Copy seed-only link" button is present (`ui().shareLink` is the seed-only link).
10. **Pools (C8):** `playLog` of golden pattern 0 for 720 ticks; after a 120-tick warm-up, `poolStats()` allocated counts don't grow.

**Manual checks** (in the PR template; each has a pass condition):

| Check | Pass condition |
|---|---|
| Hit feedback | 2 of 2 testers, asked "when did you get hit?" during play, answer correctly without looking at the HP display |
| Phone | Portrait, touch drag: a tester threads 3 consecutive walls without a hit within 5 attempts |
| Performance | Chrome DevTools, 6× CPU throttle, boss + horde scene: ≥50 fps over 10 s (Performance panel screenshot in the PR) |
| Gate readability | Idea-doc assumption: ≥4 of 5 first-time players name what they picked after a gate passes |

## Success Criteria

- [ ] Unit tests pass in the gate lane; E2E 1–10 pass in Chromium, Firefox and WebKit.
- [ ] Manual checks pass and are recorded in the PR.
- [ ] `dist/` contains only `index.html`, JS and CSS (no image or audio files).

## Open Questions

- A local "beat your own best" ghost (`localStorage`, no upload)? Cheap but scope; proposed **not in MVP**.

## View toggle: flat and 2.5D

`src/client/camera.ts` projects world (x, y) to the screen. It's client-only: core, ghosts, replays and hashes don't see the camera.
- **flat:** the original top-down view (identity projection). This is the default.
- **tilt (2.5D, behind the cat):**
  - `depth = catLineY − y` and `scale = zNear / (zNear + depth)`, with zNear 1300.
  - Screen x shrinks toward the centre line, and screen y runs toward a horizon set so that world y = 0 lands at screen y 70 (about 0.6 scale).
  - The cat row keeps scale 1, so pointer x maps 1:1 and input code is unchanged.
  - Rectangles (lane stripes, gates, beams) draw as projected quads, and lane edges are outlined.
  - Sprites draw under a translate+scale, far to near. Gate labels, damage numbers and puffs are projected too.
- **Switching:** the button bottom-right ("2.5D" / "Top") or the V key. The choice is stored in `localStorage['catman.view']`; `?view=flat|tilt` overrides it.
- **Tests:** `camera.test.ts` covers identity, the cat row, monotone shrink, lane top on screen at moderate scale, and URL/storage precedence. E2E 11 covers the toggle, persistence, the URL override and no console errors in 3 browsers.
- **Known cost:** far rats and gates draw at about 0.6 scale, so gates are harder to read early. This needs a play check.

## CORE_VERSION 9 client changes

- **2.5D is the default view.** `parseView` falls back to `tilt`; `?view=flat` or the toggle still switches, and the choice is remembered.
- **Narrow gate boxes** drawn at `gates.widthU`, and a "missed" popup on `gateMissed`.
- **Gate labels are emoji + number, no words** (`src/client/labels.ts`): `📏 +30%` over `⏩ −10%`, additive stats as `🗡️ +1`, a weapon gate as its emoji alone (bigger). A client test asserts no letters in any label.
- **No boss win/lose banner.** The "YOU x/s · NEED y/s · ON PACE / TOO WEAK" panel is gone; the boss warning is only the sound. The HUD still shows your DPS.

## Boss telegraph (CORE_VERSION 10)

- On `bossIncoming`, an emoji line appears at the top centre (40 px): `bossIcons(variant)` gives 👑 for plain, 🐀 for horde, ⚡ for frenzy, 👑👑 for twins, and joins combos with a space. There are no words, like the gate labels.
- It stays visible through the fight and hides on `bossKilled` and when the screen leaves `run`.
- Each variant plays its own sound at `bossIncoming` (`horde`, `frenzy`, `twins`; plain plays `warning`). `bossWarning` still plays `warning`.
- Twins are drawn as two bosses, each with its own HP bar.
- `ui().bossIcons` exposes the line (null when hidden). U-boss-icons tests the mapping, and E2E 13 checks it during the golden replay's boss 0 and that it is gone on the death screen.

## Frenzy look and firing sounds (CORE_VERSION 11)

- **Frenzy rats** (`segmentK === FRENZY_K`, exported from core) are drawn purple (`#b26bff`), with three fading dots trailing above them, since they run down the screen.
- **Firing sounds.** Before this change no firing sound ever played: `'shoot'` existed but nothing called it. Each weapon now has its own voice: pencil click, laser hum, yarn "thwup", fishbone chirp.
  - `fireSfx(weapon, prevId, nextId, beamOn)` picks the voice. A projectile weapon plays when `nextProjectileId` advanced during the step. The laser plays while it is on (not frozen, run not over).
  - Each voice is throttled by `MIN_GAP_S` (0.08–0.18 s).
  - The scene keeps `lastShotId` between steps and resets it on each new run.
  - U-fire-sfx tests the rule.
