# Spec: Catman

Source idea: [docs/ideas/catman.md](docs/ideas/catman.md). This root spec holds the capability map, shared stack, commands, conventions and boundaries. Each module has its own spec, listed below; the map is the index of what exists.

## Objective

A vertical endless runner in the browser. One stickman cat moves freely left and right and auto-fires straight up at rat hordes.
- Paired **trade-off gates** change its weapon stats; **weapon gates** swap its weapon (pencil, laser, yarn ball, fishbone).
- Every 500 m a boss rat walks down as a DPS check.
- Runs are seeded. Sharing a run sends a friend a link to the identical lane, raced against your **ghost**.

**User:** Felipe and friends, on desktop and phone browsers, sharing links in a group chat.

**Outcomes this moves** (measured, not felt):

| Outcome | Target | Evidence |
|---|---|---|
| Friends open shared runs | ≥3 of 5 shared links opened by someone else | Felipe records the 5 ids in the idea doc. ghost-api log: ids with a `GET → 200` where `own: false`. This measures opens, not plays; the playtest confirms that opens turned into plays. Ids from Felipe's own device tests (e.g. the phone deploy check) are left out of the 5. |
| Builds are real choices | No weapon build dominates another by ≥0.05 on both horde clear rate and boss-0 kill rate | balance-sim `dominance.json` (empty) |
| Gates readable at speed | ≥4 of 5 first-time players name what they picked | Playtest notes in the idea doc |
| Boss losses feel fair | ≥4 of 5 boss deaths across testers explained by naming a gate choice | Playtest notes in the idea doc |

## Capability Map

| Module id | Responsibility | Depends on | Spec |
|---|---|---|---|
| `game-core` | Pure deterministic game logic on a fixed 60 Hz tick: lane generation, cat, rats, weapons, gates, boss, scoring, input log codec, boundary validators | — | [SPEC-game-core.md](SPEC-game-core.md) |
| `ghost-api` | Cloudflare Worker: static assets, `POST /api/ghost`, `GET /api/ghost/:id`, KV with a 30-day TTL, size cap, rate limit | `game-core` (`ghost.ts` only) | [SPEC-ghost-api.md](SPEC-ghost-api.md) |
| `balance-sim` | Headless Node CLI: seeded bot runs per build, report, `--check` against frozen targets | `game-core` | [SPEC-balance-sim.md](SPEC-balance-sim.md) |
| `client` | Phaser 4 front end: render, input, HUD, feel, SFX, seed/ghost URLs, share | `game-core`, `ghost-api` (HTTP) | [SPEC-client.md](SPEC-client.md) |

**Build order:** `game-core` → `balance-sim`, `ghost-api` (parallel) → `client`

By the time pixels exist, the rules are deterministic, tested and roughly balanced. The client's hard part is game feel, built on a stable core.

**Deviation from the idea doc's build order** ("movement and shooting feel first"): the spec builds core first, because the ghost, the sim and the cross-engine guarantee all depend on core being right. The cost is that feel is validated later. **Mitigation:** the client's first task is a throwaway feel spike (Phaser canvas, cat movement and auto-fire against static rats, no core), timeboxed to one session and deleted after. It runs in parallel with `game-core`, and anything it learns feeds back into `config.ts` start values.

**Dependency rules (lint, `no-restricted-imports`):**
1. `src/core/**` imports only `src/core/**`.
2. `src/sim/**` and `src/client/**` import core only via `src/core/index.ts`.
3. `worker/**` imports only `src/core/ghost.ts` and its own files.
4. Nothing outside a module imports `src/client/**`, `src/sim/**` or `tools/**` (files inside each import each other freely). One exception: `e2e/global.d.ts` may `import type { CatmanHooks }` from `src/client/dev-hooks.ts`, which is erased at build time.
5. **Override:** `src/core/testing.ts` may be imported by `*.test.ts` files and by `tools/**` (the bench needs `runFromScenario` and `corridorFollower`), and nothing else, including e2e and dev hooks, which use only `index.ts` (e2e and any `*.test.ts` may also import the fixture JSON files in `src/core/fixtures/`, which are data, not code, always with `with { type: 'json' }`: under `"type": "module"`, Playwright refuses a plain JSON import, and one such file makes the run list 0 tests and exit 1). Where this conflicts with rule 2, rule 5 wins.
6. `tools/**` imports core only via `src/core/index.ts` and `src/core/testing.ts`.

## Tech Stack

