// worker_threads entry: one job in, one row out. Runs as .ts under Node's type stripping.
import { parentPort, workerData } from 'node:worker_threads';
import { runOne } from './run.ts';
import type { Job } from './sweep.ts';

const maxTicks = (workerData as { maxTicks?: number } | null)?.maxTicks;
parentPort?.on('message', (j: Job) => {
  parentPort?.postMessage(runOne(j.build, j.seedIndex, maxTicks));
});
