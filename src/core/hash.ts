// FNV-1a 32 over RunState in types.ts field order. Numbers are hashed as raw f64 LE bytes.
import type { Boss, Cat, Gate, GatePair, Horde, Mods, Projectile, Rat, RunState, StatGate } from './types.ts';

type H = { h: number; dv: DataView };

function byte(s: H, b: number): void {
  s.h = Math.imul(s.h ^ b, 0x01000193) >>> 0;
}
function num(s: H, n: number): void {
  if (Number.isNaN(n)) {
    s.dv.setUint32(0, 0, true);
    s.dv.setUint32(4, 0x7ff80000, true);
  } else {
    s.dv.setFloat64(0, n, true);
  }
  for (let i = 0; i < 8; i++) byte(s, s.dv.getUint8(i));
}
function str(s: H, v: string): void {
  num(s, v.length);
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    byte(s, c & 0xff);
    byte(s, c >>> 8);
  }
}
function bool(s: H, b: boolean): void {
  byte(s, b ? 0x02 : 0x01);
}
function nul(s: H): void {
  byte(s, 0x00);
}
function mods(s: H, m: Mods): void {
  num(s, m.damageMult); num(s, m.fireRateMult); num(s, m.rangeMult);
  num(s, m.pierceAdd); num(s, m.projectilesAdd); num(s, m.moveSpeedMult);
}
function cat(s: H, c: Cat): void {
  num(s, c.x); num(s, c.vx); num(s, c.hp); num(s, c.invulnTicks); str(s, c.weapon); mods(s, c.mods); num(s, c.cooldown);
}
function rat(s: H, r: Rat): void {
  num(s, r.laneId); num(s, r.segmentK); num(s, r.x); num(s, r.baseY); num(s, r.y); num(s, r.hp);
}
function statGate(s: H, g: StatGate): void {
  str(s, g.kind);
  str(s, g.buff.stat); num(s, g.buff.value);
  str(s, g.debuff.stat); num(s, g.debuff.value);
}
function gate(s: H, g: Gate): void {
  if (g.kind === 'stat') statGate(s, g);
  else { str(s, g.kind); str(s, g.weapon); statGate(s, g.fallback); }
}
function gatePair(s: H, g: GatePair): void {
  num(s, g.laneId); num(s, g.baseY); num(s, g.y); gate(s, g.left); gate(s, g.right); bool(s, g.resolved);
}
function projectile(s: H, p: Projectile): void {
  num(s, p.id); str(s, p.weapon); num(s, p.x); num(s, p.y); num(s, p.vx); num(s, p.vy);
  num(s, p.w); num(s, p.h); num(s, p.speedU); num(s, p.damage); num(s, p.rangeU); num(s, p.travelled); num(s, p.hitsLeft);
  num(s, p.hitIds.length);
  for (const id of p.hitIds) num(s, id);
}
function boss(s: H, b: Boss | null): void {
  if (b === null) { nul(s); return; }
  num(s, b.index); num(s, b.x); num(s, b.y); num(s, b.hp); num(s, b.maxHp);
}
function horde(s: H, h: Horde): void {
  num(s, h.segmentK); num(s, h.alive); num(s, h.spawnTick);
}
function arr<T>(s: H, a: readonly T[], f: (s: H, v: T) => void): void {
  num(s, a.length);
  for (const v of a) f(s, v);
}

export function hashRunState(st: RunState): string {
  const s: H = { h: 0x811c9dc5, dv: new DataView(new ArrayBuffer(8)) };
  str(s, st.seed); num(s, st.tick); num(s, st.distanceU); num(s, st.freezeTicks);
  if (st.over === null) nul(s); else str(s, st.over);
  cat(s, st.cat);
  arr(s, st.rats, rat); arr(s, st.gates, gatePair); arr(s, st.projectiles, projectile);
  boss(s, st.boss); arr(s, st.hordes, horde);
  num(s, st.nextSegmentK); num(s, st.nextProjectileId); num(s, st.bossesSpawned); num(s, st.bossesKilled);
  num(s, st.ratsKilled); num(s, st.score); num(s, st.warnedForBoss);
  return s.h.toString(16).padStart(8, '0');
}
