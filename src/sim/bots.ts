// Scripted bots for the balance sweep (SPEC-balance-sim § Bots).
import {
  catTopY, config, effProjectiles, effRange, generateSegment, levelToward, onDpsAxis, scrollFor,
  type DeepReadonly, type Gate, type InputLevel, type RunState, type StatKey, type WeaponId,
} from '../core/index.ts';

export type Build = 'pencil' | 'laser' | 'yarn' | 'fishbone' | 'random';
export const BUILDS: readonly Build[] = ['pencil', 'laser', 'yarn', 'fishbone', 'random'];
export type Bot = (view: DeepReadonly<RunState>, rng: () => number) => InputLevel;

const W = config.world;
const CAT = config.cat;
const RAT = config.rat.sizeU;
const CANDIDATES = Array.from({ length: 26 }, (_, i) => 20 + 20 * i);
const LOOKAHEAD = 30;

const PREFERRED: Record<Exclude<Build, 'random'>, (s: StatKey) => boolean> = {
  laser: onDpsAxis,
  fishbone: (s) => s === 'projectilesAdd' || s === 'pierceAdd',
  yarn: (s) => s === 'projectilesAdd' || s === 'pierceAdd',
  pencil: (s) => s === 'pierceAdd' || s === 'rangeMult',
};

function halfIsPreferred(build: Exclude<Build, 'random'>, gate: Gate, held: WeaponId): boolean {
  if (gate.kind === 'weapon') {
    if (gate.weapon === build && held !== build) return true;
    if (gate.weapon !== held) return false; // would swap us off our weapon
    return PREFERRED[build](gate.fallback.buff.stat);
  }
  return PREFERRED[build](gate.buff.stat);
}

/** Which half a build takes. Weapon gate for its weapon first, then a preferred-axis buff, else left. */
export function chooseSide(build: Build, left: Gate, right: Gate, held: WeaponId, rng: () => number): 'left' | 'right' {
  if (build === 'random') return rng() < 0.5 ? 'left' : 'right';
  const wantL = left.kind === 'weapon' && left.weapon === build && held !== build;
  const wantR = right.kind === 'weapon' && right.weapon === build && held !== build;
  if (wantL) return 'left';
  if (wantR) return 'right';
  if (halfIsPreferred(build, left, held)) return 'left';
  if (halfIsPreferred(build, right, held)) return 'right';
  return 'left';
}

function firingHalfWidth(v: DeepReadonly<RunState>): number {
  const weapon = v.cat.weapon;
  const n = effProjectiles(weapon, v.cat.mods);
  if (weapon === 'laser') {
    const lw = config.weapons.laser;
    return ((n - 1) / 2) * lw.beamSpacingU + lw.beamWidthU / 2;
  }
  const w = config.weapons[weapon];
  const range = effRange(weapon, v.cat.mods);
  return ((n - 1) / 2) * w.spreadVx * (range / w.speedU) + w.w / 2;
}

function safe(v: DeepReadonly<RunState>, x: number, scroll: number): boolean {
  const catTop = W.catLineY - CAT.heightU / 2;
  const catBottom = W.catLineY + CAT.heightU / 2;
  for (const r of v.rats) {
    if (Math.abs(r.x - x) >= (CAT.widthU + RAT) / 2) continue;
    // the rat sweeps [y, y + LOOKAHEAD·scroll] over the next ticks
    const top = r.y - RAT / 2;
    const bottom = r.y + RAT / 2 + LOOKAHEAD * scroll;
    if (bottom > catTop && top < catBottom) return false;
  }
  return true;
}

/** Creates a fresh bot (it remembers its gate decisions per pair). */
export function createBot(build: Build): Bot {
  const decided = new Map<number, 'left' | 'right'>();
  return (v, rng) => {
    const cat = v.cat;
    // gates on screen and not yet crossed: steer to the chosen half
    for (const g of v.gates) {
      if (g.resolved || g.y > W.catLineY) continue;
      let side = decided.get(g.laneId);
      if (side === undefined) {
        side = chooseSide(build, g.left, g.right, cat.weapon, rng);
        decided.set(g.laneId, side);
      }
      const onSide = side === 'left' ? cat.x < W.widthU / 2 : cat.x >= W.widthU / 2;
      if (!onSide || g.y > W.catLineY - 200) return levelToward(cat, side === 'left' ? W.widthU / 4 : (3 * W.widthU) / 4);
    }
    if (v.boss !== null) return levelToward(cat, v.boss.x);
    const scroll = scrollFor(v);
    const half = firingHalfWidth(v);
    const range = effRange(cat.weapon, cat.mods);
    let best = -1;
    let bestScore = -1;
    for (const x of CANDIDATES) {
      if (!safe(v, x, scroll)) continue;
      let score = 0;
      for (const r of v.rats) {
        if (Math.abs(r.x - x) < half + RAT / 2 && r.y < catTopY && catTopY - r.y <= range) score++;
      }
      if (score > bestScore || (score === bestScore && Math.abs(x - cat.x) < Math.abs(best - cat.x))) {
        best = x;
        bestScore = score;
      }
    }
    if (best < 0) {
      const k = Math.max(0, Math.floor(v.distanceU / (config.lane.segmentM * 10)));
      best = generateSegment(v.seed, k + 1).corridorX;
    }
    return levelToward(cat, best);
  };
}
