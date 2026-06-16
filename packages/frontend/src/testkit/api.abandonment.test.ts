/**
 * Testkit abandonment surface (docs/plan/ABANDONED_GAMES.md "Missing #2",
 * Phase-1 testkit). The playtest harness must be able to:
 *   (a) OBSERVE the abandonment warning — phase().abandonment.{warning,
 *       claimAvailable,isClaimingAbandoned,disputeCountdown}
 *   (b) TRIGGER the claim — __triadTest.claimAbandonedGame(), equivalent to
 *       clicking "Claim abandoned game" (calls game.handleClaimAbandoned()).
 *
 * These assertions fail against the pre-change testkit (no abandonment block,
 * no claimAbandonedGame action).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Keep the test hermetic: stub the heavy deps api.ts pulls in. The registry is
// real module state (the bridge target); project/contracts/txManager are not
// exercised by the abandonment surface.
vi.mock('../aztec/contracts', () => ({ ensureContracts: vi.fn() }));
vi.mock('./project', () => ({ getScreenXY: vi.fn() }));
vi.mock('../aztec/txManager', () => ({
  default: { getEntries: () => [], enqueuePxe: vi.fn() },
}));
vi.mock('../aztec/txProgress', () => ({
  txProgress: { subscribe: vi.fn() },
}));

import { createApi } from './api';
import { registry, publishApp } from './registry';
import type { UseAztecReturn } from '../hooks/useAztec';
import type { UseGameReturn } from '../hooks/useGame';

function publish(opts: {
  warning?: { idlePlayer: 'player1' | 'player2'; secondsIdle: number; secondsUntilClaimable: number } | null;
  isClaimingAbandoned?: boolean;
  abandonedDisputeCountdown?: number | null;
  playerNumber?: 1 | 2;
  handleClaimAbandoned?: () => void;
}) {
  const aztec = {
    status: 'connected', accountAddress: '0xME', ownedCardIds: [], tokenBalance: 0,
  } as unknown as UseAztecReturn;

  const game = {
    screen: 'game',
    onChainGameId: '0xG', handProofStatus: 'ready', moveProofStatus: 'ready',
    canSettle: false, settleTxStatus: 'idle', opponentSettled: false,
    takenCardId: null, onChainError: null,
    isClaimingAbandoned: opts.isClaimingAbandoned ?? false,
    abandonedDisputeCountdown: opts.abandonedDisputeCountdown ?? null,
    handleClaimAbandoned: opts.handleClaimAbandoned ?? (() => {}),
    handlePlaceCard: () => {},
    ws: {
      connected: true, gameId: 'ws-game', playerNumber: opts.playerNumber ?? 1,
      matchmakingStatus: 'idle', gameOver: null, opponentDisconnected: false,
      abandonmentWarning: opts.warning ?? null,
      gameState: null,
    },
  } as unknown as UseGameReturn;

  publishApp(aztec, game);
}

describe('testkit abandonment surface', () => {
  beforeEach(() => {
    registry.aztec = null;
    registry.game = null;
    registry.gameScreen = null;
    registry.scene = null;
  });

  it('exposes a claimAbandonedGame() action that calls game.handleClaimAbandoned', () => {
    const onClaim = vi.fn();
    publish({ handleClaimAbandoned: onClaim, warning: { idlePlayer: 'player2', secondsIdle: 60, secondsUntilClaimable: 0 } });

    const api = createApi();
    expect(typeof api.claimAbandonedGame).toBe('function');

    api.claimAbandonedGame();
    expect(onClaim).toHaveBeenCalledTimes(1);
  });

  it('phase().abandonment reports the warning and claimAvailable for the non-idle player', () => {
    // I am player1; player2 is idle and the window has elapsed → I may claim.
    publish({ playerNumber: 1, warning: { idlePlayer: 'player2', secondsIdle: 60, secondsUntilClaimable: 0 } });

    const api = createApi();
    const snap = api.phase()!;
    expect(snap.abandonment.warning).toEqual({ idlePlayer: 'player2', secondsIdle: 60, secondsUntilClaimable: 0 });
    expect(snap.abandonment.claimAvailable).toBe(true);
    expect(snap.abandonment.isClaimingAbandoned).toBe(false);
  });

  it('claimAvailable is false while the countdown has not elapsed', () => {
    publish({ playerNumber: 1, warning: { idlePlayer: 'player2', secondsIdle: 60, secondsUntilClaimable: 5 } });
    const snap = createApi().phase()!;
    expect(snap.abandonment.warning!.secondsUntilClaimable).toBe(5);
    expect(snap.abandonment.claimAvailable).toBe(false);
  });

  it('claimAvailable is false for the IDLE player (they cannot claim themselves)', () => {
    // I am player1 and I am the idle one.
    publish({ playerNumber: 1, warning: { idlePlayer: 'player1', secondsIdle: 60, secondsUntilClaimable: 0 } });
    const snap = createApi().phase()!;
    expect(snap.abandonment.claimAvailable).toBe(false);
  });

  it('surfaces the dispute countdown + claiming flag during the on-chain claim', () => {
    publish({ playerNumber: 1, warning: null, isClaimingAbandoned: true, abandonedDisputeCountdown: 30 });
    const snap = createApi().phase()!;
    expect(snap.abandonment.isClaimingAbandoned).toBe(true);
    expect(snap.abandonment.disputeCountdown).toBe(30);
    // claimAvailable is false (no active warning / already claiming).
    expect(snap.abandonment.claimAvailable).toBe(false);
  });

  it('abandonment.warning is null when no warning is active', () => {
    publish({ playerNumber: 1, warning: null });
    const snap = createApi().phase()!;
    expect(snap.abandonment.warning).toBeNull();
    expect(snap.abandonment.claimAvailable).toBe(false);
  });
});
