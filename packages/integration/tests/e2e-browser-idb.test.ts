/**
 * E2E Browser Test: Reproduce TransactionInactiveError with REAL IndexedDB
 *
 * Runs the minimal reproduction flow (wallet create → account deploy →
 * get_cards_for_new_player().send()) multiple times in a real browser.
 *
 * The IDB error is non-deterministic — it sometimes triggers on the first
 * .send() call, sometimes doesn't. Running 10 iterations increases the
 * chance of reproducing it.
 *
 * Prerequisites:
 *   - Aztec sandbox running: aztec start --local-network
 *   - Contracts deployed (VITE_NFT_CONTRACT_ADDRESS in .env)
 *   - Frontend dev server running: cd packages/frontend && npm run dev
 *
 * Run on WebKit (Safari engine — most likely to reproduce):
 *   npx playwright test packages/integration/tests/e2e-browser-idb.test.ts --project=webkit
 *
 * Run on Chromium:
 *   npx playwright test packages/integration/tests/e2e-browser-idb.test.ts --project=chromium
 */

import { test, expect } from '@playwright/test';

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const SINGLE_RUN_TIMEOUT = 5 * 60 * 1000; // 5 min per iteration
const ITERATIONS = 10;

for (let i = 0; i < ITERATIONS; i++) {
  test(`iteration ${i + 1}/${ITERATIONS}: get_cards_for_new_player with real IDB`, async ({ page, browserName }) => {
    test.setTimeout(SINGLE_RUN_TIMEOUT);

    const consoleErrors: string[] = [];

    page.on('console', msg => {
      const text = msg.text();
      if (msg.type() === 'error') consoleErrors.push(text);
      // Only print [idb-test] lines and errors to keep output manageable
      if (text.includes('[idb-test]') || msg.type() === 'error') {
        console.log(`  [${browserName}:${i + 1}] ${text}`);
      }
    });

    page.on('pageerror', err => {
      consoleErrors.push(err.message);
      console.log(`  [${browserName}:${i + 1}:pageerror] ${err.message}`);
    });

    await page.goto(`${FRONTEND_URL}/idb-test.html`, { waitUntil: 'domcontentloaded' });

    // Poll for result
    let result: any = null;
    for (let poll = 0; poll < Math.floor(SINGLE_RUN_TIMEOUT / 3000); poll++) {
      result = await page.evaluate(() => (window as any).__IDB_TEST_RESULT__);
      if (result !== null && result !== undefined) break;
      await page.waitForTimeout(3000);
    }

    const idbErrorInConsole = consoleErrors.some(
      e => e.includes('TransactionInactiveError') || e.includes('transaction is inactive or finished'),
    );
    const idbErrorInResult = result?.isTransactionInactiveError === true;

    if (idbErrorInConsole || idbErrorInResult) {
      console.log(`\n  *** ITERATION ${i + 1}: BUG REPRODUCED on ${browserName}! ***`);
      console.log(`  Error: ${result?.error?.slice(0, 150)}`);
      console.log(`  Total time: ${result?.totalElapsed}s\n`);
    } else if (result?.success) {
      console.log(`  [${browserName}:${i + 1}] PASSED in ${result.totalElapsed}s (send: ${result.sendElapsed}s)`);
    } else {
      console.log(`  [${browserName}:${i + 1}] FAILED: ${result?.error?.slice(0, 150) ?? 'timeout'}`);
    }

    // Test always passes — we're just looking for reproduction evidence
    expect(result).not.toBeNull();
  });
}
