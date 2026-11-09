// The 13-step tick (SPEC-game-core § Tick order). Changing the order bumps CORE_VERSION.
import type { Boss, CoreEvent, Fight, DeepReadonly, InputLevel, Mods, Projectile, Rat, RunState, Tuna, WeaponId } from './types.ts';
import { config } from './config.ts';
import { overlaps } from './math.ts';
import { stepCat } from './cat.ts';
import { BOSS_FRENZY, BOSS_HORDE, BOSS_TWINS, bossIndexOfSegment, bossMarkK, bossVariant, generateSegment, ratHpAt, segU } from './lane.ts';
import { createRng, randInt, randReal } from './rng.ts';
import { applyStatGate, catTopY, defaultMods, effBounces, effPierce, effProjectiles } from './stats.ts';

export type StepOpts = { probe: boolean };
/** Run-level options that are not part of the hashed state (scenario-only). */
export type RunOpts = { nextBossHp: number | null; gates: boolean };
export type ProbeResult = { killTick: number | null };

const W = config.world;
const C = config.cat;
const RAT = config.rat.sizeU;
const B = config.boss;

export function bossHpFor(index: number): number {
  let hp = B.baseHp;
  for (let i = 0; i < index; i++) hp *= B.hpGrowth;
  return hp;
}

export function scrollFor(state: DeepReadonly<RunState>): number {
  if (state.boss !== null) return 0;
  const s = config.scroll;
  return Math.min(s.maxUPerTick, s.baseUPerTick + s.rampPerM * (state.distanceU / 10));
}

/**
 * Step 5 for the boss: drift toward the cat (at most trackUPerTick, never past it, kept on screen), and descend at
 * base speed, or faster once missTicks reaches the grace window. A hit in step 4 has already reset missTicks to 0.
 */
function moveBoss(b: Boss, catX: number): void {
  const half = B.sizeU / 2;
  const dx = catX - b.x;
  b.x += Math.max(-B.trackUPerTick, Math.min(B.trackUPerTick, dx));
  // a twin keeps to its own half, so the cat must cross the middle to hit the other one
  const lo = b.half === 1 ? W.widthU / 2 + half : half;
  const hi = b.half === 0 ? W.widthU / 2 - half : W.widthU - half;
  b.x = Math.max(lo, Math.min(hi, b.x));
  const over = b.missTicks - B.missGraceTicks + 1;
  const mult = over > 0 ? Math.min(B.rageMax, 1 + B.rageRampPerTick * over) : 1;
  b.y += B.speedUPerTick * mult;
  b.missTicks += 1;
}

/** Which gate box the cat's body overlaps at x, or null between/outside them (SPEC-game-core § Narrow gates). */
export function gateSideAt(x: number): 'left' | 'right' | null {
  const reach = (config.gates.widthU + C.widthU) / 2;
  if (Math.abs(x - W.widthU / 4) < reach) return 'left';
  if (Math.abs(x - (3 * W.widthU) / 4) < reach) return 'right';
  return null;
}

/** Sideways homing per unit scrolled at distance dM (SPEC-game-core § Homing rats). */
export function homingFrac(dM: number): number {
  const H = config.rat.homing;
  return Math.min(H.maxFrac, Math.max(0, (dM - H.startM) * H.fracPerM));
}

/**
 * Step 5, after scrolling: rats above the lock line drift toward the cat by at most frac × scroll, never past it.
 * Scaled by scroll, so a frozen or stopped lane (boss fight) leaves rat x alone and the lane stays distance-driven.
 */
/** Extra forward speed per unit scrolled at distance dM: rats charge, so standing still stops working. */
export function chargeFrac(dM: number): number {
  const H = config.rat.homing;
  return Math.min(H.maxCharge, Math.max(0, (dM - H.startM) * H.chargePerM));
}

