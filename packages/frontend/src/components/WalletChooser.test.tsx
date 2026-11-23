/**
 * The screens that ask which wallet to use and walk a Nulo connection through
 * its approvals, plus the menu's wallet controls.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WalletChooser } from './WalletChooser';
import { NuloConnect } from './NuloConnect';
import { MainMenu } from './MainMenu';

describe('WalletChooser', () => {
  it('offers Nulo and the in-browser wallet, and reports which one was picked', () => {
    const onChoose = vi.fn();
    render(<WalletChooser onChoose={onChoose} />);

    fireEvent.click(screen.getByTestId('choose-nulo'));
    fireEvent.click(screen.getByTestId('choose-embedded'));

    expect(onChoose.mock.calls).toEqual([['nulo'], ['embedded']]);
    expect(screen.getByRole('link', { name: 'nulo.sh' }).getAttribute('href')).toBe('https://nulo.sh');
  });
});

function nuloProps(overrides: Partial<Parameters<typeof NuloConnect>[0]> = {}): Parameters<typeof NuloConnect>[0] {
  return {
    step: { step: 'discovering' },
    error: null,
    onAnswerEmojis: vi.fn(),
    onCancel: vi.fn(),
    onRetry: vi.fn(),
    onUseInBrowser: vi.fn(),
    ...overrides,
  };
}

describe('NuloConnect', () => {
  it('tells the player to allow the connection in Nulo, and lets them cancel', () => {
    const p = nuloProps();
    render(<NuloConnect {...p} />);

    expect(screen.getByText(/allow Axolotl Arena to connect/)).toBeTruthy();
    fireEvent.click(screen.getByTestId('nulo-cancel'));
    expect(p.onCancel).toHaveBeenCalled();
  });

  it('shows the emoji grid in order and passes on the answer', () => {
    const emojis = ['🦊', '🐸', '🎲', '🐼', '🌟', '💎', '🦋', '🎯', '🔵'];
    const p = nuloProps({ step: { step: 'verifying', emojis } });
    render(<NuloConnect {...p} />);

    expect(screen.getByTestId('nulo-emojis').textContent).toBe(emojis.join(''));
    fireEvent.click(screen.getByTestId('nulo-emojis-match'));
    fireEvent.click(screen.getByTestId('nulo-emojis-differ'));
    expect((p.onAnswerEmojis as ReturnType<typeof vi.fn>).mock.calls).toEqual([[true], [false]]);
  });

  it('asks for the starter-card approval in Nulo', () => {
    render(<NuloConnect {...nuloProps({ step: { step: 'claiming' } })} />);
    expect(screen.getByText(/Approve the starter-card claim in Nulo/)).toBeTruthy();
  });

  it('on failure, shows why and offers another try or the in-browser wallet', () => {
    const p = nuloProps({ error: 'Nulo did not answer.' });
    render(<NuloConnect {...p} />);

    expect(screen.getByTestId('nulo-error').textContent).toContain('Nulo did not answer.');
    fireEvent.click(screen.getByTestId('nulo-retry'));
    fireEvent.click(screen.getByTestId('nulo-use-in-browser'));
    expect(p.onRetry).toHaveBeenCalled();
    expect(p.onUseInBrowser).toHaveBeenCalled();
  });
});

function menuProps(overrides: Partial<Parameters<typeof MainMenu>[0]> = {}): Parameters<typeof MainMenu>[0] {
  return {
    connected: true, aztecStatus: 'connected', aztecError: null, onRetryAztec: vi.fn(),
    aztecConnecting: false, aztecReady: true, cardCount: 5, tokenBalance: 100,
    accountAddress: '0x' + '0b'.repeat(32), hasGameInProgress: false, stuckGame: null,
    isRecovering: false, onRecoverStuckGame: vi.fn(), onContestClaim: vi.fn(),
    onPlay: vi.fn(), onTutorial: vi.fn(), onPractice: vi.fn(), onCardPacks: vi.fn(),
    ...overrides,
  };
}

describe('MainMenu wallet controls', () => {
  it('offers to switch wallets', () => {
    const onSwitchWallet = vi.fn();
    render(<MainMenu {...menuProps({ walletKind: 'embedded', onSwitchWallet })} />);

    fireEvent.click(screen.getByTestId('switch-wallet'));
    expect(onSwitchWallet).toHaveBeenCalled();
  });

  it('hides the in-browser wallet\'s repair tools from a Nulo player, whose state lives in Nulo', () => {
    render(<MainMenu {...menuProps({ walletKind: 'nulo', onSwitchWallet: vi.fn() })} />);

    expect(screen.getByTestId('switch-wallet').textContent).toBe('Switch Wallet (Nulo)');
    expect(screen.queryByTestId('repair-chain-sync')).toBeNull();
    expect(screen.queryByTestId('clear-all-state')).toBeNull();
  });

  it('keeps them for the in-browser wallet', () => {
    render(<MainMenu {...menuProps({ walletKind: 'embedded', onSwitchWallet: vi.fn() })} />);

    expect(screen.getByTestId('repair-chain-sync')).toBeTruthy();
    expect(screen.getByTestId('clear-all-state')).toBeTruthy();
  });
});
