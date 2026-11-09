// Boss schedule and variants (SPEC-game-core § Boss schedule, § Boss variants). CORE_VERSION 10.
// Failure modes written first:
//  - the schedule is fixed, or gaps leave their bounds, or two runs of one seed disagree
//  - a gate spawns on a boss mark or inside its clear zone
//  - boss 0 is not plain; variants never roll, roll too often early, or combos show up before comboFrom
//  - twins share a half (one shot column hits both), or the fight ends when only one twin dies
//  - horde/frenzy waves never spawn, spawn in a plain fight, don't move during the stopped lane, or leave no gap
//  - the telegraph is missing, late, repeated, or names a different variant than the fight
import { describe, expect, it } from 'vitest';
import type { CoreEvent } from './types.ts';
import { config } from './config.ts';
import { step, view } from './index.ts';
import { BOSS_FRENZY, BOSS_HORDE, BOSS_TWINS, bossMarkK, bossVariant, inClearZone, isBossSegment, spawnsGate } from './lane.ts';
import { bossHpFor, variantHpMult } from './step.ts';
import { runFromScenario, stateOf } from './testing.ts';
import { ofType } from './test-util.test-helpers.ts';

const B = config.boss;
const S = B.schedule;
const W = config.world.widthU;
const SEG = config.lane.segmentM;
const seeds = Array.from({ length: 400 }, (_, i) => 'vs' + i.toString(36).padStart(3, '0'));

/** First (seed, boss index) whose variant is exactly `flags`. */
function find(flags: number): { seed: string; i: number } {
  for (const seed of seeds) for (let i = 1; i < 8; i++) if (bossVariant(seed, i) === flags) return { seed, i };
  throw new Error('no boss with variant ' + flags);
}

/** A run 50 m before boss i, stepped to its spawn. Invincible cat parked at x, no gates. */
function intoFight(seed: string, i: number, catX = W / 2) {
  const markM = bossMarkK(seed, i) * SEG;
  const run = runFromScenario({ seed, distanceM: markM - 50, hp: 1e9, gates: false, catX, weapon: 'laser', mods: { rangeMult: config.clamps.multMin } });
  const ev: CoreEvent[] = [];
  for (let t = 0; t < 5000 && !ev.some((e) => e.t === 'bossSpawned'); t++) ev.push(...step(run, 0));
  expect(ofType(ev, 'bossSpawned')).toHaveLength(1);
  return { run, ev };
}

describe('boss schedule', () => {
  it('boss 0 lands in firstM; each gap stays inside its sliding range; marks are whole segments', () => {
    for (const seed of seeds) {
      const m0 = bossMarkK(seed, 0) * SEG;
      expect(m0).toBeGreaterThanOrEqual(S.firstM[0]);
      expect(m0).toBeLessThanOrEqual(S.firstM[1]);
      for (let i = 1; i < 15; i++) {
        const prev = bossMarkK(seed, i - 1) * SEG;
        const gap = bossMarkK(seed, i) * SEG - prev;
        const t = Math.min(1, prev / S.farM);
        const lo = S.gapNearM[0] + (S.gapFarM[0] - S.gapNearM[0]) * t;
        const hi = S.gapNearM[1] + (S.gapFarM[1] - S.gapNearM[1]) * t;
        expect(gap).toBeGreaterThanOrEqual(lo - SEG / 2);
        expect(gap).toBeLessThanOrEqual(hi + SEG / 2);
        if (prev >= S.farM) { expect(gap).toBeGreaterThanOrEqual(S.gapFarM[0]); expect(gap).toBeLessThanOrEqual(S.gapFarM[1]); }
      }
    }
  });
  it('is not fixed: boss 0 and gaps vary across seeds, and late gaps are shorter on average', () => {
    const firsts = new Set(seeds.map((s) => bossMarkK(s, 0)));
    expect(firsts.size).toBeGreaterThanOrEqual(4);
    const gaps = new Set(seeds.map((s) => bossMarkK(s, 2) - bossMarkK(s, 1)));
    expect(gaps.size).toBeGreaterThanOrEqual(8);
    let early = 0;
    let late = 0;
    for (const s of seeds) { early += bossMarkK(s, 1) - bossMarkK(s, 0); late += bossMarkK(s, 12) - bossMarkK(s, 11); }
    expect(late).toBeLessThan(early);
  });
  it('is a pure function of the seed, whatever order marks are asked in', () => {
    const a = Array.from({ length: 10 }, (_, i) => bossMarkK('pure1', 9 - i)).reverse();
    const b = Array.from({ length: 10 }, (_, i) => bossMarkK('pure1', i));
    expect(a).toEqual(b);
  });
  it('no gate on a boss mark or inside its clear zone', () => {
    for (const seed of seeds.slice(0, 50)) {
      for (let i = 0; i < 10; i++) {
        const k = bossMarkK(seed, i);
        expect(isBossSegment(seed, k)).toBe(true);
        for (let j = k - B.clearM / SEG; j <= k; j++) {
          expect(inClearZone(seed, j)).toBe(true);
          expect(spawnsGate(seed, j)).toBe(false);
        }
      }
    }
  });
});

