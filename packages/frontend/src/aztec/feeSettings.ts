/**
 * Fee headroom for transaction sends.
 *
 * The L2 base fee (`getCurrentMinFees().feePerL2Gas`) rises with network
 * demand. The wallet's default fee path sets `maxFeesPerGas` to the base fee
 * times a tiny `minFeePadding`, so a tx whose `maxFeesPerGas` was computed
 * against a momentarily-low base fee REJECTS when the base fee climbs before
 * the tx lands (observed in the 4.3.1 playtest:
 * `maxFeesPerGas.feePerL2Gas=21600000 < gasFees.feePerL2Gas`). The proving
 * step alone takes several seconds, which is plenty of time for the base fee
 * to move, so every send needs real headroom.
 *
 * Fix: set `maxFeesPerGas = currentBaseFee × FEE_HEADROOM_MULTIPLIER` on every
 * tx send path. The wallet's `completeFeeOptions` honors a caller-provided
 * `gasSettings.maxFeesPerGas` and only falls back to the no-headroom estimate
 * when it is absent.
 *
 * `FEE_HEADROOM_MULTIPLIER` is the CANONICAL value — Lane 1's deploy scripts
 * (`scripts/deploy-*.ts`) must use the same multiplier so on-chain and in-app
 * txs share one fee policy.
 */

import type { GasFees } from '@aztec/stdlib/gas';

/** Multiplier applied to the current L2 base fee to set `maxFeesPerGas`. */
export const FEE_HEADROOM_MULTIPLIER = 3;

/** Minimal node surface the helpers need (an `AztecNode` satisfies this). */
export interface BaseFeeNode {
  getCurrentMinFees(): Promise<GasFees>;
}

/** Current L2 base fee scaled by {@link FEE_HEADROOM_MULTIPLIER}. */
export async function maxFeesPerGasWithHeadroom(node: BaseFeeNode): Promise<GasFees> {
  const baseFees = await node.getCurrentMinFees();
  return baseFees.mul(FEE_HEADROOM_MULTIPLIER);
}

/**
 * The `gasSettings` fragment for a `.send({ fee })` — a partial
 * `Partial<FieldsOf<GasSettings>>` carrying only `maxFeesPerGas`; the wallet
 * fills `gasLimits`/`teardownGasLimits`/`maxPriorityFeesPerGas` from gas
 * estimation. Usage:
 *
 *   .send({ from, fee: { gasSettings: await gasSettingsWithHeadroom(node) }, wait })
 *   .send({ from, fee: { paymentMethod, gasSettings: await gasSettingsWithHeadroom(node) }, wait })
 */
export async function gasSettingsWithHeadroom(node: BaseFeeNode): Promise<{ maxFeesPerGas: GasFees }> {
  return { maxFeesPerGas: await maxFeesPerGasWithHeadroom(node) };
}
