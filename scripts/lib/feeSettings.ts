/**
 * L2 fee headroom for the deploy/fund scripts.
 *
 * SOURCE OF TRUTH: packages/frontend/src/aztec/feeSettings.ts (lane-2). Scripts
 * cannot import frontend/src, so this REPLICATES the same idiom and multiplier.
 * The two MUST stay in sync — coordinate any change to FEE_HEADROOM_MULTIPLIER or
 * the base-fee source with lane-2 to avoid divergence.
 *
 * The bug it fixes: the stock wallet caps maxFeesPerGas at
 *   getCurrentMinFees() * (1 + minFeePadding)   // minFeePadding defaults to 0.5
 * i.e. 1.5x the *current* L2 min fee. When the L2 base fee rises between fee
 * estimation and tx inclusion by more than that, the tx is rejected for an
 * under-priced max fee. We instead cap at a larger, explicit multiple of the
 * current min fee. maxFeesPerGas is only a CEILING — the tx still pays the actual
 * base fee at inclusion — so generous headroom costs nothing extra; it only needs
 * Fee Juice balance to cover the (maxFeesPerGas * gasLimit) reservation.
 *
 * Canonical computation (mirror this exactly in lane-2's helper):
 *   maxFeesPerGas = (await node.getCurrentMinFees()).mul(FEE_HEADROOM_MULTIPLIER)
 */

/**
 * Headroom multiplier over the current L2 min fee. 3x = double the stock 1.5x
 * default. Keep equal to lane-2's FEE_HEADROOM_MULTIPLIER.
 */
export const FEE_HEADROOM_MULTIPLIER = 3;

/** A GasFees-like value with a scalar `mul` (the SDK's GasFees). */
interface MulFees {
  mul(scalar: number | bigint): MulFees;
}

/** Minimal slice of the Aztec node client we depend on. */
interface MinFeesNode {
  getCurrentMinFees(): Promise<MulFees>;
}

/**
 * Returns a headroomed `maxFeesPerGas` (GasFees) for the CURRENT L2 base fee.
 * Pass it as `fee.gasSettings.maxFeesPerGas` — the wallet's completeFeeOptions
 * respects a caller-supplied maxFeesPerGas (`gasSettings?.maxFeesPerGas ?? ...`),
 * so this overrides the stock 1.5x default. Compute it fresh per tx so each tx
 * is sized against the latest base fee.
 */
export async function headroomMaxFeesPerGas<T extends MulFees>(node: { getCurrentMinFees(): Promise<T> }): Promise<T> {
  const minFees = await node.getCurrentMinFees();
  return minFees.mul(FEE_HEADROOM_MULTIPLIER) as T;
}

export type { MinFeesNode };
