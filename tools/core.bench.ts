// `npm run bench`: times only busy ticks (SPEC-game-core § The bench).
import { cpus } from 'node:os';
import { bench, describe } from 'vitest';
import { step, view, type CoreEvent, type Mods, type WeaponId } from '../src/core/index.ts';
import { corridorFollower, runFromScenario } from '../src/core/testing.ts';

const SEEDS = Array.from({ length: 12 }, (_, i) => 'bench' + String(i).padStart(2, '0'));
const WARMUP = 140;
const TIMED = 260;
const FLOOR = 50000;

type Scn = { name: string; weapon: WeaponId; mods: Partial<Mods> };
const SCENARIOS: Scn[] = [
  { name: 'projectiles', weapon: 'pencil', mods: { projectilesAdd: 6, fireRateMult: 5 } },
  { name: 'beams', weapon: 'laser', mods: { projectilesAdd: 2 } },
];

function warmRuns(s: Scn) {
  return SEEDS.map((seed) => {
    const run = runFromScenario({ seed, distanceM: 1525, hp: 1e9, weapon: s.weapon, mods: s.mods, gates: false });
    for (let i = 0; i < WARMUP; i++) step(run, corridorFollower(view(run)));
    return { seed, run };
  });
}

const BAD: CoreEvent['t'][] = ['gateTaken', 'weaponChanged'];

/** One timed pass over all seeds. Returns ns spent in step() and load stats; drops seeds that break the busy-tick rule. */
function timedPass(s: Scn) {
  const runs = warmRuns(s);
  let ns = 0n;
  let ticks = 0;
  let rats = 0;
  let projs = 0;
  let beamTouch = 0;
  const dropped: string[] = [];
  for (const { seed, run } of runs) {
    let localNs = 0n;
    let ok = true;
    let r = 0, p = 0, bt = 0;
    for (let i = 0; i < TIMED; i++) {
      const v = view(run);
      if (v.freezeTicks !== 0 || v.boss !== null || v.over !== null) { ok = false; break; }
      const lvl = corridorFollower(v);
      r += v.rats.length;
      p += v.projectiles.length;
      const t0 = process.hrtime.bigint();
      const ev = step(run, lvl);
      localNs += process.hrtime.bigint() - t0;
      if (ev.some((e) => BAD.includes(e.t))) { ok = false; break; }
      if (s.weapon === 'laser' && ev.some((e) => e.t === 'damage' || e.t === 'ratKilled')) bt++;
    }
    if (!ok) { dropped.push(seed); continue; }
    ns += localNs;
    ticks += TIMED;
    rats += r;
    projs += p;
    beamTouch += bt;
  }
  return { ns, ticks, rats, projs, beamTouch, dropped };
}

const results: string[] = [];

describe('core', () => {
  for (const s of SCENARIOS) {
    bench(s.name, () => {
      const r = timedPass(s);
      if (r.dropped.length > 2) throw new Error(`${s.name}: ${r.dropped.length} of 12 seeds dropped (${r.dropped.join(', ')})`);
      const tps = r.ticks / (Number(r.ns) / 1e9);
      const line = `${s.name}: ${Math.round(tps).toLocaleString('en-US')} ticks/s over ${r.ticks} timed ticks; ` +
        `mean rats ${(r.rats / r.ticks).toFixed(1)}, projectiles ${(r.projs / r.ticks).toFixed(1)}` +
        (s.weapon === 'laser' ? `, beam-on-rat share ${(r.beamTouch / r.ticks).toFixed(2)} (damage-event ticks only, so a lower bound)` : '') +
        (r.dropped.length ? `; dropped ${r.dropped.join(', ')}` : '');
      if (results.length < 2 * SCENARIOS.length) results.push(line);
      if (tps < FLOOR) throw new Error(`${line} — below the ${FLOOR} ticks/s floor`);
    }, { iterations: 5, time: 0, warmupIterations: 1, teardown: () => {
      if (results.length) console.log(`[bench] ${cpus()[0]?.model ?? 'unknown CPU'}\n[bench] ` + results.splice(0).join('\n[bench] '));
    } });
  }
});
