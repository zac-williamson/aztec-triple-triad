/**
 * Present-but-idle abandonment E2E under the private-games protocol
 * (docs/plan/PRIVATE_GAMES.md section 3.4): walking away from a started game
 * costs the leaver one of their open cards.
 *
 * FLOW: onboard 2 accounts → create+join → play 4 moves (P1,P2,P1,P2) so it is
 * P1's turn → P1 STOPS (its game stays open) → during the runway BEFORE the 60s
 * deadline the relay warns BOTH browsers of IMPENDING abandonment
 * (idlePlayer=player1, countdown > 0) → at the deadline the claim becomes
 * available → P2 (the non-idle player) claims:
 *
 *   1. CLAIM 1. The flow waits until the game is MIN_ABANDON_SECONDS (8 min)
 *      past the join on chain time, then files claim 1 (`claim_slot(1)`,
 *      `claim(1,2)`), taking P1's strongest open card — its terms nullifier,
 *      read here with the contract's `forfeit_nullifiers`.
 *   2. CONTESTED BY P1'S OPEN GAME. P1 stopped moving but never left: its
 *      client watches the game's claims and contests one against it as it
 *      lands (`contested_by(1)`, `contest(1)`, `resolved(1)`), with no click.
 *   3. P2's dispute window closes on a contested claim: its flow stands down
 *      ("the game goes on") instead of finalizing — nothing resolved.
 *   4. CLAIM 2. P1 is still idle, so the relay offers the claim again and P2
 *      files claim 2 (`claim_slot(2)`, `claim(2,2)`), taking the same card.
 *      Each side contests once: P1's game lets it stand, and when P1 reloads,
 *      its menu offers nothing but the wait (`stuck-game-claim-pending`).
 *   5. FINALIZE. When claim 2's window closes, P2's game and P1's menu both
 *      finalize by themselves (anyone may; one wins, the other imports from
 *      it): `resolved(2)`, `done`. ONE tx releases ten notes — P2's five
 *      returns, P1's four, and P1's card on P2's prize partial — and no
 *      reward. P2 imports six, P1 four. Both started with the same five ids,
 *      so P2 ends holding two copies of the forfeited card.
 *
 * Fully asserts reality — no masks / relaxed asserts: deterministic keys, the
 * REAL 60s inactivity threshold, the REAL 8-minute abandonment bar and
 * 10-minute dispute windows on chain time, and the independent ChainClient
 * (third pair of eyes) reading the game's nullifiers and the claims' terms.
 * About 35 minutes, most of it those waits.
 *
 * Phase B (docs/plan/PRIVATE_GAMES.md §6): the relay times the idle turn from
 * its move COUNT alone, and is told nothing of what follows — no claim, no
 * contest, no finalize. Its room still says "active, four moves" at the end.
 */
import { test, expect } from '@playwright/test';
import type { Player } from '@axolotl-arena/game-logic';
import { PlayerDriver, TIMEOUTS } from '../src/player.js';
import { ExpectedGame, expectedForfeit } from '../src/expected.js';
import { ChainClient, canonicalField, nullifierOf, type GameNullifierName } from '../src/chain.js';
import { playMoves, expectTranscriptsAgree, storedGames } from '../src/play.js';
import { expectRelayBlind, expectRelayLogBlind, expectRoomIsPipe, relayRoom } from '../src/relay.js';
import { readStackInfo } from '../src/env.js';

const STARTER_CARDS = [1, 2, 3, 4, 5];
const STARTER_TOKENS = 100;
// Play 4 moves (P1:0,2  P2:1,3) → it is P1's turn again, and P1 owes the move.
const PRE_MOVES = 4;
/** A finalize releases ten notes either way (here: 5 + 4 returns and the forfeited card), and no reward. */
const FINALIZE_NOTE_HASHES = 10;

