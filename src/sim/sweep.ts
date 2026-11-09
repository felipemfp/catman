// Runs every (build, seed) job across worker threads. Output is sorted, so thread scheduling can't change it.
import { Worker } from 'node:worker_threads';
import { runOne, type RunRow } from './run.ts';
import { sortRows } from './report.ts';
import type { Build } from './bots.ts';

export type Job = { build: Build; seedIndex: number };
export type SweepOpts = { builds: readonly Build[]; runs: number; threads: number; maxTicks?: number; onProgress?: (done: number, total: number) => void };

export function jobsFor(builds: readonly Build[], runs: number): Job[] {
  const jobs: Job[] = [];
  for (const build of builds) for (let i = 0; i < runs; i++) jobs.push({ build, seedIndex: i });
  return jobs;
}

export async function sweep(o: SweepOpts): Promise<RunRow[]> {
  const jobs = jobsFor(o.builds, o.runs);
  const total = jobs.length;
  if (o.threads <= 1) {
    const rows = jobs.map((j, i) => {
      const r = runOne(j.build, j.seedIndex, o.maxTicks);
      o.onProgress?.(i + 1, total);
      return r;
    });
    return sortRows(rows);
  }
  const rows: RunRow[] = [];
  let next = 0;
  const workerUrl = new URL('./worker.ts', import.meta.url);
  const threads = Math.min(o.threads, total);
  await Promise.all(Array.from({ length: threads }, () => new Promise<void>((resolve, reject) => {
    const w = new Worker(workerUrl, { workerData: { maxTicks: o.maxTicks } });
    const feed = () => {
      if (next >= total) { void w.terminate().then(() => resolve()); return; }
      w.postMessage(jobs[next++]);
    };
    w.on('message', (row: RunRow) => {
      rows.push(row);
      o.onProgress?.(rows.length, total);
      feed();
    });
    w.on('error', reject);
    feed();
  })));
  return sortRows(rows);
}
