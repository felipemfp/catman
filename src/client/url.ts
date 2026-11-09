import { isGhostId, isSeed } from '../core/index.ts';

const B36 = '0123456789abcdefghijklmnopqrstuvwxyz';

/** 6 base36 chars from random bytes, rejection-sampled (bytes ≥ 252 are skipped). */
export function seedFromBytes(next: () => Uint8Array): string {
  let s = '';
  while (s.length < 6) {
    for (const b of next()) if (b < 252 && s.length < 6) s += B36[b % 36];
  }
  return s;
}

export type BootParams = { seed: string; seedReplaced: boolean; ghostId: string | null };

export function parseBoot(search: string, newSeed: () => string): BootParams {
  const q = new URLSearchParams(search);
  const s = q.get('s');
  const g = q.get('g');
  const valid = s !== null && isSeed(s);
  return { seed: valid ? s : newSeed(), seedReplaced: !valid, ghostId: g !== null && isGhostId(g) ? g : null };
}

export function shareLink(origin: string, seed: string, ghostId?: string): string {
  return ghostId ? `${origin}/?s=${seed}&g=${ghostId}` : `${origin}/?s=${seed}`;
}

/** The query string for a seed with an optional ghost. */
export function searchFor(seed: string, ghostId: string | null): string {
  return ghostId ? `?s=${seed}&g=${ghostId}` : `?s=${seed}`;
}
