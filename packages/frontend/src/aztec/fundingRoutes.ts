/**
 * Which route a chain uses to acquire the Fee Juice asset.
 *
 * The rule is deliberately not "am I on testnet": it is "does this deployment
 * expose a free mint". The node tells us — `feeAssetHandlerAddress` is only
 * present where the fee asset is a mock. On mainnet it is absent and the only
 * way to get the asset is to buy it, which is exactly the behaviour we want and
 * exactly the code path we cannot fake locally.
 */
import type { AcquireRoute, L1Addresses } from './l1Funding.js';
import type { PoolKey } from './uniswapQuote.js';
import type { Address } from 'viem';

/**
 * Uniswap Universal Router, per chain — the entry point for v4 swaps.
 *
 * No WETH here: v4 treats native ETH as a currency in its own right, so the fee
 * asset is bought with ETH directly and there is nothing to wrap or approve on
 * the way in.
 */
const UNISWAP: Record<number, { router: Address }> = {
  1: { router: '0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af' },
};

export interface RouteInputs {
  chainId: number;
  l1: L1Addresses;
  /** How much ETH the player spends on Fee Juice. */
  ethIn: bigint;
  /** Fee-asset output quoted for `ethIn`. Required for a swap. */
  quotedOut?: bigint;
  /** The exact pool, from the quoter. v4 has no factory to look one up. */
  poolKey?: PoolKey;
  zeroForOne?: boolean;
  maxSlippage?: number;
  /** Overrides for a chain not in the table, or a router that moves. */
  overrides?: Partial<{ router: Address }>;
}

/**
 * Choose the route, or explain why there isn't one.
 *
 * Throwing here is better than a half-configured swap: a router address that is
 * wrong for the chain will still accept a transaction and take the ETH.
 */
export function chooseAcquireRoute(input: RouteInputs): AcquireRoute {
  if (input.l1.feeAssetHandlerAddress) return { kind: 'mint' };

  const known = UNISWAP[input.chainId];
  const router = input.overrides?.router ?? known?.router;
  if (!router) {
    throw new Error(
      `No Fee Juice route for chain ${input.chainId}: it has no fee-asset faucet and no ` +
      `configured Universal Router. Set the router address for this chain.`,
    );
  }
  if (input.quotedOut === undefined || input.quotedOut <= 0n) {
    throw new Error(
      'A swap needs a quote. Fetch the expected output from the router quoter first — ' +
      'swapping without a minimum output invites a sandwich for the full amount.',
    );
  }
  if (input.ethIn <= 0n) throw new Error('ethIn must be greater than zero');

  if (!input.poolKey) {
    throw new Error('A v4 swap needs the pool key the quote came from — there is no factory to look one up.');
  }

  return {
    kind: 'swap',
    router,
    poolKey: input.poolKey,
    zeroForOne: input.zeroForOne ?? true,
    ethIn: input.ethIn,
    quotedOut: input.quotedOut,
    maxSlippage: input.maxSlippage ?? 0.02,
  };
}

/** True when the player must pay real value — i.e. we should show a price first. */
export function routeCostsRealMoney(route: AcquireRoute): boolean {
  return route.kind === 'swap';
}

/**
 * How much Fee Juice a new player needs to get through onboarding and a game.
 *
 * On a mock-asset network the faucet decides this for us — testnet's mints 1e21
 * — so this number only governs the mainnet swap route, where the player is
 * buying it. It used to be 1e18, named as a plausible round number.
 *
 * Measured instead. Eight throwaway accounts from real production runs, read
 * off the FeeJuice balances map with `scripts/fee-juice-used.ts`, come out
 * cleanly bimodal:
 *
 *   deploy + create_game + play, no settlement   4.217 – 4.343e18   (4 accounts)
 *   the same, plus settling the game             6.676 – 6.751e18   (4 accounts)
 *
 * So onboarding and one game is ~4.3e18, settlement adds ~2.4e18, and 1e18
 * would not have covered the account deployment — a player would have run dry
 * before their first move, which is precisely the failure this constant exists
 * to prevent, since they cannot buy more without leaving the app.
 *
 * 50e18 is onboarding plus roughly five settled games (~28e18) with about 75%
 * headroom for a busier fee market. Erring high is the cheap direction: the
 * cost of too much is that the player bought Fee Juice they did not need yet,
 * and the cost of too little is a game they cannot finish.
 *
 * Measured on testnet's fee market. Re-measure before mainnet — the script
 * takes an address and needs no keys.
 */
export const DEFAULT_FEE_JUICE_TARGET = 50n * 10n ** 18n;

export interface ResolveInputs extends Omit<RouteInputs, 'ethIn' | 'quotedOut' | 'poolKey' | 'zeroForOne'> {
  /** Reads quotes. Must be connected to `chainId`. */
  pub: PublicClientLike;
  /** Fee-asset units to end up with. Defaults to DEFAULT_FEE_JUICE_TARGET. */
  target?: bigint;
  /** Extra ETH sent above the quote so a moving price still fills. */
  ethBuffer?: number;
  quoterAddress?: Address;
  poolShapes?: readonly { fee: number; tickSpacing: number }[];
}

/** Structural, so tests and Node callers do not need a full viem PublicClient. */
type PublicClientLike = Parameters<typeof import('./uniswapQuote.js')['quoteExactInput']>[0]['pub'];

/**
 * Decide the route AND price it, hitting the chain when money is involved.
 *
 * Split from `chooseAcquireRoute` so the decision stays pure and testable while
 * the quoting — the part that needs a live pool — happens in one place that
 * every caller shares.
 */
export async function resolveAcquireRoute(input: ResolveInputs): Promise<AcquireRoute> {
  if (input.l1.feeAssetHandlerAddress) return { kind: 'mint' };

  const { quoterFor, quoteExactInput, quoteExactOutput, NATIVE } = await import('./uniswapQuote.js');
  const quoter = quoterFor(input.chainId, input.quoterAddress);
  const target = input.target ?? DEFAULT_FEE_JUICE_TARGET;
  const common = {
    pub: input.pub, quoter,
    tokenIn: NATIVE, tokenOut: input.l1.feeJuiceAddress,
    poolShapes: input.poolShapes,
  };

  // Price the amount we actually want, so the player sees the real cost...
  const out = await quoteExactOutput({ ...common, amountOut: target });

  // ...then send a little more than that, because an exact-input swap sized to
  // an exact-output quote fills only if the price has not moved at all.
  const bufferBps = BigInt(Math.round(((input.ethBuffer ?? 0.03) + 1) * 10_000));
  const ethIn = (out.amount * bufferBps) / 10_000n;

  // The floor comes from quoting the amount we will genuinely send, in the pool
  // we will genuinely use — not from rescaling the exact-output quote.
  const inQuote = await quoteExactInput({
    ...common, amountIn: ethIn,
    poolShapes: [{ fee: out.poolKey.fee, tickSpacing: out.poolKey.tickSpacing }],
  });

  return chooseAcquireRoute({
    ...input, ethIn, quotedOut: inQuote.amount,
    poolKey: inQuote.poolKey, zeroForOne: inQuote.zeroForOne,
  });
}
