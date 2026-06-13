import { defineConfig, devices } from '@playwright/test';

/**
 * Playtest harness config. One worker — the campaign owns the whole stack
 * (sandbox, backend, frontend) and both browser contexts. Real-proof games
 * run for tens of minutes; the per-test timeout reflects proving physics.
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
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      // Headless Chromium's default ANGLE backend cannot create a WebGL
      // context on macOS (SwiftShader/Vulkan "BindToCurrentSequence failed"),
      // which crashes the R3F <Canvas>. 'metal' uses the real GPU headlessly;
      // CI boxes without a GPU set PLAYTEST_ANGLE=swiftshader (verified by
      // scripts/probe-webgl.ts).
      args: process.env.PLAYTEST_ANGLE === 'swiftshader'
        ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
        : ['--use-angle=metal'],
    },
  },
});
