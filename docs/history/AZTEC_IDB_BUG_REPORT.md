# Bug Report: TransactionInactiveError in PXE commitJob after complex private function simulation

## Summary

The PXE's `commitJob` step fails with `TransactionInactiveError: Failed to execute 'get' on 'IDBObjectStore': The transaction is inactive or finished` after successfully simulating a complex private function. The error occurs in `transactionAsync` (kv-store IndexedDB backend) during the job commit phase — not during simulation itself.

This is reproducible with transactions that generate a large number of staged notes/nullifiers (6+ nullifiers, 5+ partial notes in a single transaction).

## Environment

- **Aztec version**: `4.2.0-nightly.20260323`
- **Runtime**: Browser (EmbeddedWallet via `@aztec/wallets/embedded`)
- **KV Store**: IndexedDB (ephemeral mode)
- **Browser**: Safari (macOS), also observed in Chrome
- **Node.js**: 22.x

## Error

```
TransactionInactiveError: Failed to execute 'get' on 'IDBObjectStore': The transaction is inactive or finished.
```

Stack trace (from bundled source):
```
#contextualizeError (@aztec_wallets_embedded.js:18606)
(anonymous function) (@aztec_wallets_embedded.js:18985)
```

This maps to the `proveTx` method's catch block in `pxe.ts` (line ~800), which calls `#contextualizeError`.

## Reproduction

### Contract setup

Two contracts: a game contract (`TripleTriadGame`) and an NFT contract (`TripleTriadNFT`). The game contract's `create_game` private function cross-calls the NFT contract to:

1. Nullify 5 card notes (private NFT ownership notes)
2. Nullify 1 nonce tracking note
3. Create 5 partial notes (card commitments)
4. Create 1 new nonce tracking note
5. Emit multiple private log events (tagging data for note discovery)

Total: **6 nullifiers**, **6 new notes** (1 full + 5 partial), **11+ private logs** in a single transaction.

### Steps to reproduce

1. Create an `EmbeddedWallet` with ephemeral storage
2. Deploy a Schnorr account
3. Mint 5 NFT notes to the account
4. Call `gameContract.methods.create_game(cardIds).send()`
5. The simulation completes successfully (~12 seconds)
6. The commit/prove step fails with `TransactionInactiveError`

### Console output

```
[Info] "Simulating transaction execution request to 0x9d57a239 at 0x1b47..."
[Debug] "[aztec-nr] Performing state synchronization"
... (12 seconds of successful contract execution) ...
[Debug] "[NFT] commit_create: card_commit=0x2571... player_state=0x1dc7..."
[Info] "Simulation completed for 0x140e7616... in 12182.700000000012ms"

[Error] "TransactionInactiveError: Failed to execute 'get' on 'IDBObjectStore':
         The transaction is inactive or finished."
```

The simulation completes successfully — the error occurs immediately after, during `commitJob`.

## Root Cause Analysis

### The `transactionAsync` pattern in `kv-store/src/indexeddb/store.ts`

```typescript
// Lines 164-185
transactionAsync<T>(callback: () => Promise<T>): Promise<T> {
    return this.#txQueue.put(async () => {
      const tx = this.#rootDB.transaction('data', 'readwrite');
      for (const container of this.#containers) {
        container.db = tx.store;           // Point all containers at this IDB tx
      }
      const runningPromise = callback();   // Start callback (NOT awaited)
      await tx.done;                        // Wait for IDB tx to auto-commit
      for (const container of this.#containers) {
        container.db = undefined;          // Clear references
      }
      return await runningPromise;
    });
}
```

The callback races with `tx.done`. This is by design — the callback's IDB operations keep the transaction alive, and `tx.done` resolves when the transaction commits. The Aztec codebase documents this constraint extensively.

### The `commitJob` callback in `pxe/src/job_coordinator/job_coordinator.ts`

```typescript
// Lines 113-117
await this.kvStore.transactionAsync(async () => {
    for (const store of this.#stores.values()) {
        await store.commit(jobId);
    }
});
```

