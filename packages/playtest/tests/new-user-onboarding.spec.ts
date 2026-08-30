/**
 * The acceptance test for onboarding: can somebody who has ONLY an Ethereum
 * account with some testnet ETH end up having played, and settled, a real game?
 *
 * Everything the app normally leans on is deliberately withheld. There is no
 * entry in the provisioned account pool, no pre-deployed Aztec account, no
 * pre-minted cards, no Fee Juice, and no faucet call from the harness. The
 * browser starts with a random Aztec key it has just generated and a wallet
 * holding nothing but ETH, and has to get from there to a settled game against
 * the DEPLOYED bot on the live relay. Each of these is a real thing that has to
 * work, in order:
 *
 *   1. buy/mint the fee asset from the player's own wallet on L1
 *   2. approve and deposit it into the Fee Juice portal
 *   3. wait for the L1->L2 message to land
 *   4. deploy the Aztec account claiming that Fee Juice, and mint starter cards
 *      in the same transaction
 *   5. queue on the production relay and get matched by the bot
 *   6. play nine moves, each with a real client-side proof
 *   7. settle on-chain, and have the chain agree it settled
 *
 * Run it (about 40 minutes, mostly proving):
 *
 *   PLAYTEST_TESTNET=1 PLAYTEST_PXE_URL=https://aztec-testnet-fullnode.zkv.xyz \
 *   PLAYTEST_BACKEND_URL=https://ws.aztec-arena.com \
 *   npx playwright test new-user-onboarding --config packages/playtest/playwright.config.ts
 */
import { test, expect } from '@playwright/test';
import { PlayerDriver } from '../src/player.js';
import { ChainClient, GAME_STATUS } from '../src/chain.js';
import { createFundedL1Account, refundTreasury, type InjectedWallet } from '../src/walletShim.js';
import { readStackInfo, TESTNET } from '../src/env.js';
import { resolve } from 'path';
import { ARTIFACTS_DIR } from '../src/env.js';

const STARTER_CARDS = [1, 2, 3, 4, 5];
/** The bridge is the slow part: three L1 blocks plus L1->L2 inclusion. */
const FUNDING_TIMEOUT_MS = 25 * 60_000;

const log = (m: string) => console.log(`   ${m}`);

test.describe.configure({ mode: 'serial' });

