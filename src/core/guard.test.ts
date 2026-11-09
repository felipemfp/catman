// Gate guards: the better half of an uneven gate pair is guarded by a block of rats right in front of its box (CORE_VERSION 11).
import { describe, expect, it } from 'vitest';
import { config } from './config.ts';
import { step, view } from './index.ts';
import { runFromScenario } from './testing.ts';
import { bossMarkK, corridorHalfU, gateValue, generateSegment, inClearZone, isBossSegment, nextBossIndex, spawnsGate } from './lane.ts';

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
  // CORE_VERSION 11 (Felipe: "weapon gates still look unprotected"). Failure modes written first:
  //  - the guard passes the cat long before its gate arrives (old: two segments ahead, 0 rats left at 300 U)
  //  - guards drift off the box (homing) or run ahead of it (charge)
  //  - a gap in the block lets a cat take the weapon without killing anything (after homing starts)
  //  - the worse half or an even pair gets guarded
  it('an uneven pair gets a block right in front of its better box, sized by the gap; an even pair gets none', () => {
    let guarded = 0;
    let even = 0;
    const ratBelowGate = (dy: number) => config.rat.spawnYU - config.gates.spawnYU + config.gates.dyU + config.lane.segmentM * 10 - dy;
    for (const seed of seeds) {
      for (let k = 2; k < 4000 / config.lane.segmentM; k++) {
        if (!spawnsGate(seed, k) || isBossSegment(seed, k - 1) || inClearZone(seed, k - 1)) continue;
        const pair = generateSegment(seed, k).gate!;
        const diff = gateValue(pair.left) - gateValue(pair.right);
        const g = generateSegment(seed, k - 1);
        if (diff === 0) {
          even++;
          expect(g.kind).toBe('empty');
          continue;
        }
        guarded++;
        expect(g.kind).toBe('guard');
        const boxX = diff > 0 ? W / 4 : (3 * W) / 4;
        const n = Math.min(G.cap, G.ratsPerValue * Math.abs(diff));
        const solid = (k - 1) * config.lane.segmentM >= config.rat.homing.startM;
        if (solid) expect(g.rats).toHaveLength(n);
        else {
          expect(g.rats.length).toBeLessThanOrEqual(n);
          for (const r of g.rats) expect(Math.abs(r.x - g.corridorX)).toBeGreaterThanOrEqual(corridorHalfU + config.rat.sizeU / 2);
        }
        for (const r of g.rats) {
          // centred on the box, and between the gate and the cat, close to the gate
          expect(Math.abs(r.x - boxX)).toBeLessThanOrEqual(((G.perRow - 1) / 2) * G.slotSpacingU); // centred on the box, wider than the take window
          const below = ratBelowGate(r.dy);
          expect(below).toBeGreaterThanOrEqual(G.firstRowU);
          expect(below).toBeLessThanOrEqual(G.firstRowU + (Math.ceil(G.cap / G.perRow) - 1) * G.rowSpacingU);
        }
        expect(g.tuna).toBeNull();
        if (!isBossSegment(seed, k + 1) && !inClearZone(seed, k + 1)) expect(generateSegment(seed, k + 1).kind).toBe('empty'); // the buffer after a gate stays empty
      }
    }
    expect(guarded).toBeGreaterThan(20);
    expect(even).toBeGreaterThan(20);
  });
  it('a full row leaves no way into the box: a cat anywhere in the box window overlaps a guard', () => {
    const reach = (config.gates.widthU + config.cat.widthU) / 2;
    const offs = Array.from({ length: G.perRow }, (_, i) => (i - (G.perRow - 1) / 2) * G.slotSpacingU);
    for (let x = -reach + 1; x < reach; x++) {
      expect(offs.some((o) => Math.abs(x - o) < (config.cat.widthU + config.rat.sizeU) / 2)).toBe(true);
    }
  });
});

