/**
 * Present-but-idle claim wiring (docs/plan/ABANDONED_GAMES.md "Missing #2").
 *
 * The abandoned-claim flow previously auto-fired ONLY on ws.opponentDisconnected.
 * Phase-1 adds: the NON-idle player triggers the SAME flow for a PRESENT-but-idle
 * opponent. That requires useGameSettlement to EXPOSE handleAbandonedGame so the
 * "Claim abandoned game" button / testkit can call it — and calling it must drive
 * claim_abandoned_game → dispute wait → settle_abandoned_game even though the
 * opponent never disconnected (opponentDisconnected: false).
 *
 * These assertions fail against the pre-change hook (handleAbandonedGame is not
 * returned, so the button/testkit have nothing to call, and nothing fires while
 * the opponent stays connected).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const hoisted = vi.hoisted(() => ({
  importCardNotesMock: vi.fn().mockResolvedValue([1, 2]),
  fetchTxEffectDataMock: vi.fn().mockResolvedValue({ noteHashes: ['0xA'], firstNullifier: '0xN' }),
  addCardsMock: vi.fn(),
  sendClaimMock: vi.fn().mockResolvedValue('0xCLAIM_TX'),
  sendSettleMock: vi.fn().mockResolvedValue('0xSETTLE_TX'),
}));

vi.mock('../../aztec/AztecContext', () => {
  // Block-aware dispute wait polls node.getBlockNumber() until 5 blocks elapse
  // since the claim. Advance one block per poll so the window opens and
  // settle_abandoned_game fires (the real node advances by wall-clock; +1 per
  // poll is enough to exercise the loop deterministically under fake timers).
  let block = 1000;
  return ({
  useAztecContext: () => ({
    wallet: { fake: 'wallet' },
    accountAddress: '0xME',
    nodeClient: { fake: 'node', getBlockNumber: () => Promise.resolve(block++) },
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

vi.mock('../../aztec/noteImporter', () => ({ fetchTxEffectData: hoisted.fetchTxEffectDataMock }));
vi.mock('../../aztec/cardStore', () => ({ addCards: hoisted.addCardsMock }));

vi.mock('../../aztec/pxe', () => {
  const ops = {
    sendClaimAbandonedGame: hoisted.sendClaimMock,
    sendSettleAbandonedGame: hoisted.sendSettleMock,
    importCardNotes: hoisted.importCardNotesMock,
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

vi.mock('@aztec/aztec.js/fields', () => ({
  Fr: class { constructor(public v: unknown) {} toString() { return String(this.v); } },
}));
vi.mock('@aztec/aztec.js/addresses', () => ({
  AztecAddress: { fromStringUnsafe: (s: string) => s },
}));

vi.mock('../../aztec/circuitLoader', () => ({
  loadProveHandCircuit: vi.fn().mockResolvedValue({ bytecode: 'AA==' }),
  loadGameMoveCircuit: vi.fn().mockResolvedValue({ bytecode: 'AA==' }),
  loadDummyMoveCircuit: vi.fn().mockResolvedValue({ bytecode: 'AA==' }),
}));
vi.mock('../../aztec/proofBackend', () => ({ getBarretenberg: vi.fn().mockResolvedValue({}) }));
vi.mock('@aztec/bb.js', () => ({
  UltraHonkBackend: class {
    getVerificationKey() { return Promise.resolve(new Uint8Array([1])); }
    generateProof() { return Promise.resolve({ proof: new Uint8Array([2]) }); }
  },
}));
vi.mock('@noir-lang/noir_js', () => ({
  Noir: class { execute() { return Promise.resolve({ witness: new Uint8Array([3]) }); } },
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
vi.mock('../../aztec/feeSettings', () => ({
  gasSettingsWithHeadroom: vi.fn(async () => ({ maxFeesPerGas: 'HEADROOM_MAX' })),
}));

import { useGameSettlement } from '../useGameSettlement';
import type { UseWebSocketReturn } from '../useWebSocket';

const handProof = { proof: 'AA==', publicInputs: ['0x1'], cardCommit: '0xC1' };
const oppHandProof = { proof: 'AA==', publicInputs: ['0x2'], cardCommit: '0xC2' };
const moveProofs = [
  { proof: 'AA==', publicInputs: ['0x0'], cardCommit1: '0xC1', cardCommit2: '0xC2', startStateHash: '0xINIT', endStateHash: '0xS1', gameEnded: false, winnerId: 0 },
  { proof: 'AA==', publicInputs: ['0x0'], cardCommit1: '0xC1', cardCommit2: '0xC2', startStateHash: '0xS1', endStateHash: '0xS2', gameEnded: false, winnerId: 0 },
];

const settlementInfo = {
  onChainGameId: '0xCHAIN_GAME',
  gameRandomness: ['0xr0', '0xr1', '0xr2', '0xr3', '0xr4', '0xr5'],
  opponentAddress: '0xOPP',
  opponentRandomness: ['0xo0', '0xo1', '0xo2', '0xo3', '0xo4', '0xo5'],
  callerCardIds: [1, 2, 3, 4, 5],
  opponentCardIds: [7, 8, 9, 10, 11],
};

// Opponent is PRESENT — not disconnected. The disconnect auto-trigger must NOT
// fire here; only an explicit handleAbandonedGame() call drives the flow.
function makeWs(overrides: Record<string, unknown> = {}) {
  return {
    gameId: 'ws-game-1',
    playerNumber: 1,
    opponentDisconnected: false,
    abandonmentWarning: { idlePlayer: 'player2', secondsIdle: 60, secondsUntilClaimable: 0 },
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

describe('present-but-idle claim wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('exposes handleAbandonedGame as a callable action', () => {
    const ws = makeWs();
    const { result } = renderHook(() => useGameSettlement({ ws, cardIds: [1, 2, 3, 4, 5], session, play }));
    expect(typeof result.current.handleAbandonedGame).toBe('function');
  });

  it('does NOT auto-fire while the opponent is merely idle (present, not disconnected)', async () => {
    const ws = makeWs();
    renderHook(() => useGameSettlement({ ws, cardIds: [1, 2, 3, 4, 5], session, play }));
    // Let any mount effects run — no disconnect, so no auto-claim.
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(hoisted.sendClaimMock).not.toHaveBeenCalled();
  });

  it('calling handleAbandonedGame() drives claim → dispute wait → settle (opponent present)', async () => {
    const ws = makeWs();
    const { result } = renderHook(() => useGameSettlement({ ws, cardIds: [1, 2, 3, 4, 5], session, play }));

    // Equivalent to clicking "Claim abandoned game" / __triadTest.claimAbandonedGame().
    await act(async () => { result.current.handleAbandonedGame(); });
    // isClaimingAbandoned flips true synchronously at the start of the flow.
    expect(result.current.isClaimingAbandoned).toBe(true);

    // Drive the claim tx → block-based dispute window (poll until 5 blocks
    // elapse; the mock advances 1 block per ~3s poll) → settle tx → postEffects.
    await act(async () => { await vi.advanceTimersByTimeAsync(80_000); });

    expect(hoisted.sendClaimMock).toHaveBeenCalled();
    expect(hoisted.sendSettleMock).toHaveBeenCalled();
    // Claim happens before settle.
    expect(hoisted.sendClaimMock.mock.invocationCallOrder[0])
      .toBeLessThan(hoisted.sendSettleMock.mock.invocationCallOrder[0]);
    // Opponent played ≥1 card → claimed card is opponentCardIds[0] (7).
    expect(ws.notifySettleStarted).toHaveBeenCalledWith('ws-game-1', 7);
    // Settlement reported to the relay after the tx mined.
    expect(ws.notifyAbandonedGameSettled).toHaveBeenCalledWith('ws-game-1');
    // Flow finished — claiming flag cleared.
    expect(result.current.isClaimingAbandoned).toBe(false);
  });

  it('surfaces abandonedDisputeCountdown during the on-chain dispute window', async () => {
    const ws = makeWs();
    const { result } = renderHook(() => useGameSettlement({ ws, cardIds: [1, 2, 3, 4, 5], session, play }));

    await act(async () => { result.current.handleAbandonedGame(); });
    // Advance past the claim tx into the dispute window, but not past it.
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });

    // The countdown is now a block-based estimate (~5 blocks × observed s/block,
    // seeded at 5×40s), not the old fixed 65s — assert it's surfaced + positive
    // within a sane bound rather than pinning the old wall-clock value.
    expect(result.current.abandonedDisputeCountdown).not.toBeNull();
    expect(result.current.abandonedDisputeCountdown!).toBeGreaterThan(0);
    expect(result.current.abandonedDisputeCountdown!).toBeLessThanOrEqual(5 * 60);
  });

  it('is idempotent — a second call while claiming does not start a second claim', async () => {
    const ws = makeWs();
    const { result } = renderHook(() => useGameSettlement({ ws, cardIds: [1, 2, 3, 4, 5], session, play }));

    await act(async () => { result.current.handleAbandonedGame(); });
    await act(async () => { result.current.handleAbandonedGame(); }); // guarded no-op
    await act(async () => { await vi.advanceTimersByTimeAsync(80_000); });

    expect(hoisted.sendClaimMock).toHaveBeenCalledTimes(1);
  });
});
