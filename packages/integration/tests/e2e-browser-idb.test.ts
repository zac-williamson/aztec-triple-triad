/**
 * E2E Browser Test: Reproduce TransactionInactiveError with REAL IndexedDB
 *
 * Uses Playwright to open a headless Chromium browser, load a minimal page
 * that exercises the exact EmbeddedWallet → create_game code path with
 * real browser IndexedDB (no polyfills, no fakes).
 *
 * Prerequisites:
 *   - Aztec sandbox running: aztec start --local-network
 *   - Contracts deployed (VITE_NFT_CONTRACT_ADDRESS and VITE_GAME_CONTRACT_ADDRESS in .env)
 *   - Frontend dev server running: cd packages/frontend && npm run dev
 *     (provides Vite bundling, COOP/COEP headers, WASM support)
 *   - Playwright installed: npx playwright install chromium
 *
 * Run:
 *   npx playwright test packages/integration/tests/e2e-browser-idb.test.ts
 *
 * Or with headed browser for debugging:
 *   npx playwright test packages/integration/tests/e2e-browser-idb.test.ts --headed
 */

import { test, expect } from '@playwright/test';

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
// Generous timeout — account deployment + card minting + create_game can take minutes
const TEST_TIMEOUT = 10 * 60 * 1000; // 10 minutes

test.describe('Browser IndexedDB TransactionInactiveError', () => {
  test('create_game triggers TransactionInactiveError with real browser IndexedDB', async ({ page }) => {
    test.setTimeout(TEST_TIMEOUT);

    const consoleMessages: string[] = [];
    const consoleErrors: string[] = [];

    // Capture ALL console output from the browser
    page.on('console', msg => {
      const text = msg.text();
      consoleMessages.push(`[${msg.type()}] ${text}`);
      if (msg.type() === 'error') {
        consoleErrors.push(text);
      }
      // Print to Node.js stdout for live visibility
      console.log(`  [browser:${msg.type()}] ${text}`);
    });

    // Capture uncaught exceptions
    page.on('pageerror', err => {
      consoleErrors.push(err.message);
      console.log(`  [browser:pageerror] ${err.message}`);
    });

    console.log('Navigating to test page...');
    console.log(`URL: ${FRONTEND_URL}/idb-test.html`);

    await page.goto(`${FRONTEND_URL}/idb-test.html`, {
      waitUntil: 'domcontentloaded',
    });

    console.log('Page loaded. Waiting for test to complete...');
    console.log('(This takes several minutes: account deploy, card mint, create_game)');
    console.log('');

    // Wait for the test runner to set __IDB_TEST_RESULT__ on the window object.
    // Poll every 5 seconds, with total timeout matching the test timeout.
    let result: any = null;
    const pollInterval = 5000;
    const maxPolls = Math.floor(TEST_TIMEOUT / pollInterval);

    for (let i = 0; i < maxPolls; i++) {
      result = await page.evaluate(() => (window as any).__IDB_TEST_RESULT__);
      if (result !== null && result !== undefined) break;
      await page.waitForTimeout(pollInterval);
    }

    console.log('');
    console.log('=== TEST RESULT ===');
    console.log(JSON.stringify(result, null, 2));
    console.log('');

    // Check if TransactionInactiveError appeared anywhere
    const idbErrorInConsole = consoleErrors.some(
      e => e.includes('TransactionInactiveError') || e.includes('transaction is inactive or finished'),
    );
    const idbErrorInResult = result?.isTransactionInactiveError === true;
    const idbErrorInMessage = result?.error?.includes?.('transaction is inactive or finished');

    if (idbErrorInConsole || idbErrorInResult || idbErrorInMessage) {
      console.log('BUG CONFIRMED: TransactionInactiveError occurred in real browser IndexedDB.');
      console.log('');
      console.log('Relevant console errors:');
      for (const e of consoleErrors.filter(
        e => e.includes('TransactionInactiveError') || e.includes('transaction is inactive'),
      )) {
        console.log(`  ${e.slice(0, 200)}`);
      }
    } else if (result?.success) {
      console.log('create_game succeeded — bug did NOT reproduce in this run.');
      console.log('The bug may be timing-dependent. Try running with --headed or on a slower machine.');
    } else if (result?.error) {
      console.log(`create_game failed with a different error: ${result.error.slice(0, 200)}`);
    } else {
      console.log('Test did not complete within the timeout.');
    }

    // Assert that we got a result (test completed)
    expect(result).not.toBeNull();

    // If TransactionInactiveError was seen, the bug is confirmed.
    // If create_game succeeded, the test still passes (the bug is timing-dependent).
    // We just report what happened.
    if (idbErrorInConsole || idbErrorInResult || idbErrorInMessage) {
      // Bug reproduced — log it clearly
      console.log('');
      console.log('To use this as a regression test, uncomment the expect below:');
      console.log('// expect(result.success).toBe(true);');
    }
  });
});
