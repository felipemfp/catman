import type { InputLevel } from '../core/index.ts';

/** Chase-the-finger: level from pointer x vs cat x (both in world units). */
export function levelFromPointer(pointerXU: number, catX: number): InputLevel {
  const l = Math.max(-4, Math.min(4, Math.round(((pointerXU - catX) / 60) * 4)));
  return (l === 0 ? 0 : l) as InputLevel; // no −0
}

/** ←/A → −4, →/D → +4, both or neither → 0. */
export function levelFromKeys(left: boolean, right: boolean): InputLevel {
  if (left === right) return 0;
  return left ? -4 : 4;
}
