/**
 * E2E Browser Test: Reproduce TransactionInactiveError with REAL IndexedDB
 *
 * Uses Playwright to open a headless browser, load a page that exercises
 * the exact EmbeddedWallet → create_game code path with real browser IndexedDB.
 *
 * The test page fires concurrent .simulate() calls while .send() is in flight,
 * reproducing what the React app does when effects re-evaluate during the
 * 12-17 second create_game transaction.
 *
 * Prerequisites:
 *   - Aztec sandbox running: aztec start --local-network
 *   - Contracts deployed (VITE_NFT_CONTRACT_ADDRESS and VITE_GAME_CONTRACT_ADDRESS in .env)
 *   - Frontend dev server running: cd packages/frontend && npm run dev
 *
 * Run (Chromium):
 *   npx playwright test packages/integration/tests/e2e-browser-idb.test.ts
 *
 * Run (WebKit/Safari — more likely to reproduce):
 *   npx playwright test packages/integration/tests/e2e-browser-idb.test.ts --project=webkit
 *
 * Run headed for debugging:
 *   npx playwright test packages/integration/tests/e2e-browser-idb.test.ts --headed
 */

import { test, expect } from '@playwright/test';

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const TEST_TIMEOUT = 10 * 60 * 1000;

test.describe('Browser IndexedDB TransactionInactiveError', () => {
  test('create_game with concurrent PXE activity triggers IDB error', async ({ page, browserName }) => {
    test.setTimeout(TEST_TIMEOUT);

    const consoleMessages: string[] = [];
    const consoleErrors: string[] = [];

    page.on('console', msg => {
      const text = msg.text();
      consoleMessages.push(`[${msg.type()}] ${text}`);
      if (msg.type() === 'error') consoleErrors.push(text);
      console.log(`  [${browserName}:${msg.type()}] ${text}`);
    });

    page.on('pageerror', err => {
      consoleErrors.push(err.message);
      console.log(`  [${browserName}:pageerror] ${err.message}`);
    });

    console.log(`Browser: ${browserName}`);
    console.log(`Navigating to ${FRONTEND_URL}/idb-test.html`);
    console.log('');

    await page.goto(`${FRONTEND_URL}/idb-test.html`, { waitUntil: 'domcontentloaded' });

    // Wait for __IDB_TEST_RESULT__ to be set
    let result: any = null;
    const pollInterval = 5000;
    const maxPolls = Math.floor(TEST_TIMEOUT / pollInterval);

    for (let i = 0; i < maxPolls; i++) {
      result = await page.evaluate(() => (window as any).__IDB_TEST_RESULT__);
      if (result !== null && result !== undefined) break;
      await page.waitForTimeout(pollInterval);
    }

    console.log('');
    console.log('=== RESULT ===');
    console.log(JSON.stringify(result, null, 2));
    console.log('');

    const idbErrorInConsole = consoleErrors.some(
      e => e.includes('TransactionInactiveError') || e.includes('transaction is inactive or finished'),
    );
    const idbErrorInResult = result?.isTransactionInactiveError === true;
    const idbErrorInConcurrent = (result?.concurrentErrors || []).some(
      (e: string) => e.includes('TransactionInactiveError') || e.includes('transaction is inactive'),
    );

    const bugReproduced = idbErrorInConsole || idbErrorInResult || idbErrorInConcurrent;

    if (bugReproduced) {
      console.log(`BUG REPRODUCED on ${browserName}!`);
      console.log('TransactionInactiveError occurred during concurrent PXE access.');
      if (idbErrorInResult) console.log('  → .send() itself failed');
      if (idbErrorInConcurrent) console.log('  → Concurrent .simulate() calls failed');
      if (idbErrorInConsole) console.log('  → Error seen in browser console');
    } else if (result?.success) {
      console.log(`create_game succeeded on ${browserName} with ${result.concurrentOps} concurrent ops.`);
      if (result.concurrentErrors?.length > 0) {
        console.log(`  But ${result.concurrentErrors.length} concurrent errors occurred:`);
        result.concurrentErrors.forEach((e: string) => console.log(`    ${e.slice(0, 120)}`));
      }
    } else if (result?.error) {
      console.log(`Failed with: ${result.error.slice(0, 200)}`);
    } else {
      console.log('Test did not complete within timeout.');
    }

    expect(result).not.toBeNull();
    // The test reports what happened. If the bug reproduces, it's logged clearly.
    // The test passes either way — it's a reproduction test, not a regression test.
  });
});
