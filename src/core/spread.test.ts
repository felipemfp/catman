// Spread gates (CORE_VERSION 13, Felipe: "a new gate stat to increase/decrease spread"). spreadMult scales the
// fan between projectiles and the laser beam's width (and beam spacing). Wider is the buff side, narrower the debuff.
// Failure modes this file pins:
//  - the stat is drawn but changes nothing in play (fan or beam ignores it)
//  - it's never offered at a gate, or never as a debuff
//  - it escapes its clamps
import { describe, expect, it } from 'vitest';
import { config } from './config.ts';
import { generateSegment, step, view } from './index.ts';
import { applyStatGate, clampMods, defaultMods, effSpread } from './stats.ts';
import { runFromScenario } from './testing.ts';

const at = (weapon: 'fishbone' | 'laser', spreadMult: number, rats: { x: number; y: number; hp: number }[] = []) =>
  runFromScenario({ seed: 'sprd', distanceM: 100, catX: 270, hp: 1e9, gates: false, weapon, mods: { spreadMult }, rats });

describe('spread in play', () => {
  it('fishbone fan: vx between neighbours scales with spreadMult', () => {
    const vxs = (m: number) => {
      const run = at('fishbone', m);
      for (let i = 0; i < 30 && view(run).projectiles.length === 0; i++) step(run, 0);
      return view(run).projectiles.map((p) => p.vx).sort((a, b) => a - b);
    };
    const one = vxs(1);
    const two = vxs(2);
    expect(one.length).toBe(config.weapons.fishbone.projectiles);
    expect(two[1]! - two[0]!).toBeCloseTo(2 * (one[1]! - one[0]!), 9);
  });
  it('laser: a rat just outside the base beam is missed at 1x and hit at 2x', () => {
    const off = (config.weapons.laser.beamWidthU + config.rat.sizeU) / 2 + 3;
    const hpAfter = (m: number) => {
      const run = at('laser', m, [{ x: 270 + off, y: 600, hp: 1e9 }]);
      for (let i = 0; i < 10; i++) step(run, 0);
      return view(run).rats.find((r) => r.laneId >= 1e9)!.hp;
    };
    expect(hpAfter(1)).toBe(1e9);
    expect(hpAfter(2)).toBeLessThan(1e9);
  });
  it('effSpread rises with the buff and falls with the debuff for every weapon', () => {
    for (const w of ['pencil', 'laser', 'yarn', 'fishbone'] as const) {
      const base = effSpread(w, defaultMods());
      const up = defaultMods();
      applyStatGate(up, { kind: 'stat', buff: { stat: 'spreadMult', value: 1.3 }, debuff: { stat: 'damageMult', value: 0.9 } });
      const down = defaultMods();
      applyStatGate(down, { kind: 'stat', buff: { stat: 'pierceAdd', value: 1 }, debuff: { stat: 'spreadMult', value: 0.9 } });
      expect(effSpread(w, up)).toBeGreaterThan(base);
      expect(effSpread(w, down)).toBeLessThan(base);
    }
  });
  it('clamps hold', () => {
    const m = defaultMods();
    m.spreadMult = 100;
    clampMods(m);
    expect(m.spreadMult).toBe(config.clamps.spreadMax);
    m.spreadMult = 0;
    clampMods(m);
    expect(m.spreadMult).toBe(config.clamps.spreadMin);
  });
});

describe('spread at gates', () => {
  it('shows up as a buff and as a debuff in generated lanes', () => {
    let buff = 0;
    let debuff = 0;
    for (let i = 0; i < 100; i++) for (let k = 0; k < 160; k++) {
      const g = generateSegment('sp' + i, k).gate;
      if (!g) continue;
      for (const h of [g.left, g.right]) {
        const sg = h.kind === 'weapon' ? h.fallback : h;
        if (sg.buff.stat === 'spreadMult') buff++;
        if (sg.debuff.stat === 'spreadMult') debuff++;
      }
    }
    expect(buff).toBeGreaterThan(100);
    expect(debuff).toBeGreaterThan(100);
  });
});
