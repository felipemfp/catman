// Homing rats: past homing.startM, rats drift sideways toward the cat, per unit scrolled, and lock their x for the
// final approach so a moving cat can always dodge.
import { describe, expect, it } from 'vitest';
import { config } from './config.ts';
import { step, view } from './index.ts';
import { chargeFrac, homingFrac, rowSlots } from './step.ts';
import { runFromScenario } from './testing.ts';
import type { DeepReadonly, Rat } from './types.ts';

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

describe('charging rats (CORE_VERSION 8)', () => {
  it('chargeFrac is 0 before startM, ramps, caps at maxCharge', () => {
    expect(chargeFrac(H.startM)).toBe(0);
    expect(chargeFrac(H.startM + 100)).toBeCloseTo(100 * H.chargePerM, 12);
    expect(chargeFrac(1e6)).toBe(H.maxCharge);
  });
  it('past startM a rat advances faster than the lane by chargeFrac × scroll, before and inside the lock line', () => {
    for (const y0 of [-200, CAT_Y - H.lockU + 20]) {
      const run = one(mDist(H.startM + 3000), 270, 270, y0);
      const r0 = mine(view(run).rats)!.y;
      const d0 = view(run).distanceU;
      step(run, 0);
      const dy = mine(view(run).rats)!.y - r0;
      const scroll = view(run).distanceU - d0;
      expect(dy).toBeCloseTo(scroll * (1 + chargeFrac(view(run).distanceU / 10)), 9);
    }
  });
  it('before startM rats move with the lane only', () => {
    const run = one(mDist(H.startM - 200), 270, 400, 100);
    const d0 = view(run).distanceU;
    step(run, 0);
    expect(mine(view(run).rats)!.y - 100).toBeCloseTo(view(run).distanceU - d0, 9);
  });
});

// Felipe: "multiple rats on top of each other, hard to tell how many". Homing pulled every rat to cat.x, so rats
// in one row collapsed onto a single sprite. Homing now stops a rat where it would touch a rat in its way.
const RAT = config.rat.sizeU;
function overlapping(rats: DeepReadonly<Rat[]>): string | null {
  for (let i = 0; i < rats.length; i++) for (let j = i + 1; j < rats.length; j++) {
    const a = rats[i]!, b = rats[j]!;
    if (Math.abs(a.x - b.x) < RAT - 1e-9 && Math.abs(a.y - b.y) < RAT - 1e-9) return `${a.laneId}@${a.x.toFixed(1)},${a.y.toFixed(1)} vs ${b.laneId}@${b.x.toFixed(1)},${b.y.toFixed(1)}`;
  }
  return null;
}

describe('homing rats never stack (CORE_VERSION 13)', () => {
  it('a row of rats closing on the cat stops side by side, not on top of each other', () => {
    const rats = [60, 120, 180, 360, 420, 480].map((x) => ({ x, y: -200, hp: 1e9 }));
    const run = runFromScenario({ seed: 'home0', distanceM: mDist(H.startM + 3000), catX: 270, hp: 1e9, gates: false, weapon: 'laser', mods: { rangeMult: config.clamps.multMin }, rats });
    let moved = false;
    for (let i = 0; i < 300; i++) {
      step(run, 0);
      const mineRats = view(run).rats.filter((r) => r.laneId >= 1e9 && r.y < CAT_Y - H.lockU);
      if (mineRats.length < 6) break;
      expect(overlapping(mineRats)).toBeNull();
      if (mineRats.some((r) => r.x !== rats.find((q) => q.x === r.x)?.x)) moved = true;
    }
    expect(moved).toBe(true);
  });
  it('real lanes: a still cat past homing start never sees two homing rats overlap', () => {
    const W = config.world.widthU;
    for (const seed of ['home0', 'abcd', 'zz99', 'k2x9']) for (const catX of [config.cat.widthU / 2, 270, W - config.cat.widthU / 2]) {
      const run = runFromScenario({ seed, distanceM: mDist(H.startM + 1500), catX, hp: 1e9, gates: false, weapon: 'laser', mods: { rangeMult: config.clamps.multMin } });
      for (let i = 0; i < 3000 && view(run).over === null; i++) {
        step(run, 0);
        const homing = view(run).rats.filter((r) => !r.guard);
        const o = overlapping(homing);
        expect(o, `${seed} cat ${catX} tick ${i}`).toBeNull();
        // critic finding: wide rows used to home past the wall when the cat hugged it
        for (const r of homing) expect(r.x >= RAT / 2 - 1e-9 && r.x <= W - RAT / 2 + 1e-9, `${seed} cat ${catX} tick ${i} rat ${r.laneId} x ${r.x}`).toBe(true);
      }
    }
  });
});

describe('rowSlots', () => {
  it('rats closer than sizeU in y (chained) share a row, ranked by x; others keep slot 0', () => {
    const s = rowSlots([{ x: 60, y: 0 }, { x: 20, y: 10 }, { x: 40, y: 30 }, { x: 50, y: 100 }]);
    expect(s.map((r) => r.slot)).toEqual([1, -1, 0, 0]);
    expect(s.map((r) => r.lead)).toEqual([30, 20, 0, 0]);
    expect(rowSlots([{ x: 5, y: 0 }, { x: 5, y: 0 }]).map((r) => r.slot)).toEqual([-0.5, 0.5]);
  });
  it('a gap the cat fits through stays as wide; tighter gaps pack to one rat width', () => {
    const pass = config.cat.widthU + RAT;
    // three rats packed on the left (gaps 40 < pass), then a corridor of exactly pass, then one rat
    const xs = [0, 40, 80, 80 + pass];
    const slots = rowSlots(xs.map((x) => ({ x, y: 0 }))).map((r) => r.slot * RAT);
    expect(slots[1]! - slots[0]!).toBeCloseTo(RAT, 9);
    expect(slots[2]! - slots[1]!).toBeCloseTo(RAT, 9);
    expect(slots[3]! - slots[2]!).toBeCloseTo(pass, 9);
    expect(slots[0]! + slots[3]!).toBeCloseTo(0, 9); // the row's span is centred on the cat
  });
});
