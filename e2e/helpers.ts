import type { Page } from '@playwright/test';
import dies from '../src/core/fixtures/dies.json' with { type: 'json' };

/** Repeats formatScore's one-line definition (dependency rule 4: e2e can't import client code). */
export const fmt = (n: number) => new Intl.NumberFormat('en-US').format(n);

export async function hooks(page: Page): Promise<void> {
  await page.waitForFunction(() => typeof window.__catman !== 'undefined' && window.__catman.ui().screen === 'title');
}

/** A valid ghost payload built from the dies fixture (dies.json: { seed, levels, ticks, ended, coreVersion }). */
export function diesPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  const runs: number[] = [];
  let prev: number | null = null;
  let count = 0;
  const flush = () => {
    if (prev === null) return;
    runs.push(prev + 4);
    let n = count;
    while (n >= 0x80) { runs.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
    runs.push(n);
  };
  for (const l of dies.levels) {
    if (l === prev) count++;
    else { flush(); prev = l; count = 1; }
  }
  flush();
  const inputs = Buffer.from(Uint8Array.from(runs)).toString('base64');
  return { v: 1, coreVersion: dies.coreVersion, seed: dies.seed, score: dies.ended!.score, ticks: dies.ticks, inputs, ...over };
}

export { dies };
