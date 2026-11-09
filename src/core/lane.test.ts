import { describe, expect, inject, it } from 'vitest';
import type { CoreEvent, Gate, Mods, StatGate, StatKey, WeaponId } from './types.ts';
import { STAT_KEYS, WEAPON_IDS } from './types.ts';
import { config } from './config.ts';
import { generateSegment, step, view, validateGate } from './index.ts';
import { corridorHalfU, segU, corridorX } from './lane.ts';
import {
  catTopY, clampMods, defaultMods, effBounces, effDamage, effFireRate, effPierce, effProjectiles, effRange, isAdditive, tierFor, DEBUFFABLE,
} from './stats.ts';
import { corridorFollower, runFromScenario, stateOf } from './testing.ts';

const full = inject('full');
const W = config.world;
const L = config.lane;

/** Distance covered from rest in `ticks` ticks at move speed 1.0 (accelerate, then cruise). */
function reachFromRest(ticks: number): number {
  let v = 0;
  let x = 0;
  for (let i = 0; i < ticks; i++) {
    v = Math.min(config.cat.maxSpeedUPerTick, v + config.cat.accelUPerTick2);
    x += v;
  }
  return x;
}

const anchorMargin = corridorHalfU + L.corridorEdgeMarginU;
const maxShift = (W.widthU - 2 * anchorMargin) / L.anchorEverySegments;

describe('T-config (F2–F4, F12, F14, F15): invariants on the live config', () => {
  const smax = config.scroll.maxUPerTick;
  const gateSpawnY = config.gates.spawnYU - config.gates.dyU;
  it('F4: a gate is on screen ≥ 90 ticks before it crosses', () => {
    expect((W.catLineY - gateSpawnY) / smax).toBeGreaterThanOrEqual(90);
  });
  it('F2: the screen is empty when the boss spawns', () => {
    const r = config.rat;
    expect(r.spawnYU - (L.bandU - r.sizeU) + (config.boss.clearM + L.segmentM) * 10 - r.sizeU / 2).toBeGreaterThan(W.heightU);
  });
  it('F12: the last gate before a boss crosses before the warning', () => {
    expect((W.catLineY - gateSpawnY) / 10 - config.boss.clearM - L.segmentM).toBeLessThanOrEqual(-(config.boss.warningM + 5));
  });
  it('marks align with segments', () => {
    for (const m of [config.boss.everyM, config.gates.everyM, config.boss.clearM, L.warmupM]) expect(m % L.segmentM).toBe(0);
  });
  it('F3: free window lets the cat reach the next corridor', () => {
    const window = segU - L.bandU - config.cat.heightU;
    expect(window).toBeGreaterThan(0);
    const need = maxShift - (2 * corridorHalfU - config.cat.widthU);
    expect(reachFromRest(Math.floor(window / smax))).toBeGreaterThanOrEqual(need);
  });
  it('F15 lateral: reach around gates with one buffer each side', () => {
    const catBottom = W.catLineY + config.cat.heightU / 2;
    const bandTop = config.rat.spawnYU - (L.bandU - config.rat.sizeU) - config.rat.sizeU / 2;
    const cross = W.catLineY - gateSpawnY; // distance (rel. to g·segU) at which the gate centre reaches the cat line
    const lastContactBefore = catBottom - bandTop - 2 * segU; // band g−2 fully passed
    const firstContactAfter = catTopY - (config.rat.spawnYU + config.rat.sizeU / 2) + 2 * segU; // band g+2 reaches the cat
    const before = Math.floor((cross - lastContactBefore) / smax);
    const after = Math.floor((firstContactAfter - cross) / smax);
    const halfCat = config.cat.widthU / 2;
    const extremeCorridorEdgeCat = anchorMargin - (corridorHalfU - halfCat);
    expect(reachFromRest(before)).toBeGreaterThanOrEqual(W.widthU / 2 - extremeCorridorEdgeCat);
    // from the wall (cat centre at halfCat) to the near edge of the far extreme corridor
    const farCorridorNear = W.widthU - anchorMargin - (corridorHalfU - halfCat);
    expect(reachFromRest(after)).toBeGreaterThanOrEqual(farCorridorNear - halfCat);
  });
  it('lane density: gate + two buffers + ≥1 horde segment', () => {
    expect(config.gates.everyM / L.segmentM - 3).toBeGreaterThanOrEqual(1);
  });
  it('F15: gate-to-rat clearance to neighbouring bands', () => {
    const gateY = -config.gates.dyU + config.gates.spawnYU; // relative to the segment origin
    const above = config.rat.spawnYU - segU; // band g+1, lowest rat
    const below = config.rat.spawnYU - (L.bandU - config.rat.sizeU) + segU; // band g−1, highest rat
    const clearance = Math.min(gateY - above, below - gateY);
    expect(clearance).toBeGreaterThanOrEqual(config.cat.heightU / 2 + config.rat.sizeU / 2 + config.gates.heightU / 2);
  });
  it('F14: projectiles cannot tunnel through a rat in one tick', () => {
    for (const w of [config.weapons.pencil, config.weapons.yarn, config.weapons.fishbone]) {
      expect(w.speedU + smax).toBeLessThan(config.rat.sizeU + w.h);
    }
  });
  it('F5, F3: debuffs bite at base 1.0 and never target additive stats or move speed', () => {
    for (const t of config.gates.tiers) {
      expect(t.debuffMult).toBeLessThan(1);
      expect(t.debuffMult).toBeGreaterThan(config.clamps.multMin);
    }
    expect(DEBUFFABLE).not.toContain('pierceAdd');
    expect(DEBUFFABLE).not.toContain('projectilesAdd');
    expect(DEBUFFABLE).not.toContain('moveSpeedMult');
  });
  it('F5 buff side: every buff alone raises its effective stat for every weapon and tier', () => {
    expect(config.weapons.laser.rangeU).toBeLessThan(catTopY);
    for (const t of config.gates.tiers) {
      for (const stat of STAT_KEYS) {
        const g: StatGate = { kind: 'stat', buff: { stat, value: isAdditive(stat) ? t.buffAdd : t.buffMult }, debuff: { stat: 'rangeMult', value: 1 } };
        for (const w of WEAPON_IDS) expect(effStat(w, applyOnly(g.buff), stat)).toBeGreaterThan(effStat(w, defaultMods(), stat));
      }
    }
  });
});

