// Regenerates src/core/fixtures/*.json. Run only after bumping CORE_VERSION: `npm run fixture:regen`.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CORE_VERSION, createRun, hashState, step, type CoreEvent, type EndCause, type InputLevel } from '../src/core/index.ts';

type Fixture = {
  coreVersion: number; seed: string; levels: InputLevel[]; ticks: number; hash: string;
  ended: { cause: EndCause; score: number; tick: number } | null;
};

export function record(seed: string, levels: readonly InputLevel[]): Fixture {
  const run = createRun(seed);
  let ended: Fixture['ended'] = null;
  let n = 0;
  for (const l of levels) {
    n++;
    const e = step(run, l).find((x): x is Extract<CoreEvent, { t: 'ended' }> => x.t === 'ended');
    if (e) { ended = { cause: e.cause, score: e.score, tick: e.tick }; break; }
  }
  const used = levels.slice(0, n);
  return { coreVersion: CORE_VERSION, seed, levels: used, ticks: used.length, hash: hashState(run), ended };
}

/** Pattern 0: a repeating 240-tick cycle of 60 × +4, 60 × 0, 60 × −4, 60 × 0. */
export function pattern0(n: number): InputLevel[] {
  const cyc: InputLevel[] = [4, 0, -4, 0];
  return Array.from({ length: n }, (_, i) => cyc[Math.floor((i % 240) / 60)]!);
}

function main(): void {
  const dir = fileURLToPath(new URL('../src/core/fixtures/', import.meta.url));
  const replay = record('golden1', pattern0(3600));
  writeFileSync(dir + 'replay.json', JSON.stringify(replay) + '\n');
  const zeros: InputLevel[] = Array.from({ length: 3600 }, () => 0);
  for (let i = 0; i < 1000; i++) {
    const seed = 'die' + String(i).padStart(3, '0');
    const f = record(seed, zeros);
    if (f.ended?.cause === 'rats') {
      writeFileSync(dir + 'dies.json', JSON.stringify(f) + '\n');
      console.log('replay', replay.ticks, replay.hash, replay.ended, '| dies', seed, f.ticks, f.hash, f.ended);
      return;
    }
  }
  throw new Error('no seed in die000..die999 dies to rats within 3,600 idle ticks');
}

main();
