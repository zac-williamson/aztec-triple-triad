/**
 * Two real players, two browsers, one game on the DEPLOYED app.
 *
 * Every production run so far has been human-vs-bot, and the bot is not a
 * stand-in for a person on the settlement path: it RELAYS the settlement note
 * data that lets the loser import their returned cards and their +20 reward.
 * Between two people that relay is the winner's browser, and that code has
 * only ever run against a local sandbox. If it is broken, the loser silently
 * ends the game four cards down and twenty tokens short.
 *
 * So this drives both sides and checks both sides. The bot must not be in the
 * game at all — proven by both of MY pages reporting the same on-chain game id
 * as player 1 and player 2, not inferred from the absence of a bot.
 *
 *   SHOT_DIR=/tmp/pvp npx tsx packages/playtest/scripts/prod-pvp.mts
 */
import { chromium, type Browser, type Page } from '@playwright/test';
import { createFundedL1Account, refundTreasury, type InjectedWallet } from '../src/walletShim.js';

const URL = 'https://www.aztec-arena.com';
const SHOT = process.env.SHOT_DIR!;
/** Two browsers proving at once on a 12-core box; leave the machine some room. */
const PROOF_THREADS = process.env.PROOF_THREADS ?? '5';
const STARTER_TOKENS = 100, GAME_REWARD = 20;

let shotN = 0;
/** Seats that have money in them, for the interrupt path below. */
const liveSeats: Seat[] = [];
let shuttingDown = false;

/**
 * Take the interrupt back from Playwright, which installs a process-level
 * SIGINT handler that exits with 130 once its browsers are down — regardless
 * of `handleSIGINT`, which only decides which browsers it closes. Left alone,
 * it kills the refunds mid-RPC and strands two funded accounts per interrupted
 * run. Must be called AFTER the first browser launch, since that is when
 * Playwright installs its handlers.
 */
function ownShutdownSignals(): void {
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.removeAllListeners(sig);
    process.on(sig, () => {
      if (shuttingDown) process.exit(130);
      shuttingDown = true;
      console.log(`   interrupted by ${sig} — refunding both seats before exit`);
      void (async () => {
        // Refund first: `browser.close()` on an interrupted run often never
        // settles, and node exits silently once nothing holds the event loop.
        for (const s of liveSeats) {
          if (s.wallet) await refundTreasury(s.wallet.privateKey, m => s.log(m));
        }
        await Promise.race([
          Promise.all(liveSeats.map(s => s.browser?.close().catch(() => {}))),
          new Promise(r => setTimeout(r, 5_000)),
        ]);
        process.exit(130);
      })();
    });
  }
}

/** One person: their browser, their throwaway wallet, their view of the game. */
class Seat {
  browser!: Browser;
  page!: Page;
  wallet!: InjectedWallet;
  constructor(readonly name: string) {}

  log(m: string) { console.log(`   [${this.name}] ${m}`); }

  async shot(tag: string) {
    await this.page.screenshot({ path: `${SHOT}/${String(++shotN).padStart(2, '0')}-${this.name}-${tag}.png` })
      .catch(() => {});
  }

  phase() { return this.page.evaluate(() => window.__triadTest?.phase() ?? null); }

  screenXY(target: unknown) {
    return this.page.evaluate(t => window.__triadTest!.getScreenXY(t as never), target);
  }

  /** Wait for a predicate over the page's own state snapshot. */
  async waitFor(what: string, fn: string, ms: number): Promise<boolean> {
    return this.page.waitForFunction(fn, undefined, { timeout: ms, polling: 1000 })
      .then(() => true)
      .catch(() => { this.log(`timed out waiting for ${what} after ${Math.round(ms / 1000)}s`); return false; });
  }

  async open(wallet: InjectedWallet) {
    this.wallet = wallet;
    this.browser = await chromium.launch({
      channel: 'chrome', headless: true,
      handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
    });
    const ctx = await this.browser.newContext({ viewport: { width: 1280, height: 820 } });
    this.page = await ctx.newPage();
    liveSeats.push(this);
    ownShutdownSignals();
    await wallet.install(this.page);
    this.page.on('console', m => {
      const t = m.text();
      if (/\[(useGameSession|useGameSettlement)\]/.test(t)) this.log(`  ${t.slice(0, 150)}`);
      else if (/error/i.test(m.type()) && !/404|OPFS/i.test(t)) this.log(`  [page] ${t.slice(0, 120)}`);
    });
    await this.page.addInitScript({
      content: `localStorage.setItem('triad_proof_threads','${PROOF_THREADS}')`,
    });
    await this.page.goto(`${URL}/?e2e=1`, { waitUntil: 'domcontentloaded' });
  }

