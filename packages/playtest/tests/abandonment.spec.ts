/**
 * Phase-1 present-but-idle abandonment E2E (docs/plan/ABANDONED_GAMES.md).
 *
 * RUN MODE: a LOCAL backend (the merged ws-relay with the new present-but-idle
 * inactivity detection) as the relay + local vite + the LIVE testnet chain /
 * deployed contracts. The deployed game contract already exposes
 * claim_abandoned_game / settle_abandoned_game (verified in the target artifact),
 * so ONLY the relay's GAME_ABANDONMENT_WARNING is new — hence the harness runs
 * with PLAYTEST_TESTNET=1 PLAYTEST_LOCAL_BACKEND=1 (see src/stack.ts).
 *
 * FLOW: onboard 2 pre-funded accounts → create+join → play 4 moves (P1,P2,P1,P2)
 * so the abandoner has played >=2 cards (claimable) and it is P1's turn → P1 STOPS
 * (never moves) → during the runway BEFORE the 60s deadline the relay warns BOTH
 * browsers of IMPENDING abandonment (idlePlayer=player1, countdown > 0) → at the
 * 60s deadline the claim becomes available → P2 (the non-idle player) claims →
 * claim_abandoned_game (on-chain status → 5 abandoned_claimed) → on-chain dispute
 * window (>=5 blocks) → settle_abandoned_game (status → 3 settled) → P2 receives
 * the claimed card (P1's hand[0]).
 *
 * Fully asserts reality — no masks / relaxed asserts: deterministic keys, the
 * REAL 60s inactivity threshold, the REAL on-chain claim/dispute/settle path,
 * and the independent ChainClient (third pair of eyes) for the status.
 */
import { test, expect } from '@playwright/test';
import type { Player } from '@axolotl-arena/game-logic';
import { PlayerDriver, TIMEOUTS } from '../src/player.js';
import { ExpectedGame } from '../src/expected.js';
import { ChainClient, GAME_STATUS } from '../src/chain.js';
import { readStackInfo } from '../src/env.js';

const STARTER_CARDS = [1, 2, 3, 4, 5];
// Play 4 moves (P1:0,2  P2:1,3) → board holds claimable cards AND it's P1's
// turn again. handleAbandonedGame claims a card only when BOTH hold:
//   (1) `numValid >= 2` — the claimant collected >=2 proofs of the OPPONENT's
//       moves (i.e. the abandoner actually played). With 2 total moves P1 has
//       played just 1, so this fails and BOTH recover. 4 total moves → P1 has
//       played 2 → satisfied.
//   (2) the claimant KNOWS the abandoner's hand (`opponentCardIds`). Card ids are
//       normally exchanged only at GAME_OVER, which an abandonment never reaches —
//       so the relay rides the idle player's hand on GAME_ABANDONMENT_WARNING and
//       the claimant adopts it (backend GameManager.findIdleGames + useWebSocket).
// Both satisfied → a card (P1's hand[0]) is genuinely claimed.
const PRE_MOVES = 4;

/** Multiset of card ids (a win/claim can add a second copy of an id). */
function countMap(ids: number[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const id of ids) m.set(id, (m.get(id) ?? 0) + 1);
  return m;
}

/**
 * Poll the harness's independent node client until the public game status
 * reaches `target`. Throws with the last-seen status on timeout — a real failure,
 * never masked. (A thrown read propagates: it means the read itself is broken.)
 */
