// The 13-step tick (SPEC-game-core § Tick order). Changing the order bumps CORE_VERSION.
import type { Boss, CoreEvent, DeepReadonly, InputLevel, Mods, Projectile, Rat, RunState, Tuna, WeaponId } from './types.ts';
import { config } from './config.ts';
import { overlaps } from './math.ts';
import { stepCat } from './cat.ts';
import { bossIndexOfSegment, generateSegment, segU } from './lane.ts';
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
  b.x = Math.max(half, Math.min(W.widthU - half, b.x));
  const over = b.missTicks - B.missGraceTicks + 1;
  const mult = over > 0 ? Math.min(B.rageMax, 1 + B.rageRampPerTick * over) : 1;
  b.y += B.speedUPerTick * mult;
  b.missTicks += 1;
}

/** Boss damage multiplier: pierce taken at gates drills into the boss (SPEC-game-core § Boss). */
function bossMult(s: RunState): number {
  return 1 + B.pierceBonus * s.cat.mods.pierceAdd;
}

export function createState(seed: string): RunState {
  return {
    seed, tick: 0, distanceU: 0, freezeTicks: 0, over: null,
    cat: { x: W.widthU / 2, vx: 0, hp: C.hp, invulnTicks: 0, weapon: 'pencil', mods: defaultMods(), cooldown: 0 },
    rats: [], gates: [], projectiles: [], boss: null, hordes: [],
    nextSegmentK: 0, nextProjectileId: 0, bossesSpawned: 0, bossesKilled: 0, ratsKilled: 0, score: 0, warnedForBoss: -1,
    tunas: [], bonusScore: 0,
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

type BeamTarget = { y: number; id: number; rat: Rat | null };

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
      if (r.hp > 0 && overlaps(bx, cy, lw.beamWidthU, h, r.x, r.y, RAT, RAT)) targets.push({ y: r.y, id: r.laneId, rat: r });
    }
    const boss = s.boss;
    if (boss !== null && overlaps(bx, cy, lw.beamWidthU, h, boss.x, boss.y, B.sizeU, B.sizeU)) {
      targets.push({ y: boss.y, id: -1, rat: null });
    }
    targets.sort((a, c) => (c.y - a.y) || (a.id - c.id));
    const count = Math.min(maxTargets, targets.length);
    for (let i = 0; i < count; i++) {
      const t = targets[i]!;
      if (t.rat !== null) {
        t.rat.hp -= dmg;
        if (showEvent) ev.push({ t: 'damage', x: t.rat.x, y: t.rat.y, amount: dmg * 10 });
        if (t.rat.hp <= 0) killRat(s, t.rat, ev);
      } else if (boss !== null) {
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
    const boss = s.boss;
    if (p.hitsLeft > 0 && boss !== null && overlaps(p.x, p.y, p.w, p.h, boss.x, boss.y, B.sizeU, B.sizeU)) {
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
    const index = bossIndexOfSegment(k);
    if (index !== s.bossesSpawned) return; // scenario started on this mark: counted as spawned and killed
    const hp = opts.nextBossHp ?? bossHpFor(index);
    opts.nextBossHp = null;
    const boss: Boss = { index, x: seg.bossX!, y: -B.sizeU / 2, hp, maxHp: hp, missTicks: 0 };
    s.boss = boss;
    s.bossesSpawned += 1;
    s.cat.cooldown = 0;
    s.projectiles = [];
    ev.push({ t: 'bossSpawned', index, hp });
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

function bossWarning(s: RunState, opts: RunOpts, ev: CoreEvent[]): void {
  const i = s.warnedForBoss + 1;
  const markM = (i + 1) * B.everyM;
  if (s.distanceU / 10 < markM - B.warningM) return;
  s.warnedForBoss = i;
  const hp = opts.nextBossHp ?? bossHpFor(s.bossesSpawned);
  const bossX = generateSegment(s.seed, markM / config.lane.segmentM).bossX!;
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
    for (const g of s.gates) g.y = g.baseY + s.distanceU;
    for (const t of s.tunas) t.y = t.baseY + s.distanceU;
    if (s.boss !== null) moveBoss(s.boss, cat.x);
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
        const side = cat.x < W.widthU / 2 ? 'left' : 'right';
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
    if (boss !== null && boss.hp <= 0) {
      if (step.probe) {
        if (probe && probe.killTick === null) probe.killTick = s.tick;
      } else {
        s.boss = null;
        s.bossesKilled += 1;
        s.freezeTicks = Math.max(s.freezeTicks, B.killFreezeTicks);
        ev.push({ t: 'bossKilled', index: boss.index });
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
    if (!step.probe) bossWarning(s, opts, ev);
  }
  // 13
  let cause: RunState['over'] = null;
  if (!frozen) {
    if (s.cat.hp <= 0) cause = 'rats';
    else if (s.boss !== null && s.boss.y + B.sizeU / 2 >= catTopY) cause = 'boss';
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
export function simulateBossFight(mods: Mods, weapon: WeaponId, bossHp: number, bossX: number):
  { damageByReach: number; killTick: number | null; reachTick: number } {
  const s = createState('scratch0');
  const markM = B.everyM;
  s.distanceU = markM * 10;
  s.nextSegmentK = markM / config.lane.segmentM + 1;
  s.bossesSpawned = 1;
  s.warnedForBoss = 0;
  s.cat.x = bossX;
  s.cat.weapon = weapon;
  s.cat.mods = { ...mods };
  s.boss = { index: 0, x: bossX, y: -B.sizeU / 2, hp: bossHp, maxHp: bossHp, missTicks: 0 };
  const opts: RunOpts = { nextBossHp: null, gates: true };
  const probe: ProbeResult = { killTick: null };
  while (s.over === null) stepState(s, 0, opts, { probe: true }, probe);
  const finalHp = s.boss === null ? 0 : s.boss.hp;
  return { damageByReach: bossHp - finalHp, killTick: probe.killTick, reachTick: s.tick };
}
