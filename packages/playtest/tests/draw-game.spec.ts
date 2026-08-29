/**
 * The draw settlement path, forced rather than waited for.
 *
 * WHY THIS EXISTS. A draw is the one settlement outcome the campaign has never
 * exercised — 30 real games across the July and August testnet campaigns
 * produced zero. That was not bad luck: multi-game's `pickHand` takes the five
 * LOWEST distinct owned card ids, which is always the starter set [1,2,3,4,5],
 * and the move policy is deterministic (hand slot 0 → first empty cell,
 * row-major). Identical ordered hands under a deterministic policy give exactly
 * one result — player1 wins 7–3 — every single time. The campaign is therefore
 * structurally INCAPABLE of drawing, so "validate it opportunistically" would
 * never have paid out however long we ran it.
 *
 * The cards do not need to change; only their ORDER does. Of the 14400 ordered
 * pairs of permutations of the starter set, 1124 draw. This test plays one of
 * them, so it needs no card pack and no collection state beyond what
 * provisioning already guarantees:
 *
 *     both players select [4,2,3,1,5]  →  board full, 5–5, winner 'draw'
 *
 * (P1 places 5 cards and P2 places 4, so P2 keeps one in hand; score counts
 * owned cells PLUS held cards, which is how 9 cells still tie.)
 *
 * The expectation is nonetheless DERIVED from the live rules mirror, never
 * hardcoded: if the rules change so this ordering no longer draws, the test
 * fails loudly at the mirror assert rather than silently testing a win path.
 *
 * Draw settlement is SINGLE-SETTLER: player 1 auto-fires the one
 * process_game(winner_id=3), which re-mints BOTH hands and pays 20 tokens each;
 * player 2 sends no transaction and receives its cards over the relay. So the
 * card economy nets to zero and there is no "taken card" — which is why the
 * win-path's waitOpponentSettled (it keys on takenCardId) must not be used.
 */
import { test, expect } from '@playwright/test';
import type { Player } from '@axolotl-arena/game-logic';
import { PlayerDriver } from '../src/player.js';
import { ExpectedGame } from '../src/expected.js';
import { ChainClient, GAME_STATUS } from '../src/chain.js';
import { BACKEND_URL, readStackInfo } from '../src/env.js';

/** Starter cards reordered so the deterministic policy ties. Same five cards. */
const DRAW_HAND = [4, 2, 3, 1, 5];
const STARTER_CARDS = [1, 2, 3, 4, 5];
const STARTER_TOKENS = 100;
const GAME_REWARD = 20;