Versions and peer ranges checked with `npm view` on 2026-11-08. Ranges are floors; the lockfile pins exact versions.

| Package | Range | Why this one / this version |
|---|---|---|
| npm | `>=11` | npm 10.9.4, which ships with Node 22.22.0, crashes installing `vitest@4.1.12` (`edgesOut` error, 3 of 3 fresh installs in the round-10 review); npm 11 installs it. One-time `npm install -g npm@11`, enforced by `engines.npm` plus `engine-strict=true` in `.npmrc`. |
| Node | `>=22.22` | `wrangler@4.158.0` declares `engines.node >=22.0.0`. Node 22.22 runs `.ts` natively through type stripping, including `.ts` `worker_threads` workers (both checked locally), so the sim needs no `tsx`. |
| `typescript` | `~5.9.3` | Type-check only. `typescript-eslint@8.72.1` peer range is `>=4.8.4 <6.1.0`, so 7.x is out. 6.0.3 is inside that range, but 5.9 is the line the scratch project checked; moving to 6.0 is a later, separate change. |
| `phaser` | `^4.2.1` | Engine chosen in ideation. Client only. Ships types. |
| `vite` | `^8.3.6` | Dev server and client build. |
| `vitest` | `^4.1.12` | The Cloudflare plugin accepts `^4.1.0 \|\| ^5.0.0`; 4.1.12 is the line checked in the scratch project. |
| `@cloudflare/vitest-plugin` | `^1.6.0` | Worker tests inside workerd with local KV and the ratelimit binding. It depends on `wrangler` 4.158.0. **Not** `@cloudflare/vitest-pool-workers`: `npm view` marks it "renamed to @cloudflare/vitest-plugin. This package will not receive future updates", and its 0.23.0 bundles a workerd that rejects the 2026-11-08 compatibility date (`ERR_RUNTIME_FAILURE`, round-11 review). Under 1.6.0 with that date, a scratch worker test ran: the limiter allowed 10 of 12 calls from one IP and still allowed a second IP, and `GHOSTS.list()` reported `expiration`. |
| `wrangler` | `^4.158.0` | Dev, deploy, KV. The ratelimit binding needs ≥4.36.0 ([Rate Limiting docs](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)). |
| `@playwright/test` | `^1.65.0` | E2E plus cross-engine determinism (Chromium, Firefox, WebKit). |
| `eslint` + `typescript-eslint` | `^10.14.0` + `^8.72.1` | Flat config. Enforces dependency rules and core bans. |
| `@types/node` | `^22.20.5` | Node types for `tsconfig.sim.json` only (`worker_threads`, `os`, `fs` in `src/sim/` and `tools/`). vitest lists it as an *optional* peer, so `npm ci` won't install it unless it's declared. `tsconfig.core.json` keeps `types: []`. |

No other runtime or dev dependencies. Adding one is **Ask first**.

**Hosting: Cloudflare Workers with static assets.** One Worker serves the build and the API on one origin, so there's no CORS. The [migration guide](https://developers.cloudflare.com/workers/static-assets/migrate-from-pages/) says Workers has "a distinctly broader set of features" than Pages. Third-party write-ups say Cloudflare recommends Workers for new projects; the official pages I read don't say that. The one-origin setup is the reason for this choice.

