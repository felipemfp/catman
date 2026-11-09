// Lane generation: a pure function of (seed, k, config). Each segment has its own RNG, so the
// lane is identical whatever the player does (F2).
import type { Gate, GatePair, SegmentContent, StatGate, StatKey } from './types.ts';
import { STAT_KEYS, WEAPON_IDS } from './types.ts';
import { config } from './config.ts';
import { createRng, randInt, randReal } from './rng.ts';
import { allowedDebuffs, isAdditive, tierFor } from './stats.ts';
import { overlaps } from './math.ts';

const L = config.lane;
export const segU = L.segmentM * 10;
export const corridorHalfU = config.cat.widthU / 2 + L.corridorMarginU;
const anchorMargin = corridorHalfU + L.corridorEdgeMarginU;

function anchor(seed: string, j: number): number {
  const rng = createRng(seed + ':anchor:' + j);
  return randReal(rng, anchorMargin, config.world.widthU - anchorMargin);
}

/** Corridor centre of segment k: linear between two anchors, so no chain state. */
export function corridorX(seed: string, k: number): number {
  const P = L.anchorEverySegments;
  const j = Math.floor(k / P);
  const a = anchor(seed, j);
  const b = anchor(seed, j + 1);
  return a + ((b - a) * (k % P)) / P;
}

export const BOSS_HORDE = 1;
export const BOSS_FRENZY = 2;
export const BOSS_TWINS = 4;
const VARIANT_BITS = [BOSS_HORDE, BOSS_FRENZY, BOSS_TWINS] as const;

/** Boss marks (segment indexes) per seed, grown on demand. Pure: a cache of a function of (seed, i). */
const marks = new Map<string, number[]>();

/** Segment index of boss i's mark (SPEC-game-core § Boss schedule). */
export function bossMarkK(seed: string, i: number): number {
  let a = marks.get(seed);
  if (a === undefined) {
    if (marks.size >= 256) marks.clear();
    a = [];
    marks.set(seed, a);
  }
  const S = config.boss.schedule;
  const seg = L.segmentM;
  while (a.length <= i) {
    const j = a.length;
    const rng = createRng(seed + ':boss:' + j);
    if (j === 0) {
      const lo = S.firstM[0] / seg;
      a.push(lo + randInt(rng, S.firstM[1] / seg - lo + 1));
    } else {
      const prev = a[j - 1]!;
      const t = Math.min(1, (prev * seg) / S.farM);
      const lo = Math.round((S.gapNearM[0] + (S.gapFarM[0] - S.gapNearM[0]) * t) / seg);
      const hi = Math.round((S.gapNearM[1] + (S.gapFarM[1] - S.gapNearM[1]) * t) / seg);
      a.push(prev + lo + randInt(rng, hi - lo + 1));
    }
  }
  return a[i]!;
}

/** Index of the first boss whose mark is at or after segment k. */
export function nextBossIndex(seed: string, k: number): number {
  let i = 0;
  while (bossMarkK(seed, i) < k) i++;
  return i;
}

/** Number of boss marks at or before distance dM. */
export function bossesBefore(seed: string, dM: number): number {
  let i = 0;
  while (bossMarkK(seed, i) * L.segmentM <= dM) i++;
  return i;
}

export function isBossSegment(seed: string, k: number): boolean {
  return k > 0 && bossMarkK(seed, nextBossIndex(seed, k)) === k;
}

/** Boss index of a boss segment. */
export function bossIndexOfSegment(seed: string, k: number): number {
  return nextBossIndex(seed, k);
}

export function inClearZone(seed: string, k: number): boolean {
  // the next mark B at or after k; the zone is [B - clearM, B]
  const B = bossMarkK(seed, nextBossIndex(seed, k));
  return k >= B - config.boss.clearM / L.segmentM;
}

/** Variant flags of boss i: 0 for boss 0, then a seeded roll whose chance ramps (SPEC-game-core § Boss variants). */
export function bossVariant(seed: string, i: number): number {
  if (i <= 0) return 0;
  const V = config.boss.variants;
  const rng = createRng(seed + ':bossv:' + i);
  if (rng() >= Math.min(V.chanceMax, V.chanceStart + V.chanceStep * (i - 1))) return 0;
  const a = randInt(rng, VARIANT_BITS.length);
  let f: number = VARIANT_BITS[a]!;
  if (i >= V.comboFrom && rng() < V.comboChance) f |= VARIANT_BITS[(a + 1 + randInt(rng, VARIANT_BITS.length - 1)) % VARIANT_BITS.length]!;
  return f;
}

