// Logic files: plain data in and out, named exports, no classes, no module state.
import type { Cat, InputLevel } from './types.ts';
import { config } from './config.ts';
import { clamp } from './math.ts';

/** Moves the cat one tick toward the speed its input asks for. Mutates `cat`. */
export function stepCat(cat: Cat, input: InputLevel): void {
  const { maxSpeedUPerTick, accelUPerTick2, widthU } = config.cat;
  const halfWidthU = widthU / 2;
  const targetVx = (input / 4) * maxSpeedUPerTick * cat.mods.moveSpeedMult;
  cat.vx += clamp(targetVx - cat.vx, -accelUPerTick2, accelUPerTick2);
  const x = clamp(cat.x + cat.vx, halfWidthU, config.world.widthU - halfWidthU);
  if (x !== cat.x + cat.vx) cat.vx = 0; // pressed against a wall = at rest (the gate-reach invariant depends on it)
  cat.x = x;
}

/**
 * The input level that moves the cat toward `targetX` without overshooting at the current accel.
 * For bots (balance-sim, test helpers); the game never calls it.
 */
export function levelToward(cat: { x: number; vx: number; mods: { moveSpeedMult: number } }, targetX: number): InputLevel {
  const { maxSpeedUPerTick, accelUPerTick2 } = config.cat;
  let best: InputLevel = 0;
  let bestErr = Infinity;
  const levels: InputLevel[] = [0, 1, -1, 2, -2, 3, -3, 4, -4];
  for (const L of levels) {
    const target = (L / 4) * maxSpeedUPerTick * cat.mods.moveSpeedMult;
    let v = cat.vx + clamp(target - cat.vx, -accelUPerTick2, accelUPerTick2);
    let x = cat.x + v;
    // then brake to rest as fast as possible
    while (v !== 0) {
      v -= clamp(v, -accelUPerTick2, accelUPerTick2);
      x += v;
    }
    const err = Math.abs(targetX - x);
    if (err < bestErr - 1e-9) {
      bestErr = err;
      best = L;
    }
  }
  return best;
}
