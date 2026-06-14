/**
 * The single door to the PXE (IndexedDB-backed local state) for every contract
 * read and send.
 *
 * Ground rule #6: all PXE operations must be serialized per wallet — concurrent
 * simulate/send/proof races corrupt IndexedDB (`TransactionInactiveError`). This
 * module is the ONLY place allowed to touch a contract instance; everything goes
 * through `txManager`'s serial queue. Callers receive values, never contracts,
 * so the queue cannot be bypassed (enforced by the source-guard test).
 *
 * Each op has ONE implementation (inside `makeOps`); the injected `schedule`
 * decides whether it ENQUEUES (standalone `pxe.*` calls) or runs INLINE (inside
 * a `runPxeTx` body — already within a queue item, so re-enqueuing would
 * deadlock and would also break the one-item atomicity that settlement priority
 * + postEffects ordering depend on).
 */
import txManager from './txManager';
import type { TxType, TxPhase } from './txManager';

type Schedule = <T>(fn: () => Promise<T>) => Promise<T>;

// The wallet the contracts are bound to. Set on connect, cleared on disconnect.
// Owned here so no caller needs (or can capture) the raw wallet for PXE work.
let currentWallet: unknown = null;
export function setPxeWallet(wallet: unknown): void {
  currentWallet = wallet;
}

/** Resolve the (privately cached) contract instances for the current wallet. */
async function resolveContracts() {
  if (!currentWallet) throw new Error('PXE wallet not set — connect first');
  // Lazy import keeps the heavy aztec.js contract stack out of the initial
  // bundle. waitForWarmup reuses the pre-warmed Contract.at instances rather
  // than racing fresh ones (Safari IDB is strict).
  const { ensureContracts, waitForWarmup } = await import('./contracts');
  await waitForWarmup();
  return ensureContracts(currentWallet);
}

/**
 * Named PXE operations. ONE implementation each; `schedule` picks enqueue vs
 * inline. Add new reads/sends here as callers migrate off raw contracts.
 */
function makeOps(schedule: Schedule) {
  return {
    /** Private ARNA-token balance for `owner` (decimal-safe → bigint). */
    readTokenBalance: (owner: string): Promise<bigint> =>
      schedule(async () => {
        const { tokenContract, AztecAddress } = await resolveContracts();
        if (!tokenContract) throw new Error('token contract unavailable');
        const addr = AztecAddress.fromString(owner);
        const { result } = await tokenContract.methods.get_balance(addr).simulate({ from: addr });
        return BigInt(result.toString());
      }),
  };
}

export type PxeOps = ReturnType<typeof makeOps>;

/** Standalone facade: every op is enqueued on the serial PXE queue. */
export const pxe: PxeOps = makeOps((fn) => txManager.enqueuePxe(fn));

/** In-tx facade: ops run INLINE within the current queue item (no re-enqueue). */
const inlinePxe: PxeOps = makeOps((fn) => fn());

/**
 * Run a tracked transaction whose body uses the INLINE facade, so its reads and
 * its send execute as ONE atomic queue item (preserving settlement priority and
 * postEffects ordering). Use this instead of `txManager.runTx` for any tx body
 * that touches the PXE — the body never receives a raw contract.
 */
export function runPxeTx<T>(
  opts: {
    type: TxType;
    label: string;
    gameId?: string;
    postEffects?: (result: T) => Promise<void>;
  },
  body: (ops: PxeOps, setPhase: (phase: TxPhase) => void) => Promise<T>,
): Promise<T> {
  return txManager.runTx({ ...opts, execute: (setPhase) => body(inlinePxe, setPhase) });
}
