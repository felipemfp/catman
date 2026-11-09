// Rows → runs.csv, summary.json, dominance.json, check.txt. Deterministic: sorted input, fixed key order.
import { BOSS_SLOTS, type RunRow } from './run.ts';
import { BUILDS, type Build } from './bots.ts';
import { TARGETS } from './targets.ts';
import { BOSS_FRENZY, BOSS_HORDE, BOSS_TWINS } from '../core/index.ts';

export type Rate = { rate: number | null; n: number };
export type BuildSummary = {
  build: Build; runs: number;
  distanceM: { median: number; p10: number; p90: number };
  hordeClearRate: Rate;
  /** Rats killed / rats that appeared, pooled over runs. */
  ratKillRate: Rate;
  bossKillRate: Rate[]; bossKillRateHolding: Rate[];
  cause: Record<string, number>;
  gatePicks: Record<string, number>;
};
/** Boss-fight outcomes pooled over the weapon builds (not random). A combo fight counts toward each of its variants. */
export type FightSummary = {
  deaths: number; fightDeaths: number; bossDeathShare: Rate;
  variants: { name: VariantName; reached: number; won: number; winRate: Rate; deaths: number; deathShare: Rate }[];
};
export type VariantName = 'plain' | 'horde' | 'frenzy' | 'twins';
export type Summary = { builds: BuildSummary[]; fights: FightSummary };

const VARIANTS: { name: VariantName; has: (f: number) => boolean }[] = [
  { name: 'plain', has: (f) => f === 0 },
  { name: 'horde', has: (f) => (f & BOSS_HORDE) !== 0 },
  { name: 'frenzy', has: (f) => (f & BOSS_FRENZY) !== 0 },
  { name: 'twins', has: (f) => (f & BOSS_TWINS) !== 0 },
];

function summarizeFights(rows: RunRow[]): FightSummary {
  const rs = rows.filter((r) => r.build !== 'random');
  const dead = rs.filter((r) => r.cause === 'rats' || r.cause === 'boss');
  const inFight = dead.filter((r) => r.deathFight >= 0);
  return {
    deaths: dead.length, fightDeaths: inFight.length, bossDeathShare: rate(inFight.length, dead.length),
    variants: VARIANTS.map(({ name, has }) => {
      let reached = 0;
      let won = 0;
      for (const r of rs) for (const f of r.fights) if (has(f.variant)) { reached++; if (f.won) won++; }
      const deaths = inFight.filter((r) => has(r.deathFight)).length;
      return { name, reached, won, winRate: rate(won, reached), deaths, deathShare: rate(deaths, inFight.length) };
    }),
  };
}
export type Dominance = { a: Build; b: Build; hordeClearDelta: number; boss0Delta: number };

export function sortRows(rows: RunRow[]): RunRow[] {
  const order = (b: Build) => BUILDS.indexOf(b);
  return rows.slice().sort((x, y) => order(x.build) - order(y.build) || x.seedIndex - y.seedIndex);
}

const CSV_COLS = ['build', 'seedIndex', 'seed', 'ticks', 'distanceM', 'score', 'cause', 'bossesKilled', 'reachedBoss0', 'killedBoss0', 'hordesCleared', 'hordesEscaped', 'gatesTaken', 'finalWeapon', 'ratsSeen', 'ratsKilled', 'tunaHeals', 'deathFight'] as const;

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
      ratKillRate: rate(rs.reduce((s, r) => s + r.ratsKilled, 0), rs.reduce((s, r) => s + r.ratsSeen, 0)),
      bossKillRate: kill, bossKillRateHolding: killHold,
      cause: sortedRecord(cause), gatePicks: sortedRecord(picks),
    });
  }
  return { builds, fights: summarizeFights(rows) };
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
  const fmt = (x: number | null) => (x === null ? 'n/a' : x.toFixed(3));
  for (const b of weapons) {
    const h = b.bossKillRateHolding[0];
    const hn = h?.n ?? 0;
    const hr = h?.rate ?? null;
    if (hn >= TARGETS.holdingMinN) {
      lines.push({ target: `${b.build} bossKillRateHolding[0] ≥ ${TARGETS.boss0HoldingMin} (n=${hn})`, value: fmt(hr), pass: hr !== null && hr >= TARGETS.boss0HoldingMin });
    }
    const k1 = b.bossKillRate[1]?.rate ?? null;
    lines.push({ target: `${b.build} bossKillRate[1] ≥ ${TARGETS.boss1KillMin}`, value: fmt(k1), pass: k1 !== null && k1 >= TARGETS.boss1KillMin });
    const rk = b.ratKillRate.rate;
    lines.push({ target: `${b.build} ratKillRate ≥ ${TARGETS.ratKillMin}`, value: fmt(rk), pass: rk !== null && rk >= TARGETS.ratKillMin });
    lines.push({ target: `${b.build} median distance ≥ ${TARGETS.minMedianDistanceM} m`, value: String(b.distanceM.median), pass: b.distanceM.median >= TARGETS.minMedianDistanceM });
  }
  const F = s.fights;
  lines.push({ target: `boss fights cause ≥ ${TARGETS.bossDeathShareMin} of deaths`, value: fmt(F.bossDeathShare.rate), pass: (F.bossDeathShare.rate ?? 0) >= TARGETS.bossDeathShareMin });
  for (const v of F.variants) {
    if (v.name === 'plain') continue;
    lines.push({ target: `${v.name} fights cause ≥ ${TARGETS.variantDeathShareMin} of boss deaths`, value: fmt(v.deathShare.rate), pass: (v.deathShare.rate ?? 0) >= TARGETS.variantDeathShareMin });
    lines.push({ target: `${v.name} fights won ≥ ${TARGETS.variantWinMin} (n=${v.reached})`, value: fmt(v.winRate.rate), pass: (v.winRate.rate ?? 0) >= TARGETS.variantWinMin });
  }
  lines.push({ target: `sweep elapsed ≤ ${TARGETS.maxSweepSeconds} s`, value: elapsedS.toFixed(1), pass: elapsedS <= TARGETS.maxSweepSeconds });
  return lines;
}
