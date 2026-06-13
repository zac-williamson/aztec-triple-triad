/**
 * Phase 1 campaign: one full click-driven game between two real browser
 * contexts on the local sandbox, with three-layer settlement validation.
 *
 * Layers asserted:
 *   1. Private chain state — inside each browser's own PXE (cards, tokens)
 *   2. Public chain state  — from the harness's independent node client
 *   3. Backend             — game room status via REST
 * plus a move-by-move board cross-check against @axolotl-arena/game-logic.
 *
 * Deterministic by construction: fresh stack per campaign, both players hold
 * starter cards 1–5, scripted policy (hand slot 0 → first empty cell).
 * Precomputed outcome for that script: player1 wins 7–3, loser board cards
 * {1,2,3,4} — but every expectation below is derived from the live mirror,
 * not hardcoded, so a rules change fails the cross-check, not the harness.
 */
import { test, expect, type Browser } from '@playwright/test';
import type { Player } from '@axolotl-arena/game-logic';
import { PlayerDriver } from '../src/player.js';
import { ExpectedGame } from '../src/expected.js';
import { ChainClient, GAME_STATUS } from '../src/chain.js';
import { BACKEND_URL, readStackInfo } from '../src/env.js';

const STARTER_CARDS = [1, 2, 3, 4, 5];
const STARTER_TOKENS = 100;
const GAME_REWARD = 20;

async function newDriver(browser: Browser, name: string, logsDir: string): Promise<PlayerDriver> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const driver = new PlayerDriver(name, page);
  await driver.boot(logsDir);
  return driver;
}

