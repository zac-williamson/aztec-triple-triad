/**
 * Play a real game on the DEPLOYED app, as a new player, headless.
 *
 * Not the playtest harness: production has no testkit, so there is no
 * window.__triadTest to read state from and no getScreenXY to aim clicks with.
 * Everything here goes through the DOM the way a person's mouse would, against
 * https://www.aztec-arena.com and the live relay and bot.
 *
 * The only thing simulated is the wallet, backed by a throwaway Sepolia key
 * funded from the treasury — the user's own Chrome, their own browser engine,
 * but never their profile or their money.
 */
import { chromium, type Page } from '@playwright/test';
import { createFundedL1Account, refundTreasury, type InjectedWallet } from '../src/walletShim.js';

const SHOT = process.env.SHOT_DIR!;
const URL = 'https://www.aztec-arena.com';
const log = (m: string) => console.log(`   ${m}`);
let shotN = 0;
const shot = async (page: Page, name: string) => {
  await page.screenshot({ path: `${SHOT}/${String(++shotN).padStart(2, '0')}-${name}.png` });
  log(`— screenshot: ${name}`);
};

/** Wait for a predicate over the page's visible text. */
async function until(page: Page, what: string, re: RegExp, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const text = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (re.test(text)) return;
    await page.waitForTimeout(3000);
  }
  throw new Error(`timed out waiting for ${what} after ${ms / 1000}s`);
}

async function main() {
  let wallet: InjectedWallet | null = null;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    log('creating a funded Ethereum account (throwaway key)…');
    wallet = await createFundedL1Account({ log });

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await wallet.install(page);
    page.on('console', m => {
      const t = m.text();
      if (/error/i.test(m.type()) && !/404|OPFS/i.test(t)) log(`  [page] ${t.slice(0, 110)}`);
    });

    log(`opening ${URL} as a first-time visitor…`);
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await until(page, 'the app to boot', /First time here|Fund with My Wallet|Play/i, 120_000);
    await shot(page, 'landing');

    // Xochitl's tutorial prompt opens over everything, including the funding
    // button, so it has to go first — a real player meets it first too.
    if (await page.getByTestId('tutorial-skip').isVisible().catch(() => false)) {
      log('dismissing the tutorial prompt…');
      await page.getByTestId('tutorial-skip').click();
      await page.waitForTimeout(2000);
    }

    // Onboarding, if this profile has never funded an account. Wait for the app
    // to SETTLE first: preparing the account (wallet, keys, address) takes ~15s,
    // and checking before that reads a menu that has not decided anything yet.
    log('waiting for the app to decide whether it needs funding…');
    const settled = await Promise.race([
      page.getByTestId('fund-with-wallet').waitFor({ state: 'visible', timeout: 180_000 })
        .then(() => 'needs-funding' as const).catch(() => null),
      until(page, 'cards to appear', /Cards:\s*[1-9]/, 180_000)
        .then(() => 'already-funded' as const).catch(() => null),
    ]);
    log(`app settled: ${settled ?? 'neither — see screenshot'}`);
    await shot(page, 'after-tutorial');
    if (settled === 'needs-funding') {
      log('clicking "Fund with My Wallet" — mint, approve, bridge, deploy…');
      await page.getByTestId('fund-with-wallet').click();
      await shot(page, 'funding-started');
      await until(page, 'onboarding to finish', /Cards:\s*[1-9]/, 25 * 60_000);
      await shot(page, 'onboarded');
    }
    const cards = (await page.evaluate(() => document.body.innerText)).match(/Cards:\s*(\d+)/)?.[1];
    log(`onboarded — holding ${cards} cards`);

    log('queueing for a game on the live relay…');
    await page.getByTestId('menu-play').click();
    await page.waitForTimeout(3000);
    await shot(page, 'card-select');

    // The card selector wants five cards chosen before it will queue.
    const picks = await page.locator('[data-testid^="card-select-"]').all();
    for (const p of picks.slice(0, 5)) await p.click().catch(() => {});
    await page.waitForTimeout(1000);
    const confirm = page.getByRole('button', { name: /queue|play|confirm|find/i }).first();
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
    await shot(page, 'queued');

    log('waiting to be matched (the bot joins after 30s of nobody else)…');
    await until(page, 'a game to start', /Your Turn|Opponent's Turn/i, 8 * 60_000);
    await shot(page, 'in-game');
    log('matched — playing');

    // The board is a WebGL quad, not DOM: production ships no testkit, so there
    // is no getScreenXY to aim with and no cell element to click. Interpolate
    // the nine cell centres across the board's projected corners and verify by
    // whether the turn actually flipped — a click that misses is silent.
    const CORNERS = { bl: [515, 252], br: [920, 252], fl: [468, 658], fr: [985, 658] };
    const cellPoint = (r: number, c: number): [number, number] => {
      const u = (c + 0.5) / 3, v = (r + 0.5) / 3;
      const topX = CORNERS.bl[0] + u * (CORNERS.br[0] - CORNERS.bl[0]);
      const topY = CORNERS.bl[1] + u * (CORNERS.br[1] - CORNERS.bl[1]);
      const botX = CORNERS.fl[0] + u * (CORNERS.fr[0] - CORNERS.fl[0]);
      const botY = CORNERS.fl[1] + u * (CORNERS.fr[1] - CORNERS.fl[1]);
      return [topX + v * (botX - topX), topY + v * (botY - topY)];
    };
    const text = () => page.evaluate(() => document.body.innerText);

    for (let move = 0; move < 9; move++) {
      if (/Game Over/i.test(await text())) break;
      await until(page, 'my turn', /Your Turn|Game Over/i, 15 * 60_000);
      if (/Game Over/i.test(await text())) break;

      // Pick a card. The hand IS DOM, but there is no text that confirms a
      // selection: the hint reads "Select a card from your hand" purely while
      // ten cards remain across both hands, so it says that whether or not
      // anything is selected. Treating it as a selection signal is what made an
      // earlier run give up on a click that had probably worked. The turn
      // flipping is the only honest confirmation, so that is what we check.
      const hand = await page.locator('[data-testid^="card-"]').all();
      if (!hand.length) { log('no hand cards in the DOM — stopping'); await shot(page, 'no-hand'); break; }
      await hand[0].click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(900);

      // Try each empty-looking cell until the turn flips.
      let placed = false;
      for (let r = 0; r < 3 && !placed; r++) {
        for (let c = 0; c < 3 && !placed; c++) {
          const [x, y] = cellPoint(r, c);
          await page.mouse.click(x, y);
          await page.waitForTimeout(2500);
          if (/Opponent's Turn|Game Over/i.test(await text())) {
            placed = true;
            log(`played move ${move + 1} at cell [${r},${c}]`);
          }
        }
      }
      if (!placed) { await shot(page, `stuck-move-${move + 1}`); log('no cell accepted a card — stopping'); break; }
      await page.waitForTimeout(3000);
    }

    await until(page, 'the game to end', /Game Over/i, 20 * 60_000);
    await shot(page, 'game-over');
    const final = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 400));
    log(`game over — ${final.slice(0, 200)}`);
  } finally {
    await browser.close();
    if (wallet) await refundTreasury(wallet.privateKey, log);
  }
}

main().catch(async err => { console.error('\n  FAILED:', err.message); process.exit(1); });
