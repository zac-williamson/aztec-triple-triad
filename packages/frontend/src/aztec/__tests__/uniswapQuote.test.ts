/**
 * Quoting decides how much of somebody's ETH to spend, so its failure modes
 * matter more than its happy path: probing a pool shape that does not exist, or
 * quietly returning a default when every shape is dead, both end with a swap
 * into nothing.
 *
 * The pool-key construction is tested here too, because in v4 an incorrect key
 * is not an error — it hashes to a poolId that simply has no pool behind it.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  quoteExactInput, quoteExactOutput, quoterFor, poolKeyFor, poolIdFor,
  DEFAULT_POOL_SHAPES, NATIVE,
} from '../uniswapQuote';

const QUOTER = '0x00000000000000000000000000000000000000a1' as const;
const ASSET = '0x00000000000000000000000000000000000000c1' as const;

/** A quoter that answers only for the fees in `pools`, like a real one. */
function fakeQuoter(pools: Record<number, bigint>) {
  return {
    simulateContract: vi.fn(async ({ args }: { args: readonly { poolKey: { fee: number } }[] }) => {
      const fee = args[0].poolKey.fee;
      if (!(fee in pools)) throw new Error('execution reverted');
      return { result: [pools[fee], 0n] };
    }),
  } as never;
}

describe('quoterFor', () => {
  it('refuses a chain it has no quoter for', () => {
    expect(() => quoterFor(31337)).toThrow(/No Uniswap v4 quoter configured/);
  });
  it('accepts an explicit override for an unlisted chain', () => {
    expect(quoterFor(31337, QUOTER)).toBe(QUOTER);
  });
});

describe('poolKeyFor', () => {
  it('sorts currencies by address, so native ETH is always currency0', () => {
    const key = poolKeyFor(NATIVE, ASSET, 10000, 200);
    expect(key.currency0).toBe(NATIVE);
    expect(key.currency1).toBe(ASSET);
  });

  it('produces the same key whichever order the pair is given in', () => {
    // Two callers naming the same pool must derive the same poolId, or one of
    // them trades against a pool that does not exist.
    expect(poolIdFor(poolKeyFor(NATIVE, ASSET, 10000, 200)))
      .toBe(poolIdFor(poolKeyFor(ASSET, NATIVE, 10000, 200)));
  });

  it('changes the pool id when any key field changes', () => {
    const base = poolIdFor(poolKeyFor(NATIVE, ASSET, 10000, 200));
    expect(poolIdFor(poolKeyFor(NATIVE, ASSET, 3000, 200))).not.toBe(base);
    expect(poolIdFor(poolKeyFor(NATIVE, ASSET, 10000, 60))).not.toBe(base);
    expect(poolIdFor(poolKeyFor(NATIVE, ASSET, 10000, 200, ASSET))).not.toBe(base);
  });
});

describe('quoteExactInput', () => {
  const common = { quoter: QUOTER, tokenIn: NATIVE, tokenOut: ASSET } as const;

  it('picks the pool that returns the most for the same input', async () => {
    const pub = fakeQuoter({ 500: 100n, 3000: 250n, 10000: 90n });
    const q = await quoteExactInput({ ...common, pub, amountIn: 10n });
    expect(q.amount).toBe(250n);
    expect(q.poolKey.fee).toBe(3000);
  });

  it('reports the direction implied by the sorted key', async () => {
    const pub = fakeQuoter({ 10000: 7n });
    const q = await quoteExactInput({ ...common, pub, amountIn: 10n });
    // Spending native ETH, which sorts first, so we go 0 -> 1.
    expect(q.zeroForOne).toBe(true);
  });

  it('ignores shapes with no pool rather than failing', async () => {
    const pub = fakeQuoter({ 10000: 7n });
    const q = await quoteExactInput({ ...common, pub, amountIn: 10n });
    expect(q.poolKey.tickSpacing).toBe(200);
  });

  it('throws when no shape has liquidity, instead of returning a default', async () => {
    await expect(quoteExactInput({ ...common, pub: fakeQuoter({}), amountIn: 10n }))
      .rejects.toThrow(/No Uniswap v4 pool with fillable liquidity/);
  });

  it('treats a zero quote as no pool — it would floor the swap at nothing', async () => {
    await expect(quoteExactInput({ ...common, pub: fakeQuoter({ 500: 0n }), amountIn: 10n }))
      .rejects.toThrow(/No Uniswap v4 pool with fillable liquidity/);
  });

  it('probes every configured shape', async () => {
    const pub = fakeQuoter({ 3000: 1n });
    await quoteExactInput({ ...common, pub, amountIn: 10n });
    expect((pub as unknown as { simulateContract: { mock: { calls: unknown[] } } })
      .simulateContract.mock.calls).toHaveLength(DEFAULT_POOL_SHAPES.length);
  });
});

describe('quoteExactOutput', () => {
  it('picks the pool that costs the least for the same output', async () => {
    const pub = fakeQuoter({ 500: 100n, 3000: 40n, 10000: 900n });
    const q = await quoteExactOutput({
      pub, quoter: QUOTER, tokenIn: NATIVE, tokenOut: ASSET, amountOut: 10n,
    });
    expect(q.amount).toBe(40n);
    expect(q.poolKey.fee).toBe(3000);
  });
});
