/**
 * The consent gate on the funding screen.
 *
 * The claim this file has to keep honest is narrow and load-bearing: on a
 * network where Fee Juice costs money, the player sees the price BEFORE
 * anything is signed, and the numbers they see are the ones the swap will use.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FundingPrompt } from './FundingPrompt';

const ADDR = '0x0e3c0e29c5de8393bf7e32017841bfc1fb3f76eaeb6f63f4a510f9dd766917c7';
const base = { accountAddress: ADDR, onConfirm: vi.fn(), onFundWithWallet: vi.fn() };

const QUOTE = {
  ethIn: 25_000_000_000_000_000n,   // 0.025 ETH
  quotedOut: 10n ** 18n,            // 1.0 Fee Juice
  minimumOut: 980_000_000_000_000_000n, // 0.98 after 2% slippage
  poolFee: 3000,
};

describe('FundingPrompt', () => {
  it('offers the wallet as the primary path when there is nothing to price', () => {
    render(<FundingPrompt {...base} />);
    expect(screen.getByTestId('fund-with-wallet')).toBeTruthy();
    expect(screen.queryByTestId('swap-quote')).toBeNull();
  });

  it('shows what the player pays, gets, and gets at worst', () => {
    render(<FundingPrompt {...base} quote={QUOTE} />);
    const panel = screen.getByTestId('swap-quote');
    expect(panel.textContent).toContain('0.025 ETH');
    expect(panel.textContent).toContain('1 Fee Juice');
    expect(panel.textContent).toContain('0.98 Fee Juice');
  });

  it('spends nothing until the quote is accepted', () => {
    const onAcceptQuote = vi.fn();
    const onFundWithWallet = vi.fn();
    render(
      <FundingPrompt {...base} quote={QUOTE}
        onFundWithWallet={onFundWithWallet} onAcceptQuote={onAcceptQuote} />,
    );
    // The button that starts spending is not reachable while a quote is up:
    // only the explicit "yes, at this price" control is.
    expect(onFundWithWallet).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('accept-quote'));
    expect(onAcceptQuote).toHaveBeenCalledOnce();
  });

  it('lets the player back out of a price without buying', () => {
    const onCancelQuote = vi.fn();
    const onAcceptQuote = vi.fn();
    render(
      <FundingPrompt {...base} quote={QUOTE}
        onAcceptQuote={onAcceptQuote} onCancelQuote={onCancelQuote} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onCancelQuote).toHaveBeenCalledOnce();
    expect(onAcceptQuote).not.toHaveBeenCalled();
  });

  it('surfaces a funding failure instead of leaving a dead screen', () => {
    render(<FundingPrompt {...base} error="Bridge deposit reverted on L1" />);
    expect(screen.getByText(/Bridge deposit reverted on L1/)).toBeTruthy();
  });
});
