// Synthesised sounds, no audio files. The context unlocks on first input.
import type { WeaponId } from '../core/index.ts';
export type SfxName = 'pencil' | 'laser' | 'yarn' | 'fishbone' | 'hit' | 'gate' | 'warning' | 'death' | 'heal' | 'horde' | 'frenzy' | 'twins';

type Voice = { type: OscillatorType; from: number; to: number; ms: number; gain: number };
const VOICES: Record<SfxName, Voice> = {
  // firing: one voice per weapon, each throttled by MIN_GAP_S so fast fire rates stay a texture, not a buzz
  pencil: { type: 'square', from: 1400, to: 900, ms: 35, gain: 0.025 },
  laser: { type: 'sawtooth', from: 170, to: 190, ms: 200, gain: 0.03 },
  yarn: { type: 'sine', from: 260, to: 520, ms: 90, gain: 0.06 },
  fishbone: { type: 'triangle', from: 900, to: 350, ms: 60, gain: 0.04 },
  hit: { type: 'sawtooth', from: 220, to: 80, ms: 160, gain: 0.12 },
  gate: { type: 'triangle', from: 520, to: 1040, ms: 180, gain: 0.1 },
  warning: { type: 'square', from: 330, to: 330, ms: 400, gain: 0.07 },
  death: { type: 'sawtooth', from: 400, to: 40, ms: 700, gain: 0.12 },
  heal: { type: 'sine', from: 660, to: 1320, ms: 260, gain: 0.12 },
  // boss telegraphs: one voice per variant (CORE_VERSION 10)
  horde: { type: 'sawtooth', from: 110, to: 160, ms: 600, gain: 0.1 },
  frenzy: { type: 'square', from: 900, to: 1500, ms: 300, gain: 0.06 },
  twins: { type: 'triangle', from: 260, to: 520, ms: 500, gain: 0.12 },
};
const MUTE_KEY = 'catman.muted';

/** Minimum seconds between two plays of a firing voice. */
export const MIN_GAP_S: Partial<Record<SfxName, number>> = { pencil: 0.08, laser: 0.18, yarn: 0.12, fishbone: 0.12 };

/** The firing sound for this tick, or null: a projectile weapon that spawned shots, or a laser that is on. */
export function fireSfx(weapon: WeaponId, prevProjectileId: number, nextProjectileId: number, beamOn: boolean): SfxName | null {
  if (weapon === 'laser') return beamOn ? 'laser' : null;
  return nextProjectileId > prevProjectileId ? weapon : null;
}

export function createSfx() {
  let ctx: AudioContext | null = null;
  let muted = true;
  try {
    muted = localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    muted = true; // storage throws: default to muted
  }
  const last: Partial<Record<SfxName, number>> = {};
  return {
    unlock(): void {
      if (ctx) return;
      try {
        ctx = new AudioContext();
      } catch {
        ctx = null;
      }
    },
    isMuted: () => muted,
    toggle(): boolean {
      muted = !muted;
      try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch { /* storage unavailable */ }
      return muted;
    },
    play(name: SfxName): void {
      if (muted || !ctx) return;
      const now = ctx.currentTime;
      const gap = MIN_GAP_S[name];
      if (gap !== undefined) {
        if (now - (last[name] ?? -Infinity) < gap) return;
        last[name] = now;
      }
      const v = VOICES[name];
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = v.type;
      osc.frequency.setValueAtTime(v.from, now);
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, v.to), now + v.ms / 1000);
      gain.gain.setValueAtTime(v.gain, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + v.ms / 1000);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + v.ms / 1000 + 0.02);
    },
  };
}
export type Sfx = ReturnType<typeof createSfx>;
