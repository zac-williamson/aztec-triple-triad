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
import { toFr } from './fieldUtils';
import { gasSettingsWithHeadroom, type BaseFeeNode } from './feeSettings';
import { CARDS_PER_HAND } from './gameConstants';
import type { NoteToImport, TxEffectData } from './noteImporter';
import type { OffchainMessage } from '@aztec-labs/aztec.js/contracts';
import { diag } from './diagnostics';
import {
  GAME_NULLIFIER_COUNT,
  normalizeField,
  parseGameSecrets,
  parseRecord,
  RECORD_LEN,
  ZERO_RECORD,
  type ClaimNo,
  type GameRecord,
  type GameSecrets,
  type Side,
} from './privateGame';

type Schedule = <T>(fn: () => Promise<T>) => Promise<T>;

/** Per-send fee/timeout context. `node` supplies the live L2 base fee for the
 *  shared headroom policy; the contract itself never leaves this module. */
export interface SendOpts {
  node: unknown;
  timeoutMs: number;
}

/**
 * A mined send that created card notes (a pack, the starter set): its hash,
 * and the notes' offchain messages — one per note, each addressed to the
 * card's owner — for `receiveCardMessages`. Game txs deliver nothing; their
 * notes are imported by each owner (see `importCardNotes`).
 */
export interface MintedTx {
  txHash: string;
  offchainMessages: OffchainMessage[];
}

/** aztec-nr's MAX_OFFCHAIN_MESSAGES_PER_RECEIVE_CALL: `offchain_receive` takes a
 *  BoundedVec of at most this many. */
const MAX_MESSAGES_PER_RECEIVE = 16;

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

/** The two records and key every abandonment call takes. */
export interface GameRef {
  gameKey: string;
  record1: GameRecord;
  record2: GameRecord;
}

/** A hand as the five `[Field; 5]` card ids the game functions take. */
function handFields(Fr: any, cardIds: number[]): any[] {
  if (cardIds.length !== CARDS_PER_HAND) {
    throw new Error(`a hand is exactly ${CARDS_PER_HAND} card ids, got ${cardIds.length}`);
  }
  return cardIds.map((id) => new Fr(BigInt(id)));
}

/** A record as `[Field; 9]`. */
function recordFields(Fr: any, record: GameRecord): any[] {
  if (record.length !== RECORD_LEN) throw new Error(`a record is ${RECORD_LEN} fields, got ${record.length}`);
  return record.map((v) => toFr(Fr, v));
}

function gameRefFields(Fr: any, game: GameRef): any[] {
  return [toFr(Fr, game.gameKey), recordFields(Fr, game.record1), recordFields(Fr, game.record2)];
}

/** A block number for a `u32` parameter. */
function blockArg(blockNumber: number): number {
  if (!Number.isInteger(blockNumber) || blockNumber < 0 || blockNumber > 0xffffffff) {
    throw new Error(`not a block number: ${blockNumber}`);
  }
  return blockNumber;
}

/**
 * Named PXE operations. ONE implementation each; `schedule` picks enqueue vs
 * inline. Callers pass and receive plain values (hex strings, numbers, bigints,
 * pre-built Fr arg arrays) — never a contract instance.
 */
/**
 * `makeOps` with the operation's own name threaded through to the scheduler.
 * Implemented as a Proxy so every op is covered without naming each by hand,
 * and so a new op cannot be added without a label by accident.
 */
