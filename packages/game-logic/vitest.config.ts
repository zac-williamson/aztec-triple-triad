import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
      // The 99% bar is binding for this package (docs/plan/LANE_3_GAME_AI.md);
      // branches sit at the pre-bot baseline to leave headroom in the older files.
      thresholds: {
        statements: 99,
        branches: 95,
        functions: 100,
        lines: 99,
      },
    },
  },
});
