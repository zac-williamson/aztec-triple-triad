import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 600_000,
    hookTimeout: 600_000,
    // Only run unit/integration tests by default.
    // E2E tests (e2e-*) require a running Aztec sandbox — run them explicitly:
    //   npx vitest run tests/e2e-game-flow.test.ts
    include: ['tests/proof-utils.test.ts', 'tests/state.test.ts', 'tests/game-session.test.ts', 'tests/real-proof.test.ts'],
  },
});
