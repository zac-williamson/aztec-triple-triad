/**
 * PlayerDriver — drives one browser context through the real UI: DOM screens
 * via selectors, the 3D board via real pointer events at testkit-projected
 * coordinates, and waits on app state (never wall-clock sleeps).
 */
import type { Page } from '@playwright/test';
import { createWriteStream, type WriteStream } from 'fs';
import { resolve } from 'path';
import type { PhaseSnapshot, ClickTarget } from '../../frontend/src/testkit/contract.js';
import { FRONTEND_URL } from './env.js';

declare global {
  interface Window {
    __triadTest?: import('../../frontend/src/testkit/contract.js').TriadTestApi;
  }
}

const POLL_MS = 250;

export const TIMEOUTS = {
  install: 120_000,      // first boot after an SDK bump cold-optimizes the @aztec deps in-browser
  wsConnect: 30_000,
  onboarding: 420_000,      // L1 bridge wait + deploy+mint tx + note import
  match: 60_000,
  selection: 10_000,
  boardUpdate: 30_000,
  interactionIdle: 60_000,  // capture cascades run ~1s per flip
  canSettle: 1_200_000,     // all 9 move proofs + 2 hand proofs (real proving)
  settleTx: 1_800_000,      // process_game: 11 recursive verifications, client-proved
  packTx: 600_000,          // purchase_card_pack: tx proving + 10-note import
  pxeRead: 180_000,         // hard backstop for a single PXE read; a true hang fails fatally, never masked
  evaluate: 30_000,         // a bare page.evaluate (phase snapshot) must not hang the run
  eventually: 180_000,      // private-state eventual consistency (PXE note discovery) after a tx
};

export class PlayerDriver {
  private consoleLog: WriteStream | null = null;

  constructor(readonly name: string, readonly page: Page) {}

  /** Navigate, capture console/page errors to the artifacts dir, skip the tutorial. */
  async boot(logsDir: string): Promise<void> {
    this.consoleLog = createWriteStream(resolve(logsDir, `browser-${this.name}.log`));
    this.page.on('console', msg =>
      this.consoleLog!.write(`[${new Date().toISOString()}] [${msg.type()}] ${msg.text()}\n`));
    this.page.on('pageerror', err =>
      this.consoleLog!.write(`[${new Date().toISOString()}] [pageerror] ${err.stack ?? err.message}\n`));

    await this.page.goto(FRONTEND_URL);
    await this.page.waitForFunction(() => !!window.__triadTest, undefined, {
      timeout: TIMEOUTS.install, polling: POLL_MS,
    });
    // First visit shows the tutorial prompt once the funding gate clears.
    await this.page.getByTestId('tutorial-skip').click({ timeout: TIMEOUTS.wsConnect });
  }

  async phase(): Promise<PhaseSnapshot> {
    // Even the synchronous snapshot is a page.evaluate; if the page's JS event
    // loop is blocked (e.g. an IndexedDB conflict from the app's unqueued
    // get_balance poll racing a PXE read) the evaluate never returns. Bound it.
    const snapshot = await this.withTimeout(
      this.page.evaluate(() => window.__triadTest!.phase()), TIMEOUTS.evaluate, 'phase()');
    if (!snapshot) throw new Error(`${this.name}: testkit bridge has not published yet`);
    return snapshot;
  }

  /**
   * Wait until a phase-snapshot predicate holds; on timeout, rethrow with the
   * live snapshot. The predicate is serialized into the page, so it MUST NOT
   * close over outer variables — pass them via `args` instead.
   */
  async waitPhase<A>(
    label: string,
    predicate: (p: PhaseSnapshot, args: A) => boolean,
    timeout: number,
    args?: A,
  ): Promise<PhaseSnapshot> {
    try {
      await this.page.waitForFunction(
        (input: { src: string; args: unknown }) => {
          const t = window.__triadTest;
          if (!t) return false;
          const p = t.phase();
          if (!p) return false;
          // eslint-disable-next-line no-new-func
          return (new Function('p', 'args', `return (${input.src})(p, args)`))(p, input.args);
        },
        { src: predicate.toString(), args: args as unknown },
        { timeout, polling: POLL_MS },
      );
    } catch (err) {
      const snapshot = await this.phase().catch(() => null);
      throw new Error(
        `${this.name}: timed out waiting for "${label}" after ${timeout / 1000}s\n` +
        `last phase: ${JSON.stringify(snapshot, null, 2)}\n${err}`,
      );
    }
    return this.phase();
  }

