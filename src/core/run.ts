import type { CoreEvent, DeepReadonly, InputLevel, RunState } from './types.ts';
import { isSeed } from './ghost.ts';
import { createState, stepState, type RunOpts } from './step.ts';
import { hashRunState } from './hash.ts';
import { viewOf } from './view.ts';

declare const runBrand: unique symbol;
/** Opaque handle. */
export type Run = { readonly [runBrand]: true };

type RunInternal = { state: RunState; opts: RunOpts };

export function wrapRun(state: RunState, opts: RunOpts): Run {
  const r: RunInternal = { state, opts };
  return r as unknown as Run;
}

export function internal(run: Run): RunInternal {
  return run as unknown as RunInternal;
}

export function createRun(seed: string): Run {
  if (!isSeed(seed)) throw new Error('invalid seed: ' + JSON.stringify(seed));
  return wrapRun(createState(seed), { nextBossHp: null, gates: true });
}

export function step(run: Run, input: InputLevel): CoreEvent[] {
  const r = internal(run);
  return stepState(r.state, input, r.opts, { probe: false });
}

export function view(run: Run): DeepReadonly<RunState> {
  return viewOf(internal(run).state);
}

export function hashState(run: Run): string {
  return hashRunState(internal(run).state);
}
