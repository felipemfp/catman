// The one module flag in core (by design): whether view() returns a deep-frozen copy.
import type { DeepReadonly, RunState } from './types.ts';

const flags = { frozenViews: false };

export function setFrozenViews(on: boolean): void {
  flags.frozenViews = on;
}

export function frozenViews(): boolean {
  return flags.frozenViews;
}

function copy<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => copy(x)) as T;
  if (typeof v === 'object' && v !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = copy(x);
    return out as T;
  }
  return v;
}

function freeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null) {
    Object.freeze(v);
    for (const x of Object.values(v)) freeze(x);
  }
  return v;
}

/** Plain recursive copy (no structuredClone, which isn't in lib ES2022). Used only for views, never by logic. */
export function copyState(s: RunState): RunState {
  return copy(s);
}

export function viewOf(s: RunState): DeepReadonly<RunState> {
  return frozenViews() ? freeze(copyState(s)) : s;
}
