/**
 * Route selection. The dangerous outcomes here are silent ones: a swap sent to
 * the wrong router still takes the player's ETH, and a swap with no minimum
 * output is a free sandwich. Both must fail loudly instead.
 */
import { describe, it, expect } from 'vitest';
import { chooseAcquireRoute, routeCostsRealMoney } from '../fundingRoutes';

const PORTAL = '0x00000000000000000000000000000000000000aa' as const;
const ASSET = '0x00000000000000000000000000000000000000bb' as const;
const HANDLER = '0x00000000000000000000000000000000000000cc' as const;

describe('chooseAcquireRoute', () => {
  it('mints where the node exposes a fee-asset faucet', () => {
    const route = chooseAcquireRoute({
      chainId: 11155111,
      l1: { feeJuiceAddress: ASSET, feeJuicePortalAddress: PORTAL, feeAssetHandlerAddress: HANDLER },
      ethIn: 0n,
    });
    // Presence of the handler is the signal, not the chain id: a deployment
    // either has a mock fee asset or it does not.
    expect(route.kind).toBe('mint');
    expect(routeCostsRealMoney(route)).toBe(false);
  });

  it('swaps on mainnet, where there is no faucet', () => {
    const route = chooseAcquireRoute({
      chainId: 1,
      l1: { feeJuiceAddress: ASSET, feeJuicePortalAddress: PORTAL },
      ethIn: 10n ** 16n,
      quotedOut: 10n ** 18n,
    });
    expect(route.kind).toBe('swap');
    if (route.kind !== 'swap') return;
    expect(route.router).toBe('0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45');
    expect(route.weth).toBe('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2');
    expect(routeCostsRealMoney(route)).toBe(true);
  });

  it('refuses a swap with no quote', () => {
    // Zero minimum output means anyone watching the mempool can take the lot.
    expect(() => chooseAcquireRoute({
      chainId: 1,
      l1: { feeJuiceAddress: ASSET, feeJuicePortalAddress: PORTAL },
      ethIn: 10n ** 16n,
    })).toThrow(/needs a quote/i);
  });

  it('refuses an unknown chain rather than guessing a router', () => {
    // A wrong router address still accepts the transaction and keeps the ETH.
    expect(() => chooseAcquireRoute({
      chainId: 424242,
      l1: { feeJuiceAddress: ASSET, feeJuicePortalAddress: PORTAL },
      ethIn: 10n ** 16n,
      quotedOut: 10n ** 18n,
    })).toThrow(/no configured swap router/i);
  });

  it('accepts an override for a chain not in the table', () => {
    const route = chooseAcquireRoute({
      chainId: 424242,
      l1: { feeJuiceAddress: ASSET, feeJuicePortalAddress: PORTAL },
      ethIn: 10n ** 16n,
      quotedOut: 10n ** 18n,
      overrides: { router: PORTAL, weth: ASSET },
    });
    expect(route.kind).toBe('swap');
  });

  it('refuses to spend nothing', () => {
    expect(() => chooseAcquireRoute({
      chainId: 1,
      l1: { feeJuiceAddress: ASSET, feeJuicePortalAddress: PORTAL },
      ethIn: 0n,
      quotedOut: 10n ** 18n,
    })).toThrow(/greater than zero/i);
  });

  it('defaults slippage to something a player would accept', () => {
    const route = chooseAcquireRoute({
      chainId: 1,
      l1: { feeJuiceAddress: ASSET, feeJuicePortalAddress: PORTAL },
      ethIn: 10n ** 16n,
      quotedOut: 10n ** 18n,
    });
    if (route.kind !== 'swap') throw new Error('expected a swap');
    expect(route.maxSlippage).toBeGreaterThan(0);
    expect(route.maxSlippage).toBeLessThanOrEqual(0.05);
  });
});