function applyOnly(c: { stat: StatKey; value: number }): Mods {
  const m = defaultMods();
  if (isAdditive(c.stat)) m[c.stat] += c.value;
  else m[c.stat] *= c.value;
  clampMods(m);
  return m;
}

function effStat(w: WeaponId, m: Mods, stat: StatKey): number {
  switch (stat) {
    case 'damageMult': return effDamage(w, m);
    case 'fireRateMult': return effFireRate(w, m);
    case 'rangeMult': return effRange(w, m);
    case 'pierceAdd': return w === 'yarn' ? effBounces(m) : effPierce(w, m);
    case 'projectilesAdd': return effProjectiles(w, m);
    case 'moveSpeedMult': return m.moveSpeedMult;
  }
}

const genSeeds = Array.from({ length: full ? 1000 : 100 }, (_, i) => 'gen' + i);
const segs3000 = 3000 / L.segmentM;

describe('T-corridor (F3)', () => {
  it('no rat in its corridor; shift bound holds', () => {
    const seeds = full ? genSeeds.slice(0, 200) : genSeeds;
    for (const seed of seeds) {
      let prev = corridorX(seed, 0);
      for (let k = 0; k < segs3000; k++) {
        const s = generateSegment(seed, k);
        expect(Math.abs(s.corridorX - prev)).toBeLessThanOrEqual(maxShift + 1e-9);
        prev = s.corridorX;
        for (const r of s.rats) expect(Math.abs(r.x - s.corridorX)).toBeGreaterThanOrEqual(corridorHalfU + config.rat.sizeU / 2);
      }
    }
  });
  it.runIf(full)('a corridor-follower bot runs 3,000 m with zero hits (full only)', () => {
    for (const seed of genSeeds.slice(0, 200)) {
      const run = runFromScenario({ seed, distanceM: 0, mods: { damageMult: 20 } });
      let hits = 0;
      while (view(run).distanceU < 30000 && view(run).over === null) {
        hits += step(run, corridorFollower(view(run))).filter((e) => e.t === 'catHit').length;
      }
      expect({ seed, hits }).toEqual({ seed, hits: 0 });
    }
  });
});

