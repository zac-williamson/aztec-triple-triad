import { defineConfig, devices } from '@playwright/test';
import { chromiumLaunchArgs, DEFAULT_ACTION_TIMEOUT_MS, DEFAULT_NAV_TIMEOUT_MS } from './src/browser.js';

/**
 * Playtest harness config. One worker — the campaign owns the whole stack
 * (sandbox, backend, frontend) and both browser contexts. Real-proof games
 * run for tens of minutes; the per-test timeout reflects proving physics.
 *
 * NOTE: the multi-game campaign does NOT use the shared `browser` fixture
 * configured here; it launches one isolated Chromium process per player (see
 * src/browser.ts) for GPU-process isolation. The `launchOptions` below still
 * govern single-context specs (full-game) and any fixture-based test.
 */
export default defineConfig({
  testDir: './tests',
  timeout: 60 * 60 * 1000,
  workers: 1,
  retries: 0,
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  outputDir: './.artifacts/test-output',
  reporter: [['list'], ['html', { outputFolder: './.artifacts/report', open: 'never' }]],
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    // Playwright's default actionTimeout is 0 (UNBOUNDED) — a bare click on a
    // wedged page would hang until the 60-min test timeout. Bound it. (The
    // campaign's own contexts set this via context.setDefaultTimeout in
    // src/browser.ts, since `use` does not reach manually-launched contexts.)
    actionTimeout: DEFAULT_ACTION_TIMEOUT_MS,
    navigationTimeout: DEFAULT_NAV_TIMEOUT_MS,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      // ANGLE backend selection lives in src/browser.ts so the shared fixture
      // and the campaign's per-player launches cannot drift apart.
      args: chromiumLaunchArgs(),
    },
  },
});
