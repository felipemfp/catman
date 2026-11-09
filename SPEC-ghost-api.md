# Spec: ghost-api

Module id: `ghost-api` · Path: `worker/` · Depends on: `game-core` (`src/core/ghost.ts` only) · Root spec: [SPEC.md](SPEC.md)

## Objective

One Cloudflare Worker that:

1. Serves the static client build (Workers static assets).
2. Stores a finished run's ghost and returns a short id: `POST /api/ghost` → `{ id }`.
3. Returns that ghost to anyone holding the link: `GET /api/ghost/:id`.

It is the only server-side piece, and it should stay boring: no accounts, no leaderboard, no score verification. Scores are trusted between friends, and the client checks a ghost's integrity by re-simulating it (SPEC-client).

**Deviation from the idea doc:** the idea sketched `/ghost`. This spec uses `/api/ghost`, so every API route sits under one prefix that can never collide with a static file.

## Failure modes (tests are written against these first)

| # | Failure | Effect | Guard → test |
|---|---|---|---|
| A1 | Oversized body, with no `Content-Length` or a false one | Memory or CPU blow-up, junk in KV | Stream-read with a hard byte cap, independent of headers → T-A1 |
| A2 | Malformed or hostile JSON | Bad ghost stored; the friend's title screen breaks | `validateGhostPayload` before any write; store only `canonicalGhostJson` → T-A2 |
| A3 | Script spamming `POST` | Free-plan KV write quota burned | Rate limiting binding, keyed per client IP → T-A3 |
| A4 | A 404 for a not-yet-visible ghost gets cached | The friend never sees it | `Cache-Control: no-store` on every miss and error → T-A4 |
| A5 | KV eventual consistency: a write can take **60 s or more** to show up elsewhere ([How KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/): "Changes may take up to 60 seconds or more to be visible in other global network locations") | "Ghost not found" right after sharing | API returns honest 404s; client retries through 70 s → **SPEC-client E2E 5** |
| A6 | Ghosts never expire | KV grows forever | `expirationTtl: 2592000` (30 days) on every put → T-A6 |
| A7 | `/api/*` swallowed by an SPA fallback | API returns HTML | No `not_found_handling`, so unmatched requests reach the Worker ([Worker script routing](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/): "If an appropriate static asset if not found, Cloudflare will invoke your Worker script.") → T-A7 |
| A8 | Logs leak personal data | Privacy problem | Whitelisted log fields; no IP, no body → T-A8 |
| A9 | Guessable or colliding ids | Enumeration or overwrite | 8-char base62 from `crypto.getRandomValues` with rejection sampling (62⁸ ≈ 2.2 × 10¹⁴), plus one existence check before `put` → T-A9 |
| A10 | The rate limiter itself errors | Every share fails | Fail open, log `error: "rl_error"`; the KV daily quota is the backstop → T-A10 |

## API

All `/api/*` responses are JSON (`application/json; charset=utf-8`). Errors are `{ "error": "<code>", "field"?: "<name>" }`. Same origin only, so there are no CORS headers. Every non-2xx and every POST response carries `Cache-Control: no-store`.

### `POST /api/ghost`

| Step, in order | Fails with |
|---|---|
| Path is exactly `/api/ghost`. `/api/ghost/` (trailing slash) belongs to the GET route below, so `POST /api/ghost/` → 405 `Allow: GET` | — |
| Method must be POST (HEAD and OPTIONS included) | 405 `method_not_allowed`, `Allow: POST` |
| `Content-Type`, lowercased, starts with `application/json` | 415 `unsupported_media_type` |
| `GHOST_POST_LIMIT.limit({ key: ip })`, with `ip = CF-Connecting-IP ?? "unknown"`. I expect the header to be missing only in local dev (unverified); if it's missing in production, every client shares one bucket, which T-A3 can't detect, so check it once after deploy. | 429 `rate_limited`; if `limit()` throws → continue (A10) |
| Stream-read the body; abort once it exceeds `ghostLimits.maxBodyBytes` (49,152) | 413 `body_too_large` |
| Empty body, invalid UTF-8 (`new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })`), `null`, or `JSON.parse` throws | 400 `bad_json` |
| `validateGhostPayload(body)` | 400 `<GhostErrorCode>` (+ `field` for `bad_field`) |
| Generate an id. If `GHOSTS.get("g:" + id)` is non-null, regenerate (at most 3 tries). If that `get` throws, treat it as "free" and log `error: "kv_get_error"`: the check is a nicety, and the `put` is what matters. | 500 `id_exhausted` |
| `GHOSTS.put("g:" + id, canonicalGhostJson(payload), { expirationTtl: 2592000 })` | 500 `store_failed` |

