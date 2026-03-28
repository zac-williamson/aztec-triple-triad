import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'packages/integration/tests',
  testMatch: 'e2e-browser-*.test.ts',
  timeout: 10 * 60 * 1000, // 10 min per test
  retries: 0,
  // Run tests sequentially — each test uses a shared Aztec sandbox
  workers: 1,
  // Allow individual test steps to take up to 3 minutes
  expect: {
    timeout: 180_000,
  },
  projects: [
    {
      name: 'azguard-chromium',
      testMatch: 'e2e-browser-azguard*.test.ts',
      use: {
        // Azguard requires Chromium (Chrome extension)
        ...devices['Desktop Chrome'],
        // Extensions need headed mode
        headless: false,
      },
    },
    {
      name: 'chromium',
      testIgnore: 'e2e-browser-azguard*.test.ts',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'webkit',
      testIgnore: 'e2e-browser-azguard*.test.ts',
      use: { ...devices['Desktop Safari'] },
    },
  ],
});