This iterates over **all stores** (note store, sender tagging store, recipient tagging store, capsule store, anchor block store, contract store, private event store), calling `commit(jobId)` on each. Each `commit` writes that store's staged data to IDB.

### Why it fails with complex transactions

Between each `await store.commit(jobId)`, if the previous store's IDB writes have completed and no new operations are pending, the browser is free to auto-commit the IDB transaction. With simple transactions (1-2 nullifiers), the stores have little staged data and the entire loop completes quickly. With our transaction (6 nullifiers, 6 notes, 11+ logs), multiple stores have significant staged data, creating more `await` boundaries where the browser can auto-commit.

This is the exact pattern documented in `pxe/src/storage/note_store/note_store.ts` (lines 116-129):

```
// The following sequence is unsafe in IndexedDB:
//
// 1. start transactionAsync()
// 2. await readDb()          <-- OK, transaction alive because we issued DB ops
// 3. run computations        <-- OK, same microtask
// 4. await doSthNotInDb()    <-- no DB ops, browser may auto-commit
// 5. await readDb()          <-- BOOM, TransactionInactiveError
//
// Note that the real issue is in step number 5: we try to continue using
// a transaction that the browser might have already committed.
```

The `note_store.ts` and `sender_tagging_store.ts` implementations have mitigations for this (issuing dummy reads to keep transactions alive). However, the `commitJob` loop across stores does not appear to have the same mitigation — between store commits, there may be `await` points without pending IDB operations.

### Additional factor: `proveTx` re-executes

The `.send()` method calls `simulateTx()` then `proveTx()`. Both go through `#putInJobQueue` and both call `commitJob` at the end. `proveTx` re-executes the private function (line 743: `await this.#executePrivate(...)`) before proving. This means the complex contract execution happens twice, and `commitJob` runs twice — doubling the exposure to the timing issue.

## Evidence This Is Not Concurrent Access

- The PXE's "concurrent execution is not supported" warning does NOT appear in the console
- All `.simulate()` calls are sequential (no `Promise.all`)
- No other PXE operations are visible in the log during the 12-second simulation window
- The error occurs during `commitJob`, which runs inside the PXE's serial job queue

## Workaround

We've implemented retry logic around `.send()` calls, which works because the IDB timing issue is non-deterministic. However, this adds latency and is not a proper fix.

## Suggested Fix

The `commitJob` callback in `job_coordinator.ts` could use the same mitigation pattern as `note_store.ts` — issuing a dummy IDB read between store commits to keep the transaction alive:

```typescript
await this.kvStore.transactionAsync(async () => {
    for (const store of this.#stores.values()) {
        await store.commit(jobId);
        // Issue a dummy read to keep the IDB transaction alive
        // (same pattern as note_store.ts and sender_tagging_store.ts)
    }
});
```

Or alternatively, the `transactionAsync` implementation could be restructured to not race the callback against `tx.done` — for example, by awaiting the callback first and then awaiting `tx.done`, or by using a pattern that guarantees the transaction stays alive for the entire callback duration.

## Related Code References

| File | Lines | Description |
|------|-------|-------------|
| `kv-store/src/indexeddb/store.ts` | 164-185 | `transactionAsync` — the racing pattern |
| `kv-store/src/indexeddb/map.ts` | 28-30 | `db` getter — fallback opens new tx when `#_db` is undefined |
| `pxe/src/job_coordinator/job_coordinator.ts` | 113-117 | `commitJob` — iterates stores with `await` between each |
| `pxe/src/storage/note_store/note_store.ts` | 116-129 | Documents the IDB auto-commit constraint |
| `pxe/src/storage/tagging_store/sender_tagging_store.ts` | 73-75 | Documents same constraint, uses dummy reads as mitigation |
| `pxe/src/pxe.ts` | 327-346 | `#putInJobQueue` — serial queue + commitJob |
| `pxe/src/pxe.ts` | 732-802 | `proveTx` — re-executes private function, calls commitJob |