Success: **201** `{ "id": "k2x9AbQ7" }`.

The existence check can't be fully reliable under eventual consistency. It guards against the astronomically unlikely collision at the cost of one read, nothing more.

### `GET /api/ghost/:id`

| Case | Response |
|---|---|
| The route matches exactly `/api/ghost/<one segment>`. More segments (`/api/ghost/a/b`) → 404 `not_found` | — |
| `!isGhostId(id)`, including a trailing slash or an empty id | 400 `bad_id` |
| `GHOSTS.get` throws | 503 `store_unavailable` (the client retries it like a 404) |
| KV hit | 200, body = stored canonical JSON passed through **unvalidated**, `Cache-Control: public, max-age=86400, immutable`. The client validates it: after a `CORE_VERSION` bump, a stored ghost is a valid `older version`, not corrupt data, and only the client can tell the player that. |
| KV miss | 404 `not_found` (A4) |

Methods other than GET → 405 with `Allow: GET`. The method check runs before the id check, so `PUT /api/ghost/bad!` → 405, not 400.

### Anything else

- `/api`, `/api/` and any other `/api/*` path → 404 `not_found` (JSON).
- Non-`/api` paths are served by assets first. A path matching no asset **invokes the Worker** (A7 quote), which returns a plain-text 404 `Not found` with `no-store`, not `index.html`. The game lives at `/` with query params only.

## Config (`wrangler.jsonc`)

```jsonc
{
  "name": "catman",
  "main": "worker/index.ts",
  "compatibility_date": "2026-11-08",              // set on the scaffold day and committed; bump deliberately
  "assets": { "directory": "./dist" },             // no not_found_handling (A7)
  "kv_namespaces": [{ "binding": "GHOSTS", "id": "<from wrangler kv namespace create GHOSTS>" }],
  "ratelimits": [{ "name": "GHOST_POST_LIMIT", "namespace_id": "1001", "simple": { "limit": 10, "period": 60 } }],
  "observability": { "enabled": true },
  "env": {
    "e2e": {                                              // e2e build with test hooks; local only, never deployed
      "assets": { "directory": "./dist-e2e" },
      // bindings are not inherited by named envs, so they're repeated here
      "kv_namespaces": [{ "binding": "GHOSTS", "id": "<same id; wrangler dev uses local storage>" }],
      "ratelimits": [{ "name": "GHOST_POST_LIMIT", "namespace_id": "1001", "simple": { "limit": 10, "period": 60 } }]
    }
  }
}
```

Facts from the [Rate Limiting docs](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) (fetched 2026-11-08):
- `period` "Must be either `10` or `60`".
- Requires "version 4.36.0 or later of the Wrangler CLI".
- "Rate limits are approximate and apply separately in each Cloudflare location".

Not on that page: how the binding behaves locally. **Checked** in the round-11 scratch project under `@cloudflare/vitest-plugin` 1.6.0: 12 calls from one IP gave 10 allowed and 2 refused, and a second IP was still allowed.

The docs advise against IP keys. With no accounts, IP is the only key available, and the limit is an abuse cap, not fairness.

**Named envs don't inherit bindings:** `kv_namespaces` and `ratelimits` are marked `@nonInheritable` in wrangler's config types (checked by the round-4 reviewer against local wrangler 4.156.1 `cli.d.ts`), so `env.e2e` repeats them. T-A3 and E2E 4 would fail without that.

**Checked** (round-11 scratch project, `@cloudflare/vitest-plugin` 1.6.0): local `GHOSTS.list()` reports `expiration`, so T-A6 can read it directly.

**Unverified until the first task's spike:**
- That per-env `assets.directory` overrides work under `wrangler dev --env e2e`.

If one fails, the fallback is noted in the test (T-A3: inject a fake limiter via `env`; T-A6: assert `put` options through a KV wrapper).

Provisioning (`wrangler kv namespace create GHOSTS`) and `npm run deploy` touch production: **Felipe runs them or confirms first.**

## Platform limits (checked 2026-11-08, [KV limits](https://developers.cloudflare.com/kv/platform/limits/))

Free plan: "1,000 writes per day" to different keys; value size up to 25 MiB.

