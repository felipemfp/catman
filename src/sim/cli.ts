// node src/sim/cli.ts --builds all|pencil,laser,... --runs 1000 [--out DIR] [--check] [--threads N]
import { mkdirSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus } from 'node:os';
import { relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILDS, type Build } from './bots.ts';
import { sweep } from './sweep.ts';
import { check, dominance, summarize, toCsv } from './report.ts';

export type CliArgs = { builds: Build[]; runs: number; out: string; check: boolean; threads: number };

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));

export function insideRepo(dir: string): boolean {
  const rel = relative(REPO, resolve(dir));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = { builds: [...BUILDS], runs: 1000, out: '', check: false, threads: availableParallelism() };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => { const x = argv[++i]; if (x === undefined) throw new Error(`${k} needs a value`); return x; };
    if (k === '--builds') {
      const s = v();
      a.builds = s === 'all' ? [...BUILDS] : s.split(',').map((b) => {
        if (!(BUILDS as readonly string[]).includes(b)) throw new Error(`unknown build ${b}`);
        return b as Build;
      });
    } else if (k === '--runs') a.runs = Number.parseInt(v(), 10);
    else if (k === '--out') a.out = v();
    else if (k === '--threads') a.threads = Number.parseInt(v(), 10);
    else if (k === '--check') a.check = true;
    else throw new Error(`unknown flag ${k}`);
  }
  if (!(a.runs > 0)) throw new Error('--runs must be > 0');
  if (!a.out) a.out = `/tmp/catman-sim/${new Date().toISOString().replace(/[:.]/g, '-')}/`;
  return a;
}

async function main(): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    return 2;
  }
  if (insideRepo(args.out)) {
    console.error(`--out ${args.out} is inside the repo; sim output never goes in the repo`);
    return 2;
  }
  const t0 = Date.now();
  let last = 0;
  const rows = await sweep({
    builds: args.builds, runs: args.runs, threads: args.threads,
    onProgress: (done, total) => {
      const now = Date.now();
      if (now - last < 5000 && done !== total) return;
      last = now;
      const s = (now - t0) / 1000;
      const rate = done / s;
      console.log(`${done}/${total} runs · ${rate.toFixed(1)} runs/s · ETA ${((total - done) / rate).toFixed(0)} s`);
    },
  });
  const elapsed = (Date.now() - t0) / 1000;
  const summary = summarize(rows);
  mkdirSync(args.out, { recursive: true });
  writeFileSync(args.out + '/runs.csv', toCsv(rows));
  writeFileSync(args.out + '/summary.json', JSON.stringify(summary, null, 2) + '\n');
  writeFileSync(args.out + '/dominance.json', JSON.stringify(dominance(summary), null, 2) + '\n');
  console.log(`elapsed ${elapsed.toFixed(1)} s on ${cpus()[0]?.model ?? 'unknown CPU'} (${args.threads} threads) → ${args.out}`);
  if (!args.check) return 0;
  const lines = check(summary, elapsed);
  const txt = lines.map((l) => `${l.pass ? 'PASS' : 'FAIL'}  ${l.target}: ${l.value}`).join('\n') + '\n';
  writeFileSync(args.out + '/check.txt', txt);
  process.stdout.write(txt);
  return lines.every((l) => l.pass) ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (e: unknown) => { console.error(e); process.exit(2); });
}
