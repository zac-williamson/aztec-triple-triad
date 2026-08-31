/** What is failing on the deployed app, and what state does onboarding reach? */
import { chromium } from '@playwright/test';

const SHOT = process.env.SHOT_DIR!;
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--window-size=1500,1000'] });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();

const failures: string[] = [];
page.on('response', r => { if (r.status() >= 400) failures.push(`${r.status()} ${r.url()}`); });
const errors: string[] = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });

await page.goto('https://www.aztec-arena.com', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(20000);
await page.screenshot({ path: `${SHOT}/01-landing.png`, fullPage: false });

console.log('\n  === failed requests ===');
for (const f of [...new Set(failures)]) console.log('   ', f);
console.log('\n  === console errors ===');
for (const e of [...new Set(errors)].slice(0, 8)) console.log('   ', e);

// What does the app think its state is? No testkit in prod, so read the DOM.
const state = await page.evaluate(() => ({
  testids: [...document.querySelectorAll('[data-testid]')].map(e => (e as HTMLElement).dataset.testid),
  status: document.body.innerText.match(/CONNECTED|NEEDS FUNDING|CONNECTING|ERROR/i)?.[0] ?? 'unknown',
  cards: document.body.innerText.match(/Cards:\s*(\d+)/)?.[1] ?? '?',
  storedAddr: localStorage.getItem('aztec_account_address'),
  storedKeys: Object.keys(localStorage).filter(k => k.startsWith('aztec') || k.startsWith('triad')),
}));
console.log('\n  === app state ===');
console.log('    status  :', state.status, ' cards:', state.cards);
console.log('    address :', state.storedAddr ?? '(none)');
console.log('    storage :', state.storedKeys.join(', ') || '(empty)');
console.log('    testids :', state.testids.join(', '));
await browser.close();
