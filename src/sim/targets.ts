// The frozen rubric for any balance pass. Changing these is Ask first (SPEC.md Boundaries).
export const TARGETS = {
  dominanceMargin: 0.05,
  medianDistanceBand: [0.75, 1.33] as const,
  boss0KillBand: [0.6, 0.9] as const,
  maxSweepSeconds: 300,
};
