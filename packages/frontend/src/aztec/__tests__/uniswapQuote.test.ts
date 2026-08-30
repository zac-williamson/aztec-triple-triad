/**
 * Quoting is the step that decides how much of someone's ETH to spend, so its
 * failure modes matter more than its happy path: picking a tier with no
 * liquidity, or quietly returning a default when every tier is dead, both end
 * with a swap into an empty pool.
 */
import { describe, it, expect, vi } from 'vitest';
import { quoteExactInput, quoteExactOutput, quoterFor, DEFAULT_FEE_TIERS } from '../uniswapQuote';

const QUOTER = '0x00000000000000000000000000000000000000q1'.replace('q1', 'a1') as `0x${string}`;
const WETH = '0x00000000000000000000000000000000000000b1' as const;
const ASSET = '0x00000000000000000000000000000000000000c1' as const;

/** A quoter that answers only for the tiers in `pools`, like a real one. */
function fakeQuoter(pools: Record<number, bigint>) {
  return {
    simulateContract: vi.fn(async ({ args }: { args: readonly { fee: number }[] }) => {
      const tier = args[0].fee;
      if (!(tier in pools)) throw new Error('execution reverted');
      return { result: [pools[tier], 0n, 0, 0n] };
    }),
  } as never;
}

describe('quoterFor', () => {
  it('refuses a chain it has no quoter for', () => {
    expect(() => quoterFor(31337)).toThrow(/No Uniswap quoter configured/);
  });

  it('accepts an explicit override for an unlisted chain', () => {
    expect(quoterFor(31337, QUOTER)).toBe(QUOTER);
  });
});

describe('quoteExactInput', () => {
  it('picks the tier that returns the most for the same input', async () => {
    const pub = fakeQuoter({ 500: 100n, 3000: 250n, 10000: 90n });
    const q = await quoteExactInput({ pub, quoter: QUOTER, tokenIn: WETH, tokenOut: ASSET, amountIn: 10n });
    expect(q).toEqual({ poolFee: 3000, amountOut: 250n });
  });

  it('ignores tiers with no pool rather than failing', async () => {
    const pub = fakeQuoter({ 10000: 7n }); // only the exotic tier exists
    const q = await quoteExactInput({ pub, quoter: QUOTER, tokenIn: WETH, tokenOut: ASSET, amountIn: 10n });
    expect(q.poolFee).toBe(10000);
  });

  it('throws when no tier has liquidity, instead of returning a default', async () => {
    const pub = fakeQuoter({});
    await expect(quoteExactInput({ pub, quoter: QUOTER, tokenIn: WETH, tokenOut: ASSET, amountIn: 10n }))
      .rejects.toThrow(/No Uniswap V3 pool with liquidity/);
  });

  it('treats a zero quote as no pool — it would floor the swap at nothing', async () => {
    const pub = fakeQuoter({ 500: 0n });
    await expect(quoteExactInput({ pub, quoter: QUOTER, tokenIn: WETH, tokenOut: ASSET, amountIn: 10n }))
      .rejects.toThrow(/No Uniswap V3 pool with liquidity/);
  });

  it('probes every configured tier', async () => {
    const pub = fakeQuoter({ 3000: 1n });
    await quoteExactInput({ pub, quoter: QUOTER, tokenIn: WETH, tokenOut: ASSET, amountIn: 10n });
    expect((pub as unknown as { simulateContract: { mock: { calls: unknown[] } } }).simulateContract.mock.calls)
      .toHaveLength(DEFAULT_FEE_TIERS.length);
  });
});

describe('quoteExactOutput', () => {
  it('picks the tier that costs the least for the same output', async () => {
    const pub = fakeQuoter({ 500: 100n, 3000: 40n, 10000: 900n });
    const q = await quoteExactOutput({ pub, quoter: QUOTER, tokenIn: WETH, tokenOut: ASSET, amountOut: 10n });
    expect(q).toEqual({ poolFee: 3000, amountIn: 40n });
  });
});
