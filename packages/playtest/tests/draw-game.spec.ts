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
 * Draw settlement is SINGLE-SETTLER: player 1 auto-fires the one settle_game,
 * which releases all ten prepared return notes and both reward notes
 * (docs/plan/PRIVATE_GAMES.md section 3.4: twelve note hashes, the same count
 * as a win, so the result is not visible in it). Player 2 sends no
 * transaction; it imports its OWN five returns and its reward from that tx,
 * with its own secrets — the same import a loser makes. So the card economy
 * nets to zero and nothing is taken.
 */
import { test, expect } from '@playwright/test';
import type { Player } from '@axolotl-arena/game-logic';
import { PlayerDriver } from '../src/player.js';
import { ExpectedGame } from '../src/expected.js';
import { ChainClient, canonicalField, nullifierOf } from '../src/chain.js';
import { BACKEND_URL, readStackInfo } from '../src/env.js';

/** Starter cards reordered so the deterministic policy ties. Same five cards. */
const DRAW_HAND = [4, 2, 3, 1, 5];
const STARTER_CARDS = [1, 2, 3, 4, 5];
const STARTER_TOKENS = 100;
const GAME_REWARD = 20;
/** Ten returns + both rewards — the same count a win releases. */
const SETTLE_NOTE_HASHES = 12;

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

    // Console marks BEFORE play: the draw's settle auto-fires the moment
    // player 1 holds all nine proofs, so a mark taken after game over could
    // already be past the settler's import.
    const marks = new Map([[alice, alice.consoleMark()], [bob, bob.consoleMark()]]);

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

    // ── Both players hold the same game: key and both records ────────────
    const settler = driverFor('player1');
    const other = driverFor('player2');
    await Promise.all([settler.waitCanSettle(), other.waitCanSettle()]);
    const ref = await settler.gameRef(wsGameId);
    expect(ref.record2, 'the joiner\'s record is known').not.toBeNull();
    expect(await other.gameRef(wsGameId),
      'both players hold the same game key and the same two records').toEqual(ref);
    const chain = await ChainClient.connect(stack.addresses);
    const createdNullifier = nullifierOf(await chain.gameState(ref), 'created');
    for (const driver of [alice, bob]) {
      const id = (await driver.phase()).chain.onChainGameId;
      expect(id, `${driver.name} knows the game's created nullifier`).not.toBeNull();
      expect(canonicalField(id!), `${driver.name}'s on-chain game id is the created nullifier`).toBe(createdNullifier);
    }

    // ── Settlement: player 1 alone fires settle_game ─────────────────────
    // Player 2 sends nothing and imports its own notes from that tx, so there
    // is no second doomed tx to revert. Nothing is taken on a draw: player 2's
    // "taken card" reads 0 once its import is done.
    await settler.waitSettleConfirmed();
    const otherSettled = await other.waitOpponentSettled();
    expect(otherSettled.chain.takenCardId, 'draw: nothing taken from player 2').toBe(0);

    // ── Layer 1: card economy nets to zero, both players paid ───────────
    // settle_game releases BOTH hands' prepared returns, so each player ends
    // with exactly the cards they started with.
    await alice.expectEventually('draw: alice holds the SAME cards back',
      async () => (await alice!.privateCards()).slice().sort((a, b) => a - b), STARTER_CARDS);
    await bob.expectEventually('draw: bob holds the SAME cards back',
      async () => (await bob!.privateCards()).slice().sort((a, b) => a - b), STARTER_CARDS);
    await alice.expectEventually(`draw: alice tokens +${GAME_REWARD}`,
      () => alice!.tokenBalance(), aliceBeforeTokens + GAME_REWARD);
    await bob.expectEventually(`draw: bob tokens +${GAME_REWARD}`,
      () => bob!.tokenBalance(), bobBeforeTokens + GAME_REWARD);
    // Each imported its own five returns and its reward; nobody was sent any.
    for (const driver of [alice, bob]) {
      driver.expectOwnNotesImported(marks.get(driver)!, STARTER_CARDS.length, `draw (${driver.name})`, { reward: true });
    }

    // ── Layer 2: public chain — the draw is SETTLED, not left active ─────
    const settled = await chain.gameState(ref);
    expect(settled.present, 'draw: on-chain settled, no claim').toEqual(['created', 'seat2', 'joined', 'done']);
    const settleTx = await chain.txOf(settled, 'done');
    for (const driver of [alice, bob]) {
      const stored = await driver.storedGame(wsGameId);
      expect(stored?.resolutionTxHash, `draw: ${driver.name} recorded the game's resolution`).toBeTruthy();
      expect(canonicalField(stored!.resolutionTxHash!), `draw: ${driver.name} imported from the tx that pushed 'done'`)
        .toBe(settleTx.txHash);
    }
    expect(settleTx.noteHashes.length, 'draw: settle_game releases ten returns and two rewards')
      .toBe(SETTLE_NOTE_HASHES);

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