test('full click-driven game settles correctly across all three layers', async ({ browser }) => {
  const stack = readStackInfo();
  if (!stack.addresses) throw new Error('stack.json has no contract addresses — setup incomplete');

  // ── Onboarding: two isolated tabs, each with its own embedded PXE ──────
  // SERIAL on purpose: devnet auto-funding bridges from one hardcoded anvil
  // account (fundDevnet.ts), so two concurrent onboardings race on the same
  // ERC20 allowance (approve/deposit interleave → ERC20InsufficientAllowance,
  // seen in run 8). Finding reported to lane 2; the campaign schedules
  // onboardings sequentially, as real players arrive.
  const alice = await newDriver(browser, 'alice', stack.logsDir);
  const alicePhase = await alice.waitConnected();
  const bob = await newDriver(browser, 'bob', stack.logsDir);
  const bobPhase = await bob.waitConnected();
  expect(alicePhase.accountAddress).not.toBeNull();
  expect(bobPhase.accountAddress).not.toBeNull();
  expect(alicePhase.accountAddress).not.toEqual(bobPhase.accountAddress);

  for (const driver of [alice, bob]) {
    expect(await driver.privateCards(), `${driver.name} starter cards in PXE`).toEqual(STARTER_CARDS);
    expect(await driver.tokenBalance(), `${driver.name} starter tokens`).toBe(STARTER_TOKENS);
  }

  // ── Matchmaking ────────────────────────────────────────────────────────
  await alice.startMatchmaking(STARTER_CARDS);
  await bob.startMatchmaking(STARTER_CARDS);
  const [aliceGame, bobGame] = await Promise.all([alice.waitInGame(), bob.waitInGame()]);

  expect(aliceGame.ws.gameId).toEqual(bobGame.ws.gameId);
  const wsGameId = aliceGame.ws.gameId!;
  const byNumber = new Map<number, PlayerDriver>([
    [aliceGame.ws.playerNumber!, alice],
    [bobGame.ws.playerNumber!, bob],
  ]);
  const driverFor = (player: Player) => byNumber.get(player === 'player1' ? 1 : 2)!;
  expect(byNumber.size, 'server assigned distinct player numbers').toBe(2);

  // ── Play all 9 moves via real canvas clicks, cross-checking every board ─
  const mirror = new ExpectedGame(STARTER_CARDS, STARTER_CARDS);

  for (let moveNumber = 0; moveNumber < 9; moveNumber++) {
    const player = mirror.state.currentTurn;
    const mover = driverFor(player);
    const { handIndex, row, col } = mirror.nextMove();

    await mover.waitReadyToMove();
    await mover.selectHandCard(handIndex);
    await mover.clickCell(row, col);

    mirror.apply(player, handIndex, row, col);

    const [moverPhase, otherPhase] = await Promise.all([
      mover.waitBoardCount(mirror.occupiedCount),
      (mover === alice ? bob : alice).waitBoardCount(mirror.occupiedCount),
    ]);
    for (const phase of [moverPhase, otherPhase]) {
      expect(phase.game!.board.map(r => r.map(c => ({ cardId: c.cardId, owner: c.owner }))),
        `board after move ${moveNumber} (${player} → [${row},${col}])`,
      ).toEqual(mirror.board);
    }
  }

  // ── Game over: both UIs agree with the mirror ──────────────────────────
  expect(mirror.state.status).toBe('finished');
  const winner = mirror.state.winner as Player;
  expect(winner === 'player1' || winner === 'player2',
    'scripted game must be decisive (a draw means the rules changed)').toBe(true);

  const [aliceOver, bobOver] = await Promise.all([alice.waitGameOver(), bob.waitGameOver()]);
  for (const phase of [aliceOver, bobOver]) {
    expect(phase.ws.gameOver!.winner).toBe(winner);
  }

  const winnerDriver = driverFor(winner);
  const loserDriver = winnerDriver === alice ? bob : alice;
  const loserPlayer: Player = winner === 'player1' ? 'player2' : 'player1';

  // On-chain game id (derived in-circuit, shared by both clients).
  const onChainGameId = (await winnerDriver.phase()).chain.onChainGameId
    ?? (await loserDriver.phase()).chain.onChainGameId;
  expect(onChainGameId, 'on-chain game id known to a client').not.toBeNull();

  // ── Settlement: winner claims a loser card the mirror says is on board ──
  const loserBoardCards = mirror.state.board.flat()
    .filter(c => c.card && c.originalOwner === loserPlayer)
    .map(c => c.card!.id)
    .sort((a, b) => a - b);
  expect(loserBoardCards.length).toBeGreaterThan(0);
  const claimedCard = loserBoardCards[loserBoardCards.length - 1];

  await winnerDriver.waitCanSettle();

  // Mid-campaign chain check: both hands were committed (nullified) on game
  // creation — neither PXE should hold spendable cards before settlement.
  for (const driver of [winnerDriver, loserDriver]) {
    expect(await driver.privateCards(), `${driver.name} cards nullified during game`).toEqual([]);
  }

  await winnerDriver.pickSettleCard(claimedCard);
  await winnerDriver.waitSettleConfirmed();
  const loserSettled = await loserDriver.waitOpponentSettled();
  expect(loserSettled.chain.takenCardId).toBe(claimedCard);

  // ── Layer 1: private state in each PXE ─────────────────────────────────
  const expectedWinnerCards = [...STARTER_CARDS, claimedCard].sort((a, b) => a - b);
  const removeAt = STARTER_CARDS.indexOf(claimedCard);
  const expectedLoserCards = STARTER_CARDS.filter((_, i) => i !== removeAt);

  await winnerDriver.expectEventually(
    'winner PXE holds starter cards + claimed card',
    () => winnerDriver.privateCards(), expectedWinnerCards);
  await loserDriver.expectEventually(
    'loser PXE holds starter cards minus claimed card',
    () => loserDriver.privateCards(), expectedLoserCards);

  await winnerDriver.expectEventually(
    'winner token reward', () => winnerDriver.tokenBalance(), STARTER_TOKENS + GAME_REWARD);

  // ── Layer 2: public chain state via the harness's own node client ──────
  const chain = await ChainClient.connect(stack.addresses);
  expect(await chain.gameStatus(onChainGameId!), 'game settled on-chain').toBe(GAME_STATUS.settled);

  const onChainPlayers = await chain.gamePlayers(onChainGameId!);
  const browserAddresses = [
    (await alice.phase()).accountAddress!.toLowerCase(),
    (await bob.phase()).accountAddress!.toLowerCase(),
  ].sort();
  const chainAddresses = [
    onChainPlayers.player1.toLowerCase(),
    onChainPlayers.player2.toLowerCase(),
  ].sort();
  expect(chainAddresses, 'on-chain players match the two browser accounts').toEqual(browserAddresses);

  // ── Layer 3: backend session state ─────────────────────────────────────
  const health = await (await fetch(`${BACKEND_URL}/health`)).json() as { status: string };
  expect(health.status).toBe('ok');

  const gameRes = await fetch(`${BACKEND_URL}/games/${wsGameId}`);
  if (gameRes.ok) {
    // Room still present (stale cleanup runs on a timer) — must be finished
    // with the same winner; players were released from it at GAME_OVER.
    const room = await gameRes.json() as { status: string; winner: string };
    expect(room.status).toBe('finished');
    expect(room.winner).toBe(winner);
  } else {
    expect(gameRes.status, 'room either finished or already cleaned up').toBe(404);
  }

  // ── Loser token reward — OPEN APP FINDING (lane brief, assumption 13) ───
  // The loser's +20 is an ONCHAIN_CONSTRAINED note tagged by the game
  // contract inside the WINNER's settle tx. Runs 7 & 9: the loser's PXE never
  // discovers it in-session (100 after 120s and 360s of continuous polling).
  // Last so it cannot shadow the layers above; on timeout, a reload-probe
  // attributes the bug (fresh-session discovery ⇒ in-session scanning gap,
  // lane 2; still missing ⇒ tag derivation, lane 1) before failing the run.
  try {
    await loserDriver.expectEventually(
      'loser token reward', () => loserDriver.tokenBalance(), STARTER_TOKENS + GAME_REWARD,
      120_000);
  } catch (inSessionErr) {
    await loserDriver.page.reload();
    await loserDriver.waitConnected();
    let reloadVerdict: string;
    try {
      await loserDriver.expectEventually(
        'loser token reward after reload', () => loserDriver.tokenBalance(),
        STARTER_TOKENS + GAME_REWARD, 120_000);
      reloadVerdict = 'DISCOVERED AFTER RELOAD — in-session scanning gap (lane 2 frontend/PXE-session)';
    } catch {
      reloadVerdict = 'STILL MISSING AFTER RELOAD — tag derivation/delivery (lane 1 contract-side)';
    }
    throw new Error(`loser +20 token note not discovered in-session; reload probe: ${reloadVerdict}\n${inSessionErr}`);
  }
});