**Storage:** Workers KV. **Abuse cap:** Workers Rate Limiting binding (GA per the [2025-09-19 changelog](https://developers.cloudflare.com/changelog/post/2025-09-19-ratelimit-workers-ga/)).

## Commands

```bash
npm ci                         # install from lockfile; `prepare` sets core.hooksPath=.githooks
npx playwright install --with-deps   # one-time: browsers + OS libraries for e2e (WebKit and Firefox need them on Linux/WSL; may ask for sudo)
npm run dev                    # vite on http://localhost:5173; /api proxied to :8787 (run dev:worker alongside for ghosts)
npm run dev:worker             # vite build && wrangler dev → http://localhost:8787 (prod build, local KV)
npm run build                  # npm run typecheck && vite build → dist/
npm run build:e2e              # vite build --mode e2e --outDir dist-e2e  (test hooks on)
npm run typecheck              # wrangler types && tsc -p tsconfig.core.json && tsc -p tsconfig.sim.json && tsc -p tsconfig.client.json && tsc -p tsconfig.worker.json && tsc -p tsconfig.e2e.json
npm run lint                   # eslint .
npm run test:gate              # vitest run --project core --project sim --project client   (pre-commit, <2 s; the root vitest.config.ts doesn't load the Cloudflare plugin, which would add ≈0.35 s)
npm test                       # vitest run && vitest run -c vitest.worker.config.ts   (core, sim, client; then worker. `tools` holds only the bench, which `vitest run` skips)
npm run test:e2e               # playwright test   (webServer: build:e2e + wrangler dev --env e2e)
npm run check                  # lint && test && build && test:e2e   (build includes typecheck; dist/ is needed by E2E 8)
npm run bench                  # vitest bench --run --project tools   (periodic; tools/core.bench.ts; --run so it doesn't enter watch mode)
npm run sim -- --builds all --runs 1000 --check   # balance sweep; exit 1 if a target fails (periodic)
npm run sim:periodic           # CATMAN_FULL=1 vitest run --project core --project sim   (full-size property tests)
npm run fixture:regen          # node tools/regen-fixtures.ts   (only after bumping CORE_VERSION)
npm run deploy                 # npm run build && wrangler deploy   (Ask first: production)
```

`npm run sim` is `node src/sim/cli.ts`, with no build step. The pre-commit hook `.githooks/pre-commit` runs `npm run lint && npm run test:gate`; there's no hook-manager dependency.

**TypeScript configs.** Five standalone files, no project references (which avoids the `composite` + `noEmit` interplay). Every one has these shared options:

```jsonc
"target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler",
"strict": true, "noUncheckedIndexedAccess": true, "noEmit": true,
"allowImportingTsExtensions": true, "erasableSyntaxOnly": true,
"verbatimModuleSyntax": true, "skipLibCheck": true, "resolveJsonModule": true
```

| File | `lib` | `types` | `include` |
|---|---|---|---|
| `tsconfig.core.json` | `["ES2022"]` | `[]` | `src/core/**/*.ts`, `src/core/**/*.json` |
| `tsconfig.sim.json` | `["ES2022"]` | `["node"]` | `src/sim/**/*.ts`, `tools/**/*.ts`, `*.config.ts` |
| `tsconfig.client.json` | `["ES2022", "DOM", "DOM.Iterable"]` | `["vite/client"]` (for `import.meta.env`) | `src/client/**/*.ts` |
| `tsconfig.worker.json` | `["ES2022"]` | `["@cloudflare/vitest-plugin/types"]` | `worker/**/*.ts`, `worker-configuration.d.ts` |
| `tsconfig.e2e.json` | `["ES2022", "DOM"]` | `["node"]` | `e2e/**/*.ts` (with `e2e/global.d.ts` declaring `window.__catman` from a type-only import of `CatmanHooks` in `src/client/dev-hooks.ts`) |

Why these:
- With no DOM in `lib`, core, sim and the worker can't use DOM APIs: tsc rejects them. Core also has `types: []`, so a Node global in `src/core` fails too.
- `verbatimModuleSyntax` makes a type imported without `import type` a type error. Without it, `tsc` and vitest accept the import, but Node's type stripping keeps it and crashes at run time. `npm run sim` and `fixture:regen` would then fail while every gate is green.
- `skipLibCheck` stops dependencies' own `.d.ts` files from failing the build. vitest's types reference `setTimeout`, `EventTarget` and `WebSocket`, which don't exist under core's lib. Our own files are still fully checked: in the round-10 experiment, the only errors left were a deliberate `Buffer`/`process` use in a core file.
- **Worker types.** `wrangler types` generates `worker-configuration.d.ts` from `wrangler.jsonc`.
  - In wrangler 4.158 that file contains the Workers runtime types; its CLI says it "supersedes @cloudflare/workers-types". So that package is **not** a dependency, because loading both is a duplicate-definition error (TS6200, TS2374).
  - It also declares the `Env` interface with `GHOSTS` and `GHOST_POST_LIMIT` as `Cloudflare.Env`, which the plugin's `cloudflare:test` types use.
  - It's regenerated on every typecheck and gitignored, so it can't go stale.
  - Those runtime types make `TextDecoder`'s options require `ignoreBOM`, so the worker writes `{ fatal: true, ignoreBOM: false }`.
- **Checked** in the round-11 scratch project (the full stack table installed with npm 11, plus stub sources that exercise each config's hard cases: `import.meta.env`, `Phaser.Scale.FIT`, `node:worker_threads`, `cloudflare:test`, a fixture JSON import in e2e): `wrangler types` and all five `tsc -p` runs exit 0.
- **Offline:** `wrangler types` succeeded in a network namespace with loopback up and no internet route (round-12 experiment). With loopback down it fails (`fetch failed`), which only a broken sandbox would hit.

`package.json` has `"type": "module"`, so Node runs the `.ts` sim and tools as ESM without a warning per file. `eslint.config.js` starts with a global `ignores: ["dist/", "dist-e2e/", ".wrangler/", "worker-configuration.d.ts", "playwright-report/", "test-results/"]`.

## Project Structure

```
catman/
├── SPEC.md, SPEC-<module>.md    root + one spec per module id
├── docs/ideas/catman.md         idea one-pager; playtest results and the 5 shared ids get appended here
├── index.html                   Vite entry
├── src/
│   ├── core/                    game-core: pure TS, no DOM lib
│   │   ├── index.ts             the public surface
│   │   ├── ghost.ts             codec, payload, boundary validators
│   │   ├── testing.ts           test-only helpers (see dependency rule 5)
│   │   ├── config.ts            every tunable, one frozen object
│   │   ├── version.ts           CORE_VERSION
│   │   ├── *.ts / *.test.ts     one concern per file, tests colocated
│   │   └── fixtures/            golden replay fixtures (JSON only)
│   ├── sim/                     balance-sim: cli.ts, bots.ts, targets.ts, worker.ts
│   └── client/                  client: scenes, loop.ts, labels.ts, input, sfx, dev-hooks.ts
├── tools/                       Node-only scripts on core: regen-fixtures.ts, core.bench.ts (vitest project `tools`)
├── worker/                      ghost-api: index.ts + tests
├── e2e/                         Playwright specs
├── .githooks/pre-commit
├── wrangler.jsonc  vite.config.ts  vitest.config.ts  vitest.worker.config.ts  playwright.config.ts  eslint.config.js
└── tsconfig.core.json  tsconfig.sim.json  tsconfig.client.json  tsconfig.worker.json  tsconfig.e2e.json
```

Gitignored: `dist/`, `dist-e2e/`, `.wrangler/`, `worker-configuration.d.ts`, `.dev.vars`, `node_modules/`, `test-results/`, `playwright-report/`. Sim output always goes to `/tmp/catman-sim/`.

## Code Style

```ts
// src/core/cat.ts. Logic files: plain data in and out, named exports, no classes, no module state.
// (Exceptions by design: the GhostDecodeError class, and the single setFrozenViews flag in view.ts.)
import type { Cat, InputLevel } from './types.ts';
import { config } from './config.ts';
import { clamp } from './math.ts';

/** Moves the cat one tick toward the speed its input asks for. Mutates `cat`. */
export function stepCat(cat: Cat, input: InputLevel): void {
  const { maxSpeedUPerTick, accelUPerTick2, widthU } = config.cat;
  const halfWidthU = widthU / 2;
  const targetVx = (input / 4) * maxSpeedUPerTick * cat.mods.moveSpeedMult;
  cat.vx += clamp(targetVx - cat.vx, -accelUPerTick2, accelUPerTick2);
  const x = clamp(cat.x + cat.vx, halfWidthU, config.world.widthU - halfWidthU);
  if (x !== cat.x + cat.vx) cat.vx = 0; // pressed against a wall = at rest (the gate-reach invariant depends on it)
  cat.x = x;
}
```

- Files `kebab-case.ts`; types `PascalCase`; values `camelCase`. Tunables live in `config.ts` (only `CORE_VERSION` is `UPPER_CASE`).
- Named exports only. No default exports, no `enum`, no `namespace` (`erasableSyntaxOnly`); string-literal unions instead.
- Relative imports carry `.ts`.
- Units in names wherever they could be confused: `U` world units, `PerTick`, `M` metres, `Seconds`, `Bytes`.
- `strict` and `noUncheckedIndexedAccess`. No `any`; `unknown` plus a validator from `src/core/ghost.ts` at every boundary.
- No formatter dependency; the editor's TypeScript formatter defaults apply.

## Testing Strategy

There's no LLM in this product, so no evals. The periodic lane is the balance sweep, the full-size property tests and the bench.

| Lane | What | Command | When | Budget |
|---|---|---|---|---|
| Gate | core, sim and client-helper unit/property tests at gate size (≈70k simulated ticks by tally of the gate sizes, ≈1.4 s at the bench floor; the real wall time is measured and recorded in the first game-core PR) | `npm run test:gate` | pre-commit | <2 s, never flaky |
| Full | gate + worker tests + typecheck + lint | `npm run typecheck && npm run lint && npm test` | before push | <60 s |
| E2E | real browsers against `wrangler dev --env e2e` | `npm run check` (E2E 8 needs the production `dist/` it builds; `npm run test:e2e` alone works only after `npm run build`) | before push; on any `src/core` or `src/client` change | <3 min |
| Periodic | full-size property tests, readout honesty, bot floor, sweep `--check`, bench | `npm run sim:periodic`, `npm run sim -- --builds all --runs 1000 --check`, `npm run bench` | before a balance PR and before deploy | sweep <5 min on Felipe's dev machine |

`npm run check` = Full + production build + E2E, under 4 min.

**Rules:**
- **Failure modes first.** Each module spec lists its failure modes before its requirements, each maps to a named test, and tests are written before the code they cover.
- **Property tests over examples** for universal claims. Seed lists are fixed, so failures reproduce. Gate size by default; `CATMAN_FULL=1` for full size.
- **How tests see `CATMAN_FULL`:** core tests can't read `process.env` (core's `types: []` makes it a type error). `vitest.config.ts` passes it in with `test.provide: { full: process.env.CATMAN_FULL === '1' }`, tests read it with `inject('full')` from `vitest`, and `src/core/vitest-context.d.ts` declares `declare module 'vitest' { interface ProvidedContext { full: boolean } }`. Checked in the round-12 scratch project.
- **One deliberate change-detector:** `src/core/fixtures/replay.json` (its `coreVersion` field must equal `CORE_VERSION`). It fails whenever core behaviour changes, because a behaviour change without a `CORE_VERSION` bump silently desyncs every stored ghost. Its message explains the bump and regen. No other test pins tunables or exact numbers; tests assert invariants.

## Boundaries

**Always**
- Route every lane decision in core through the per-segment RNG (SPEC-game-core § Lane generation).
- Bump `CORE_VERSION` and regenerate the fixture in the same commit as any core behaviour or `config.ts` change.
- Ship tests in the same commit as the behaviour. Run `npm run check` before pushing.
- The **receiving side** validates every value crossing a boundary with `src/core/ghost.ts` (`isSeed`, `isGhostId`, `validateGhostPayload`). The Worker validates POST bodies and path ids; the client validates URL params and GET bodies. KV values come back from the Worker unvalidated, because only the client can turn a stale `coreVersion` into the right message (SPEC-ghost-api).

**Ask first**
- Adding a dependency.
- Changing the ghost wire format, KV TTL, size cap or rate limit.
- Changing balance targets (`src/sim/targets.ts`).
- Creating Cloudflare resources or running `npm run deploy` (production: Felipe runs or confirms).
- Moving a module boundary or editing the capability map.

**Never**
- `Math.random`, `Date`, `performance`, `crypto`, timers, or banned math (`sin`, `cos`, `atan2`, `exp`, `log`, `pow`, `**`, and `sqrt` by choice) in `src/core`. Reason: SPEC-game-core § Determinism contract.
- Import `phaser` outside `src/client`, or DOM APIs in `src/core`, `src/sim` or `worker`.
- Store anything but ghost payloads in KV. Log IPs or request bodies.
- Commit build output, sim output or secrets. Deploy the `e2e` env.

## Success Criteria (project level)

- [ ] Every module spec's success criteria pass.
- [ ] `npm run check` is green on a clean clone after `npm ci && npx playwright install --with-deps`.
- [ ] Deployed to `catman.<subdomain>.workers.dev`; a run shared from desktop is played with its ghost on a phone over mobile data (both devices named in the PR).
- [ ] `npm run sim -- --builds all --runs 1000 --check` exits 0.
- [ ] Playtest with ≥2 friends done, and each outcome row above has its measured value and pass/fail appended to `docs/ideas/catman.md`.

## Open Questions

1. **Golden fixture:** this spec allows exactly one change-detector test (above). Approve, or rely only on the cross-engine replay test plus manual `CORE_VERSION` discipline?
2. **Domain:** `workers.dev` is enough for friends. A custom domain changes only `wrangler.jsonc` routes.
3. **Bot vs human:** if playtests disagree with the sim, proposed: playtest wins, and the bot is fixed to match.
4. **Pencil vs boss 0** and **kills only for score:** design-intent questions in SPEC-game-core § Open Questions.
