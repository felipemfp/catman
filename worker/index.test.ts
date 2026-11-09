import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { newGhostId, TTL_SECONDS } from './index.ts';
import { CORE_VERSION, canonicalGhostJson, isGhostId, validateGhostPayload, type GhostErrorCode, type GhostPayload } from '../src/core/ghost.ts';

const URL_POST = 'http://catman.test/api/ghost';
let ipCounter = 0;
const freshIp = () => `198.51.100.${(ipCounter++ % 250) + 1}`;

// "BAkICA==" encodes bytes 04 09 08 08: 9 ticks at level 0, 8 at +4 (17 ticks).
const INPUTS = 'BAkICA==';
function payload(over: Partial<Record<keyof GhostPayload, unknown>> = {}): Record<string, unknown> {
  return { v: 1, coreVersion: CORE_VERSION, seed: 'abcd', score: 42, ticks: 17, inputs: INPUTS, ...over };
}

function post(body: BodyInit | null, headers: Record<string, string> = {}) {
  return SELF.fetch(URL_POST, { method: 'POST', body, headers: { 'content-type': 'application/json', 'CF-Connecting-IP': freshIp(), ...headers } });
}

let logs: string[] = [];
beforeEach(() => {
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
});
afterEach(() => vi.restoreAllMocks());

describe('T-A1 body cap', () => {
  it('60 KB streamed without Content-Length → 413', async () => {
    const big = new TextEncoder().encode('x'.repeat(60 * 1024));
    const stream = new ReadableStream({ start(c) { c.enqueue(big.slice(0, 30000)); c.enqueue(big.slice(30000)); c.close(); } });
    const r = await post(stream);
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual({ error: 'body_too_large' });
  });
  it('a false Content-Length: 10 on a 60 KB body → 413', async () => {
    const r = await worker.fetch(new Request(URL_POST, { method: 'POST', body: 'x'.repeat(60 * 1024), headers: { 'content-type': 'application/json', 'content-length': '10' } }), env);
    expect(r.status).toBe(413);
  });
  it('exactly 49,152 bytes passes the size step', async () => {
    const base = JSON.stringify(payload());
    const body = base.slice(0, -1) + ',"pad":"' + 'p'.repeat(49152 - base.length - 9) + '"}';
    expect(new TextEncoder().encode(body).byteLength).toBe(49152);
    const r = await post(body);
    expect(r.status).toBe(201);
  });
});

describe('T-A2 validation', () => {
  const cases: [Record<string, unknown> | string, GhostErrorCode | 'bad_json', string?][] = [
    ['[]', 'not_object'],
    [payload({ seed: 5 }), 'bad_field', 'seed'],
    [payload({ v: 2 }), 'bad_version'],
    [payload({ coreVersion: CORE_VERSION + 1 }), 'version_mismatch'],
    [payload({ seed: 'NO!' }), 'bad_seed'],
    [payload({ score: -3 }), 'bad_score'],
    [payload({ ticks: 0 }), 'bad_ticks'],
    [payload({ inputs: 'A'.repeat(43692) }), 'inputs_too_large'],
    [payload({ inputs: 'B!==' }), 'bad_base64'],
    [payload({ inputs: 'CQE=' }), 'bad_level'],
    [payload({ inputs: 'BAA=' }), 'zero_run'],
    [payload({ inputs: 'BA==' }), 'truncated'],
    [payload({ inputs: 'BIGBgYEB' }), 'varint_overflow'],
    [payload({ inputs: 'BIEA' }), 'non_canonical'],
    [payload({ inputs: 'BMGyBA==' }), 'too_many_ticks'],
    [payload({ ticks: 16 }), 'ticks_mismatch'],
    ['', 'bad_json'],
    ['null', 'bad_json'],
    ['{nope', 'bad_json'],
  ];
  for (const [body, code, field] of cases) {
    it(`${code}${field ? ' ' + field : ''}`, async () => {
      const r = await post(typeof body === 'string' ? body : JSON.stringify(body));
      expect(r.status).toBe(400);
      expect(r.headers.get('cache-control')).toBe('no-store');
      expect(await r.json()).toEqual(field ? { error: code, field } : { error: code });
    });
  }
  it('invalid UTF-8 → bad_json', async () => {
    const r = await post(new Uint8Array([0x7b, 0xff, 0x7d]));
    expect(await r.json()).toEqual({ error: 'bad_json' });
  });
  it('an extra field is dropped: the stored value is canonical JSON', async () => {
    const r = await post(JSON.stringify({ ...payload(), extra: 'x' }));
    expect(r.status).toBe(201);
    const { id } = (await r.json()) as { id: string };
    expect(await env.GHOSTS.get('g:' + id)).toBe(canonicalGhostJson(payload() as GhostPayload));
  });
  it('wrong content type → 415', async () => {
    const r = await post(JSON.stringify(payload()), { 'content-type': 'text/plain' });
    expect(r.status).toBe(415);
  });
});

