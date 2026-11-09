// Rows → runs.csv, summary.json, dominance.json, check.txt. Deterministic: sorted input, fixed key order.
import { BOSS_SLOTS, type RunRow } from './run.ts';
import { BUILDS, type Build } from './bots.ts';
import { TARGETS } from './targets.ts';

export type Rate = { rate: number | null; n: number };
export type BuildSummary = {
  build: Build; runs: number;
  distanceM: { median: number; p10: number; p90: number };
  hordeClearRate: Rate;
  bossKillRate: Rate[]; bossKillRateHolding: Rate[];
  cause: Record<string, number>;
  gatePicks: Record<string, number>;
};
export type Summary = { builds: BuildSummary[] };
export type Dominance = { a: Build; b: Build; hordeClearDelta: number; boss0Delta: number };

export function sortRows(rows: RunRow[]): RunRow[] {
  const order = (b: Build) => BUILDS.indexOf(b);
  return rows.slice().sort((x, y) => order(x.build) - order(y.build) || x.seedIndex - y.seedIndex);
}

const CSV_COLS = ['build', 'seedIndex', 'seed', 'ticks', 'distanceM', 'score', 'cause', 'bossesKilled', 'reachedBoss0', 'killedBoss0', 'hordesCleared', 'hordesEscaped', 'gatesTaken', 'finalWeapon'] as const;

export function toCsv(rows: RunRow[]): string {
  const lines = [CSV_COLS.join(',')];
  for (const r of sortRows(rows)) lines.push(CSV_COLS.map((c) => String(r[c])).join(','));
  return lines.join('\n') + '\n';
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i]!;
}

function rate(num: number, den: number): Rate {
  return { rate: den === 0 ? null : num / den, n: den };
}

function sortedRecord(m: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of [...m.keys()].sort()) out[k] = m.get(k)!;
  return out;
}

export function summarize(rows: RunRow[]): Summary {
  const builds: BuildSummary[] = [];
  for (const build of BUILDS) {
    const rs = sortRows(rows).filter((r) => r.build === build);
    if (rs.length === 0) continue;
    const d = rs.map((r) => r.distanceM).sort((a, b) => a - b);
    const cleared = rs.reduce((s, r) => s + r.hordesCleared, 0);
    const escaped = rs.reduce((s, r) => s + r.hordesEscaped, 0);
    const kill: Rate[] = [];
    const killHold: Rate[] = [];
    for (let k = 0; k < BOSS_SLOTS; k++) {
      const reached = rs.filter((r) => r.reached[k]);
      kill.push(rate(reached.filter((r) => r.killed[k]).length, reached.length));
      const held = reached.filter((r) => r.holding[k]);
      killHold.push(rate(held.filter((r) => r.killed[k]).length, held.length));
    }
    const cause = new Map<string, number>();
    const picks = new Map<string, number>();
    for (const r of rs) {
      cause.set(r.cause, (cause.get(r.cause) ?? 0) + 1);
      for (const p of r.picks) picks.set(p, (picks.get(p) ?? 0) + 1);
    }
    builds.push({
      build, runs: rs.length,
      distanceM: { median: quantile(d, 0.5), p10: quantile(d, 0.1), p90: quantile(d, 0.9) },
      hordeClearRate: rate(cleared, cleared + escaped),
      bossKillRate: kill, bossKillRateHolding: killHold,
      cause: sortedRecord(cause), gatePicks: sortedRecord(picks),
    });
  }
  return { builds };
}

/** A dominates B iff it is ahead by ≥ margin on both horde clear rate and boss-0 kill rate. `random` never counts. */
export function dominates(a: BuildSummary, b: BuildSummary, margin = TARGETS.dominanceMargin): Dominance | null {
  if (a.build === 'random' || b.build === 'random' || a.build === b.build) return null;
  const ha = a.hordeClearRate.rate, hb = b.hordeClearRate.rate;
  const ka = a.bossKillRate[0]?.rate ?? null, kb = b.bossKillRate[0]?.rate ?? null;
  if (ha === null || hb === null || ka === null || kb === null) return null;
  // compare in integer-ish space so 0.05 exactly counts and 0.049 doesn't, despite float noise
  const ok = (x: number) => Math.round(x * 1e9) >= Math.round(margin * 1e9);
  if (ok(ha - hb) && ok(ka - kb)) return { a: a.build, b: b.build, hordeClearDelta: ha - hb, boss0Delta: ka - kb };
  return null;
}

export function dominance(s: Summary): Dominance[] {
  const out: Dominance[] = [];
  for (const a of s.builds) for (const b of s.builds) {
    const d = dominates(a, b);
    if (d) out.push(d);
  }
  return out;
}

export type CheckLine = { target: string; value: string; pass: boolean };

export function check(s: Summary, elapsedS: number): CheckLine[] {
  const lines: CheckLine[] = [];
  const dom = dominance(s);
  lines.push({ target: 'dominance.json is empty', value: dom.map((d) => `${d.a}>${d.b}`).join(' ') || 'empty', pass: dom.length === 0 });
  const weapons = s.builds.filter((b) => b.build !== 'random');
  const meds = weapons.map((b) => b.distanceM.median).sort((a, b) => a - b);
  const ref = meds.length === 0 ? 0 : meds.length % 2 === 1 ? meds[(meds.length - 1) / 2]! : (meds[meds.length / 2 - 1]! + meds[meds.length / 2]!) / 2;
  const [lo, hi] = TARGETS.medianDistanceBand;
  for (const b of weapons) {
    const r = ref === 0 ? 0 : b.distanceM.median / ref;
    lines.push({ target: `${b.build} median distance within [${lo}, ${hi}]× of weapon medians' median (${ref})`, value: r.toFixed(3), pass: r >= lo && r <= hi });
  }
  const [klo, khi] = TARGETS.boss0KillBand;
  for (const b of weapons) {
    const k = b.bossKillRate[0]?.rate ?? null;
    lines.push({ target: `${b.build} bossKillRate[0] in [${klo}, ${khi}]`, value: k === null ? 'n/a' : k.toFixed(3), pass: k !== null && k >= klo && k <= khi });
  }
  lines.push({ target: `sweep elapsed ≤ ${TARGETS.maxSweepSeconds} s`, value: elapsedS.toFixed(1), pass: elapsedS <= TARGETS.maxSweepSeconds });
  return lines;
}
