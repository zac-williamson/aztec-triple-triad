# TransactionInactiveError Investigation Report

## Error

```
TransactionInactiveError: Failed to execute 'get' on 'IDBObjectStore': The transaction is inactive or finished.
  line: 960, column: 27
  sourceURL: http://localhost:3000/node_modules/.vite/deps/@aztec_wallets_embedded.js

  #contextualizeError (@aztec_wallets_embedded.js:18606)
  (anonymous function) (@aztec_wallets_embedded.js:18985)
```

## Summary

This error occurs because our application calls two PXE `.simulate()` operations concurrently via `Promise.all()`. The PXE's internal IndexedDB store is not designed for this. When two PXE jobs overlap, the first job's IDB transaction commits and clears the shared `container.db` reference, causing the second job's IDB reads to fail.

---

## The IndexedDB Transaction Lifecycle (Root Cause)

IndexedDB transactions have a critical browser-enforced rule: **a transaction auto-commits when there are no pending read/write requests and a new microtask begins**. This is explicitly documented in the Aztec codebase itself.

### Documentation in `note_store.ts` (lines 116-129)

```
node_modules/@aztec/pxe/src/storage/note_store/note_store.ts
```

```typescript
// The code below might read a bit unnatural, the reason is that we need to be careful
// in how we use `await` inside `transactionAsync`, otherwise browsers might choose to
// auto-commit the IndexedDB transaction forcing us to explicitly handle that condition.
// The rule we need to honor is: do not await unless you generate a database read or
// write or you're done using the DB for the remainder of the transaction.
// The following sequence is unsafe in IndexedDB:
//
// 1. start transactionAsync()
// 2. await readDb()          <-- OK, transaction alive because we issued DB ops
// 3. run a bunch of computations (no await involved) <-- OK, same microtask
// 4. await doSthNotInDb()    <-- no DB ops, browser's free to commit the tx
// 5. await readDb()          <-- BOOM, TransactionInactiveError
```

### Documentation in `sender_tagging_store.ts` (lines 73-75)

```
node_modules/@aztec/pxe/src/storage/tagging_store/sender_tagging_store.ts
```

```typescript
// Always issue DB read to keep IndexedDB transaction alive (they auto-commit when
// a new micro-task starts and there are no pending read requests). The staged value
// still takes precedence if it exists.
```

Both of these comments confirm that the Aztec team is aware of and actively working around this IDB constraint.

---

## How the PXE Manages IDB Transactions

### The Transaction Wrapper (`kv-store/src/indexeddb/store.ts`, lines 164-185)

```typescript
transactionAsync<T>(callback: () => Promise<T>): Promise<T> {
  return this.#txQueue.put(async () => {          // (A) Queued on serial #txQueue
    const tx = this.#rootDB.transaction('data', 'readwrite');  // (B) Open IDB tx
    for (const container of this.#containers) {
      container.db = tx.store;                    // (C) Point all containers at this tx
    }
    const runningPromise = callback();            // (D) Start callback (NOT awaited yet)
    await tx.done;                                // (E) Wait for IDB tx to auto-commit
    for (const container of this.#containers) {
      container.db = undefined;                   // (F) Clear container references
    }
    return await runningPromise;                  // (G) Return callback's result
  });
}
```

Key points:
- Step (C): All map/singleton containers share a **single** `db` reference pointing to the active transaction's store.
- Step (E): `tx.done` resolves when the browser auto-commits the transaction (i.e., when no more IDB ops are pending).
- Step (F): After commit, `container.db` is set to `undefined`.

### The Container Fallback (`kv-store/src/indexeddb/map.ts`, lines 28-30)

```typescript
get db(): IDBPObjectStore<...> {
  return this.#_db ? this.#_db : this.#rootDB.transaction('data', 'readwrite').store;
}
```

When `this.#_db` is `undefined` (cleared at step F above), every `.getAsync()` call opens a **new standalone IDB transaction**. This fallback is intended for reads outside of `transactionAsync()`, but it creates a new transaction per read, which is inefficient and can conflict with an active `transactionAsync()` call.

