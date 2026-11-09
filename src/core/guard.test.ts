// Gate guards: the better half of an uneven gate pair is guarded by a horde two segments before it.
import { describe, expect, it } from 'vitest';
import { config } from './config.ts';
import { corridorHalfU, gateValue, generateSegment, inClearZone, isBossSegment, spawnsGate } from './lane.ts';

const G = config.gates.guard;
const W = config.world.widthU;
const seeds = Array.from({ length: 30 }, (_, i) => 'guard' + i);

describe('gate guards', () => {
  it('value: laser 3, yarn/fishbone 2, pencil and stat gates 1', () => {
    const fb = { kind: 'stat', buff: { stat: 'damageMult', value: 1.3 }, debuff: { stat: 'rangeMult', value: 0.9 } } as const;
    expect(gateValue({ kind: 'weapon', weapon: 'laser', fallback: fb })).toBe(3);
    expect(gateValue({ kind: 'weapon', weapon: 'yarn', fallback: fb })).toBe(2);
    expect(gateValue({ kind: 'weapon', weapon: 'fishbone', fallback: fb })).toBe(2);
    expect(gateValue({ kind: 'weapon', weapon: 'pencil', fallback: fb })).toBe(1);
    expect(gateValue(fb)).toBe(1);
  });
  it('an uneven pair gets a guard on its better half, sized by the gap, off the corridor; an even pair does not', () => {
    let guarded = 0;
    let even = 0;
    for (const seed of seeds) {
      for (let k = 2; k < 4000 / config.lane.segmentM; k++) {
        if (!spawnsGate(k) || isBossSegment(k - 2) || inClearZone(k - 2)) continue;
        const pair = generateSegment(seed, k).gate!;
        const diff = gateValue(pair.left) - gateValue(pair.right);
        const g = generateSegment(seed, k - 2);
        if (diff === 0) {
          even++;
          expect(g.kind).not.toBe('guard');
          continue;
        }
        guarded++;
        expect(g.kind).toBe('guard');
        const better = diff > 0 ? 'left' : 'right';
        expect(g.rats.length).toBeGreaterThan(0);
        expect(g.rats.length).toBeLessThanOrEqual(Math.min(G.cap, G.ratsPerValue * Math.abs(diff)));
        for (const r of g.rats) {
          if (better === 'left') expect(r.x).toBeLessThan(W / 2);
          else expect(r.x).toBeGreaterThan(W / 2);
          expect(Math.abs(r.x - g.corridorX)).toBeGreaterThanOrEqual(corridorHalfU + config.rat.sizeU / 2);
          expect(r.dy).toBeGreaterThanOrEqual(0);
          expect(r.dy).toBeLessThanOrEqual(config.lane.bandU - config.rat.sizeU);
        }
        expect(g.tuna).toBeNull();
      }
    }
    expect(guarded).toBeGreaterThan(20);
    expect(even).toBeGreaterThan(20);
  });
  it('a laser gate opposite a stat gate gets the full 8-rat guard unless the corridor eats slots', () => {
    let seen = 0;
    for (const seed of seeds) {
      for (let k = 2; k < 4000 / config.lane.segmentM; k++) {
        if (!spawnsGate(k) || isBossSegment(k - 2) || inClearZone(k - 2)) continue;
        const pair = generateSegment(seed, k).gate!;
        const d = Math.abs(gateValue(pair.left) - gateValue(pair.right));
        if (d !== 2) continue;
        seen++;
        expect(generateSegment(seed, k - 2).rats.length).toBeGreaterThanOrEqual(G.ratsPerValue * 2 - 6);
      }
    }
    expect(seen).toBeGreaterThan(0);
  });
});
