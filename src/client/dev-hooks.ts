// Test hooks: dev and e2e builds only (C6). Loaded by a dynamic import that Vite drops from production.
import { createRun, hashState, setFrozenViews, step, view, type EndCause, type InputLevel } from '../core/index.ts';
import type { GameScene, UiState } from './scene.ts';

export type CatmanHooks = {
  seed: string;
  tick(): number;
  hash(): string;
  catX(): number;
  ghostStatus(): string;
  view(): string;
  poolStats(): Record<string, { live: number; allocated: number }>;
  ui(): UiState;
  playLog(levels: number[]): Promise<{ hash: string; ended: { cause: EndCause; score: number; tick: number } | null }>;
  coreReplay(seed: string, levels: number[]): string;
};

declare global {
  interface Window { __catman: CatmanHooks }
}

export function installHooks(scene: GameScene): void {
  setFrozenViews(true);
  window.__catman = {
    get seed() { return scene.seed; },
    tick: () => (scene.run ? view(scene.run).tick : 0),
    hash: () => (scene.run ? hashState(scene.run) : ''),
    catX: () => (scene.run ? view(scene.run).cat.x : 270),
    ghostStatus: () => scene.ghostStatus,
    view: () => scene.cam.view,
    poolStats: () => scene.poolStats(),
    ui: () => scene.ui(),
    playLog: (levels) => scene.startScripted(levels as InputLevel[]),
    coreReplay: (seed, levels) => {
      const run = createRun(seed);
      for (const l of levels) if (step(run, l as InputLevel).some((e) => e.t === 'ended')) break;
      return hashState(run);
    },
  };
}
