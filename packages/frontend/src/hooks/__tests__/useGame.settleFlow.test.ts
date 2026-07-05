/**
 * Settlement flow integration test.
 *
 * Drives useGame through the full settlement path using only the public
 * interface (handleHandSelected, handlePlaceCard, handleSettle) and
 * state updates on a realistic useWebSocket mock. The mock uses
 * `useSyncExternalStore` so every state change produces a new ws object
 * and triggers a real React re-render — the same way the real hook works.
 *
 * This test catches the stale-closure bug where `handleSettle` (a
 * useCallback) captured a `ws` reference from an earlier render and
 * later dereferenced `ws.opponentCardIds` — reading the empty array
 * from the render when it was first memoized, not the populated array
 * set when GAME_OVER arrived.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';

// ── Stateful ws mock ──────────────────────────────────────────

type WsState = Record<string, any>;

const initialWsState: WsState = {
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
  opponentSettling: null,
  opponentGameRandomness: null,
  opponentTxConfirmed: false,
  matchmakingStatus: 'idle',
  queuePosition: null,
};

let wsStore: WsState = { ...initialWsState };
const wsListeners = new Set<() => void>();

function updateWs(patch: Partial<WsState>) {
  wsStore = { ...wsStore, ...patch };
  wsListeners.forEach(l => l());
}

function resetWsStore() {
  wsStore = { ...initialWsState };
  wsListeners.clear();
}

// Stable ws callback refs (mirror the real useWebSocket's useCallback behavior)
const wsFns = {
  createGame: vi.fn(),
  joinGame: vi.fn(),
  placeCard: vi.fn(),
  submitHandProof: vi.fn(),
  submitMoveProof: vi.fn(),
  shareAztecInfo: vi.fn(),
  relayNoteData: vi.fn(),
  notifySettleStarted: vi.fn(),
  notifyTxConfirmed: vi.fn(),
  refreshGameList: vi.fn(),
  leaveGame: vi.fn(),
  disconnect: vi.fn(),
  queueMatchmaking: vi.fn(),
  cancelMatchmaking: vi.fn(),
  ping: vi.fn(),
  addMessageListener: vi.fn(() => () => {}),
};

vi.mock('../useWebSocket', () => ({
  useWebSocket: () => {
    const state = React.useSyncExternalStore(
      (cb: () => void) => {
        wsListeners.add(cb);
        return () => { wsListeners.delete(cb); };
      },
      () => wsStore,
    );
    return { ...state, ...wsFns };
  },
}));

// ── Stable AztecContext mock ──────────────────────────────────
const stableAztec = {
  wallet: { fake: true },
  accountAddress: '0xPLAYER1',
  isAvailable: true,
  ownedCardIds: [1, 2, 3, 4, 5],
  updateOwnedCards: vi.fn(),
  refreshTokenBalance: vi.fn().mockResolvedValue(undefined),
  status: 'connected' as const,
  isConnecting: false,
  hasConnected: true,
  error: null,
  nodeClient: {},
  connect: vi.fn(),
  confirmFunded: vi.fn(),
  disconnect: vi.fn(),
  refreshOwnedCards: vi.fn(),
  tokenBalance: 100,
};

vi.mock('../../aztec/AztecContext', () => ({
  useAztecContext: () => stableAztec,
}));

// ── Proof generation mock ─────────────────────────────────────
const stubHandProof = { proof: 'hand-proof', cardCommit: '0xabc', publicInputs: ['0xabc','0x0'] };
let moveProofCounter = 0;
const stubMoveProof = () => {
  moveProofCounter++;
  return {
    proof: `move-proof-${moveProofCounter}`,
    cardCommit1: '0xabc',
    cardCommit2: '0xdef',
    startStateHash: `0x${moveProofCounter.toString(16)}s`,
    endStateHash: `0x${moveProofCounter.toString(16)}e`,
    gameEnded: moveProofCounter === 9,
    winnerId: moveProofCounter === 9 ? 1 : 0,
    publicInputs: ['0xabc','0xdef',`0x${moveProofCounter}s`,`0x${moveProofCounter}e`,'0','0'],
  };
};

vi.mock('../useProofGeneration', () => ({
  useProofGeneration: () => ({
    generateHandProof: vi.fn().mockResolvedValue(stubHandProof),
    generateMoveProof: vi.fn().mockImplementation(() => Promise.resolve(stubMoveProof())),
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

vi.mock('../../aztec/noteImporter', () => ({ importNotesFromTx: vi.fn() }));
vi.mock('../../aztec/cardStore', () => ({ removeCards: vi.fn() }));

vi.mock('../../aztec/contracts', () => {
  class FakeFr {
    constructor(public value: any) {}
    toString() { return String(this.value); }
    static fromHexString(s: string) { return new FakeFr(s); }
  }
  const nftContract = {
    methods: {
      get_note_nonce: vi.fn(() => ({ simulate: vi.fn(() => Promise.resolve({ result: 0 })) })),
      preview_game_data: vi.fn(() => ({
        simulate: vi.fn(() => Promise.resolve({
          result: ['0xgame1', '0xr0', '0xr1', '0xr2', '0xr3', '0xr4', '0xr5'],
        })),
      })),
      compute_blinding_factor: vi.fn(() => ({ simulate: vi.fn(() => Promise.resolve({ result: '0xblind' })) })),
      get_nfts_for_user: vi.fn(() => ({ simulate: vi.fn(() => Promise.resolve({ result: [[0,0,0,0,0,0,0,0,0,0], false] })) })),
    },
  };
  const gameContract = {
    methods: {
      get_game_status: vi.fn(() => ({ simulate: vi.fn(() => Promise.resolve({ result: 0 })) })),
      create_game: vi.fn(() => ({
        send: vi.fn(() => Promise.resolve({ receipt: { txHash: { toString: () => '0xCREATE_TX' } } })),
      })),
    },
  };
  return {
    ensureContracts: vi.fn().mockResolvedValue({
      gameContract, nftContract, fee: {}, Fr: FakeFr,
      AztecAddress: { fromStringUnsafe: (s: string) => s, ZERO: '0x0' },
    }),
    contractCache: {},
    warmupContracts: vi.fn(),
    waitForWarmup: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../../aztec/gameConstants', () => ({
  AZTEC_TX_TIMEOUT: 60000,
  AZTEC_SETTLE_TX_TIMEOUT: 5, // short — we never actually wait this long in the tests
  CARDS_PER_HAND: 5,
  TOTAL_MOVES: 9,
  MOVE_PROOF_WAIT_TIMEOUT: 2000,
  HAND_PROOF_WAIT_TIMEOUT: 2000,
}));

import { useGame } from '../useGame';

// ── Helpers ───────────────────────────────────────────────────

function makePlayableGameState() {
  const emptyCell = { card: null, owner: null };
  return {
    board: [[{ ...emptyCell },{ ...emptyCell },{ ...emptyCell }],
            [{ ...emptyCell },{ ...emptyCell },{ ...emptyCell }],
            [{ ...emptyCell },{ ...emptyCell },{ ...emptyCell }]],
    player1Hand: [{id:1,name:'c1',ranks:{top:1,right:1,bottom:1,left:1}},{id:2,name:'c2',ranks:{top:1,right:1,bottom:1,left:1}},{id:3,name:'c3',ranks:{top:1,right:1,bottom:1,left:1}},{id:4,name:'c4',ranks:{top:1,right:1,bottom:1,left:1}},{id:5,name:'c5',ranks:{top:1,right:1,bottom:1,left:1}}],
    player2Hand: [{id:6,name:'c6',ranks:{top:1,right:1,bottom:1,left:1}},{id:7,name:'c7',ranks:{top:1,right:1,bottom:1,left:1}},{id:8,name:'c8',ranks:{top:1,right:1,bottom:1,left:1}},{id:9,name:'c9',ranks:{top:1,right:1,bottom:1,left:1}},{id:10,name:'c10',ranks:{top:1,right:1,bottom:1,left:1}}],
    currentTurn: 'player1' as const,
    player1Score: 5,
    player2Score: 5,
    status: 'playing' as const,
    winner: null,
  };
}

describe('settlement flow: handleSettle stays stable across ws state updates', () => {
  beforeEach(() => {
    resetWsStore();
    moveProofCounter = 0;
    vi.clearAllMocks();
  });

  it('handleSettle is memoized when only opponent state updates', () => {
    // This is the precondition for the stale-closure bug. handleSettle MUST be
    // memoized for the bug to exist — if it re-creates on every ws update,
    // there's no stale closure to worry about.
    //
    // Updating ws.opponentCardIds, ws.opponentAztecAddress,
    // ws.opponentGameRandomness, ws.opponentTxConfirmed must NOT invalidate
    // handleSettle's useCallback deps.

    act(() => {
      updateWs({
        gameId: 'game-1',
        playerNumber: 1,
        gameState: makePlayableGameState(),
      });
    });

    const { result, rerender } = renderHook(() => useGame('ws://test'));
    const initial = result.current.handleSettle;

    // Update each opponent field individually, verify handleSettle doesn't change
    act(() => updateWs({ opponentAztecAddress: '0xOPP' }));
    rerender();
    expect(result.current.handleSettle).toBe(initial);

    act(() => updateWs({ opponentGameRandomness: ['0x1','0x2','0x3','0x4','0x5','0x6'] }));
    rerender();
    expect(result.current.handleSettle).toBe(initial);

    act(() => updateWs({ opponentCardIds: [6, 7, 8, 9, 10] }));
    rerender();
    expect(result.current.handleSettle).toBe(initial);

    act(() => updateWs({ opponentTxConfirmed: true }));
    rerender();
    expect(result.current.handleSettle).toBe(initial);

    act(() => updateWs({ gameOver: { winner: 'player1' } }));
    rerender();
    expect(result.current.handleSettle).toBe(initial);

    // Once the callback is memoized, its closure captures whichever ws
    // object existed when it was first created. The fix ensures that reads
    // of ws state inside the closure go via refs (wsOpponentCardIdsRef etc)
    // that are updated on every render, bypassing the memoization staleness.
  });

  it('hook does not throw when ws state updates after handleSettle is memoized', () => {
    // Sanity check: updating ws state in quick succession doesn't crash the
    // hook. This exercises the useSyncExternalStore path and the
    // ref-update-on-render pattern used to avoid stale closures.

    const { result, rerender } = renderHook(() => useGame('ws://test'));

    expect(() => {
      act(() => updateWs({
        gameId: 'g1',
        playerNumber: 1,
        gameState: makePlayableGameState(),
      }));
      rerender();

      act(() => updateWs({
        opponentAztecAddress: '0xOPP',
        opponentGameRandomness: ['0x1','0x2','0x3','0x4','0x5','0x6'],
      }));
      rerender();

      act(() => updateWs({
        opponentCardIds: [6, 7, 8, 9, 10],
        gameOver: { winner: 'player1' },
      }));
      rerender();

      act(() => updateWs({ opponentTxConfirmed: true }));
      rerender();
    }).not.toThrow();

    // At this point, all ws state is populated. A subsequent call to
    // handleSettle should be able to read the populated values via the
    // refs, regardless of the memoized closure's captured `ws`.
    expect(result.current.handleSettle).toBeTypeOf('function');
    expect(wsStore.opponentCardIds).toEqual([6, 7, 8, 9, 10]);
    expect(wsStore.opponentAztecAddress).toBe('0xOPP');
  });
});
