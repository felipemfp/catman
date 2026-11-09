// Ghost codec, payload and every boundary validator. The worker imports only this file.
import type { InputLevel } from './types.ts';
import { CORE_VERSION } from './version.ts';
import { config } from './config.ts';

export { CORE_VERSION } from './version.ts';

export type GhostPayload = { v: 1; coreVersion: number; seed: string; score: number; ticks: number; inputs: string };
export type GhostErrorCode =
  | 'not_object' | 'bad_field' | 'bad_version' | 'version_mismatch' | 'bad_seed' | 'bad_score' | 'bad_ticks'
  | 'bad_base64' | 'inputs_too_large' | 'bad_level' | 'zero_run' | 'truncated' | 'varint_overflow'
  | 'non_canonical' | 'too_many_ticks' | 'ticks_mismatch';

export class GhostDecodeError extends Error {
  code: GhostErrorCode;
  constructor(code: GhostErrorCode) {
    super(code);
    this.code = code;
    this.name = 'GhostDecodeError';
  }
}

export const ghostLimits: { maxInputBytes: 32768; maxBodyBytes: 49152 } = { maxInputBytes: 32768, maxBodyBytes: 49152 };

const SEED_RE = /^[0-9a-z]{4,12}$/;
const ID_RE = /^[0-9A-Za-z]{8}$/;

export function isSeed(s: string): boolean {
  return typeof s === 'string' && SEED_RE.test(s);
}

export function isGhostId(s: string): boolean {
  return typeof s === 'string' && ID_RE.test(s);
}

// ---- input log codec: runs of [level + 4: u8][length: unsigned LEB128] ----

function pushVarint(out: number[], n: number): void {
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
}

function encodeRuns(runs: readonly { level: number; count: number }[]): Uint8Array {
  const out: number[] = [];
  for (const r of runs) {
    out.push(r.level + 4);
    pushVarint(out, r.count);
  }
  return Uint8Array.from(out);
}

export function encodeInputLog(levels: readonly InputLevel[]): Uint8Array {
  const runs: { level: number; count: number }[] = [];
  for (const l of levels) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.level === l) last.count += 1;
    else runs.push({ level: l, count: 1 });
  }
  return encodeRuns(runs);
}

export function createRecorder(): { push(level: InputLevel): void; ticks(): number; bytes(): Uint8Array } {
  const runs: { level: number; count: number }[] = [];
  let ticks = 0;
  return {
    push(level: InputLevel): void {
      const last = runs[runs.length - 1];
      if (last !== undefined && last.level === level) last.count += 1;
      else runs.push({ level, count: 1 });
      ticks += 1;
    },
    ticks: () => ticks,
    bytes: () => encodeRuns(runs),
  };
}

/** Single pass, never reads past the input. Throws GhostDecodeError. */
export function decodeInputLog(bytes: Uint8Array): InputLevel[] {
  const out: InputLevel[] = [];
  const max = config.run.maxTicks;
  let i = 0;
  let prev = -1;
  let sum = 0;
  while (i < bytes.length) {
    const lb = bytes[i++]!;
    if (lb > 8) throw new GhostDecodeError('bad_level');
    if (lb === prev) throw new GhostDecodeError('non_canonical');
    let len = 0;
    let shift = 1;
    let n = 0;
    for (;;) {
      if (i >= bytes.length) throw new GhostDecodeError('truncated');
      if (n === 4) throw new GhostDecodeError('varint_overflow');
      const b = bytes[i++]!;
      n += 1;
      len += (b & 0x7f) * shift;
      shift *= 128;
      if ((b & 0x80) === 0) {
        if (n > 1 && b === 0) throw new GhostDecodeError('non_canonical');
        break;
      }
    }
    if (len === 0) throw new GhostDecodeError('zero_run');
    sum += len;
    if (sum > max) throw new GhostDecodeError('too_many_ticks');
    const level = (lb - 4) as InputLevel;
    for (let j = 0; j < len; j++) out.push(level);
    prev = lb;
  }
  return out;
}

// ---- strict RFC 4648 base64 (padding required) ----

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function alphaIndex(c: number): number {
  if (c >= 65 && c <= 90) return c - 65;
  if (c >= 97 && c <= 122) return c - 71;
  if (c >= 48 && c <= 57) return c + 4;
  if (c === 43) return 62;
  if (c === 47) return 63;
  return -1;
}

