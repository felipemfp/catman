import { describe, expect, inject, it } from 'vitest';
import { config, generateSegment, simulateBossFight, step, view, type Mods, type WeaponId } from '../core/index.ts';
import { runFromScenario } from '../core/testing.ts';
import { sweep } from './sweep.ts';
import { dominates, summarize, toCsv, type BuildSummary } from './report.ts';
import { runOne } from './run.ts';
import { insideRepo, parseArgs } from './cli.ts';
import { chooseSide } from './bots.ts';
import type { StatGate, StatKey } from '../core/index.ts';

const full = inject('full');

describe('T-S1 reproducible, T-S2 paired', () => {
  it('2 threads, 2 threads and 1 thread give byte-identical runs.csv and summary.json', async () => {
    const opts = { builds: ['pencil', 'laser'] as const, runs: 2, maxTicks: 600 };
    const outs = [];
    for (const threads of [2, 2, 1]) {
      const rows = await sweep({ ...opts, threads });
      outs.push([toCsv(rows), JSON.stringify(summarize(rows))]);
    }
    expect(outs[1]).toEqual(outs[0]);
    expect(outs[2]).toEqual(outs[0]);
    const lines = outs[0]![0]!.trim().split('\n').slice(1).map((l) => l.split(','));
    const seeds = (b: string) => lines.filter((l) => l[0] === b).map((l) => l[2]);
    expect(seeds('pencil')).toEqual(seeds('laser'));
    expect(seeds('pencil')).toHaveLength(2);
  });
});

function fake(build: BuildSummary['build'], horde: number | null, boss0: number | null): BuildSummary {
  return {
    build, runs: 1000, distanceM: { median: 500, p10: 400, p90: 600 }, hordeClearRate: { rate: horde, n: 1000 },
    bossKillRate: [{ rate: boss0, n: boss0 === null ? 0 : 900 }], bossKillRateHolding: [], cause: {}, gatePicks: {},
  };
}

describe('T-S6 dominance', () => {
  it('≥ 0.05 on both axes dominates; 0.049 on either does not; missing boss-0 does not; random never', () => {
    expect(dominates(fake('laser', 0.65, 0.75), fake('pencil', 0.6, 0.7))).not.toBeNull();
    expect(dominates(fake('laser', 0.649, 0.75), fake('pencil', 0.6, 0.7))).toBeNull();
    expect(dominates(fake('laser', 0.65, 0.749), fake('pencil', 0.6, 0.7))).toBeNull();
    expect(dominates(fake('laser', 0.65, null), fake('pencil', 0.6, 0.7))).toBeNull();
    expect(dominates(fake('random', 0.9, 0.9), fake('pencil', 0.1, 0.1))).toBeNull();
    expect(dominates(fake('pencil', 0.9, 0.9), fake('random', 0.1, 0.1))).toBeNull();
  });
});

describe('cli', () => {
  it('refuses --out inside the repo; parses flags', () => {
    expect(insideRepo('.')).toBe(true);
    expect(insideRepo('src/out')).toBe(true);
    expect(insideRepo('/tmp/catman-sim/x')).toBe(false);
    const a = parseArgs(['--builds', 'pencil,laser', '--runs', '5', '--threads', '2', '--check']);
    expect(a).toMatchObject({ builds: ['pencil', 'laser'], runs: 5, threads: 2, check: true });
    expect(() => parseArgs(['--builds', 'sword'])).toThrow();
  });
});

const bossK = config.boss.everyM / config.lane.segmentM;

