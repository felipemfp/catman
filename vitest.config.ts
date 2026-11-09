import { defineConfig } from 'vitest/config';

// Root config: core, sim, client and tools. It does not load the Cloudflare plugin
// (worker tests live in vitest.worker.config.ts), so the gate lane stays fast.
const full = process.env.CATMAN_FULL === '1';

export default defineConfig({
  test: {
    provide: { full },
    testTimeout: full ? 900_000 : 5_000,
    projects: [
      { extends: true, test: { name: 'core', include: ['src/core/**/*.test.ts'] } },
      { extends: true, test: { name: 'sim', include: ['src/sim/**/*.test.ts'] } },
      { extends: true, test: { name: 'client', include: ['src/client/**/*.test.ts'] } },
      { extends: true, test: { name: 'tools', include: [], benchmark: { include: ['tools/**/*.bench.ts'] } } },
    ],
  },
});
