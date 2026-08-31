/** Click Fund on the deployed app and report, second by second, where it stops. */
import { chromium } from '@playwright/test';
import { createFundedL1Account, refundTreasury } from '../src/walletShim.js';

const SHOT = process.env.SHOT_DIR!;
const log = (m: string) => console.log(`   ${m}`);

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const wallet = await createFundedL1Account({ log });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await wallet.install(page);

const errors: string[] = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
page.on('pageerror', e => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`));
const reqFail: string[] = [];
page.on('requestfailed', r => reqFail.push(`${r.method()} ${r.url().slice(0, 90)} — ${r.failure()?.errorText}`));

await page.goto('https://www.aztec-arena.com', { waitUntil: 'domcontentloaded' });
await page.getByTestId('tutorial-skip').click({ timeout: 120_000 }).catch(() => log('no tutorial'));
await page.getByTestId('fund-with-wallet').waitFor({ state: 'visible', timeout: 180_000 });
log('clicking Fund with My Wallet');
await page.getByTestId('fund-with-wallet').click();

let last = '';
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(15_000);
  const st = await page.evaluate(() => {
    const t = document.body.innerText;
    return {
      progress: t.match(/(Connecting your wallet|Claiming test Fee Juice|Approving the Fee Juice bridge|Bridging to your Aztec account|Waiting for Ethereum to reach Aztec|Your account is funded)[^\n]*/)?.[0] ?? '',
      error: [...document.querySelectorAll('[role="alert"], .parchment-dialog__error')].map(e => e.textContent?.trim()).filter(Boolean).join(' | '),
      cards: t.match(/Cards:\s*(\d+)/)?.[1] ?? '?',
    };
  });
  const line = `${st.progress || '(no progress text)'}${st.error ? `  ERROR: ${st.error}` : ''}  cards=${st.cards}`;
  if (line !== last) { log(`t+${(i + 1) * 15}s  ${line}`); last = line; }
  if (st.error || st.cards !== '0') break;
}
await page.screenshot({ path: `${SHOT}/final.png` });
console.log('\n  === console errors ===');
for (const e of [...new Set(errors)].slice(0, 12)) console.log('   ', e);
console.log('\n  === failed requests ===');
for (const r of [...new Set(reqFail)].slice(0, 8)) console.log('   ', r);
await browser.close();
await refundTreasury(wallet.privateKey, log);
