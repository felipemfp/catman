// Homing rats: past homing.startM, rats drift sideways toward the cat, per unit scrolled, and lock their x for the
// final approach so a moving cat can always dodge.
import { describe, expect, it } from 'vitest';
import { config } from './config.ts';
import { step, view } from './index.ts';
import { homingFrac } from './step.ts';
import { runFromScenario } from './testing.ts';

const H = config.rat.homing;
const CAT_Y = config.world.catLineY;
const seg = config.lane.segmentM;
const mDist = (m: number) => Math.ceil(m / seg) * seg;
/** The crafted rat (scenario ids start at 1e9; lane rats spawning meanwhile sort before it). */
const mine = <T extends { laneId: number }>(rats: readonly T[]): T | undefined => rats.find((r) => r.laneId >= 1e9);

describe('homingFrac', () => {
  it('is 0 before startM, ramps linearly, caps at maxFrac', () => {
    expect(homingFrac(0)).toBe(0);
    expect(homingFrac(H.startM)).toBe(0);
    expect(homingFrac(H.startM + 100)).toBeCloseTo(100 * H.fracPerM, 12);
    expect(homingFrac(1e6)).toBe(H.maxFrac);
    for (let m = 0; m < 6000; m += 50) expect(homingFrac(m + 50)).toBeGreaterThanOrEqual(homingFrac(m));
  });
});

const one = (distanceM: number, catX: number, ratX: number, ratY: number) =>
  runFromScenario({ seed: 'home0', distanceM, catX, hp: 1e9, gates: false, weapon: 'laser', mods: { rangeMult: config.clamps.multMin }, rats: [{ x: ratX, y: ratY, hp: 1e9 }] });

describe('homing rats', () => {
  it('before startM a rat keeps its x', () => {
    const run = one(mDist(H.startM - 200), 100, 400, 100);
    for (let i = 0; i < 60; i++) step(run, 0);
    expect(mine(view(run).rats)!.x).toBe(400);
  });
  it('past startM it moves toward the cat, at most frac × scroll per tick, never past the cat', () => {
    const run = one(mDist(H.startM + 2000), 100, 400, -200);
    let prev = 400;
    let moved = false;
    for (let i = 0; i < 400; i++) {
      const v0 = view(run);
      const lockedBefore = mine(v0.rats) !== undefined && mine(v0.rats)!.y > CAT_Y - H.lockU;
      const d0 = v0.distanceU;
      step(run, 0);
      const r = mine(view(run).rats);
      if (!r) break;
      const dx = prev - r.x;
      expect(dx).toBeGreaterThanOrEqual(0);
      expect(dx).toBeLessThanOrEqual(homingFrac(view(run).distanceU / 10) * (view(run).distanceU - d0) + 1e-9);
      if (lockedBefore) expect(dx).toBe(0);
      if (dx > 0) moved = true;
      expect(r.x).toBeGreaterThanOrEqual(100);
      prev = r.x;
    }
    expect(moved).toBe(true);
  });
  it('locks for the final approach: a rat inside lockU of the cat line keeps its x', () => {
    const run = one(mDist(H.startM + 3000), 100, 400, CAT_Y - H.lockU + 10);
    for (let i = 0; i < 10; i++) step(run, 0);
    expect(mine(view(run).rats)!.x).toBe(400);
  });
  it('a cat that keeps moving still dodges a homing rat it sees coming', () => {
    // rat dead ahead at the far edge; the cat sidesteps once, before the lock line
    const run = one(mDist(H.startM + 3000), 270, 270, -14);
    // only this rat's hits count (lane rats spawn meanwhile): a hit removes the rat on that same tick
    let hits = 0;
    let passed = false;
    for (let i = 0; i < 400 && view(run).over === null && !passed; i++) {
      const r = mine(view(run).rats);
      if (!r) break;
      const input = r.y > CAT_Y - H.lockU - 150 && r.y < CAT_Y - H.lockU ? 4 : 0;
      const hit = step(run, input).some((e) => e.t === 'catHit');
      const after = mine(view(run).rats);
      if (hit && !after) hits++;
      if (after && after.y > CAT_Y + 60) passed = true;
    }
    expect(hits).toBe(0);
    expect(passed).toBe(true);
  });
});
