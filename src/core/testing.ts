// Test-only helpers. Importable only from *.test.ts and tools/** (SPEC.md dependency rule 5).
import type { DeepReadonly, InputLevel, Mods, RunState, WeaponId } from './types.ts';
import { config } from './config.ts';
import { isSeed } from './ghost.ts';
import { createState } from './step.ts';
import { bossesBefore, bossMarkK, corridorX, segU } from './lane.ts';
import { defaultMods } from './stats.ts';
import { levelToward } from './cat.ts';
import { type Run, wrapRun, internal } from './run.ts';

export type Scenario = {
  seed: string; distanceM: number; weapon?: WeaponId; mods?: Partial<Mods>; hp?: number; catX?: number; tick?: number;
  rats?: { x: number; y: number; hp: number }[]; tunas?: { x: number; y: number }[]; boss?: { x: number; y: number; hp: number }; nextBossHp?: number; gates?: false;
};

export function runFromScenario(sc: Scenario): Run {
  if (!isSeed(sc.seed)) throw new Error('invalid seed');
  if (sc.distanceM % config.lane.segmentM !== 0) throw new Error('distanceM must be a multiple of segmentM');
  const s = createState(sc.seed);
  s.distanceU = sc.distanceM * 10;
  s.nextSegmentK = sc.distanceM / config.lane.segmentM;
  const bosses = bossesBefore(sc.seed, sc.distanceM);
  s.bossesSpawned = bosses;
  s.bossesKilled = bosses;
  let warned = -1;
  for (let i = 0; bossMarkK(sc.seed, i) * config.lane.segmentM - config.boss.warningM <= sc.distanceM; i++) warned = i;
  s.warnedForBoss = warned;
  let told = -1;
  for (let i = 0; bossMarkK(sc.seed, i) * config.lane.segmentM - config.boss.telegraphM <= sc.distanceM; i++) told = i;
  s.telegraphedBoss = told;
  s.tick = sc.tick ?? 0;
  s.cat.weapon = sc.weapon ?? 'pencil';
  s.cat.mods = { ...defaultMods(), ...sc.mods };
  s.cat.hp = sc.hp ?? config.cat.hp;
  s.cat.x = sc.catX ?? config.world.widthU / 2;
  s.score = Math.floor(sc.distanceM) + 250 * bosses;
  (sc.rats ?? []).forEach((r, i) => {
    s.rats.push({ laneId: 1e9 + i, segmentK: -1, x: r.x, baseY: r.y - s.distanceU, y: r.y, hp: r.hp });
  });
  (sc.tunas ?? []).forEach((t, i) => s.tunas.push({ id: 2e9 + i, x: t.x, baseY: t.y - s.distanceU, y: t.y }));
  if (sc.boss) s.boss = { index: bosses, x: sc.boss.x, y: sc.boss.y, hp: sc.boss.hp, maxHp: sc.boss.hp, missTicks: 0, half: -1 };
  return wrapRun(s, { nextBossHp: sc.nextBossHp ?? null, gates: sc.gates !== false });
}

/** Mutable state, for tests that need to craft a situation. */
export function stateOf(run: Run): RunState {
  return internal(run).state;
}

export function assertFiniteState(run: Run): void {
  const walk = (v: unknown, path: string): void => {
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new Error('non-finite number at ' + path);
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, path + '[' + i + ']'));
    else if (typeof v === 'object' && v !== null) for (const [k, x] of Object.entries(v)) walk(x, path + '.' + k);
  };
  walk(internal(run).state, 'state');
}

/**
 * The T-corridor bot: steers to cx(k) of the band it's about to enter (the first band whose rats
 * the cat hasn't fully passed). Gate halves span the full width, so whatever x it holds picks a half.
 */
export function corridorFollower(v: DeepReadonly<RunState>): InputLevel {
  const catBottom = config.world.catLineY + config.cat.heightU / 2;
  const bandTopAtK0 = config.rat.spawnYU - (config.lane.bandU - config.rat.sizeU) - config.rat.sizeU / 2;
  // band k's top edge = bandTopAtK0 + distanceU − k·segU; it is passed once that is ≥ catBottom
  const k = Math.max(0, Math.floor((v.distanceU + bandTopAtK0 - catBottom) / segU) + 1);
  const target = v.boss !== null ? v.boss.x : corridorX(v.seed, k);
  return levelToward(v.cat, target);
}
