// The only import path for src/sim and src/client.
export type * from './types.ts';
export { STAT_KEYS, WEAPON_IDS } from './types.ts';
export { CORE_VERSION } from './version.ts';
export { config, type CoreConfig } from './config.ts';
export { type Run, createRun, step, view, hashState } from './run.ts';
export { setFrozenViews } from './view.ts';
export { scrollFor, bossHpFor, simulateBossFight, variantHpMult, HORDE_K, FRENZY_K } from './step.ts';
export { validateGate, effDamage, effFireRate, effRange, effSpread, effPierce, effProjectiles, onDpsAxis, isAdditive, catTopY } from './stats.ts';
export { generateSegment, bossMarkK, bossVariant, BOSS_HORDE, BOSS_FRENZY, BOSS_TWINS } from './lane.ts';
export { createRng } from './rng.ts';
export { levelToward } from './cat.ts';
export {
  isSeed, isGhostId, createRecorder, encodeInputLog, decodeInputLog, toBase64, fromBase64, GhostDecodeError,
  validateGhostPayload, canonicalGhostJson, ghostLimits, type GhostPayload, type GhostErrorCode,
} from './ghost.ts';
