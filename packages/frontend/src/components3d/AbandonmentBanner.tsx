import { useEffect, useState } from 'react';
import type { Player } from '../types';
import type { AbandonmentWarning } from '../hooks/useWebSocket';

interface AbandonmentBannerProps {
  /** Live present-but-idle warning from the relay, or null when none is active. */
  warning: AbandonmentWarning | null;
  /** This client's player side, to decide idle-vs-waiting framing. */
  myPlayer: Player;
  /** True while the on-chain claim+settle flow is running (button → disabled). */
  isClaimingAbandoned: boolean;
  /** Seconds left in the on-chain dispute window during claim, else null. */
  abandonedDisputeCountdown: number | null;
  /** Fire the claim flow (claim_abandoned_game → dispute wait → settle). */
  onClaimAbandoned: () => void;
}

/**
 * Warning banner for the present-but-idle abandonment flow
 * (docs/plan/ABANDONED_GAMES.md "Message contract"):
 *  - If I AM the idle player: "move now or your opponent can claim the game".
 *  - If I am NOT the idle player: "Opponent isn't moving" + a live countdown
 *    and, once claimable, a "Claim abandoned game" button → onClaimAbandoned.
 *  - During the on-chain dispute window the claimant sees the dispute countdown
 *    ("opponent has Ns to dispute / resolving…").
 *
 * The countdown ticks locally each second from the last server value so it is
 * live between (possibly infrequent) GAME_ABANDONMENT_WARNING re-sends; it is
 * re-seeded whenever a fresh warning arrives.
 */
export function AbandonmentBanner({
  warning,
  myPlayer,
  isClaimingAbandoned,
  abandonedDisputeCountdown,
  onClaimAbandoned,
}: AbandonmentBannerProps) {
  // Local live countdown seeded from the server's secondsUntilClaimable.
  const serverSeconds = warning?.secondsUntilClaimable ?? null;
  const [secondsLeft, setSecondsLeft] = useState<number | null>(serverSeconds);

  // Re-seed when the server pushes a new value (or the warning clears).
  useEffect(() => {
    setSecondsLeft(serverSeconds);
  }, [serverSeconds]);

  // Tick down once per second while a warning is active and not yet claimable.
  useEffect(() => {
    if (serverSeconds === null) return;
    const id = setInterval(() => {
      setSecondsLeft(prev => (prev === null ? null : Math.max(0, prev - 1)));
    }, 1000);
    return () => clearInterval(id);
  }, [serverSeconds]);

  // While the claim flow runs, the dispute-window banner takes over even if the
  // warning has since cleared (a move/GAME_STATE could have raced in).
  if (isClaimingAbandoned || abandonedDisputeCountdown !== null) {
    const disputeText = abandonedDisputeCountdown != null && abandonedDisputeCountdown > 0
      ? `Claiming abandoned game — opponent has ${abandonedDisputeCountdown}s to dispute…`
      : 'Claiming abandoned game — resolving…';
    return (
      <div
        className="game-screen__alert"
        data-testid="abandonment-dispute"
        style={{ position: 'fixed', top: 40, left: 0, right: 0, zIndex: 11, textAlign: 'center', pointerEvents: 'none' }}
      >
        {disputeText}
      </div>
    );
  }

  if (!warning) return null;

  const iAmIdle = warning.idlePlayer === myPlayer;
  const claimable = secondsLeft !== null && secondsLeft <= 0;

  return (
    <div
      className="game-screen__alert"
      data-testid="abandonment-warning"
      data-idle={iAmIdle ? 'me' : 'opponent'}
      style={{
        position: 'fixed', top: 40, left: 0, right: 0, zIndex: 11,
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
        pointerEvents: 'auto',
      }}
    >
      {iAmIdle ? (
        <span data-testid="abandonment-warning-self">
          You haven't moved — move now or your opponent can claim the game
        </span>
      ) : (
        <>
          <span data-testid="abandonment-warning-opponent">
            Opponent isn't moving
            {!claimable && secondsLeft !== null && (
              <> — claimable in <strong data-testid="abandonment-countdown">{secondsLeft}s</strong></>
            )}
          </span>
          <button
            className="btn btn--small"
            data-testid="claim-abandoned-game"
            disabled={!claimable || isClaimingAbandoned}
            onClick={onClaimAbandoned}
          >
            Claim abandoned game
          </button>
        </>
      )}
    </div>
  );
}
