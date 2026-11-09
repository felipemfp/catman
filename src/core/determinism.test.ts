import { describe, expect, inject, it } from 'vitest';
import type { CoreEvent, InputLevel } from './types.ts';
import { createRun, generateSegment, hashState, step, view, createRecorder, decodeInputLog, config } from './index.ts';
import { runFromScenario } from './testing.ts';
import { pattern } from './test-util.test-helpers.ts';

const full = inject('full');

function play(seed: string, levels: readonly InputLevel[]) {
  const run = createRun(seed);
  const hashes: string[] = [];
  const events: CoreEvent[][] = [];
  let ended: Extract<CoreEvent, { t: 'ended' }> | null = null;
  for (let i = 0; i < levels.length; i++) {
    const ev = step(run, levels[i]!);
    events.push(ev);
    if ((i + 1) % 600 === 0) hashes.push(hashState(run));
    const e = ev.find((x) => x.t === 'ended');
    if (e && e.t === 'ended') { ended = e; hashes.push(hashState(run)); break; }
  }
  return { hashes, events, ended, run };
}

describe('T-replay (F1, F13)', () => {
  const seeds = full ? Array.from({ length: 50 }, (_, i) => 'rep' + i) : ['rep0', 'rep1', 'rep2', 'rep3'];
  const n = full ? config.run.maxTicks : 1200;
  for (const [i, seed] of seeds.entries()) {
    const p = (i % 4) as 0 | 1 | 2 | 3;
    it(`${seed} pattern ${p}: record → encode → decode → re-simulate`, () => {
      const levels = pattern(p, seed, n);
      const a = play(seed, levels);
      const rec = createRecorder();
      const played = a.ended ? levels.slice(0, a.ended.tick) : levels;
      for (const l of played) rec.push(l);
      expect(rec.ticks()).toBe(played.length);
      const decoded = decodeInputLog(rec.bytes());
      expect(decoded).toEqual(played);
      const b = play(seed, decoded);
      expect(b.hashes).toEqual(a.hashes);
      expect(b.ended).toEqual(a.ended);
      if (a.ended) expect(a.ended.tick).toBe(played.length);
    });
  }
});

describe('T-repeat (F1)', () => {
  const seeds = full ? Array.from({ length: 20 }, (_, i) => 'rpt' + i) : ['rpt0'];
  for (const seed of seeds) {
    it(`${seed}: same seed and log twice → identical event streams`, () => {
      const levels = pattern(3, seed, full ? config.run.maxTicks : 1200);
      expect(play(seed, levels).events).toEqual(play(seed, levels).events);
    });
  }
});

describe('T-lane (F2): the lane is independent of how long a boss took', () => {
  const seeds = full ? Array.from({ length: 200 }, (_, i) => 'lane' + i) : ['lane0', 'lane1'];
  const endM = full ? 2700 : 700;
  for (const seed of seeds) {
    it(seed, () => {
      const bossX = generateSegment(seed, config.boss.everyM / config.lane.segmentM).bossX!;
      const mk = (damageMult: number) =>
        runFromScenario({ seed, distanceM: 450, weapon: 'laser', mods: { damageMult }, hp: 1e9, catX: bossX });
      const fast = mk(20);
      const slow = mk(1);
      type Snap = { dist: number; ents: Map<number, string>; seen: Set<number> };
      const trace = (run: ReturnType<typeof mk>) => {
        const dists: number[] = [];
        const snaps: Snap[] = [];
        const seen = new Set<number>();
        let nextCp = 460;
        let killTick = -1;
        let spawnTick = -1;
        for (let t = 0; t < 200000; t++) {
          const ev = step(run, 0);
          if (ev.some((e) => e.t === 'bossSpawned') && spawnTick < 0) spawnTick = view(run).tick;
          if (ev.some((e) => e.t === 'bossKilled') && killTick < 0) killTick = view(run).tick - spawnTick;
          const v = view(run);
          if (dists[dists.length - 1] !== v.distanceU) dists.push(v.distanceU);
          for (const r of v.rats) seen.add(r.laneId);
          for (const g of v.gates) seen.add(g.laneId);
          if (v.distanceU / 10 >= nextCp) {
            const ents = new Map<number, string>();
            for (const r of v.rats) ents.set(r.laneId, `${r.x}:${r.y}`);
            for (const g of v.gates) ents.set(g.laneId, `${g.y}`);
            snaps.push({ dist: v.distanceU, ents, seen: new Set(seen) });
            nextCp += 10;
          }
          if (v.over !== null || v.distanceU / 10 >= endM) break;
        }
        return { dists, snaps, killTick };
      };
      const a = trace(fast);
      const b = trace(slow);
      expect(b.killTick).toBeGreaterThan(3 * a.killTick);
      const m = Math.min(a.dists.length, b.dists.length);
      expect(a.dists.slice(0, m)).toEqual(b.dists.slice(0, m));
      const cps = Math.min(a.snaps.length, b.snaps.length);
      expect(cps).toBeGreaterThan(10);
      for (let i = 0; i < cps; i++) {
        const sa = a.snaps[i]!;
        const sb = b.snaps[i]!;
        expect(sa.dist).toBe(sb.dist);
        for (const [id, pos] of sa.ents) if (sb.ents.has(id)) expect(pos).toBe(sb.ents.get(id));
        expect([...sa.seen].sort()).toEqual([...sb.seen].sort());
      }
    });
  }
});
