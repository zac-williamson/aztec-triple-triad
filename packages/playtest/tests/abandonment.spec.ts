/**
 * Present-but-idle abandonment E2E (docs/plan/ABANDONED_GAMES.md) under the
 * private-games protocol (docs/plan/PRIVATE_GAMES.md section 3.4): claim,
 * contest, claim again, finalize.
 *
 * FLOW: onboard 2 accounts → create+join → play 4 moves (P1,P2,P1,P2) so it is
 * P1's turn → P1 STOPS → during the runway BEFORE the 60s deadline the relay
 * warns BOTH browsers of IMPENDING abandonment (idlePlayer=player1, countdown
 * > 0) → at the deadline the claim becomes available → P2 (the non-idle
 * player) claims:
 *
 *   1. CLAIM 1. The flow waits until the game is MIN_ABANDON_SECONDS (8 min)
 *      past the join on chain time, then files claim 1 (`claim_slot(1)`,
 *      `claim(1,2)`), and waits out its 10-minute dispute window.
 *   2. CONTEST. P1 "comes back": the tab reloads, the menu finds the standing
 *      claim (`stuck-game-contestable`) and P1 clicks "I'm Still Here"
 *      (`contested_by(1)`, `contest(1)`, `resolved(1)`). The contest restarts
 *      the clock, so P1's menu now says the game is too young to claim.
 *   3. P2's dispute window closes on a contested claim: its flow stands down
 *      ("the game goes on") instead of finalizing — nothing resolved.
 *   4. CLAIM 2. P1 is still idle, so the relay offers the claim again and P2
 *      files claim 2 (`claim_slot(2)`, `claim(2,2)`). Each side contests once,
 *      so P1's menu offers nothing but the wait (`stuck-game-claim-pending`).
 *   5. FINALIZE. After claim 2's window P2 finalizes (`resolved(2)`, `done`):
 *      ONE tx releases both hands' prepared returns — ten notes, no rewards —
 *      and each player imports its OWN five from it: P2 in the game, P1 from
 *      the menu. Nobody wins anything from an abandonment.
 *
 * Fully asserts reality — no masks / relaxed asserts: deterministic keys, the
 * REAL 60s inactivity threshold, the REAL 8-minute abandonment bar and
 * 10-minute dispute windows on chain time, the real menu contest, and the
 * independent ChainClient (third pair of eyes) reading the game's nullifiers.
 * About 35 minutes, most of it those waits.
 */
import { test, expect } from '@playwright/test';
import type { Player } from '@axolotl-arena/game-logic';
import { PlayerDriver, TIMEOUTS } from '../src/player.js';
import { ExpectedGame } from '../src/expected.js';
import { ChainClient, canonicalField, nullifierOf, type GameNullifierName } from '../src/chain.js';
import { BACKEND_URL, readStackInfo } from '../src/env.js';

const STARTER_CARDS = [1, 2, 3, 4, 5];
const STARTER_TOKENS = 100;
// Play 4 moves (P1:0,2  P2:1,3) → it is P1's turn again, and P1 owes the move.
const PRE_MOVES = 4;
/** An unwind releases both hands' five prepared returns and no reward. */
const UNWIND_NOTE_HASHES = 10;

const COMMITTED: GameNullifierName[] = ['created', 'seat2', 'joined'];
const CLAIM_1: GameNullifierName[] = [...COMMITTED, 'claim_slot(1)', 'claim(1,2)'];
const CONTESTED: GameNullifierName[] = [...CLAIM_1, 'contested_by(1)', 'contest(1)', 'resolved(1)'];
const CLAIM_2: GameNullifierName[] = [...CONTESTED, 'claim_slot(2)', 'claim(2,2)'];
const FINALIZED: GameNullifierName[] = [...CLAIM_2, 'resolved(2)', 'done'];

