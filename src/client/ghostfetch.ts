// Ghost fetch with a retry schedule that outlasts KV propagation (C3), then validation (C4).
import { validateGhostPayload, type GhostPayload, type InputLevel } from '../core/index.ts';

export const RETRY_AT_S = [0, 2, 5, 10, 20, 40, 70] as const;

export type FetchDeps = {
  fetch: (url: string, init: { headers: Record<string, string> }) => Promise<{ status: number; json(): Promise<unknown> }>;
  /** Resolves after `ms` (a fake clock in tests). */
  sleep: (ms: number) => Promise<void>;
};

export type FetchOutcome =
  | { kind: 'body'; body: unknown }
  | { kind: 'unavailable' };

export async function fetchGhost(id: string, own: boolean, deps: FetchDeps): Promise<FetchOutcome> {
  let t = 0;
  for (const at of RETRY_AT_S) {
    const wait = at * 1000 - t;
    if (wait > 0) await deps.sleep(wait);
    t = at * 1000;
    let status: number;
    let res: Awaited<ReturnType<FetchDeps['fetch']>>;
    try {
      res = await deps.fetch('/api/ghost/' + id, { headers: own ? { 'X-Catman-Own': '1' } : {} });
      status = res.status;
    } catch {
      continue; // network error → next slot
    }
    if (status === 200) {
      try {
        return { kind: 'body', body: await res.json() };
      } catch {
        return { kind: 'unavailable' };
      }
    }
    if (status === 404 || status >= 500) continue;
    return { kind: 'unavailable' };
  }
  return { kind: 'unavailable' };
}

export type Verified =
  | { kind: 'ok'; payload: GhostPayload; levels: InputLevel[] }
  | { kind: 'older version' } | { kind: 'unavailable' } | { kind: 'different seed' };

export function verifyBody(body: unknown, seed: string): Verified {
  const v = validateGhostPayload(body);
  if (!v.ok) return v.code === 'version_mismatch' ? { kind: 'older version' } : { kind: 'unavailable' };
  if (v.payload.seed !== seed) return { kind: 'different seed' };
  return { kind: 'ok', payload: v.payload, levels: v.levels };
}
