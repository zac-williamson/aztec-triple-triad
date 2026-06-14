/**
 * Regression: settlement and loser-note-import flows must persist the newly
 * minted card notes to localStorage (via addCards) in addition to importing
 * them into PXE (via importNotesFromTx). Otherwise a fresh wallet loses the
 * cards on the next page refresh — PXE starts empty and localStorage has
 * no tx-effect aux data to drive re-import.
 *
 * The fix also adds a refreshTokenBalance poll on the loser side after
 * incomingNoteData because settlement mints 20 ARNA to both players and
 * the loser's PXE tag-scan may lag behind chain head.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const hoisted = vi.hoisted(() => ({
  mockWs: {} as Record<string, any>,
  wsMessageListeners: new Set<(msg: any) => void>(),
  refreshTokenBalanceMock: vi.fn().mockResolvedValue(undefined),
  importCardNotesMock: vi.fn().mockResolvedValue([101, 102]),
  importTokenRewardNoteMock: vi.fn().mockResolvedValue(true),
  fetchTxEffectDataMock: vi.fn().mockResolvedValue({
    noteHashes: ['0xA1', '0xA2'],
    firstNullifier: '0xN1',
  }),
  addCardsMock: vi.fn(),
  removeCardsMock: vi.fn(),
}));
const {
  mockWs, refreshTokenBalanceMock, importCardNotesMock,
  fetchTxEffectDataMock, addCardsMock, removeCardsMock,
} = hoisted;
let wsMessageListeners = hoisted.wsMessageListeners;

vi.mock('../useWebSocket', () => ({
  useWebSocket: () => hoisted.mockWs,
}));

vi.mock('../../aztec/AztecContext', () => ({
  useAztecContext: () => ({
    wallet: { fake: 'wallet' },
    accountAddress: '0xACCOUNT',
    nodeClient: { fake: 'node' },
    isAvailable: true,
    ownedCardIds: [],
    updateOwnedCards: vi.fn(),
    refreshTokenBalance: hoisted.refreshTokenBalanceMock,
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

vi.mock('../useProofGeneration', () => ({
  useProofGeneration: () => ({
    generateHandProof: vi.fn(),
    generateMoveProof: vi.fn(),
    reset: vi.fn(),
  }),
}));

vi.mock('../useGameStorage', () => ({
  useGameStorage: () => ({
    saveGame: vi.fn(),
    loadGame: vi.fn().mockReturnValue(null),
    clearGame: vi.fn(),
    hasGame: vi.fn().mockReturnValue(false),
  }),
}));

vi.mock('../../aztec/config', () => ({
  AZTEC_CONFIG: {
    enabled: true,
    gameContractAddress: '0xGAME',
    nftContractAddress: '0xNFT',
    pxeUrl: '',
    storageKeys: { accountAddress: 'test_addr' },
  },
}));

// Note imports go through the PXE door (`pxe.importCardNotes` /
// `pxe.importTokenRewardNote`). fetchTxEffectData (a node read) stays in
// noteImporter. warmupPxe/runPxeTx are inert here (no game pipeline starts).
vi.mock('../../aztec/pxe', () => ({
  pxe: {
    importCardNotes: hoisted.importCardNotesMock,
    importTokenRewardNote: hoisted.importTokenRewardNoteMock,
  },
  runPxeTx: vi.fn(),
  warmupPxe: vi.fn(),
}));

vi.mock('../../aztec/noteImporter', () => ({
  fetchTxEffectData: hoisted.fetchTxEffectDataMock,
}));

vi.mock('../../aztec/cardStore', () => ({
  addCards: hoisted.addCardsMock,
  removeCards: hoisted.removeCardsMock,
}));

vi.mock('../../aztec/txManager', () => ({
  default: { runTx: vi.fn(), currentTx: null, cancel: vi.fn() },
}));

vi.mock('../../aztec/gameConstants', () => ({
  AZTEC_TX_TIMEOUT: 60000,
  AZTEC_SETTLE_TX_TIMEOUT: 120000,
  CARDS_PER_HAND: 5,
  TOTAL_MOVES: 9,
  MOVE_PROOF_WAIT_TIMEOUT: 60000,
  HAND_PROOF_WAIT_TIMEOUT: 60000,
}));

import { useGame } from '../useGame';

function resetWs() {
  wsMessageListeners = new Set();
  Object.assign(mockWs, {
    connected: true,
    gameId: null,
    playerNumber: null,
    gameState: null,
    lastCaptures: [],
    gameList: [],
    error: null,
    gameOver: null,
    opponentDisconnected: false,
    opponentHandProof: null,
    lastMoveProof: null,
    opponentAztecAddress: null,
    opponentOnChainGameId: null,
    opponentCardIds: [],
    incomingNoteData: null,
    relayNoteData: vi.fn(),
    opponentSettling: null,
    notifySettleStarted: vi.fn(),
    opponentTxConfirmed: false,
    notifyTxConfirmed: vi.fn(),
    matchmakingStatus: 'idle',
    queuePosition: null,
    createGame: vi.fn(),
    joinGame: vi.fn(),
    placeCard: vi.fn(),
    submitHandProof: vi.fn(),
    submitMoveProof: vi.fn(),
    shareAztecInfo: vi.fn(),
    opponentGameRandomness: null,
    refreshGameList: vi.fn(),
    leaveGame: vi.fn(),
    disconnect: vi.fn(),
    queueMatchmaking: vi.fn(),
    cancelMatchmaking: vi.fn(),
    ping: vi.fn(),
    addMessageListener: vi.fn((cb: (msg: any) => void) => {
      wsMessageListeners.add(cb);
      return () => wsMessageListeners.delete(cb);
    }),
  });
}

describe('loser import persists new cards to localStorage', () => {
  beforeEach(() => {
    resetWs();
    addCardsMock.mockClear();
    removeCardsMock.mockClear();
    importCardNotesMock.mockClear();
    fetchTxEffectDataMock.mockClear();
    refreshTokenBalanceMock.mockClear();
  });

  it('ws.incomingNoteData fires addCards with tx-effect aux data', async () => {
    const { rerender } = renderHook(({ data }) => {
      mockWs.incomingNoteData = data;
      return useGame('ws://test');
    }, { initialProps: { data: null as any } });

    const incomingNoteData = {
      txHash: '0xDEADBEEF',
      notes: [
        { tokenId: 101, randomness: '0xRAND101' },
        { tokenId: 102, randomness: '0xRAND102' },
      ],
    };

    await act(async () => {
      rerender({ data: incomingNoteData });
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
    });

    // fetchTxEffectData must have been called with the tx hash
    expect(fetchTxEffectDataMock).toHaveBeenCalledWith(
      expect.anything(), '0xDEADBEEF',
    );

    // addCards must have been called with StoredCard shape for both notes
    expect(addCardsMock).toHaveBeenCalledTimes(1);
    expect(addCardsMock).toHaveBeenCalledWith('0xACCOUNT', [
      {
        cardId: 101,
        randomness: '0xRAND101',
        txHash: '0xDEADBEEF',
        noteHashes: ['0xA1', '0xA2'],
        firstNullifier: '0xN1',
      },
      {
        cardId: 102,
        randomness: '0xRAND102',
        txHash: '0xDEADBEEF',
        noteHashes: ['0xA1', '0xA2'],
        firstNullifier: '0xN1',
      },
    ]);

    // PXE import happens too, through the serial-queue door (pxe.importCardNotes)
    expect(importCardNotesMock).toHaveBeenCalled();

    // Loser-side token-balance refresh fires after settlement
    expect(refreshTokenBalanceMock).toHaveBeenCalled();
  });

  it('does not crash when TxEffect fetch returns null (skips import — no note hashes)', async () => {
    fetchTxEffectDataMock.mockResolvedValueOnce(null);

    const { rerender } = renderHook(({ data }) => {
      mockWs.incomingNoteData = data;
      return useGame('ws://test');
    }, { initialProps: { data: null as any } });

    await act(async () => {
      rerender({
        data: {
          txHash: '0xCAFE',
          notes: [{ tokenId: 5, randomness: '0xRAND5' }],
        },
      });
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
    });

    // No persist AND no PXE import if TxEffect unavailable — import_note needs
    // the note hashes from the tx effect, so without it there's nothing to import.
    expect(addCardsMock).not.toHaveBeenCalled();
    expect(importCardNotesMock).not.toHaveBeenCalled();
  });

  it('persistence error does not prevent PXE import', async () => {
    addCardsMock.mockImplementationOnce(() => {
      throw new Error('QuotaExceededError');
    });

    const { rerender } = renderHook(({ data }) => {
      mockWs.incomingNoteData = data;
      return useGame('ws://test');
    }, { initialProps: { data: null as any } });

    await act(async () => {
      rerender({
        data: {
          txHash: '0xFOO',
          notes: [{ tokenId: 7, randomness: '0xRAND7' }],
        },
      });
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
    });

    expect(addCardsMock).toHaveBeenCalled();
    expect(importCardNotesMock).toHaveBeenCalled();
  });
});
