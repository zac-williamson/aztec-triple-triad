/**
 * QA-F3 frontend half — abandoned-game settlement must notify the relay.
 *
 * Spec (docs/plan/LANE_4_BACKEND.md, "QA-F3"):
 * - SETTLE_STARTED { gameId, selectedCardId: claimedCardId } when the
 *   abandoned settle begins (parity with the normal flow — gives an offline
 *   opponent the buffered OPPONENT_SETTLING card info).
 * - ABANDONED_GAME_SETTLED { gameId } ONLY after settle_abandoned_game is
 *   mined, after importNotes — the server unbinds both players on receipt.
 *
 * Drives useGameSettlement directly with stub session/play deps and the
 * real txManager; the opponent-disconnected auto-trigger starts the flow.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const hoisted = vi.hoisted(() => ({
  importCardNotesMock: vi.fn().mockResolvedValue([1, 2]),
  fetchTxEffectDataMock: vi.fn().mockResolvedValue({ noteHashes: ['0xA'], firstNullifier: '0xN' }),
  addCardsMock: vi.fn(),
  // The claim/settle sends now go through named pxe ops (which return a txHash
  // string), not a raw contract.methods.*.send(...).
  sendClaimMock: vi.fn().mockResolvedValue('0xCLAIM_TX'),
  sendSettleMock: vi.fn().mockResolvedValue('0xSETTLE_TX'),
}));

vi.mock('../../aztec/AztecContext', () => ({
  useAztecContext: () => ({
    wallet: { fake: 'wallet' },
    accountAddress: '0xME',
    nodeClient: { fake: 'node' },
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
}));

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

// loadSdk() in useGameSettlement lazy-imports these directly (value types only;
// the contract instances stay inside pxe.ts).
vi.mock('@aztec/aztec.js/fields', () => ({
  Fr: class { constructor(public v: unknown) {} toString() { return String(this.v); } },
}));
vi.mock('@aztec/aztec.js/addresses', () => ({
  AztecAddress: { fromString: (s: string) => s },
}));

vi.mock('../../aztec/circuitLoader', () => ({
  loadProveHandCircuit: vi.fn().mockResolvedValue({ bytecode: 'AA==' }),
  loadGameMoveCircuit: vi.fn().mockResolvedValue({ bytecode: 'AA==' }),
  loadDummyMoveCircuit: vi.fn().mockResolvedValue({ bytecode: 'AA==' }),
}));

vi.mock('../../aztec/proofBackend', () => ({
  getBarretenberg: vi.fn().mockResolvedValue({}),
}));

vi.mock('@aztec/bb.js', () => ({
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
  getPhase: () => 'active' as const,
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

describe('abandoned settlement relay notifications (QA-F3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends SETTLE_STARTED with the claimed card when the settle begins, and ABANDONED_GAME_SETTLED after the tx is mined (after importNotes)', async () => {
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

    // ABANDONED_GAME_SETTLED: ws gameId, sent only after the tx mined + notes imported
    expect(ws.notifyAbandonedGameSettled).toHaveBeenCalledWith('ws-game-1');
    const settledOrder = (ws.notifyAbandonedGameSettled as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const importOrder = hoisted.importCardNotesMock.mock.invocationCallOrder[0];
    expect(settledOrder).toBeGreaterThan(settleSendOrder);
    expect(settledOrder).toBeGreaterThan(importOrder);
  });

  it('does not send ABANDONED_GAME_SETTLED when the claim tx fails', async () => {
    hoisted.sendClaimMock.mockRejectedValueOnce(new Error('claim reverted'));
    const ws = makeWs();
    renderHook(() => useGameSettlement({ ws, cardIds: [1, 2, 3, 4, 5], session, play }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(80_000);
    });

    expect(hoisted.sendSettleMock).not.toHaveBeenCalled();
    expect(ws.notifyAbandonedGameSettled).not.toHaveBeenCalled();
  });
});
