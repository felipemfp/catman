// Six synthesised sounds, no audio files. The context unlocks on first input.
export type SfxName = 'shoot' | 'hit' | 'gate' | 'warning' | 'death' | 'heal';

type Voice = { type: OscillatorType; from: number; to: number; ms: number; gain: number };
const VOICES: Record<SfxName, Voice> = {
  shoot: { type: 'square', from: 880, to: 660, ms: 40, gain: 0.03 },
  hit: { type: 'sawtooth', from: 220, to: 80, ms: 160, gain: 0.12 },
  gate: { type: 'triangle', from: 520, to: 1040, ms: 180, gain: 0.1 },
  warning: { type: 'square', from: 330, to: 330, ms: 400, gain: 0.07 },
  death: { type: 'sawtooth', from: 400, to: 40, ms: 700, gain: 0.12 },
  heal: { type: 'sine', from: 660, to: 1320, ms: 260, gain: 0.12 },
};
const MUTE_KEY = 'catman.muted';

export function createSfx() {
  let ctx: AudioContext | null = null;
  let muted = true;
  try {
    muted = localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    muted = true; // storage throws: default to muted
  }
  let lastShoot = 0;
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
      if (name === 'shoot') {
        if (now - lastShoot < 0.08) return;
        lastShoot = now;
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
