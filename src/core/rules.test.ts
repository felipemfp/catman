import { describe, expect, inject, it } from 'vitest';
import type { CoreEvent, Mods, Projectile, StatGate, WeaponId } from './types.ts';
import { config } from './config.ts';
import { generateSegment, hashState, simulateBossFight, step, view, bossHpFor } from './index.ts';
import { assertFiniteState, corridorFollower, runFromScenario, stateOf } from './testing.ts';
import { stepCat } from './cat.ts';
import { applyStatGate, catTopY, defaultMods } from './stats.ts';
import { spawnsGate, segU } from './lane.ts';
import { ofType } from './test-util.test-helpers.ts';

const full = inject('full');
const W = config.world;
const bossK = config.boss.everyM / config.lane.segmentM;

function stepUntil(run: ReturnType<typeof runFromScenario>, pred: (ev: CoreEvent[]) => boolean, max = 5000, input: () => -4 | 0 | 4 = () => 0) {
  const all: CoreEvent[] = [];
  for (let i = 0; i < max; i++) {
    const ev = step(run, input());
    all.push(...ev);
    if (pred(ev) || view(run).over !== null) return all;
  }
  return all;
}

describe('T-boss-reset (F6)', () => {
  const builds: { weapon: WeaponId; mods: Partial<Mods> }[] = [
    { weapon: 'yarn', mods: { rangeMult: 1.3 } },
    { weapon: 'pencil', mods: { rangeMult: 1.69 } },
  ];
  const seeds = full ? Array.from({ length: 20 }, (_, i) => 'reset' + i) : ['reset0', 'reset1'];
  for (const b of builds) for (const seed of seeds) {
    it(`${b.weapon} ${JSON.stringify(b.mods)} ${seed}`, () => {
      const bossX = generateSegment(seed, bossK).bossX!;
      const run = runFromScenario({ seed, distanceM: 450, weapon: b.weapon, mods: b.mods, hp: 1e9, catX: bossX });
      stepUntil(run, (ev) => ev.some((e) => e.t === 'bossSpawned'));
      const v = view(run);
      expect(v.boss).not.toBeNull();
      expect(v.projectiles).toHaveLength(0);
      expect(v.cat.cooldown).toBe(0);
      const spawnTick = v.tick;
      const hp = v.boss!.hp;
      const sim = simulateBossFight({ ...v.cat.mods }, v.cat.weapon, hp, bossX);
      const rest = stepUntil(run, (ev) => ev.some((e) => e.t === 'bossKilled'), 2000);
      const killed = rest.some((e) => e.t === 'bossKilled');
      expect(killed).toBe(sim.killTick !== null);
      if (killed) expect(view(run).tick - spawnTick).toBe(sim.killTick);
      else {
        expect(view(run).over).toBe('boss');
        expect(view(run).tick - spawnTick).toBe(sim.reachTick);
        expect(hp - view(run).boss!.hp).toBe(sim.damageByReach);
      }
    });
  }
  it('bossHpFor iterates multiplication', () => {
    expect(bossHpFor(0)).toBe(config.boss.baseHp);
    expect(bossHpFor(2)).toBe(config.boss.baseHp * config.boss.hpGrowth * config.boss.hpGrowth);
  });
});

