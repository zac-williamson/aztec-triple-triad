/**
 * Transaction Lifecycle Manager — module-level singleton.
 *
 * Owns the PXE serial queue, tracks in-flight transactions, and provides
 * a subscription mechanism for React components. Lives outside React so
 * transactions survive component unmounts and screen transitions.
 *
 * The PXE queue is priority-ordered: before picking the next item to
 * execute, the queue is sorted so that game-lifecycle transactions
 * (deploy, create, join) always run before settlement transactions.
 * This prevents deadlocks where a settlement blocks the queue while
 * waiting for a join_game that's stuck behind it.
 */

export type TxType = 'deploy_account' | 'create_game' | 'join_game' | 'settle_game' | 'purchase_card_pack' | 'claim_abandoned_game' | 'settle_abandoned_game';

/**
 * Priority map — lower number = higher priority = runs first.
 * Game lifecycle (deploy/create/join) must complete before settlement
 * can succeed, so they get higher priority.
 */
const TX_PRIORITY: Record<TxType, number> = {
  deploy_account: 0,
  create_game: 1,
  join_game: 1,
  purchase_card_pack: 2,
  settle_game: 3,
  claim_abandoned_game: 3,
  settle_abandoned_game: 4,
};

export type TxPhase =
  | 'queued'
  | 'simulating'
  | 'proving'
  | 'sending'
  | 'post_effects'
  | 'completed'
  | 'error';

export interface TxEntry {
  id: string;
  type: TxType;
  phase: TxPhase;
  label: string;
  error: string | null;
  txHash: string | null;
  updatedAt: number;
}

type TxSubscriber = () => void;

/** Default timeout per enqueued PXE operation (10 minutes) */
const PXE_OP_TIMEOUT = 600_000;

/** Internal queue item */
interface PxeQueueItem {
  fn: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  priority: number;
  gameId?: string;
  timeoutMs: number;
}

class TxManager {
  private entries = new Map<string, TxEntry>();
  private subscribers = new Set<TxSubscriber>();
  private inFlightGameIds = new Set<string>();
  private deferredLeaveGame = new Map<string, () => void>();
  private cachedSnapshot: TxEntry[] = [];
  private snapshotDirty = true;

  // ── Priority PXE Queue ────────────────────────────────────────
  private pxeItems: PxeQueueItem[] = [];
  private pxeProcessing = false;

  // ── Subscription ──────────────────────────────────────────────

  subscribe(cb: TxSubscriber): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  private notify(): void {
    this.snapshotDirty = true;
    for (const cb of this.subscribers) cb();
  }

  /** Stable snapshot for useSyncExternalStore */
  getEntries(): TxEntry[] {
    if (this.snapshotDirty) {
      this.cachedSnapshot = Array.from(this.entries.values());
      this.snapshotDirty = false;
    }
    return this.cachedSnapshot;
  }

  // ── Queries ───────────────────────────────────────────────────

  hasInFlight(type?: TxType): boolean {
    for (const e of this.entries.values()) {
      if (e.phase !== 'completed' && e.phase !== 'error') {
        if (!type || e.type === type) return true;
      }
    }
    return false;
  }

  hasInFlightForGame(gameId: string): boolean {
    return this.inFlightGameIds.has(gameId);
  }

  // ── Entry Management ──────────────────────────────────────────

  private addEntry(type: TxType, label: string, gameId?: string): string {
    const id = crypto.randomUUID();
    this.entries.set(id, {
      id, type, phase: 'queued', label,
      error: null, txHash: null, updatedAt: Date.now(),
    });
    if (gameId) this.inFlightGameIds.add(gameId);
    this.notify();
    return id;
  }

