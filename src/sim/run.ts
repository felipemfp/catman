// One seeded bot run → one row. Pure: same (build, seedIndex, maxTicks) → same row.
import { config, createRng, createRun, step, view, type EndCause, type WeaponId } from '../core/index.ts';
import { createBot, type Build } from './bots.ts';

export const BOSS_SLOTS = 5;

export type RunRow = {
  build: Build; seedIndex: number; seed: string; ticks: number; distanceM: number; score: number; cause: EndCause | 'cap';
  bossesKilled: number; reachedBoss0: boolean; killedBoss0: boolean; hordesCleared: number; hordesEscaped: number;
  gatesTaken: number; finalWeapon: WeaponId; ratsSeen: number; ratsKilled: number; tunaHeals: number;
  // not in runs.csv; used for summary.json
  reached: boolean[]; killed: boolean[]; holding: boolean[]; picks: string[];
};

export function seedFor(i: number): string {
  return 'sim' + i.toString(36).padStart(3, '0');
}

export function runOne(build: Build, seedIndex: number, maxTicks: number = config.run.maxTicks): RunRow {
  const seed = seedFor(seedIndex);
  const run = createRun(seed);
  const bot = createBot(build);
  const rng = createRng('bot:' + seed);
  const reached = Array.from({ length: BOSS_SLOTS }, () => false);
  const killed = reached.slice();
  const holding = reached.slice();
  const picks: string[] = [];
  let cleared = 0;
  let escaped = 0;
  let ratsKilled = 0;
  let tunaHeals = 0;
  const seen = new Set<number>();
  let cause: RunRow['cause'] = 'cap';
  for (let t = 0; t < maxTicks; t++) {
    const ev = step(run, bot(view(run), rng));
    // a rat counts once it is on the field, or when its kill event arrives (if it died on its spawn tick)
    for (const r of view(run).rats) seen.add(r.laneId);
    let over = false;
    for (const e of ev) {
      switch (e.t) {
        case 'ratKilled': ratsKilled++; seen.add(e.laneId); break;
        case 'tunaEaten': if (e.healed) tunaHeals++; break;
        case 'hordeCleared': cleared++; break;
        case 'hordeEscaped': escaped++; break;
        case 'bossSpawned':
          if (e.index < BOSS_SLOTS) { reached[e.index] = true; holding[e.index] = view(run).cat.weapon === build; }
          break;
        case 'bossKilled': if (e.index < BOSS_SLOTS) killed[e.index] = true; break;
        case 'gateTaken':
          picks.push(typeof e.applied === 'string' ? 'weapon:' + e.applied : `${e.applied.buff.stat}/${e.applied.debuff.stat}`);
          break;
        case 'ended': cause = e.cause; over = true; break;
        default: break;
      }
    }
    if (over) break;
  }
  const v = view(run);
  return {
    build, seedIndex, seed, ticks: v.tick, distanceM: Math.floor(v.distanceU / 10), score: v.score, cause,
    bossesKilled: v.bossesKilled, reachedBoss0: reached[0]!, killedBoss0: killed[0]!, hordesCleared: cleared, hordesEscaped: escaped,
    gatesTaken: picks.length, finalWeapon: v.cat.weapon, ratsSeen: seen.size, ratsKilled, tunaHeals, reached, killed, holding, picks,
  };
}