function homeRats(s: RunState, scroll: number): void {
  const dM = s.distanceU / 10;
  const frac = homingFrac(dM);
  if (frac === 0 || s.rats.length === 0) return;
  // charge: a constant extra forward speed for every rat (moving baseY keeps y = baseY + distanceU true)
  const charge = chargeFrac(dM) * scroll;
  if (charge > 0) for (const r of s.rats) { r.baseY += charge; r.y += charge; }
  const step = frac * scroll;
  const lockY = W.catLineY - config.rat.homing.lockU;
  const cx = s.cat.x;
  for (const r of s.rats) {
    if (r.y > lockY) continue;
    const d = cx - r.x;
    r.x += d > 0 ? Math.min(step, d) : Math.max(-step, d);
  }
}

/** Boss damage multiplier: pierce taken at gates drills into the boss (SPEC-game-core § Boss). */
function bossMult(s: RunState): number {
  return 1 + B.pierceBonus * s.cat.mods.pierceAdd;
}

/** Live bosses, main first. A twin exists only while the main boss does. */
function bossesOf(s: RunState): Boss[] {
  if (s.boss === null) return [];
  return s.twin === null ? [s.boss] : [s.boss, s.twin];
}

/** HP multiplier of one boss of a fight with this variant. */
export function variantHpMult(variant: number): number {
  const m = B.variants.hpMult;
  let k = 1;
  if (variant & BOSS_HORDE) k *= m.horde;
  if (variant & BOSS_FRENZY) k *= m.frenzy;
  if (variant & BOSS_TWINS) k *= m.twins;
  return k;
}

/** Wave rats get ids above any lane id; horde ones and fast frenzy ones in separate ranges. */
const HORDE_ID = 5e8;
const FRENZY_ID = 6e8;
/** Wave rats carry these segmentK values (no lane segment, no horde bookkeeping). */
const HORDE_K = -2;
const FRENZY_K = -3;

function waveEvery(s: RunState, f: Fight, every: number, min: number): number {
  let hp = 0;
  for (const b of bossesOf(s)) hp += Math.max(0, b.hp);
  const frac = f.maxHp > 0 ? Math.min(1, hp / f.maxHp) : 0;
  return Math.round(min + (every - min) * frac);
}

/** Spawns one fight wave at the top of the screen (SPEC-game-core § Boss variants). */
function spawnWave(s: RunState, f: Fight, kind: 'horde' | 'frenzy'): void {
  const rng = createRng(s.seed + ':wave:' + f.index + ':' + f.waves);
  f.waves += 1;
  const hp = ratHpAt(s.distanceU / 10);
  const y = config.rat.spawnYU;
  const base = s.distanceU;
  if (kind === 'horde') {
    const L = config.lane;
    const gap = randInt(rng, L.wallSlots - B.horde.gapSlots + 1);
    for (let i = 0; i < L.wallSlots; i++) {
      if (i >= gap && i < gap + B.horde.gapSlots) continue;
      s.rats.push({ laneId: HORDE_ID + s.nextWaveId++, segmentK: HORDE_K, x: L.wallSlotOriginU + L.wallSlotSpacingU * i, baseY: y - base, y, hp });
    }
  } else {
    for (let i = 0; i < B.frenzy.rats; i++) {
      const x = randReal(rng, RAT / 2, W.widthU - RAT / 2);
      s.rats.push({ laneId: FRENZY_ID + s.nextWaveId++, segmentK: FRENZY_K, x, baseY: y - base - i * 40, y: y - i * 40, hp });
    }
  }
  s.rats.sort((a, b) => a.laneId - b.laneId);
}

/** Step 5 during a fight: spawn due waves, then move wave rats down and toward the cat. */
function fightWaves(s: RunState, f: Fight): void {
  if (f.variant & BOSS_HORDE && s.tick >= f.nextHordeTick) {
    spawnWave(s, f, 'horde');
    f.nextHordeTick = s.tick + waveEvery(s, f, B.horde.everyTicks, B.horde.minEveryTicks);
  }
  if (f.variant & BOSS_FRENZY && s.tick >= f.nextFrenzyTick) {
    spawnWave(s, f, 'frenzy');
    f.nextFrenzyTick = s.tick + waveEvery(s, f, B.frenzy.everyTicks, B.frenzy.minEveryTicks);
  }
  const lockY = W.catLineY - config.rat.homing.lockU;
  const cx = s.cat.x;
  for (const r of s.rats) {
    if (r.segmentK !== HORDE_K && r.segmentK !== FRENZY_K) continue;
    const w = r.segmentK === FRENZY_K ? B.frenzy : B.horde;
    r.baseY += w.speedU;
    r.y += w.speedU;
    if (r.y > lockY) continue;
    const step = w.homeFrac * w.speedU;
    const d = cx - r.x;
    r.x += d > 0 ? Math.min(step, d) : Math.max(-step, d);
  }
}