async function waitGameStatus(
  chain: ChainClient, gameId: string, target: number, timeoutMs: number, label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  while (Date.now() < deadline) {
    last = await chain.gameStatus(gameId);
    if (last === target) return;
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error(`${label}: on-chain status never reached ${target} within ${timeoutMs / 1000}s (last=${last})`);
}

/**
 * Poll the clients until one publishes the on-chain game id. The ws-relayed
 * moves run AHEAD of on-chain create_game/join_game inclusion on testnet, so the
 * id only appears once create_game is mined + the session captures it. Throws on
 * timeout — a real failure (create_game never mined).
 */
async function waitForOnChainGameId(drivers: PlayerDriver[], timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const d of drivers) {
      const id = (await d.phase()).chain.onChainGameId;
      if (id) return id;
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error(`on-chain game id never published within ${timeoutMs / 1000}s (create_game not mined?)`);
}

test.describe.serial('present-but-idle abandonment', () => {
  let p1d: PlayerDriver; // queues first → player1 → the ABANDONER (idles)
  let p2d: PlayerDriver; // player2 → the CLAIMANT

  test.afterAll(async () => {
    await p1d?.dispose();
    await p2d?.dispose();
  });

  test('P1 idles 60s → both warned → P2 claims a card → settled via abandonment', async () => {
    const stack = readStackInfo();
    if (!stack.addresses) throw new Error('stack.json has no contract addresses — setup incomplete');
    const chain = await ChainClient.connect(stack.addresses);

    // ── Onboard (restore pre-funded accounts; no funding step) ──────────────
    p1d = await PlayerDriver.launch('p1-abandoner', stack.logsDir);
    await p1d.waitConnected();
    p2d = await PlayerDriver.launch('p2-claimant', stack.logsDir);
    await p2d.waitConnected();
    for (const d of [p1d, p2d]) {
      expect(await d.privateCards(), `${d.name} starter cards`).toEqual(STARTER_CARDS);
    }

    // ── Matchmaking: p1d queues FIRST → player1 (the abandoner) ──────────────
    await p1d.startMatchmaking(STARTER_CARDS);
    await p2d.startMatchmaking(STARTER_CARDS);
    const [g1, g2] = await Promise.all([p1d.waitInGame(), p2d.waitInGame()]);
    expect(g1.ws.gameId).toEqual(g2.ws.gameId);
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
    // The contract claims the opponent's hand[0]; P1's hand is STARTER, so card 1.
    const claimedCard = STARTER_CARDS[0];

    // ── P1 STOPS. The relay warns BOTH browsers of IMPENDING abandonment during
    //    the runway BEFORE the 60s deadline (warn lead, docs/plan/ABANDONED_GAMES.md):
    //    idlePlayer=player1, with a live countdown still > 0 (not yet claimable).
    //    The idle player (P1) gets this too — it is their forfeit countdown. No
    //    move is driven for p1d; this is a ws-relay signal, independent of
    //    on-chain inclusion. ──
    const [w1, w2] = await Promise.all([
      p1d.waitAbandonmentWarning('player1'),
      p2d.waitAbandonmentWarning('player1'),
    ]);
    for (const [d, w] of [[p1d, w1], [p2d, w2]] as const) {
      expect(w.abandonment.warning!.idlePlayer, `${d.name} warning idlePlayer`).toBe('player1');
      expect(w.abandonment.warning!.secondsIdle, `${d.name} warned during the runway`).toBeGreaterThanOrEqual(30);
      expect(w.abandonment.warning!.secondsUntilClaimable, `${d.name} impending: countdown still running`).toBeGreaterThan(0);
    }

    // ── The deadline passes (>=60s idle) → the claim becomes AVAILABLE to P2
    //    (the non-idle player), mirroring the enabled "Claim abandoned game"
    //    button. P1 keeps idling, so it stays claimable. ──
    await p2d.waitClaimAvailable();

    // ── The claim is an ON-CHAIN action: wait for create_game + join_game to be
    //    MINED (the ws moves above ran ahead of on-chain inclusion). onChainGameId
    //    is published once create_game mines; status reaches active once join
    //    mines. P1 keeps idling throughout, so the warning stays live. ──
    const onChainGameId = await waitForOnChainGameId([p1d, p2d], TIMEOUTS.onboarding);
    await waitGameStatus(chain, onChainGameId, GAME_STATUS.active, TIMEOUTS.onboarding,
      'on-chain game active (create+join mined)');

    // ── P2 (non-idle) triggers the abandoned-game claim ─────────────────────
    await p2d.claimAbandonedGame();
    await p2d.waitClaimingAbandoned();

    // claim_abandoned_game lands on-chain → status 5 (abandoned_claimed).
    await waitGameStatus(chain, onChainGameId!, GAME_STATUS.abandoned_claimed, TIMEOUTS.settleTx, 'claim_abandoned_game');

    // on-chain dispute window (>=5 blocks / ~65s) → settle_abandoned_game → 3.
    await waitGameStatus(chain, onChainGameId!, GAME_STATUS.settled, TIMEOUTS.settleTx, 'settle_abandoned_game');

    // ── Assert: settled VIA abandonment (status path 2 → 5 → 3 above) ───────
    expect(await chain.gameStatus(onChainGameId!), 'on-chain settled via abandonment').toBe(GAME_STATUS.settled);
    const players = await chain.gamePlayers(onChainGameId!);
    const onChain = [players.player1.toLowerCase(), players.player2.toLowerCase()].sort();
    const browsers = [
      (await p1d.phase()).accountAddress!.toLowerCase(),
      (await p2d.phase()).accountAddress!.toLowerCase(),
    ].sort();
    expect(onChain, 'on-chain players match the two accounts').toEqual(browsers);

    // ── Assert: P2 (claimant) GOT the claimed card ──────────────────────────
    // settle_abandoned_game re-mints P2's 5 committed cards (frontend import) and
    // mints the claimed card PRIVATELY to P2 (tagged → discovered by P2's PXE
    // block scan; the frontend does not import it explicitly). So P2's private
    // cards reach pre-game count + 1, with one extra copy of the claimed id.
    await p2d.expectEventually(`P2 (claimant) card count = pre-game +1`,
      async () => (await p2d.privateCards()).length, STARTER_CARDS.length + 1);
    await p2d.expectEventually(`P2 multiset gained claimed #${claimedCard}`,
      async () => (countMap(await p2d.privateCards()).get(claimedCard) ?? 0),
      (countMap(STARTER_CARDS).get(claimedCard) ?? 0) + 1);
  });
});