describe('gate guards in play (CORE_VERSION 11)', () => {
  /** First guarded weapon gate past homing start, for a seed. */
  function findGuard(seed: string): { k: number; boxX: number; n: number } | null {
    for (let k = Math.ceil(config.rat.homing.startM / config.lane.segmentM) + 2; k < 200; k++) {
      if (!spawnsGate(seed, k) || isBossSegment(seed, k - 1) || inClearZone(seed, k - 1)) continue;
      if (bossMarkK(seed, nextBossIndex(seed, k - 3)) <= k + 1) continue; // no boss fight between the scenario start and the gate
      const pair = generateSegment(seed, k).gate!;
      const diff = gateValue(pair.left) - gateValue(pair.right);
      if (diff === 0) continue;
      return { k, boxX: diff > 0 ? W / 4 : (3 * W) / 4, n: generateSegment(seed, k - 1).rats.length };
    }
    return null;
  }
  it('the whole block is still in front of the box when the gate is 300 U away, and has not moved sideways', () => {
    let checked = 0;
    for (const seed of seeds) {
      const f = findGuard(seed);
      if (!f) continue;
      // cat parked on the other half, shots that can't reach: nothing touches the block
      const run = runFromScenario({ seed, distanceM: (f.k - 3) * config.lane.segmentM, hp: 1e9, catX: W - f.boxX, weapon: 'laser', mods: { rangeMult: config.clamps.multMin } });
      let gateY = -Infinity;
      for (let t = 0; t < 3000 && gateY < config.world.catLineY - 300; t++) {
        step(run, 0);
        gateY = view(run).gates.find((g) => g.laneId === f.k * 64)?.y ?? -Infinity;
      }
      const block = view(run).rats.filter((r) => r.segmentK === f.k - 1);
      expect({ seed, k: f.k, n: block.length, over: view(run).over, gateY }).toEqual({ seed, k: f.k, n: f.n, over: null, gateY });
      for (const r of block) {
        expect(Math.abs(r.x - f.boxX)).toBeLessThanOrEqual(((G.perRow - 1) / 2) * G.slotSpacingU);
        expect(r.y).toBeGreaterThan(gateY);
        expect(r.y - gateY).toBeLessThanOrEqual(G.firstRowU + 2 * G.rowSpacingU + 1e-9);
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(5);
  });
  it('no flank-then-slide: waiting beside the block and steering in late never takes the gate unhit', () => {
    // critic finding (CORE_VERSION 11 review): with a 4-wide block a cat could wait just outside it and slide in after
    // the front row passed. Try every wait position outside the block and every steer-in moment.
    const reach = (config.gates.widthU + config.cat.widthU) / 2;
    const blockHalf = ((G.perRow - 1) / 2) * G.slotSpacingU + (config.rat.sizeU + config.cat.widthU) / 2;
    let attempts = 0;
    let taken = 0;
    for (const seed of seeds.slice(0, 8)) {
      const f = findGuard(seed);
      if (!f) continue;
      for (const sideSign of [-1, 1]) for (const d of [reach + 1, blockHalf, blockHalf + 10, blockHalf + 30]) {
        const startX = f.boxX + sideSign * d;
        if (startX < config.cat.widthU / 2 || startX > W - config.cat.widthU / 2) continue;
        for (let trigger = 0; trigger <= 200; trigger += 5) {
          const run = runFromScenario({ seed, distanceM: (f.k - 3) * config.lane.segmentM, hp: 1e9, catX: startX, weapon: 'laser', mods: { rangeMult: config.clamps.multMin } });
          let hit = false;
          let steer = false;
          for (let t = 0; t < 3000; t++) {
            const g = view(run).gates.find((x) => x.laneId === f.k * 64);
            if (g && g.y >= config.world.catLineY - trigger) steer = true;
            const input = steer ? (sideSign > 0 ? -4 : 4) : 0;
            let done = false;
            for (const e of step(run, input)) {
              if (e.t === 'catHit') hit = true;
              if (e.t === 'gateTaken' || e.t === 'gateMissed') {
                done = true;
                if (e.t === 'gateTaken' && (e.side === 'left') === (f.boxX < W / 2)) {
                  taken++;
                  expect({ seed, startX, trigger, hit }).toEqual({ seed, startX, trigger, hit: true });
                }
              }
            }
            if (done) break;
          }
          attempts++;
        }
      }
    }
    expect(attempts).toBeGreaterThan(200);
    expect(taken).toBeGreaterThan(0); // some attempts do reach the box, so the assertion above is exercised
  });
  it('a cat that holds the box without killing anything gets hit before it takes the gate', () => {
    let checked = 0;
    for (const seed of seeds) {
      const f = findGuard(seed);
      if (!f) continue;
      const run = runFromScenario({ seed, distanceM: (f.k - 3) * config.lane.segmentM, hp: 1e9, catX: f.boxX, weapon: 'laser', mods: { rangeMult: config.clamps.multMin } });
      let hit = false;
      let taken = false;
      for (let t = 0; t < 3000 && !taken; t++) {
        for (const e of step(run, 0)) {
          if (e.t === 'catHit') hit = true;
          if (e.t === 'gateTaken') { taken = true; expect(hit).toBe(true); }
        }
      }
      expect(taken).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(5);
  });
});
