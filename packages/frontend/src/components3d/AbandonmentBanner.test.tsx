/**
 * AbandonmentBanner — the present-but-idle abandonment UX
 * (docs/plan/ABANDONED_GAMES.md "Message contract"):
 *  - idle player sees a live countdown to the deadline + a forfeit warning,
 *    then "flagged as abandoned — move immediately" once claimable
 *  - non-idle player sees "Opponent isn't moving" + live countdown + a
 *    "Claim abandoned game" button that fires only once claimable
 *  - during the on-chain dispute window, the claimant sees the dispute banner.
 *
 * These assertions fail against the pre-change code (no banner exists at all).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { AbandonmentBanner } from './AbandonmentBanner';
import type { AbandonmentWarning } from '../hooks/useWebSocket';

const noop = () => {};

function warn(over: Partial<AbandonmentWarning> = {}): AbandonmentWarning {
  return { idlePlayer: 'player1', secondsIdle: 60, secondsUntilClaimable: 5, ...over };
}

describe('AbandonmentBanner', () => {
  it('renders nothing when there is no warning and no claim in flight', () => {
    const { container } = render(
      <AbandonmentBanner
        warning={null} myPlayer="player1"
        isClaimingAbandoned={false} abandonedDisputeCountdown={null}
        onClaimAbandoned={noop}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows a live countdown + forfeit warning when I AM the idle player (impending)', () => {
    render(
      <AbandonmentBanner
        warning={warn({ idlePlayer: 'player1', secondsUntilClaimable: 5 })} myPlayer="player1"
        isClaimingAbandoned={false} abandonedDisputeCountdown={null}
        onClaimAbandoned={noop}
      />,
    );
    expect(screen.getByTestId('abandonment-warning-self')).toBeTruthy();
    // The idle player sees how long until they forfeit (a live countdown).
    expect(screen.getByTestId('abandonment-countdown-self').textContent).toBe('5s');
    expect(screen.getByText(/until the game is flagged abandoned/i)).toBeTruthy();
    expect(screen.getByText(/forfeit a card/i)).toBeTruthy();
    // The idle player gets NO claim button.
    expect(screen.queryByTestId('claim-abandoned-game')).toBeNull();
  });

  it('tells the idle player the game is flagged abandoned once claimable', () => {
    render(
      <AbandonmentBanner
        warning={warn({ idlePlayer: 'player1', secondsUntilClaimable: 0 })} myPlayer="player1"
        isClaimingAbandoned={false} abandonedDisputeCountdown={null}
        onClaimAbandoned={noop}
      />,
    );
    // textContent (the <strong> splits the text nodes): full message check.
    const selfBanner = screen.getByTestId('abandonment-warning-self');
    expect(selfBanner.textContent).toMatch(/flagged as abandoned/i);
    expect(selfBanner.textContent).toMatch(/move immediately or you forfeit/i);
    // No countdown once claimable, and still no claim button for the idle player.
    expect(screen.queryByTestId('abandonment-countdown-self')).toBeNull();
    expect(screen.queryByTestId('claim-abandoned-game')).toBeNull();
  });

  it('shows "Opponent isn\'t moving" + a disabled claim button when I am NOT idle and not yet claimable', () => {
    render(
      <AbandonmentBanner
        warning={warn({ idlePlayer: 'player2', secondsUntilClaimable: 5 })} myPlayer="player1"
        isClaimingAbandoned={false} abandonedDisputeCountdown={null}
        onClaimAbandoned={noop}
      />,
    );
    expect(screen.getByTestId('abandonment-warning-opponent')).toBeTruthy();
    expect(screen.getByText(/Opponent isn't moving/i)).toBeTruthy();
    expect(screen.getByTestId('abandonment-countdown').textContent).toBe('5s');
    const btn = screen.getByTestId('claim-abandoned-game') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('enables the claim button once the countdown reaches 0', () => {
    render(
      <AbandonmentBanner
        warning={warn({ idlePlayer: 'player2', secondsUntilClaimable: 0 })} myPlayer="player1"
        isClaimingAbandoned={false} abandonedDisputeCountdown={null}
        onClaimAbandoned={noop}
      />,
    );
    const btn = screen.getByTestId('claim-abandoned-game') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it('clicking the enabled claim button fires onClaimAbandoned', () => {
    const onClaim = vi.fn();
    render(
      <AbandonmentBanner
        warning={warn({ idlePlayer: 'player2', secondsUntilClaimable: 0 })} myPlayer="player1"
        isClaimingAbandoned={false} abandonedDisputeCountdown={null}
        onClaimAbandoned={onClaim}
      />,
    );
    fireEvent.click(screen.getByTestId('claim-abandoned-game'));
    expect(onClaim).toHaveBeenCalledTimes(1);
  });

  it('shows the dispute-window banner with the countdown while claiming', () => {
    render(
      <AbandonmentBanner
        warning={null} myPlayer="player1"
        isClaimingAbandoned={true} abandonedDisputeCountdown={42}
        onClaimAbandoned={noop}
      />,
    );
    const dispute = screen.getByTestId('abandonment-dispute');
    expect(dispute).toBeTruthy();
    expect(dispute.textContent).toMatch(/42s to dispute/);
    // The warning banner is replaced by the dispute banner.
    expect(screen.queryByTestId('claim-abandoned-game')).toBeNull();
  });

  it('shows "resolving…" once the dispute countdown elapses', () => {
    render(
      <AbandonmentBanner
        warning={null} myPlayer="player1"
        isClaimingAbandoned={true} abandonedDisputeCountdown={0}
        onClaimAbandoned={noop}
      />,
    );
    expect(screen.getByTestId('abandonment-dispute').textContent).toMatch(/resolving/i);
  });

  describe('live countdown', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('ticks the countdown down once per second and enables the button at 0', () => {
      const onClaim = vi.fn();
      render(
        <AbandonmentBanner
          warning={warn({ idlePlayer: 'player2', secondsUntilClaimable: 2 })} myPlayer="player1"
          isClaimingAbandoned={false} abandonedDisputeCountdown={null}
          onClaimAbandoned={onClaim}
        />,
      );
      expect(screen.getByTestId('abandonment-countdown').textContent).toBe('2s');
      expect((screen.getByTestId('claim-abandoned-game') as HTMLButtonElement).disabled).toBe(true);

      act(() => { vi.advanceTimersByTime(1000); });
      expect(screen.getByTestId('abandonment-countdown').textContent).toBe('1s');

      act(() => { vi.advanceTimersByTime(1000); });
      // At 0 the countdown text is gone and the button is enabled.
      expect(screen.queryByTestId('abandonment-countdown')).toBeNull();
      expect((screen.getByTestId('claim-abandoned-game') as HTMLButtonElement).disabled).toBe(false);
    });
  });
});
