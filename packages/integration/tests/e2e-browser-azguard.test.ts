/**
 * E2E Browser Test — Azguard Wallet Integration
 *
 * Tests the full application flow using the real Azguard browser extension:
 *   1. Create a wallet in Azguard, switch to Sandbox node
 *   2. Navigate to the app (frontend dev server must be running)
 *   3. App connects via AztecWallet.connect() → approve in Azguard popup
 *   4. Starter cards are minted → approve transaction in Azguard popup
 *   5. Verify cards + token balance appear in the UI
 *   6. Purchase a card pack → approve transaction
 *   7. Verify card count increases
 *
 * Prerequisites:
 *   - Aztec sandbox: aztec start --local-network
 *   - Contracts deployed: npx tsx scripts/deploy-contracts.ts
 *   - VITE_WALLET_MODE=azguard in packages/frontend/.env
 *   - Frontend running: cd packages/frontend && npm run dev
 *   - Azguard extension installed in Chrome
 *
 * Run:
 *   npx playwright test e2e-browser-azguard --headed
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { launchBrowserWithAzguard } from './azguard/browser-context';
import { setupAzguardWallet, autoApproveAzguardPopups } from './azguard/azguard-helpers';

const APP_URL = process.env.APP_URL || 'http://localhost:3000';

test.describe.serial('Azguard Wallet E2E', () => {
  let context: BrowserContext;
  let appPage: Page;
  let stopAutoApprove: (() => void) | null = null;
  let walletAddress = '';

  test.beforeAll(async () => {
    context = await launchBrowserWithAzguard();
    await new Promise(r => setTimeout(r, 3000));
  });

  test.afterAll(async () => {
    if (stopAutoApprove) stopAutoApprove();
    await context?.close();
  });

  test('create Azguard wallet and switch to Sandbox', async () => {
    const { address, popupPage } = await setupAzguardWallet(context);
    walletAddress = address;
    console.log(`[Test] Azguard wallet created. Address: ${address || '(truncated in UI)'}`);

    // Verify we're on Sandbox
    await popupPage.goto('chrome-extension://pliilpflcmabdiapdeihifihkbdfnbmn/src/popup/index.html');
    await popupPage.waitForTimeout(2000);
    await expect(popupPage.getByText('Sandbox')).toBeVisible({ timeout: 5000 });
    await popupPage.close();
  });

  test('connect app via Azguard and load main menu', async () => {
    // Start auto-approving popups before navigating to the app
    stopAutoApprove = autoApproveAzguardPopups(context);

    appPage = await context.newPage();
    await appPage.goto(APP_URL);
    await appPage.waitForLoadState('networkidle');
    await appPage.waitForTimeout(3000);

    // Skip tutorial prompt if it appears
    const skipBtn = appPage.getByText(/I Know the Rules/i);
    if (await skipBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await skipBtn.click();
      await appPage.waitForTimeout(1000);
    }

    // Capture ALL console output from the app
    appPage.on('console', msg => {
      console.log(`[App ${msg.type()}] ${msg.text()}`);
    });
    appPage.on('pageerror', err => {
      console.log(`[App ERROR] ${err.message}`);
    });

    // Check if Azguard injected window.azguard
    await appPage.waitForTimeout(5000);
    const hasAzguard = await appPage.evaluate(() => {
      return {
        hasWindowAzguard: typeof (window as any).azguard !== 'undefined',
        azguardVersion: (window as any).azguard?.version,
        azguardKeys: (window as any).azguard ? Object.keys((window as any).azguard) : [],
      };
    });
    console.log('[Test] window.azguard check:', JSON.stringify(hasAzguard));

    await appPage.screenshot({ path: '/tmp/azguard-app-initial.png', fullPage: true });
    const appText = (await appPage.textContent('body'))?.substring(0, 500);
    console.log('[Test] App page text:', appText);

    // Wait for Azguard to open the connection approval popup
    console.log('[Test] Looking for Azguard connection popup...');
    await appPage.waitForTimeout(5000);

    // Find the Azguard popup page (it opens as #/windows/connect)
    let azguardPopup: Page | null = null;
    for (const page of context.pages()) {
      if (page.url().includes('pliilpflcmabdiapdeihifihkbdfnbmn') && page.url().includes('/windows/')) {
        azguardPopup = page;
        break;
      }
    }

    // If not found yet, wait for it
    if (!azguardPopup) {
      console.log('[Test] Popup not found yet, waiting for new page...');
      azguardPopup = await context.waitForEvent('page', { timeout: 30_000 });
      await azguardPopup.waitForLoadState('domcontentloaded');
    }

    console.log(`[Test] Found Azguard popup: ${azguardPopup.url()}`);
    await azguardPopup.waitForTimeout(2000);
    await azguardPopup.screenshot({ path: '/tmp/azguard-connect-popup.png', fullPage: true });

    // Log popup contents to find the right button
    const popupText = (await azguardPopup.textContent('body'))?.substring(0, 500);
    console.log('[Test] Connect popup text:', popupText);
    const popupBtns = await azguardPopup.getByRole('button').allTextContents();
    console.log('[Test] Connect popup buttons:', JSON.stringify(popupBtns));

    // The Approve button is disabled until an account is selected.
    // Azguard uses custom checkbox components — find the account selection area.
    // Log all clickable elements near "Select accounts" or "Account"
    const selectSection = azguardPopup.getByText(/Select accounts/i);
    if (await selectSection.count() > 0) {
      console.log('[Test] Found "Select accounts" section');
    }

    // Try clicking on the account entry (the row with the account address)
    // The account row contains the truncated address (e.g. "0x05c5...f5bf")
    const accountRow = azguardPopup.locator('text=/0x[0-9a-f]/i').first();
    if (await accountRow.count() > 0) {
      console.log('[Test] Clicking account row...');
      await accountRow.click({ force: true });
      await azguardPopup.waitForTimeout(1000);
    }

    // Also try any checkbox-like elements (custom or native)
    const checkboxes = azguardPopup.locator('[role="checkbox"], input[type="checkbox"], [class*="check"], [class*="toggle"]');
    const checkboxCount = await checkboxes.count();
    console.log(`[Test] Found ${checkboxCount} checkbox-like elements`);
    for (let i = 0; i < checkboxCount; i++) {
      await checkboxes.nth(i).click({ force: true }).catch(() => {});
    }
    await azguardPopup.waitForTimeout(500);

    // Screenshot after account selection attempt
    await azguardPopup.screenshot({ path: '/tmp/azguard-after-select.png', fullPage: true });
    const btnStates = await azguardPopup.getByRole('button').allTextContents();
    console.log('[Test] Buttons after account select:', JSON.stringify(btnStates));

    // Check if Approve button is now enabled
    const approveBtn = azguardPopup.getByRole('button', { name: /Approve/i });
    const isDisabled = await approveBtn.evaluate(el => el.classList.contains('_disabled_qsyuv_317') || (el as HTMLButtonElement).disabled).catch(() => true);
    console.log(`[Test] Approve button disabled: ${isDisabled}`);

    // Try force-clicking Approve regardless
    await approveBtn.click({ force: true, timeout: 5000 });
    console.log('[Test] Force-clicked Approve');

    await appPage.waitForTimeout(5000);

    // Wait for the app to connect
    console.log('[Test] Waiting for app to show Connected...');
    await expect(
      appPage.getByText('Connected')
    ).toBeVisible({ timeout: 120_000 });

    console.log('[Test] App connected via Azguard');
  });

  test('starter cards minted and visible', async () => {
    // After connection, get_cards_for_new_player is called
    // The Azguard tx popup will be auto-approved
    // Wait for card count to appear (Cards: 5+)
    console.log('[Test] Waiting for starter cards...');
    await expect(
      appPage.getByText(/Cards:\s*[5-9]|Cards:\s*\d{2,}/)
    ).toBeVisible({ timeout: 300_000 }); // 5 min — minting + note import is slow

    console.log('[Test] Starter cards visible');
  });

  test('token balance shows 100', async () => {
    await expect(
      appPage.getByText(/Arena Tokens:\s*100/)
    ).toBeVisible({ timeout: 30_000 });
    console.log('[Test] Token balance = 100');
  });

  test('navigate to card pack purchase', async () => {
    await appPage.getByRole('button', { name: /Buy Card Pack/i }).click();
    await expect(
      appPage.getByText(/Purchase Card Pack/i)
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      appPage.getByText(/Your Balance/)
    ).toBeVisible({ timeout: 10_000 });
    console.log('[Test] Card pack purchase screen loaded');
  });

  test('purchase a card pack', async () => {
    await appPage.getByRole('button', { name: /Purchase Card Pack/i }).click();

    // The Azguard tx popup will be auto-approved
    // Wait for pack opening animation → "Click anywhere to continue"
    console.log('[Test] Waiting for pack opening...');
    await expect(
      appPage.getByText(/Click anywhere to continue/i)
    ).toBeVisible({ timeout: 300_000 });

    await appPage.click('body');
    await appPage.waitForTimeout(2000);
    console.log('[Test] Card pack purchased');
  });

  test('card count increased after purchase', async () => {
    // Should have 15 cards (5 starter + 10 from pack)
    await expect(
      appPage.getByText(/Cards:\s*(1[0-5]|[2-9]\d|\d{3,})/)
    ).toBeVisible({ timeout: 30_000 });
    console.log('[Test] Card count increased');
  });

  test('can start a game', async () => {
    const playBtn = appPage.getByRole('button', { name: /Play|Resume/i });
    await expect(playBtn).toBeEnabled({ timeout: 10_000 });
    console.log('[Test] Play button enabled — game can be started');
  });
});
