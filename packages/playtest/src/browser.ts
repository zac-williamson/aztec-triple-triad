/**
 * Browser launch config shared by playwright.config.ts and the multi-game
 * campaign.
 *
 * Why the campaign launches a SEPARATE Chromium process per player instead of
 * two contexts in one browser: two BrowserContexts in one Chromium share ONE
 * GPU process. Under sustained ClientIVC proving (CPU pinned for minutes) that
 * shared GPU process is starved and its WebGL context is lost — and because it
 * is shared, BOTH tabs lose their context within tens of ms of each other
 * (measured 16–56 ms apart in the frozen-run logs), then the pages wedge. One
 * Chromium process per player isolates the GPU/context budget so one player's
 * proving load cannot kill the other player's renderer.
 */
import { chromium, type Browser, type BrowserContext } from '@playwright/test';

/**
 * ANGLE backend args. Headless Chromium's default backend cannot create a WebGL
 * context on macOS; 'metal' drives the real GPU headlessly. CI boxes without a
 * GPU opt into swiftshader via PLAYTEST_ANGLE (verified by scripts/probe-webgl.ts).
 */
export function chromiumLaunchArgs(): string[] {
  return process.env.PLAYTEST_ANGLE === 'swiftshader'
    ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
    : ['--use-angle=metal'];
}

/** Viewport must match playwright.config so testkit world→screen projection is consistent. */
export const VIEWPORT = { width: 1440, height: 900 };

/**
 * Launch one isolated Chromium process and open a context+page in it. Returns
 * the browser (caller must close it) and the page. Honours PLAYTEST_HEADED for
 * debugging.
 */
export async function launchIsolatedBrowser(): Promise<{ browser: Browser; context: BrowserContext }> {
  const browser = await chromium.launch({
    headless: process.env.PLAYTEST_HEADED !== '1',
    args: chromiumLaunchArgs(),
  });
  const context = await browser.newContext({ viewport: VIEWPORT });
  return { browser, context };
}