test.describe.serial('draw settlement', () => {
  let alice: PlayerDriver | null = null;
  let bob: PlayerDriver | null = null;

  test.afterAll(async () => {
    await alice?.dispose();
    await bob?.dispose();
  });

  test('a drawn game settles both hands back and pays both players', async () => {
    const stack = readStackInfo();
    if (!stack.addresses) throw new Error('stack.json has no contract addresses — setup incomplete');

    // ── Onboarding (serial: devnet auto-funding races if concurrent) ─────
    alice = await PlayerDriver.launch('alice', stack.logsDir);
    const alicePhase = await alice.waitConnected();
    bob = await PlayerDriver.launch('bob', stack.logsDir);
    const bobPhase = await bob.waitConnected();
    expect(alicePhase.accountAddress).not.toBeNull();
    expect(bobPhase.accountAddress).not.toBeNull();
    expect(alicePhase.accountAddress).not.toEqual(bobPhase.accountAddress);

    for (const driver of [alice, bob]) {
      expect(await driver.privateCards(), `${driver.name} starter cards in PXE`).toEqual(STARTER_CARDS);
      expect(await driver.tokenBalance(), `${driver.name} starter tokens`).toBe(STARTER_TOKENS);
    }
    const aliceBeforeCards = await alice.privateCards();
    const bobBeforeCards = await bob.privateCards();
    const aliceBeforeTokens = await alice.tokenBalance();
    const bobBeforeTokens = await bob.tokenBalance();

    // ── Matchmaking with the draw ordering ───────────────────────────────
    await alice.startMatchmaking(DRAW_HAND);
    await bob.startMatchmaking(DRAW_HAND);
    const [aliceGame, bobGame] = await Promise.all([alice.waitInGame(), bob.waitInGame()]);

    expect(aliceGame.ws.gameId).toEqual(bobGame.ws.gameId);
    const wsGameId = aliceGame.ws.gameId!;
    const byNumber = new Map<number, PlayerDriver>([
      [aliceGame.ws.playerNumber!, alice],
      [bobGame.ws.playerNumber!, bob],
    ]);
    expect(byNumber.size, 'server assigned distinct player numbers').toBe(2);
    const driverFor = (player: Player) => byNumber.get(player === 'player1' ? 1 : 2)!;

    // ── Play all 9 moves, cross-checking every board against the mirror ──
    const mirror = new ExpectedGame(DRAW_HAND, DRAW_HAND);

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
        (mover === alice ? bob! : alice!).waitBoardCount(mirror.occupiedCount),
      ]);
      for (const phase of [moverPhase, otherPhase]) {
        expect(phase.game!.board.map(r => r.map(c => ({ cardId: c.cardId, owner: c.owner }))),
          `board after move ${moveNumber} (${player} → [${row},${col}])`,
        ).toEqual(mirror.board);
      }
    }

    // ── The point of the test: this ordering must actually draw ──────────
    expect(mirror.state.status).toBe('finished');
    expect(mirror.state.winner,
      'DRAW_HAND must still tie — if this fails the rules changed and the ordering needs recomputing, ' +
      'not the assertion relaxing').toBe('draw');
    expect(mirror.state.player1Score).toBe(mirror.state.player2Score);

    // Both browsers must independently agree it is a draw.
    const [aliceOver, bobOver] = await Promise.all([alice.waitGameOver(), bob.waitGameOver()]);
    for (const [d, ph] of [[alice, aliceOver], [bob, bobOver]] as const) {
      const occupied = ph.game!.board.flat().filter(c => c.cardId !== null).length;
      expect(occupied, `draw: ${d.name} board full`).toBe(9);
      expect(ph.game!.myScore, `draw: ${d.name} scores tied`).toBe(ph.game!.opponentScore);
      expect(ph.ws.gameOver!.winner, `draw: ${d.name} winner=draw`).toBe('draw');
    }

    const onChainGameId = (await alice.phase()).chain.onChainGameId
      ?? (await bob.phase()).chain.onChainGameId;
    expect(onChainGameId, 'on-chain game id known to a client').not.toBeNull();

    // Both hands were committed (nullified) at game creation.
    for (const driver of [alice, bob]) {
      expect(await driver.privateCards(), `${driver.name} cards nullified during game`).toEqual([]);
    }

    // ── Settlement: player 1 alone fires process_game(winner_id=3) ───────
    // Player 2 sends nothing and receives its hand over the relay, so there is
    // no second doomed tx to revert. A draw has no taken card, so we wait on
    // the settler's own confirmation rather than waitOpponentSettled.
    await driverFor('player1').waitSettleConfirmed();

    // ── Layer 2: public chain — the draw is SETTLED, not left active ─────
    const chain = await ChainClient.connect(stack.addresses);
    await alice.expectEventually('draw: on-chain settled',
      async () => await chain.gameStatus(onChainGameId!), GAME_STATUS.settled);

    // ── Layer 1: card economy nets to zero, both players paid ───────────
    // winner_id=3 re-mints BOTH hands rather than transferring one, so each
    // player ends with exactly the cards they started with.
    await alice.expectEventually('draw: alice hand returned (net 0)',
      async () => (await alice!.privateCards()).length, aliceBeforeCards.length);
    await bob.expectEventually('draw: bob hand returned (net 0)',
      async () => (await bob!.privateCards()).length, bobBeforeCards.length);
    await alice.expectEventually('draw: alice holds the SAME cards back',
      async () => (await alice!.privateCards()).slice().sort((a, b) => a - b), STARTER_CARDS);
    await bob.expectEventually('draw: bob holds the SAME cards back',
      async () => (await bob!.privateCards()).slice().sort((a, b) => a - b), STARTER_CARDS);
    await alice.expectEventually(`draw: alice tokens +${GAME_REWARD}`,
      () => alice!.tokenBalance(), aliceBeforeTokens + GAME_REWARD);
    await bob.expectEventually(`draw: bob tokens +${GAME_REWARD}`,
      () => bob!.tokenBalance(), bobBeforeTokens + GAME_REWARD);

    // ── Layer 2b: on-chain players are the two browser accounts ─────────
    const drawPlayers = await chain.gamePlayers(onChainGameId!);
    expect([drawPlayers.player1.toLowerCase(), drawPlayers.player2.toLowerCase()].sort(),
      'draw: on-chain players').toEqual([
        alicePhase.accountAddress!.toLowerCase(),
        bobPhase.accountAddress!.toLowerCase(),
      ].sort());

    // ── Layer 3: backend released the room ──────────────────────────────
    const health = await (await fetch(`${BACKEND_URL}/health`)).json() as { status: string };
    expect(health.status).toBe('ok');
    const gameRes = await fetch(`${BACKEND_URL}/games/${wsGameId}`);
    if (gameRes.ok) {
      const room = await gameRes.json() as { status: string };
      expect(room.status, 'draw: backend room finished').toBe('finished');
    }
  });
});