describe('T-wall-rest (F15)', () => {
  it('holding −4 at x = 20 for 10 ticks leaves vx = 0', () => {
    const cat = { x: 20, vx: 0, hp: 3, invulnTicks: 0, weapon: 'pencil' as const, mods: defaultMods(), cooldown: 0 };
    for (let i = 0; i < 10; i++) stepCat(cat, -4);
    expect(cat.vx).toBe(0);
    expect(cat.x).toBe(config.cat.widthU / 2);
  });
  const seeds = full ? Array.from({ length: 100 }, (_, i) => 'wall' + i) : ['wall0', 'wall1', 'wall2', 'wall3'];
  it('a cat waiting at the left wall through a gate can still dodge band g + 2', () => {
    let checked = 0;
    for (const seed of seeds) {
      // F15 is a corridor guarantee, and homing rats (CORE_VERSION 7) end the corridor guarantee at homing.startM.
      // So: the last three gates whose window (through band g + 2) ends before homing starts.
      const lastK = Math.floor(config.rat.homing.startM / config.lane.segmentM) - 3;
      const gs: number[] = [];
      for (let k = lastK; k > 0 && gs.length < 3; k--) if (spawnsGate(k)) gs.push(k);
      expect(gs.length).toBeGreaterThanOrEqual(2);
      for (const g of gs) {
        // start in the empty buffer before the gate, pinned to the left wall, from rest
        const run = runFromScenario({ seed, distanceM: (g - 1) * config.lane.segmentM, catX: 20 });
        const st = stateOf(run);
        let crossed = false;
        const crossD = W.catLineY - (config.gates.spawnYU - config.gates.dyU) + g * segU;
        const passedG2 = (W.catLineY + config.cat.heightU / 2) - (config.rat.spawnYU - (config.lane.bandU - config.rat.sizeU) - config.rat.sizeU / 2) + (g + 2) * segU;
        let hits = 0;
        for (let t = 0; t < 3000 && st.distanceU < passedG2 && st.over === null; t++) {
          if (!crossed && st.distanceU >= crossD) crossed = true;
          const lvl = crossed ? corridorFollower(view(run)) : -4;
          hits += ofType(step(run, lvl), 'catHit').length;
        }
        expect({ seed, g, hits }).toEqual({ seed, g, hits: 0 });
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(seeds.length * 2);
  });
});

describe('T-once (F7) with narrow gates (CORE_VERSION 9)', () => {
  // each half is a box of gates.widthU centred in its half; the cat takes it only if its body overlaps the box
  const reach = (config.gates.widthU + config.cat.widthU) / 2;
  const cL = W.widthU / 4;
  const cR = (3 * W.widthU) / 4;
  const cases: [number, 'left' | 'right' | null][] = [
    [cL, 'left'], [cL - reach + 1, 'left'], [cL + reach - 1, 'left'], [cL - reach - 1, null], [cL + reach + 1, null],
    [cR, 'right'], [cR - reach + 1, 'right'], [cR + reach + 1, null], [W.widthU / 2, null],
  ];
  for (const [catX, side] of cases) {
    it(`cat parked at ${catX}: ${side ?? 'misses both halves'}, exactly one event per pair at max scroll`, () => {
      const s = config.scroll;
      let g = Math.ceil((s.maxUPerTick - s.baseUPerTick) / s.rampPerM / config.lane.segmentM);
      while (!spawnsGate(g)) g++;
      const run = runFromScenario({ seed: 'once0', distanceM: (g - 1) * config.lane.segmentM, catX, hp: 1e9 });
      const before = { ...view(run).cat.mods };
      const all = stepUntil(run, () => false, 300);
      const taken = ofType(all, 'gateTaken');
      const missed = ofType(all, 'gateMissed');
      if (side === null) {
        expect(taken).toHaveLength(0);
        expect(missed).toHaveLength(1);
        expect(view(run).cat.mods).toEqual(before);
      } else {
        expect(missed).toHaveLength(0);
        expect(taken).toHaveLength(1);
        expect(taken[0]!.side).toBe(side);
      }
    });
  }
});

describe('T-clamps (F8)', () => {
  it('50 max buffs and 50 max debuffs keep every stat at its clamp', () => {
    const t = config.gates.tiers[config.gates.tiers.length - 1]!;
    const up = defaultMods();
    const down = defaultMods();
    const buffs: StatGate['buff'][] = [
      { stat: 'damageMult', value: t.buffMult }, { stat: 'fireRateMult', value: t.buffMult }, { stat: 'rangeMult', value: t.buffMult },
      { stat: 'pierceAdd', value: t.buffAdd }, { stat: 'projectilesAdd', value: t.buffAdd }, { stat: 'moveSpeedMult', value: t.buffMult },
    ];
    for (let i = 0; i < 50; i++) for (const b of buffs) applyStatGate(up, { kind: 'stat', buff: b, debuff: { stat: 'rangeMult', value: 1 } });
    for (let i = 0; i < 50; i++) {
      for (const d of ['damageMult', 'fireRateMult', 'rangeMult'] as const) {
        applyStatGate(down, { kind: 'stat', buff: { stat: 'moveSpeedMult', value: 1 }, debuff: { stat: d, value: t.debuffMult } });
      }
    }
    const c = config.clamps;
    expect(up).toEqual({ damageMult: c.multMax, fireRateMult: c.multMax, rangeMult: c.multMax, pierceAdd: c.pierceAddMax, projectilesAdd: c.projectilesAddMax, moveSpeedMult: c.moveSpeedMax });
    expect(down).toMatchObject({ damageMult: c.multMin, fireRateMult: c.multMin, rangeMult: c.multMin, moveSpeedMult: 1 });
    for (const [weapon, mods] of [['pencil', up], ['laser', up], ['yarn', up], ['fishbone', up], ['yarn', down], ['laser', down]] as const) {
      const run = runFromScenario({ seed: 'clamp0', distanceM: 1000, weapon, mods, hp: 1e9 });
      for (let i = 0; i < 1500; i++) step(run, ((i >> 5) % 3 - 1) * 4 as -4 | 0 | 4);
      assertFiniteState(run);
    }
  });
  it('yarn hitting a rat at its own position keeps its velocity', () => {
    // yarn moves 10 U/tick straight up; put two rats exactly where it will be after its first move
    const y = catTopY - config.weapons.yarn.speedU;
    const run = runFromScenario({ seed: 'clamp1', distanceM: 1000, weapon: 'yarn', hp: 1e9, rats: [{ x: 270, y, hp: 1000 }, { x: 270, y, hp: 1000 }] });
    // freeze the rats in place: scroll would move them, so cancel by making the run a boss fight
    stateOf(run).boss = { index: 99, x: 270, y: -400, hp: 1e12, maxHp: 1e12, missTicks: 0 };
    step(run, 0);
    const p = view(run).projectiles[0] as Projectile;
    expect(p.hitIds).toHaveLength(2);
    expect(p.vx).toBe(0);
    expect(p.vy).toBe(-config.weapons.yarn.speedU);
    assertFiniteState(run);
  });
});

/** Scenario with the boss pause trick so crafted rats don't scroll. */
function still(weapon: WeaponId, rats: { x: number; y: number; hp: number }[], mods: Partial<Mods> = {}) {
  const run = runFromScenario({ seed: 'hits0', distanceM: 1000, weapon, hp: 1e9, rats, mods });
  stateOf(run).boss = { index: 99, x: 270, y: -2000, hp: 1e12, maxHp: 1e12, missTicks: 0 };
  return run;
}

describe('T-hits', () => {
  it('pencil with pierce 2 hits 3 stacked rats, then is removed', () => {
    const y = catTopY - config.weapons.pencil.speedU;
    const run = still('pencil', [{ x: 270, y, hp: 1000 }, { x: 270, y: y - 1, hp: 1000 }, { x: 270, y: y - 2, hp: 1000 }, { x: 270, y: y - 3, hp: 1000 }]);
    const ev = step(run, 0);
    expect(ofType(ev, 'damage')).toHaveLength(3);
    expect(view(run).projectiles).toHaveLength(0);
    const d = config.weapons.pencil.damage;
    expect(view(run).rats.map((r) => r.hp)).toEqual([1000 - d, 1000 - d, 1000 - d, 1000]);
  });
  it('one pencil on the boss deals one hit and is removed', () => {
    const run = runFromScenario({ seed: 'hits1', distanceM: 1000, hp: 1e9, boss: { x: 270, y: catTopY - 80, hp: 500 } });
    const ev = step(run, 0);
    expect(ofType(ev, 'damage')).toHaveLength(1);
    expect(view(run).boss!.hp).toBe(500 - config.weapons.pencil.damage);
    expect(view(run).projectiles).toHaveLength(0);
  });
  for (const pierceAdd of [0, 2]) {
    const mult = 1 + config.boss.pierceBonus * pierceAdd;
    it(`a pencil with pierceAdd ${pierceAdd} hits the boss for damage × ${mult}`, () => {
      const run = runFromScenario({ seed: 'hits2', distanceM: 1000, hp: 1e9, mods: { pierceAdd }, boss: { x: 270, y: catTopY - 80, hp: 500 } });
      step(run, 0);
      expect(view(run).boss!.hp).toBeCloseTo(500 - config.weapons.pencil.damage * mult, 9);
    });
    it(`a laser with pierceAdd ${pierceAdd} hits the boss for dps × ${mult}`, () => {
      const run = runFromScenario({ seed: 'hits3', distanceM: 1000, hp: 1e9, weapon: 'laser', mods: { pierceAdd }, boss: { x: 270, y: catTopY - 80, hp: 500 } });
      step(run, 0);
      expect(view(run).boss!.hp).toBeCloseTo(500 - (config.weapons.laser.dps / 60) * mult, 9);
    });
  }
  for (const pierceAdd of [0, 1]) {
    it(`yarn bounces effBounces times (pierceAdd ${pierceAdd})`, () => {
      const y0 = catTopY - 40; // clear of the cat, so no contact
      const rats = Array.from({ length: 8 }, (_, i) => ({ x: 270, y: y0 - i * 40, hp: 1000 }));
      // fire rate at its clamp floor, so the second shot comes long after the 21-tick window, whatever the tuning
      const run = still('yarn', rats, { pierceAdd, fireRateMult: config.clamps.multMin });
      expect(60 / (config.weapons.yarn.rate * config.clamps.multMin)).toBeGreaterThan(21);
      let damage = 0;
      for (let i = 0; i <= 20; i++) damage += ofType(step(run, 0), 'damage').length;
      expect(damage).toBe(1 + config.weapons.yarn.bounces + pierceAdd);
    });
  }
  it('laser with pierce 0 hits only the lowest rat', () => {
    const run = still('laser', [{ x: 270, y: 500, hp: 1000 }, { x: 270, y: 700, hp: 1000 }, { x: 270, y: 300, hp: 1000 }]);
    step(run, 0);
    const hp = view(run).rats.map((r) => r.hp);
    expect(hp[0]).toBe(1000);
    expect(hp[1]).toBeLessThan(1000);
    expect(hp[2]).toBe(1000);
  });
  it('laser → pencil swap keeps cooldown and fires again', () => {
    const run = still('pencil', []);
    for (let i = 0; i < 5; i++) step(run, 0);
    const cd = view(run).cat.cooldown;
    stateOf(run).cat.weapon = 'laser';
    for (let i = 0; i < 30; i++) step(run, 0);
    expect(view(run).cat.cooldown).toBe(cd);
    stateOf(run).cat.weapon = 'pencil';
    const before = view(run).nextProjectileId;
    for (let i = 0; i < 16; i++) step(run, 0);
    expect(view(run).nextProjectileId).toBeGreaterThan(before);
  });
  it('a rat killed by a beam is not hit by a projectile in the same step', () => {
    const y = catTopY - config.weapons.pencil.speedU;
    const run = still('laser', [{ x: 270, y, hp: 1 }]);
    const st = stateOf(run);
    st.projectiles.push({
      id: 999, weapon: 'pencil', x: 270, y: y + config.weapons.pencil.speedU, vx: 0, vy: -config.weapons.pencil.speedU,
      w: 6, h: 16, speedU: 14, damage: 10, rangeU: 520, travelled: 0, hitsLeft: 3, hitIds: [],
    });
    const ev = step(run, 0);
    expect(ofType(ev, 'ratKilled')).toHaveLength(1);
    expect(view(run).projectiles[0]!.hitIds).toEqual([]);
  });
});

describe('T-end', () => {
  it("'rats': the contact that takes the last HP ends the run that tick", () => {
    const run = runFromScenario({ seed: 'end0', distanceM: 1000, hp: 1, rats: [{ x: 270, y: W.catLineY, hp: 1000 }] });
    const ev = step(run, 0);
    expect(ofType(ev, 'catHit')).toHaveLength(1);
    expect(ofType(ev, 'ended')[0]).toMatchObject({ cause: 'rats', tick: 1 });
  });
  it("'boss': the boss reaching the cat ends the run", () => {
    const run = runFromScenario({ seed: 'end1', distanceM: 1000, hp: 3, boss: { x: 270, y: catTopY - config.boss.sizeU / 2 - 1, hp: 1e9 } });
    const ev = step(run, 0);
    expect(ofType(ev, 'ended')[0]).toMatchObject({ cause: 'boss' });
  });
  it("'timeout' after exactly maxTicks", () => {
    const max = config.run.maxTicks;
    const run = runFromScenario({ seed: 'end2', distanceM: 1000, hp: 1e9, tick: max - 10 });
    const all: CoreEvent[] = [];
    for (let i = 0; i < 10; i++) all.push(...step(run, 0));
    expect(ofType(all, 'ended')).toEqual([{ t: 'ended', cause: 'timeout', score: view(run).score, tick: max }]);
  });
  it('timeout during hit-stop still ends on maxTicks', () => {
    const max = config.run.maxTicks;
    const run = runFromScenario({ seed: 'end3', distanceM: 1000, hp: 3, tick: max - 3, rats: [{ x: 270, y: W.catLineY, hp: 1000 }] });
    const e1 = step(run, 0);
    expect(ofType(e1, 'catHit')).toHaveLength(1);
    expect(view(run).freezeTicks).toBeGreaterThan(0);
    step(run, 0);
    const e3 = step(run, 0);
    expect(ofType(e3, 'ended')[0]).toMatchObject({ cause: 'timeout', tick: max });
  });
  it('post-end step() returns [] and changes nothing', () => {
    const run = runFromScenario({ seed: 'end4', distanceM: 1000, hp: 1, rats: [{ x: 270, y: W.catLineY, hp: 1000 }] });
    step(run, 0);
    const h = hashState(run);
    expect(step(run, 4)).toEqual([]);
    expect(hashState(run)).toBe(h);
  });
});
