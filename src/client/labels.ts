// Gate labels (C5): every half has an icon and a +/− sign per stat change; colour is extra.
import { isAdditive, type Gate, type StatGate, type StatKey, type WeaponId } from '../core/index.ts';

export type IconId = StatKey | WeaponId;
export type GateLabel = { icons: IconId[]; signs: ('+' | '−')[]; text: string; buff: boolean[] };

const NAMES: Record<StatKey, string> = {
  damageMult: 'DMG', fireRateMult: 'RATE', rangeMult: 'RANGE', pierceAdd: 'PIERCE', projectilesAdd: 'SHOTS', moveSpeedMult: 'SPEED',
};

function change(stat: StatKey, value: number): { sign: '+' | '−'; text: string } {
  if (isAdditive(stat)) return { sign: value >= 0 ? '+' : '−', text: `${value >= 0 ? '+' : '−'}${Math.abs(value)} ${NAMES[stat]}` };
  const pct = Math.round(Math.abs(value - 1) * 100);
  const sign = value >= 1 ? '+' : '−';
  return { sign, text: `${sign}${pct}% ${NAMES[stat]}` };
}

function statLabel(g: StatGate): GateLabel {
  const b = change(g.buff.stat, g.buff.value);
  const d = change(g.debuff.stat, g.debuff.value);
  return { icons: [g.buff.stat, g.debuff.stat], signs: [b.sign, d.sign], text: `${b.text}\n${d.text}`, buff: [true, false] };
}

export function gateLabel(gate: Gate, held: WeaponId): GateLabel {
  if (gate.kind === 'stat') return statLabel(gate);
  if (gate.weapon === held) return statLabel(gate.fallback);
  return { icons: [gate.weapon], signs: [], text: gate.weapon.toUpperCase(), buff: [] };
}
