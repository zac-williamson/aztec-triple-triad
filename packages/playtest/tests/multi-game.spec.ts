/**
 * Campaign C-multi (docs/plan/CAMPAIGN_MULTIGAME.md): two players open a card
 * pack each (→15 cards), then play FIVE consecutive games in ONE session,
 * validating three layers + NO carryover after each game.
 *
 * Targets the multi-game bug class: a single game works, but consecutive games
 * in one session raise state-carryover / note-discovery / proof-chain-reuse
 * errors. So this STOPS at the first failing game and reports the game #, the
 * failing layer, the exact error, and the suspected carryover source. The stack
 * is NOT reset between games — that is the whole point.
 *
 * Real proofs, real UI clicks (testkit), three-layer validation — same rigor as
 * the C1 ladder. Winner is derived from the live rules mirror (not hardcoded);
 * who queues first (→ P1) alternates each game to vary the win/loss paths.
 */
import os from 'os';
import { test, expect } from '@playwright/test';
import type { Player } from '@axolotl-arena/game-logic';
import { PlayerDriver } from '../src/player.js';
import { ExpectedGame } from '../src/expected.js';
import { ChainClient, GAME_STATUS } from '../src/chain.js';
import { BACKEND_URL, readStackInfo, type ContractAddresses } from '../src/env.js';

const STARTER_CARDS = [1, 2, 3, 4, 5];
const STARTER_TOKENS = 100;
const PACK_COST = 100;
const PACK_SIZE = 10;
const GAME_REWARD = 20;
const HAND = 5;
// Default 5 per the campaign; lower via MULTIGAME_GAMES while iterating the
// harness in real-proof mode (each game is minutes — fast mode isn't wired).
const GAMES = Number(process.env.MULTIGAME_GAMES ?? 5);

/** Multiset of card ids (collections can hold duplicate type-ids after wins). */
function countMap(ids: number[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const id of ids) m.set(id, (m.get(id) ?? 0) + 1);
  return m;
}

/** 5 DISTINCT lowest ids the player owns — distinct avoids the C2 self-replay
 *  guard (a player may not place two cards with the same id). */
function pickHand(owned: number[]): number[] {
  const distinct = [...new Set(owned)].sort((a, b) => a - b);
  if (distinct.length < HAND) throw new Error(`only ${distinct.length} distinct cards owned, need ${HAND}`);
  return distinct.slice(0, HAND);
}

/**
 * Hard wall-clock guard around a campaign phase. A stuck run FAILS FAST instead
 * of zombie-hanging until the 60-min Playwright test timeout. Races against:
 *  - a wall-clock budget (the proof physics ceiling for a healthy run),
 *  - each driver's `dead` signal (a crashed/wedged page, watchdog-detected in
 *    ~2 min), AND
 *  - the backend-liveness signal (the WS relay process dying mid-run — the
 *    proven cause of BOTH prior campaign hangs: it manifested as onboarding's
 *    ws.connected staying false and as a settled winner unable to relay the
 *    note to the loser; without this guard either just runs out the deadline
 *    far from the real cause).
 * `deadSignals` are never-resolving rejections; passing them here surfaces the
 * true failure fast — it does NOT retry or mask anything.
 */
