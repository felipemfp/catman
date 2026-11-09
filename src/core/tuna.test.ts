// Tuna: an occasional pickup that heals one life, placed off the safe corridor inside a ring of guard rats.
import { describe, expect, it } from 'vitest';
import type { CoreEvent } from './types.ts';
import { config, generateSegment, step, view } from './index.ts';
import { corridorHalfU } from './lane.ts';
import { runFromScenario } from './testing.ts';

const T = config.tuna;
const W = config.world;
const ofType = <K extends CoreEvent['t']>(ev: CoreEvent[], t: K) => ev.filter((e): e is Extract<CoreEvent, { t: K }> => e.t === t);
const segs = (seed: string, toM: number) => Array.from({ length: toM / config.lane.segmentM }, (_, k) => generateSegment(seed, k));

describe('tuna in the lane', () => {
  const seeds = Array.from({ length: 40 }, (_, i) => 'tuna' + i);
  it('appears only on tuna marks, guarded by a full ring, all of it off the corridor', () => {
    let n = 0;
    for (const seed of seeds) {
      for (const s of segs(seed, 4000)) {
        if (s.tuna === null) continue;
        n++;
        expect(s.kind).toBe('tuna');
        expect((s.k * config.lane.segmentM) % T.everyM).toBe(0);
        expect(s.gate).toBeNull();
        expect(s.bossX).toBeNull();
        expect(s.rats).toHaveLength(T.guards);
        for (const r of s.rats) {
          expect((r.x - s.tuna.x) * (r.x - s.tuna.x) + (r.dy - s.tuna.dy) * (r.dy - s.tuna.dy)).toBeCloseTo(T.guardRadiusU * T.guardRadiusU, 6);
          expect(Math.abs(r.x - s.corridorX)).toBeGreaterThanOrEqual(corridorHalfU + config.rat.sizeU / 2);
          expect(r.x - config.rat.sizeU / 2).toBeGreaterThanOrEqual(0);
          expect(r.x + config.rat.sizeU / 2).toBeLessThanOrEqual(W.widthU);
          expect(r.dy).toBeGreaterThanOrEqual(0);
          expect(r.dy).toBeLessThanOrEqual(config.lane.bandU - config.rat.sizeU);
        }
        expect(Math.abs(s.tuna.x - s.corridorX)).toBeGreaterThanOrEqual(corridorHalfU + T.sizeU / 2);
      }
    }
    // "occasional": 1 to 3 per 1000 m on average (about one per boss-to-boss stretch, sometimes two)
    const per1000 = n / seeds.length / 4;
    expect(per1000).toBeGreaterThanOrEqual(1);
    expect(per1000).toBeLessThanOrEqual(3);
  });
  it('is a pure function of (seed, k)', () => {
    expect(segs('tuna0', 3000)).toEqual(segs('tuna0', 3000));
  });
});

describe('eating tuna', () => {
  const at = (hp: number) => runFromScenario({ seed: 'eat0', distanceM: 1000, hp, gates: false, tunas: [{ x: 270, y: W.catLineY }] });
  it('heals one life when hurt', () => {
    const run = at(1);
    const ev = step(run, 0);
    expect(ofType(ev, 'tunaEaten')).toEqual([{ t: 'tunaEaten', hp: 2, healed: true }]);
    expect(view(run).cat.hp).toBe(2);
    expect(view(run).tunas).toHaveLength(0);
  });
  it('never heals past max hp; at full hp it is a score bonus instead', () => {
    const run = at(config.cat.hp);
    const before = view(run).score;
    const ev = step(run, 0);
    expect(ofType(ev, 'tunaEaten')).toEqual([{ t: 'tunaEaten', hp: config.cat.hp, healed: false }]);
    expect(view(run).cat.hp).toBe(config.cat.hp);
    expect(view(run).score).toBeGreaterThanOrEqual(before + T.fullHpScore);
  });
  it('shots pass through tuna', () => {
    const run = runFromScenario({ seed: 'eat1', distanceM: 1000, gates: false, catX: 270, tunas: [{ x: 270, y: 600 }] });
    for (let i = 0; i < 30; i++) step(run, 0);
    expect(view(run).tunas).toHaveLength(1);
  });
  it('a tuna the cat misses scrolls off and is gone, with a tunaMissed event', () => {
    const run = runFromScenario({ seed: 'eat2', distanceM: 1000, gates: false, catX: 60, tunas: [{ x: 450, y: 800 }] });
    const all: CoreEvent[] = [];
    for (let i = 0; i < 200 && view(run).tunas.length > 0; i++) all.push(...step(run, 0));
    expect(view(run).tunas).toHaveLength(0);
    expect(ofType(all, 'tunaMissed')).toHaveLength(1);
    expect(ofType(all, 'tunaEaten')).toHaveLength(0);
  });
  it('a real tuna segment spawns its tuna into the run', () => {
    let k = -1;
    for (let j = 0; j < 400 && k < 0; j++) if (generateSegment('spawn0', j).tuna !== null) k = j;
    expect(k).toBeGreaterThan(0);
    const run = runFromScenario({ seed: 'spawn0', distanceM: k * config.lane.segmentM, gates: false });
    step(run, 0);
    expect(view(run).tunas).toHaveLength(1);
    expect(view(run).tunas[0]!.x).toBe(generateSegment('spawn0', k).tuna!.x);
  });
});
