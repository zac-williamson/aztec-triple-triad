/**
 * Create a Playwright browser context with the Azguard extension loaded.
 *
 * Chrome extensions require:
 * - Headed mode (headless: false) — or use xvfb on CI
 * - Persistent context (to keep extension state between page navigations)
 * - --disable-extensions-except + --load-extension flags
 */

import { chromium, type BrowserContext } from '@playwright/test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getAzguardExtensionPath } from './setup-extension';

export interface AzguardBrowserOptions {
  /** Show the browser window (default: true, needed for extensions) */
  headed?: boolean;
  /** Additional Chrome args */
  args?: string[];
  /** Slow down operations by N ms (useful for debugging) */
  slowMo?: number;
}

/**
 * Launch a Chrome browser with the Azguard extension loaded.
 * Returns a persistent browser context.
 */
export async function launchBrowserWithAzguard(
  opts: AzguardBrowserOptions = {},
): Promise<BrowserContext> {
  const extensionPath = getAzguardExtensionPath();

  // Each test run gets a fresh user data directory
  const userDataDir = mkdtempSync(join(tmpdir(), 'azguard-test-'));

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false, // Extensions require headed mode
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-first-run',
      '--disable-default-apps',
      '--disable-popup-blocking',
      ...(opts.args || []),
    ],
    slowMo: opts.slowMo,
    // Larger viewport for the game
    viewport: { width: 1280, height: 900 },
    // Grant permissions needed by the app
    permissions: ['clipboard-read', 'clipboard-write'],
    // Increase action timeout for extension interactions
    actionTimeout: 30_000,
  });

  // Wait for extension service worker to initialize
  let bgPage = context.serviceWorkers()[0];
  if (!bgPage) {
    bgPage = await context.waitForEvent('serviceworker', { timeout: 10_000 });
  }
  console.log(`[Browser] Azguard service worker loaded: ${bgPage.url()}`);

  return context;
}
