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
 * adapted to the 4.3.1 SDK shape (mirrors EmbeddedWallet.sendTx +
 * BaseWallet.sendTx with timing emits inserted):
 *   - ONE completeFeeOptions({ from, feePayer, gasSettings, forEstimation })
 *     config object — the separate completeFeeOptionsForEstimation is gone;
 *     called again without `forEstimation` for the production pass
 *   - simulateViaEntrypoint takes `additionalScopes` (scopesFrom is applied
 *     inside it) and `sendMessagesAs`
 *   - pxe.proveTx takes an options object { scopes, senderForTags }
 *   - waitForTx defaults waitForStatus to PROPOSED unless the caller set one
 */

import { EmbeddedWallet as EmbeddedWalletBase, type EmbeddedWalletOptions } from '@aztec/wallets/embedded';
import type { AztecNode } from '@aztec/aztec.js/node';
import {
  extractOffchainOutput,
  NO_WAIT,
  type InteractionWaitOptions,
  type SendReturn,
} from '@aztec/aztec.js/contracts';
// v5: getGasLimits moved from @aztec/aztec.js/contracts to @aztec/wallet-sdk/base-wallet
// and now takes (gasUsed, maxTxGasLimits, pad) instead of (simulationResult, pad).
import { getGasLimits } from '@aztec/wallet-sdk/base-wallet';
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
import { startNodeKeepalive } from './nodeKeepalive';

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
      const estFeeOptions = await self.completeFeeOptions({
        from: opts.from,
        feePayer: executionPayload.feePayer,
        gasSettings: opts.fee?.gasSettings,
        forEstimation: true,
      });

      emit('simulating');
      const simStart = Date.now();
      const simulationResult = await self.simulateViaEntrypoint(executionPayload, {
        from: opts.from,
        feeOptions: estFeeOptions,
        additionalScopes: opts.additionalScopes,
        skipTxValidation: true,
        sendMessagesAs: (opts as { sendMessagesAs?: unknown }).sendMessagesAs,
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
        if (wit) {
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
      const maxTxGasLimits = await self.getMaxTxGasLimits();
      const estimated = getGasLimits(simulationResult.gasUsed, maxTxGasLimits, self.estimatedGasPadding);
      const gasSettings = GasSettings.from({
        ...opts.fee?.gasSettings,
        maxFeesPerGas: estFeeOptions.gasSettings.maxFeesPerGas,
        maxPriorityFeesPerGas: estFeeOptions.gasSettings.maxPriorityFeesPerGas,
        gasLimits: opts.fee?.gasSettings?.gasLimits ?? estimated.gasLimits,
        teardownGasLimits: opts.fee?.gasSettings?.teardownGasLimits ?? estimated.teardownGasLimits,
      });
      const prodFeeOptions = await self.completeFeeOptions({
        from: opts.from,
        feePayer: executionPayload.feePayer,
        gasSettings,
      });

      // ── Prove ────────────────────────────────────────────────────────
      // The proof is CPU-pinned for 1–3 min and sends NO node requests, so the
      // node's HTTP/2 connection would idle-drop (net::ERR_CONNECTION_RESET on
      // the send below, ~30% of deploys). Keep it warm with a periodic
      // lightweight read for the whole proving window — prevention, not a retry.
      // (`await proveTx` yields the main thread to bb.js workers, so the
      // keepalive timer still fires.)
      emit('proving');
      const provingStart = Date.now();
      const stopKeepalive = startNodeKeepalive(self.aztecNode);
      let provenTx: any;
      try {
        const txRequest = await self.createTxExecutionRequestFromPayloadAndFee(
          executionPayload,
          opts.from,
          prodFeeOptions,
        );
        provenTx = await self.pxe.proveTx(txRequest, {
          scopes: self.scopesFrom(opts.from, opts.additionalScopes),
          senderForTags: self.senderForTagsFrom(opts.from, (opts as { sendMessagesAs?: unknown }).sendMessagesAs),
        });
      } finally {
        stopKeepalive();
      }
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
        waitForStatus: (waitOpts as { waitForStatus?: TxStatus } | undefined)?.waitForStatus ?? TxStatus.PROPOSED,
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
