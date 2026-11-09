// Pre-simulates a ghost before it is shown (C9). Pure: imports only core, no Phaser or DOM.
import { createRun, step, view, type GhostPayload, type InputLevel } from '../core/index.ts';

export type GhostTrack = { xs: Float32Array; scores: number[]; finalScore: number; ticks: number };
export type Verdict = 'ok' | "doesn't match";

export function createGhostCheck(payload: GhostPayload, levels: readonly InputLevel[]) {
  const run = createRun(payload.seed);
  const xs = new Float32Array(levels.length);
  const scores: number[] = [0];
  let i = 0;
  let verdict: Verdict | null = null;
  return {
    advance(maxTicks: number): { done: boolean; verdict?: Verdict } {
      if (verdict) return { done: true, verdict };
      const end = Math.min(levels.length, i + maxTicks);
      for (; i < end; i++) {
        const ev = step(run, levels[i]!);
        const v = view(run);
        xs[i] = v.cat.x;
        if ((i + 1) % 60 === 0) scores.push(v.score);
        const e = ev.find((x) => x.t === 'ended');
        if (e && e.t === 'ended') {
          verdict = e.tick === payload.ticks && i + 1 === levels.length && e.score === payload.score ? 'ok' : "doesn't match";
          i++;
          return { done: true, verdict };
        }
      }
      if (i >= levels.length) {
        verdict = "doesn't match"; // the log ran out without the run ending
        return { done: true, verdict };
      }
      return { done: false };
    },
    track(): GhostTrack {
      return { xs, scores, finalScore: payload.score, ticks: payload.ticks };
    },
  };
}

/** Ghost score at a tick, from the 60-tick samples (final score after its last tick). */
export function ghostScoreAt(t: GhostTrack, tick: number): number {
  if (tick >= t.ticks) return t.finalScore;
  return t.scores[Math.min(t.scores.length - 1, Math.floor(tick / 60))] ?? 0;
}
