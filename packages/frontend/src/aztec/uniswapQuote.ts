/**
 * Live Uniswap V3 quotes for the Fee Juice swap.
 *
 * The swap leg is the one part of onboarding that spends real money, so it is
 * the one part that must never run on a guess. Two things have to be true
 * before we ask a player to sign:
 *
 *   - we know which pool actually holds liquidity for this pair (a brand-new
 *     asset will not be on the tier you assume), and
 *   - we know what the trade returns, so the swap can carry a minimum output.
 *     Without one, anyone watching the mempool can sandwich the trade and take
 *     the whole amount.
 *
 * QuoterV2 answers both. It is not a view function — it executes the swap and
 * reverts — so it is called through `eth_call` (viem's `simulateContract`),
 * never sent.
 */
import { parseAbi, type Address, type PublicClient } from 'viem';

/** QuoterV2. Same address on mainnet and most L2s; overridable per chain. */
const QUOTER_V2: Record<number, Address> = {
  1: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
};

/** The tiers a new pair could plausibly live on, cheapest fee first. */
export const DEFAULT_FEE_TIERS = [500, 3000, 10000] as const;

const QUOTER_ABI = parseAbi([
  'struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }',
  'struct QuoteExactOutputSingleParams { address tokenIn; address tokenOut; uint256 amount; uint24 fee; uint160 sqrtPriceLimitX96; }',
  'function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
  'function quoteExactOutputSingle(QuoteExactOutputSingleParams params) returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);

export function quoterFor(chainId: number, override?: Address): Address {
  const quoter = override ?? QUOTER_V2[chainId];
  if (!quoter) {
    throw new Error(
      `No Uniswap quoter configured for chain ${chainId}. A swap cannot be priced, ` +
      `and swapping without a price is not something we will do with someone's ETH.`,
    );
  }
  return quoter;
}

export interface QuoteRequest {
  pub: PublicClient;
  quoter: Address;
  tokenIn: Address;
  tokenOut: Address;
  /** Tiers to probe. The best-priced one that has liquidity wins. */
  feeTiers?: readonly number[];
}

/** How much `tokenOut` comes back for an exact `amountIn`. */
export async function quoteExactInput(
  req: QuoteRequest & { amountIn: bigint },
): Promise<{ poolFee: number; amountOut: bigint }> {
  const results = await probe(req, tier =>
    req.pub.simulateContract({
      address: req.quoter, abi: QUOTER_ABI, functionName: 'quoteExactInputSingle',
      args: [{
        tokenIn: req.tokenIn, tokenOut: req.tokenOut,
        amountIn: req.amountIn, fee: tier, sqrtPriceLimitX96: 0n,
      }],
    }).then(r => (r.result as readonly bigint[])[0]),
  );
  // More output for the same input is strictly better.
  const best = results.reduce((a, b) => (b.value > a.value ? b : a));
  return { poolFee: best.tier, amountOut: best.value };
}

/** How much `tokenIn` it costs to receive an exact `amountOut`. */
export async function quoteExactOutput(
  req: QuoteRequest & { amountOut: bigint },
): Promise<{ poolFee: number; amountIn: bigint }> {
  const results = await probe(req, tier =>
    req.pub.simulateContract({
      address: req.quoter, abi: QUOTER_ABI, functionName: 'quoteExactOutputSingle',
      args: [{
        tokenIn: req.tokenIn, tokenOut: req.tokenOut,
        amount: req.amountOut, fee: tier, sqrtPriceLimitX96: 0n,
      }],
    }).then(r => (r.result as readonly bigint[])[0]),
  );
  // Less input for the same output is strictly better.
  const best = results.reduce((a, b) => (b.value < a.value ? b : a));
  return { poolFee: best.tier, amountIn: best.value };
}

/**
 * Ask every tier and keep the ones that answered.
 *
 * A tier with no pool reverts; that is normal and not an error. All tiers
 * failing IS an error, and it has to say so plainly — the alternative is
 * falling through to a default tier and swapping into an empty pool.
 */
async function probe(
  req: QuoteRequest,
  ask: (tier: number) => Promise<bigint>,
): Promise<Array<{ tier: number; value: bigint }>> {
  const tiers = req.feeTiers ?? DEFAULT_FEE_TIERS;
  const settled = await Promise.all(tiers.map(async tier => {
    try {
      const value = await ask(tier);
      return value > 0n ? { tier, value } : null;
    } catch {
      return null; // no pool at this tier, or not enough liquidity to fill
    }
  }));
  const live = settled.filter((r): r is { tier: number; value: bigint } => r !== null);
  if (live.length === 0) {
    throw new Error(
      `No Uniswap V3 pool with liquidity for ${req.tokenIn} -> ${req.tokenOut} on any of ` +
      `the ${tiers.join(', ')} fee tiers. Fee Juice cannot be bought on this chain yet.`,
    );
  }
  return live;
}