export function createState(seed: string): RunState {
  return {
    seed, tick: 0, distanceU: 0, freezeTicks: 0, over: null,
    cat: { x: W.widthU / 2, vx: 0, hp: C.hp, invulnTicks: 0, weapon: 'pencil', mods: defaultMods(), cooldown: 0 },
    rats: [], gates: [], projectiles: [], boss: null, twin: null, fight: null, hordes: [],
    nextSegmentK: 0, nextProjectileId: 0, bossesSpawned: 0, bossesKilled: 0, ratsKilled: 0, score: 0, warnedForBoss: -1,
    tunas: [], bonusScore: 0, telegraphedBoss: -1, nextWaveId: 0,
  };
}

function fire(s: RunState): void {
  const cat = s.cat;
  const weapon = cat.weapon as Exclude<WeaponId, 'laser'>;
  const w = config.weapons[weapon];
  const n = effProjectiles(weapon, cat.mods);
  const hitsLeft = 1 + (weapon === 'yarn' ? effBounces(cat.mods) : effPierce(weapon, cat.mods));
  for (let i = 0; i < n; i++) {
    s.projectiles.push({
      id: s.nextProjectileId++, weapon, x: cat.x, y: catTopY, vx: (i - (n - 1) / 2) * w.spreadVx, vy: -w.speedU,
      w: w.w, h: w.h, speedU: w.speedU, damage: w.damage * cat.mods.damageMult, rangeU: w.rangeU * cat.mods.rangeMult,
      travelled: 0, hitsLeft, hitIds: [],
    });
  }
}

type BeamTarget = { y: number; id: number; rat: Rat | null; boss: Boss | null };

function killRat(s: RunState, rat: Rat, ev: CoreEvent[]): void {
  ev.push({ t: 'ratKilled', laneId: rat.laneId, segmentK: rat.segmentK, x: rat.x, y: rat.y });
  s.ratsKilled += 1;
  decHorde(s, rat.segmentK);
}

function decHorde(s: RunState, k: number): void {
  for (const h of s.hordes) if (h.segmentK === k) { h.alive -= 1; return; }
}

function beams(s: RunState, ev: CoreEvent[]): void {
  const cat = s.cat;
  const lw = config.weapons.laser;
  const m = cat.mods;
  const n = effProjectiles('laser', m);
  const reach = Math.min(lw.rangeU * m.rangeMult, catTopY);
  const top = catTopY - reach;
  const cy = (top + catTopY) / 2;
  const h = catTopY - top;
  const maxTargets = 1 + effPierce('laser', m);
  const dmg = (lw.dps * m.damageMult * m.fireRateMult) / 60;
  const showEvent = s.tick % config.beamEventEveryTicks === 0;
  for (let b = 0; b < n; b++) {
    const bx = cat.x + (b - (n - 1) / 2) * lw.beamSpacingU;
    const targets: BeamTarget[] = [];
    for (const r of s.rats) {
      if (r.hp > 0 && overlaps(bx, cy, lw.beamWidthU, h, r.x, r.y, RAT, RAT)) targets.push({ y: r.y, id: r.laneId, rat: r, boss: null });
    }
    for (const boss of bossesOf(s)) {
      if (overlaps(bx, cy, lw.beamWidthU, h, boss.x, boss.y, B.sizeU, B.sizeU)) targets.push({ y: boss.y, id: -1 - boss.half, rat: null, boss });
    }
    targets.sort((a, c) => (c.y - a.y) || (a.id - c.id));
    const count = Math.min(maxTargets, targets.length);
    for (let i = 0; i < count; i++) {
      const t = targets[i]!;
      if (t.rat !== null) {
        t.rat.hp -= dmg;
        if (showEvent) ev.push({ t: 'damage', x: t.rat.x, y: t.rat.y, amount: dmg * 10 });
        if (t.rat.hp <= 0) killRat(s, t.rat, ev);
      } else if (t.boss !== null) {
        const boss = t.boss;
        const bd = dmg * bossMult(s);
        boss.hp -= bd;
        boss.missTicks = 0;
        if (showEvent) ev.push({ t: 'damage', x: boss.x, y: boss.y, amount: bd * 10 });
      }
    }
  }
}