  /** From a cold profile to five cards in hand. */
  async onboard() {
    await this.waitFor('the app to boot',
      `!!document.body.innerText.match(/First time here|Fund with My Wallet|Play/i)`, 120_000);
    if (await this.page.getByTestId('tutorial-skip').isVisible().catch(() => false)) {
      await this.page.getByTestId('tutorial-skip').click();
      await this.page.waitForTimeout(2000);
    }
    // The app takes ~15s to prepare keys before it knows whether it needs
    // funding; asking sooner reads a menu that has not decided anything.
    const needsFunding = await Promise.race([
      this.page.getByTestId('fund-with-wallet').waitFor({ state: 'visible', timeout: 180_000 })
        .then(() => true).catch(() => null),
      this.page.waitForFunction(() => /Cards:\s*[1-9]/.test(document.body.innerText),
        undefined, { timeout: 180_000, polling: 2000 }).then(() => false).catch(() => null),
    ]);
    if (needsFunding) {
      this.log('funding: mint, approve, bridge, deploy…');
      await this.page.getByTestId('fund-with-wallet').click();
      const ok = await this.waitFor('onboarding to finish',
        `/Cards:\\s*[1-9]/.test(document.body.innerText)`, 25 * 60_000);
      if (!ok) { await this.shot('onboard-stuck'); throw new Error(`${this.name}: never finished onboarding`); }
    }
    const p = await this.phase();
    this.log(`onboarded — ${p?.ownedCardIds.length} cards, ${p?.tokenBalance} tokens`);
    await this.shot('onboarded');
    return p!;
  }

  /** Pick five cards and join the queue. */
  async queue() {
    await this.page.getByTestId('menu-play').click();
    await this.page.waitForTimeout(3000);
    const picks = await this.page.locator('[data-testid^="card-select-"]').all();
    for (const c of picks.slice(0, 5)) await c.click().catch(() => {});
    await this.page.waitForTimeout(800);
    const confirm = this.page.getByRole('button', { name: /queue|play|confirm|find/i }).first();
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
    this.log('queued');
  }

  /** Place hand[0] on a cell, confirmed by the board rather than a turn flag. */
  async play(row: number, col: number, filledBefore: number): Promise<boolean> {
    const hand = await this.screenXY({ type: 'hand', index: 0 });
    if (!hand) { this.log('hand slot 0 not projectable'); return false; }
    await this.page.mouse.click(hand.x, hand.y);
    await this.page.waitForTimeout(600);
    const cell = await this.screenXY({ type: 'cell', row, col });
    if (!cell) { this.log(`cell [${row},${col}] not projectable`); return false; }
    await this.page.mouse.click(cell.x, cell.y);
    return this.page.waitForFunction(n => {
      const p = window.__triadTest?.phase();
      if (!p) return false;
      if (p.ws.gameOver) return true;
      return (p.game?.board.flat().filter(c => c.cardId !== null).length ?? 0) >= n;
    }, filledBefore + 1, { timeout: 5 * 60_000, polling: 1000 }).then(() => true).catch(() => false);
  }

  async close() {
    // Leaving is not politeness: an abandoned game holds the other side's
    // client and, if the bot were ever in it, the whole arena for 30 minutes.
    try {
      const leave = this.page.getByRole('button', { name: /Leave/i }).first();
      if (await leave.isVisible({ timeout: 3000 }).catch(() => false)) await leave.click({ timeout: 5000 });
    } catch { /* the page may already be gone */ }
    // Bounded: `browser.close()` does not reliably settle after a page has been
    // through a settlement, and an unbounded await here wedged a completed run
    // — every assertion done, nothing printed, and the accounts never refunded.
    await Promise.race([
      this.browser?.close().catch(() => {}) ?? Promise.resolve(),
      new Promise(r => setTimeout(r, 15_000)),
    ]);
  }
}

/** Multiset difference: what is in `a` that `b` does not also account for. */
function without(a: number[], b: number[]): number[] {
  const rest = [...b];
  const out: number[] = [];
  for (const id of a) {
    const i = rest.indexOf(id);
    if (i === -1) out.push(id);
    else rest.splice(i, 1);
  }
  return out;
}

/**
 * Where to play next.
 *
 * A draw settles with a single settler and nothing changes hands, which is
 * exactly the path this test is NOT trying to prove, so the two seats play
 * asymmetrically: one takes corners (fewest attackable sides), the other takes
 * the square with the most opponent-owned neighbours. That reliably produces a
 * winner without needing card statistics the snapshot does not carry.
 */
