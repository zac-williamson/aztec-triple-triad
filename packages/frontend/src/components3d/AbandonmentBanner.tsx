import { useEffect, useState } from 'react';
import type { Player } from '../types';
import type { AbandonmentWarning } from '../hooks/useWebSocket';

interface AbandonmentBannerProps {
  /** Live present-but-idle warning from the relay, or null when none is active. */
  warning: AbandonmentWarning | null;
  /** This client's player side, to decide idle-vs-waiting framing. */
  myPlayer: Player;
  /** True while the on-chain claim → finalize flow is running (button → disabled). */
  isClaimingAbandoned: boolean;
  /** Seconds until the contract will accept the claim, while the flow waits
   *  for the game to reach MIN_ABANDON_SECONDS; else null. */
  abandonBarCountdown?: number | null;
  /** Seconds left in the on-chain dispute window during claim, else null. */
  abandonedDisputeCountdown: number | null;
  /** Fire the claim flow (claim_abandoned_game → dispute wait → finalize_abandoned_game). */
  onClaimAbandoned: () => void;
}

/**
 * Warning banner for the present-but-idle abandonment flow
 * (docs/plan/ABANDONED_GAMES.md "Message contract"):
 *  - If I AM the idle player: a live countdown to the abandonment deadline
 *    ("Ns until the game is flagged abandoned"), then a "flagged as abandoned —
 *    move immediately" message once it is claimable. Nobody forfeits a card: a
 *    claim returns each player only their own stake, so what an idle player
 *    loses is the game, not a card.
 *  - If I am NOT the idle player: "Opponent isn't moving" + a live countdown
 *    and, once claimable, a "Claim abandoned game" button → onClaimAbandoned.
 *  - While the claim waits for the game to be old enough for the contract
 *    (MIN_ABANDON_SECONDS since it went active), the claimant sees that
 *    countdown; then, during the on-chain dispute window, the dispute
 *    countdown ("opponent has Ns to dispute / resolving…").
 *
 * The countdown ticks locally each second from the last server value so it is
 * live between (possibly infrequent) GAME_ABANDONMENT_WARNING re-sends; it is
 * re-seeded whenever a fresh warning arrives.
 */
export function AbandonmentBanner({
  warning,
  myPlayer,
  isClaimingAbandoned,
  abandonBarCountdown = null,
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
    const disputeText = abandonBarCountdown != null && abandonBarCountdown > 0
      ? `Claim opens in ${abandonBarCountdown}s — a game must have run 8 minutes before it can be called abandoned`
      : abandonedDisputeCountdown != null && abandonedDisputeCountdown > 0
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
          {claimable ? (
            <>Game flagged as <strong>abandoned</strong> — your opponent can claim it now. Move immediately to keep the game going.</>
          ) : (
            <>
              You haven't moved —{' '}
              <strong data-testid="abandonment-countdown-self">{secondsLeft}s</strong>
              {' '}until the game is flagged abandoned and your opponent can claim it. Move now!
            </>
          )}
        </span>
      ) : (
        <>
          <span data-testid="abandonment-warning-opponent">
            {claimable ? (
              <>Opponent abandoned the game</>
            ) : (
              <>
                Opponent isn't moving
                {secondsLeft !== null && (
                  <> — claimable in <strong data-testid="abandonment-countdown">{secondsLeft}s</strong></>
                )}
              </>
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