describe('T-gates (F5, F10)', () => {
  it('validateGate rejects a pure buff, a DPS-only trade and an additive debuff', () => {
    const pure = { kind: 'stat', buff: { stat: 'damageMult', value: 1.3 } } as unknown as Gate;
    expect(validateGate(pure).ok).toBe(false);
    expect(validateGate({ kind: 'stat', buff: { stat: 'damageMult', value: 1.3 }, debuff: { stat: 'fireRateMult', value: 0.8 } }).ok).toBe(false);
    expect(validateGate({ kind: 'stat', buff: { stat: 'rangeMult', value: 1.3 }, debuff: { stat: 'pierceAdd', value: 0.8 } }).ok).toBe(false);
    expect(validateGate({ kind: 'stat', buff: { stat: 'rangeMult', value: 1.3 }, debuff: { stat: 'damageMult', value: 0.8 } }).ok).toBe(true);
  });
  it('every generated gate is valid, and every stat half costs and gives something for every weapon', () => {
    let gates = 0;
    for (const seed of genSeeds) {
      for (let k = 0; k < segs3000; k++) {
        const g = generateSegment(seed, k).gate;
        if (!g) continue;
        gates++;
        for (const half of [g.left, g.right]) {
          expect(validateGate(half)).toEqual({ ok: true });
          const sg = half.kind === 'weapon' ? half.fallback : half;
          const t = tierFor(k * L.segmentM);
          expect(sg.debuff.value).toBe(t.debuffMult);
          for (const w of WEAPON_IDS) {
            const base = defaultMods();
            expect(effStat(w, applyOnly(sg.debuff), sg.debuff.stat)).toBeLessThan(effStat(w, base, sg.debuff.stat));
            expect(effStat(w, applyOnly(sg.buff), sg.buff.stat)).toBeGreaterThan(effStat(w, base, sg.buff.stat));
          }
        }
      }
    }
    expect(gates).toBeGreaterThan(genSeeds.length * 10);
  });
  it('holding the offered weapon applies the fallback', () => {
    // Find a weapon gate, then cross it holding that weapon.
    for (const seed of genSeeds) {
      for (let k = 0; k < segs3000; k++) {
        const seg = generateSegment(seed, k);
        const g = seg.gate;
        if (!g) continue;
        const wg = g.left.kind === 'weapon' ? g.left : g.right.kind === 'weapon' ? g.right : null;
        if (!wg || wg.kind !== 'weapon') continue;
        const side = wg === g.left ? 'left' : 'right';
        const catX = side === 'left' ? 100 : 440;
        const run = runFromScenario({ seed, distanceM: (k - 1) * L.segmentM, weapon: wg.weapon, hp: 1e9, catX });
        let taken: Extract<CoreEvent, { t: 'gateTaken' }> | undefined;
        for (let t = 0; t < 1000 && !taken; t++) {
          const e = step(run, 0).find((x) => x.t === 'gateTaken');
          if (e && e.t === 'gateTaken') taken = e;
        }
        expect(taken?.side).toBe(side);
        expect(taken?.applied).toEqual(wg.fallback);
        expect(view(run).cat.weapon).toBe(wg.weapon);
        return;
      }
    }
    throw new Error('no weapon gate found');
  });
});

describe('T-warning (F2, F12)', () => {
  const seeds = full ? Array.from({ length: 1000 }, (_, i) => 'warn' + i) : ['warn0', 'warn1', 'warn2', 'warn3'];
  const bosses = full ? 20 : 1;
  it('no gate between bossWarning and bossSpawned; the screen is empty at spawn', () => {
    for (const seed of seeds) {
      const run = runFromScenario({ seed, distanceM: 250, hp: 1e9, mods: { damageMult: 20 } });
      let warned = false;
      let spawned = 0;
      for (let t = 0; t < 400000 && spawned < bosses; t++) {
        const ev = step(run, corridorFollower(view(run)));
        for (const e of ev) {
          if (e.t === 'bossWarning') warned = true;
          if (e.t === 'gateTaken') expect(warned).toBe(false);
          if (e.t === 'bossSpawned') {
            expect(warned).toBe(true);
            expect(view(run).rats).toHaveLength(0);
            expect(view(run).gates).toHaveLength(0);
            warned = false;
            spawned++;
            stateOf(run).boss!.hp = 1; // later bosses outgrow any build; only the lane around them matters here
          }
        }
        if (view(run).over !== null) break;
      }
      expect(spawned).toBe(bosses);
    }
  });
});
