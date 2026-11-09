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
  rat: {
    sizeU: 28, spawnYU: -14, baseHp: 12, hpRampPerM: 0.003,
    /** Past startM, rats drift toward the cat by frac × scroll per tick (frac ramps per m, capped); x locks within lockU of the cat line. */
    homing: { startM: 500, fracPerM: 0.0004, maxFrac: 0.7, lockU: 250, chargePerM: 0.0003, maxCharge: 0.5 },
  },
  /** Heal pickup: on tuna marks, with `chance`, off the corridor inside a hexagon of `guards` rats. */
  tuna: { everyM: 200, chance: 0.8, sizeU: 32, guards: 6, guardRadiusU: 50, fullHpScore: 50, xTries: 8 },
  gates: {
    everyM: 150,
    heightU: 40,
    /** Each half is a box this wide, centred in its half; the cat takes it only if its body overlaps the box. */
    widthU: 120,
    spawnYU: -20,
    dyU: 75,
    weaponChance: 0.25,
    /** Uneven pairs: ratsPerValue × value gap (capped) rats in rows of perRow, right in front of the better box (firstRowU below the gate, then every rowSpacingU). They neither home nor charge. */
    guard: { weaponValue: { pencil: 1, laser: 3, yarn: 2, fishbone: 2 }, statValue: 1, ratsPerValue: 6, cap: 12, perRow: 6, firstRowU: 34, rowSpacingU: 50, slotSpacingU: 34 },
    /** Chosen by the gate mark's distance; first tier whose fromM ≤ d, scanning from the end. */
    tiers: [
      { fromM: 0, buffMult: 1.3, buffAdd: 1, debuffMult: 0.9 },
      { fromM: 1000, buffMult: 1.4, buffAdd: 1, debuffMult: 0.85 },
      { fromM: 3000, buffMult: 1.5, buffAdd: 2, debuffMult: 0.8 },
    ],
  },
  boss: { clearM: 150, warningM: 30,
    /**
     * Seeded schedule (SPEC-game-core § Boss schedule): boss 0 lands in firstM; each next gap is drawn in a range that
     * slides from gapNearM to gapFarM as the previous mark goes from 0 to farM. All in whole segments.
     */
    schedule: { firstM: [450, 550] as const, gapNearM: [450, 700] as const, gapFarM: [350, 550] as const, farM: 3000 },
    /** The variant icon shows this far before the mark. */
    telegraphM: 150,
    /** Boss i ≥ 1 rolls a variant with chance min(chanceMax, chanceStart + chanceStep·(i − 1)); from comboFrom, a second one with comboChance. */
    variants: { chanceStart: 0.3, chanceStep: 0.2, chanceMax: 0.9, comboFrom: 3, comboChance: 0.4,
      /** HP multiplier per variant (twins: each of the two). */
      hpMult: { horde: 0.9, frenzy: 0.85, twins: 0.7 } },
    /**
     * Fight waves. Interval goes from everyTicks (full HP) to minEveryTicks (no HP left).
     * horde: a row of wall slots with a gap. frenzy: a few fast rats that home on the cat.
     */
    horde: { firstTicks: 40, everyTicks: 100, minEveryTicks: 50, gapSlots: 4, speedU: 2.8, homeFrac: 0.25 },
    frenzy: { firstTicks: 60, everyTicks: 120, minEveryTicks: 60, rats: 5, speedU: 5, homeFrac: 0.8 },
    sizeU: 120, speedUPerTick: 1.2, baseHp: 500, hpGrowth: 1.17, killFreezeTicks: 12, xMarginU: 20, pierceBonus: 0.18,
    /** Sideways tracking toward the cat, U per tick. */
    trackUPerTick: 0.8,
    /** Ticks without a hit before the boss speeds up; then +rageRampPerTick × base per tick, up to rageMax × base. */
    missGraceTicks: 45, rageRampPerTick: 0.02, rageMax: 3 },
  weapons: {
    pencil: { kind: 'projectile' as const, damage: 16, rate: 4, projectiles: 1, pierce: 1, bounces: 0, rangeU: 520, speedU: 14, spreadVx: 0.6, w: 6, h: 16 },
    laser: { kind: 'beam' as const, dps: 80, beams: 1, beamWidthU: 14, beamSpacingU: 22, rangeU: 700, pierce: 0 },
    yarn: { kind: 'projectile' as const, damage: 27, rate: 4, projectiles: 1, pierce: 0, bounces: 3, rangeU: 700, speedU: 10, spreadVx: 0.8, w: 12, h: 12, retargetRadiusU: 250 },
    fishbone: { kind: 'projectile' as const, damage: 21, rate: 3.5, projectiles: 5, pierce: 0, bounces: 0, rangeU: 500, speedU: 12, spreadVx: 0.5, w: 8, h: 12 },
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
