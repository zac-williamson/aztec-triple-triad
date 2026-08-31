/**
 * Why does a production game stall after the first move?
 *
 * The bot will not join until player 1's create_game is CONFIRMED on-chain
 * (join_game asserts the game is in `created` state). If that never lands, the
 * bot waits forever and the game dies at move one. This captures the browser
 * side of that pipeline — every app log, in order — so the failure is read
 * rather than guessed.
 */
import { chromium, type Page } from '@playwright/test';
import { createFundedL1Account, refundTreasury } from '../src/walletShim.js';
import { writeFileSync } from 'fs';

const SHOT = process.env.SHOT_DIR!;
const THREADS = process.env.PROOF_THREADS ?? '4';
const log = (m: string) => console.log(`   ${m}`);
const APP = /\[(useGameSession|useGamePlay|useAztec|pxe|proofWorker|txManager|useWebSocket|contracts|PXE-TRACE)\]/;

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  let wallet = null as Awaited<ReturnType<typeof createFundedL1Account>> | null;
  let page: Page | null = null;
  const lines: string[] = [];
  try {
    wallet = await createFundedL1Account({ log });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await ctx.newPage();
    await wallet.install(page);
    // Proving is the slow step and headless has no GPU; give it real threads.
    await page.addInitScript({ content: `localStorage.setItem('triad_proof_threads','${THREADS}')` });

    page.on('console', m => {
      const t = m.text();
      if (APP.test(t) || /error/i.test(m.type())) {
        const line = `${new Date().toISOString().slice(11, 19)} [${m.type()}] ${t.slice(0, 240)}`;
        lines.push(line);
        if (/useGameSession|txManager|error/i.test(line)) log(line);
      }
    });
    page.on('pageerror', e => lines.push(`PAGEERROR ${e.message}`));

    await page.goto('https://www.aztec-arena.com', { waitUntil: 'domcontentloaded' });
    await page.getByTestId('tutorial-skip').click({ timeout: 120_000 }).catch(() => {});
    await page.getByTestId('fund-with-wallet').waitFor({ state: 'visible', timeout: 180_000 });
    log('funding…');
    await page.getByTestId('fund-with-wallet').click();

    const text = () => page!.evaluate(() => document.body.innerText);
    const deadline = Date.now() + 25 * 60_000;
    while (Date.now() < deadline && !/Cards:\s*[1-9]/.test(await text())) await page.waitForTimeout(10_000);
    log('onboarded');

    await page.getByTestId('menu-play').click();
    await page.waitForTimeout(3000);
    for (const p of (await page.locator('[data-testid^="card-select-"]').all()).slice(0, 5)) {
      await p.click().catch(() => {});
    }
    await page.waitForTimeout(800);
    const go = page.getByRole('button', { name: /queue|play|confirm|find/i }).first();
    if (await go.isVisible().catch(() => false)) await go.click();
    log('queued — waiting for the match, then watching the chain pipeline');

    // Watch for 18 minutes after the match, logging what the app does.
    const matchBy = Date.now() + 8 * 60_000;
    while (Date.now() < matchBy && !/Your Turn|Opponent's Turn/i.test(await text())) {
      await page.waitForTimeout(5000);
    }
    log('matched — observing for 18 minutes');
    const watchUntil = Date.now() + 18 * 60_000;
    while (Date.now() < watchUntil) {
      await page.waitForTimeout(30_000);
      const t = await text();
      const turn = t.match(/Your Turn|Opponent's Turn|Game Over/i)?.[0] ?? '?';
      log(`… ${turn}`);
      if (/Game Over/i.test(t)) break;
    }
    await page.screenshot({ path: `${SHOT}/stalled.png` });
    // The app ships its own chain observability; open it and read it.
    await page.getByTestId('chain-view-toggle').click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${SHOT}/chain-view.png` });
    const chain = await page.evaluate(() => {
      const p = document.querySelector('[data-testid="chain-view-panel"]');
      return p ? (p as HTMLElement).innerText : '(chain view not open)';
    });
    log(`chain view:\n${chain}`);
  } finally {
    writeFileSync(`${SHOT}/browser.log`, lines.join('\n'));
    try {
      const leave = page!.getByRole('button', { name: /Leave/i }).first();
      if (await leave.isVisible({ timeout: 3000 }).catch(() => false)) await leave.click();
      await page!.waitForTimeout(2500);
    } catch { /* best effort */ }
    await browser.close();
    if (wallet) await refundTreasury(wallet.privateKey, log);
  }
}
main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
