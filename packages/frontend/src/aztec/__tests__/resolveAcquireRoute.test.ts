/**
 * Turning "this player needs Fee Juice" into a priced, signable swap.
 *
 * The property that matters: the minimum output must be derived from a quote of
 * the amount actually being sent, on the tier actually being used. Rescaling
 * the exact-output quote instead would produce a floor that looks right and is
 * wrong the moment the pool is not linear — which is always.
 */
import { describe, it, expect, vi } from 'vitest';
import { resolveAcquireRoute, DEFAULT_FEE_JUICE_TARGET } from '../fundingRoutes';

const PORTAL = '0x00000000000000000000000000000000000000aa' as const;
const ASSET = '0x00000000000000000000000000000000000000bb' as const;
const HANDLER = '0x00000000000000000000000000000000000000cc' as const;
const QUOTER = '0x00000000000000000000000000000000000000dd' as const;

/** Exact-out costs 1 wei per unit; exact-in returns 1 unit per wei. */
function linearQuoter() {
  return {
    simulateContract: vi.fn(async ({ functionName, args }: {
      functionName: string; args: readonly { amount?: bigint; amountIn?: bigint; fee: number }[];
    }) => {
      if (args[0].fee !== 3000) throw new Error('execution reverted');
      return functionName === 'quoteExactOutputSingle'
        ? { result: [args[0].amount!, 0n, 0, 0n] }
        : { result: [args[0].amountIn!, 0n, 0, 0n] };
    }),
  } as never;
}

describe('resolveAcquireRoute', () => {
  it('mints, without quoting, where the node exposes a faucet', async () => {
    const pub = linearQuoter();
    const route = await resolveAcquireRoute({
      chainId: 1, pub,
      l1: { feeJuiceAddress: ASSET, feeJuicePortalAddress: PORTAL, feeAssetHandlerAddress: HANDLER },
    });
    expect(route.kind).toBe('mint');
    // Quoting a faucet network would be a pointless RPC round trip on a path
    // every new player walks.
    expect((pub as unknown as { simulateContract: { mock: { calls: unknown[] } } })
      .simulateContract.mock.calls).toHaveLength(0);
  });

  it('prices the target amount and sends a buffer above it', async () => {
    const route = await resolveAcquireRoute({
      chainId: 1, pub: linearQuoter(), quoterAddress: QUOTER, ethBuffer: 0.03,
      l1: { feeJuiceAddress: ASSET, feeJuicePortalAddress: PORTAL },
    });
    if (route.kind !== 'swap') throw new Error('expected a swap');
    // 1:1 pool, so the ETH sent is the target plus the 3% buffer.
    expect(route.ethIn).toBe((DEFAULT_FEE_JUICE_TARGET * 10_300n) / 10_000n);
    // ...and the floor is quoted from THAT amount, not rescaled from the target.
    expect(route.quotedOut).toBe(route.ethIn);
    expect(route.poolFee).toBe(3000);
  });

  it('honours an explicit target', async () => {
    const route = await resolveAcquireRoute({
      chainId: 1, pub: linearQuoter(), quoterAddress: QUOTER, ethBuffer: 0,
      target: 5n * 10n ** 17n,
      l1: { feeJuiceAddress: ASSET, feeJuicePortalAddress: PORTAL },
    });
    if (route.kind !== 'swap') throw new Error('expected a swap');
    expect(route.ethIn).toBe(5n * 10n ** 17n);
  });

  it('fails loudly when the pair has no pool, rather than swapping blind', async () => {
    const dead = { simulateContract: vi.fn(async () => { throw new Error('execution reverted'); }) } as never;
    await expect(resolveAcquireRoute({
      chainId: 1, pub: dead, quoterAddress: QUOTER,
      l1: { feeJuiceAddress: ASSET, feeJuicePortalAddress: PORTAL },
    })).rejects.toThrow(/No Uniswap V3 pool with liquidity/);
  });

  it('refuses an unknown chain even with a quoter, since the router is unknown', async () => {
    await expect(resolveAcquireRoute({
      chainId: 31337, pub: linearQuoter(), quoterAddress: QUOTER,
      l1: { feeJuiceAddress: ASSET, feeJuicePortalAddress: PORTAL },
    })).rejects.toThrow(/No Fee Juice route for chain 31337/);
  });
});