  /** Onboarding end state: wallet connected and the 5 starter cards imported. */
  async waitConnected(): Promise<PhaseSnapshot> {
    return this.waitPhase(
      'aztec connected with starter cards',
      p => p.aztecStatus === 'connected' && p.ownedCardIds.length >= 5 && p.ws.connected,
      TIMEOUTS.onboarding,
    );
  }

  /** Main menu → card selector → pick the 5 cards → queue for matchmaking. */
  async startMatchmaking(cardIds: number[]): Promise<void> {
    await this.page.getByTestId('menu-play').click();
    for (const id of [...new Set(cardIds)]) {
      const copies = cardIds.filter(c => c === id).length;
      for (let i = 0; i < copies; i++) {
        await this.page.getByTestId(`card-select-${id}`).click();
      }
    }
    await this.page.getByTestId('hand-confirm').click();
  }

  async waitInGame(): Promise<PhaseSnapshot> {
    return this.waitPhase(
      'matched into game screen',
      p => p.screen === 'game' && p.game !== null && p.ws.playerNumber !== null,
      TIMEOUTS.match,
    );
  }

  /**
   * Interaction gate: my turn, game playing, no selection, and no fly/capture
   * animation — held over several consecutive polls so the click cannot land
   * in the gap between an incoming board update and its animation kickoff.
   */
  async waitReadyToMove(): Promise<void> {
    const deadline = Date.now() + TIMEOUTS.interactionIdle;
    let stable = 0;
    while (Date.now() < deadline) {
      const p = await this.phase();
      const idle = p.game !== null
        && p.game.status === 'playing'
        && p.game.isMyTurn
        && p.interaction !== null
        && !p.interaction.flying
        && !p.interaction.cascading
        && p.interaction.selectedCardIndex === null;
      stable = idle ? stable + 1 : 0;
      if (stable >= 3) return;
      await this.page.waitForTimeout(POLL_MS / 2);
    }
    const snapshot = await this.phase().catch(() => null);
    throw new Error(
      `${this.name}: never became ready to move within ${TIMEOUTS.interactionIdle / 1000}s\n` +
      `last phase: ${JSON.stringify(snapshot, null, 2)}`,
    );
  }

  private async clickProjected(target: ClickTarget): Promise<void> {
    const { x, y } = await this.page.evaluate(
      t => window.__triadTest!.getScreenXY(t as any),
      target as any,
    );
    await this.page.mouse.click(x, y);
  }

  /** Click a hand-fan strip and confirm the app registered that selection. */
  async selectHandCard(index: number): Promise<void> {
    await this.clickProjected({ type: 'hand', index });
    await this.waitPhase(
      `hand card ${index} selected`,
      (p, args) => p.interaction?.selectedCardIndex === args.index,
      TIMEOUTS.selection,
      { index },
    );
  }

  /** Click a board cell (a card must already be selected). */
  async clickCell(row: number, col: number): Promise<void> {
    await this.clickProjected({ type: 'cell', row, col });
  }

  async waitBoardCount(occupied: number): Promise<PhaseSnapshot> {
    return this.waitPhase(
      `board has ${occupied} cards`,
      (p, args) => p.game !== null
        && p.game.board.flat().filter(c => c.cardId !== null).length === args.occupied,
      TIMEOUTS.boardUpdate,
      { occupied },
    );
  }

  async waitGameOver(): Promise<PhaseSnapshot> {
    return this.waitPhase(
      'game over',
      p => p.ws.gameOver !== null,
      TIMEOUTS.boardUpdate,
    );
  }

  /** All 9 move proofs + both hand proofs collected — settlement unlocked. */
  async waitCanSettle(): Promise<void> {
    await this.waitPhase('canSettle (hand + 9 move proofs)', p => p.chain.canSettle, TIMEOUTS.canSettle);
  }

  /** Winner: pick the loser card in the settlement dialog. */
  async pickSettleCard(cardId: number): Promise<void> {
    await this.page.getByTestId(`settle-card-${cardId}`).click();
  }

  async waitSettleConfirmed(): Promise<void> {
    await this.waitPhase(
      'settlement tx confirmed',
      p => p.chain.settleTxStatus === 'confirmed',
      TIMEOUTS.settleTx,
    );
  }

  /** Loser: opponent settled and the taken card is known. */
  async waitOpponentSettled(): Promise<PhaseSnapshot> {
    return this.waitPhase(
      'opponent settlement received',
      p => p.chain.opponentSettled && p.chain.takenCardId !== null,
      TIMEOUTS.settleTx,
    );
  }

