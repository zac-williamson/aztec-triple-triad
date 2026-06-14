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
 * Default per-action (click/fill/etc.) timeout. CRITICAL: Playwright's built-in
 * default is 0 = UNBOUNDED, so a bare `.click()` on a wedged page hangs until the
 * 60-min test timeout — this is exactly why the post-pack `menu-play.click()`
 * zombie-hung past every guard (proven: scripts/probe-frozen-guard.ts Q4). A UI
 * click is fast on a healthy page (heavy work is awaited separately via
 * waitScreen/waitPhase), so 60s is generous; a wedged page now fails here, fast.
 * The config's `use.actionTimeout` does NOT reach contexts we launch ourselves —
 * it must be set on the context explicitly.
 */
export const DEFAULT_ACTION_TIMEOUT_MS = 60_000;
/** Navigation gets more room than actions: the first goto can cold-optimize deps. */
export const DEFAULT_NAV_TIMEOUT_MS = 120_000;

/**
 * Launch one isolated Chromium process and open a context+page in it. Returns
 * the browser (caller must close it) and the context. Honours PLAYTEST_HEADED.
 */
export async function launchIsolatedBrowser(): Promise<{ browser: Browser; context: BrowserContext }> {
  const browser = await chromium.launch({
    headless: process.env.PLAYTEST_HEADED !== '1',
    args: chromiumLaunchArgs(),
  });
  const context = await browser.newContext({ viewport: VIEWPORT });
  // Bound every action so no bare click/fill can hang unbounded on a wedged page.
  context.setDefaultTimeout(DEFAULT_ACTION_TIMEOUT_MS);
  context.setDefaultNavigationTimeout(DEFAULT_NAV_TIMEOUT_MS);
  return { browser, context };
}