function isWarmup(k: number): boolean {
  return k * L.segmentM < L.warmupM;
}

function isGateMark(k: number): boolean {
  const dM = k * L.segmentM;
  return dM > 0 && dM % config.gates.everyM === 0;
}

/** True when segment k actually spawns a gate pair. */
export function spawnsGate(seed: string, k: number): boolean {
  return k >= 0 && !isWarmup(k) && isGateMark(k) && !isBossSegment(seed, k) && !inClearZone(seed, k);
}

export function ratHpAt(dM: number): number {
  return config.rat.baseHp * (1 + config.rat.hpRampPerM * dM);
}

/** A stat gate whose buff is any stat but `avoid` (the other half's buff, so a pair never offers the same thing twice). */
function drawStatGate(rng: () => number, tier: { buffMult: number; buffAdd: number; debuffMult: number }, avoid: StatKey | null = null): StatGate {
  const pool = avoid === null ? STAT_KEYS : STAT_KEYS.filter((s) => s !== avoid);
  const buffStat: StatKey = pool[randInt(rng, pool.length)]!;
  const allowed = allowedDebuffs(buffStat);
  const debuffStat: StatKey = allowed[randInt(rng, allowed.length)]!;
  return {
    kind: 'stat',
    buff: { stat: buffStat, value: isAdditive(buffStat) ? tier.buffAdd : tier.buffMult },
    debuff: { stat: debuffStat, value: tier.debuffMult },
  };
}

function drawGatePair(rng: () => number, k: number): GatePair {
  const tier = tierFor(k * L.segmentM);
  let left: Gate | null = null;
  let right: Gate | null = null;
  if (rng() < config.gates.weaponChance) {
    const side = randInt(rng, 2);
    const weapon = WEAPON_IDS[randInt(rng, WEAPON_IDS.length)]!;
    const fallback = drawStatGate(rng, tier);
    const wg: Gate = { kind: 'weapon', weapon, fallback };
    if (side === 0) left = wg;
    else right = wg;
  }
  const buffOf = (g: Gate) => (g.kind === 'weapon' ? g.fallback.buff.stat : g.buff.stat);
  if (left === null) left = drawStatGate(rng, tier, right === null ? null : buffOf(right));
  if (right === null) right = drawStatGate(rng, tier, buffOf(left));
  const baseY = config.gates.spawnYU - config.gates.dyU - k * segU;
  return { laneId: k * 64, baseY, y: baseY + k * segU, left, right, resolved: false };
}

/** Unit hexagon, as literals: Math.cos/sin are not bit-identical across engines. */
const HEX: readonly (readonly [number, number])[] = [
  [1, 0], [0.5, 0.8660254037844386], [-0.5, 0.8660254037844386], [-1, 0], [-0.5, -0.8660254037844386], [0.5, -0.8660254037844386],
];
if (config.tuna.guards !== HEX.length) throw new Error('config.tuna.guards must match the hexagon ring');

function isTunaMark(k: number): boolean {
  const dM = k * L.segmentM;
  return dM > 0 && dM % config.tuna.everyM === 0;
}

/** Tuna at the band's middle, ring of guards around it; the whole ring stays off the corridor and on screen. */
function placeTuna(seed: string, k: number, cx: number, out: SegmentContent): boolean {
  const T = config.tuna;
  const rng = createRng(seed + ':tuna:' + k);
  if (rng() >= T.chance) return false;
  const size = config.rat.sizeU;
  const R = T.guardRadiusU;
  const minX = R + size / 2;
  const maxX = config.world.widthU - R - size / 2;
  const clear = corridorHalfU + size / 2 + R;
  for (let t = 0; t < T.xTries; t++) {
    const x = randReal(rng, minX, maxX);
    if (Math.abs(x - cx) < clear) continue;
    const dy = (L.bandU - size) / 2;
    const hp = ratHpAt(k * L.segmentM);
    out.kind = 'tuna';
    out.tuna = { x, dy };
    out.rats = HEX.map(([ux, uy], i) => ({ laneId: k * 64 + i + 1, x: x + R * ux, dy: dy + R * uy, hp }));
    return true;
  }
  return false;
}

/** How good a gate half is, for sizing its guard (SPEC-game-core § Gate guards). */
export function gateValue(g: Gate): number {
  const G = config.gates.guard;
  return g.kind === 'weapon' ? G.weaponValue[g.weapon] : G.statValue;
}

