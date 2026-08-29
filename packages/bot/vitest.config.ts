import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // *.manual.ts are operator-run scripts (need a sandbox + provisioned
    // identities), deliberately excluded from the unit suite.
    include: ['tests/**/*.test.ts'],
  },
});
