/**
 * Which route a chain uses to acquire the Fee Juice asset.
 *
 * The rule is deliberately not "am I on testnet": it is "does this deployment
 * expose a free mint". The node tells us — `feeAssetHandlerAddress` is only
 * present where the fee asset is a mock. On mainnet it is absent and the only
 * way to get the asset is to buy it, which is exactly the behaviour we want and
 * exactly the code path we cannot fake locally.
 */
import type { AcquireRoute, L1Addresses } from './l1Funding';
import type { Address } from 'viem';

/** Uniswap V3 SwapRouter02 and WETH9, per chain. */
const UNISWAP: Record<number, { router: Address; weth: Address }> = {
  1: {
    router: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  },
};

export interface RouteInputs {
  chainId: number;
  l1: L1Addresses;
  /** How much ETH the player spends on Fee Juice. */
  ethIn: bigint;
  /** Fee-asset output quoted for `ethIn`. Required for a swap. */
  quotedOut?: bigint;
  /** Pool fee tier; 0.3% is the usual starting pool for a new pair. */
  poolFee?: number;
  maxSlippage?: number;
  /** Overrides for a chain not in the table, or a pool that moves. */
  overrides?: Partial<{ router: Address; weth: Address }>;
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
  const weth = input.overrides?.weth ?? known?.weth;
  if (!router || !weth) {
    throw new Error(
      `No Fee Juice route for chain ${input.chainId}: it has no fee-asset faucet and no ` +
      `configured swap router. Set the router and WETH addresses for this chain.`,
    );
  }
  if (input.quotedOut === undefined || input.quotedOut <= 0n) {
    throw new Error(
      'A swap needs a quote. Fetch the expected output from the router quoter first — ' +
      'swapping without a minimum output invites a sandwich for the full amount.',
    );
  }
  if (input.ethIn <= 0n) throw new Error('ethIn must be greater than zero');

  return {
    kind: 'swap',
    router,
    weth,
    poolFee: input.poolFee ?? 3000,
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
 * On a mock-asset network the faucet decides this for us. On mainnet we have to
 * name a number, and it has to cover the account deployment plus the three
 * chain transactions a game costs, with headroom — a player who runs dry
 * mid-game cannot settle, and cannot buy more without leaving the app.
 */
export const DEFAULT_FEE_JUICE_TARGET = 10n ** 18n;

export interface ResolveInputs extends Omit<RouteInputs, 'ethIn' | 'quotedOut'> {
  /** Reads quotes. Must be connected to `chainId`. */
  pub: PublicClientLike;
  /** Fee-asset units to end up with. Defaults to DEFAULT_FEE_JUICE_TARGET. */
  target?: bigint;
  /** Extra ETH sent above the quote so a moving price still fills. */
  ethBuffer?: number;
  quoterAddress?: Address;
  feeTiers?: readonly number[];
}

/** Structural, so tests and Node callers do not need a full viem PublicClient. */
type PublicClientLike = Parameters<typeof import('./uniswapQuote')['quoteExactInput']>[0]['pub'];

/**
 * Decide the route AND price it, hitting the chain when money is involved.
 *
 * Split from `chooseAcquireRoute` so the decision stays pure and testable while
 * the quoting — the part that needs a live pool — happens in one place that
 * every caller shares.
 */
export async function resolveAcquireRoute(input: ResolveInputs): Promise<AcquireRoute> {
  if (input.l1.feeAssetHandlerAddress) return { kind: 'mint' };

  const { quoterFor, quoteExactInput, quoteExactOutput } = await import('./uniswapQuote');
  const quoter = quoterFor(input.chainId, input.quoterAddress);
  // Resolve the pair the same way chooseAcquireRoute will, so a router/WETH
  // misconfiguration fails before we spend a quote on it.
  const scaffold = chooseAcquireRoute({ ...input, ethIn: 1n, quotedOut: 1n });
  if (scaffold.kind !== 'swap') throw new Error('Unreachable: no handler yet not a swap');
  const { router, weth } = scaffold;

  const target = input.target ?? DEFAULT_FEE_JUICE_TARGET;
  const common = { pub: input.pub, quoter, feeTiers: input.feeTiers };

  // Price the amount we actually want, so the player sees the real cost...
  const { poolFee, amountIn } = await quoteExactOutput({
    ...common, tokenIn: weth, tokenOut: input.l1.feeJuiceAddress, amountOut: target,
  });

  // ...then send a little more than that, because an exact-input swap sized to
  // an exact-output quote fills only if the price has not moved at all.
  const bufferBps = BigInt(Math.round(((input.ethBuffer ?? 0.03) + 1) * 10_000));
  const ethIn = (amountIn * bufferBps) / 10_000n;

  // The floor comes from quoting the amount we will genuinely send, on the tier
  // we will genuinely use — not from rescaling the exact-output quote.
  const { amountOut } = await quoteExactInput({
    ...common, tokenIn: weth, tokenOut: input.l1.feeJuiceAddress,
    amountIn: ethIn, feeTiers: [poolFee],
  });

  return chooseAcquireRoute({ ...input, ethIn, quotedOut: amountOut, poolFee });
}
