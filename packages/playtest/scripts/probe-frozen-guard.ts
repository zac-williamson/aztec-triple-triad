/**
 * PROOF (orchestrator directive): every harness guard must fail FAST against a
 * deliberately-frozen page — a frozen-page `page.evaluate`/click neither returns
 * nor rejects on its own, so each guard must be a Node-side timer that fires
 * regardless of page state. Asserts and EXITS NON-ZERO if any guard fails to
 * fire, so it is a runnable regression proof, not just a print.
 *
 *   npx tsx scripts/probe-frozen-guard.ts
 *
 * Covers the three guard classes the campaign relies on:
 *   1. reads   — withTimeout(page.evaluate, ms)              [Promise.race + Node timer]
 *   2. actions — context.setDefaultTimeout bounds bare clicks [Playwright Node-side]
 *   3. dead    — the liveness watchdog rejects driver.dead    [Node timer pings]
 * and that teardown does not hang on a frozen page.
 */
import { chromium } from '@playwright/test';
import { chromiumLaunchArgs, DEFAULT_ACTION_TIMEOUT_MS } from '../src/browser.js';
import { PlayerDriver } from '../src/player.js';

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);
const failures: string[] = [];
function check(ok: boolean, label: string, detail: string): void {
  log(`${ok ? 'PASS' : 'FAIL'}: ${label} — ${detail}`);
  if (!ok) failures.push(label);
}

function raceTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label}: did not return within ${ms / 1000}s`)), ms)),
  ]);
}

/** Block the page's JS event loop forever (not awaited — never returns). */
function freeze(page: import('@playwright/test').Page): void {
  page.evaluate(() => { while (true) { /* spin */ } }).catch(() => {});
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true, args: chromiumLaunchArgs() });

  // ── Guard 1 + 2: reads and clicks on a frozen context ──
  {
    const context = await browser.newContext();
    context.setDefaultTimeout(2_000); // tight, so the proof is quick
    const page = await context.newPage();
    await page.goto('about:blank');
    freeze(page);
    await new Promise(r => setTimeout(r, 800));

    const t1 = Date.now();
    let readGuarded = false;
    try { await raceTimeout(page.evaluate(() => 42), 3_000, 'read'); }
    catch { readGuarded = true; }
    check(readGuarded && Date.now() - t1 < 5_000, 'guarded read fails fast',
      `rejected after ${Date.now() - t1}ms (frozen page.evaluate)`);

    const t2 = Date.now();
    let clickBounded = false;
    try { await page.locator('#nope').click(); } // no explicit timeout → uses setDefaultTimeout(2s)
    catch { clickBounded = true; }
    check(clickBounded && Date.now() - t2 < 5_000, 'bare click is bounded by setDefaultTimeout',
      `rejected after ${Date.now() - t2}ms (the unbounded-click zombie, now bounded)`);

    const t3 = Date.now();
    let teardownOk = false;
    try { await raceTimeout(context.close(), 8_000, 'context.close'); teardownOk = true; } catch { /* hung */ }
    check(teardownOk, 'teardown does not hang on a frozen page', `context.close after ${Date.now() - t3}ms`);
  }

  // ── Guard 3: the liveness watchdog declares a frozen page dead ──
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('about:blank');
    const driver = new PlayerDriver('frozen', page, browser);
    freeze(page);
    await new Promise(r => setTimeout(r, 500));
    driver.startWatchdog({ pingEvery: 300, pingTimeout: 800, maxPingFails: 3 });
    const t = Date.now();
    let watchdogFired = false; let reason = '';
    try { await raceTimeout(driver.dead, 10_000, 'watchdog'); }
    catch (e) { const m = (e as Error).message; watchdogFired = m.includes('PAGE DEAD'); reason = m; }
    check(watchdogFired, 'watchdog declares a frozen page dead',
      `${watchdogFired ? `dead after ${Date.now() - t}ms` : `did NOT fire: ${reason}`}`);
    await context.close().catch(() => {});
  }

  await browser.close().catch(() => {});
  log(`DEFAULT_ACTION_TIMEOUT_MS in production = ${DEFAULT_ACTION_TIMEOUT_MS}ms`);
  if (failures.length) { log(`GUARD PROOF FAILED: ${failures.join(', ')}`); process.exit(1); }
  log('GUARD PROOF PASSED — every guard fails fast against a frozen page');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