const COMMITTED: GameNullifierName[] = ['created', 'seat2', 'joined'];
const CLAIM_1: GameNullifierName[] = [...COMMITTED, 'claim_slot(1)', 'claim(1,2)'];
const CONTESTED: GameNullifierName[] = [...CLAIM_1, 'contested_by(1)', 'contest(1)', 'resolved(1)'];
const CLAIM_2: GameNullifierName[] = [...CONTESTED, 'claim_slot(2)', 'claim(2,2)'];
const FINALIZED: GameNullifierName[] = [...CLAIM_2, 'resolved(2)', 'done'];

test.describe.serial('present-but-idle abandonment', () => {
  let p1d: PlayerDriver; // queues first → player1 → the ABANDONER (idles; its open game contests once)
  let p2d: PlayerDriver; // player2 → the CLAIMANT

  test.afterAll(async () => {
    await p1d?.dispose();
    await p2d?.dispose();
  });

  test('P1 idles → P2 claims P1\'s open card → P1\'s game contests → P2 claims again → finalize: six and four', async () => {
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

    // ── Play 4 moves (P1,P2,P1,P2), both games checked, stop on P1's turn ───
    const mirror = new ExpectedGame(STARTER_CARDS, STARTER_CARDS);
    await playMoves(mirror, driverFor, PRE_MOVES);
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
    // Both hold the same four moves and proofs — the game a claim abandons.
    expectTranscriptsAgree(mirror, await storedGames(driverFor, wsGameId), 'before the claim: ');
    // The relay times the idle turn from its move count, and knows no more.
    expectRoomIsPipe(await relayRoom(wsGameId), wsGameId, { status: 'active', movesMade: PRE_MOVES }, 'relay, P1 idle');

    // What a claim against P1 takes: the strongest of P1's open cards (its
    // committed slots 0..2), which P2 has seen and checked since the game began.
    const p1Hand = (await p1d.storedGame(wsGameId))!.selectedCardIds;
    const P1_OPEN = p1Hand.slice(0, 3);
    const FORFEIT = expectedForfeit(p1Hand);
    expect((await p2d.storedGame(wsGameId))?.opponentOpenCards, 'P2 holds P1\'s checked open cards').toEqual(P1_OPEN);

    // ═══ 1. CLAIM 1 — P2 takes P1's strongest open card ════════════════════
    const claimMark = p2d.consoleMark();
    const p1WatchMark = p1d.consoleMark();
    await p2d.claimAbandonedGame();
    await p2d.waitClaimingAbandoned();
    // The relay offered the claim after a minute of idling, but the contract
    // takes it only once the game is MIN_ABANDON_SECONDS (8 min of chain time)
    // past the join: the flow waits that out before proving, this wait covers it.

    // ═══ 2. CONTESTED — by P1's open game, with no click ═══════════════════
    await chain.waitForState(ref, CONTESTED, TIMEOUTS.settleTx, 'claim 1 filed by player 2, contested by player 1\'s game');
    expect(await chain.forfeitTerms(ref, 1, 2, P1_OPEN), 'claim 1 named P1\'s strongest open card').toEqual(FORFEIT);
    expect(p1d.consoleSince(p1WatchMark).some(l => l.includes('filed claim 1 while we are here — contesting it')),
      'P1\'s game contested the claim by itself').toBe(true);

    // ═══ 3. P2's claim stands down when its window closes ═══════════════════
    await p2d.waitPhase('claim 1 stood down (contested)',
      p => p.abandonment.isClaimingAbandoned === false && p.game?.status === 'playing',
      TIMEOUTS.settleTx);
    expect(p2d.consoleSince(claimMark).some(l => l.includes('our claim was contested — the game goes on')),
      'P2 saw its claim contested and let the game go on').toBe(true);
    expect((await chain.gameState(ref)).present, 'a contested claim resolves nothing').toEqual(CONTESTED);

    // ═══ 4. CLAIM 2 — P1 is still idle; its one contest is spent ═══════════
    await p2d.waitClaimAvailable();
    await p2d.claimAbandonedGame();
    await p2d.waitClaimingAbandoned();
    await chain.waitForState(ref, CLAIM_2, TIMEOUTS.settleTx, 'claim 2 filed by player 2');
    expect(await chain.forfeitTerms(ref, 2, 2, P1_OPEN), 'claim 2 named the same card').toEqual(FORFEIT);
    // P1 comes back to the menu: each side contests once, so it offers nothing
    // but the wait. (Marked here: nothing of P1's has been imported yet.)
    await p1d.reload();
    await p1d.waitScreen('main-menu', TIMEOUTS.boardUpdate);
    await p1d.waitStuckGame('claim-pending', TIMEOUTS.eventually);
    const p1Mark = p1d.consoleMark();
    await expect(p1d.page.getByTestId('contest-claim'), 'no second contest is offered').toHaveCount(0);

    // ═══ 5. FINALIZE — the leaver pays one open card ════════════════════════
    const finalized = await chain.waitForState(ref, FINALIZED, TIMEOUTS.settleTx, 'claim 2 finalized');
    const finalizeTx = await chain.txOf(finalized, 'done');
    expect(finalizeTx.nullifiers, 'the finalize resolves claim 2 in the same tx')
      .toContain(nullifierOf(finalized, 'resolved(2)'));
    expect(finalizeTx.noteHashes.length, 'finalize releases ten notes: 5 + 4 returns and the forfeited card, no reward')
      .toBe(FINALIZE_NOTE_HASHES);

    // P2: its five back plus P1's card. P1: its other four. Nobody was paid.
    const sorted = (ids: number[]) => [...ids].sort((a, b) => a - b);
    const p1Left = [...STARTER_CARDS];
    p1Left.splice(p1Left.indexOf(FORFEIT.cardId), 1);
    await p2d.expectEventually('P2 holds its five plus the card P1 forfeited',
      async () => sorted(await p2d.privateCards()), sorted([...STARTER_CARDS, FORFEIT.cardId]));
    await p1d.expectEventually('P1 holds its other four',
      async () => sorted(await p1d.privateCards()), sorted(p1Left));
    for (const d of [p2d, p1d]) {
      expect(await d.tokenBalance(), `${d.name}: an abandonment pays no reward`).toBe(STARTER_TOKENS);
    }
    // ...each by importing its OWN notes from the finalize tx: P2 its five
    // returns and the card on its prize partial, P1 its four returns.
    p2d.expectOwnNotesImported(claimMark, STARTER_CARDS.length + 1, 'abandoned recovery (claimant)', { reward: false });
    p1d.expectOwnNotesImported(p1Mark, STARTER_CARDS.length - 1, 'abandoned recovery (abandoner)', { reward: false });
    const p2Stored = await p2d.storedGame(wsGameId);
    expect(p2Stored?.resolutionTxHash ? canonicalField(p2Stored.resolutionTxHash) : null,
      'P2 imported from the tx that pushed done').toBe(finalizeTx.txHash);

    // ── The relay was told nothing of the claims or the finalize ───────────
    // Its room — if it still holds it: rooms are swept 30 minutes after the
    // last move, and the claims alone take longer — says just what it said
    // while P1 idled: active, four moves.
    const room = await relayRoom(wsGameId);
    if (room) expectRoomIsPipe(room, wsGameId, { status: 'active', movesMade: PRE_MOVES }, 'relay after the finalize');
    expectRelayBlind([
      { driver: p1d, seat: 1, mark: 0 },
      { driver: p2d, seat: 2, mark: 0 },
    ], wsGameId, PRE_MOVES, 'relay traffic');
    expectRelayLogBlind(stack.logsDir, wsGameId, PRE_MOVES, 'relay log');

    // ...and the game stays over. A finished lifecycle ends in 'idle', which is
    // also where the create/join pipeline starts, and a late relay message
    // (Phase A's GAME_OVER) once restarted it on a dead game. Nothing in a
    // correct flow goes idle → creating/awaiting_create after the claim, so
    // give the relay's messages a window and check that nothing did.
    await p2d.page.waitForTimeout(15_000);
    expect(p2d.consoleSince(claimMark).filter(l => /Phase: idle → (creating|awaiting_create)/.test(l)),
      'the on-chain pipeline restarted on a finished game').toEqual([]);
  });
});
