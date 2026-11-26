/**
 * Phase 1 campaign: one full click-driven game between two real browser
 * contexts on the local sandbox, with three-layer settlement validation —
 * under the private-games protocol, Phase B (docs/plan/PRIVATE_GAMES.md):
 * each client runs the game itself and the relay is a pure pipe.
 *
 * Layers asserted (all hard):
 *   1. Private chain state — inside each browser's own PXE: the winner holds
 *      its own five plus the prize, the loser the four it kept, both +20
 *      tokens; and each got there by importing its OWN prepared notes from
 *      the settle tx (no card message, nothing relayed about anybody's notes).
 *   2. Public chain state  — from the harness's independent node client. A
 *      game leaves no public status or players any more, only nullifiers only
 *      its two players can compute: created / seat2 / joined before
 *      settlement, + done after, nothing else; the `done` tx is the one both
 *      browsers recorded as the game's resolution, and it releases exactly
 *      twelve note hashes (the count a draw releases too).
 *   3. Relay               — blind: every frame either browser sent it is a
 *      Phase B message with only its allowed fields (no card id anywhere,
 *      sealed payloads unreadable), it relayed the nine moves as numbers, and
 *      its REST view and its log say no more than that — not even who won.
 * plus the two clients' own games, after every move: each matches the
 * @axolotl-arena/game-logic mirror (board, turn, scores, hands — the
 * opponent's hidden cards face down), and at the end both transcripts are the
 * same nine moves and proofs, bound to the records the chain committed.
 *
 * Deterministic by construction: fresh per-run accounts mint starter cards
 * 1–5, scripted policy (hand slot 0 → first empty cell). Precomputed outcome:
 * player1 wins 7–3, loser board cards {1,2,3,4} — but every expectation is
 * derived from the live rules mirror, not hardcoded, so a rules change fails
 * the cross-check, not the harness.
 */
import { test, expect } from '@playwright/test';
import type { Player } from '@axolotl-arena/game-logic';
import { PlayerDriver } from '../src/player.js';
import { ExpectedGame } from '../src/expected.js';
import { ChainClient, canonicalField, nullifierOf } from '../src/chain.js';
import { playMoves, expectGameOver, expectTranscriptsAgree, storedGames } from '../src/play.js';
import { expectRelayBlind, expectRelayLogBlind, expectRoomIsPipe, relayRoom } from '../src/relay.js';
import { BACKEND_URL, TESTNET, readStackInfo } from '../src/env.js';

const STARTER_CARDS = [1, 2, 3, 4, 5];
const STARTER_TOKENS = 100;
const GAME_REWARD = 20;
/** A settlement releases 9 returns + the prize (win) or 10 returns (draw), plus both rewards. */
const SETTLE_NOTE_HASHES = 12;

/**
 * One ISOLATED Chromium per player (own GPU process), the proven model from the
 * multi-game campaign — also registers the browser with the leak reaper. Under
 * long testnet proving the old shared-context model risked WebGL context loss
 * (two contexts sharing one GPU process, starved while the CPU is pinned).
 */
async function newDriver(name: string, logsDir: string): Promise<PlayerDriver> {
  return PlayerDriver.launch(name, logsDir);
}

