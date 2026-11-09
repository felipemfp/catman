// Every tunable, one frozen object. Any change bumps CORE_VERSION (version.ts) and regenerates fixtures.

function deepFreeze<T>(o: T): T {
  if (typeof o === 'object' && o !== null && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

export const config = deepFreeze({
  world: { widthU: 540, heightU: 960, catLineY: 880 },
  scroll: { baseUPerTick: 2.5, maxUPerTick: 5, rampPerM: 0.001 },
  lane: {
    segmentM: 25,
    bandU: 150,
    warmupM: 50,
    anchorEverySegments: 10,
    /** Listed order is the weighted-choice walk order. */
    formationWeights: [
      { kind: 'column', weight: 0.5 },
      { kind: 'swarm', weight: 0.4 },
      { kind: 'wall', weight: 0.1 },
    ] as { kind: 'column' | 'swarm' | 'wall'; weight: number }[],
    emptyFloor: 0.1,
    emptyStart: 0.4,
    emptyFallM: 2000,
    columnBase: 3,
    columnEveryM: 500,
    columnCap: 4,
    columnSpacingU: 34,
    columnTries: 8,
    swarmBase: 4,
    swarmEveryM: 300,
    swarmCap: 10,
    swarmTries: 4,
    wallSlotSpacingU: 34,
    wallSlotOriginU: 17,
    wallSlots: 15,
    corridorMarginU: 16,
    corridorEdgeMarginU: 20,
  },
  cat: { widthU: 40, heightU: 48, maxSpeedUPerTick: 9, accelUPerTick2: 1.5, hp: 3, invulnTicks: 60, hitFreezeTicks: 6 },
  rat: { sizeU: 28, spawnYU: -14, baseHp: 12, hpRampPerM: 0.0003 },
  gates: {
    everyM: 150,
    heightU: 40,
    spawnYU: -20,
    dyU: 75,
    weaponChance: 0.25,
    /** Chosen by the gate mark's distance; first tier whose fromM ≤ d, scanning from the end. */
    tiers: [
      { fromM: 0, buffMult: 1.3, buffAdd: 1, debuffMult: 0.9 },
      { fromM: 1000, buffMult: 1.4, buffAdd: 1, debuffMult: 0.85 },
      { fromM: 3000, buffMult: 1.5, buffAdd: 2, debuffMult: 0.8 },
    ],
  },
  boss: { everyM: 500, clearM: 150, warningM: 30, sizeU: 120, speedUPerTick: 1.2, baseHp: 650, hpGrowth: 1.1, killFreezeTicks: 12, xMarginU: 20 },
  weapons: {
    pencil: { kind: 'projectile' as const, damage: 16, rate: 5, projectiles: 1, pierce: 2, bounces: 0, rangeU: 520, speedU: 14, spreadVx: 0.6, w: 6, h: 16 },
    laser: { kind: 'beam' as const, dps: 70, beams: 1, beamWidthU: 14, beamSpacingU: 22, rangeU: 700, pierce: 0 },
    yarn: { kind: 'projectile' as const, damage: 20, rate: 3.5, projectiles: 1, pierce: 0, bounces: 3, rangeU: 700, speedU: 10, spreadVx: 0.8, w: 12, h: 12, retargetRadiusU: 250 },
    fishbone: { kind: 'projectile' as const, damage: 14, rate: 3.5, projectiles: 5, pierce: 0, bounces: 0, rangeU: 420, speedU: 12, spreadVx: 0.9, w: 8, h: 12 },
  },
  clamps: {
    multMin: 0.25,
    multMax: 20,
    moveSpeedMin: 1,
    moveSpeedMax: 3,
    pierceAddMin: 0,
    pierceAddMax: 8,
    projectilesAddMin: 0,
    projectilesAddMax: 6,
    effProjectilesMin: 1,
    effProjectilesMax: 9,
  },
  run: { maxTicks: 72000 },
  /** Projectile cleanup: centre x outside [−marginU, widthU + marginU]. */
  cleanup: { xMarginU: 20 },
  /** Beam damage events fire on ticks divisible by this. */
  beamEventEveryTicks: 10,
});

export type CoreConfig = typeof config;