### The PXE Job Queue (`pxe.ts`, lines 327-344)

```typescript
#putInJobQueue<T>(fn: (jobId: string) => Promise<T>): Promise<T> {
  if (this.jobQueue.length() != 0) {
    this.log.warn(`PXE is already processing ${this.jobQueue.length()} jobs,
                   concurrent execution is not supported. Will run once those are complete.`);
  }
  return this.jobQueue.put(async () => {
    const jobId = this.jobCoordinator.beginJob();
    try {
      const result = await fn(jobId);
      await this.jobCoordinator.commitJob(jobId);    // calls transactionAsync()
      return result;
    } catch { ... }
  });
}
```

Every `.simulate()` call goes through `#putInJobQueue`, which uses a `SerialQueue` to prevent concurrent execution. **However**, this serialization only protects against jobs running at the same time — it does NOT prevent two jobs from being *enqueued* simultaneously, which is exactly what `Promise.all()` does.

---

## What Happens During Our `Promise.all()` Calls

### The Offending Code (`useGame.ts`, lines 211-214)

```typescript
const [{ result: statusResult }, { result: blindingResult }] = await Promise.all([
  gameContract.methods.get_game_status(gameIdFr).simulate({ from: senderAddr }),
  nftContract.methods.compute_blinding_factor(gameIdFr).simulate({ from: senderAddr }),
]);
```

And (`useGame.ts`, lines 287-290):

```typescript
const [{ result: nonceResult }, { result: blindingResult }] = await Promise.all([
  nftContract.methods.get_note_nonce(senderAddr).simulate({ from: senderAddr }),
  nftContract.methods.compute_blinding_factor(chainGameIdFr).simulate({ from: senderAddr }),
]);
```

### The Failure Sequence

```
T0: Promise.all() starts BOTH promises immediately
    ├── Promise 1: get_game_status().simulate() → calls PXE.executeUtility()
    │   └── enqueues Job A on PXE's SerialQueue
    └── Promise 2: compute_blinding_factor().simulate() → calls PXE.executeUtility()
        └── enqueues Job B on PXE's SerialQueue (queued behind A)

T1: Job A begins executing
    ├── blockStateSynchronizer.sync() runs
    │   └── block_synchronizer.doSync() reads from IDB (anchorBlockStore.getBlockHeader())
    │       └── This IDB read uses the container fallback (standalone tx per read)
    ├── contractSyncService.ensureContractSynced() runs
    │   └── More IDB reads via container fallback
    └── Contract function executes (oracle calls read notes from IDB)

T2: Job A completes, commitJob() called
    ├── transactionAsync() opens IDB transaction
    │   └── container.db = tx.store    (all containers now point to this tx)
    ├── Staged data committed
    ├── tx.done resolves (IDB tx auto-commits)
    └── container.db = undefined       (all containers cleared)

T3: Job B begins executing
    ├── blockStateSynchronizer.sync() runs
    │   └── anchorBlockStore.getBlockHeader() calls map.getAsync()
    │       └── container.db is undefined (cleared at T2)
    │       └── Fallback: opens NEW standalone IDB transaction
    │       └── This CAN race with Job A's cleanup or with
    │           another operation that expects container.db to be set
    ├── contractSyncService.ensureContractSynced() runs
    │   └── If this triggers a transactionAsync() internally,
    │       it will set container.db, then clear it on commit
    └── Contract simulation reads notes
        └── If container.db was cleared between two reads
            by an interleaved transactionAsync() → BOOM
```

The exact failure point depends on timing, but the root cause is always the same: **`container.db` is a shared mutable reference** that gets set and cleared by `transactionAsync()`. When two PXE jobs run in sequence but were started concurrently, the cleanup of one job's transaction can invalidate references expected by the next job's reads.

---

## Why This Does NOT Happen in Typical Aztec Applications

Typical Aztec applications — wallets, DEXs, simple token transfers — interact with the PXE **sequentially**:

```typescript
// Typical pattern: sequential calls
const balance = await contract.methods.balance_of(addr).simulate();
const receipt = await contract.methods.transfer(to, amount).send().wait();
const newBalance = await contract.methods.balance_of(addr).simulate();
```

Each `.simulate()` completes before the next one starts. The PXE's `SerialQueue` handles this correctly because there's only ever one job in the queue at a time.

Our application is unusual because it runs **two independent simulations concurrently** for performance:

```typescript
// Our pattern: concurrent calls (problematic)
const [result1, result2] = await Promise.all([
  contract1.methods.foo().simulate(),
  contract2.methods.bar().simulate(),
]);
```

While `Promise.all()` doesn't bypass the PXE's `SerialQueue` (the jobs still execute one at a time), the *enqueuing* of both jobs simultaneously creates a window where:
1. The PXE logs a warning: `"PXE is already processing 1 jobs, concurrent execution is not supported"`
2. Job B starts immediately after Job A's `commitJob()` clears `container.db`
3. Job B's initial `blockStateSynchronizer.sync()` tries to read from IDB with no active `transactionAsync()` context
4. The fallback path (`this.#rootDB.transaction('data', 'readwrite').store`) opens a standalone transaction
5. This standalone transaction can auto-commit between reads if any `await` yields without a pending IDB op

The error is timing-dependent: it surfaces when the gap between Job A's cleanup and Job B's first read falls on a microtask boundary where the browser decides to auto-commit.

---

## Affected Code Paths (Both Must Be Fixed)

| Location | File | Lines |
|----------|------|-------|
| `createGameOnChain()` | `packages/frontend/src/hooks/useGame.ts` | 211-214 |
| `prepareJoinGame()` | `packages/frontend/src/hooks/useGame.ts` | 287-290 |

---

## Resolution Steps

### Step 1: Serialize the `Promise.all()` Calls

Replace concurrent simulations with sequential ones. This is the definitive fix.

**In `createGameOnChain()` (lines 211-214):**

Change:
```typescript
const [{ result: statusResult }, { result: blindingResult }] = await Promise.all([
  gameContract.methods.get_game_status(gameIdFr).simulate({ from: senderAddr }),
  nftContract.methods.compute_blinding_factor(gameIdFr).simulate({ from: senderAddr }),
]);
```

To:
```typescript
const { result: statusResult } = await gameContract.methods.get_game_status(gameIdFr).simulate({ from: senderAddr });
const { result: blindingResult } = await nftContract.methods.compute_blinding_factor(gameIdFr).simulate({ from: senderAddr });
```

**In `prepareJoinGame()` (lines 287-290):**

Change:
```typescript
const [{ result: nonceResult }, { result: blindingResult }] = await Promise.all([
  nftContract.methods.get_note_nonce(senderAddr).simulate({ from: senderAddr }),
  nftContract.methods.compute_blinding_factor(chainGameIdFr).simulate({ from: senderAddr }),
]);
```

To:
```typescript
const { result: nonceResult } = await nftContract.methods.get_note_nonce(senderAddr).simulate({ from: senderAddr });
const { result: blindingResult } = await nftContract.methods.compute_blinding_factor(chainGameIdFr).simulate({ from: senderAddr });
```

### Step 2: Audit for Other Concurrent PXE Calls

Search the entire frontend for any other `Promise.all()` patterns involving `.simulate()`, `.send()`, or any other PXE method. Every PXE interaction must be sequential.

### Step 3: Verify the Fix

After serializing the calls:
1. The PXE warning `"PXE is already processing N jobs"` should disappear from the console
2. The `TransactionInactiveError` should not recur
3. The performance impact is minimal — each `.simulate()` call for these utility functions takes ~50-200ms, so serializing adds at most ~200ms to the pipeline

---

## Architectural Rule Going Forward

**Never call two PXE methods concurrently.** The PXE's IndexedDB-backed storage uses a shared mutable `container.db` reference and the browser's IDB transaction auto-commit behavior makes concurrent access inherently unsafe. Always `await` one PXE call before starting the next.