function chooseCell(
  board: { cardId: number | null; owner: string | null }[][],
  opponent: string,
  style: 'strong' | 'weak',
): { row: number; col: number } | null {
  const empties: { row: number; col: number; sides: number; exposed: number }[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      if (board[r][c].cardId !== null) continue;
      let sides = 0, exposed = 0;
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nc < 0 || nr > 2 || nc > 2) continue;
        sides += 1;
        if (board[nr][nc].owner === opponent) exposed += 1;
      }
      empties.push({ row: r, col: c, sides, exposed });
    }
  }
  if (empties.length === 0) return null;
  const best = style === 'strong'
    ? empties.reduce((a, b) => (b.sides < a.sides ? b : a))            // corners first
    : empties.reduce((a, b) => (b.exposed > a.exposed ? b : a));       // walk into fire
  return { row: best.row, col: best.col };
}

async function main() {
  const seats = [new Seat('north'), new Seat('south')];
  let failed: string | null = null;
  try {
    // Sequentially: both funding transactions come from the SAME treasury key,
    // and viem reads the pending nonce per call — two in flight at once and one
    // silently replaces the other.
    console.log('   funding two throwaway Ethereum accounts (sequentially — one treasury nonce)…');
    const wallets: InjectedWallet[] = [];
    for (const s of seats) {
      wallets.push(await createFundedL1Account({ log: m => s.log(m) }));
    }

    await Promise.all(seats.map((s, i) => s.open(wallets[i])));
    // Again after both launches: the two `open` calls race, and whichever
    // Playwright launch finishes last reinstalls the handlers we just removed.
    ownShutdownSignals();
    // Onboarding is mostly waiting on L1 and L2, so the two overlap happily.
    await Promise.all(seats.map(s => s.onboard()));

    // Queue both inside the bot's 30s patience window. Even if the bot did
    // queue, the relay prefers a human joiner — but not racing it at all is
    // simpler than relying on that.
    console.log('   queueing both seats within the bot\'s 30s window…');
    await seats[0].queue();
    await seats[1].queue();

    const matched = await Promise.all(seats.map(s =>
      s.waitFor('a game to start', `(() => { const p = window.__triadTest?.phase();
        return !!p && p.game?.status === 'playing' && p.ws.gameId !== null; })()`, 5 * 60_000)));
    if (matched.some(m => !m)) throw new Error('the two seats were never matched into a game');

    // The proof that this is player-vs-player: both of MY browsers are in the
    // SAME game, holding the two different seats. The bot cannot also be in it.
    const [a, b] = await Promise.all(seats.map(s => s.phase()));
    const nums = [a!.ws.playerNumber, b!.ws.playerNumber].sort();
    if (a!.ws.gameId !== b!.ws.gameId) {
      throw new Error(`not the same game: ${a!.ws.gameId} vs ${b!.ws.gameId} — one seat matched something else`);
    }
    if (nums[0] !== 1 || nums[1] !== 2) throw new Error(`seats are not player 1 and 2: ${nums}`);
    console.log(`   MATCHED player-vs-player in ${a!.ws.gameId} — ` +
      `north is player ${a!.ws.playerNumber}, south is player ${b!.ws.playerNumber}`);
    const startCards = { north: a!.ownedCardIds.slice(), south: b!.ownedCardIds.slice() };
    await Promise.all(seats.map(s => s.shot('matched')));

    // North plays corners, south walks into fire, so somebody wins.
    const style: Record<string, 'strong' | 'weak'> = { north: 'strong', south: 'weak' };

    // `stalls` bounds the retry path below: a seat that keeps reporting no
    // turn must not spin the loop forever on a 9-move game.
    let stalls = 0;
    for (let move = 0; move < 9; move++) {
      // Whichever seat has the turn plays it. Asking the board who is next is
      // more robust than assuming strict alternation across two browsers.
      const snaps = await Promise.all(seats.map(s => s.phase()));
      if (snaps.some(p => p?.ws.gameOver)) break;
      const idx = snaps.findIndex(p => p?.game?.status === 'playing' && p.game.isMyTurn);
      if (idx === -1) {
        const ok = await Promise.race(seats.map((s, i) =>
          s.waitFor('a turn', `(() => { const p = window.__triadTest?.phase();
            return !!p && (p.ws.gameOver !== null || (p.game?.status === 'playing' && p.game.isMyTurn)); })()`,
            10 * 60_000).then(v => (v ? i : -1))));
        if (ok === -1) { failed = 'neither seat ever got a turn'; break; }
        if (++stalls > 9) { failed = 'the turn never came round to a seat that could play it'; break; }
        move -= 1;
        continue;
      }
      const seat = seats[idx];
      const snap = snaps[idx]!;

      // Only move on a genuinely idle turn — nothing selected, no card in
      // flight, no capture animation still running.
      const ready = await seat.waitFor('an idle turn',
        `(() => { const p = window.__triadTest?.phase();
          return !!p && (p.ws.gameOver !== null || (p.game?.status === 'playing' && p.game.isMyTurn &&
            p.interaction !== null && !p.interaction.flying && !p.interaction.cascading &&
            p.interaction.selectedCardIndex === null)); })()`, 10 * 60_000);
      if (!ready) { failed = `${seat.name} never became ready to move`; break; }

      const me = snap.ws.playerNumber === 1 ? 'player1' : 'player2';
      const opponent = me === 'player1' ? 'player2' : 'player1';
      const board = (await seat.phase())!.game!.board;
      const filled = board.flat().filter(c => c.cardId !== null).length;
      const target = chooseCell(board, opponent, style[seat.name]);
      if (!target) break;

      if (!(await seat.play(target.row, target.col, filled))) {
        failed = `${seat.name}'s move to [${target.row},${target.col}] never landed`;
        break;
      }
      const after = (await seat.phase())!;
      console.log(`   move ${move + 1}: ${seat.name} → [${target.row},${target.col}] — ` +
        `board ${after.game?.board.flat().filter(c => c.cardId !== null).length ?? '?'}/9, ` +
        `score ${after.game?.myScore}-${after.game?.opponentScore}`);
    }
    if (failed) throw new Error(failed);

    const over = await Promise.all(seats.map(s =>
      s.waitFor('the game to end', `!!window.__triadTest?.phase()?.ws.gameOver`, 15 * 60_000)));
    if (over.some(o => !o)) throw new Error('the game never reached Game Over on both sides');
    await Promise.all(seats.map(s => s.shot('game-over')));

    const ends = await Promise.all(seats.map(s => s.phase()));
    const winner = ends[0]!.ws.gameOver!.winner;
    console.log(`   game over: ${winner}`);

    // Settlement. The winner claims a card and their process_game mints the
    // loser's reward and hands the rest back; the loser has to be TOLD, by the
    // winner's browser, which notes to import. That relay is the point.
    const winnerSeat = winner === 'draw' ? null
      : seats[ends.findIndex(p => (p!.ws.playerNumber === 1 ? 'player1' : 'player2') === winner)];
    const loserSeat = winnerSeat ? seats[1 - seats.indexOf(winnerSeat)] : null;

    if (winnerSeat && loserSeat) {
      const claimable = await winnerSeat.page.locator('[data-testid^="settle-card-"]').all();
      if (claimable.length === 0) throw new Error(`${winnerSeat.name} won but was offered no card to claim`);
      const claimed = Number((await claimable[0].getAttribute('data-testid'))!.replace('settle-card-', ''));
      winnerSeat.log(`won — claiming card ${claimed}`);
      await claimable[0].click();

      const confirmed = await winnerSeat.waitFor('the settlement tx',
        `window.__triadTest?.phase()?.chain.settleTxStatus === 'confirmed'`, 25 * 60_000);
      if (!confirmed) { await winnerSeat.shot('settle-stuck'); throw new Error('the winner never confirmed settlement'); }
      winnerSeat.log('settlement CONFIRMED on-chain');

      // The loser learns about it only through the winner's relay.
      const told = await loserSeat.waitFor('the settlement relay',
        `(() => { const p = window.__triadTest?.phase();
          return p?.chain.opponentSettled === true && p.chain.takenCardId !== null; })()`, 15 * 60_000);
      if (!told) { await loserSeat.shot('relay-missing'); throw new Error('the loser was never told the game settled'); }
      loserSeat.log(`told: the winner took card ${(await loserSeat.phase())!.chain.takenCardId}`);

      const settledWin = await winnerSeat.waitFor('the winner\'s six cards',
        `window.__triadTest?.phase()?.ownedCardIds.length === 6`, 10 * 60_000);
      const settledLose = await loserSeat.waitFor('the loser\'s four cards',
        `window.__triadTest?.phase()?.ownedCardIds.length === 4`, 10 * 60_000);
      const [wEnd, lEnd] = await Promise.all([winnerSeat.phase(), loserSeat.phase()]);

      // Conservation: the exact card the loser no longer has is the one the
      // winner now does. Counting to six and four would pass if the contract
      // minted a card and burned another.
      // Multiset, not set: the winner here already held a card 1 and won a
      // SECOND one, so a `!includes` comparison saw no gain at all and called
      // a correct settlement a failure. Duplicates are normal — the bot wagers
      // duplicate starter cards by design.
      const lost = without(startCards[loserSeat.name as 'north' | 'south'], lEnd!.ownedCardIds);
      const gained = without(wEnd!.ownedCardIds, startCards[winnerSeat.name as 'north' | 'south']);
      const problems: string[] = [];
      if (!settledWin) problems.push(`winner holds ${wEnd!.ownedCardIds.length} cards, expected 6`);
      if (!settledLose) problems.push(`loser holds ${lEnd!.ownedCardIds.length} cards, expected 4`);
      if (lost.length !== 1 || gained.length !== 1 || lost[0] !== gained[0]) {
        problems.push(`the wagered card did not change hands: loser lost [${lost}], winner gained [${gained}]`);
      } else {
        console.log(`   card ${lost[0]} moved from ${loserSeat.name} to ${winnerSeat.name}`);
      }
      // Both sides earn the reward; the loser's is minted by the winner's tx
      // and imported off the same relay, so it fails separately from the cards.
      for (const [s, p] of [[winnerSeat, wEnd] as const, [loserSeat, lEnd] as const]) {
        const want = STARTER_TOKENS + GAME_REWARD;
        if ((p!.tokenBalance ?? 0) < want) {
          const got = await s.waitFor(`${s.name}'s +${GAME_REWARD} reward`,
            `(window.__triadTest?.phase()?.tokenBalance ?? 0) >= ${want}`, 6 * 60_000);
          if (!got) problems.push(`${s.name} holds ${(await s.phase())!.tokenBalance} tokens, expected ${want}`);
        }
      }
      // Report from a FRESH read, not from the snapshot the checks ran against.
      // The loser's reward lands on its own clock — the token note needs a PXE
      // block sync, so it arrives after the cards — and reporting the earlier
      // snapshot printed `loser_tokens=100` on a run that had waited for, and
      // seen, 120. A verdict line that disagrees with its own verdict is worse
      // than no verdict line.
      const [wFinal, lFinal] = await Promise.all([winnerSeat.phase(), loserSeat.phase()]);
      console.log(`   ${winnerSeat.name}: ${wFinal!.ownedCardIds.length} cards ` +
        `[${[...wFinal!.ownedCardIds].sort((x, y) => x - y)}], ${wFinal!.tokenBalance} tokens`);
      console.log(`   ${loserSeat.name}: ${lFinal!.ownedCardIds.length} cards ` +
        `[${[...lFinal!.ownedCardIds].sort((x, y) => x - y)}], ${lFinal!.tokenBalance} tokens`);

      if (problems.length) throw new Error(problems.join('; '));
      console.log('\n   PASS — two people played and settled a game on production.');
      // Same fixed-shape verdict prod-play prints, so a caller never has to
      // pattern-match prose to find out whether this worked.
      console.log(`RESULT: pass winner=${winner} moved=${lost[0]} ` +
        `winner_cards=${wFinal!.ownedCardIds.length} loser_cards=${lFinal!.ownedCardIds.length} ` +
        `winner_tokens=${wFinal!.tokenBalance} loser_tokens=${lFinal!.tokenBalance}`);
    } else {
      // A draw settles with a single settler and nothing changes hands, so it
      // proves the game but NOT the transfer this test exists for.
      const done = await Promise.all(seats.map(s => s.waitFor('the draw to settle',
        `(() => { const p = window.__triadTest?.phase();
          return p?.chain.settleTxStatus === 'confirmed' || p?.chain.opponentSettled === true; })()`,
        25 * 60_000)));
      const held = await Promise.all(seats.map(s => s.phase()));
      console.log(`   drew — north ${held[0]!.ownedCardIds.length} cards, south ${held[1]!.ownedCardIds.length}`);
      if (done.some(d => !d)) throw new Error('the draw never settled');
      if (held.some(p => p!.ownedCardIds.length !== 5)) throw new Error('a draw must leave both sides holding five');
      throw new Error('the game drew — settlement is proven but the card transfer is not; re-run');
    }
  } finally {
    if (!shuttingDown) {
      await Promise.all(seats.map(s => s.close()));
      for (const s of seats) if (s.wallet) await refundTreasury(s.wallet.privateKey, m => s.log(m));
    }
  }
}

main().catch(err => {
  console.error('\n  FAILED:', err.message);
  console.log(`RESULT: fail ${err.message}`);
  process.exit(1);
});
