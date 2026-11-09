import { describe, expect, inject, it } from 'vitest';
import type { InputLevel } from './types.ts';
import {
  CORE_VERSION, GhostDecodeError, canonicalGhostJson, decodeInputLog, encodeInputLog, fromBase64, ghostLimits, isGhostId, isSeed,
  toBase64, validateGhostPayload, type GhostErrorCode,
} from './ghost.ts';
import { createRng } from './rng.ts';
import { config } from './config.ts';

const full = inject('full');

function codeOf(f: () => unknown): GhostErrorCode | 'ok' {
  try {
    f();
    return 'ok';
  } catch (e) {
    if (e instanceof GhostDecodeError) return e.code;
    throw e;
  }
}

const b = (...xs: number[]) => Uint8Array.from(xs);

describe('T-codec (F9)', () => {
  it('round trips input logs and base64', () => {
    const rng = createRng('codec');
    for (let n = 0; n < 50; n++) {
      const levels: InputLevel[] = [];
      let l = 0;
      const len = Math.floor(rng() * 3000);
      for (let i = 0; i < len; i++) {
        if (rng() < 0.05) l = Math.floor(rng() * 9) - 4;
        levels.push(l as InputLevel);
      }
      const bytes = encodeInputLog(levels);
      expect(decodeInputLog(bytes)).toEqual(levels);
      expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    }
    // long runs need multi-byte varints
    const long = Array.from({ length: 20000 }, () => 3 as InputLevel);
    expect(decodeInputLog(encodeInputLog(long))).toEqual(long);
  });
  it('every codec error code is reachable', () => {
    expect(codeOf(() => decodeInputLog(b(9, 1)))).toBe('bad_level');
    expect(codeOf(() => decodeInputLog(b(4, 0)))).toBe('zero_run');
    expect(codeOf(() => decodeInputLog(b(4)))).toBe('truncated');
    expect(codeOf(() => decodeInputLog(b(4, 0x81)))).toBe('truncated');
    expect(codeOf(() => decodeInputLog(b(4, 0x81, 0x81, 0x81, 0x81, 0x01)))).toBe('varint_overflow');
    expect(codeOf(() => decodeInputLog(b(4, 0x81, 0x81, 0x81, 0x81)))).toBe('varint_overflow');
    expect(codeOf(() => decodeInputLog(b(4, 0x81, 0x00)))).toBe('non_canonical');
    expect(codeOf(() => decodeInputLog(b(4, 1, 4, 1)))).toBe('non_canonical');
    // 72,001 ticks: 0xC1 0xB2 0x04
    const over = config.run.maxTicks + 1;
    expect(codeOf(() => decodeInputLog(b(4, (over & 0x7f) | 0x80, ((over >> 7) & 0x7f) | 0x80, over >> 14)))).toBe('too_many_ticks');
    expect(codeOf(() => fromBase64('abc'))).toBe('bad_base64');
    expect(codeOf(() => fromBase64('ab c'))).toBe('bad_base64');
    expect(codeOf(() => fromBase64('a=bc'))).toBe('bad_base64');
    expect(codeOf(() => fromBase64('AB=='))).toBe('bad_base64'); // non-zero trailing bits
    expect(codeOf(() => fromBase64('AAB='))).toBe('bad_base64');
    expect(fromBase64('AA==')).toEqual(b(0));
    expect(fromBase64('')).toEqual(b());
  });
  it('random bytes decode or throw a GhostDecodeError, within bounds', () => {
    const rng = createRng('codec-random');
    const n = full ? 10000 : 1000;
    for (let i = 0; i < n; i++) {
      const bytes = Uint8Array.from({ length: Math.floor(rng() * 40) }, () => Math.floor(rng() * 256));
      const r = codeOf(() => {
        const out = decodeInputLog(bytes);
        expect(out.length).toBeLessThanOrEqual(config.run.maxTicks);
      });
      expect(typeof r).toBe('string');
      const s = Array.from({ length: Math.floor(rng() * 24) }, () => 'ABCxyz019+/=!'[Math.floor(rng() * 13)]).join('');
      codeOf(() => fromBase64(s));
    }
  });
});

function payload(levels: InputLevel[], over: Record<string, unknown> = {}) {
  return { v: 1, coreVersion: CORE_VERSION, seed: 'abcd', score: 10, ticks: levels.length, inputs: toBase64(encodeInputLog(levels)), ...over };
}

describe('validateGhostPayload', () => {
  const lv: InputLevel[] = [0, 0, 4, 4, -4];
  it('accepts a valid payload, drops extra fields in the canonical form', () => {
    const r = validateGhostPayload({ ...payload(lv), extra: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.levels).toEqual(lv);
      expect(canonicalGhostJson(r.payload)).toBe(JSON.stringify(payload(lv)));
    }
  });
  it('every validation code, first failure wins', () => {
    const cases: [unknown, GhostErrorCode, string?][] = [
      [null, 'not_object'], [[1], 'not_object'], ['x', 'not_object'],
      [{ ...payload(lv), v: '1' }, 'bad_field', 'v'], [{ ...payload(lv), inputs: undefined }, 'bad_field', 'inputs'],
      [payload(lv, { v: 2 }), 'bad_version'], [payload(lv, { coreVersion: CORE_VERSION + 1 }), 'version_mismatch'],
      [payload(lv, { seed: 'AB' }), 'bad_seed'], [payload(lv, { score: 1.5 }), 'bad_score'], [payload(lv, { score: -1 }), 'bad_score'],
      [payload(lv, { ticks: 0 }), 'bad_ticks'], [payload(lv, { ticks: config.run.maxTicks + 1 }), 'bad_ticks'],
      [payload(lv, { inputs: 'A'.repeat(43692) }), 'inputs_too_large'], [payload(lv, { inputs: '!!!!' }), 'bad_base64'],
      [payload(lv, { inputs: toBase64(b(9, 1)) }), 'bad_level'], [payload(lv, { ticks: 4 }), 'ticks_mismatch'],
    ];
    for (const [x, code, field] of cases) {
      const r = validateGhostPayload(x);
      expect(r).toMatchObject({ ok: false, code, ...(field ? { field } : {}) });
    }
  });
  it('the size cap is exact: 32,768 decoded bytes pass the size step, 32,769 fail', () => {
    const at = (n: number) => toBase64(new Uint8Array(n));
    expect(validateGhostPayload(payload(lv, { inputs: at(ghostLimits.maxInputBytes) }))).not.toMatchObject({ code: 'inputs_too_large' });
    expect(validateGhostPayload(payload(lv, { inputs: at(ghostLimits.maxInputBytes + 1) }))).toMatchObject({ code: 'inputs_too_large' });
  });
  it('isSeed and isGhostId', () => {
    expect(isSeed('abcd')).toBe(true);
    expect(isSeed('abc')).toBe(false);
    expect(isSeed('ABCD')).toBe(false);
    expect(isSeed('a'.repeat(13))).toBe(false);
    expect(isGhostId('k2x9AbQ7')).toBe(true);
    expect(isGhostId('k2x9AbQ')).toBe(false);
    expect(isGhostId('k2x9AbQ!')).toBe(false);
  });
});