  private setPhase(id: string, phase: TxPhase, extra?: Partial<TxEntry>): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    Object.assign(entry, { phase, updatedAt: Date.now(), ...extra });
    this.notify();
  }

  private finalize(id: string, gameId?: string): void {
    if (gameId) {
      this.inFlightGameIds.delete(gameId);
      this.executeDeferredLeaveGame(gameId);
    }
    // Auto-remove completed entries after 10s
    setTimeout(() => {
      const entry = this.entries.get(id);
      if (entry && entry.phase === 'completed') {
        this.entries.delete(id);
        this.notify();
      }
    }, 10_000);
  }

  dismissError(id: string): void {
    this.entries.delete(id);
    this.notify();
  }

  // ── Navigation Deferral ───────────────────────────────────────

  deferLeaveGame(gameId: string, leaveGameFn: () => void): void {
    this.deferredLeaveGame.set(gameId, leaveGameFn);
  }

  private executeDeferredLeaveGame(gameId: string): void {
    const fn = this.deferredLeaveGame.get(gameId);
    if (fn) {
      this.deferredLeaveGame.delete(gameId);
      try { fn(); } catch { /* best effort */ }
    }
  }

  // ── PXE Queue (priority-ordered) ──────────────────────────────

  /**
   * Enqueue a PXE operation. Priority reordering only happens among
   * items that share the same gameId. Items with different gameIds
   * (i.e. different games) always maintain FIFO order so that one
   * game's settlement completes before the next game's creation.
   */
  enqueuePxe<T>(fn: () => Promise<T>, timeoutMs = PXE_OP_TIMEOUT, priority = 5, gameId?: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const item: PxeQueueItem = {
        fn, resolve: resolve as (v: unknown) => void, reject, priority, gameId, timeoutMs,
      };

      // Insert position: scan from the end. We can only jump ahead of
      // items that belong to the SAME game and have strictly lower
      // priority. Never jump ahead of items from a different game.
      let idx = this.pxeItems.length;
      for (let i = this.pxeItems.length - 1; i >= 0; i--) {
        const existing = this.pxeItems[i];
        if (gameId && existing.gameId === gameId && existing.priority > priority) {
          idx = i; // can go ahead of this same-game lower-priority item
        } else {
          break; // different game or higher/equal priority — stop here
        }
      }
      this.pxeItems.splice(idx, 0, item);

      this.drainPxeQueue();
    });
  }

  /** Process items one at a time until the queue is empty. */
  private async drainPxeQueue(): Promise<void> {
    if (this.pxeProcessing) return;
    this.pxeProcessing = true;

    while (this.pxeItems.length > 0) {
      const item = this.pxeItems.shift()!;
      try {
        const value = await Promise.race([
          item.fn(),
          new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error('PXE operation timed out')), item.timeoutMs),
          ),
        ]);
        item.resolve(value);
      } catch (e) {
        item.reject(e);
      }
    }

    this.pxeProcessing = false;
  }

  // ── Convenience: run a full tx lifecycle ──────────────────────

  /**
   * Run a transaction through the manager. Handles entry tracking,
   * phase updates, PXE queue, post-effects, and cleanup.
   *
   * The execute callback is enqueued with a priority derived from the
   * TxType so that game-lifecycle operations (create/join) always run
   * before settlement operations even if queued later.
   */
  async runTx<T>(opts: {
    type: TxType;
    label: string;
    gameId?: string;
    execute: (setPhase: (phase: TxPhase) => void) => Promise<T>;
    postEffects?: (result: T) => Promise<void>;
  }): Promise<T> {
    const { type, label, gameId, execute, postEffects } = opts;
    const id = this.addEntry(type, label, gameId);
    const priority = TX_PRIORITY[type] ?? 2;

    try {
      const result = await this.enqueuePxe(async () => {
        const setPhase = (phase: TxPhase) => this.setPhase(id, phase);
        return execute(setPhase);
      }, PXE_OP_TIMEOUT, priority, gameId);

      if (postEffects) {
        this.setPhase(id, 'post_effects');
        await postEffects(result);
      }

      this.setPhase(id, 'completed');
      this.finalize(id, gameId);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Transaction failed';
      this.setPhase(id, 'error', { error: message });
      if (gameId) {
        this.inFlightGameIds.delete(gameId);
        this.executeDeferredLeaveGame(gameId);
      }
      throw err;
    }
  }
}

const txManager = new TxManager();
export default txManager;