async function withDeadline<T>(
  label: string, ms: number, deadSignals: Promise<never>[], fn: () => Promise<T>,
): Promise<T> {
  let timer: NodeJS.Timeout;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`PHASE TIMEOUT: "${label}" did not finish within ${ms / 1000}s — likely a hang`)), ms);
  });
  try {
    return await Promise.race([fn(), guard, ...deadSignals]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Backend-liveness watchdog. Polls `/health`; after a few consecutive failures
 * it rejects with a timestamped "BACKEND DEAD" so a phase racing it fails in
 * ~15s instead of running out a 7–25 min deadline. This is diagnosis, not a
 * mask: the WS relay process exiting mid-run is exactly what wedged the two
 * acceptance runs (winner settles on-chain but cannot relay the won-card note;
 * onboarding never sees ws.connected) — and the failure pointed at the wrong
 * layer because nothing watched the backend itself.
 */
function startBackendLiveness(): { dead: Promise<never>; stop: () => void } {
  const EVERY = 5_000, PROBE_TIMEOUT = 5_000, MAX_FAILS = 3;
  let timer: NodeJS.Timeout;
  let stopped = false;
  let fails = 0;
  let rejectDead!: (e: Error) => void;
  const dead = new Promise<never>((_, reject) => { rejectDead = reject; });
  dead.catch(() => {}); // never an unhandled rejection if nothing is racing it
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const res = await fetch(`${BACKEND_URL}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT) });
      fails = res.ok ? 0 : fails + 1;
    } catch { fails++; }
    if (stopped) return;
    if (fails >= MAX_FAILS) {
      rejectDead(new Error(
        `BACKEND DEAD: ${BACKEND_URL}/health unreachable ${fails}× (~${(fails * EVERY) / 1000}s) ` +
        `at ${new Date().toISOString()} — the WS relay process exited mid-run (inspect backend.log; ` +
        `no "backend stopped" at teardown == it was already gone). This is the root cause of the ` +
        `two prior campaign hangs, surfaced fast instead of as a phase timeout.`));
      return;
    }
    timer = setTimeout(() => void tick(), EVERY);
  };
  timer = setTimeout(() => void tick(), EVERY);
  return { dead, stop: () => { stopped = true; clearTimeout(timer); } };
}

/**
 * Log host memory + load at each checkpoint. The backend died mid-proof in both
 * acceptance runs; if it dies again on the clean machine, a free-memory cliff or
 * climbing load average right before it would corroborate memory pressure
 * (jetsam) vs. rule it out (the open question the rotated unified-log couldn't
 * answer). `os.freemem()` undercounts cached pages on macOS, so read the trend,
 * not the absolute.
 */
function logMem(label: string): void {
  const gib = (b: number) => (b / 2 ** 30).toFixed(2);
  const freePct = Math.round((os.freemem() / os.totalmem()) * 100);
  const load = os.loadavg().map(n => n.toFixed(1)).join('/');
  console.log(`[mem@${label}] free=${gib(os.freemem())}/${gib(os.totalmem())}GiB (${freePct}%) load(1/5/15)=${load}`);
}

/** Log both tabs' live WebGL context counts — leak (climbs) vs crash (flat). */
async function logWebgl(label: string, drivers: PlayerDriver[]): Promise<void> {
  const parts = await Promise.all(drivers.map(async d => {
    const s = await d.webglStats();
    return s ? `${d.name} live=${s.live} created=${s.created} lost=${s.lost}` : `${d.name} (unreadable)`;
  }));
  console.log(`[webgl@${label}] ${parts.join(' | ')}`);
}

const DEADLINES = { pack: 900_000, game: 1_500_000 }; // 15 min / pack phase, 25 min / game

interface GameRow {
  game: number;
  /** 'decisive' = a winner settled; 'draw' = tied, NOT settled (see draw branch). */
  outcome: 'decisive' | 'draw';
  winner: string;       // driver name (decisive) or 'draw'
  aliceCards: string;   // before→after
  bobCards: string;
  aliceTokens: string;
  bobTokens: string;
  claimed: number | null;   // null on a draw (no card claimed)
  settleOk: boolean | null; // null on a draw (not settled by design)
}

test.describe.serial('multi-game with packs', () => {
  let alice: PlayerDriver;
  let bob: PlayerDriver;
  let backend: { dead: Promise<never>; stop: () => void };
  const rows: GameRow[] = [];
  // Cross-game identity sets: a fresh game must mint a NEW ws room id and a NEW
  // on-chain game id. Re-seeing one fingerprints a specific carryover (see the
  // hypothesis matrix in docs/plan/PLAYTEST_HARNESS.md).
  const seen = { wsGameIds: new Set<string>(), onChainGameIds: new Set<string>() };

  test.afterAll(async () => {
    // Print the per-game table regardless of pass/fail.
    if (rows.length) {
      const fmt = (r: GameRow) =>
        `  game ${r.game} | ${r.outcome === 'draw' ? 'DRAW (no settle)' : `winner=${r.winner}`} | ` +
        `alice cards ${r.aliceCards} tokens ${r.aliceTokens} | bob cards ${r.bobCards} tokens ${r.bobTokens} | ` +
        (r.outcome === 'draw' ? 'hands stranded (product bug)' : `claimed #${r.claimed} | settle ${r.settleOk ? 'OK' : 'FAIL'}`);
      console.log('\n=== C-multi per-game results ===\n' + rows.map(fmt).join('\n') + '\n');
    }
    backend?.stop();
    await alice?.dispose();
    await bob?.dispose();
  });

  test('open packs then play five consecutive games', async () => {
    const stack = readStackInfo();
    if (!stack.addresses) throw new Error('stack.json has no contract addresses — setup incomplete');
    const addresses = stack.addresses;
    const chain = await ChainClient.connect(addresses);
    logMem('start');
    // Watch the WS relay for the whole run; both prior hangs were it dying.
    backend = startBackendLiveness();

    // ── Onboard two ISOLATED browser PROCESSES (one Chromium per player so the
    //    two tabs don't share a GPU process; serial — shared anvil funding key).
    //    Raced against backend.dead: in run #1 the backend died here and the bare
    //    waitConnected ran out its full 420s with ws.connected stuck false. ──
    await withDeadline('onboard both players', DEADLINES.pack, [backend.dead], async () => {
      alice = await PlayerDriver.launch('alice', stack.logsDir);
      await alice.waitConnected();
      bob = await PlayerDriver.launch('bob', stack.logsDir);
      await bob.waitConnected();
      for (const d of [alice, bob]) {
        expect(await d.privateCards(), `${d.name} starter cards`).toEqual(STARTER_CARDS);
        expect(await d.tokenBalance(), `${d.name} starter tokens`).toBe(STARTER_TOKENS);
      }
    });
    logMem('after-onboard');

    // ── Pack open (both) → 15 cards each, 0 tokens; assert discoverability ──
    await withDeadline('open packs (both)', DEADLINES.pack, [alice.dead, bob.dead, backend.dead], async () => {
      for (const d of [alice, bob]) {
        const newIds = await d.openPack();
        expect(newIds.length, `${d.name} pack gives ${PACK_SIZE} cards`).toBe(PACK_SIZE);
        // Chain layer: the 10 new notes are actually discoverable (import_note),
        // not just minted — PXE must report 15 spendable cards.
        await d.expectEventually(`${d.name} chain card count = 15 after pack`,
          async () => (await d.privateCards()).length, STARTER_CARDS.length + PACK_SIZE);
        // Frontend layer: the menu collection reflects 15.
        expect((await d.phase()).ownedCardIds.length, `${d.name} UI collection = 15`).toBe(15);
        // Token economy (queued PXE read): starter 100 − pack 100 = 0.
        await d.expectEventually(`${d.name} tokens after pack = 0`,
          () => d.tokenBalance(), STARTER_TOKENS - PACK_COST);
      }
    });

    await logWebgl('after-packs', [alice, bob]);
    logMem('after-packs');

    // ── FIVE consecutive games in one session ─────────────────────────────
    for (let g = 1; g <= GAMES; g++) {
      // Alternate who queues first → who is P1 (varies win/loss paths).
      const first = g % 2 === 1 ? alice : bob;
      const second = first === alice ? bob : alice;
      await withDeadline(`game ${g}`, DEADLINES.game, [alice.dead, bob.dead, backend.dead], () =>
        playOneGame(g, first, second, chain, addresses, rows, seen));
      await logWebgl(`after-game-${g}`, [alice, bob]);
      logMem(`after-game-${g}`);
    }

    // All games completed. Decisive games must have settled; a draw is a VALID
    // completed game that does NOT settle by design — the draw branch fully
    // asserts its real outcome (incl. the stranded-hands product bug), so it
    // needs no settle assertion here.
    expect(rows.length, 'all games completed').toBe(GAMES);
    for (const r of rows) {
      if (r.outcome === 'draw') continue;
      expect(r.settleOk, `game ${r.game} (decisive) settled`).toBe(true);
    }
  });
});

