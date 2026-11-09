import type { Gate, Mods, StatGate, StatKey, WeaponId } from './types.ts';
import { STAT_KEYS } from './types.ts';
import { config } from './config.ts';
import { clamp } from './math.ts';

export const DPS_AXIS: readonly StatKey[] = ['damageMult', 'fireRateMult', 'projectilesAdd'];
export const DEBUFFABLE: readonly StatKey[] = ['damageMult', 'fireRateMult', 'rangeMult'];
export const ADDITIVE: readonly StatKey[] = ['pierceAdd', 'projectilesAdd'];

export function isAdditive(s: StatKey): boolean {
  return s === 'pierceAdd' || s === 'projectilesAdd';
}
export function onDpsAxis(s: StatKey): boolean {
  return s === 'damageMult' || s === 'fireRateMult' || s === 'projectilesAdd';
}

export function defaultMods(): Mods {
  return { damageMult: 1, fireRateMult: 1, rangeMult: 1, pierceAdd: 0, projectilesAdd: 0, moveSpeedMult: 1 };
}

export function clampMods(m: Mods): void {
  const c = config.clamps;
  m.damageMult = clamp(m.damageMult, c.multMin, c.multMax);
  m.fireRateMult = clamp(m.fireRateMult, c.multMin, c.multMax);
  m.rangeMult = clamp(m.rangeMult, c.multMin, c.multMax);
  m.pierceAdd = clamp(m.pierceAdd, c.pierceAddMin, c.pierceAddMax);
  m.projectilesAdd = clamp(m.projectilesAdd, c.projectilesAddMin, c.projectilesAddMax);
  m.moveSpeedMult = clamp(m.moveSpeedMult, c.moveSpeedMin, c.moveSpeedMax);
}

function applyOne(m: Mods, stat: StatKey, value: number): void {
  if (isAdditive(stat)) m[stat] += value;
  else m[stat] *= value;
}

/** Applies a stat gate's buff then debuff, then clamps. Mutates `m`. */
export function applyStatGate(m: Mods, g: StatGate): void {
  applyOne(m, g.buff.stat, g.buff.value);
  applyOne(m, g.debuff.stat, g.debuff.value);
  clampMods(m);
}

export function allowedDebuffs(buff: StatKey): StatKey[] {
  return DEBUFFABLE.filter((s) => s !== buff && !(onDpsAxis(buff) && onDpsAxis(s)));
}

function validateStat(g: StatGate): { ok: true } | { ok: false; reason: string } {
  const { buff, debuff } = g;
  if (!STAT_KEYS.includes(buff.stat) || !STAT_KEYS.includes(debuff.stat)) return { ok: false, reason: 'unknown stat' };
  if (buff.stat === debuff.stat) return { ok: false, reason: 'buff and debuff on the same stat' };
  if (onDpsAxis(buff.stat) && onDpsAxis(debuff.stat)) return { ok: false, reason: 'DPS-only trade' };
  if (!DEBUFFABLE.includes(debuff.stat)) return { ok: false, reason: 'debuff on an additive or move-speed stat' };
  if (!Number.isFinite(buff.value) || !Number.isFinite(debuff.value)) return { ok: false, reason: 'non-finite value' };
  if (isAdditive(buff.stat) ? !(buff.value > 0) : !(buff.value > 1)) return { ok: false, reason: 'buff does not raise its stat' };
  if (!(debuff.value < 1 && debuff.value > config.clamps.multMin)) return { ok: false, reason: 'debuff not in (floor, 1)' };
  return { ok: true };
}

export function validateGate(gate: Gate): { ok: true } | { ok: false; reason: string } {
  if (gate.kind === 'weapon') return validateStat(gate.fallback);
  if (gate.kind === 'stat') {
    if (!gate.buff || !gate.debuff) return { ok: false, reason: 'pure buff or pure debuff' };
    return validateStat(gate);
  }
  return { ok: false, reason: 'unknown kind' };
}

export function tierFor(markM: number): { buffMult: number; buffAdd: number; debuffMult: number } {
  const tiers = config.gates.tiers;
  for (let i = tiers.length - 1; i >= 0; i--) {
    const t = tiers[i]!;
    if (markM >= t.fromM) return t;
  }
  return tiers[0]!;
}

// ---- effective stats (used by firing, tests and the client HUD) ----

export const catTopY = config.world.catLineY - config.cat.heightU / 2;

export function effPierce(weapon: WeaponId, m: Mods): number {
  const w = config.weapons[weapon];
  return Math.max(0, w.pierce + m.pierceAdd);
}
export function effBounces(m: Mods): number {
  return Math.max(0, config.weapons.yarn.bounces + m.pierceAdd);
}
export function effProjectiles(weapon: WeaponId, m: Mods): number {
  const w = config.weapons[weapon];
  const base = w.kind === 'beam' ? w.beams : w.projectiles;
  return clamp(base + m.projectilesAdd, config.clamps.effProjectilesMin, config.clamps.effProjectilesMax);
}
export function effDamage(weapon: WeaponId, m: Mods): number {
  const w = config.weapons[weapon];
  return (w.kind === 'beam' ? w.dps : w.damage) * m.damageMult;
}
export function effFireRate(weapon: WeaponId, m: Mods): number {
  const w = config.weapons[weapon];
  return (w.kind === 'beam' ? w.dps : w.rate) * m.fireRateMult;
}
export function effRange(weapon: WeaponId, m: Mods): number {
  const w = config.weapons[weapon];
  const r = w.rangeU * m.rangeMult;
  return w.kind === 'beam' ? Math.min(r, catTopY) : r;
}