describe('variant roll', () => {
  it('boss 0 is always plain; the chance ramps; combos only from comboFrom; all three variants show up', () => {
    const V = B.variants;
    const n = 2000;
    const rate = (i: number) => {
      let hit = 0;
      for (let s = 0; s < n; s++) if (bossVariant('roll' + s, i) !== 0) hit++;
      return hit / n;
    };
    for (let s = 0; s < n; s++) expect(bossVariant('roll' + s, 0)).toBe(0);
    expect(rate(1)).toBeCloseTo(V.chanceStart, 1);
    expect(rate(4)).toBeCloseTo(V.chanceMax, 1);
    const counts = new Map<number, number>();
    for (let s = 0; s < n; s++) for (let i = 1; i < 8; i++) {
      const f = bossVariant('roll' + s, i);
      const bits = (f & 1) + ((f >> 1) & 1) + ((f >> 2) & 1);
      if (i < V.comboFrom) expect(bits).toBeLessThanOrEqual(1);
      expect(bits).toBeLessThanOrEqual(2);
      counts.set(f, (counts.get(f) ?? 0) + 1);
    }
    for (const f of [BOSS_HORDE, BOSS_FRENZY, BOSS_TWINS, BOSS_HORDE | BOSS_FRENZY, BOSS_HORDE | BOSS_TWINS, BOSS_FRENZY | BOSS_TWINS]) {
      expect(counts.get(f) ?? 0).toBeGreaterThan(50);
    }
  });
});

describe('telegraph', () => {
  it('bossIncoming fires once per boss, about telegraphM before the mark, naming the fight variant', () => {
    for (const seed of ['tel0', 'tel1', 'tel2']) {
      const run = runFromScenario({ seed, distanceM: 100, hp: 1e9, gates: false, mods: { damageMult: 20 } });
      const told = new Map<number, number>();
      for (let t = 0; t < 60000 && view(run).bossesKilled < 5; t++) {
        for (const e of step(run, 0)) {
          if (e.t === 'bossIncoming') {
            expect(told.has(e.index)).toBe(false);
            told.set(e.index, e.variant);
            const markM = bossMarkK(seed, e.index) * SEG;
            const d = view(run).distanceU / 10;
            expect(d).toBeGreaterThanOrEqual(markM - B.telegraphM);
            expect(d).toBeLessThan(markM - B.telegraphM + 1);
          }
          if (e.t === 'bossSpawned') {
            expect(told.get(e.index)).toBe(e.variant);
            expect(e.variant).toBe(bossVariant(seed, e.index));
            // only the telegraph matters here: end each fight at once
            stateOf(run).boss!.hp = 0;
            if (view(run).twin) stateOf(run).twin!.hp = 0;
          }
        }
        if (view(run).over !== null) break;
      }
      expect(told.size).toBeGreaterThanOrEqual(5);
    }
  });
});

describe('twins', () => {
  const { seed, i } = find(BOSS_TWINS);
  it('two bosses, one per half, each with base × twins HP', () => {
    const { run } = intoFight(seed, i);
    const v = view(run);
    const hp = bossHpFor(i) * variantHpMult(BOSS_TWINS);
    expect(v.boss).toMatchObject({ x: W / 4, hp, half: 0 });
    expect(v.twin).toMatchObject({ x: (3 * W) / 4, hp, half: 1 });
  });
  it('a cat in the middle drags neither twin into the other half', () => {
    const { run } = intoFight(seed, i);
    for (let t = 0; t < 200; t++) step(run, 0);
    const v = view(run);
    expect(v.boss!.x).toBeLessThanOrEqual(W / 2 - B.sizeU / 2);
    expect(v.twin!.x).toBeGreaterThanOrEqual(W / 2 + B.sizeU / 2);
    // and no shot column hits both: their boxes never meet
    expect(v.twin!.x - v.boss!.x).toBeGreaterThanOrEqual(B.sizeU);
  });
  it('the fight ends only when both are dead: one bossKilled, the lane moves again', () => {
    const { run } = intoFight(seed, i);
    const killed0 = view(run).bossesKilled;
    stateOf(run).boss!.hp = 0;
    const ev1 = step(run, 0);
    expect(ofType(ev1, 'bossKilled')).toHaveLength(0);
    expect(view(run).boss).not.toBeNull();
    expect(view(run).boss!.half).toBe(1); // the right twin took the slot
    expect(view(run).twin).toBeNull();
    const d = view(run).distanceU;
    step(run, 0);
    expect(view(run).distanceU).toBe(d);
    stateOf(run).boss!.hp = 0;
    const ev2 = step(run, 0);
    expect(ofType(ev2, 'bossKilled')).toHaveLength(1);
    expect(view(run).boss).toBeNull();
    expect(view(run).fight).toBeNull();
    expect(view(run).bossesKilled).toBe(killed0 + 1);
  });
  it('either twin reaching the cat ends the run', () => {
    const { run } = intoFight(seed, i, 20);
    stateOf(run).boss!.hp = 1e12;
    stateOf(run).twin!.hp = 1e12;
    for (let t = 0; t < 5000 && view(run).over === null; t++) step(run, 0);
    expect(view(run).over).toBe('boss');
  });
});