  /** Reject if a promise outruns `ms` — a hung PXE read must fail loudly, not stall the run. */
  private withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`${this.name}: ${label} did not return within ${ms / 1000}s`)), ms)),
    ]);
  }

  /** Private NFT reads from THIS tab's PXE (serialized via the app's queue). */
  async privateCards(): Promise<number[]> {
    const cards = await this.withTimeout(
      this.page.evaluate(() => window.__triadTest!.getPrivateCards()),
      TIMEOUTS.pxeRead, 'getPrivateCards');
    return [...cards].sort((a, b) => a - b);
  }

  /** Token balance via THIS tab's PXE (a fresh get_balance simulate, queued). */
  async tokenBalance(): Promise<number> {
    return this.withTimeout(
      this.page.evaluate(() => window.__triadTest!.getTokenBalance()),
      TIMEOUTS.pxeRead, 'getTokenBalance');
  }

  /**
   * Poll an async read until it equals `expected` — for private state that is
   * eventually consistent by design (PXE discovers notes by block scanning).
   * A read that THROWS is FATAL and propagates: it means the read itself is
   * broken (e.g. a PXE/IndexedDB conflict), not "value not yet". Polling is
   * ONLY for a legitimately not-yet-equal value. Never swallow a thrown read.
   */
  async expectEventually<T>(
    label: string,
    read: () => Promise<T>,
    expected: T,
    timeout = TIMEOUTS.eventually,
  ): Promise<void> {
    const deadline = Date.now() + timeout;
    let last: T | undefined;
    while (Date.now() < deadline) {
      last = await read();
      if (JSON.stringify(last) === JSON.stringify(expected)) return;
      await this.page.waitForTimeout(2000);
    }
    throw new Error(
      `${this.name}: "${label}" never reached expected value within ${timeout / 1000}s\n` +
      `expected: ${JSON.stringify(expected)}\nlast:     ${JSON.stringify(last)}`,
    );
  }

  /** Current app screen ('main-menu' | 'card-packs' | 'pack-opening' | 'game' | ...). */
  async screen(): Promise<string> {
    return (await this.phase()).screen;
  }

  async waitScreen(screen: string, timeout = TIMEOUTS.match): Promise<void> {
    await this.waitPhase(`screen=${screen}`, (p, s) => p.screen === s, timeout, screen);
  }

  /** From the game-over dialog: click Back to Lobby and land on the main menu. */
  async returnToMenu(): Promise<void> {
    await this.page.getByTestId('back-to-lobby').click();
    await this.waitScreen('main-menu', TIMEOUTS.boardUpdate);
  }

  /**
   * Open ONE card pack via the real UI: menu → Card Packs → Purchase → drive
   * the reveal (flip all 10, continue) → back to menu. Returns the 10 new card
   * ids. The purchase is a real tx (proving), so it can take a while.
   */
  async openPack(): Promise<number[]> {
    const before = (await this.phase()).ownedCardIds.length;
    await this.page.getByTestId('menu-packs').click();
    await this.waitScreen('card-packs', TIMEOUTS.match);
    await this.page.getByTestId('purchase-pack').click();
    // Wait through the purchase tx + note import until the reveal screen.
    await this.waitScreen('pack-opening', TIMEOUTS.packTx);
    // Reveal phase auto-starts after ~4.5s of intro animation; flip all 10.
    for (let i = 0; i < 10; i++) {
      await this.page.getByTestId(`pack-card-${i}`).click({ timeout: TIMEOUTS.boardUpdate });
    }
    await this.page.getByTestId('pack-all-flipped').waitFor({ state: 'attached', timeout: TIMEOUTS.selection });
    await this.page.locator('[data-testid="pack-opening"]').click(); // "click anywhere to continue"
    await this.waitScreen('card-packs', TIMEOUTS.boardUpdate);
    // Cards land in ownedCardIds via handlePackOpenComplete.
    const after = await this.waitPhase(
      'pack cards added to collection',
      (p, b) => p.ownedCardIds.length >= b + 10, TIMEOUTS.boardUpdate, before);
    await this.page.getByTestId('packs-back').click();
    await this.waitScreen('main-menu', TIMEOUTS.match);
    // The 10 new ids = ownedCardIds delta (multiset).
    return after.ownedCardIds.slice(before);
  }
}
