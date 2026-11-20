/**
 * The main menu must never say "Connected" while the chain is unusable.
 *
 * Its badge used to show only the relay socket, so through the Oct-Nov 2026
 * testnet outage the live site greeted every visitor with "Connected", 0 cards
 * and a disabled Play button, and the reason lived only in the console.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MainMenu, connectionBadge } from './MainMenu';

function props(overrides: Partial<Parameters<typeof MainMenu>[0]> = {}): Parameters<typeof MainMenu>[0] {
  return {
    connected: true,
    aztecStatus: 'connected',
    aztecError: null,
    onRetryAztec: vi.fn(),
    aztecConnecting: false,
    aztecReady: true,
    cardCount: 5,
    tokenBalance: 100,
    accountAddress: '0x' + '0b'.repeat(32),
    hasGameInProgress: false,
    stuckGame: null,
    isRecovering: false,
    onRecoverStuckGame: vi.fn(),
    onContestClaim: vi.fn(),
    onPlay: vi.fn(),
    onTutorial: vi.fn(),
    onPractice: vi.fn(),
    onCardPacks: vi.fn(),
    ...overrides,
  };
}

describe('connectionBadge', () => {
  it('says Connected only when the relay and Aztec are both up', () => {
    expect(connectionBadge(true, 'connected')).toEqual({ label: 'Connected', tone: 'ok' });
  });

  it('reports an Aztec failure even while the relay is fine — the outage case', () => {
    expect(connectionBadge(true, 'error')).toEqual({ label: 'Aztec network unavailable', tone: 'error' });
  });

  it('puts an Aztec failure ahead of a relay that is still connecting', () => {
    expect(connectionBadge(false, 'error').tone).toBe('error');
  });

  it('names whichever link is still coming up', () => {
    expect(connectionBadge(false, 'connected').label).toBe('Connecting to game server...');
    expect(connectionBadge(true, 'connecting').label).toBe('Connecting to Aztec...');
    expect(connectionBadge(true, 'deploying').label).toBe('Connecting to Aztec...');
    expect(connectionBadge(true, 'needs-funding').label).toBe('Account needs funding');
  });
});

describe('MainMenu when the Aztec node is unreachable', () => {
  const outage = () =>
    props({
      aztecStatus: 'error',
      aztecError: 'Error fetching from host https://v5.testnet.rpc.aztec-labs.com: fetch failed',
      aztecReady: false,
      cardCount: 0,
      tokenBalance: 0,
    });

  it('shows the failure and its reason instead of "Connected"', () => {
    render(<MainMenu {...outage()} />);
    expect(screen.getByTestId('connection-status').textContent).toBe('Aztec network unavailable');
    expect(screen.getByTestId('aztec-error').textContent).toContain('fetch failed');
    expect(screen.queryByText('Connected')).toBeNull();
  });

  it('explains the disabled buttons and offers a retry', () => {
    const p = outage();
    render(<MainMenu {...p} />);
    const play = screen.getByTestId('menu-play') as HTMLButtonElement;
    expect(play.disabled).toBe(true);
    expect(play.title).toBe('Aztec network unavailable');
    expect((screen.getByTestId('menu-packs') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('aztec-retry'));
    expect(p.onRetryAztec).toHaveBeenCalledTimes(1);
  });

  it('keeps Practice vs Bot available', () => {
    const p = outage();
    render(<MainMenu {...p} />);
    fireEvent.click(screen.getByText('Practice vs Bot'));
    expect(p.onPractice).toHaveBeenCalledTimes(1);
  });

  it('shows no error panel once everything is up', () => {
    render(<MainMenu {...props()} />);
    expect(screen.getByTestId('connection-status').textContent).toBe('Connected');
    expect(screen.queryByTestId('aztec-error')).toBeNull();
  });
});