function retarget(s: RunState, p: Projectile): void {
  const r2max = config.weapons.yarn.retargetRadiusU * config.weapons.yarn.retargetRadiusU;
  let best: Rat | null = null;
  let bestD = Infinity;
  for (const r of s.rats) {
    if (r.hp <= 0 || p.hitIds.includes(r.laneId)) continue;
    const dx = r.x - p.x;
    const dy = r.y - p.y;
    const d = dx * dx + dy * dy;
    if (d <= r2max && d < bestD) { best = r; bestD = d; } // rats sorted by lane id, so strict < keeps the lowest id on ties
  }
  if (best === null) return;
  const dx = best.x - p.x;
  const dy = best.y - p.y;
  const m = Math.max(Math.abs(dx), Math.abs(dy));
  if (m === 0) return;
  p.vx = (dx * p.speedU) / m;
  p.vy = (dy * p.speedU) / m;
}

function projectiles(s: RunState, ev: CoreEvent[]): void {
  let removed = false;
  for (const p of s.projectiles) {
    p.x += p.vx;
    p.y += p.vy;
    p.travelled += Math.max(Math.abs(p.vx), Math.abs(p.vy));
    for (const r of s.rats) {
      if (p.hitsLeft <= 0) break;
      if (r.hp <= 0 || p.hitIds.includes(r.laneId)) continue;
      if (!overlaps(p.x, p.y, p.w, p.h, r.x, r.y, RAT, RAT)) continue;
      r.hp -= p.damage;
      p.hitIds.push(r.laneId);
      p.hitsLeft -= 1;
      ev.push({ t: 'damage', x: r.x, y: r.y, amount: p.damage });
      if (r.hp <= 0) killRat(s, r, ev);
      if (p.weapon === 'yarn' && p.hitsLeft > 0) retarget(s, p);
    }
    for (const boss of bossesOf(s)) {
      if (p.hitsLeft <= 0) break;
      if (!overlaps(p.x, p.y, p.w, p.h, boss.x, boss.y, B.sizeU, B.sizeU)) continue;
      const bd = p.damage * bossMult(s);
      boss.hp -= bd;
      boss.missTicks = 0;
      ev.push({ t: 'damage', x: p.x, y: p.y, amount: bd });
      p.hitsLeft = 0;
    }
    if (p.hitsLeft <= 0) removed = true;
  }
  if (removed) s.projectiles = s.projectiles.filter((p) => p.hitsLeft > 0);
}

