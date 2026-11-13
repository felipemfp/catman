import { describe, expect, inject, it } from 'vitest';
import { bossMarkK, config, createRun, generateSegment, simulateBossFight, step, view, type Mods, type WeaponId } from '../core/index.ts';
import { runFromScenario } from '../core/testing.ts';
import { sweep } from './sweep.ts';
import { check, dominates, summarize, toCsv, type BuildSummary } from './report.ts';
import { runOne, seedFor } from './run.ts';
import { insideRepo, parseArgs } from './cli.ts';
import { chooseSide, createBot } from './bots.ts';
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
    build, runs: 1000, distanceM: { median: 500, p10: 400, p90: 600 }, hordeClearRate: { rate: horde, n: 1000 }, ratKillRate: { rate: 0.7, n: 5000 },
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


/** A real run into boss 0 with HP set via nextBossHp: does the warning's onPace match the outcome? */
function readoutAgrees(seed: string, weapon: WeaponId, mods: Partial<Mods>, hpFactor: number): { onPace: boolean; died: boolean } {
  const bossK = bossMarkK(seed, 0);
  const bossX = generateSegment(seed, bossK).bossX!;
  const m = { damageMult: 1, fireRateMult: 1, rangeMult: 1, pierceAdd: 0, projectilesAdd: 0, moveSpeedMult: 1, spreadMult: 1, ...mods };
  const base = simulateBossFight(m, weapon, 1e12, bossX).damageByReach;
  const run = runFromScenario({ seed, distanceM: bossK * config.lane.segmentM - 50, weapon, mods, hp: 1e9, catX: bossX, nextBossHp: base * hpFactor });
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

describe('check: casual targets', () => {
  const mk = (over: Partial<BuildSummary>): BuildSummary => ({
    ...fake('pencil', 0.7, 0.9), distanceM: { median: 2000, p10: 1000, p90: 3000 },
    bossKillRate: [{ rate: 0.9, n: 900 }, { rate: 0.6, n: 500 }], bossKillRateHolding: [{ rate: 0.8, n: 100 }], ...over,
  });
  type Fights = Parameters<typeof check>[0]['fights'];
  const v = (name: Fights['variants'][number]['name'], win: number, share: number) =>
    ({ name, reached: 100, won: win * 100, winRate: { rate: win, n: 100 }, deaths: share * 100, deathShare: { rate: share, n: 100 } });
  const okFights = (over: Partial<Record<'share' | 'horde' | 'hordeWin', number>> = {}): Fights => ({
    deaths: 100, fightDeaths: 40, bossDeathShare: { rate: over.share ?? 0.4, n: 100 },
    variants: [v('plain', 0.9, 0.3), v('horde', over.hordeWin ?? 0.8, over.horde ?? 0.2), v('frenzy', 0.8, 0.2), v('twins', 0.8, 0.3)],
  });
  const lines = (b: BuildSummary, fights: Fights = okFights()) => check({ builds: [b], fights }, 1).filter((l) => !l.target.includes('elapsed'));
  it('a build meeting every target passes every line', () => {
    expect(lines(mk({})).filter((l) => !l.pass)).toEqual([]);
  });
  it('each target fails on its own', () => {
    const failing = (b: BuildSummary) => lines(b).filter((l) => !l.pass).map((l) => l.target.split(' ')[1]);
    expect(failing(mk({ ratKillRate: { rate: 0.59, n: 5000 } }))).toEqual(['ratKillRate']);
    expect(failing(mk({ bossKillRate: [{ rate: 0.9, n: 900 }, { rate: 0.49, n: 500 }] }))).toEqual(['bossKillRate[1]']);
    expect(failing(mk({ bossKillRateHolding: [{ rate: 0.74, n: 100 }] }))).toEqual(['bossKillRateHolding[0]']);
    expect(failing(mk({ distanceM: { median: 1499, p10: 1000, p90: 3000 } }))).toEqual(['median']);
    expect(failing(mk({ bossKillRate: [{ rate: 0.99, n: 900 }, { rate: 0.6, n: 500 }] }))).toEqual(['bossKillRate[0]']);
  });
  it('boss-fight lines fail on their own (CORE_VERSION 10)', () => {
    const failing = (f: Fights) => lines(mk({}), f).filter((l) => !l.pass).map((l) => l.target);
    expect(failing(okFights({ share: 0.34 }))).toEqual([expect.stringMatching(/^boss fights cause/)]);
    expect(failing(okFights({ horde: 0.14 }))).toEqual([expect.stringMatching(/^horde fights cause/)]);
    expect(failing(okFights({ hordeWin: 0.49 }))).toEqual([expect.stringMatching(/^horde fights won/)]);
  });
  it('the holding line is skipped below holdingMinN', () => {
    expect(lines(mk({ bossKillRateHolding: [{ rate: 0, n: 29 }] })).some((l) => l.target.includes('Holding'))).toBe(false);
  });
});

describe('bot gate choice: pencil prefers damage / fire rate (CORE_VERSION 12, Felipe: DPS-first + nerf pencil)', () => {
  // range-first held the pencil bot to 0.69x the other medians; bosses come to the cat now, so range buys nothing in a fight
  const g = (stat: StatKey): StatGate => ({ kind: 'stat', buff: { stat, value: 1 }, debuff: { stat: 'rangeMult', value: 0.85 } });
  const never = () => { throw new Error('rng used'); };
  it('a DPS-axis buff beats range and pierce on either side; two equal ranks fall to the left', () => {
    expect(chooseSide('pencil', g('rangeMult'), g('damageMult'), 'pencil', never)).toBe('right');
    expect(chooseSide('pencil', g('fireRateMult'), g('pierceAdd'), 'pencil', never)).toBe('left');
    expect(chooseSide('pencil', g('pierceAdd'), g('rangeMult'), 'pencil', never)).toBe('left');
    expect(chooseSide('pencil', g('damageMult'), g('fireRateMult'), 'pencil', never)).toBe('left');
  });
  it('a weapon gate offered to its holder ranks by its fallback buff', () => {
    const wg = { kind: 'weapon', weapon: 'pencil', fallback: g('damageMult') } as const;
    expect(chooseSide('pencil', g('rangeMult'), wg, 'pencil', never)).toBe('right');
  });
  it('other builds keep first-preferred-from-left', () => {
    expect(chooseSide('yarn', g('pierceAdd'), g('projectilesAdd'), 'yarn', never)).toBe('left');
  });
});

describe('rat counters', () => {
  it('every killed rat was counted as seen, and a short pencil run kills some', () => {
    for (let i = 0; i < 3; i++) {
      const r = runOne('pencil', i, 3000);
      expect(r.ratsKilled).toBeGreaterThan(0);
      expect(r.ratsSeen).toBeGreaterThanOrEqual(r.ratsKilled);
    }
  });
});

describe('bots and tuna', () => {
  const go = (hp: number) => {
    const run = runFromScenario({ seed: 'bott0', distanceM: 1000, hp, gates: false, catX: 100, tunas: [{ x: 420, y: 600 }] });
    const bot = createBot('pencil');
    const rng = () => 0;
    let ate = false;
    for (let i = 0; i < 200 && !ate; i++) ate = step(run, bot(view(run), rng)).some((e) => e.t === 'tunaEaten');
    return ate;
  };
  it('a hurt bot goes and eats an approaching tuna', () => expect(go(1)).toBe(true));
  it('a bot at full hp leaves it', () => expect(go(config.cat.hp)).toBe(false));
});

describe('standing still loses (CORE_VERSION 8: homing + charging rats)', () => {
  // A cat that never moves vs the pencil bot, same 100 seeds. Floors are the levels reached in the v8 pass
  // (SPEC-balance-sim § Charging rats): a regression guard, not the original 1000 m / 2000 m / 2.5× goal.
  it.runIf(full)('still cat: median ≤ 1300 m, p90 ≤ 2500 m; moving bot median ≥ 2× the still median', () => {
    const still: number[] = [];
    const moving: number[] = [];
    for (let i = 0; i < 100; i++) {
      const run = createRun(seedFor(i));
      for (let t = 0; t < config.run.maxTicks && view(run).over === null; t++) step(run, 0);
      still.push(Math.floor(view(run).distanceU / 10));
      moving.push(runOne('pencil', i).distanceM);
    }
    const q = (a: number[], p: number) => a.slice().sort((x, y) => x - y)[Math.floor(p * a.length)]!;
    expect(q(still, 0.5)).toBeLessThanOrEqual(1300);
    expect(q(still, 0.9)).toBeLessThanOrEqual(2500);
    expect(q(moving, 0.5)).toBeGreaterThanOrEqual(2 * q(still, 0.5));
  });
});