/**
 * Play one consecutive game. `first` queues first (→ P1). Validates three
 * layers + no-carryover, pushes a result row, and throws (stopping the run) at
 * the first failure — with the game #, layer, and suspected carryover source.
 */
async function playOneGame(
  gameNum: number,
  first: PlayerDriver,
  second: PlayerDriver,
  chain: ChainClient,
  addresses: ContractAddresses,
  rows: GameRow[],
  seen: { wsGameIds: Set<string>; onChainGameIds: Set<string> },
): Promise<void> {
  const alice = first.name === 'alice' ? first : second;
  const bob = first.name === 'alice' ? second : first;

  const where = (layer: string, msg: string) =>
    new Error(`GAME ${gameNum} FAILED [${layer}]: ${msg}`);

  // ── Pre-game ledger (counts are stable: prior game's asserts waited) ──
  const aliceBeforeCards = await alice.privateCards();
  const bobBeforeCards = await bob.privateCards();
  const aliceBeforeTokens = await alice.tokenBalance();
  const bobBeforeTokens = await bob.tokenBalance();

  const firstHand = pickHand((first === alice ? aliceBeforeCards : bobBeforeCards));
  const secondHand = pickHand((second === alice ? aliceBeforeCards : bobBeforeCards));

  // Queue first → P1, then second → P2.
  await first.startMatchmaking(firstHand);
  await second.startMatchmaking(secondHand);
  const [firstGame, secondGame] = await Promise.all([first.waitInGame(), second.waitInGame()]);

  if (firstGame.ws.gameId !== secondGame.ws.gameId) {
    throw where('backend', `players matched into different game rooms ` +
      `(${firstGame.ws.gameId} vs ${secondGame.ws.gameId}) — suspect backend playerToGame ` +
      `mapping not released after game ${gameNum - 1} (lane-4 GameManager.releasePlayersFromGame)`);
  }
  const wsGameId = firstGame.ws.gameId!;
  // Gap 3 (matrix): a fresh game must mint a NEW ws room id. Re-seeing one ==
  // both players re-joined game (i-1)'s stale room (backend never released them).
  if (seen.wsGameIds.has(wsGameId)) throw where('backend',
    `ws room id ${wsGameId} reused from an earlier game — players re-joined a stale room ` +
    `(lane-4 GameManager.releasePlayersFromGame did not release on finish)`);
  seen.wsGameIds.add(wsGameId);

  // ── NO-CARRYOVER: a fresh game must start clean ───────────────────────
  for (const [d, ph] of [[first, firstGame], [second, secondGame]] as const) {
    const c = ph.chain;
    if (c.canSettle) throw where('no-carryover',
      `${d.name} canSettle=true at game start — leftover hand/move proofs from game ${gameNum - 1} ` +
      `(lane-2 useGamePlay reset: collectedMoveProofs/myHandProof)`);
    if (c.settleTxStatus !== 'idle') throw where('no-carryover',
      `${d.name} settleTxStatus='${c.settleTxStatus}' at game start (expected idle) — ` +
      `lane-2 useGameSettlement.resetForMenu`);
    if (c.opponentSettled || c.takenCardId !== null) throw where('no-carryover',
      `${d.name} opponentSettled/takenCardId leaked from game ${gameNum - 1} (lane-2 settlement reset)`);
    if (c.onChainError) throw where('no-carryover', `${d.name} onChainError leaked: ${c.onChainError}`);
    // Gap 7 (matrix): the board must be EMPTY at the start of a fresh game.
    // A stale board == useGameSession/useGame did not clear gameState on
    // returnToMenu — caught here crisply instead of as a later board-count timeout.
    const occupied = ph.game?.board.flat().filter(cell => cell.cardId !== null).length ?? 0;
    if (occupied !== 0) throw where('no-carryover',
      `${d.name} board has ${occupied} cards at game start (expected empty) — stale gameState ` +
      `from game ${gameNum - 1} (lane-2 useGameSession/useGame reset on returnToMenu)`);
  }

  const byNumber = new Map<number, PlayerDriver>([
    [firstGame.ws.playerNumber!, first],
    [secondGame.ws.playerNumber!, second],
  ]);
  if (byNumber.size !== 2) throw where('backend', 'players got the same playerNumber');
  const driverFor = (p: Player) => byNumber.get(p === 'player1' ? 1 : 2)!;
  const p1Hand = byNumber.get(1) === first ? firstHand : secondHand;
  const p2Hand = byNumber.get(2) === first ? firstHand : secondHand;

  // ── Play 9 moves via real clicks, board cross-checked each move ────────
  const mirror = new ExpectedGame(p1Hand, p2Hand);
  for (let m = 0; m < 9; m++) {
    const player = mirror.state.currentTurn;
    const mover = driverFor(player);
    const { handIndex, row, col } = mirror.nextMove();
    await mover.waitReadyToMove();
    await mover.selectHandCard(handIndex);
    await mover.clickCell(row, col);
    mirror.apply(player, handIndex, row, col);
    const [mp, op] = await Promise.all([
      mover.waitBoardCount(mirror.occupiedCount),
      (mover === alice ? bob : alice).waitBoardCount(mirror.occupiedCount),
    ]);
    for (const phase of [mp, op]) {
      expect(phase.game!.board.map(r => r.map(c => ({ cardId: c.cardId, owner: c.owner }))),
        `game ${gameNum} board after move ${m}`).toEqual(mirror.board);
    }
  }

  // ── Terminal outcome (board full after 9 moves → decisive winner OR draw) ──
  // BRANCH on the REAL result the rules mirror derived; each branch FULLY
  // asserts its own outcome (no relaxed/forced-winner asserts).
  const outcome = mirror.state.winner; // 'player1' | 'player2' | 'draw'
  if (outcome === null) {
    throw where('rules', `game ${gameNum} did not finish after 9 moves (mirror winner=null) — ` +
      `hands ${JSON.stringify({ p1Hand, p2Hand })}`);
  }
  // Both browsers must report game over with the SAME outcome the mirror derived.
  const [firstOver, secondOver] = await Promise.all([first.waitGameOver(), second.waitGameOver()]);
  for (const [d, ph] of [[first, firstOver], [second, secondOver]] as const) {
    expect(ph.ws.gameOver!.winner, `game ${gameNum}: ${d.name} browser outcome`).toBe(outcome);
  }

  // A fresh game must mint a NEW on-chain id — decisive OR draw (Gap 6, matrix):
  // game_id + randomness are derived IN-CIRCUIT, so a repeat == per-session state
  // reuse. Assert uniqueness BEFORE trusting any on-chain status below.
  const onChainGameId = (await first.phase()).chain.onChainGameId
    ?? (await second.phase()).chain.onChainGameId;
  if (!onChainGameId) throw where('chain', 'no on-chain game id known to either client');
  if (seen.onChainGameIds.has(onChainGameId)) throw where('chain',
    `on-chain game_id ${onChainGameId} reused from an earlier game — in-circuit ` +
    `game_id/randomness derivation is not fresh per game (contract / lane-1)`);
  seen.onChainGameIds.add(onChainGameId);

  // ════════════════════════════ DRAW outcome ════════════════════════════
  // KNOWN PRODUCT BUG (flagged to Zac as a separate follow-up — do NOT fix it
  // here): a draw is never settled. On a draw GameHUD shows BOTH players only
  // "Back to Lobby" (no card picker), and nothing auto-settles, so the 5-card
  // hand each player committed (nullified) at create_game/join_game is NEVER
  // returned — a draw STRANDS both wagered hands on-chain and pays no reward.
  // The draw-settle path (useGameSettlement.handleSettle with selectedCardId=0
  // → process_game returns both hands, no transfer) EXISTS but is unwired in the
  // UI. We FULLY assert that real outcome below (no relaxed asserts); if the
  // draw-settle ever gets wired the card/token/status asserts flip and this
  // fails loud — exactly the regression signal we want.
  if (outcome === 'draw') {
    // Genuine draw, agreed by both browsers: board full, scores tied, no winner.
    for (const [d, ph] of [[first, firstOver], [second, secondOver]] as const) {
      const occupied = ph.game!.board.flat().filter(c => c.cardId !== null).length;
      expect(occupied, `game ${gameNum} draw: ${d.name} board full`).toBe(9);
      expect(ph.game!.myScore, `game ${gameNum} draw: ${d.name} scores tied`).toBe(ph.game!.opponentScore);
      expect(ph.ws.gameOver!.winner, `game ${gameNum} draw: ${d.name} winner=draw`).toBe('draw');
    }
    // No settlement happened or is pending on either side (a draw never settles).
    for (const d of [first, second]) {
      const c = (await d.phase()).chain;
      expect(c.settleTxStatus, `game ${gameNum} draw: ${d.name} never settled`).toBe('idle');
      expect(c.opponentSettled, `game ${gameNum} draw: ${d.name} no opponent settle`).toBe(false);
      expect(c.takenCardId, `game ${gameNum} draw: ${d.name} no card taken`).toBeNull();
    }
    // Public chain: created+joined but NOT settled — only create/join touch the
    // chain, process_game never ran, so a draw leaves the game 'active'.
    expect(await chain.gameStatus(onChainGameId), `game ${gameNum} draw: on-chain not settled (active)`)
      .toBe(GAME_STATUS.active);
    // Card economy (the bug): each committed 5-card hand is stranded, never
    // returned → private cards drop by exactly HAND; no settlement → no reward.
    await alice.expectEventually(`game ${gameNum} draw: alice hand stranded (−${HAND})`,
      async () => (await alice.privateCards()).length, aliceBeforeCards.length - HAND);
    await bob.expectEventually(`game ${gameNum} draw: bob hand stranded (−${HAND})`,
      async () => (await bob.privateCards()).length, bobBeforeCards.length - HAND);
    expect(await alice.tokenBalance(), `game ${gameNum} draw: alice no reward`).toBe(aliceBeforeTokens);
    expect(await bob.tokenBalance(), `game ${gameNum} draw: bob no reward`).toBe(bobBeforeTokens);
    // Backend room finished (GAME_OVER released both players for the next game).
    const drawRes = await fetch(`${BACKEND_URL}/games/${wsGameId}`);
    if (drawRes.ok) {
      const room = await drawRes.json() as { status: string };
      expect(room.status, `game ${gameNum} draw: backend room finished`).toBe('finished');
    }
    // Frontend: both back to a clean menu — the NEXT game's no-carryover checks
    // verify the reset (board empty, canSettle false, settle idle) held.
    await Promise.all([first.returnToMenu(), second.returnToMenu()]);
    expect((await alice.phase()).screen, `game ${gameNum} draw: alice on menu`).toBe('main-menu');
    expect((await bob.phase()).screen, `game ${gameNum} draw: bob on menu`).toBe('main-menu');

    rows.push({
      game: gameNum, outcome: 'draw', winner: 'draw',
      aliceCards: `${aliceBeforeCards.length}→${(await alice.privateCards()).length}`,
      bobCards: `${bobBeforeCards.length}→${(await bob.privateCards()).length}`,
      aliceTokens: `${aliceBeforeTokens}→${await alice.tokenBalance()}`,
      bobTokens: `${bobBeforeTokens}→${await bob.tokenBalance()}`,
      claimed: null, settleOk: null,
    });
    return; // draw fully asserted — continue to the next game
  }

  // ══════════════════════════ DECISIVE outcome ══════════════════════════
  const winner: Player = outcome;
  const winnerD = driverFor(winner);
  const loserD = winnerD === alice ? bob : alice;
  const loserPlayer: Player = winner === 'player1' ? 'player2' : 'player1';

  // Claim the loser's highest-id board card.
  const loserBoardIds = mirror.state.board.flat()
    .filter(c => c.card && c.originalOwner === loserPlayer).map(c => c.card!.id).sort((a, b) => a - b);
  const claimed = loserBoardIds[loserBoardIds.length - 1];

  await winnerD.waitCanSettle();
  // Mid-game nullification: the 5 committed hand cards are spent → count − 5.
  const winnerPre = winnerD === alice ? aliceBeforeCards : bobBeforeCards;
  const loserPre = loserD === alice ? aliceBeforeCards : bobBeforeCards;
  expect((await winnerD.privateCards()).length, `${winnerD.name} hand committed`).toBe(winnerPre.length - HAND);
  expect((await loserD.privateCards()).length, `${loserD.name} hand committed`).toBe(loserPre.length - HAND);

  let settleOk = false;
  try {
    await winnerD.pickSettleCard(claimed);
    await winnerD.waitSettleConfirmed();
    const ls = await loserD.waitOpponentSettled();
    expect(ls.chain.takenCardId, `loser sees taken card`).toBe(claimed);
    settleOk = true;
  } catch (err) {
    rows.push(buildRow(gameNum, winnerD.name, aliceBeforeCards, bobBeforeCards, null, null,
      aliceBeforeTokens, bobBeforeTokens, null, null, claimed, false));
    throw where('chain/settlement', `process_game settlement failed: ${(err as Error).message}\n` +
      `suspect proof-chain reuse / session state across games (lane-2 useGameSettlement)`);
  }

  // ── Layer 1 (chain, private): card counts + the specific claimed id ────
  const winnerExpect = countMap(winnerPre); winnerExpect.set(claimed, (winnerExpect.get(claimed) ?? 0) + 1);
  const loserExpect = countMap(loserPre);
  const loserClaimedBefore = loserExpect.get(claimed) ?? 0;
  if (loserClaimedBefore < 1) throw where('rules', `loser never owned claimed #${claimed}`);
  // countMap never stores a zero count, so when the loser held its LAST copy of
  // the claimed card, drop the entry rather than set it to 0 — a [claimed,0]
  // entry can never equal the actual multiset (which simply omits the card),
  // and expectEventually would spin out 180s on a game the product settled
  // correctly (a false negative; surfaces only when the random pack draw left
  // the loser a single copy of the claimed id).
  if (loserClaimedBefore - 1 > 0) loserExpect.set(claimed, loserClaimedBefore - 1);
  else loserExpect.delete(claimed);

  await winnerD.expectEventually(`${winnerD.name} (winner) card count +1`,
    async () => (await winnerD.privateCards()).length, winnerPre.length + 1);
  await loserD.expectEventually(`${loserD.name} (loser) card count -1`,
    async () => (await loserD.privateCards()).length, loserPre.length - 1);
  // Exact multiset (the specific wagered id moved owner).
  await winnerD.expectEventually(`${winnerD.name} multiset gained #${claimed}`,
    async () => [...countMap(await winnerD.privateCards())].sort(), [...winnerExpect].sort());
  await loserD.expectEventually(`${loserD.name} multiset lost #${claimed}`,
    async () => [...countMap(await loserD.privateCards())].sort(), [...loserExpect].sort());

  // ── Layer 2 (token economy): both +20 this game ───────────────────────
  await winnerD.expectEventually(`${winnerD.name} tokens +20`,
    () => winnerD.tokenBalance(), (winnerD === alice ? aliceBeforeTokens : bobBeforeTokens) + GAME_REWARD);
  await loserD.expectEventually(`${loserD.name} tokens +20`,
    () => loserD.tokenBalance(), (loserD === alice ? aliceBeforeTokens : bobBeforeTokens) + GAME_REWARD);

  // ── Public chain: settled + on-chain players == the two accounts ───────
  expect(await chain.gameStatus(onChainGameId), `game ${gameNum} settled on-chain`).toBe(GAME_STATUS.settled);
  const players = await chain.gamePlayers(onChainGameId);
  const onChain = [players.player1.toLowerCase(), players.player2.toLowerCase()].sort();
  const browsers = [
    (await alice.phase()).accountAddress!.toLowerCase(),
    (await bob.phase()).accountAddress!.toLowerCase(),
  ].sort();
  expect(onChain, `game ${gameNum} on-chain players`).toEqual(browsers);

  // ── Backend: room finished/released; both can start the next game ──────
  const res = await fetch(`${BACKEND_URL}/games/${wsGameId}`);
  if (res.ok) {
    const room = await res.json() as { status: string; winner: string };
    expect(room.status, `game ${gameNum} backend room finished`).toBe('finished');
  }

  // ── Frontend: both return to a clean menu showing post-game counts ─────
  await Promise.all([winnerD.returnToMenu(), loserD.returnToMenu()]);
  const aliceAfter = (await alice.phase()).ownedCardIds.length;
  const bobAfter = (await bob.phase()).ownedCardIds.length;
  expect((await alice.phase()).screen, 'alice on menu').toBe('main-menu');
  expect((await bob.phase()).screen, 'bob on menu').toBe('main-menu');

  const aliceAfterCards = await alice.privateCards();
  const bobAfterCards = await bob.privateCards();
  const aliceAfterTokens = await alice.tokenBalance();
  const bobAfterTokens = await bob.tokenBalance();
  rows.push(buildRow(gameNum, winnerD.name, aliceBeforeCards, bobBeforeCards,
    aliceAfterCards, bobAfterCards, aliceBeforeTokens, bobBeforeTokens,
    aliceAfterTokens, bobAfterTokens, claimed, true));
  void aliceAfter; void bobAfter;
}

function buildRow(
  game: number, winner: string,
  aBefore: number[], bBefore: number[], aAfter: number[] | null, bAfter: number[] | null,
  atBefore: number, btBefore: number, atAfter: number | null, btAfter: number | null,
  claimed: number, settleOk: boolean,
): GameRow {
  return {
    game, outcome: 'decisive', winner, claimed, settleOk,
    aliceCards: `${aBefore.length}→${aAfter?.length ?? '?'}`,
    bobCards: `${bBefore.length}→${bAfter?.length ?? '?'}`,
    aliceTokens: `${atBefore}→${atAfter ?? '?'}`,
    bobTokens: `${btBefore}→${btAfter ?? '?'}`,
  };
}
