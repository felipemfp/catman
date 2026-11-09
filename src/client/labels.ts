// Gate labels (C5): every half has an emoji and a signed number per stat change; colour is extra.
// No words: gates are narrow (CORE_VERSION 9), so a line is "📏 +30%" or "🗡️ +1", and a weapon is its emoji.
import { isAdditive, type Gate, type StatGate, type StatKey, type WeaponId } from '../core/index.ts';

export type IconId = StatKey | WeaponId;
export type GateLabel = { icons: IconId[]; signs: ('+' | '−')[]; text: string; buff: boolean[] };

const GLYPHS: Record<IconId, string> = {
  damageMult: '💥', fireRateMult: '⏩', rangeMult: '📏', pierceAdd: '🗡️', projectilesAdd: '➕', moveSpeedMult: '👟',
  pencil: '✏️', laser: '🔦', yarn: '🧶', fishbone: '🐟',
};

export function iconGlyph(id: string): string {
  return GLYPHS[id as IconId] ?? '?';
}

function change(stat: StatKey, value: number): { sign: '+' | '−'; text: string } {
  if (isAdditive(stat)) {
    const sign = value >= 0 ? '+' : '−';
    return { sign, text: `${iconGlyph(stat)} ${sign}${Math.abs(value)}` };
  }
  const pct = Math.round(Math.abs(value - 1) * 100);
  const sign = value >= 1 ? '+' : '−';
  return { sign, text: `${iconGlyph(stat)} ${sign}${pct}%` };
}

function statLabel(g: StatGate): GateLabel {
  const b = change(g.buff.stat, g.buff.value);
  const d = change(g.debuff.stat, g.debuff.value);
  return { icons: [g.buff.stat, g.debuff.stat], signs: [b.sign, d.sign], text: `${b.text}\n${d.text}`, buff: [true, false] };
}

export function gateLabel(gate: Gate, held: WeaponId): GateLabel {
  if (gate.kind === 'stat') return statLabel(gate);
  if (gate.weapon === held) return statLabel(gate.fallback);
  return { icons: [gate.weapon], signs: [], text: iconGlyph(gate.weapon), buff: [] };
}
