// Field order here is the hashState order (see hash.ts).
export type InputLevel = -4 | -3 | -2 | -1 | 0 | 1 | 2 | 3 | 4;
export type EndCause = 'rats' | 'boss' | 'timeout';
export type WeaponId = 'pencil' | 'laser' | 'yarn' | 'fishbone';
export type StatKey = 'damageMult' | 'fireRateMult' | 'rangeMult' | 'pierceAdd' | 'projectilesAdd' | 'moveSpeedMult';
export type Mods = Record<StatKey, number>;
export type StatGate = { kind: 'stat'; buff: { stat: StatKey; value: number }; debuff: { stat: StatKey; value: number } };
export type WeaponGate = { kind: 'weapon'; weapon: WeaponId; fallback: StatGate };
export type Gate = StatGate | WeaponGate;
export type Cat = { x: number; vx: number; hp: number; invulnTicks: number; weapon: WeaponId; mods: Mods; cooldown: number };
export type Rat = { laneId: number; segmentK: number; x: number; baseY: number; y: number; hp: number };
export type GatePair = { laneId: number; baseY: number; y: number; left: Gate; right: Gate; resolved: boolean };
export type Projectile = {
  id: number; weapon: Exclude<WeaponId, 'laser'>; x: number; y: number; vx: number; vy: number;
  w: number; h: number; speedU: number; damage: number; rangeU: number; travelled: number; hitsLeft: number; hitIds: number[];
};
/** half: −1 roams the whole lane; 0 / 1 keeps a twin in the left / right half. */
export type Boss = { index: number; x: number; y: number; hp: number; maxHp: number; missTicks: number; half: number };
/** Bit flags of a boss fight's variant (SPEC-game-core § Boss variants); 0 is a plain boss. */
export type BossVariant = number;
/** The fight in progress: which boss, its variant, the next wave ticks, and the total HP it started with. */
export type Fight = { index: number; variant: BossVariant; maxHp: number; nextHordeTick: number; nextFrenzyTick: number; waves: number };
export type Horde = { segmentK: number; alive: number; spawnTick: number };
export type Tuna = { id: number; x: number; baseY: number; y: number };
export type RunState = {
  seed: string; tick: number; distanceU: number; freezeTicks: number; over: EndCause | null;
  cat: Cat; rats: Rat[]; gates: GatePair[]; projectiles: Projectile[]; boss: Boss | null; twin: Boss | null; fight: Fight | null; hordes: Horde[];
  nextSegmentK: number; nextProjectileId: number; bossesSpawned: number; bossesKilled: number;
  ratsKilled: number; score: number; warnedForBoss: number; // index of the last boss warned; starts at −1
  tunas: Tuna[]; bonusScore: number; telegraphedBoss: number; nextWaveId: number;
};
export type SegmentKind = 'empty' | 'gate' | 'column' | 'swarm' | 'wall' | 'boss' | 'tuna' | 'guard';
export type SegmentContent = {
  k: number; kind: SegmentKind; corridorX: number;
  rats: { laneId: number; x: number; dy: number; hp: number }[]; gate: GatePair | null; bossX: number | null;
  tuna: { x: number; dy: number } | null;
};
export type DeepReadonly<T> = { readonly [K in keyof T]: DeepReadonly<T[K]> };

export type CoreEvent =
  | { t: 'ratKilled'; laneId: number; segmentK: number; x: number; y: number }
  | { t: 'damage'; x: number; y: number; amount: number }
  | { t: 'catHit'; hp: number }
  | { t: 'gateTaken'; side: 'left' | 'right'; gate: Gate; applied: StatGate | WeaponId }
  | { t: 'gateMissed'; laneId: number }
  | { t: 'weaponChanged'; weapon: WeaponId }
  | { t: 'hordeCleared'; segmentK: number; ticksAlive: number }
  | { t: 'hordeEscaped'; segmentK: number }
  | { t: 'bossWarning'; haveDps: number; needDps: number; onPace: boolean; etaTicks: number }
  | { t: 'bossIncoming'; index: number; variant: BossVariant }
  | { t: 'bossSpawned'; index: number; hp: number; variant: BossVariant }
  | { t: 'bossKilled'; index: number }
  | { t: 'tunaEaten'; hp: number; healed: boolean }
  | { t: 'tunaMissed' }
  | { t: 'ended'; cause: EndCause; score: number; tick: number };

/** Declaration order of StatKey, used for draws and hashing (never iterate object keys). */
export const STAT_KEYS: readonly StatKey[] = ['damageMult', 'fireRateMult', 'rangeMult', 'pierceAdd', 'projectilesAdd', 'moveSpeedMult'];
/** Declaration order of WeaponId, used for draws. */
export const WEAPON_IDS: readonly WeaponId[] = ['pencil', 'laser', 'yarn', 'fishbone'];
