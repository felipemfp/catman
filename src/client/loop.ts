export const TICK_MS = 1000 / 60;
export const MAX_STEPS_PER_FRAME = 5;

/** Fixed-step accumulator with a catch-up cap (C2). Pure. */
export function advance(accMs: number, deltaMs: number, hidden: boolean): { steps: number; accMs: number } {
  if (hidden) return { steps: 0, accMs: 0 };
  let acc = accMs + deltaMs;
  const owed = Math.floor(acc / TICK_MS);
  const steps = Math.min(MAX_STEPS_PER_FRAME, owed);
  acc -= steps * TICK_MS;
  if (owed > MAX_STEPS_PER_FRAME) acc = 0;
  return { steps, accMs: acc };
}
