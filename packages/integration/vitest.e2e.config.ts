import { defineConfig } from 'vitest/config';

// The default config's `include` lists only the sandbox-free suites, so
// `npx vitest run tests/e2e-…` there finds no test files at all. These suites
// need a running local network (`aztec start --local-network`, see
// start-sandbox.sh) and generate real proofs, hence the long timeouts:
//   npm run test:e2e -w packages/integration -- tests/e2e-aztec-settlement.test.ts
export default defineConfig({
  test: {
    globals: true,
    testTimeout: 1_800_000,
    hookTimeout: 1_800_000,
    include: ['tests/e2e-*.test.ts'],
  },
});
