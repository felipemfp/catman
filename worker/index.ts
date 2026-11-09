// ghost-api: static assets (served before this runs) + POST /api/ghost + GET /api/ghost/:id.
import { canonicalGhostJson, ghostLimits, isGhostId, validateGhostPayload } from '../src/core/ghost.ts';
import { newGhostId, TTL_SECONDS } from './ghost-id.ts';

type Log = { route: string; status: number; id?: string; own?: boolean; bytes: number; error?: string };

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const h: Record<string, string> = { 'content-type': 'application/json; charset=utf-8', ...headers };
  if (status >= 300 && !h['cache-control']) h['cache-control'] = 'no-store';
  return new Response(JSON.stringify(body), { status, headers: h });
}


/** Reads at most `max` bytes, whatever Content-Length says. Returns null once the cap is passed. */
async function readCapped(req: Request, max: number): Promise<Uint8Array | null> {
  if (req.body === null) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}

async function postGhost(req: Request, env: Env, log: Log): Promise<Response> {
  const ct = (req.headers.get('content-type') ?? '').toLowerCase();
  if (!ct.startsWith('application/json')) return fail(log, 415, 'unsupported_media_type');
  const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown';
  try {
    const { success } = await env.GHOST_POST_LIMIT.limit({ key: ip });
    if (!success) return fail(log, 429, 'rate_limited');
  } catch {
    log.error = 'rl_error'; // fail open (A10); the KV daily quota is the backstop
  }
  const bytes = await readCapped(req, ghostLimits.maxBodyBytes);
  if (bytes === null) return fail(log, 413, 'body_too_large');
  let body: unknown;
  try {
    if (bytes.byteLength === 0) throw new Error('empty');
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
    if (body === null) throw new Error('null');
  } catch {
    return fail(log, 400, 'bad_json');
  }
  const v = validateGhostPayload(body);
  if (!v.ok) return fail(log, 400, v.code, v.field);
  let id: string | null = null;
  for (let i = 0; i < 3 && id === null; i++) {
    const cand = newGhostId();
    try {
      if ((await env.GHOSTS.get('g:' + cand)) === null) id = cand;
    } catch {
      log.error = 'kv_get_error';
      id = cand;
    }
  }
  if (id === null) return fail(log, 500, 'id_exhausted');
  try {
    await env.GHOSTS.put('g:' + id, canonicalGhostJson(v.payload), { expirationTtl: TTL_SECONDS });
  } catch {
    return fail(log, 500, 'store_failed');
  }
  log.id = id;
  return done(log, json(201, { id }, { 'cache-control': 'no-store' }));
}

async function getGhost(req: Request, env: Env, id: string, log: Log): Promise<Response> {
  log.own = req.headers.get('X-Catman-Own') === '1';
  if (!isGhostId(id)) return fail(log, 400, 'bad_id');
  log.id = id;
  let value: string | null;
  try {
    value = await env.GHOSTS.get('g:' + id);
  } catch {
    return fail(log, 503, 'store_unavailable');
  }
  if (value === null) return fail(log, 404, 'not_found');
  return done(log, new Response(value, {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=86400, immutable' },
  }));
}

function fail(log: Log, status: number, error: string, field?: string, headers: Record<string, string> = {}): Response {
  log.error = error;
  return done(log, json(status, field ? { error, field } : { error }, headers));
}

function done(log: Log, res: Response): Response {
  log.status = res.status;
  // bytes = response body length; every /api body here is ASCII JSON or the stored canonical JSON
  return res;
}

async function handleApi(req: Request, env: Env, path: string, log: Log): Promise<Response> {
  if (path === '/api/ghost') {
    log.route = 'POST /api/ghost';
    if (req.method !== 'POST') return fail(log, 405, 'method_not_allowed', undefined, { allow: 'POST' });
    return postGhost(req, env, log);
  }
  if (path.startsWith('/api/ghost/')) {
    log.route = 'GET /api/ghost/:id';
    const rest = path.slice('/api/ghost/'.length);
    if (rest.includes('/')) return fail(log, 404, 'not_found');
    if (req.method !== 'GET') return fail(log, 405, 'method_not_allowed', undefined, { allow: 'GET' });
    return getGhost(req, env, rest, log);
  }
  log.route = 'other /api';
  return fail(log, 404, 'not_found');
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path !== '/api' && !path.startsWith('/api/')) {
      return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
    }
    const log: Log = { route: '', status: 0, bytes: 0 };
    const res = await handleApi(req, env, path, log);
    const body = await res.clone().arrayBuffer();
    log.bytes = body.byteLength;
    const line: Log = { route: log.route, status: log.status, bytes: log.bytes };
    if (log.id !== undefined && (log.route.startsWith('GET') || log.status === 201)) line.id = log.id;
    if (log.route.startsWith('GET')) line.own = log.own ?? false;
    if (log.error !== undefined) line.error = log.error;
    console.log(JSON.stringify({ route: line.route, status: line.status, ...(line.id ? { id: line.id } : {}), ...(line.own !== undefined ? { own: line.own } : {}), bytes: line.bytes, ...(line.error ? { error: line.error } : {}) }));
    return res;
  },
} satisfies ExportedHandler<Env>;