test.describe.serial('present-but-idle abandonment', () => {
  let p1d: PlayerDriver; // queues first → player1 → the ABANDONER (idles, then contests once)
  let p2d: PlayerDriver; // player2 → the CLAIMANT

  test.afterAll(async () => {
    await p1d?.dispose();
    await p2d?.dispose();
  });

  test('P1 idles → P2 claims → P1 contests from the menu → P2 claims again → finalize returns both hands', async () => {
    const stack = readStackInfo();
    if (!stack.addresses) throw new Error('stack.json has no contract addresses — setup incomplete');
    const chain = await ChainClient.connect(stack.addresses);

    // ── Onboard ──────────────────────────────────────────────────────────────
    p1d = await PlayerDriver.launch('p1-abandoner', stack.logsDir);
    await p1d.waitConnected();
    p2d = await PlayerDriver.launch('p2-claimant', stack.logsDir);
    await p2d.waitConnected();
    for (const d of [p1d, p2d]) {
      expect(await d.privateCards(), `${d.name} starter cards`).toEqual(STARTER_CARDS);
      expect(await d.tokenBalance(), `${d.name} starter tokens`).toBe(STARTER_TOKENS);
    }

    // ── Matchmaking: p1d queues FIRST → player1 (the abandoner) ──────────────
    await p1d.startMatchmaking(STARTER_CARDS);
    await p2d.startMatchmaking(STARTER_CARDS);
    const [g1, g2] = await Promise.all([p1d.waitInGame(), p2d.waitInGame()]);
    expect(g1.ws.gameId).toEqual(g2.ws.gameId);
    const wsGameId = g1.ws.gameId!;
    expect(g1.ws.playerNumber, 'p1d queued first → player1').toBe(1);
    expect(g2.ws.playerNumber, 'p2d → player2').toBe(2);
    const byNumber = new Map<number, PlayerDriver>([[1, p1d], [2, p2d]]);
    const driverFor = (p: Player) => byNumber.get(p === 'player1' ? 1 : 2)!;

    // ── Play 4 moves (P1,P2,P1,P2), board cross-checked, stop on P1's turn ───
    const mirror = new ExpectedGame(STARTER_CARDS, STARTER_CARDS);
    for (let m = 0; m < PRE_MOVES; m++) {
      const player = mirror.state.currentTurn;
      const mover = driverFor(player);
      const { handIndex, row, col } = mirror.nextMove();
      await mover.waitReadyToMove();
      await mover.selectHandCard(handIndex);
      await mover.clickCell(row, col);
      mirror.apply(player, handIndex, row, col);
      const [mp, op] = await Promise.all([
        mover.waitBoardCount(mirror.occupiedCount),
        (mover === p1d ? p2d : p1d).waitBoardCount(mirror.occupiedCount),
      ]);
      for (const ph of [mp, op]) {
        expect(ph.game!.board.map(r => r.map(c => ({ cardId: c.cardId, owner: c.owner }))),
          `board after move ${m}`).toEqual(mirror.board);
      }
    }
    // It must now be P1's turn (the abandoner owes the next move) — on both UIs.
    expect(mirror.state.currentTurn, 'after 4 moves it is player1 (abandoner) turn').toBe('player1');
    for (const d of [p1d, p2d]) {
      expect((await d.phase()).game!.currentTurn, `${d.name} sees player1's turn`).toBe('player1');
    }

    // ── P1 STOPS. The relay warns BOTH browsers of IMPENDING abandonment during
    //    the runway BEFORE the 60s deadline: idlePlayer=player1, with a live
    //    countdown still > 0. A ws-relay signal, independent of the chain. ──
    const [w1, w2] = await Promise.all([
      p1d.waitAbandonmentWarning('player1'),
      p2d.waitAbandonmentWarning('player1'),
    ]);
    for (const [d, w] of [[p1d, w1], [p2d, w2]] as const) {
      expect(w.abandonment.warning!.idlePlayer, `${d.name} warning idlePlayer`).toBe('player1');
      expect(w.abandonment.warning!.secondsIdle, `${d.name} warned during the runway`).toBeGreaterThanOrEqual(30);
      expect(w.abandonment.warning!.secondsUntilClaimable, `${d.name} impending: countdown still running`).toBeGreaterThan(0);
    }

    // ── The deadline passes (>=60s idle) → the claim becomes AVAILABLE to P2. ──
    await p2d.waitClaimAvailable();

    // ── The claim is an ON-CHAIN action on the game's nullifiers: both players
    //    must hold the game (key + both records), and both commits must be on
    //    chain. P1 learns the joiner's record only once it has seen the join. ──
    await p2d.expectEventually('P2 holds both records', async () => {
      const g = await p2d.storedGame(wsGameId);
      return !!g?.gameKey && !!g.record1 && !!g.record2;
    }, true, TIMEOUTS.onboarding);
    const ref = await p2d.gameRef(wsGameId);
    await p1d.expectEventually('P1 holds the same game (key and both records)', async () => {
      const g = await p1d.storedGame(wsGameId);
      return g ? { gameKey: g.gameKey, record1: g.record1, record2: g.record2 } : null;
    }, ref, TIMEOUTS.onboarding);
    const committed = await chain.waitForState(ref, COMMITTED, TIMEOUTS.onboarding, 'create + join mined');
    for (const d of [p1d, p2d]) {
      const id = (await d.phase()).chain.onChainGameId;
      expect(id ? canonicalField(id) : null, `${d.name}'s on-chain game id is the created nullifier`)
        .toBe(nullifierOf(committed, 'created'));
    }

    // ═══ 1. CLAIM 1 ═══════════════════════════════════════════════════════════
    const claimMark = p2d.consoleMark();
    await p2d.claimAbandonedGame();
    await p2d.waitClaimingAbandoned();
    // The relay offered the claim after a minute of idling, but the contract
    // takes it only once the game is MIN_ABANDON_SECONDS (8 min of chain time)
    // past the join: the flow waits that out before proving, this wait covers it.
    await chain.waitForState(ref, CLAIM_1, TIMEOUTS.settleTx, 'claim 1 filed by player 2');

    // ═══ 2. CONTEST — P1 comes back to a claimed game ═══════════════════════
    await p1d.reload();
    await p1d.waitScreen('main-menu', TIMEOUTS.boardUpdate);
    // Marked after the reload's boot (its card-store restore imports nothing:
    // the committed hand left the store), so only the recovery counts below.
    const p1Mark = p1d.consoleMark();
    await p1d.waitStuckGame('contestable');
    await p1d.contestClaim();
    await chain.waitForState(ref, CONTESTED, TIMEOUTS.settleTx, 'player 1 contested claim 1');
    // A contest restarts the abandonment clock: the game is too young to claim again.
    await p1d.waitStuckGame('too-soon');

    // ═══ 3. P2's claim stands down when its window closes ═══════════════════
    await p2d.waitPhase('claim 1 stood down (contested)',
      p => p.abandonment.isClaimingAbandoned === false && p.game?.status === 'playing',
      TIMEOUTS.settleTx);
    expect(p2d.consoleSince(claimMark).some(l => l.includes('our claim was contested — the game goes on')),
      'P2 saw its claim contested and let the game go on').toBe(true);
    expect((await chain.gameState(ref)).present, 'a contested claim resolves nothing').toEqual(CONTESTED);

    // ═══ 4. CLAIM 2 — P1 is still idle; it may not contest again ════════════
    await p2d.waitClaimAvailable();
    await p2d.claimAbandonedGame();
    await p2d.waitClaimingAbandoned();
    await chain.waitForState(ref, CLAIM_2, TIMEOUTS.settleTx, 'claim 2 filed by player 2');
    // Each side contests once: P1's menu now offers nothing but the wait.
    // (The menu looks again once a minute.)
    await p1d.waitStuckGame('claim-pending', TIMEOUTS.eventually);
    await expect(p1d.page.getByTestId('contest-claim'), 'no second contest is offered').toHaveCount(0);

    // ═══ 5. FINALIZE — one tx returns both hands ════════════════════════════
    const finalized = await chain.waitForState(ref, FINALIZED, TIMEOUTS.settleTx, 'claim 2 finalized');
    const unwindTx = await chain.txOf(finalized, 'done');
    expect(unwindTx.nullifiers, 'the finalize resolves claim 2 in the same tx')
      .toContain(nullifierOf(finalized, 'resolved(2)'));
    expect(unwindTx.noteHashes.length, 'finalize releases both hands\' ten returns, no reward')
      .toBe(UNWIND_NOTE_HASHES);

    // Each player holds exactly its own five again, and nobody was paid.
    for (const d of [p2d, p1d]) {
      await d.expectEventually(`${d.name} holds its own five again`,
        async () => (await d.privateCards()).sort((a, b) => a - b), STARTER_CARDS);
      expect(await d.tokenBalance(), `${d.name}: an abandonment pays no reward`).toBe(STARTER_TOKENS);
    }
    // ...each by importing its OWN prepared returns from the unwind tx.
    p2d.expectOwnNotesImported(claimMark, STARTER_CARDS.length, 'abandoned recovery (claimant)', { reward: false });
    p1d.expectOwnNotesImported(p1Mark, STARTER_CARDS.length, 'abandoned recovery (abandoner)', { reward: false });
    const p2Stored = await p2d.storedGame(wsGameId);
    expect(p2Stored?.resolutionTxHash ? canonicalField(p2Stored.resolutionTxHash) : null,
      'P2 imported from the tx that pushed done').toBe(unwindTx.txHash);

    // ── Backend: P2 reported the mined unwind; the room is finished ────────
    const roomRes = await fetch(`${BACKEND_URL}/games/${wsGameId}`);
    if (roomRes.ok) {
      const room = await roomRes.json() as { status: string };
      expect(room.status, 'backend room finished after the unwind').toBe('finished');
    }

    // ...and the game stays over. A finished lifecycle ends in 'idle', which is
    // also where the create/join pipeline starts, and the relay's follow-up
    // GAME_OVER once restarted it on a dead game. Nothing in a correct flow
    // goes idle → creating/awaiting_create after the claim, so give the relay's
    // messages a window and check that nothing did.
    await p2d.page.waitForTimeout(15_000);
    expect(p2d.consoleSince(claimMark).filter(l => /Phase: idle → (creating|awaiting_create)/.test(l)),
      'the on-chain pipeline restarted on a finished game').toEqual([]);
  });
});
