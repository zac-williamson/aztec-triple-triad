/**
 * Loser +20 token reward import. The winner's process_game mints the loser's
 * reward via mint_reward (create_and_push), which the loser's passive PXE scan
 * never discovers. On receiving the settlement NOTE_DATA, the loser must
 * explicitly import the reward note — deriving its randomness from the loser's
 * OWN per-game randomness — alongside the relayed card notes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const hoisted = vi.hoisted(() => ({
  importCardNotesMock: vi.fn().mockResolvedValue([1, 2, 3, 4, 5]),
  fetchTxEffectDataMock: vi.fn().mockResolvedValue({ noteHashes: ['0xA1'], firstNullifier: '0xN1' }),
  importTokenRewardNoteMock: vi.fn().mockResolvedValue(true),
  addCardsMock: vi.fn(),
  refreshTokenBalanceMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../aztec/AztecContext', () => ({
  useAztecContext: () => ({
    wallet: { fake: 'wallet' },
    accountAddress: '0xLOSER',
    nodeClient: { fake: 'node' },
    isAvailable: true,
    ownedCardIds: [],
    updateOwnedCards: vi.fn(),
    refreshTokenBalance: hoisted.refreshTokenBalanceMock,
    status: 'connected', isConnecting: false, hasConnected: true, error: null,
    connect: vi.fn(), confirmFunded: vi.fn(), disconnect: vi.fn(), refreshOwnedCards: vi.fn(),
    tokenBalance: 100,
  }),
}));

// The loser-side note imports run through the PXE door (enqueued via `pxe.*`,
// not a raw contract). fetchTxEffectData is the only remaining noteImporter
// export (a node read, not a PXE op).
vi.mock('../../aztec/pxe', () => ({
  pxe: {
    importCardNotes: hoisted.importCardNotesMock,
    importTokenRewardNote: hoisted.importTokenRewardNoteMock,
  },
  runPxeTx: vi.fn(),
}));
vi.mock('../../aztec/noteImporter', () => ({ fetchTxEffectData: hoisted.fetchTxEffectDataMock }));
vi.mock('../../aztec/cardStore', () => ({ addCards: hoisted.addCardsMock }));
vi.mock('../../aztec/gameConstants', () => ({
  AZTEC_TX_TIMEOUT: 60000, AZTEC_SETTLE_TX_TIMEOUT: 600, CARDS_PER_HAND: 5, TOTAL_MOVES: 9,
  MOVE_PROOF_WAIT_TIMEOUT: 5000, HAND_PROOF_WAIT_TIMEOUT: 5000, GAME_TOKEN_REWARD: 20,
}));

import { useGameSettlement } from '../useGameSettlement';
import type { UseWebSocketReturn } from '../useWebSocket';

const LOSER_RANDOMNESS = ['0x1', '0x2', '0x3', '0x4', '0x5', '0x6'];

const session = {
  getBlindingFactor: () => '0xb1', getPhase: () => 'awaiting_settlement' as const,
  transitionPhase: vi.fn(),
  waitForActivePhase: vi.fn().mockResolvedValue(undefined),
  getSettlementInfo: () => ({
    onChainGameId: '0xG', gameRandomness: LOSER_RANDOMNESS,
    opponentAddress: '0xWINNER', opponentRandomness: ['0x7', '0x8', '0x9', '0xa', '0xb', '0xc'],
    callerCardIds: [1, 2, 3, 4, 5], opponentCardIds: [6, 7, 8, 9, 10],
  }),
  backfillSettlementInfoFromWs: vi.fn(),
  clearSettlementInfo: vi.fn(),
};

const play = {
  getMyHandProof: () => null, getOpponentHandProof: () => null, getMoveProofs: () => [],
  waitForHandProofs: vi.fn().mockResolvedValue(undefined),
  waitForMoveProofs: vi.fn().mockResolvedValue(undefined),
};

function makeWs(incomingNoteData: unknown): UseWebSocketReturn {
  return {
    gameId: 'game-1', playerNumber: 2,
    opponentSettling: null, opponentDisconnected: false,
    incomingNoteData,
    addMessageListener: vi.fn(() => () => {}),
    relayNoteData: vi.fn(), notifySettleStarted: vi.fn(), notifyAbandonedGameSettled: vi.fn(),
  } as unknown as UseWebSocketReturn;
}

describe('loser token reward import', () => {
  beforeEach(() => vi.clearAllMocks());

  it('imports the +20 reward note using the loser\'s own per-game randomness after settlement', async () => {
    const incoming = {
      txHash: '0xSETTLE',
      notes: [
        { tokenId: 1, randomness: '0xr1' }, { tokenId: 2, randomness: '0xr2' },
        { tokenId: 3, randomness: '0xr3' }, { tokenId: 4, randomness: '0xr4' },
      ],
    };

    const { rerender } = renderHook(
      ({ inc }) => useGameSettlement({ ws: makeWs(inc), cardIds: [1, 2, 3, 4, 5], session, play }),
      { initialProps: { inc: null as unknown } },
    );

    await act(async () => {
      rerender({ inc: incoming });
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
    });

    // Cards still imported (relayed NFT notes) via the PXE door ...
    expect(hoisted.importCardNotesMock).toHaveBeenCalled();
    // ... and the +20 token reward imported with the loser's OWN randomness.
    // New op signature: (account, txHash, amount, playerRandomness, txEffect).
    expect(hoisted.importTokenRewardNoteMock).toHaveBeenCalledTimes(1);
    const [account, txHash, amount, randomness, txEffect] =
      hoisted.importTokenRewardNoteMock.mock.calls[0];
    expect(account).toBe('0xLOSER');
    expect(txHash).toBe('0xSETTLE');
    expect(amount).toBe(20);
    expect(randomness).toEqual(LOSER_RANDOMNESS);
    expect(txEffect).toEqual({ noteHashes: ['0xA1'], firstNullifier: '0xN1' });

    expect(hoisted.refreshTokenBalanceMock).toHaveBeenCalled();
  });

  it('skips the token import (no crash) when per-game randomness is unavailable', async () => {
    const noRandomnessSession = { ...session, getSettlementInfo: () => null };

    const { rerender } = renderHook(
      ({ inc }) => useGameSettlement({ ws: makeWs(inc), cardIds: [1, 2, 3, 4, 5], session: noRandomnessSession, play }),
      { initialProps: { inc: null as unknown } },
    );

    await act(async () => {
      rerender({ inc: { txHash: '0xS', notes: [{ tokenId: 1, randomness: '0xr1' }] } });
      await new Promise(r => setTimeout(r, 0));
    });

    expect(hoisted.importCardNotesMock).toHaveBeenCalled();
    expect(hoisted.importTokenRewardNoteMock).not.toHaveBeenCalled();
  });
});