test('a new player with only an Ethereum account plays and settles a game', async () => {
  test.skip(!TESTNET, 'onboarding is only meaningful against a real chain (PLAYTEST_TESTNET=1)');
  test.setTimeout(60 * 60_000);

  const stack = readStackInfo();
  const logsDir = resolve(ARTIFACTS_DIR, 'logs');
  let wallet: InjectedWallet | null = null;
  let player: PlayerDriver | null = null;

  try {
    // ---- The starting position: an Ethereum account with some ETH ----------
    log('creating a brand-new Ethereum account…');
    wallet = await createFundedL1Account({ log });
    expect(await wallet.balance(), 'the new account holds testnet ETH').toBeGreaterThan(0n);

    // ---- A browser that knows nothing ---------------------------------------
    // seed: null — no pooled account. The app generates a fresh Aztec key on
    // first load, exactly as it would for a stranger.
    player = await PlayerDriver.launch('newcomer', logsDir, {
      seed: null,
      skipTutorial: false,
      beforeNavigate: page => wallet!.install(page),
    });

    // Onboarding transits 'connecting' while it generates keys, so wait for
    // the state to settle rather than sampling it.
    const before = await player.waitPhase(
      'the app to ask for funding',
      p => p.aztecStatus === 'needs-funding' || p.aztecStatus === 'connected' || p.aztecStatus === 'error',
      3 * 60_000,
    );
    expect(before.aztecStatus, 'a brand-new player has no funded account').toBe('needs-funding');
    expect(before.ownedCardIds, 'and no cards').toHaveLength(0);
    log(`aztec account ${before.accountAddress} — unfunded, undeployed`);

    // ---- Funding, deployment and starter cards, from the wallet alone -------
    log('clicking "Fund with My Wallet"…');
    const funded = await player.fundFromWallet({ timeout: FUNDING_TIMEOUT_MS, log });
    expect(funded.aztecStatus).toBe('connected');
    expect(funded.ownedCardIds.slice().sort((a, b) => a - b),
      'starter cards minted during account deployment').toEqual(STARTER_CARDS);
    log(`onboarded: ${funded.accountAddress} holds ${funded.ownedCardIds.length} cards`);

    await player.skipTutorial();

    // ---- A real game against the deployed bot -------------------------------
    log('queueing on the production relay…');
    await player.startMatchmaking(STARTER_CARDS);
    const inGame = await player.waitInGame();
    log(`matched as player ${inGame.ws.playerNumber} in game ${inGame.ws.gameId}`);
    // Join-only bot: it never creates, so a matched newcomer is always player 1.
    expect(inGame.ws.playerNumber, 'the bot joins, so the human created').toBe(1);

    for (let placed = 0; placed < 9; placed++) {
      const snap = await player.phase();
      if (snap.ws.gameOver) break;
      if (!snap.game?.isMyTurn) {
        // The bot's turn: it proves off-box, which takes minutes.
        await player.waitPhase(
          'the bot to move',
          p => !!p.ws.gameOver || (p.game?.isMyTurn ?? false),
          15 * 60_000,
        );
        continue;
      }
      await player.waitReadyToMove();
      const board = (await player.phase()).game!.board;
      const target = firstEmptyCell(board);
      if (!target) break;
      await player.selectHandCard(0);
      await player.clickCell(target.row, target.col);
      log(`played hand[0] → [${target.row},${target.col}]`);
      await player.waitBoardCount(countOccupied(board) + 1);
    }

    const over = await player.waitGameOver();
    log(`game over: ${over.ws.gameOver?.winner}`);

    // ---- Settlement ----------------------------------------------------------
    // Whoever won settles. When the human wins it happens in this browser; when
    // the bot wins it happens on the bot's box, and we wait for the chain.
    const iWon = over.ws.gameOver?.winner === 'player1';
    if (iWon) {
      await player.waitCanSettle();
      const claim = pickClaimableCard(over.game!.board);
      log(`settling, claiming card ${claim}`);
      await player.pickSettleCard(claim);
      await player.waitSettleConfirmed();
    } else {
      log('the bot won — waiting for it to settle');
      await player.waitOpponentSettled();
    }

    // ---- The chain is the judge ---------------------------------------------
    const chain = await ChainClient.connect(stack.addresses!);
    const onChainGameId = (await player.phase()).chain.onChainGameId;
    expect(onChainGameId, 'the game reached the chain').toBeTruthy();

    const status = await chain.gameStatus(onChainGameId!);
    expect(status, `game ${onChainGameId} is settled on-chain`).toBe(GAME_STATUS.settled);
    log(`on-chain status ${status} (SETTLED) for game ${onChainGameId}`);

    const finalCards = (await player.phase()).ownedCardIds;
    log(`newcomer finished holding ${finalCards.length} cards`);
    expect(finalCards.length, 'the wager moved a card one way or the other').not.toBe(5);
  } finally {
    await player?.dispose().catch(() => {});
    if (wallet) await refundTreasury(wallet.privateKey, log);
  }
});

function firstEmptyCell(board: { cardId: number | null }[][]): { row: number; col: number } | null {
  for (let row = 0; row < board.length; row++) {
    for (let col = 0; col < board[row].length; col++) {
      if (board[row][col].cardId === null) return { row, col };
    }
  }
  return null;
}

function countOccupied(board: { cardId: number | null }[][]): number {
  return board.flat().filter(c => c.cardId !== null).length;
}

/** A card the opponent still owns on the board — what a winner may claim. */
function pickClaimableCard(board: { cardId: number | null; owner: string | null }[][]): number {
  for (const cell of board.flat()) {
    if (cell.cardId !== null && cell.owner === 'player2') return cell.cardId;
  }
  throw new Error('no opponent-owned card on the board to claim');
}