describe('T-A3 rate limit', () => {
  it('11 POSTs from one IP within 60 s → at least one 429; another IP is unaffected', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await post(JSON.stringify(payload()), { 'CF-Connecting-IP': '203.0.113.7' })).status);
    expect(statuses).toContain(429);
    expect((await post(JSON.stringify(payload()), { 'CF-Connecting-IP': '203.0.113.8' })).status).toBe(201);
  });
});

describe('T-A4, T-A6, T-roundtrip', () => {
  it('POST then GET: immutable hit, TTL within ±60 s of 30 days, payload decodes to the same levels', async () => {
    const r = await post(JSON.stringify(payload()));
    expect(r.status).toBe(201);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const { id } = (await r.json()) as { id: string };
    expect(isGhostId(id)).toBe(true);
    const listed = await env.GHOSTS.list({ prefix: 'g:' + id });
    const exp = listed.keys[0]?.expiration ?? 0;
    expect(Math.abs(exp - (Date.now() / 1000 + TTL_SECONDS))).toBeLessThanOrEqual(60);
    const g = await SELF.fetch('http://catman.test/api/ghost/' + id);
    expect(g.status).toBe(200);
    expect(g.headers.get('cache-control')).toBe('public, max-age=86400, immutable');
    const v = validateGhostPayload(await g.json());
    const orig = validateGhostPayload(payload());
    expect(v.ok && orig.ok && v.levels).toEqual(orig.ok && orig.levels);
  });
  it('every non-2xx carries no-store', async () => {
    for (const [url, init] of [
      ['http://catman.test/api/ghost/zzzzzzzz', {}],
      ['http://catman.test/api/ghost/bad', {}],
      ['http://catman.test/api/nope', {}],
      ['http://catman.test/nope.txt', {}],
      [URL_POST, { method: 'PUT' }],
    ] as const) {
      const r = await SELF.fetch(url, init);
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.headers.get('cache-control')).toBe('no-store');
    }
  });
});

describe('T-A8 logs', () => {
  it('only whitelisted keys, no IP-shaped strings', async () => {
    await post(JSON.stringify(payload()), { 'CF-Connecting-IP': '192.0.2.55' });
    await SELF.fetch('http://catman.test/api/ghost/abcdEFGH', { headers: { 'X-Catman-Own': '1', 'CF-Connecting-IP': '2001:db8::1' } });
    await post('{bad', { 'CF-Connecting-IP': '192.0.2.56' });
    expect(logs.length).toBeGreaterThanOrEqual(3);
    const allowed = new Set(['route', 'status', 'id', 'own', 'bytes', 'error']);
    for (const l of logs) {
      const o = JSON.parse(l) as Record<string, unknown>;
      for (const k of Object.keys(o)) expect(allowed.has(k)).toBe(true);
      expect(l).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
      expect(l).not.toMatch(/[0-9a-f]{1,4}(:[0-9a-f]{0,4}){2,7}/i);
    }
    const get = logs.map((l) => JSON.parse(l) as Record<string, unknown>).find((o) => o.route === 'GET /api/ghost/:id');
    expect(get).toMatchObject({ status: 404, id: 'abcdEFGH', own: true, error: 'not_found' });
  });
});

describe('T-A9 ids', () => {
  it('10,000 ids all valid and distinct', () => {
    const s = new Set<string>();
    for (let i = 0; i < 10000; i++) {
      const id = newGhostId();
      expect(isGhostId(id)).toBe(true);
      s.add(id);
    }
    expect(s.size).toBe(10000);
  });
  it('a pre-seeded colliding key makes the second id be used', async () => {
    const ids = ['AAAAAAAA', 'BBBBBBBB'];
    let call = 0;
    const real = crypto.getRandomValues.bind(crypto);
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(a: T): T => {
      const id = ids[Math.min(call++, 1)]!;
      const u = a as unknown as Uint8Array;
      real(u);
      for (let i = 0; i < 8; i++) u[i] = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.indexOf(id[i]!);
      return a;
    });
    await env.GHOSTS.put('g:AAAAAAAA', '{}');
    const r = await worker.fetch(new Request(URL_POST, { method: 'POST', body: JSON.stringify(payload()), headers: { 'content-type': 'application/json' } }), env);
    expect(await r.json()).toEqual({ id: 'BBBBBBBB' });
  });
});

