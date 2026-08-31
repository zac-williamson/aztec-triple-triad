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
/** Play badly on purpose, so the bot wins and the winner/loser path runs. */
const PLAY_TO_LOSE = process.env.E2E_PLAY_TO_LOSE === '1';
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
  let page: Awaited<ReturnType<Awaited<ReturnType<typeof browser.newContext>>['newPage']>> | null = null;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    log('creating a funded Ethereum account (throwaway key)…');
    wallet = await createFundedL1Account({ log });

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await ctx.newPage();
    await wallet.install(page);
    // Capture the on-chain pipeline as well as errors: when a game stalls, the
    // question is always which half of the create/join handshake did not
    // happen, and guessing at that has cost several runs.
    page.on('console', m => {
      const t = m.text();
      if (/\[(useGameSession|txManager)\]/.test(t)) log(`  ${t.slice(0, 150)}`);
      else if (/error/i.test(m.type()) && !/404|OPFS/i.test(t)) log(`  [page] ${t.slice(0, 110)}`);
    });
    // Proving is the slow step and headless has no GPU; give it real threads.
    await page.addInitScript({
      content: `localStorage.setItem('triad_proof_threads','${process.env.PROOF_THREADS ?? '6'}')`,
    });

    log(`opening ${URL} as a first-time visitor…`);
    await page.goto(`${URL}/?e2e=1`, { waitUntil: 'domcontentloaded' });
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
    await until(page, 'a game to start', /Your Turn|Opponent's Turn/i, 35 * 60_000);
    await shot(page, 'in-game');
    log('matched — playing');

    let moves = 0;
    // Drive through the testkit, the same way the playtest harness does.
    // Guessing at pixels was the wrong approach twice over: the board is a
    // WebGL quad and the hand is a 3D FAN laid out with sin(angle), so neither
    // has a stable screen position that can be computed from outside. The app
    // already knows where its own cells are; ask it.
    const phase = () => page!.evaluate(() => window.__triadTest!.phase());
    const screenXY = (t: unknown) =>
      page!.evaluate(target => window.__triadTest!.getScreenXY(target as never), t);

    for (let move = 0; move < 9; move++) {
      const before = await phase();
      if (before?.ws.gameOver || before?.game?.status !== 'playing') break;

      // Wait for a genuinely idle turn: my turn, nothing selected, no card in
      // flight and no capture animation running.
      const ready = await page.waitForFunction(() => {
        const p = window.__triadTest?.phase();
        return !!p && (p.ws.gameOver !== null || (
          p.game?.status === 'playing' && p.game.isMyTurn &&
          p.interaction !== null && !p.interaction.flying && !p.interaction.cascading &&
          p.interaction.selectedCardIndex === null
        ));
      }, undefined, { timeout: 15 * 60_000, polling: 1000 }).then(() => true).catch(() => false);
      if (!ready) { log('never became ready to move'); break; }
      if ((await phase())?.ws.gameOver) break;

      // Which empty cell to take.
      //
      // Reading order tends to produce draws, and a draw is the UNUSUAL
      // settlement path — single settler, nothing changes hands. The common
      // case is a winner claiming a card and handing the rest back, which is
      // different code. PLAY_TO_LOSE takes the most exposed square instead, so
      // the bot wins and that path gets exercised.
      const board = (await phase())!.game!.board;
      const empties: { row: number; col: number; exposure: number }[] = [];
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          if (board[r][c].cardId !== null) continue;
          let exposure = 0;
          for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
            const nr = r + dr, nc = c + dc;
            if (nr < 0 || nc < 0 || nr > 2 || nc > 2) continue;
            exposure += 1;
            if (board[nr][nc].owner === 'player2') exposure += 2;
          }
          empties.push({ row: r, col: c, exposure });
        }
      }
      if (empties.length === 0) break;
      const target = PLAY_TO_LOSE
        ? empties.reduce((a, b) => (b.exposure > a.exposure ? b : a))
        : empties[0];

      const hand = await screenXY({ type: 'hand', index: 0 });
      if (!hand) { log('hand slot 0 not projectable'); break; }
      await page.mouse.click(hand.x, hand.y);
      await page.waitForTimeout(600);

      const cell = await screenXY({ type: 'cell', row: target.row, col: target.col });
      if (!cell) { log(`cell [${target.row},${target.col}] not projectable`); break; }
      await page.mouse.click(cell.x, cell.y);

      // Confirmed by the board itself, not by a turn indicator that can flip
      // for reasons of its own.
      const wanted = board.flat().filter(c => c.cardId !== null).length + 1;
      const landed = await page.waitForFunction(n => {
        const p = window.__triadTest?.phase();
        if (!p) return false;
        if (p.ws.gameOver) return true;
        return (p.game?.board.flat().filter(c => c.cardId !== null).length ?? 0) >= n;
      }, wanted, { timeout: 5 * 60_000, polling: 1000 }).then(() => true).catch(() => false);
      if (!landed) { log(`move ${move + 1} did not land on [${target.row},${target.col}]`); break; }

      moves += 1;
      const now = (await phase())!;
      log(`move ${moves}: cell [${target.row},${target.col}] — board now ` +
        `${now.game?.board.flat().filter(c => c.cardId !== null).length ?? '?'}/9`);
    }

    await until(page, 'the game to end', /Game Over/i, 20 * 60_000);
    await shot(page, 'game-over');
    const result = (await phase())!;
    const winner = result.ws.gameOver?.winner ?? 'unknown';
    log(`game over: ${winner} — board ${result.game?.board.flat().filter(c => c.cardId !== null).length}/9`);

    // Settlement is the point of the wager, and the winner's half is the
    // common case: claim a card, hand the rest back. Stopping at "Game Over"
    // proved the game, not the settlement.
    const iWon = winner === 'player1';
    if (iWon) {
      // The claim buttons ARE DOM (settle-card-<id>), unlike the board.
      const claimable = await page.locator('[data-testid^="settle-card-"]').all();
      if (claimable.length === 0) { log('no claimable card offered'); }
      else {
        const id = await claimable[0].getAttribute('data-testid');
        log(`claiming ${id?.replace('settle-card-', 'card ')} and settling…`);
        await claimable[0].click();
        const settled = await page.waitForFunction(() => {
          const p = window.__triadTest?.phase();
          return p?.chain.settleTxStatus === 'confirmed';
        }, undefined, { timeout: 25 * 60_000, polling: 2000 }).then(() => true).catch(() => false);
        log(settled ? 'settlement CONFIRMED on-chain' : 'settlement did not confirm in time');
        await shot(page, 'settled');
      }
    } else {
      log('the bot won — waiting for it to settle and hand our cards back');
      const got = await page.waitForFunction(() => {
        const p = window.__triadTest?.phase();
        return p?.chain.opponentSettled === true && p.chain.takenCardId !== null;
      }, undefined, { timeout: 25 * 60_000, polling: 2000 }).then(() => true).catch(() => false);
      log(got ? 'opponent settled and returned our cards' : 'opponent settlement not observed');
      await shot(page, 'settled');
    }

    // Poll for the card list to SETTLE. Reading it the instant settlement is
    // announced catches the window between the old notes being spent and the
    // re-minted ones being imported, which reads as zero cards — a correct run
    // and a catastrophic one look identical there. A winner ends with six, a
    // loser with four; anything else is real and worth failing on.
    const want = iWon ? 6 : 4;
    const reached = await page.waitForFunction(n => {
      const p = window.__triadTest?.phase();
      return (p?.ownedCardIds.length ?? 0) === n;
    }, want, { timeout: 10 * 60_000, polling: 2000 }).then(() => true).catch(() => false);

    const end = (await phase())!;
    const finalCards = [...end.ownedCardIds].sort((a, b) => a - b);
    log(`final: ${end.ownedCardIds.length} cards [${finalCards}], ${end.tokenBalance} tokens` +
      (reached ? '' : `  — EXPECTED ${want}, the wager did not complete`));
    if (!reached) { await shot(page, 'cards-missing'); process.exitCode = 1; }
  } finally {
    // Leave the game rather than just closing the tab. An abandoned game holds
    // the bot until its 30-minute watchdog fires, and with one bot that is
    // thirty minutes in which nobody in the arena can get an opponent. Three
    // failed runs of this script cost ninety.
    try {
      const leave = page!.getByRole('button', { name: /Leave/i }).first();
      if (await leave.isVisible({ timeout: 3000 }).catch(() => false)) {
        await leave.click({ timeout: 5000 });
        log('left the game so the bot is free immediately');
        await page!.waitForTimeout(3000);
      }
    } catch { /* best effort: the browser may already be gone */ }
    await browser.close();
    if (wallet) await refundTreasury(wallet.privateKey, log);
  }
}

main().catch(async err => { console.error('\n  FAILED:', err.message); process.exit(1); });
