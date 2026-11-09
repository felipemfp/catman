// View projection, client only: core never sees it, so ghosts, replays and hashes don't depend on the view.
// 'flat' is the original top-down view. 'tilt' is a 2.5D behind-the-cat view: depth is the distance ahead of the cat
// line, scale = zNear / (zNear + depth), and screen y runs toward a horizon above the screen. The cat row stays at
// scale 1, so pointer x maps 1:1 where the cat is.
import { config } from '../core/index.ts';

export type View = 'flat' | 'tilt';
export type Projected = { x: number; y: number; s: number };
export type Camera = { view: View; project(x: number, y: number): Projected };

const W = config.world.widthU;
const CAT_Y = config.world.catLineY;
/** Bigger = gentler tilt. */
const Z_NEAR = 1300;
/** Where world y = 0 lands on screen; the horizon follows from it. */
const TOP_SCREEN_Y = 70;
const S_TOP = Z_NEAR / (Z_NEAR + CAT_Y);
const HORIZON_Y = (TOP_SCREEN_Y - CAT_Y * S_TOP) / (1 - S_TOP);

export const VIEW_KEY = 'catman.view';

export function createCamera(view: View): Camera {
  if (view === 'flat') return { view, project: (x, y) => ({ x, y, s: 1 }) };
  return {
    view,
    project(x, y) {
      if (y === CAT_Y) return { x, y, s: 1 };
      // never let depth reach −zNear (things far behind the cat): clamp just above it
      const depth = Math.max(-Z_NEAR * 0.9, CAT_Y - y);
      const s = Z_NEAR / (Z_NEAR + depth);
      return { x: W / 2 + (x - W / 2) * s, y: HORIZON_Y + (CAT_Y - HORIZON_Y) * s, s };
    },
  };
}

/** ?view= wins, then the stored choice, else flat. */
export function parseView(search: string, stored: string | null): View {
  const q = new URLSearchParams(search).get('view');
  if (q === 'flat' || q === 'tilt') return q;
  if (stored === 'flat' || stored === 'tilt') return stored;
  return 'flat';
}