const throwingKV = {
  get: () => Promise.reject(new Error('kv down')),
  put: () => Promise.reject(new Error('kv down')),
} as unknown as KVNamespace;

describe('T-A10, T-kv-errors', () => {
  it('a throwing limiter fails open and logs rl_error', async () => {
    const e = { ...env, GHOST_POST_LIMIT: { limit: () => Promise.reject(new Error('rl')) } as unknown as RateLimit };
    const r = await worker.fetch(new Request(URL_POST, { method: 'POST', body: JSON.stringify(payload()), headers: { 'content-type': 'application/json' } }), e);
    expect(r.status).toBe(201);
    expect(logs.some((l) => l.includes('"error":"rl_error"'))).toBe(true);
  });
  it('GET with KV throwing → 503 store_unavailable, no-store', async () => {
    const r = await worker.fetch(new Request('http://catman.test/api/ghost/abcdEFGH'), { ...env, GHOSTS: throwingKV });
    expect(r.status).toBe(503);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.json()).toEqual({ error: 'store_unavailable' });
  });
  it('existence-check throw → still 201, logs kv_get_error', async () => {
    const kv = { get: () => Promise.reject(new Error('x')), put: (k: string, v: string, o: KVNamespacePutOptions) => env.GHOSTS.put(k, v, o) } as unknown as KVNamespace;
    const r = await worker.fetch(new Request(URL_POST, { method: 'POST', body: JSON.stringify(payload()), headers: { 'content-type': 'application/json' } }), { ...env, GHOSTS: kv });
    expect(r.status).toBe(201);
    expect(logs.some((l) => l.includes('kv_get_error'))).toBe(true);
  });
  it('put throw → 500 store_failed', async () => {
    const kv = { get: () => Promise.resolve(null), put: () => Promise.reject(new Error('x')) } as unknown as KVNamespace;
    const r = await worker.fetch(new Request(URL_POST, { method: 'POST', body: JSON.stringify(payload()), headers: { 'content-type': 'application/json' } }), { ...env, GHOSTS: kv });
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ error: 'store_failed' });
  });
});

describe('T-routes', () => {
  const cases: [string, RequestInit, number, Record<string, string>?, unknown?][] = [
    ['/api/nope', {}, 404, {}, { error: 'not_found' }],
    ['/api', {}, 404, {}, { error: 'not_found' }],
    ['/api/', {}, 404, {}, { error: 'not_found' }],
    ['/api/ghost', { method: 'PUT' }, 405, { allow: 'POST' }],
    ['/api/ghost', { method: 'GET' }, 405, { allow: 'POST' }],
    ['/api/ghost/', { method: 'POST' }, 405, { allow: 'GET' }],
    ['/api/ghost/x', { method: 'HEAD' }, 405, { allow: 'GET' }],
    ['/api/ghost/bad!', { method: 'PUT' }, 405, { allow: 'GET' }],
    ['/api/ghost/', {}, 400, {}, { error: 'bad_id' }],
    ['/api/ghost/a/b', {}, 404, {}, { error: 'not_found' }],
  ];
  for (const [path, init, status, headers, body] of cases) {
    it(`${init.method ?? 'GET'} ${path} → ${status}`, async () => {
      const r = await SELF.fetch('http://catman.test' + path, init);
      expect(r.status).toBe(status);
      for (const [k, v] of Object.entries(headers ?? {})) expect(r.headers.get(k)).toBe(v);
      if (init.method !== 'HEAD') expect(r.headers.get('content-type')).toContain('application/json');
      if (body) expect(await r.json()).toEqual(body);
    });
  }
  it('a non-/api path → plain-text 404 from the Worker', async () => {
    const r = await SELF.fetch('http://catman.test/no-such-file');
    expect(r.status).toBe(404);
    expect(r.headers.get('content-type')).toContain('text/plain');
    expect(await r.text()).toBe('Not found');
  });
});
