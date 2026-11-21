/**
 * QA-F3 frontend half — abandoned-game settlement must notify the relay.
 *
 * Spec (docs/plan/LANE_4_BACKEND.md, "QA-F3"):
 * - SETTLE_STARTED { gameId, selectedCardId: claimedCardId } when the
 *   abandoned settle begins (parity with the normal flow — gives an offline
 *   opponent the buffered OPPONENT_SETTLING card info).
 * - ABANDONED_GAME_SETTLED { gameId } ONLY after settle_abandoned_game is
 *   mined, after our cards are received — the server unbinds both players on
 *   receipt.
 *
 * Drives useGameSettlement directly with stub session/play deps and the
 * real txManager; the opponent-disconnected auto-trigger starts the flow.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const hoisted = vi.hoisted(() => ({
  importCardNotesMock: vi.fn().mockResolvedValue([1, 2]),
  receiveCardMessagesMock: vi.fn().mockResolvedValue(5),
  settleMessages: [{ m: 'card-1' }, { m: 'card-2' }],
  fetchTxEffectDataMock: vi.fn().mockResolvedValue({ noteHashes: ['0xA'], firstNullifier: '0xN' }),
  addCardsMock: vi.fn(),
  // The claim/settle sends now go through named pxe ops, not a raw
  // contract.methods.*.send(...). The claim returns its txHash; the settle,
  // which mints our cards back, also returns the notes' offchain messages.
  sendClaimMock: vi.fn().mockResolvedValue('0xCLAIM_TX'),
  sendSettleMock: vi.fn(),
  // The mocked chain clock. It lives here, not in a module-level closure, so
  // beforeEach can rewind it: shared across tests it drifts past the dispute
  // window, and a later test then finds the window already open — or worse,
  // lets a flow parked by an EARLIER test run to completion mid-assertion.
  chainClock: { t: 1_700_000, step: 900 },
  // Default: a game long past the abandonment bar, claimed at 1_700_000.
  readInfoMock: vi.fn(),
}));

vi.mock('../../aztec/AztecContext', () => {
  // The dispute wait polls CHAIN TIME — the contract measures its window in
  // seconds, not blocks. Advance the chain clock well past DISPUTE_SECONDS on
  // the first poll so this test gets through the window in one step.
  // (was: block-aware wait polling getBlockNumber until 5 blocks elapse
  // since the claim. Advance one block per call so the window opens and
  // settle_abandoned_game fires deterministically under fake timers.
  let block = 1000;
  return ({
  useAztecContext: () => ({
    wallet: { fake: 'wallet' },
    accountAddress: '0xME',
    nodeClient: {
      fake: 'node',
      getBlockNumber: () => Promise.resolve(block++),
      getBlock: () => {
        hoisted.chainClock.t += hoisted.chainClock.step;   // default: one poll clears the 600s window
        return Promise.resolve({ header: { globalVariables: { timestamp: hoisted.chainClock.t } } });
      },
    },
    isAvailable: true,
    ownedCardIds: [],
    updateOwnedCards: vi.fn(),
    refreshTokenBalance: vi.fn().mockResolvedValue(undefined),
    status: 'connected',
    isConnecting: false,
    hasConnected: true,
    error: null,
    connect: vi.fn(),
    confirmFunded: vi.fn(),
    disconnect: vi.fn(),
    refreshOwnedCards: vi.fn(),
    tokenBalance: 0,
  }),
  });
});

vi.mock('../../aztec/noteImporter', () => ({
  fetchTxEffectData: hoisted.fetchTxEffectDataMock,
}));

vi.mock('../../aztec/cardStore', () => ({
  addCards: hoisted.addCardsMock,
}));

// The claim/settle flow runs through the PXE door: runPxeTx executes the body
// (proof build) inline with the inline `ops`, whose send + import are spies.
vi.mock('../../aztec/pxe', () => {
  const ops = {
    sendClaimAbandonedGame: hoisted.sendClaimMock,
    sendSettleAbandonedGame: hoisted.sendSettleMock,
    readAbandonmentInfo: hoisted.readInfoMock,
    importCardNotes: hoisted.importCardNotesMock,
    receiveCardMessages: hoisted.receiveCardMessagesMock,
  };
  return {
    pxe: ops,
    runPxeTx: async (opts: any) => {
      const result = await opts.execute(ops, () => {});
      if (opts.postEffects) await opts.postEffects(result, ops);
      return result;
    },
  };
});

// loadSdk() in useGameSettlement lazy-imports these directly (value types only;
// the contract instances stay inside pxe.ts).
vi.mock('@aztec-labs/aztec.js/fields', () => ({
  Fr: class { constructor(public v: unknown) {} toString() { return String(this.v); } },
}));
vi.mock('@aztec-labs/aztec.js/addresses', () => ({
  AztecAddress: { fromStringUnsafe: (s: string) => s },
}));

vi.mock('../../aztec/circuitLoader', () => ({
  loadProveHandCircuit: vi.fn().mockResolvedValue({ bytecode: 'AA==' }),
  loadGameMoveCircuit: vi.fn().mockResolvedValue({ bytecode: 'AA==' }),
  loadDummyMoveCircuit: vi.fn().mockResolvedValue({ bytecode: 'AA==' }),
}));

vi.mock('../../aztec/proofBackend', () => ({
  getBarretenberg: vi.fn().mockResolvedValue({}),
}));

vi.mock('@aztec-foundation/bb.js', () => ({
  UltraHonkBackend: class {
    getVerificationKey() { return Promise.resolve(new Uint8Array([1])); }
    generateProof() { return Promise.resolve({ proof: new Uint8Array([2]) }); }
  },
}));

vi.mock('@noir-lang/noir_js', () => ({
  Noir: class {
    execute() { return Promise.resolve({ witness: new Uint8Array([3]) }); }
  },
}));

vi.mock('../../aztec/proofWorker', () => ({
  computeBoardStateHash: vi.fn().mockResolvedValue('0xINIT'),
}));

vi.mock('../../aztec/fieldUtils', () => ({
  toFr: (_Fr: unknown, v: unknown) => v,
  toHexString: (v: unknown) => String(v),
  bytesToFrArray: () => [],
  base64ToFrArray: () => [],
  hexToFr: (_Fr: unknown, h: unknown) => h,
}));

vi.mock('../../aztec/gameConstants', () => ({
  AZTEC_TX_TIMEOUT: 60000,
  AZTEC_SETTLE_TX_TIMEOUT: 600,
  CARDS_PER_HAND: 5,
  TOTAL_MOVES: 9,
  MOVE_PROOF_WAIT_TIMEOUT: 5000,
  HAND_PROOF_WAIT_TIMEOUT: 5000,
}));

// Fee headroom is unit-tested separately; stub so the claim/settle sends
// don't need a real node base-fee lookup.
vi.mock('../../aztec/feeSettings', () => ({
  gasSettingsWithHeadroom: vi.fn(async () => ({ maxFeesPerGas: 'HEADROOM_MAX' })),
}));

import { useGameSettlement } from '../useGameSettlement';
import type { UseWebSocketReturn } from '../useWebSocket';

const handProof = { proof: 'AA==', publicInputs: ['0x1'], cardCommit: '0xC1' };
const oppHandProof = { proof: 'AA==', publicInputs: ['0x2'], cardCommit: '0xC2' };
// Two valid move proofs chained from the canonical initial hash — numValid=2
// means the opponent played a card, so claimedCardId = opponentCardIds[0].
// THREE proofs, not two. These tests run as player 1, and the contract refuses
// a claimant who is next to move — after an even number of 0-indexed moves
// that is player 1. Two proofs is a count the chain would have rejected, so
// the fixture was asserting a claim that could never have succeeded; the claim
// path now trims to the largest workable prefix and a two-proof fixture would
// silently become one.
const moveProofs = [
  { proof: 'AA==', publicInputs: ['0x0'], cardCommit1: '0xC1', cardCommit2: '0xC2', startStateHash: '0xINIT', endStateHash: '0xS1', gameEnded: false, winnerId: 0 },
  { proof: 'AA==', publicInputs: ['0x0'], cardCommit1: '0xC1', cardCommit2: '0xC2', startStateHash: '0xS1', endStateHash: '0xS2', gameEnded: false, winnerId: 0 },
  { proof: 'AA==', publicInputs: ['0x0'], cardCommit1: '0xC1', cardCommit2: '0xC2', startStateHash: '0xS2', endStateHash: '0xS3', gameEnded: false, winnerId: 0 },
];

const settlementInfo = {
  onChainGameId: '0xCHAIN_GAME',
  gameRandomness: ['0xr0', '0xr1', '0xr2', '0xr3', '0xr4', '0xr5'],
  opponentAddress: '0xOPP',
  opponentRandomness: ['0xo0', '0xo1', '0xo2', '0xo3', '0xo4', '0xo5'],
  callerCardIds: [1, 2, 3, 4, 5],
  opponentCardIds: [7, 8, 9, 10, 11],
};

function makeWs(overrides: Record<string, unknown> = {}) {
  return {
    gameId: 'ws-game-1',
    playerNumber: 1,
    opponentDisconnected: true, // fires the abandoned auto-trigger on mount
    opponentSettling: null,
    incomingNoteData: null,
    opponentAztecAddress: '0xOPP',
    relayNoteData: vi.fn(),
    notifySettleStarted: vi.fn(),
    notifyAbandonedGameSettled: vi.fn(),
    addMessageListener: vi.fn(() => () => {}),
    ...overrides,
  } as unknown as UseWebSocketReturn;
}

const session = {
  getBlindingFactor: () => '0xb1', getPhase: () => 'active' as const,
  transitionPhase: vi.fn(),
  waitForActivePhase: vi.fn().mockResolvedValue(undefined),
  getSettlementInfo: () => settlementInfo,
  backfillSettlementInfoFromWs: () => settlementInfo,
  clearSettlementInfo: vi.fn(),
};

const play = {
  getMyHandProof: () => handProof,
  getOpponentHandProof: () => oppHandProof,
  getMoveProofs: () => [...moveProofs],
  waitForHandProofs: vi.fn().mockResolvedValue(undefined),
  waitForMoveProofs: vi.fn().mockResolvedValue(undefined),
};

const LONG_PAST_THE_BAR = { status: 5, activeAt: 1_000_000, claimAt: 1_700_000, claimPlayer: '0xME' };

describe('abandoned settlement relay notifications (QA-F3)', () => {
  beforeEach(() => {
    hoisted.chainClock.t = 1_700_000;   // rewind the chain clock for each test
    hoisted.chainClock.step = 900;
    vi.clearAllMocks();
    hoisted.readInfoMock.mockResolvedValue(LONG_PAST_THE_BAR);
    hoisted.sendSettleMock.mockResolvedValue({ txHash: '0xSETTLE_TX', offchainMessages: hoisted.settleMessages });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends SETTLE_STARTED with the claimed card when the settle begins, and ABANDONED_GAME_SETTLED after the tx is mined (after our cards are received)', async () => {
    const ws = makeWs();
    renderHook(() => useGameSettlement({ ws, cardIds: [1, 2, 3, 4, 5], session, play }));

    // Drive the whole flow: claim tx → 65s dispute window → settle tx → postEffects
    await act(async () => {
      await vi.advanceTimersByTimeAsync(80_000);
    });

    // Claim and settle both went out (through the named pxe send ops)
    expect(hoisted.sendClaimMock).toHaveBeenCalled();
    expect(hoisted.sendSettleMock).toHaveBeenCalled();

    // SETTLE_STARTED parity: ws gameId + first opponent card (opponent played ≥1 card)
    expect(ws.notifySettleStarted).toHaveBeenCalledWith('ws-game-1', 7);
    // ...sent when the settle BEGINS — before the settle tx send
    const settleStartedOrder = (ws.notifySettleStarted as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const settleSendOrder = hoisted.sendSettleMock.mock.invocationCallOrder[0];
    expect(settleStartedOrder).toBeLessThan(settleSendOrder);

    // Our cards come back through the settle tx's own messages, not import_note.
    expect(hoisted.receiveCardMessagesMock).toHaveBeenCalledWith('0xME', '0xSETTLE_TX', hoisted.settleMessages);
    expect(hoisted.importCardNotesMock).not.toHaveBeenCalled();

    // ABANDONED_GAME_SETTLED: ws gameId, sent only after the tx mined + cards received
    expect(ws.notifyAbandonedGameSettled).toHaveBeenCalledWith('ws-game-1');
    const settledOrder = (ws.notifyAbandonedGameSettled as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const receiveOrder = hoisted.receiveCardMessagesMock.mock.invocationCallOrder[0];
    expect(settledOrder).toBeGreaterThan(settleSendOrder);
    expect(settledOrder).toBeGreaterThan(receiveOrder);
  });

  it('still receives our cards when the node cannot serve the tx effect for the card store', async () => {
    // Storing for restore needs the tx effect; the receive does not. A node
    // error while storing must not cost the player the cards themselves.
    hoisted.fetchTxEffectDataMock.mockRejectedValueOnce(new Error('node unreachable'));
    const ws = makeWs();
    renderHook(() => useGameSettlement({ ws, cardIds: [1, 2, 3, 4, 5], session, play }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(80_000);
    });

    expect(hoisted.addCardsMock).not.toHaveBeenCalled();
    expect(hoisted.receiveCardMessagesMock).toHaveBeenCalledWith('0xME', '0xSETTLE_TX', hoisted.settleMessages);
    expect(ws.notifyAbandonedGameSettled).toHaveBeenCalledWith('ws-game-1');
  });

  it('stores exactly our five recovered cards — no claimed card, which the contract no longer mints', async () => {
    const ws = makeWs();
    renderHook(() => useGameSettlement({ ws, cardIds: [1, 2, 3, 4, 5], session, play }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(80_000);
    });

    // settle_abandoned_game recovers the caller's own stake and nothing else.
    // Listing the opponent card (7) here once stored a card that does not
    // exist and showed it in the collection until the next refresh.
    expect(hoisted.addCardsMock).toHaveBeenCalledTimes(1);
    const stored = hoisted.addCardsMock.mock.calls[0][1] as { cardId: number; randomness: string }[];
    expect(stored.map(c => c.cardId)).toEqual([1, 2, 3, 4, 5]);
    expect(stored.map(c => c.randomness)).toEqual(['0xr0', '0xr1', '0xr2', '0xr3', '0xr4']);
  });

  it('does not send ABANDONED_GAME_SETTLED when the claim tx fails', async () => {
    // mockRejectedValue, not ...Once: the auto-fire path attempts the claim
    // more than once, so rejecting only the first left a SUCCEEDING claim
    // running behind it — and the test then asserted nothing about the failure
    // case it is named for.
    hoisted.sendClaimMock.mockRejectedValue(new Error('claim reverted'));
    const ws = makeWs();
    renderHook(() => useGameSettlement({ ws, cardIds: [1, 2, 3, 4, 5], session, play }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(80_000);
    });

    expect(hoisted.sendSettleMock).not.toHaveBeenCalled();
    expect(ws.notifyAbandonedGameSettled).not.toHaveBeenCalled();
  });
});

/**
 * A claim that reverts must not be retried forever.
 *
 * The auto-trigger used to gate on the flow's IN-FLIGHT guard, which the
 * finally block clears on failure as well as success — and the effect re-runs
 * whenever handleAbandonedGame's identity changes, which any state update
 * does. So every failure re-armed the trigger. Against a claim that reverts
 * for a persistent reason — "Too soon to call this game abandoned", "Game must
 * be in active state" — that is an unbounded loop, and each turn of it builds
 * a recursive proof and sends a transaction.
 */
