/**
 * InstrumentedWallet
 *
 * Subclasses @aztec/wallets/embedded's EmbeddedWallet and overrides sendTx
 * so every transaction emits phase-by-phase progress events
 * (simulating → proving → sending → mining → complete/error) with real
 * wall-clock durations and — where the SDK exposes them — per-function
 * witgen breakdowns and proving stats.
 *
 * Port of gregojuice/packages/embedded-wallet/src/embedded-wallet.ts
 * adapted to the v4.2.0-nightly.20260323 SDK shape:
 *   - completeFeeOptionsForEstimation(from, feePayer, gasSettings) for the
 *     pre-simulation gas estimation pass
 *   - simulateViaEntrypoint takes `scopes` (computed via scopesFrom),
 *     not `additionalScopes`
 *   - completeFeeOptions(from, feePayer, gasSettings) is called a second
 *     time after authwit collection + gas estimation to produce the
 *     production fee options that proveTx uses
 */

import { EmbeddedWallet as EmbeddedWalletBase, type EmbeddedWalletOptions } from '@aztec/wallets/embedded';
import type { AztecNode } from '@aztec/aztec.js/node';
import {
  extractOffchainOutput,
  getGasLimits,
  NO_WAIT,
  type InteractionWaitOptions,
  type SendReturn,
} from '@aztec/aztec.js/contracts';
import { waitForTx } from '@aztec/aztec.js/node';
import type { SendOptions } from '@aztec/aztec.js/wallet';
import { CallAuthorizationRequest } from '@aztec/aztec.js/authorization';
import {
  collectOffchainEffects,
  type ExecutionPayload,
  TxStatus,
} from '@aztec/stdlib/tx';
import { GasSettings } from '@aztec/stdlib/gas';

import { txProgress, type PhaseTiming, type TxProgressEvent } from './txProgress';

export class InstrumentedWallet extends EmbeddedWalletBase {
  static override create<T extends EmbeddedWalletBase = InstrumentedWallet>(
    nodeOrUrl: string | AztecNode,
    options?: EmbeddedWalletOptions,
  ): Promise<T> {
    return super.create<T>(nodeOrUrl, options);
  }