test.describe.serial('ladder campaign', () => {
  let alice: PlayerDriver | null = null;
  let bob: PlayerDriver | null = null;

  test.afterAll(async () => {
    await alice?.dispose();
    await bob?.dispose();
  });

  test('full click-driven game settles correctly across three layers', async () => {
    const stack = readStackInfo();
    if (!stack.addresses) throw new Error('stack.json has no contract addresses — setup incomplete');

    // ── Onboarding: two isolated tabs, each with its own embedded PXE ────
    // SERIAL on purpose: devnet auto-funding bridges from one hardcoded anvil
    // account (fundDevnet.ts), so two concurrent onboardings race on the same
    // ERC20 allowance (approve/deposit interleave → ERC20InsufficientAllowance,
    // run 8). Finding reported to lane 2; the campaign onboards sequentially.
    alice = await newDriver('alice', stack.logsDir);
    const alicePhase = await alice.waitConnected();
    bob = await newDriver('bob', stack.logsDir);
    const bobPhase = await bob.waitConnected();
    expect(alicePhase.accountAddress).not.toBeNull();
    expect(bobPhase.accountAddress).not.toBeNull();
    expect(alicePhase.accountAddress).not.toEqual(bobPhase.accountAddress);

    for (const driver of [alice, bob]) {
      expect(await driver.privateCards(), `${driver.name} starter cards in PXE`).toEqual(STARTER_CARDS);
      expect(await driver.tokenBalance(), `${driver.name} starter tokens`).toBe(STARTER_TOKENS);
      // The starter mint's own offchain messages were handed to the PXE. (The
      // boot-time restore then import_notes every stored card too — the
      // recovery path, by design — so only the receive is asserted here.)
      // Only when this browser made that mint: on testnet the player is a pool
      // account whose starters the provisioner minted (and checked) before the
      // browser existed, so the browser restores them and receives nothing.
      if (!TESTNET) {
        expect(driver.consoleSince(0).some(l => l.includes('received 5 card note message(s)')),
          `${driver.name} received the starter cards' messages`).toBe(true);
      }
    }

    // ── Matchmaking ──────────────────────────────────────────────────────
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

    // ── Play all 9 moves via real canvas clicks. Each client runs the game
    //    itself: after every move both games are checked against the mirror
    //    (the opponent sees a move only once it is proven, sent and checked).
    const mirror = new ExpectedGame(STARTER_CARDS, STARTER_CARDS);
    await playMoves(mirror, driverFor, 9);

    // ── Game over: both clients reach the mirror's result on their own ───
    const winner = mirror.state.winner as Player;
    expect(winner === 'player1' || winner === 'player2',
      'scripted game must be decisive (a draw means the rules changed)').toBe(true);
    await expectGameOver(mirror, driverFor);

    const winnerDriver = driverFor(winner);
    const loserDriver = winnerDriver === alice ? bob : alice;
    const loserPlayer: Player = winner === 'player1' ? 'player2' : 'player1';

    // ── Both records are committed and both players hold the whole game ──
    await Promise.all([winnerDriver.waitCanSettle(), loserDriver.waitCanSettle()]);
    const ref = await winnerDriver.gameRef(wsGameId);
    expect(ref.record2, 'the joiner\'s record is known').not.toBeNull();
    expect(await loserDriver.gameRef(wsGameId),
      'both players hold the same game key and the same two records').toEqual(ref);
    // ...and the same game: nine moves, nine proofs, bound to those records.
    expectTranscriptsAgree(mirror, await storedGames(driverFor, wsGameId));

    // ── Layer 2 (before settling): the game is exactly created + joined ──
    const chain = await ChainClient.connect(stack.addresses);
    const committed = await chain.gameState(ref);
    expect(committed.present, 'on-chain: created and joined, nothing else').toEqual(['created', 'seat2', 'joined']);
    for (const driver of [alice, bob]) {
      const id = (await driver.phase()).chain.onChainGameId;
      expect(id, `${driver.name} knows the game's created nullifier`).not.toBeNull();
      expect(canonicalField(id!), `${driver.name}'s on-chain game id is the created nullifier`)
        .toBe(nullifierOf(committed, 'created'));
    }

    // Both hands were committed (their notes nullified) by create and join —
    // neither PXE should hold a spendable card before settlement.
    for (const driver of [winnerDriver, loserDriver]) {
      expect(await driver.privateCards(), `${driver.name} cards nullified during game`).toEqual([]);
    }

    // ── Settlement: the winner takes a card the loser PLACED ─────────────
    const loserPlaced = mirror.placedBy(loserPlayer).sort((a, b) => a - b);
    expect(loserPlaced.length).toBeGreaterThan(0);
    const claimedCard = loserPlaced[loserPlaced.length - 1];

    const winnerMark = winnerDriver.consoleMark();
    const loserMark = loserDriver.consoleMark();
    await winnerDriver.pickSettleCard(claimedCard);
    await winnerDriver.waitSettleConfirmed();
    const loserSettled = await loserDriver.waitOpponentSettled();
    expect(loserSettled.chain.takenCardId).toBe(claimedCard);

    // ── Layer 1: private card + token state in each PXE ──────────────────
    const expectedWinnerCards = [...STARTER_CARDS, claimedCard].sort((a, b) => a - b);
    const removeAt = STARTER_CARDS.indexOf(claimedCard);
    const expectedLoserCards = STARTER_CARDS.filter((_, i) => i !== removeAt);

    await winnerDriver.expectEventually(
      'winner PXE holds its own five + the prize',
      () => winnerDriver.privateCards(), expectedWinnerCards);
    await loserDriver.expectEventually(
      'loser PXE holds the four it kept',
      () => loserDriver.privateCards(), expectedLoserCards);
    await winnerDriver.expectEventually(
      'winner token reward', () => winnerDriver.tokenBalance(), STARTER_TOKENS + GAME_REWARD);
    await loserDriver.expectEventually(
      'loser token reward', () => loserDriver.tokenBalance(), STARTER_TOKENS + GAME_REWARD);
    // Each imported its own prepared notes from the settle tx — the winner its
    // five returns + the prize, the loser its four — and nobody was sent any.
    winnerDriver.expectOwnNotesImported(winnerMark, STARTER_CARDS.length + 1, 'settlement (winner)', { reward: true });
    loserDriver.expectOwnNotesImported(loserMark, STARTER_CARDS.length - 1, 'settlement (loser)', { reward: true });

    // ── Layer 2: the game's nullifiers, read by the harness's own client ──
    const settled = await chain.gameState(ref);
    expect(settled.present, 'on-chain: settled, no claim').toEqual(['created', 'seat2', 'joined', 'done']);
    const settleTx = await chain.txOf(settled, 'done');
    for (const driver of [winnerDriver, loserDriver]) {
      const stored = await driver.storedGame(wsGameId);
      expect(stored?.resolutionTxHash, `${driver.name} recorded the game's resolution`).toBeTruthy();
      expect(canonicalField(stored!.resolutionTxHash!), `${driver.name} imported from the tx that pushed 'done'`)
        .toBe(settleTx.txHash);
    }
    expect(settleTx.noteHashes.length, 'settle_game releases exactly the twelve prepared notes')
      .toBe(SETTLE_NOTE_HASHES);
    // Create, join and settle are three separate transactions.
    const createTx = await chain.txOf(settled, 'created');
    const joinTx = await chain.txOf(settled, 'joined');
    expect(joinTx.nullifiers, 'join closes seat 2 in the same tx').toContain(nullifierOf(settled, 'seat2'));
    expect(new Set([createTx.txHash, joinTx.txHash, settleTx.txHash]).size, 'create, join, settle: three txs').toBe(3);

    // ── Layer 3: the relay stayed blind ──────────────────────────────────
    const health = await (await fetch(`${BACKEND_URL}/health`)).json() as { status: string };
    expect(health.status).toBe('ok');
    // It relayed nine moves and knows nothing else: not the cards, not who
    // won, not that the game settled (the room outlives the game by 30 min).
    expectRoomIsPipe(await relayRoom(wsGameId), wsGameId, { status: 'moves-complete', movesMade: 9 }, 'relay');
    expectRelayBlind([
      { driver: driverFor('player1'), seat: 1, mark: 0 },
      { driver: driverFor('player2'), seat: 2, mark: 0 },
    ], wsGameId, 9, 'relay traffic');
    expectRelayLogBlind(stack.logsDir, wsGameId, 9, 'relay log');
  });
});
