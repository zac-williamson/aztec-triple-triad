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
import { toFr, toHexString } from './fieldUtils';
import { gasSettingsWithHeadroom, type BaseFeeNode } from './feeSettings';
import type { NoteToImport, TxEffectData } from './noteImporter';

type Schedule = <T>(fn: () => Promise<T>) => Promise<T>;

/** Per-send fee/timeout context. `node` supplies the live L2 base fee for the
 *  shared headroom policy; the contract itself never leaves this module. */
export interface SendOpts {
  node: unknown;
  timeoutMs: number;
}

// The wallet the contracts are bound to. Set on connect, cleared on disconnect.
// Owned here so no caller needs (or can capture) the raw wallet for PXE work.
let currentWallet: unknown = null;
export function setPxeWallet(wallet: unknown): void {
  currentWallet = wallet;
}

/**
 * Pre-warm the contract cache for the bound wallet so the first game op is fast.
 * Re-exposed here so callers never import the raw-contract module directly.
 * No-op until a wallet is bound (warmup during account bootstrap would race the
 * deploy's own inline contract creation on IndexedDB).
 */
export async function warmupPxe(): Promise<void> {
  if (!currentWallet) return;
  const { warmupContracts } = await import('./contracts');
  warmupContracts(currentWallet);
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

/** Build the padded (length-64) note-hash array import_note expects. */
function padNoteHashes(Fr: any, noteHashes: string[]): any[] {
  const padded = new Array(64).fill(new Fr(0n));
  for (let i = 0; i < noteHashes.length && i < 64; i++) padded[i] = toFr(Fr, noteHashes[i]);
  return padded;
}

/**
 * Named PXE operations. ONE implementation each; `schedule` picks enqueue vs
 * inline. Callers pass and receive plain values (hex strings, numbers, bigints,
 * pre-built Fr arg arrays) — never a contract instance.
 */
function makeOps(schedule: Schedule) {
  return {
    /** Private ARNA-token balance for `owner` (decimal-safe → bigint). */
    readTokenBalance: (owner: string): Promise<bigint> =>
      schedule(async () => {
        const { tokenContract, AztecAddress } = await resolveContracts();
        if (!tokenContract) throw new Error('token contract unavailable');
        const addr = AztecAddress.fromStringUnsafe(owner);
        const { result } = await tokenContract.methods.get_balance(addr).simulate({ from: addr });
        return BigInt(result.toString());
      }),

    /**
     * P1 create-game preview: derive the next game's id, per-game randomness,
     * blinding factor, and current on-chain status from the note nonce.
     */
    previewCreateGame: (
      owner: string,
    ): Promise<{ gameId: string; randomness: string[]; blindingFactor: string; status: number }> =>
      schedule(async () => {
        const { gameContract, nftContract, Fr, AztecAddress } = await resolveContracts();
        const addr = AztecAddress.fromStringUnsafe(owner);
        const { result: nonceResult } = await nftContract.methods.get_note_nonce(addr).simulate({ from: addr });
        const nonceFr = toFr(Fr, nonceResult);
        const { result: preview }: any = await nftContract.methods.preview_game_data(nonceFr).simulate({ from: addr });
        const gameId = String(preview[0]);
        const randomness = Array.from({ length: 6 }, (_, i) => toHexString(preview[i + 1]));
        const gameIdFr = toFr(Fr, gameId);
        const { result: status } = await gameContract.methods.get_game_status(gameIdFr).simulate({ from: addr });
        const { result: blinding } = await nftContract.methods.compute_blinding_factor(gameIdFr).simulate({ from: addr });
        return { gameId: toHexString(gameId), randomness, blindingFactor: toHexString(blinding), status: Number(status) };
      }),

    /** P2 join-game preview: per-game randomness + blinding factor for `gameId`. */
    previewJoinGame: (
      owner: string,
      gameId: string,
    ): Promise<{ randomness: string[]; blindingFactor: string }> =>
      schedule(async () => {
        const { nftContract, Fr, AztecAddress } = await resolveContracts();
        const addr = AztecAddress.fromStringUnsafe(owner);
        const gameIdFr = toFr(Fr, gameId);
        const { result: nonceResult } = await nftContract.methods.get_note_nonce(addr).simulate({ from: addr });
        const { result: blinding } = await nftContract.methods.compute_blinding_factor(gameIdFr).simulate({ from: addr });
        const nonceFr = toFr(Fr, nonceResult);
        const { result: preview }: any = await nftContract.methods.preview_game_data(nonceFr).simulate({ from: addr });
        const randomness = Array.from({ length: 6 }, (_, i) => toHexString(preview[i + 1]));
        return { randomness, blindingFactor: toHexString(blinding) };
      }),

    /** All non-zero card IDs the PXE holds for `owner` (paged get_nfts_for_user). */
    readPrivateCards: (owner: string): Promise<number[]> =>
      schedule(async () => {
        const { nftContract, AztecAddress } = await resolveContracts();
        const addr = AztecAddress.fromStringUnsafe(owner);
        const ids: number[] = [];
        let pageIndex = 0;
        let hasMore = true;
        while (hasMore) {
          const { result }: any = await nftContract.methods.get_nfts_for_user(addr, pageIndex).simulate({ from: addr });
          const page = result[0] ?? [];
          hasMore = result[1] === true;
          for (const val of page) {
            const id = Number(BigInt(val));
            if (id !== 0) ids.push(id);
          }
          pageIndex++;
        }
        return ids;
      }),

    /** Card-pack preview: the IDs a purchase would mint + the note nonce that
     *  derives their randomness (captured BEFORE the purchase advances it). */
    previewCardPack: (owner: string, count: number): Promise<{ cardIds: number[]; nonce: string }> =>
      schedule(async () => {
        const { nftContract, Fr, AztecAddress } = await resolveContracts();
        const addr = AztecAddress.fromStringUnsafe(owner);
        const { result: nonceResult } = await nftContract.methods.get_note_nonce(addr).simulate({ from: addr });
        const { result: preview }: any = await nftContract.methods.preview_card_ids(nonceResult).simulate({ from: addr });
        const cardIds = Array.from({ length: count }, (_, i) => Number(preview[i]));
        return { cardIds, nonce: toFr(Fr, nonceResult).toString() };
      }),

    /** Recipient-derivable note randomness (hex) for `count` notes at `nonce`. */
    computeNoteRandomness: (owner: string, nonce: string, count: number): Promise<string[]> =>
      schedule(async () => {
        const { nftContract, Fr, AztecAddress } = await resolveContracts();
        const addr = AztecAddress.fromStringUnsafe(owner);
        const nonceFr = toFr(Fr, nonce);
        const { result }: any = await nftContract.methods.compute_note_randomness(nonceFr, count).simulate({ from: addr });
        return Array.from({ length: count }, (_, i) => toFr(Fr, result[i]).toString());
      }),

    /** Build the get_cards_for_new_player execution payload (account-bootstrap
     *  combined deploy+mint). Encodes only — no simulate/send. */
    buildMintStarterCardsRequest: (): Promise<any> =>
      schedule(async () => {
        const { nftContract } = await resolveContracts();
        return nftContract.methods.get_cards_for_new_player().request();
      }),

    // ── Sends → txHash ────────────────────────────────────────────
    // wait.interval=15s (SECONDS, like timeout), NOT the SDK's 1s default: on
    // testnet a tx mines in ~15-30s, so 1s getTxReceipt polling fires ~1×/s per
    // in-flight tx. Across two browsers sharing one egress IP, that receipt-poll
    // overlaps the proving read-bursts and pushes past the node's 300-req/min/IP
    // rate cap — whose 429s the browser mis-reports as bogus "CORS" errors and
    // kills the settle. 15s detects mining promptly at 1/15 the request rate.
    sendCreateGame: (owner: string, ids: number[], opts: SendOpts): Promise<string> =>
      schedule(() => withReorgRetry('create_game', async () => {
        const { gameContract, Fr, AztecAddress } = await resolveContracts();
        const addr = AztecAddress.fromStringUnsafe(owner);
        const { receipt } = await gameContract.methods
          .create_game(ids.map((id) => new Fr(BigInt(id))))
          .send({ from: addr, fee: { gasSettings: await gasSettingsWithHeadroom(opts.node as BaseFeeNode) }, wait: { timeout: opts.timeoutMs, interval: 15 } });
        return requireTxHash(receipt, 'create_game');
      })),

    sendJoinGame: (owner: string, gameId: string, ids: number[], opts: SendOpts): Promise<string> =>
      schedule(() => withReorgRetry('join_game', async () => {
        const { gameContract, Fr, AztecAddress } = await resolveContracts();
        const addr = AztecAddress.fromStringUnsafe(owner);
        const { receipt } = await gameContract.methods
          .join_game(toFr(Fr, gameId), ids.map((id) => new Fr(BigInt(id))))
          .send({ from: addr, fee: { gasSettings: await gasSettingsWithHeadroom(opts.node as BaseFeeNode) }, wait: { timeout: opts.timeoutMs, interval: 15 } });
        return requireTxHash(receipt, 'join_game');
      })),

    sendPurchaseCardPack: (owner: string, opts: SendOpts): Promise<string> =>
      schedule(async () => {
        const { nftContract, AztecAddress } = await resolveContracts();
        const addr = AztecAddress.fromStringUnsafe(owner);
        const { receipt } = await nftContract.methods
          .purchase_card_pack()
          .send({ from: addr, fee: { gasSettings: await gasSettingsWithHeadroom(opts.node as BaseFeeNode) }, wait: { timeout: opts.timeoutMs, interval: 15 } });
        return requireTxHash(receipt, 'purchase_card_pack');
      }),

    sendMintStarterCards: (owner: string, opts: SendOpts): Promise<string> =>
      schedule(async () => {
        const { nftContract, AztecAddress } = await resolveContracts();
        const addr = AztecAddress.fromStringUnsafe(owner);
        const { receipt } = await nftContract.methods
          .get_cards_for_new_player()
          .send({ from: addr, fee: { gasSettings: await gasSettingsWithHeadroom(opts.node as BaseFeeNode) }, wait: { timeout: opts.timeoutMs, interval: 15 } });
        return requireTxHash(receipt, 'get_cards_for_new_player');
      }),

    /**
     * Settlement / abandoned-game sends. The caller builds the ordered Fr/address
     * argument array (it owns the proof transcript + VK fields and needs Fr for
     * that anyway); the contract is resolved and invoked here so it never escapes.
     */
    sendProcessGame: (owner: string, args: unknown[], opts: SendOpts): Promise<string> =>
      schedule(() => sendGameMethod('process_game', owner, args, opts)),
    sendClaimAbandonedGame: (owner: string, args: unknown[], opts: SendOpts): Promise<string> =>
      schedule(() => sendGameMethod('claim_abandoned_game', owner, args, opts)),
    sendSettleAbandonedGame: (owner: string, args: unknown[], opts: SendOpts): Promise<string> =>
      schedule(() => sendGameMethod('settle_abandoned_game', owner, args, opts)),

    // ── Note imports (create_and_push notes the PXE can't auto-discover) ──
    /**
     * Inject NFT card notes into `owner`'s PXE via import_note. Per-note failures
     * are tolerated (idempotent re-import of an already-held note). `txEffect`
     * (a node read) is fetched by the caller and passed in, so this op is pure PXE.
     */
    importCardNotes: (
      owner: string,
      txHash: string,
      notes: NoteToImport[],
      label: string,
      txEffect: TxEffectData,
    ): Promise<number[]> =>
      schedule(async () => {
        const { nftContract, Fr, AztecAddress } = await resolveContracts();
        const myAddr = AztecAddress.fromStringUnsafe(owner);
        const { noteHashes, firstNullifier } = txEffect;
        const paddedHashes = padNoteHashes(Fr, noteHashes);
        const txHashFr = toFr(Fr, txHash);
        const firstNullFr = toFr(Fr, firstNullifier);
        console.log(`[pxe] ${label}: importing ${notes.length} notes (${noteHashes.length} hashes)`);
        for (const note of notes) {
          try {
            await nftContract.methods
              .import_note(myAddr, new Fr(BigInt(note.tokenId)), toFr(Fr, note.randomness), txHashFr, paddedHashes, noteHashes.length, firstNullFr, myAddr)
              .simulate({ from: myAddr });
          } catch (e) {
            console.warn(`[pxe] ${label}: import_note failed for tokenId=${note.tokenId}: ${e}`);
          }
        }
        return notes.map((n) => n.tokenId);
      }),

    /**
     * Inject the settlement +reward ArenaToken balance note into `owner`'s PXE.
     * The note randomness is derived in-contract from the recipient's own per-game
     * randomness; recompute it (compute_reward_randomness) then import_note.
     */
    importTokenRewardNote: (
      owner: string,
      txHash: string,
      amount: number,
      playerRandomness: string[],
      txEffect: TxEffectData,
    ): Promise<boolean> =>
      schedule(async () => {
        const { tokenContract, Fr, AztecAddress } = await resolveContracts();
        if (!tokenContract) {
          console.warn('[pxe] token reward: no token contract configured');
          return false;
        }
        const myAddr = AztecAddress.fromStringUnsafe(owner);
        const { result: rewardRandomness } = await tokenContract.methods
          .compute_reward_randomness(playerRandomness.map((r) => toFr(Fr, r)))
          .simulate({ from: myAddr });
        const { noteHashes, firstNullifier } = txEffect;
        const paddedHashes = padNoteHashes(Fr, noteHashes);
        try {
          await tokenContract.methods
            .import_note(myAddr, BigInt(amount), toFr(Fr, rewardRandomness), toFr(Fr, txHash), paddedHashes, noteHashes.length, toFr(Fr, firstNullifier), myAddr)
            .simulate({ from: myAddr });
          console.log(`[pxe] token reward: imported +${amount} note from ${txHash}`);
          return true;
        } catch (e) {
          console.warn('[pxe] token reward: import_note failed:', e);
          return false;
        }
      }),
  };
}

const MAX_TX_ATTEMPTS = 3;
/** Wait between reorg-retry attempts: let the PXE's background sync advance PAST
 *  the pruned anchor block before we re-prove (a bare immediate resubmit reuses
 *  the same stale anchor and fails identically). Mirrors the f28640f deploy wait. */
const PXE_RESYNC_WAIT_MS = 15_000;

/**
 * True for the transient v5-testnet tx failures that V4's stable testnet never
 * produced: the rc testnet reorgs/prunes under an in-flight tx, so the mempool
 * evicts it ("Tx dropped by P2P node") or the block its tx was anchored to is
 * pruned before it lands ("Block header not found" / "Block hash <h> not found
 * when querying world state ... possibly a reorg"). These are NOT logic errors —
 * re-syncing past the pruned block and re-proving against the fresh tip succeeds.
 */
export function isTransientTestnetTxFailure(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return m.includes('dropped by p2p')
    || m.includes('block header not found')
    || m.includes('not found when querying world state')
    || m.includes('anchor block')
    || m.includes('possibly a reorg');
}

/**
 * Re-prove + resend a game tx that hit a transient reorg/prune failure. Safe to
 * retry: every game op is gated by note nullifiers (the wagered cards, the game
 * completion), so a resubmit and any stray original are mutually exclusive — at
 * most one can ever land. Without this, a single rc-testnet reorg strands a game
 * (seen on testnet; never on V4, whose testnet didn't reorg mid-game). The retry
 * only fires on the matched transient failures, so the happy path is unchanged.
 */
export async function withReorgRetry<T>(label: string, attempt: () => Promise<T>, resyncWaitMs: number = PXE_RESYNC_WAIT_MS): Promise<T> {
  for (let n = 1; ; n++) {
    try {
      return await attempt();
    } catch (err) {
      if (n < MAX_TX_ATTEMPTS && isTransientTestnetTxFailure(err)) {
        // Wait for the PXE's background sync to advance PAST the pruned anchor
        // before re-proving — a bare immediate retry re-anchors to the same stale
        // block and fails identically (seen: 3 tries in 0.4s, all "block hash not
        // found"). This is the proven f28640f deploy-retry pattern.
        console.warn(`[pxe] ${label}: anchor pruned on attempt ${n}/${MAX_TX_ATTEMPTS} (${err instanceof Error ? err.message : err}); waiting ${resyncWaitMs}ms for PXE re-sync, then re-proving`);
        if (resyncWaitMs > 0) await new Promise((r) => setTimeout(r, resyncWaitMs));
        continue;
      }
      throw err;
    }
  }
}

/** Shared impl for the game-contract proof sends (process/claim/settle). */
async function sendGameMethod(method: string, owner: string, args: unknown[], opts: SendOpts): Promise<string> {
  return withReorgRetry(method, async () => {
    const { gameContract, AztecAddress } = await resolveContracts();
    const addr = AztecAddress.fromStringUnsafe(owner);
    const { receipt } = await gameContract.methods[method](...args)
      .send({ from: addr, fee: { gasSettings: await gasSettingsWithHeadroom(opts.node as BaseFeeNode) }, wait: { timeout: opts.timeoutMs, interval: 15 } });
    return requireTxHash(receipt, method);
  });
}

function requireTxHash(receipt: any, label: string): string {
  const txHash = receipt?.txHash?.toString();
  if (!txHash) throw new Error(`${label} tx returned no txHash`);
  return txHash;
}

export type PxeOps = ReturnType<typeof makeOps>;

/** Standalone facade: every op is enqueued on the serial PXE queue. */
export const pxe: PxeOps = makeOps((fn) => txManager.enqueuePxe(fn));

/** In-tx facade: ops run INLINE within the current queue item (no re-enqueue). */
const inlinePxe: PxeOps = makeOps((fn) => fn());

/**
 * Run a tracked transaction whose `execute` (and `postEffects`) use the INLINE
 * facade, so the reads and the send execute as ONE atomic queue item (preserving
 * settlement priority and postEffects ordering). Use this instead of
 * `txManager.runTx` for any tx that touches the PXE — `execute`/`postEffects`
 * receive the inline `ops`, never a raw contract.
 *
 * Same config shape as `txManager.runTx`, plus the `ops` argument: migrating a
 * call is a rename + threading `ops` into `execute`/`postEffects`.
 */
export function runPxeTx<T>(opts: {
  type: TxType;
  label: string;
  gameId?: string;
  execute: (ops: PxeOps, setPhase: (phase: TxPhase) => void) => Promise<T>;
  postEffects?: (result: T, ops: PxeOps) => Promise<void>;
}): Promise<T> {
  return txManager.runTx({
    type: opts.type,
    label: opts.label,
    gameId: opts.gameId,
    execute: (setPhase) => opts.execute(inlinePxe, setPhase),
    postEffects: opts.postEffects ? (result: T) => opts.postEffects!(result, inlinePxe) : undefined,
  });
}
