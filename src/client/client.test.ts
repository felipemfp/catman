import { describe, expect, it } from 'vitest';
import { generateSegment, isSeed, type GhostPayload, type InputLevel, type WeaponId } from '../core/index.ts';
import dies from '../core/fixtures/dies.json' with { type: 'json' };
import { parseBoot, seedFromBytes, shareLink, searchFor } from './url.ts';
import { levelFromKeys, levelFromPointer } from './input.ts';
import { advance, TICK_MS } from './loop.ts';
import { fetchGhost, verifyBody, RETRY_AT_S, type FetchDeps } from './ghostfetch.ts';
import { bossIcons, gateLabel, iconGlyph } from './labels.ts';
import { createGhostCheck } from './ghostcheck.ts';
import { formatScore } from './format.ts';
import { fireSfx, MIN_GAP_S } from './sfx.ts';
import { BOSS_FRENZY, BOSS_HORDE, BOSS_TWINS, CORE_VERSION, encodeInputLog, toBase64 } from '../core/index.ts';

describe('U-url', () => {
  it('keeps a valid seed, replaces a bad one, reads g only when valid', () => {
    expect(parseBoot('?s=abcd', () => 'zzzzzz')).toEqual({ seed: 'abcd', seedReplaced: false, ghostId: null });
    expect(parseBoot('?s=BAD!', () => 'zzzzzz')).toEqual({ seed: 'zzzzzz', seedReplaced: true, ghostId: null });
    expect(parseBoot('', () => 'zzzzzz').seedReplaced).toBe(true);
    expect(parseBoot('?s=abcd&g=k2x9AbQ7', () => 'x').ghostId).toBe('k2x9AbQ7');
    expect(parseBoot('?s=abcd&g=nope', () => 'x').ghostId).toBeNull();
  });
  it('generates valid seeds, rejecting biased bytes', () => {
    let n = 0;
    const s = seedFromBytes(() => Uint8Array.from([255, 252, n++, 35, 36, 71, 0, 1]));
    expect(isSeed(s)).toBe(true);
    expect(s).toHaveLength(6);
    expect(s.startsWith('0z0z')).toBe(true);
  });
  it('builds links', () => {
    expect(shareLink('https://c.dev', 'abcd', 'k2x9AbQ7')).toBe('https://c.dev/?s=abcd&g=k2x9AbQ7');
    expect(shareLink('https://c.dev', 'abcd')).toBe('https://c.dev/?s=abcd');
    expect(searchFor('abcd', null)).toBe('?s=abcd');
  });
});

describe('U-pointer', () => {
  it('maps pointer offset to a level, clamped, with a dead centre', () => {
    expect(levelFromPointer(270, 270)).toBe(0);
    expect(Object.is(levelFromPointer(269, 270), 0)).toBe(true);
    expect(levelFromPointer(270 + 15, 270)).toBe(1);
    expect(levelFromPointer(270 - 30, 270)).toBe(-2);
    expect(levelFromPointer(540, 270)).toBe(4);
    expect(levelFromPointer(0, 270)).toBe(-4);
    expect(levelFromKeys(true, true)).toBe(0);
    expect(levelFromKeys(true, false)).toBe(-4);
    expect(levelFromKeys(false, true)).toBe(4);
  });
});

describe('U-loop (C2)', () => {
  it('caps catch-up and resets on hidden', () => {
    expect(advance(0, TICK_MS, false).steps).toBe(1);
    expect(advance(0, 100, false)).toEqual({ steps: 5, accMs: 0 });
    expect(advance(10, 16, true)).toEqual({ steps: 0, accMs: 0 });
    let acc = 0;
    let seed = 1;
    for (let i = 0; i < 1000; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const r = advance(acc, (seed / 2147483648) * 400, false);
      expect(r.steps).toBeLessThanOrEqual(5);
      expect(r.accMs).toBeGreaterThanOrEqual(0);
      acc = r.accMs;
    }
  });
});

function fakeDeps(script: (number | 'net')[]) {
  let now = 0;
  const calls: number[] = [];
  const deps: FetchDeps = {
    sleep: (ms) => { now += ms; return Promise.resolve(); },
    fetch: () => {
      calls.push(now);
      const s = script.shift() ?? 404;
      if (s === 'net') return Promise.reject(new Error('net'));
      return Promise.resolve({ status: s, json: () => Promise.resolve({ ok: s }) });
    },
  };
  return { deps, calls };
}

