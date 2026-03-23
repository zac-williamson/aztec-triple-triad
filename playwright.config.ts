import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'packages/integration/tests',
  testMatch: 'e2e-browser-*.test.ts',
  timeout: 10 * 60 * 1000, // 10 minutes
  retries: 0,
  use: {
    headless: true,
    browserName: 'chromium',
  },
});
