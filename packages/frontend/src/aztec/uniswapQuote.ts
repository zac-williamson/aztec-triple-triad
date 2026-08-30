/**
 * Live Uniswap **v4** quotes for the Fee Juice swap.
 *
 * v4, not v3, because that is where AZTEC actually trades. The token
 * (0xA27EC0…) launched into a Uniswap v4 pool; the v3 factory has nothing for
 * this pair, so a v3 integration would have found no pool at all on the one
 * network it was written for. Verified against mainnet: the ETH/AZTEC pool at
 * fee 10000 / tickSpacing 200 with no hooks quotes and fills, while the 500 and
 * 3000 tiers are initialised but hold no liquidity.
 *
 * Two structural differences from v3 matter here:
 *
 *   - A pool is identified by its full PoolKey (both currencies, fee,
 *     tickSpacing and hooks), hashed to a poolId. There is no factory lookup, so
 *     the tickSpacing has to be right, not merely plausible.
 *   - Native ETH is a first-class currency (address zero), so there is no WETH
 *     to wrap and no approval on the input side.
 *
 * The quoter is not a view function — it executes the swap and reverts with the
 * result — so it is always called through `eth_call`, never sent.
 */
import { parseAbi, encodeAbiParameters, keccak256, type Address, type PublicClient } from 'viem';

/** Native ETH, and the zero hooks address. Same value, different meanings. */
export const NATIVE = '0x0000000000000000000000000000000000000000' as const;

/** V4Quoter, per chain. */
const V4_QUOTER: Record<number, Address> = {
  1: '0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203',
};

/**
 * Pool shapes to probe, cheapest fee first.
 *
 * In v4 fee and tickSpacing are independent, so this is a list of real pairs
 * rather than the v3 fee→spacing mapping. The last entry is the one AZTEC
 * actually trades in today; the others are here so a migration to a tighter
 * pool needs no code change.
 */
export const DEFAULT_POOL_SHAPES: readonly { fee: number; tickSpacing: number }[] = [
  { fee: 100, tickSpacing: 1 },
  { fee: 500, tickSpacing: 10 },
  { fee: 3000, tickSpacing: 60 },
  { fee: 10000, tickSpacing: 200 },
];

const QUOTER_ABI = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
  'function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)',
  'function quoteExactOutputSingle(QuoteExactSingleParams params) returns (uint256 amountIn, uint256 gasEstimate)',
]);

export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

export function quoterFor(chainId: number, override?: Address): Address {
  const quoter = override ?? V4_QUOTER[chainId];
  if (!quoter) {
    throw new Error(
      `No Uniswap v4 quoter configured for chain ${chainId}. A swap cannot be priced, ` +
      `and swapping without a price is not something we will do with someone's ETH.`,
    );
  }
  return quoter;
}

/**
 * Currencies in a PoolKey are sorted by address, and native ETH (zero) sorts
 * first. Getting this wrong yields a different poolId — i.e. a pool that does
 * not exist — rather than an error, so it is done in exactly one place.
 */
export function poolKeyFor(
  tokenA: Address, tokenB: Address, fee: number, tickSpacing: number, hooks: Address = NATIVE,
): PoolKey {
  const [currency0, currency1] = tokenA.toLowerCase() < tokenB.toLowerCase()
    ? [tokenA, tokenB] : [tokenB, tokenA];
  return { currency0, currency1, fee, tickSpacing, hooks };
}

/** poolId = keccak256(abi.encode(PoolKey)) — what StateView and the hooks key on. */
export function poolIdFor(key: PoolKey): `0x${string}` {
  return keccak256(encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
    [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
  ));
}

export interface QuoteRequest {
  pub: PublicClient;
  quoter: Address;
  /** What is being spent. Use NATIVE for ETH. */
  tokenIn: Address;
  tokenOut: Address;
  poolShapes?: readonly { fee: number; tickSpacing: number }[];
  hooks?: Address;
}

export interface QuoteResult {
  poolKey: PoolKey;
  zeroForOne: boolean;
  amount: bigint;
}

/** How much `tokenOut` comes back for an exact `amountIn`. */
export async function quoteExactInput(
  req: QuoteRequest & { amountIn: bigint },
): Promise<QuoteResult> {
  const results = await probe(req, (key, zeroForOne) =>
    req.pub.simulateContract({
      address: req.quoter, abi: QUOTER_ABI, functionName: 'quoteExactInputSingle',
      args: [{ poolKey: key, zeroForOne, exactAmount: req.amountIn, hookData: '0x' }] as never,
    }).then(r => (r.result as readonly bigint[])[0]),
  );
  // More output for the same input is strictly better.
  return results.reduce((a, b) => (b.amount > a.amount ? b : a));
}

/** How much `tokenIn` it costs to receive an exact `amountOut`. */
export async function quoteExactOutput(
  req: QuoteRequest & { amountOut: bigint },
): Promise<QuoteResult> {
  const results = await probe(req, (key, zeroForOne) =>
    req.pub.simulateContract({
      address: req.quoter, abi: QUOTER_ABI, functionName: 'quoteExactOutputSingle',
      args: [{ poolKey: key, zeroForOne, exactAmount: req.amountOut, hookData: '0x' }] as never,
    }).then(r => (r.result as readonly bigint[])[0]),
  );
  // Less input for the same output is strictly better.
  return results.reduce((a, b) => (b.amount < a.amount ? b : a));
}

/**
 * Ask every pool shape and keep the ones that answered.
 *
 * An uninitialised pool, or one with no fillable liquidity, reverts — normal,
 * and not an error. Every shape failing IS an error: falling through to a
 * default would mean swapping into a pool that does not exist.
 */
async function probe(
  req: QuoteRequest,
  ask: (key: PoolKey, zeroForOne: boolean) => Promise<bigint>,
): Promise<QuoteResult[]> {
  const shapes = req.poolShapes ?? DEFAULT_POOL_SHAPES;
  const settled = await Promise.all(shapes.map(async ({ fee, tickSpacing }) => {
    const poolKey = poolKeyFor(req.tokenIn, req.tokenOut, fee, tickSpacing, req.hooks ?? NATIVE);
    // zeroForOne says which way through the pool we are going; it follows from
    // whether what we spend is currency0.
    const zeroForOne = poolKey.currency0.toLowerCase() === req.tokenIn.toLowerCase();
    try {
      const amount = await ask(poolKey, zeroForOne);
      return amount > 0n ? { poolKey, zeroForOne, amount } : null;
    } catch {
      return null;
    }
  }));
  const live = settled.filter((r): r is QuoteResult => r !== null);
  if (live.length === 0) {
    throw new Error(
      `No Uniswap v4 pool with fillable liquidity for ${req.tokenIn} -> ${req.tokenOut} in any of ` +
      `the probed shapes (${shapes.map(s => `${s.fee}/${s.tickSpacing}`).join(', ')}). ` +
      `Fee Juice cannot be bought on this chain yet.`,
    );
  }
  return live;
}