At 10 POSTs/min, one abusive IP in one location could burn the daily quota in 100 minutes. After that, shares fail with `store_failed` until the reset, and existing ghosts still load. Acceptable for a friends' toy; the fix, if it happens, is the paid plan or a stricter limit.

## Observability

One JSON line per `/api` request, visible in Workers Logs:

```json
{ "route": "GET /api/ghost/:id", "status": 200, "id": "k2x9AbQ7", "own": false, "bytes": 3120 }
```

| Field | Meaning |
|---|---|
| `route`, `status` | As named |
| `bytes` | **Response** body length |
| `id` | Present on GET, and on a successful POST |
| `own` | GET only. `true` when the request carries `X-Catman-Own: 1`. The client sends it when fetching an id it created itself, so the sharer's own opens don't count |
| `error` | The error code, when there is one |

No timing field: Workers Logs already records request duration, and the Worker doesn't need to measure itself.

No IP, no body (A8).

**Evidence for the idea doc's "≥3 of 5 links opened":** Felipe records the 5 ids he shares in `docs/ideas/catman.md`. The count is ids with at least one `GET → 200` where `own: false`.

## Tests (`worker/*.test.ts`, `@cloudflare/vitest-plugin`, run by `vitest.worker.config.ts`; T-A7 runs in Playwright)

| Test | Checks |
|---|---|
| T-A1 | 60 KB body without `Content-Length` (sent as a `ReadableStream`, so no length is set) → 413; `Content-Length: 10` with a 60 KB body → 413; a body of exactly 49,152 bytes passes the size step |
| T-A2 | One request per `GhostErrorCode` the validator can produce from JSON → 400 with that code. A valid payload with an extra field → 201, and the stored value equals `canonicalGhostJson` (extra field gone). Empty body and `null` → `bad_json` |
| T-A3 | 11 POSTs from one IP within 60 s → at least one 429; another IP is unaffected |
| T-A4 | Every non-2xx has `no-store`; a hit has `immutable` |
| T-A6 | After a POST, the key's expiration is within ±60 s of now + 2,592,000 |
| T-A7 | **Runs in Playwright** (`e2e/routing.spec.ts`), against the same `wrangler dev --env e2e` server as the client E2E, because `SELF.fetch` under `@cloudflare/vitest-plugin` 1.6.0 never goes through static assets: with an SPA fallback configured on purpose, the plugin still answered `/`, `/index.html` and `/api/ghost/:id` from the Worker (round-12 experiment), so a plugin test can't fail. Checks: `GET /api/ghost/<valid unknown id>` → 404 with `content-type: application/json`; `GET /no-such-file` → plain-text 404, not `index.html`; `GET /` → the game's HTML |
| T-A8 | Captured `console.log` lines carry only whitelisted keys; no IPv4/IPv6-shaped string appears |
| T-A9 | 10,000 ids all pass `isGhostId`, with no duplicates; with a pre-seeded colliding key, the second id is used |
| T-A10 | A limiter that throws → POST still 201, and the log has `rl_error` |
| T-routes | Unknown `/api` path, `/api` and `/api/` → 404 JSON; a non-`/api` path → plain-text 404 from the Worker (the asset side of this is T-A7); `PUT /api/ghost` → 405 `Allow: POST`; `POST /api/ghost/` → 405 `Allow: GET`; `HEAD /api/ghost/x` → 405 `Allow: GET`; `/api/ghost/` → 400 `bad_id`; `/api/ghost/a/b` → 404 |
| T-kv-errors | KV wrapper that throws: GET → 503 `store_unavailable` with `no-store`; existence-check throw → POST still 201, log has `kv_get_error`; `put` throw → 500 `store_failed` |
| T-roundtrip | POST then GET → the body passes `validateGhostPayload` and decodes to the same levels |
| A5 | Covered by SPEC-client E2E 5 (client retry schedule against routed 404s) |

## Success Criteria

- [ ] All tests above pass under `npm test` (worker project).
- [ ] `npm run dev:worker` serves the game at `/`, and a POST → GET round trip works locally (also SPEC-client E2E 4).
- [ ] After a Felipe-approved deploy, a ghost created on one network (desktop Wi-Fi) is fetched on another (phone on mobile data) within 90 s.
- [ ] Workers Logs show exactly the line format above.

## Open Questions

- None blocking. Revisit the rate limit if logs show `store_failed`.
