// T-golden (F11): the one deliberate change-detector (SPEC.md § Testing Strategy).
import { describe, expect, it } from 'vitest';
import type { CoreEvent, InputLevel } from './types.ts';
import { CORE_VERSION, createRun, hashState, step } from './index.ts';
import replay from './fixtures/replay.json' with { type: 'json' };
import dies from './fixtures/dies.json' with { type: 'json' };

const BUMP = 'Core behaviour changed. Bump CORE_VERSION in src/core/version.ts and run `npm run fixture:regen`.';

function replayFixture(seed: string, levels: readonly number[]) {
  const run = createRun(seed);
  let ended: Extract<CoreEvent, { t: 'ended' }> | null = null;
  for (const l of levels) {
    const e = step(run, l as InputLevel).find((x) => x.t === 'ended');
    if (e && e.t === 'ended') { ended = e; break; }
  }
  return { hash: hashState(run), ended };
}

describe('T-golden (F11)', () => {
  for (const [name, f] of [['replay.json', replay], ['dies.json', dies]] as const) {
    it(name, () => {
      expect(f.coreVersion, 'fixture coreVersion ≠ CORE_VERSION: run `npm run fixture:regen`').toBe(CORE_VERSION);
      const r = replayFixture(f.seed, f.levels);
      expect(r.hash, BUMP).toBe(f.hash);
      if (f.ended) expect({ cause: r.ended?.cause, score: r.ended?.score, tick: r.ended?.tick }, BUMP).toEqual(f.ended);
    });
  }
  it('dies.json ends with rats exactly at its last input', () => {
    expect(dies.ended?.cause).toBe('rats');
    expect(dies.ticks).toBe(dies.ended?.tick);
    expect(dies.levels).toHaveLength(dies.ticks);
  });
});
