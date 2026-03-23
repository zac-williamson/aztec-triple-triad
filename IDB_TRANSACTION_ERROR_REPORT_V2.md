# TransactionInactiveError Investigation Report (V2)

## Error

```
TransactionInactiveError: Failed to execute 'get' on 'IDBObjectStore': The transaction is inactive or finished.
  #contextualizeError (@aztec_wallets_embedded.js:18606)
  (anonymous function) (@aztec_wallets_embedded.js:18985)
```

Caught by: `[useGame] On-chain game creation failed:` at `useGame.ts:467`

## What the Console Log Tells Us

The error happens during `create_game` — **not** during settlement. The sequence is:

```
1. create_game pipeline starts
2. get_note_nonce().simulate()       → OK (~1s)
3. preview_game_data().simulate()    → OK (~0.35s) [now sequential — fix was applied]
4. get_game_status().simulate()      → OK
5. compute_blinding_factor().simulate() → OK
6. get_private_cards().simulate()    → OK (diagnostic)
7. create_game().send() starts       → simulation runs (~12s)
   ├── "Simulating transaction execution request..."
   ├── ...12 seconds of contract execution...
   └── "Simulation completed for ... in 12182ms"
8. IMMEDIATELY AFTER simulation completes:
   [Error] TransactionInactiveError
9. Pipeline catch handler fires, sets phase='idle'
10. Effect re-fires, starts second attempt
11. Second attempt also fails identically
```

Key observations:
- The simulation **succeeds** (12s of contract execution completes)
- The error occurs **immediately after** — during the `commitJob` or `proveTx` step
- No concurrent PXE operations are visible in the log (no overlapping simulation requests)
- The PXE's "concurrent execution" warning does NOT appear

## The Code Path That Fails

### `.send()` Internally Calls PXE Twice

When `gameContract.methods.create_game(...).send()` is called, the SDK does:

1. **`simulateTx()`** — simulates the full transaction (12s for our complex contract)
   - Goes through `PXE.#putInJobQueue()` → `jobCoordinator.beginJob()` → simulation → `commitJob()` → `transactionAsync()`
2. **`proveTx()`** — re-executes the private function AND generates the ZK proof
   - Goes through `PXE.#putInJobQueue()` again → sync → `#executePrivate()` → `#prove()` → `commitJob()` → `transactionAsync()`

Both steps use the PXE's serial job queue and are sequential. The error occurs during step 2's `commitJob`.

### The `commitJob` → `transactionAsync` Pattern

```
pxe.ts:343     → jobCoordinator.commitJob(jobId)
job_coordinator.ts:113 → kvStore.transactionAsync(callback)
indexeddb/store.ts:164 → transactionAsync<T>(callback):
```

```typescript
// indexeddb/store.ts lines 164-185
transactionAsync<T>(callback: () => Promise<T>): Promise<T> {
    return this.#txQueue.put(async () => {
      const tx = this.#rootDB.transaction('data', 'readwrite');
      for (const container of this.#containers) {
        container.db = tx.store;           // (A) Point all maps at this IDB tx
      }
      const runningPromise = callback();   // (B) Start callback (NOT awaited)
      await tx.done;                        // (C) Wait for IDB tx to auto-commit
      for (const container of this.#containers) {
        container.db = undefined;          // (D) Clear references
      }
      return await runningPromise;         // (E) Return callback result
    });
}
```

The callback (which writes staged job data to IDB) races with `tx.done`. The IDB transaction auto-commits when no pending read/write operations exist. If the callback has internal `await` points between IDB operations, the browser can auto-commit the transaction at those points.

### The `commitJob` Callback

```typescript
// job_coordinator.ts lines 113-117
await this.kvStore.transactionAsync(async () => {
    for (const store of this.#stores.values()) {
        await store.commit(jobId);  // Each store writes staged data to IDB
    }
});
```

There are **multiple stores**: note store, tagging store (sender + recipient), capsule store, anchor block store, contract store, private event store. Between each `await store.commit(jobId)`, if the previous store's IDB writes have completed and no new ops are pending, the browser can auto-commit.

## Why Our App Triggers This and Others Don't

### Transaction Complexity

Our `create_game` function generates an unusually large amount of staged data:

| Operation | Nullifiers | Notes Created | Events |
|-----------|-----------|---------------|--------|
| Typical token transfer | 1-2 | 1-2 | 0-1 |
| Our `create_game` | **6** (5 cards + 1 nonce) | **1** (new nonce) + **5 partial notes** | Multiple |

The PXE documentation in `note_store.ts` (lines 116-129) explicitly warns about IDB auto-commit:

