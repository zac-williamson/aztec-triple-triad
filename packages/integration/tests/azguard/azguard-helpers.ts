/**
 * Playwright helpers for automating the Azguard browser extension.
 *
 * Selectors are based on Azguard v0.12.1 UI — update if the extension changes.
 */

import type { BrowserContext, Page } from '@playwright/test';

const EXT_ID = 'pliilpflcmabdiapdeihifihkbdfnbmn';
const POPUP_URL = `chrome-extension://${EXT_ID}/src/popup/index.html`;

/**
 * Create a wallet in Azguard and switch to the Sandbox node.
 *
 * Steps automated:
 *   1. Open popup → Click "Create Profile"
 *   2. Fill password fields → Click "Create with Password"
 *   3. Navigate to Settings → General → Nodes → Click "Sandbox"
 *   4. Return the account address from the main popup page
 */
export async function setupAzguardWallet(
  context: BrowserContext,
  opts: { password?: string } = {},
): Promise<{ address: string; popupPage: Page }> {
  const password = opts.password || 'TestPassword123!';
  const page = await context.newPage();

  // 1. Open popup and create profile
  await page.goto(POPUP_URL);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);
  await page.getByRole('button', { name: 'Create Profile' }).click();
  await page.waitForTimeout(1500);

  // 2. Set password
  await page.locator('input[placeholder="Strong password"]').fill(password);
  await page.locator('input[placeholder="Repeat password"]').fill(password);
  await page.getByRole('button', { name: 'Create with Password' }).click();
  await page.waitForTimeout(5000);

  // 3. Switch to Sandbox node
  await page.goto(`${POPUP_URL}#/popup/settings`);
  await page.waitForTimeout(1000);
  await page.getByText('General').click();
  await page.waitForTimeout(1000);
  await page.getByText('Nodes').click();
  await page.waitForTimeout(1500);
  await page.getByText('Sandbox').first().click();
  await page.waitForTimeout(2000);

  // 4. Go to main page and read address
  await page.goto(POPUP_URL);
  await page.waitForTimeout(3000);
  const bodyText = await page.textContent('body') || '';
  const addrMatch = bodyText.match(/0x[0-9a-fA-F]{40,66}/);
  const address = addrMatch?.[0] || '';

  return { address, popupPage: page };
}

/**
 * Auto-approve Azguard popups (connection requests + transactions) as they appear.
 * Returns a stop function.
 */
export function autoApproveAzguardPopups(context: BrowserContext): () => void {
  let active = true;

  const loop = async () => {
    while (active) {
      try {
        const popup = await context.waitForEvent('page', { timeout: 3000 });
        await popup.waitForLoadState('domcontentloaded');
        await popup.waitForTimeout(2000);

        const url = popup.url();
        if (!url.includes('chrome-extension://')) continue;

        // Screenshot for debugging
        await popup.screenshot({ path: `/tmp/azguard-popup-${Date.now()}.png` }).catch(() => {});

        // Try clicking approve/confirm/connect/sign buttons
        const btn = popup.getByRole('button', { name: /confirm|approve|connect|allow|sign|send|accept/i });
        if (await btn.count() > 0) {
          await btn.first().click({ timeout: 10_000 });
          console.log('[Azguard Auto-Approve] Approved popup');
        } else {
          // Maybe there's a different button layout — log it
          const allBtns = await popup.getByRole('button').allTextContents();
          console.log('[Azguard Auto-Approve] No approve button found. Buttons:', JSON.stringify(allBtns));
          // Try clicking the last button (often the confirm action)
          if (allBtns.length > 0) {
            await popup.getByRole('button').last().click({ timeout: 5000 }).catch(() => {});
          }
        }
      } catch {
        // Timeout — no popup appeared, loop again
      }
    }
  };

  loop();
  return () => { active = false; };
}

/**
 * Get the Azguard account address from the popup.
 */
export async function getAzguardAddress(context: BrowserContext): Promise<string> {
  const page = await context.newPage();
  await page.goto(POPUP_URL);
  await page.waitForTimeout(3000);
  const bodyText = await page.textContent('body') || '';
  await page.close();
  const match = bodyText.match(/0x[0-9a-fA-F]{40,66}/);
  if (!match) throw new Error('Could not find address in Azguard popup');
  return match[0];
}