describe('waves', () => {
  it('plain fight: no waves', () => {
    const { run } = intoFight('plain0', 0);
    for (let t = 0; t < 400; t++) step(run, 0);
    expect(view(run).rats).toHaveLength(0);
  });
  it('horde: a row of wall slots with one gap of gapSlots, moving down at speedU while the lane is stopped', () => {
    const { seed, i } = find(BOSS_HORDE);
    const { run } = intoFight(seed, i);
    stateOf(run).boss!.hp = 1e12;
    for (let t = 0; t < B.horde.firstTicks && view(run).rats.length === 0; t++) step(run, 0);
    const row = view(run).rats.map((r) => ({ id: r.laneId, x: r.x, y: r.y }));
    expect(row).toHaveLength(config.lane.wallSlots - B.horde.gapSlots);
    const slots = row.map((r) => Math.round((r.x - config.lane.wallSlotOriginU) / config.lane.wallSlotSpacingU));
    const missing = [];
    for (let s = 0; s < config.lane.wallSlots; s++) if (!slots.includes(s)) missing.push(s);
    expect(missing).toHaveLength(B.horde.gapSlots);
    expect(missing[missing.length - 1]! - missing[0]!).toBe(B.horde.gapSlots - 1);
    const d = view(run).distanceU;
    step(run, 0);
    expect(view(run).distanceU).toBe(d);
    for (const r of row) {
      const now = view(run).rats.find((x) => x.laneId === r.id)!;
      expect(now.y - r.y).toBeCloseTo(B.horde.speedU, 9);
    }
  });
  it('horde waves come faster as boss HP falls', () => {
    const { seed, i } = find(BOSS_HORDE);
    const gaps = (hpFrac: number) => {
      const { run } = intoFight(seed, i);
      const b = stateOf(run).boss!;
      b.hp = b.maxHp * hpFrac;
      stateOf(run).boss!.y = -1e6; // never arrives
      const ticks: number[] = [];
      let waves = 0;
      for (let t = 0; t < 1000; t++) {
        step(run, 0);
        if (view(run).fight!.waves !== waves) { waves = view(run).fight!.waves; ticks.push(view(run).tick); }
      }
      return ticks[2]! - ticks[1]!;
    };
    expect(gaps(1)).toBe(B.horde.everyTicks);
    expect(gaps(0.001)).toBeLessThanOrEqual(B.horde.minEveryTicks + 1);
  });
  it('frenzy: a few fast rats that home on the cat', () => {
    const { seed, i } = find(BOSS_FRENZY);
    const { run } = intoFight(seed, i, 60);
    stateOf(run).boss!.hp = 1e12;
    for (let t = 0; t < B.frenzy.firstTicks && view(run).rats.length === 0; t++) step(run, 0);
    const rats = view(run).rats.map((r) => ({ id: r.laneId, x: r.x, y: r.y }));
    expect(rats).toHaveLength(B.frenzy.rats);
    step(run, 0);
    for (const r of rats) {
      const now = view(run).rats.find((x) => x.laneId === r.id)!;
      expect(now.y - r.y).toBeCloseTo(B.frenzy.speedU, 9);
      expect(Math.abs(now.x - 60)).toBeLessThanOrEqual(Math.abs(r.x - 60));
    }
  });
  it('waves stop with the fight', () => {
    const { seed, i } = find(BOSS_HORDE);
    const { run } = intoFight(seed, i);
    stateOf(run).boss!.hp = 0;
    step(run, 0);
    expect(view(run).fight).toBeNull();
    const waveRats = () => view(run).rats.filter((r) => r.segmentK < -1).length;
    let prev = waveRats();
    for (let t = 0; t < 400; t++) {
      step(run, 0);
      expect(waveRats()).toBeLessThanOrEqual(prev);
      prev = waveRats();
    }
  });
});