```
// The following sequence is unsafe in IndexedDB:
// 1. start transactionAsync()
// 2. await readDb()          ← OK
// 3. run computations        ← OK (same microtask)
// 4. await doSthNotInDb()    ← browser may auto-commit
// 5. await readDb()          ← BOOM, TransactionInactiveError
```

With 6 nullifiers, 5 partial notes, and extensive tagging data, the `commitJob` callback iterates over more stores with more data. Each store's `commit()` may involve computation between IDB writes, creating more opportunities for the unsafe pattern above.

### The 12-Second Simulation

The simulation takes 12 seconds because:
- `create_game` is a private function that cross-calls the NFT contract
- The NFT contract reads and nullifies 6 notes (5 cards + 1 nonce note)
- It creates 5 partial notes and 1 new nonce note
- Each note operation involves PXE oracle calls and note discovery

During this 12-second simulation, the PXE processes many blocks of data that get staged. When `commitJob` finally runs, it has a large amount of staged data to write, increasing the probability of the auto-commit timing issue.

### The `proveTx` Re-Execution

After `simulateTx` completes and commits its job, `proveTx` starts a **new** job that re-executes the entire private function. This means the commit phase happens twice. The second commit (after proving) has even more data (the proof itself). The timing window for the IDB auto-commit race increases with each additional store commit.

## What Other Aztec Apps Do Differently

1. **Simple transactions**: 1-2 nullifiers, 1-2 notes. The commit phase is fast, fewer stores have staged data, less opportunity for IDB auto-commit.

2. **No cross-contract calls**: Most dApps call a single contract. Our game calls `TripleTriadGame` which internally calls `TripleTriadNFT`, doubling the execution complexity.

3. **Fewer notes per transaction**: Token transfers move 1 note. Our game nullifies 5 card notes + 1 nonce note and creates 5 partial notes + 1 new nonce note = 12 note operations.

## The Pipeline Retry Makes It Worse

When the first `create_game` fails, the error handler resets `onChainPhaseRef.current = 'idle'`:

```typescript
// useGame.ts line 467 (catch handler)
onChainPhaseRef.current = 'idle';
```

This causes the consolidated effect to re-fire on the next render and start a **second** `createGameOnChain()`. The second attempt hits the same IDB timing issue. The log confirms both attempts fail identically.

## Resolution Steps

### Step 1: Add Retry Logic with Backoff

Wrap the `.send()` call in a retry mechanism. The `TransactionInactiveError` is a timing issue — retrying often succeeds because browser IDB transaction timing varies:

```typescript
async function sendWithRetry(sendFn: () => Promise<any>, maxRetries = 3): Promise<any> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await sendFn();
        } catch (err) {
            if (err instanceof Error && err.message.includes('TransactionInactiveError') && attempt < maxRetries - 1) {
                console.warn(`[retry] IDB TransactionInactiveError on attempt ${attempt + 1}, retrying...`);
                await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
                continue;
            }
            throw err;
        }
    }
}
```

Apply this to every `.send()` call in `createGameOnChain`, `sendJoinGameTx`, and `handleSettle`.

### Step 2: Don't Reset Phase to 'idle' on TransactionInactiveError

The current error handler resets the phase, causing the pipeline effect to retry automatically. This creates a retry loop without backoff. Instead, set the phase to `'error'` for IDB errors and let the retry logic in step 1 handle retries:

```typescript
// In the pipeline catch handler:
onChainPhaseRef.current = err.message?.includes('TransactionInactiveError') ? 'creating' : 'idle';
```

Or better: don't reset to `'idle'` at all — require explicit user action to retry.

### Step 3: Reduce Transaction Complexity (Optional, Longer-Term)

Consider splitting `create_game` into two transactions:
1. First tx: commit cards (nullify 5 card notes, create partial notes)
2. Second tx: register game (emit game creation event)

This reduces per-transaction staged data, lowering the probability of IDB auto-commit races.

### Step 4: Report to Aztec Team

The root cause is in `transactionAsync` (kv-store/src/indexeddb/store.ts). The pattern of racing `callback()` against `tx.done` is fragile when the callback has multiple `await store.commit(jobId)` calls. A fix in the PXE would be to ensure the callback completes all IDB operations within a single microtask, or to use a more robust transaction management pattern.

File an issue referencing:
- `kv-store/src/indexeddb/store.ts` lines 164-185 (`transactionAsync`)
- `pxe/src/job_coordinator/job_coordinator.ts` lines 113-117 (`commitJob`)
- `pxe/src/storage/note_store/note_store.ts` lines 116-129 (the documentation of this exact issue)

The Aztec team is aware of IDB auto-commit issues (see the extensive comments in `note_store.ts` and `sender_tagging_store.ts`) but the `commitJob` flow may not have the same mitigations.