function spawnSegment(s: RunState, opts: RunOpts, ev: CoreEvent[]): void {
  const k = s.nextSegmentK;
  s.nextSegmentK += 1;
  const seg = generateSegment(s.seed, k);
  if (seg.kind === 'boss') {
    const index = bossIndexOfSegment(s.seed, k);
    if (index !== s.bossesSpawned) return; // scenario started on this mark: counted as spawned and killed
    const variant = bossVariant(s.seed, index);
    const hp = (opts.nextBossHp ?? bossHpFor(index)) * variantHpMult(variant);
    opts.nextBossHp = null;
    const y = -B.sizeU / 2;
    if (variant & BOSS_TWINS) {
      s.boss = { index, x: W.widthU / 4, y, hp, maxHp: hp, missTicks: 0, half: 0 };
      s.twin = { index, x: (3 * W.widthU) / 4, y, hp, maxHp: hp, missTicks: 0, half: 1 };
    } else {
      s.boss = { index, x: seg.bossX!, y, hp, maxHp: hp, missTicks: 0, half: -1 };
    }
    s.fight = {
      index, variant, maxHp: variant & BOSS_TWINS ? 2 * hp : hp,
      nextHordeTick: s.tick + B.horde.firstTicks, nextFrenzyTick: s.tick + B.frenzy.firstTicks, waves: 0,
    };
    s.bossesSpawned += 1;
    s.cat.cooldown = 0;
    s.projectiles = [];
    ev.push({ t: 'bossSpawned', index, hp, variant });
    return;
  }
  if (seg.gate !== null) {
    if (!opts.gates) return;
    const g = seg.gate;
    g.y = g.baseY + s.distanceU;
    s.gates.push(g);
    return;
  }
  const baseOff = config.rat.spawnYU - k * segU;
  if (seg.tuna !== null) {
    const baseY = baseOff - seg.tuna.dy;
    s.tunas.push({ id: k * 64 + 63, x: seg.tuna.x, baseY, y: baseY + s.distanceU });
  }
  if (seg.rats.length === 0) return;
  const needSort = s.rats.length > 0 && s.rats[s.rats.length - 1]!.laneId > seg.rats[0]!.laneId;
  for (const r of seg.rats) {
    const baseY = baseOff - r.dy;
    s.rats.push({ laneId: r.laneId, segmentK: k, x: r.x, baseY, y: baseY + s.distanceU, hp: r.hp });
  }
  if (needSort) s.rats.sort((a, b) => a.laneId - b.laneId);
  s.hordes.push({ segmentK: k, alive: seg.rats.length, spawnTick: s.tick });
}

/** The variant icon, telegraphM before the mark (SPEC-game-core § Boss variants). */
function bossTelegraph(s: RunState, ev: CoreEvent[]): void {
  const i = s.telegraphedBoss + 1;
  const markM = bossMarkK(s.seed, i) * config.lane.segmentM;
  if (s.distanceU / 10 < markM - B.telegraphM) return;
  s.telegraphedBoss = i;
  ev.push({ t: 'bossIncoming', index: i, variant: bossVariant(s.seed, i) });
}

function bossWarning(s: RunState, opts: RunOpts, ev: CoreEvent[]): void {
  const i = s.warnedForBoss + 1;
  const markK = bossMarkK(s.seed, i);
  const markM = markK * config.lane.segmentM;
  if (s.distanceU / 10 < markM - B.warningM) return;
  s.warnedForBoss = i;
  // total HP of the fight (twins: both); exact for plain bosses, an estimate for variants (waves, split targets)
  const v = bossVariant(s.seed, i);
  const hp = (opts.nextBossHp ?? bossHpFor(s.bossesSpawned)) * variantHpMult(v) * (v & BOSS_TWINS ? 2 : 1);
  const bossX = generateSegment(s.seed, markK).bossX!;
  const r = simulateBossFight(s.cat.mods, s.cat.weapon, hp, bossX);
  const walkSeconds = r.reachTick / 60;
  const scroll = scrollFor(s);
  ev.push({
    t: 'bossWarning',
    haveDps: r.damageByReach / walkSeconds,
    needDps: hp / walkSeconds,
    onPace: r.killTick !== null,
    etaTicks: scroll > 0 ? Math.ceil((markM * 10 - s.distanceU) / scroll) : 0,
  });
}

