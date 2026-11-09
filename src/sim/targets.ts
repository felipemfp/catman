// The frozen rubric for any balance pass. Changing these is Ask first (SPEC.md Boundaries).
// Casual profile (2026-11-09, Felipe: "I want to have fun"): rats die, every weapon beats the boss, runs last.
export const TARGETS = {
  dominanceMargin: 0.05,
  medianDistanceBand: [0.75, 1.33] as const,
  /** Most first bosses die, but not all. */
  boss0KillBand: [0.8, 0.98] as const,
  /** Holding the build's own weapon at boss 0 (checked when n ≥ holdingMinN): no weapon is a trap. */
  boss0HoldingMin: 0.75,
  holdingMinN: 30,
  /** Of runs that reach boss 1, each weapon build kills it at least this often. */
  boss1KillMin: 0.5,
  /**
   * Rats are there to be shot, not only dodged: share of all rats that appear and die.
   * (Was hordeClearMin 0.6: walls are dodge-through-the-corridor by design and almost never fully clear,
   * so "whole horde died" measured the lane design, not whether rats can be killed.)
   */
  ratKillMin: 0.6,
  /** A run lasts: median at least this far for each weapon build. */
  minMedianDistanceM: 1500,
  /**
   * Bosses are a threat (2026-11-09, Felipe: "I hardly die to a boss"): share of weapon-build deaths that happen in a
   * boss fight; each variant causes its share of those (no decorative variant) and is still won often (no wall).
   */
  bossDeathShareMin: 0.35,
  variantDeathShareMin: 0.15,
  variantWinMin: 0.5,
  maxSweepSeconds: 300,
};