/** Guard horde for the gate pair two segments ahead: rows across its better half, skipping the corridor. */
function placeGuard(seed: string, k: number, cx: number, out: SegmentContent): boolean {
  if (!spawnsGate(seed, k + 2)) return false;
  const pair = generateSegment(seed, k + 2).gate!;
  const diff = gateValue(pair.left) - gateValue(pair.right);
  if (diff === 0) return false;
  const G = config.gates.guard;
  const size = config.rat.sizeU;
  const half = config.world.widthU / 2;
  const x0 = diff > 0 ? 0 : half;
  const n = Math.min(G.cap, G.ratsPerValue * Math.abs(diff));
  const hp = ratHpAt(k * L.segmentM);
  const rats: SegmentContent['rats'] = [];
  for (let row = 0; row < G.rows && rats.length < n; row++) {
    const dy = 20 + row * G.rowSpacingU;
    for (let x = x0 + size / 2 + 3; x + size / 2 <= x0 + half && rats.length < n; x += G.slotSpacingU) {
      if (inCorridor(x, cx)) continue;
      rats.push({ laneId: k * 64 + rats.length + 1, x, dy, hp });
    }
  }
  if (rats.length === 0) return false;
  out.kind = 'guard';
  out.rats = rats;
  return true;
}

function inCorridor(x: number, cx: number): boolean {
  return Math.abs(x - cx) < corridorHalfU + config.rat.sizeU / 2;
}

export function generateSegment(seed: string, k: number): SegmentContent {
  const cx = corridorX(seed, k);
  const out: SegmentContent = { k, kind: 'empty', corridorX: cx, rats: [], gate: null, bossX: null, tuna: null };
  const rng = createRng(seed + ':' + k);
  const W = config.world.widthU;
  const size = config.rat.sizeU;
  const dM = k * L.segmentM;

  if (isBossSegment(seed, k)) {
    const half = config.boss.sizeU / 2 + config.boss.xMarginU;
    out.kind = 'boss';
    out.bossX = randReal(rng, half, W - half);
    return out;
  }
  if (isWarmup(k) || inClearZone(seed, k)) return out;
  if (isGateMark(k)) {
    out.kind = 'gate';
    out.gate = drawGatePair(rng, k);
    return out;
  }
  if (spawnsGate(seed, k - 1) || spawnsGate(seed, k + 1)) return out;
  if (placeGuard(seed, k, cx, out)) return out;
  if (isTunaMark(k) && placeTuna(seed, k, cx, out)) return out;

  const emptyChance = Math.max(L.emptyFloor, L.emptyStart - dM / L.emptyFallM);
  if (rng() < emptyChance) return out;

  let total = 0;
  for (const f of L.formationWeights) total += f.weight;
  const pick = rng() * total;
  let acc = 0;
  let kind: 'column' | 'swarm' | 'wall' = L.formationWeights[L.formationWeights.length - 1]!.kind;
  for (const f of L.formationWeights) {
    acc += f.weight;
    if (acc > pick) {
      kind = f.kind;
      break;
    }
  }

  const hp = ratHpAt(dM);
  const placed: { x: number; dy: number }[] = [];
  const maxDy = L.bandU - size;
  if (kind === 'column') {
    const n = Math.min(L.columnCap, L.columnBase + Math.floor(dM / L.columnEveryM));
    let x: number | null = null;
    for (let t = 0; t < L.columnTries; t++) {
      const cand = randReal(rng, size / 2, W - size / 2);
      if (!inCorridor(cand, cx)) {
        x = cand;
        break;
      }
    }
    if (x !== null) for (let i = 0; i < n; i++) placed.push({ x, dy: i * L.columnSpacingU });
  } else if (kind === 'wall') {
    const dy = randReal(rng, 0, maxDy);
    for (let i = 0; i < L.wallSlots; i++) {
      const x = L.wallSlotOriginU + L.wallSlotSpacingU * i;
      if (!inCorridor(x, cx)) placed.push({ x, dy });
    }
  } else {
    const n = Math.min(L.swarmCap, L.swarmBase + Math.floor(dM / L.swarmEveryM));
    for (let r = 0; r < n; r++) {
      for (let t = 0; t < L.swarmTries; t++) {
        const x = randReal(rng, size / 2, W - size / 2);
        const dy = randReal(rng, 0, maxDy);
        if (inCorridor(x, cx)) continue;
        let clash = false;
        for (const p of placed) {
          if (overlaps(x, dy, size, size, p.x, p.dy, size, size)) {
            clash = true;
            break;
          }
        }
        if (clash) continue;
        placed.push({ x, dy });
        break;
      }
    }
  }
  if (placed.length === 0) return out;
  out.kind = kind;
  out.rats = placed.map((p, i) => ({ laneId: k * 64 + i + 1, x: p.x, dy: p.dy, hp }));
  return out;
}
