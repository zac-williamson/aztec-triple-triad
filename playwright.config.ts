import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'packages/integration/tests',
  testMatch: 'e2e-browser-*.test.ts',
  timeout: 10 * 60 * 1000,
  retries: 0,
  // Run browsers sequentially — each test takes minutes and uses shared Aztec sandbox
  workers: 1,
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],
});