/** A real run into boss 0 with HP set via nextBossHp: does the warning's onPace match the outcome? */
function readoutAgrees(seed: string, weapon: WeaponId, mods: Partial<Mods>, hpFactor: number): { onPace: boolean; died: boolean } {
  const bossX = generateSegment(seed, bossK).bossX!;
  const m = { damageMult: 1, fireRateMult: 1, rangeMult: 1, pierceAdd: 0, projectilesAdd: 0, moveSpeedMult: 1, ...mods };
  const base = simulateBossFight(m, weapon, 1e12, bossX).damageByReach;
  const run = runFromScenario({ seed, distanceM: 450, weapon, mods, hp: 1e9, catX: bossX, nextBossHp: base * hpFactor });
  let onPace: boolean | null = null;
  let died = false;
  for (let t = 0; t < 3000 && view(run).over === null; t++) {
    for (const e of step(run, 0)) {
      if (e.t === 'bossWarning') onPace = e.onPace;
      if (e.t === 'bossKilled') died = true;
    }
    if (died) break;
  }
  if (onPace === null) throw new Error('no bossWarning');
  return { onPace, died };
}

describe('T-S4-gate: readout honesty', () => {
  const weapons: WeaponId[] = ['pencil', 'laser', 'yarn', 'fishbone'];
  it('group 1: 4 weapons × base mods × HP at 0.9× and 1.1× damageByReach', () => {
    for (const w of weapons) for (const f of [0.9, 1.1]) {
      const r = readoutAgrees('honest0', w, {}, f);
      expect({ w, f, ...r }).toEqual({ w, f, onPace: r.died, died: f < 1 });
    }
  });
  it('group 2: shots in flight at spawn (yarn ×1.3 range), HP at 0.95× and 1.05×', () => {
    for (const f of [0.95, 1.05]) {
      const r = readoutAgrees('honest1', 'yarn', { rangeMult: 1.3 }, f);
      expect({ f, ...r }).toEqual({ f, onPace: r.died, died: f < 1 });
    }
  });
});

describe.runIf(full)('periodic', () => {
  it('T-S4: 100% agreement at full size', () => {
    const modSets: Partial<Mods>[] = [{}, { rangeMult: 1.3 }, { rangeMult: 0.64 }, { projectilesAdd: 1 }, { pierceAdd: 1 }, { damageMult: 1.69, rangeMult: 0.64 }];
    const mismatches: string[] = [];
    for (const w of ['pencil', 'laser', 'yarn', 'fishbone'] as WeaponId[]) for (const m of modSets) for (const f of [0.8, 0.9, 0.99, 1.01, 1.1, 1.25]) {
      for (let s = 0; s < 20; s++) {
        const r = readoutAgrees('hon' + s, w, m, f);
        if (r.onPace !== r.died) mismatches.push(`${w} ${JSON.stringify(m)} ${f} hon${s}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
  it('T-S3: the pencil bot reaches boss 0 in ≥ 90% of runs on seeds 0..99', () => {
    let reached = 0;
    for (let i = 0; i < 100; i++) if (runOne('pencil', i).reachedBoss0) reached++;
    expect(reached).toBeGreaterThanOrEqual(90);
  });
});

describe('bot gate choice: pencil prefers range over pierce', () => {
  const g = (stat: StatKey): StatGate => ({ kind: 'stat', buff: { stat, value: 1 }, debuff: { stat: 'damageMult', value: 0.85 } });
  const never = () => { throw new Error('rng used'); };
  it('range beats pierce on either side; pierce still beats an off-axis buff', () => {
    expect(chooseSide('pencil', g('pierceAdd'), g('rangeMult'), 'pencil', never)).toBe('right');
    expect(chooseSide('pencil', g('rangeMult'), g('pierceAdd'), 'pencil', never)).toBe('left');
    expect(chooseSide('pencil', g('damageMult'), g('pierceAdd'), 'pencil', never)).toBe('right');
    expect(chooseSide('pencil', g('damageMult'), g('fireRateMult'), 'pencil', never)).toBe('left');
  });
  it('a weapon gate offered to its holder ranks by its fallback buff', () => {
    const wg = { kind: 'weapon', weapon: 'pencil', fallback: g('rangeMult') } as const;
    expect(chooseSide('pencil', g('pierceAdd'), wg, 'pencil', never)).toBe('right');
  });
  it('other builds keep first-preferred-from-left', () => {
    expect(chooseSide('yarn', g('pierceAdd'), g('projectilesAdd'), 'yarn', never)).toBe('left');
  });
});