  override async sendTx<W extends InteractionWaitOptions = undefined>(
    executionPayload: ExecutionPayload,
    opts: SendOptions<W>,
  ): Promise<SendReturn<W>> {
    const txId = crypto.randomUUID();
    const startTime = Date.now();
    const phases: PhaseTiming[] = [];
    const self = this as unknown as Record<string, any>;

    const fnName = (executionPayload.calls?.[0] as { name?: string })?.name ?? 'Transaction';
    const label = fnName.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

    const emit = (
      phase: TxProgressEvent['phase'],
      extra?: Partial<TxProgressEvent>,
    ) => {
      txProgress.emit({
        txId,
        label,
        phase,
        startTime,
        phaseStartTime: Date.now(),
        phases: [...phases],
        ...extra,
      });
    };

    try {
      // ── Pre-simulation gas estimation fee options ───────────────────
      const estFeeOptions = await self.completeFeeOptionsForEstimation(
        opts.from,
        executionPayload.feePayer,
        opts.fee?.gasSettings,
      );

      emit('simulating');
      const simStart = Date.now();
      const simulationResult = await self.simulateViaEntrypoint(executionPayload, {
        from: opts.from,
        feeOptions: estFeeOptions,
        scopes: self.scopesFrom(opts.from, opts.additionalScopes),
        skipTxValidation: true,
        skipFeeEnforcement: true,
      });
      const simElapsed = Date.now() - simStart;

      const offchainEffects = collectOffchainEffects(simulationResult.privateExecutionResult) ?? [];
      const authWitStart = Date.now();
      const authWitnesses = await Promise.all(
        offchainEffects.map(async (effect) => {
          try {
            const authRequest = await CallAuthorizationRequest.fromFields(effect.data);
            return self.createAuthWit(authRequest.onBehalfOf, {
              consumer: effect.contractAddress,
              innerHash: authRequest.innerHash,
            });
          } catch {
            return undefined;
          }
        }),
      );
      const authWitDuration = Date.now() - authWitStart;
      for (const wit of authWitnesses) {
        if (wit && (executionPayload as any).authWitnesses) {
          (executionPayload as any).authWitnesses.push(wit);
        }
      }
      const simulationDuration = simElapsed + authWitDuration;

      // ── Build sim-phase breakdown from SDK stats ────────────────────
      const simStats = simulationResult.stats;
      const breakdown: Array<{ label: string; duration: number }> = [];
      const details: string[] = [];
      if (simStats?.timings) {
        const t = simStats.timings;
        const prepareDuration = simElapsed - (t.total ?? 0);
        if (prepareDuration > 10) breakdown.push({ label: 'Prepare', duration: prepareDuration });
        if (t.sync && t.sync > 0) breakdown.push({ label: 'Sync', duration: t.sync });
        if (Array.isArray(t.perFunction) && t.perFunction.length > 0) {
          const witgenTotal = t.perFunction.reduce(
            (sum: number, fn: { time: number }) => sum + fn.time, 0,
          );
          breakdown.push({ label: 'Private execution', duration: witgenTotal });
          for (const fn of t.perFunction) {
            const short = fn.functionName.split(':').pop() || fn.functionName;
            breakdown.push({ label: `  ${short}`, duration: fn.time });
          }
        }
        if (t.publicSimulation) breakdown.push({ label: 'Public simulation', duration: t.publicSimulation });
        if (t.unaccounted && t.unaccounted > 0) breakdown.push({ label: 'Other', duration: t.unaccounted });
      }
      if (authWitDuration > 0) breakdown.push({ label: 'Auth witnesses', duration: authWitDuration });
      if (simStats?.nodeRPCCalls?.roundTrips) {
        const rt = simStats.nodeRPCCalls.roundTrips;
        const fmt = (ms: number) => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);
        details.push(`${rt.roundTrips} RPC round-trips (${fmt(rt.totalBlockingTime)} blocking)`);
      }
      phases.push({
        name: 'Simulation',
        duration: simulationDuration,
        color: '#ce93d8',
        ...(breakdown.length > 0 && { breakdown }),
        ...(details.length > 0 && { details }),
      });

      // ── Compute production gas settings + fee options ────────────────
      const estimated = getGasLimits(simulationResult, self.estimatedGasPadding ?? 0.1);
      const gasSettings = GasSettings.from({
        ...opts.fee?.gasSettings,
        maxFeesPerGas: estFeeOptions.gasSettings.maxFeesPerGas,
        maxPriorityFeesPerGas: estFeeOptions.gasSettings.maxPriorityFeesPerGas,
        gasLimits: opts.fee?.gasSettings?.gasLimits ?? estimated.gasLimits,
        teardownGasLimits: opts.fee?.gasSettings?.teardownGasLimits ?? estimated.teardownGasLimits,
      });
      const prodFeeOptions = await self.completeFeeOptions(
        opts.from,
        executionPayload.feePayer,
        gasSettings,
      );

      // ── Prove ────────────────────────────────────────────────────────
      emit('proving');
      const provingStart = Date.now();
      const txRequest = await self.createTxExecutionRequestFromPayloadAndFee(
        executionPayload,
        opts.from,
        prodFeeOptions,
      );
      const provenTx = await self.pxe.proveTx(
        txRequest,
        self.scopesFrom(opts.from, opts.additionalScopes),
      );
      const provingDuration = Date.now() - provingStart;

      const provingStats = provenTx.stats;
      if (provingStats?.timings) {
        const t = provingStats.timings;
        if (t.sync && t.sync > 0) phases.push({ name: 'Sync', duration: t.sync, color: '#90caf9' });
        if (Array.isArray(t.perFunction) && t.perFunction.length > 0) {
          const witgenTotal = t.perFunction.reduce(
            (sum: number, fn: { time: number }) => sum + fn.time, 0,
          );
          phases.push({
            name: 'Witgen',
            duration: witgenTotal,
            color: '#ffb74d',
            breakdown: t.perFunction.map((fn: { functionName: string; time: number }) => ({
              label: fn.functionName.split(':').pop() || fn.functionName,
              duration: fn.time,
            })),
          });
        }
        if (t.proving && t.proving > 0) {
          phases.push({ name: 'Proving', duration: t.proving, color: '#f48fb1' });
        }
        if (t.unaccounted && t.unaccounted > 0) {
          phases.push({ name: 'Other', duration: t.unaccounted, color: '#bdbdbd' });
        }
      } else {
        phases.push({ name: 'Proving', duration: provingDuration, color: '#f48fb1' });
      }

      // ── Send ─────────────────────────────────────────────────────────
      const offchainOutput = extractOffchainOutput(
        provenTx.getOffchainEffects(),
        provenTx.publicInputs.constants.anchorBlockHeader.globalVariables.timestamp,
      );

      const tx = await provenTx.toTx();
      const txHash = tx.getTxHash();
      emit('sending', { aztecTxHash: txHash.toString() });
      const sendingStart = Date.now();
      if (await self.aztecNode.getTxEffect(txHash)) {
        throw new Error(`A settled tx with equal hash ${txHash.toString()} exists.`);
      }
      await self.aztecNode.sendTx(tx);
      phases.push({ name: 'Sending', duration: Date.now() - sendingStart, color: '#2196f3' });

      if ((opts.wait as unknown) === NO_WAIT) {
        emit('complete');
        return { txHash, ...offchainOutput } as unknown as SendReturn<W>;
      }

      // ── Mine ─────────────────────────────────────────────────────────
      emit('mining');
      const miningStart = Date.now();
      const waitOpts = typeof opts.wait === 'object' ? opts.wait : undefined;
      const receipt = await waitForTx(self.aztecNode, txHash, {
        ...waitOpts,
        waitForStatus: TxStatus.PROPOSED,
      });
      phases.push({ name: 'Mining', duration: Date.now() - miningStart, color: '#4caf50' });

      emit('complete');
      return { receipt, ...offchainOutput } as unknown as SendReturn<W>;
    } catch (err) {
      emit('error', { error: err instanceof Error ? err.message : 'Transaction failed' });
      throw err;
    }
  }
}
