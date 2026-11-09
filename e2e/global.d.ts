import type { CatmanHooks } from '../src/client/dev-hooks.ts';

declare global {
  interface Window { __catman: CatmanHooks }
}
export {};