export function toBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += ALPHA[(n >>> 18) & 63]! + ALPHA[(n >>> 12) & 63]! + ALPHA[(n >>> 6) & 63]! + ALPHA[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += ALPHA[(n >>> 18) & 63]! + ALPHA[(n >>> 12) & 63]! + '==';
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += ALPHA[(n >>> 18) & 63]! + ALPHA[(n >>> 12) & 63]! + ALPHA[(n >>> 6) & 63]! + '=';
  }
  return out;
}

export function fromBase64(s: string): Uint8Array {
  if (s.length % 4 !== 0) throw new GhostDecodeError('bad_base64');
  let pad = 0;
  if (s.length > 0 && s.charCodeAt(s.length - 1) === 61) pad = s.length > 1 && s.charCodeAt(s.length - 2) === 61 ? 2 : 1;
  const out = new Uint8Array((s.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const last = i + 4 === s.length;
    const v: number[] = [0, 0, 0, 0];
    for (let j = 0; j < 4; j++) {
      const c = s.charCodeAt(i + j);
      if (c === 61 && last && j >= 4 - pad) { v[j] = 0; continue; }
      const x = alphaIndex(c);
      if (x < 0) throw new GhostDecodeError('bad_base64');
      v[j] = x;
    }
    const n = (v[0]! << 18) | (v[1]! << 12) | (v[2]! << 6) | v[3]!;
    if (last && pad === 2) {
      if ((n & 0xffff) !== 0) throw new GhostDecodeError('bad_base64');
      out[o++] = (n >>> 16) & 0xff;
    } else if (last && pad === 1) {
      if ((n & 0xff) !== 0) throw new GhostDecodeError('bad_base64');
      out[o++] = (n >>> 16) & 0xff;
      out[o++] = (n >>> 8) & 0xff;
    } else {
      out[o++] = (n >>> 16) & 0xff;
      out[o++] = (n >>> 8) & 0xff;
      out[o++] = n & 0xff;
    }
  }
  return out;
}

// ---- payload validation ----

function isPlainObject(x: unknown): x is Record<string, unknown> {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const p: unknown = Object.getPrototypeOf(x);
  return p === Object.prototype || p === null;
}

const FIELDS: readonly [keyof GhostPayload, 'number' | 'string'][] = [
  ['v', 'number'], ['coreVersion', 'number'], ['seed', 'string'], ['score', 'number'], ['ticks', 'number'], ['inputs', 'string'],
];

export function validateGhostPayload(x: unknown):
  | { ok: true; payload: GhostPayload; levels: InputLevel[] }
  | { ok: false; code: GhostErrorCode; field?: string } {
  if (!isPlainObject(x)) return { ok: false, code: 'not_object' };
  for (const [f, t] of FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(x, f) || typeof x[f] !== t) return { ok: false, code: 'bad_field', field: f };
  }
  const v = x.v as number;
  const coreVersion = x.coreVersion as number;
  const seed = x.seed as string;
  const score = x.score as number;
  const ticks = x.ticks as number;
  const inputs = x.inputs as string;
  if (v !== 1) return { ok: false, code: 'bad_version' };
  if (coreVersion !== CORE_VERSION) return { ok: false, code: 'version_mismatch' };
  if (!isSeed(seed)) return { ok: false, code: 'bad_seed' };
  if (!Number.isInteger(score) || score < 0 || score > 1e9) return { ok: false, code: 'bad_score' };
  if (!Number.isInteger(ticks) || ticks < 1 || ticks > config.run.maxTicks) return { ok: false, code: 'bad_ticks' };
  const len = inputs.length;
  let p = 0;
  if (len % 4 === 0 && len > 0) {
    if (inputs.charCodeAt(len - 1) === 61) p += 1;
    if (inputs.charCodeAt(len - 2) === 61) p += 1;
  }
  const decodedLen = Math.floor(len / 4) * 3 - p;
  if (decodedLen > ghostLimits.maxInputBytes) return { ok: false, code: 'inputs_too_large' };
  let levels: InputLevel[];
  try {
    levels = decodeInputLog(fromBase64(inputs));
  } catch (e) {
    if (e instanceof GhostDecodeError) return { ok: false, code: e.code };
    throw e;
  }
  if (levels.length !== ticks) return { ok: false, code: 'ticks_mismatch' };
  return { ok: true, payload: { v: 1, coreVersion, seed, score, ticks, inputs }, levels };
}

/** Keys in GhostPayload order, no whitespace. */
export function canonicalGhostJson(p: GhostPayload): string {
  return JSON.stringify({ v: p.v, coreVersion: p.coreVersion, seed: p.seed, score: p.score, ticks: p.ticks, inputs: p.inputs });
}