/** One tick. The public step() always passes probe: false. Returns this tick's events. */
export function stepState(s: RunState, input: InputLevel, opts: RunOpts, step: StepOpts, probe?: ProbeResult): CoreEvent[] {
  if (s.over !== null) return [];
  const ev: CoreEvent[] = [];
  // 1
  s.tick += 1;
  const frozen = s.freezeTicks > 0;
  if (frozen) {
    s.freezeTicks -= 1;
  } else {
    const cat = s.cat;
    // 2
    stepCat(cat, input);
    if (cat.invulnTicks > 0) cat.invulnTicks -= 1;
    // 3
    if (cat.weapon !== 'laser') {
      cat.cooldown -= 1;
      while (cat.cooldown <= 0) {
        fire(s);
        cat.cooldown += 60 / (config.weapons[cat.weapon].rate * cat.mods.fireRateMult);
      }
    }
    // 4
    if (cat.weapon === 'laser') beams(s, ev);
    projectiles(s, ev);
    if (s.rats.length > 0) {
      let dead = false;
      for (const r of s.rats) if (r.hp <= 0) { dead = true; break; }
      if (dead) s.rats = s.rats.filter((r) => r.hp > 0);
    }
    // 5
    const scroll = scrollFor(s);
    const prevDistanceU = s.distanceU;
    s.distanceU += scroll;
    for (const r of s.rats) r.y = r.baseY + s.distanceU;
    homeRats(s, scroll);
    for (const g of s.gates) g.y = g.baseY + s.distanceU;
    for (const t of s.tunas) t.y = t.baseY + s.distanceU;
    for (const b of bossesOf(s)) moveBoss(b, cat.x);
    if (s.fight !== null) fightWaves(s, s.fight);
    // 6
    if (cat.invulnTicks === 0) {
      for (let i = 0; i < s.rats.length; i++) {
        const r = s.rats[i]!;
        if (overlaps(cat.x, W.catLineY, C.widthU, C.heightU, r.x, r.y, RAT, RAT)) {
          cat.hp -= 1;
          cat.invulnTicks = C.invulnTicks;
          s.freezeTicks = Math.max(s.freezeTicks, C.hitFreezeTicks);
          s.rats.splice(i, 1);
          decHorde(s, r.segmentK);
          ev.push({ t: 'catHit', hp: cat.hp });
          break;
        }
      }
    }
    // 6b: tuna, eaten on contact (after the rat hit, so a hit and a heal on one tick net to zero)
    if (s.tunas.length > 0) {
      const TS = config.tuna.sizeU;
      const keep: Tuna[] = [];
      for (const t of s.tunas) {
        if (cat.hp > 0 && overlaps(cat.x, W.catLineY, C.widthU, C.heightU, t.x, t.y, TS, TS)) {
          const healed = cat.hp < C.hp;
          if (healed) cat.hp += 1;
          else s.bonusScore += config.tuna.fullHpScore;
          ev.push({ t: 'tunaEaten', hp: cat.hp, healed });
        } else keep.push(t);
      }
      if (keep.length !== s.tunas.length) s.tunas = keep;
    }
    // 7
    for (const g of s.gates) {
      if (g.resolved) continue;
      const prevY = g.baseY + prevDistanceU;
      if (prevY < W.catLineY && W.catLineY <= g.y) {
        g.resolved = true;
        const side = gateSideAt(cat.x);
        if (side === null) {
          ev.push({ t: 'gateMissed', laneId: g.laneId });
          continue;
        }
        const gate = side === 'left' ? g.left : g.right;
        if (gate.kind === 'weapon' && gate.weapon !== cat.weapon) {
          cat.weapon = gate.weapon;
          ev.push({ t: 'gateTaken', side, gate, applied: gate.weapon });
          ev.push({ t: 'weaponChanged', weapon: gate.weapon });
        } else {
          const sg = gate.kind === 'weapon' ? gate.fallback : gate;
          applyStatGate(cat.mods, sg);
          ev.push({ t: 'gateTaken', side, gate, applied: sg });
        }
      }
    }
    // 8
    const boss = s.boss;
    if (boss !== null) {
      const twin = s.twin;
      if (step.probe) {
        if (boss.hp <= 0 && (twin === null || twin.hp <= 0) && probe && probe.killTick === null) probe.killTick = s.tick;
      } else {
        // a twin that dies first leaves; if the main one dies first, the twin takes its slot
        if (twin !== null && twin.hp <= 0) s.twin = null;
        if (boss.hp <= 0) { s.boss = s.twin; s.twin = null; }
        if (s.boss === null) {
          s.fight = null;
          s.bossesKilled += 1;
          s.freezeTicks = Math.max(s.freezeTicks, B.killFreezeTicks);
          ev.push({ t: 'bossKilled', index: boss.index });
        }
      }
    }
    // 9
    while (s.distanceU >= s.nextSegmentK * segU) spawnSegment(s, opts, ev);
    // 10
    if (s.hordes.length > 0) {
      let gone = false;
      for (const h of s.hordes) {
        let escaped = false;
        for (const r of s.rats) {
          if (r.segmentK === h.segmentK && r.y - RAT / 2 > W.heightU) { escaped = true; break; }
        }
        if (escaped) {
          ev.push({ t: 'hordeEscaped', segmentK: h.segmentK });
          h.alive = -1;
          gone = true;
        } else if (h.alive === 0) {
          ev.push({ t: 'hordeCleared', segmentK: h.segmentK, ticksAlive: s.tick - h.spawnTick });
          h.alive = -1;
          gone = true;
        }
      }
      if (gone) s.hordes = s.hordes.filter((h) => h.alive >= 0);
    }
    // 11
    const xm = config.cleanup.xMarginU;
    if (s.projectiles.length > 0) {
      s.projectiles = s.projectiles.filter(
        (p) => !(p.y + p.h / 2 < 0 || p.x < -xm || p.x > W.widthU + xm || p.travelled > p.rangeU),
      );
    }
    if (s.rats.length > 0 && s.rats.some((r) => r.y - RAT / 2 > W.heightU)) {
      s.rats = s.rats.filter((r) => !(r.y - RAT / 2 > W.heightU));
    }
    if (s.gates.length > 0 && s.gates.some((g) => g.y - config.gates.heightU / 2 > W.heightU)) {
      s.gates = s.gates.filter((g) => !(g.y - config.gates.heightU / 2 > W.heightU));
    }
    if (s.tunas.length > 0 && s.tunas.some((t) => t.y - config.tuna.sizeU / 2 > W.heightU)) {
      s.tunas = s.tunas.filter((t) => {
        const gone = t.y - config.tuna.sizeU / 2 > W.heightU;
        if (gone) ev.push({ t: 'tunaMissed' });
        return !gone;
      });
    }
    // 12
    s.score = Math.floor(s.distanceU / 10) + s.ratsKilled + 250 * s.bossesKilled + s.bonusScore;
    if (!step.probe) { bossTelegraph(s, ev); bossWarning(s, opts, ev); }
  }
  // 13
  let cause: RunState['over'] = null;
  if (!frozen) {
    if (s.cat.hp <= 0) cause = 'rats';
    else if (bossesOf(s).some((b) => b.y + B.sizeU / 2 >= catTopY)) cause = 'boss';
  }
  if (cause === null && s.tick === config.run.maxTicks) cause = 'timeout';
  if (cause !== null) {
    s.over = cause;
    ev.push({ t: 'ended', cause, score: s.score, tick: s.tick });
  }
  return ev;
}