function makeOpsNamed(schedule: (fn: () => Promise<unknown>, name: string) => Promise<unknown>): PxeOps {
  const named = { current: 'op' };
  const ops = makeOps((fn) => schedule(fn, named.current) as Promise<never>);
  return new Proxy(ops as object, {
    get(target, prop, recv) {
      const value = Reflect.get(target, prop, recv);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        named.current = String(prop);
        return (value as (...a: unknown[]) => unknown)(...args);
      };
    },
  }) as PxeOps;
}

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

    // ── Private games (docs/plan/PRIVATE_GAMES.md) ────────────────
    // A game's commit consumes the player's note nonce and derives every
    // per-game secret from it, so the nonce is read BEFORE the commit — inside
    // the same queue item as the send (runPxeTx), so nothing can advance it
    // in between.

    /** The player's current note nonce (`get_note_nonce`), as a field (hex). */
    readNoteNonce: (owner: string): Promise<string> =>
      schedule(async () => {
        const { nftContract, AztecAddress } = await resolveContracts();
        const addr = AztecAddress.fromStringUnsafe(owner);
        const { result } = await nftContract.methods.get_note_nonce(addr).simulate({ from: addr });
        return normalizeField(result);
      }),

    /**
     * The player's own secrets for the game committed at `nonce`:
     * `[blinding, r_0..r_4, prize_randomness, reward_randomness]`. Never leave
     * the device.
     */
    computeGameSecrets: (owner: string, nonce: string): Promise<GameSecrets> =>
      schedule(async () => {
        const { nftContract, Fr, AztecAddress } = await resolveContracts();
        const addr = AztecAddress.fromStringUnsafe(owner);
        const { result } = await nftContract.methods.compute_game_secrets(toFr(Fr, nonce)).simulate({ from: addr });
        return parseGameSecrets(Array.from(result as ArrayLike<unknown>));
      }),

    /**
     * The record `create_game` / `join_game` will commit for `owner` at
     * `nonce` — built by the contract, with no side effects. The creator
     * sends it to the joiner; both need it to prove moves and to import.
     */
    previewRecord: (owner: string, gameKey: string, cardIds: number[], nonce: string): Promise<GameRecord> =>
      schedule(async () => {
        const { gameContract, Fr, AztecAddress } = await resolveContracts();
        const addr = AztecAddress.fromStringUnsafe(owner);
        const { result } = await gameContract.methods
          .preview_record(toFr(Fr, gameKey), handFields(Fr, cardIds), toFr(Fr, nonce))
          .simulate({ from: addr });
        return parseRecord(Array.from(result as ArrayLike<unknown>));
      }),

    /**
     * The game's 21 SILOED nullifiers, computed by the contract so TypeScript
     * never reimplements the hashes. Look them up on the node (gameChain.ts).
     * Before a join, pass `record2 = null` (`joined` is then meaningless).
     */
    gameNullifiers: (owner: string, gameKey: string, record1: GameRecord, record2: GameRecord | null): Promise<string[]> =>
      schedule(async () => {
        const { gameContract, Fr, AztecAddress } = await resolveContracts();
        const addr = AztecAddress.fromStringUnsafe(owner);
        const { result } = await gameContract.methods
          .game_nullifiers(toFr(Fr, gameKey), recordFields(Fr, record1), recordFields(Fr, record2 ?? ZERO_RECORD))
          .simulate({ from: addr });
        const out = Array.from(result as ArrayLike<unknown>).map(normalizeField);
        if (out.length !== GAME_NULLIFIER_COUNT) {
          throw new Error(`game_nullifiers returned ${out.length} values, expected ${GAME_NULLIFIER_COUNT}`);
        }
        return out;
      }),

    /**
     * All non-zero card IDs the PXE holds for `owner` (paged get_nfts_for_user).
     *
     * This is QUADRATIC in the size of the collection, and it is worth knowing
     * why before assuming a larger page would help. The contract asks for ten
     * notes at an offset, but the PXE does not push that offset down to
     * storage: `NoteService.getNotes` passes no limit or offset to the note
     * store, so it loads EVERY note for the slot, and `pickNotes` then does
     * `.slice(offset, offset + limit)` on the array in memory. Each page
     * therefore costs a full collection scan, and reading N cards costs about
     * N²/10 note loads. (aztec-packages `pxe/src/notes/note_service.ts` and
     * `pxe/src/contract_function_simulator/pick_notes.ts`.)
     *
     * Measured at 46s for 1,382 cards. A player's collection is five starter
     * cards plus ten per pack plus one per win, so this is comfortable into the
     * low hundreds and unpleasant past roughly five hundred. The only holder
     * anywhere near that is the arena bot, which caches the result.
     *
     * Accepted rather than fixed: a bigger page needs a contract change, and a
     * redeploy orphans every player's cards. Refreshing by delta instead of
     * re-reading would avoid the scan, but a local idea of the collection that
     * can drift from the PXE's is precisely the failure this codebase has
     * already paid for ("Could not find all 5 cards").
     */
    readPrivateCards: (owner: string): Promise<number[]> =>
      schedule(async () => {
        const { nftContract, AztecAddress } = await resolveContracts();
        const addr = AztecAddress.fromStringUnsafe(owner);
        const startedAt = Date.now();
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
        // So that a player who does reach the slow end is visible to support
        // rather than just "the app feels stuck sometimes".
        const took = Date.now() - startedAt;
        if (took > 5_000) {
          diag(`[cards] read ${ids.length} cards in ${Math.round(took / 1000)}s ` +
            `over ${pageIndex} pages — paging cost grows with the square of the collection`);
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
    /**
     * Commit a hand and create a game: `create_game(game_key, card_ids)`. The
     * record it commits is the one `previewRecord` returned at the same nonce.
     */
    sendCreateGame: (owner: string, gameKey: string, cardIds: number[], opts: SendOpts): Promise<string> =>
      schedule(async () => {
        const { Fr } = await resolveContracts();
        return sendGameMethod('create_game', owner, [toFr(Fr, gameKey), handFields(Fr, cardIds)], opts);
      }),

    /** Join the game whose creator committed `record1`. Needs its `created` nullifier mined. */
    sendJoinGame: (owner: string, gameKey: string, record1: GameRecord, cardIds: number[], opts: SendOpts): Promise<string> =>
      schedule(async () => {
        const { Fr } = await resolveContracts();
        return sendGameMethod('join_game', owner, [toFr(Fr, gameKey), recordFields(Fr, record1), handFields(Fr, cardIds)], opts);
      }),

    sendPurchaseCardPack: (owner: string, opts: SendOpts): Promise<MintedTx> =>
      schedule(() => withReorgRetry('purchase_card_pack', async () => {
        const { nftContract, AztecAddress } = await resolveContracts();
        const addr = AztecAddress.fromStringUnsafe(owner);
        const sent = await nftContract.methods
          .purchase_card_pack()
          .send({ from: addr, fee: { gasSettings: await gasSettingsWithHeadroom(opts.node as BaseFeeNode) }, wait: { timeout: opts.timeoutMs, interval: 15 } });
        return mintedTx(sent, 'purchase_card_pack', opts.node);
      })),

    sendMintStarterCards: (owner: string, opts: SendOpts): Promise<MintedTx> =>
      schedule(async () => {
        const { nftContract, AztecAddress } = await resolveContracts();
        const addr = AztecAddress.fromStringUnsafe(owner);
        const sent = await nftContract.methods
          .get_cards_for_new_player()
          .send({ from: addr, fee: { gasSettings: await gasSettingsWithHeadroom(opts.node as BaseFeeNode) }, wait: { timeout: opts.timeoutMs, interval: 15 } });
        return mintedTx(sent, 'get_cards_for_new_player', opts.node);
      }),

    /**
     * Settle a finished game. The caller builds the ordered argument list
     * (`buildSettleGameArgs`: it owns the transcript and the VK); the contract
     * is resolved and invoked here so it never escapes. Anyone may settle.
     * Nothing is delivered: each player imports their own notes from the tx.
     */
    sendSettleGame: (owner: string, args: unknown[], opts: SendOpts): Promise<string> =>
      schedule(() => sendGameMethod('settle_game', owner, args, opts)),

    /**
     * Cancel a game nobody joined: the creator's own five prepared return
     * notes are released (import them afterwards). Creator only; fails once
     * anyone has joined, because join and cancel both close seat 2.
     */
    sendCancelGame: (owner: string, gameKey: string, record1: GameRecord, opts: SendOpts): Promise<string> =>
      schedule(async () => {
        const { Fr } = await resolveContracts();
        return sendGameMethod('cancel_game', owner, [toFr(Fr, gameKey), recordFields(Fr, record1)], opts);
      }),

    /**
     * Claim that the other player abandoned the game. `clockBlock` is the
     * block the claim's clock nullifier landed in — the join for claim 1, the
     * previous contest after that.
     */
    sendClaimAbandonedGame: (
      owner: string,
      game: GameRef,
      claim: { side: Side; claimNo: ClaimNo; clockBlock: number },
      opts: SendOpts,
    ): Promise<string> =>
      schedule(async () => {
        const { Fr } = await resolveContracts();
        return sendGameMethod('claim_abandoned_game', owner, [
          ...gameRefFields(Fr, game),
          new Fr(BigInt(claim.side)),
          new Fr(BigInt(claim.claimNo)),
          blockArg(claim.clockBlock),
        ], opts);
      }),

    /**
     * Contest a standing claim: "I am still here." `beforeClaimBlock` is a
     * block in which the claim did not yet exist (its block minus one); the
     * contest must land within DISPUTE_SECONDS of it.
     */
    sendContestAbandonment: (
      owner: string,
      game: GameRef,
      contest: { side: Side; claimNo: ClaimNo; claimSide: Side; beforeClaimBlock: number },
      opts: SendOpts,
    ): Promise<string> =>
      schedule(async () => {
        const { Fr } = await resolveContracts();
        return sendGameMethod('contest_abandonment', owner, [
          ...gameRefFields(Fr, game),
          new Fr(BigInt(contest.side)),
          new Fr(BigInt(contest.claimNo)),
          new Fr(BigInt(contest.claimSide)),
          blockArg(contest.beforeClaimBlock),
        ], opts);
      }),

    /**
     * Finalize an uncontested claim once its window has passed: both hands go
     * back, nobody wins anything. Anyone may finalize. `claimBlock` is the
     * block the claim landed in.
     */
    sendFinalizeAbandonedGame: (
      owner: string,
      game: GameRef,
      claim: { claimNo: ClaimNo; claimSide: Side; claimBlock: number },
      opts: SendOpts,
    ): Promise<string> =>
      schedule(async () => {
        const { Fr } = await resolveContracts();
        return sendGameMethod('finalize_abandoned_game', owner, [
          ...gameRefFields(Fr, game),
          new Fr(BigInt(claim.claimNo)),
          new Fr(BigInt(claim.claimSide)),
          blockArg(claim.claimBlock),
        ], opts);
      }),

    // ── Card notes (explicit-randomness notes the PXE can't discover by tag) ──
    /**
     * Hand a mint's offchain messages to the NFT contract's `offchain_receive`
     * — the normal way a card note reaches its owner's PXE.
     *
     * Only the messages for `owner` from the NFT contract: a PXE can process
     * only its own accounts' messages (the inbox is scoped by recipient).
     * Received messages
     * wait in a persistent inbox; the PXE stores each note at the next NFT
     * contract sync once the tx is found on-chain — any later NFT read or
     * call triggers it — and processes it again after a reorg. Receiving the
     * same message twice is harmless. Returns how many were handed over.
     */
    receiveCardMessages: (owner: string, txHash: string, messages: OffchainMessage[]): Promise<number> =>
      schedule(async () => {
        const { nftContract, Fr, AztecAddress } = await resolveContracts();
        const me = AztecAddress.fromStringUnsafe(owner);
        const mine = messages.filter((m) => m.recipient.equals(me) && m.contractAddress.equals(nftContract.address));
        const txHashFr = toFr(Fr, txHash);
        for (let i = 0; i < mine.length; i += MAX_MESSAGES_PER_RECEIVE) {
          const batch = mine.slice(i, i + MAX_MESSAGES_PER_RECEIVE).map((m) => ({
            ciphertext: m.payload,
            recipient: m.recipient,
            tx_hash: txHashFr,
            anchor_block_timestamp: m.anchorBlockTimestamp,
          }));
          await nftContract.methods.offchain_receive(batch).simulate({ from: me });
        }
        console.log(`[pxe] received ${mine.length} card note message(s) from ${txHash}`);
        return mine.length;
      }),

    /**
     * Inject NFT card notes into `owner`'s PXE via import_note — not the path a
     * mint takes. It serves the boot-time restore from the card store, every
     * card a game releases (settlement, unwind and cancel deliver nothing:
     * each player rebuilds their own notes from their own secrets), and the
     * bot's stock (which is minted with no messages). A note that is not in the
     * tx is discarded by the contract, not stored. Per-note failures are
     * tolerated (idempotent re-import of an already-held note). `txEffect` (a
     * node read) is fetched by the caller and passed in, so this op is pure PXE.
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
     * Inject a settlement's +reward ArenaToken note into `owner`'s PXE. The
     * player prepared it at commit time with their own `reward_randomness`
     * (`computeGameSecrets`), so that is the randomness to import it with.
     */
    importTokenRewardNote: (
      owner: string,
      txHash: string,
      amount: number,
      rewardRandomness: string,
      txEffect: TxEffectData,
    ): Promise<boolean> =>
      schedule(async () => {
        const { tokenContract, Fr, AztecAddress } = await resolveContracts();
        if (!tokenContract) {
          console.warn('[pxe] token reward: no token contract configured');
          return false;
        }
        const myAddr = AztecAddress.fromStringUnsafe(owner);
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

/**
 * A resync that leaves the anchor UNMOVED while this many blocks behind the tip
 * means the PXE's chain-sync is wedged on a pruned block: the SDK's block-stream
 * walk-back hits a block the node no longer serves, aborts, and `pxe.sync()`
 * still resolves "successfully" having advanced nothing. Re-proving against
 * that anchor is doomed — fail fast instead of burning a 3-minute proof.
 */
export const WEDGE_LAG_BLOCKS = 10;

/** Marker baked into the wedge error message so UI/harness can match it. */
export const PXE_WEDGED_MARKER = '[PXE_WEDGED]';

export function isPxeWedgedError(err: unknown): boolean {
  return (err instanceof Error ? err.message : String(err)).includes(PXE_WEDGED_MARKER);
}

/** Anchor freshness report — mirrors instrumentedWallet's PxeSyncReport. */
export interface PxeSyncReport {
  anchorBlock: number;
  anchorHash: string;
  tipBlock: number;
  lag: number;
  advanced: boolean;
  syncMs: number;
}

/**
 * Sync the bound wallet's PXE to the chain tip and report anchor freshness.
 * Null when no wallet is bound yet (pre-connect) — callers treat that as
 * "nothing to sync". NOTE: this drives the PXE's own internal job queue, not
 * txManager's — safe to call from inside a txManager queue item.
 */
export async function resyncPxe(label = 'resync', quiet = false): Promise<PxeSyncReport | null> {
  const w = currentWallet as {
    syncPxeAndReport?: (label?: string, quiet?: boolean) => Promise<PxeSyncReport>;
  } | null;
  if (!w?.syncPxeAndReport) return null;
  return w.syncPxeAndReport(label, quiet);
}

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
    || m.includes('possibly a reorg')
    // Transport-level: the gateway occasionally resets a connection
    // mid-request (net::ERR_CONNECTION_RESET killed a pack purchase,
    // 2026-07-05). Chrome surfaces it as a fetch TypeError; Safari as
    // "Load failed". A resend is safe for the same nullifier-gating
    // reason as the reorg cases — at most one of the original and the
    // retry can ever land.
    || m.includes('failed to fetch')
    || m.includes('connection reset')
    || m.includes('load failed');
}

/**
 * Re-prove + resend a game tx that hit a transient reorg/prune failure. Safe to
 * retry: every game op is gated by note nullifiers (the wagered cards, the game
 * completion), so a resubmit and any stray original are mutually exclusive — at
 * most one can ever land. Without this, a single rc-testnet reorg strands a game
 * (seen on testnet; never on V4, whose testnet didn't reorg mid-game). The retry
 * only fires on the matched transient failures, so the happy path is unchanged.
 *
 * Sync-then-retry, no sleeps: the browser PXE has NO background sync, so the
 * earlier passive-wait variant just held the serial queue for 15s and re-proved
 * against the identical dead anchor (observed live: anchor unmoved across two
 * waits). Instead we drive a sync NOW; if the anchor still doesn't move while
 * far behind the tip, the PXE's chain-sync is wedged on a pruned block and
 * every future attempt is doomed — fail fast with an explicit wedge error
 * rather than masking it with more retries.
 */
export async function withReorgRetry<T>(
  label: string,
  attempt: () => Promise<T>,
  resync: (label?: string, quiet?: boolean) => Promise<PxeSyncReport | null> = resyncPxe,
): Promise<T> {
  for (let n = 1; ; n++) {
    try {
      return await attempt();
    } catch (err) {
      if (n >= MAX_TX_ATTEMPTS || !isTransientTestnetTxFailure(err)) throw err;
      console.warn(`[pxe] ${label}: transient tx failure on attempt ${n}/${MAX_TX_ATTEMPTS} (${err instanceof Error ? err.message : err}); resyncing PXE, then re-proving`);
      // The resync is diagnostic + freshness, not a gate: if it ALSO fails
      // (e.g. the same momentary connection reset that broke the attempt),
      // proceed to the retry anyway — the next attempt's own send-side sync
      // re-anchors it, and a genuine wedge still gets caught next loop.
      const report = await resync(`${label} retry ${n}`).catch((syncErr) => {
        console.warn(`[pxe] ${label}: resync after attempt ${n} failed too (${syncErr instanceof Error ? syncErr.message : syncErr}); retrying regardless`);
        return null;
      });
      if (report && !report.advanced && report.lag >= WEDGE_LAG_BLOCKS) {
        throw new Error(
          `${label}: PXE chain-sync is wedged ${PXE_WEDGED_MARKER} — anchor #${report.anchorBlock} (${report.anchorHash.slice(0, 10)}…) did not advance on resync while ${report.lag} blocks behind the tip (#${report.tipBlock}). ` +
          'The network pruned that block and local sync cannot pass it, so re-proving fails identically. Use "Repair chain sync" to rebuild local chain state, then retry.',
        );
      }
    }
  }
}

/**
 * Shared impl for every game-contract send. Returns the mined tx's hash.
 *
 * Gas headroom, because a base fee that moves between simulate and send makes
 * the tx fail; a bounded wait on a 15s poll, because the default receipt poll
 * is fast enough to trip the node's per-IP rate cap (whose 429s the browser
 * mis-reports as CORS errors), and an unbounded wait hangs the UI forever on a
 * tx that never mines. Game txs deliver no notes — nothing to receive.
 */
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

/** What mintedTx reads from the node: the block a tx landed in. */
interface BlockDataNode {
  getBlockData(block: unknown): Promise<{ header: { globalVariables: { timestamp: bigint } } } | undefined>;
}

/**
 * A mined send's hash plus its offchain messages (`send()` returns both).
 *
 * Each message carries the timestamp of the block its tx was built against
 * (`anchorBlockTimestamp`), and `offchain_receive` cannot take a message
 * without one. A wallet behind the wallet-sdk (Nulo) returns `send()`'s result
 * through the SDK's sendTx schema, which in aztec.js 6.0.0 has no such field,
 * so its messages arrive without it — and the recipient, here or across the
 * relay, could not receive its cards. aztec-nr uses the timestamp for one
 * thing: evicting the message from the inbox MAX_MSG_TTL (the longest a tx can
 * live, plus two hours) after it. The tx is mined by now, so the timestamp of
 * its block stands in: no earlier than the anchor, later only by how long the
 * tx waited, which keeps the message a little longer and changes nothing else.
 * Never throws: the tx is already mined, and the callers retry a failed send.
 */
async function mintedTx(
  sent: { receipt?: unknown; offchainMessages?: OffchainMessage[] },
  label: string,
  node: unknown,
): Promise<MintedTx> {
  const txHash = requireTxHash(sent.receipt, label);
  const messages = sent.offchainMessages ?? [];
  if (messages.every((m) => m.anchorBlockTimestamp !== undefined)) return { txHash, offchainMessages: messages };
  const blockNumber = (sent.receipt as { blockNumber?: unknown } | undefined)?.blockNumber;
  let timestamp: bigint;
  try {
    const block = await (node as BlockDataNode).getBlockData(blockNumber);
    if (!block) throw new Error(`block ${String(blockNumber)} not found`);
    timestamp = block.header.globalVariables.timestamp;
  } catch (e) {
    // Later than the anchor by a little more; it only keeps the message longer.
    timestamp = BigInt(Math.floor(Date.now() / 1000));
    console.warn(`[pxe] ${label}: no block time for its card messages (${e}); using the current time`);
  }
  return {
    txHash,
    offchainMessages: messages.map((m) => (m.anchorBlockTimestamp === undefined ? { ...m, anchorBlockTimestamp: timestamp } : m)),
  };
}

export type PxeOps = ReturnType<typeof makeOps>;

/** Standalone facade: every op is enqueued on the serial PXE queue. */
/**
 * Queued facade. Each op carries its own name so the queue diagnostics can say
 * WHAT is waiting and what is holding it — "sendJoinGame queued behind 1
 * item" is the line that would have ended a very long production hunt in one
 * pass.
 */
export const pxe: PxeOps = makeOpsNamed((fn, name) =>
  txManager.enqueuePxe(fn, undefined, undefined, undefined, name));

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