describe('a reverting claim is attempted once, not forever', () => {
  beforeEach(() => {
    hoisted.chainClock.t = 1_700_000;
    hoisted.chainClock.step = 900;
    vi.clearAllMocks();
    hoisted.readInfoMock.mockResolvedValue(LONG_PAST_THE_BAR);
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('stops after the automatic attempt fails', async () => {
    hoisted.sendClaimMock.mockRejectedValue(new Error('Too soon to call this game abandoned'));
    const ws = makeWs();
    renderHook(() => useGameSettlement({ ws, cardIds: [1, 2, 3, 4, 5], session, play }));

    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });

    expect(hoisted.sendClaimMock.mock.calls.length,
      'one automatic attempt; the player can retry deliberately').toBe(1);
    expect(hoisted.sendSettleMock).not.toHaveBeenCalled();
    expect(ws.notifyAbandonedGameSettled).not.toHaveBeenCalled();
  });
});

/**
 * The contract refuses a claim until the game has been active
 * MIN_ABANDON_SECONDS (eight minutes) of CHAIN time, and the relay offers the
 * claim after a minute of idling — in a young game, well before that. The flow
 * must wait the bar out rather than prove a claim that reverts "Too soon", and
 * must stand down if the opponent comes back while it waits.
 */
describe('the claim waits for the abandonment bar', () => {
  const ACTIVE_AT = 1_700_000;   // the game went active "now" on the chain clock

  beforeEach(() => {
    hoisted.chainClock.t = ACTIVE_AT;
    hoisted.chainClock.step = 100;     // 100s of chain time per 5s poll
    vi.clearAllMocks();
    hoisted.sendSettleMock.mockResolvedValue({ txHash: '0xSETTLE_TX', offchainMessages: hoisted.settleMessages });
    hoisted.sendClaimMock.mockImplementation(async () => '0xCLAIM_TX');
    hoisted.readInfoMock.mockImplementation(async () => (hoisted.sendClaimMock.mock.calls.length === 0
      // Before the claim: an active game, young.
      ? { status: 2, activeAt: ACTIVE_AT, claimAt: 0, claimPlayer: '0x0' }
      // After it: claimed once the bar had passed.
      : { status: 5, activeAt: ACTIVE_AT, claimAt: ACTIVE_AT + 500, claimPlayer: '0xME' }));
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('does not prove the claim until the game is eight minutes old, and counts down meanwhile', async () => {
    const ws = makeWs();
    const { result } = renderHook(() => useGameSettlement({ ws, cardIds: [1, 2, 3, 4, 5], session, play }));

    // First poll: 100s of the 480s gone. No claim yet; the countdown shows the rest.
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(hoisted.sendClaimMock).not.toHaveBeenCalled();
    expect(result.current.abandonBarCountdown).toBe(380);
    expect(result.current.isClaimingAbandoned).toBe(true);
    // The game stays 'active' while it waits — the opponent may yet return.
    expect(session.transitionPhase).not.toHaveBeenCalledWith('settling');

    // Five polls in, 500s of chain time: past the bar, so the claim goes out.
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(hoisted.sendClaimMock).toHaveBeenCalledTimes(1);
    expect(session.transitionPhase).toHaveBeenCalledWith('settling');
    expect(hoisted.sendSettleMock).toHaveBeenCalledTimes(1);
    expect(result.current.abandonBarCountdown).toBeNull();
  });

  it('stands down if the opponent moves while it waits', async () => {
    let proofs = [...moveProofs];
    const livePlay = { ...play, getMoveProofs: () => proofs };
    const ws = makeWs();
    const { result } = renderHook(() => useGameSettlement({ ws, cardIds: [1, 2, 3, 4, 5], session, play: livePlay }));

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(result.current.abandonBarCountdown).toBe(380);

    // They are back: a new move proof arrives mid-wait.
    proofs = [...proofs, { ...moveProofs[0], startStateHash: '0xS3', endStateHash: '0xS4' }];
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });

    // A stale prefix of the transcript would still be accepted by the
    // contract — against a player who is here. So nothing is claimed, and
    // the live game keeps its phase.
    expect(hoisted.sendClaimMock).not.toHaveBeenCalled();
    expect(session.transitionPhase).not.toHaveBeenCalledWith('settling');
    expect(session.transitionPhase).not.toHaveBeenCalledWith('idle');
    expect(result.current.isClaimingAbandoned).toBe(false);
    expect(result.current.abandonBarCountdown).toBeNull();
  });
});