/**
 * Runs the game's own tick on a scratch state that matches what the boss-spawn step leaves:
 * statue cat under the boss, no shots, cooldown 0, empty screen. Exact by construction (F6).
 */
const SCRATCH_MARK_M = 500;

export function simulateBossFight(mods: Mods, weapon: WeaponId, bossHp: number, bossX: number):
  { damageByReach: number; killTick: number | null; reachTick: number } {
  const s = createState('scratch0');
  const markM = SCRATCH_MARK_M;
  s.distanceU = markM * 10;
  s.nextSegmentK = markM / config.lane.segmentM + 1;
  s.bossesSpawned = 1;
  s.warnedForBoss = 0;
  s.cat.x = bossX;
  s.cat.weapon = weapon;
  s.cat.mods = { ...mods };
  s.boss = { index: 0, x: bossX, y: -B.sizeU / 2, hp: bossHp, maxHp: bossHp, missTicks: 0, half: -1 };
  const opts: RunOpts = { nextBossHp: null, gates: true };
  const probe: ProbeResult = { killTick: null };
  while (s.over === null) stepState(s, 0, opts, { probe: true }, probe);
  const finalHp = s.boss === null ? 0 : s.boss.hp;
  return { damageByReach: bossHp - finalHp, killTick: probe.killTick, reachTick: s.tick };
}
