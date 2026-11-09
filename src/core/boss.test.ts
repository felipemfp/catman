// Boss behaviour: it tracks the cat sideways, and it descends faster while the cat keeps missing it.
import { describe, expect, it } from 'vitest';
import { config } from './config.ts';
import { step, view } from './index.ts';
import { applyStatGate, defaultMods } from './stats.ts';
import { runFromScenario, stateOf } from './testing.ts';

const B = config.boss;
const topY = -3000;
// weapon with no shots that can reach: the laser with range clamped tiny never touches a boss this far up
const missing = (catX: number, bossX: number, y = topY) =>
  runFromScenario({ seed: 'boss0', distanceM: 1000, hp: 1e9, gates: false, catX, weapon: 'laser', mods: { rangeMult: config.clamps.multMin }, boss: { x: bossX, y, hp: 1e9 } });

describe('boss tracks the cat', () => {
  it('moves toward the cat by at most trackUPerTick, and never past it', () => {
    const run = missing(100, 400);
    let prev = view(run).boss!.x;
    for (let i = 0; i < 600; i++) {
      step(run, 0);
      const x = view(run).boss!.x;
      expect(prev - x).toBeGreaterThanOrEqual(0);
      expect(prev - x).toBeLessThanOrEqual(B.trackUPerTick + 1e-9);
      expect(x).toBeGreaterThanOrEqual(100);
      prev = x;
    }
    expect(view(run).boss!.x).toBe(100);
  });
  it('stays fully on screen', () => {
    const run = missing(5, 270);
    for (let i = 0; i < 600; i++) step(run, 0);
    expect(view(run).boss!.x).toBeGreaterThanOrEqual(B.sizeU / 2);
  });
});

describe('boss speeds up while missed, back to base speed once hit', () => {
  it('descends at base speed through the grace window, then faster, capped at rageMax', () => {
    const run = missing(270, 270);
    const dys: number[] = [];
    for (let i = 0; i < 400; i++) {
      const y = view(run).boss!.y;
      step(run, 0);
      if (view(run).boss === null) break;
      dys.push(view(run).boss!.y - y);
    }
    for (let i = 0; i < B.missGraceTicks; i++) expect(dys[i]).toBeCloseTo(B.speedUPerTick, 9);
    expect(dys[B.missGraceTicks + 30]!).toBeGreaterThan(B.speedUPerTick);
    for (const d of dys) expect(d).toBeLessThanOrEqual(B.speedUPerTick * B.rageMax + 1e-9);
    for (let i = 1; i < dys.length; i++) expect(dys[i]! + 1e-9).toBeGreaterThanOrEqual(dys[i - 1]!);
  });
  it('a hit resets it to base speed', () => {
    const run = missing(270, 270, 150);
    for (let i = 0; i < B.missGraceTicks + 60; i++) step(run, 0);
    const s = stateOf(run);
    // now let the laser reach: full range
    s.cat.mods = defaultMods();
    applyStatGate(s.cat.mods, { kind: 'stat', buff: { stat: 'rangeMult', value: 2 }, debuff: { stat: 'moveSpeedMult', value: 1 } });
    const y0 = view(run).boss!.y;
    step(run, 0);
    step(run, 0);
    const y1 = view(run).boss!.y;
    step(run, 0);
    expect(view(run).boss!.y - y1).toBeCloseTo(B.speedUPerTick, 9);
    expect(y1).toBeGreaterThan(y0);
  });
});