describe('U-retry (C3)', () => {
  it('four 404s then 200 → body, on the schedule', async () => {
    const { deps, calls } = fakeDeps([404, 404, 503, 'net', 200]);
    expect(await fetchGhost('k2x9AbQ7', false, deps)).toEqual({ kind: 'body', body: { ok: 200 } });
    expect(calls).toEqual([0, 2000, 5000, 10000, 20000]);
  });
  it('all 404 → unavailable after the 70 s attempt', async () => {
    const { deps, calls } = fakeDeps([]);
    expect(await fetchGhost('k2x9AbQ7', false, deps)).toEqual({ kind: 'unavailable' });
    expect(calls).toEqual(RETRY_AT_S.map((s) => s * 1000));
  });
  it('403 → unavailable immediately', async () => {
    const { deps, calls } = fakeDeps([403]);
    expect(await fetchGhost('k2x9AbQ7', false, deps)).toEqual({ kind: 'unavailable' });
    expect(calls).toEqual([0]);
  });
  it('verifyBody maps validation outcomes', () => {
    const good = { v: 1, coreVersion: CORE_VERSION, seed: 'abcd', score: 1, ticks: 2, inputs: toBase64(encodeInputLog([0, 0])) };
    expect(verifyBody(good, 'abcd').kind).toBe('ok');
    expect(verifyBody(good, 'wxyz').kind).toBe('different seed');
    expect(verifyBody({ ...good, coreVersion: 0 }, 'abcd').kind).toBe('older version');
    expect(verifyBody({ ...good, score: -1 }, 'abcd').kind).toBe('unavailable');
  });
});

describe('U-labels (C5)', () => {
  it('every half of every gate over seeds 0..99 × 3,000 m has icons and signs', () => {
    const weapons: WeaponId[] = ['pencil', 'laser', 'yarn', 'fishbone'];
    for (let s = 0; s < 100; s++) {
      for (let k = 0; k < 120; k++) {
        const g = generateSegment('gen' + s, k).gate;
        if (!g) continue;
        for (const half of [g.left, g.right]) for (const held of weapons) {
          const l = gateLabel(half, held);
          expect(l.icons.length).toBeGreaterThanOrEqual(1);
          // emoji + number only: no words on narrow gates
          expect(l.text).not.toMatch(/[A-Za-z]/);
          for (const icon of l.icons) expect(l.text).toContain(iconGlyph(icon));
          if (half.kind === 'stat') expect(l.text.split('\n')).toHaveLength(2);
          if (half.kind === 'stat') expect(l.signs).toEqual(['+', '−']);
          if (half.kind === 'weapon') {
            if (half.weapon === held) expect(l.icons).toEqual([half.fallback.buff.stat, half.fallback.debuff.stat]);
            else expect(l.icons).toEqual([half.weapon]);
          }
        }
      }
    }
  });
});

describe('U-boss-icons (CORE_VERSION 10)', () => {
  it('plain is a crown; each variant has its own emoji; combos show both; no words', () => {
    expect(bossIcons(0)).toBe('👑');
    expect(bossIcons(BOSS_HORDE)).toBe('🐀');
    expect(bossIcons(BOSS_FRENZY)).toBe('⚡');
    expect(bossIcons(BOSS_TWINS)).toBe('👑👑');
    expect(bossIcons(BOSS_TWINS | BOSS_FRENZY)).toBe('👑👑 ⚡');
    const all = [0, 1, 2, 3, 4, 5, 6].map(bossIcons);
    expect(new Set(all).size).toBe(all.length);
    for (const s of all) expect(s).not.toMatch(/[A-Za-z]/);
  });
});

describe('U-fire-sfx (CORE_VERSION 11)', () => {
  it('each weapon has its own throttled firing sound; projectile weapons play only when a shot spawned; the laser while on', () => {
    expect(fireSfx('pencil', 4, 5, true)).toBe('pencil');
    expect(fireSfx('yarn', 4, 5, true)).toBe('yarn');
    expect(fireSfx('fishbone', 4, 9, true)).toBe('fishbone');
    expect(fireSfx('pencil', 5, 5, true)).toBeNull();
    expect(fireSfx('laser', 5, 5, true)).toBe('laser');
    expect(fireSfx('laser', 5, 5, false)).toBeNull();
    for (const w of ['pencil', 'laser', 'yarn', 'fishbone'] as const) expect(MIN_GAP_S[w]).toBeGreaterThan(0);
  });
});

describe('U-ghostcheck (C9)', () => {
  const payload: GhostPayload = { v: 1, coreVersion: dies.coreVersion, seed: dies.seed, score: dies.ended!.score, ticks: dies.ticks, inputs: '' };
  const levels = dies.levels as InputLevel[];
  const runCheck = (p: GhostPayload, l: InputLevel[]) => {
    const c = createGhostCheck(p, l);
    for (;;) { const r = c.advance(2000); if (r.done) return r.verdict; }
  };
  it('the fixture as-is is ok', () => expect(runCheck(payload, levels)).toBe('ok'));
  it('score off by 1 → doesn\'t match', () => expect(runCheck({ ...payload, score: payload.score + 1 }, levels)).toBe("doesn't match"));
  it('ticks one short (levels cut to match) → doesn\'t match', () =>
    expect(runCheck({ ...payload, ticks: payload.ticks - 1 }, levels.slice(0, -1))).toBe("doesn't match"));
  it('formatScore', () => expect(formatScore(4312)).toBe('4,312'));
});
