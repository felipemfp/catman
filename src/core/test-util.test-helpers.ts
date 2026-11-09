// Shared helpers for core tests. Not a test file itself; imported only by *.test.ts.
import type { CoreEvent, InputLevel } from './types.ts';
import { createRng } from './rng.ts';

/** Patterns 0–3: cycle, hold-right, idle, seeded jitter. */
export function pattern(p: 0 | 1 | 2 | 3, seed: string, n: number): InputLevel[] {
  const out: InputLevel[] = [];
  if (p === 0) {
    const cyc: InputLevel[] = [4, 0, -4, 0];
    for (let i = 0; i < n; i++) out.push(cyc[Math.floor((i % 240) / 60)]!);
  } else if (p === 1) {
    for (let i = 0; i < n; i++) out.push(4);
  } else if (p === 2) {
    for (let i = 0; i < n; i++) out.push(0);
  } else {
    const rng = createRng('jitter:' + seed);
    let lvl: InputLevel = 0;
    for (let i = 0; i < n; i++) {
      if (rng() < 0.08) lvl = (Math.floor(rng() * 9) - 4) as InputLevel;
      out.push(lvl);
    }
  }
  return out;
}

export function ofType<T extends CoreEvent['t']>(ev: CoreEvent[], t: T): Extract<CoreEvent, { t: T }>[] {
  return ev.filter((e): e is Extract<CoreEvent, { t: T }> => e.t === t);
}
