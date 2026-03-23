# IDB TransactionInactiveError — Investigation Status

## What We've Proven

1. **The full app PXE flow succeeds in headless browsers** — both Chromium and WebKit (Safari engine) pass with the exact same sequence of PXE calls the app makes
2. **Concurrent PXE access doesn't trigger the bug** — even with 34 concurrent `.simulate()` calls during `.send()`, the PXE's SerialQueue serializes them correctly
3. **The isolated test matches the app flow step-for-step**: wallet creation → SponsoredFPC → account deploy → contract registration → card minting → note import (5x simulate) → card fetch → preview pipeline (4x simulate) → `create_game().send()`

## What's Different Between the Test and the App

The test does everything the app does EXCEPT:

1. **No second player** — In the real app, Player 2 is in a separate browser tab, deploying their own account, minting their own cards, running their own PXE. The shared Aztec sandbox is processing both players' transactions. This produces more blocks between P1's card mint and P1's `create_game`, meaning the PXE's `blockStateSynchronizer.sync()` has more blocks to process during `proveTx`.

2. **No React rendering loop** — The app runs React effects that fire on state changes. When `setBlindingFactor`/`setOnChainGameId`/`setGameRandomness` are called inside `createGameOnChain` (before `.send()`), React schedules re-renders. During the subsequent `await .send()`, React flushes these batched state updates and re-evaluates effects. None of these effects call PXE methods directly, but the re-renders themselves consume CPU time and cause microtask queue processing, which could affect IDB transaction timing.

3. **No WebSocket activity** — The app has an active WebSocket connection receiving game state updates, opponent info, etc. Message handlers trigger `setState` calls, which trigger re-renders, which trigger effect re-evaluations.

4. **No 3D rendering** — The app runs Three.js/React Three Fiber rendering (including FBX model loading). The console log shows `THREE.WebGLRenderer: Context Lost` during the create_game flow, indicating heavy GPU pressure that could affect main thread timing.

## The `sendTx` Internal Flow

```
wallet.sendTx(executionPayload, opts)
  → completeFeeOptions()        // node RPC: getCurrentMinFees()
  → createTxExecutionRequest()  // walletDB IDB read: retrieveAccount()
  → pxe.proveTx(txRequest)     // PXE job: sync → simulate → prove → commitJob
  → aztecNode.sendTx(tx)       // node RPC: submit proven tx
  → waitForTx(txHash)          // polls node until tx is mined
```

The `proveTx` step is the long one (~12s). It internally:
1. Enqueues a job via `#putInJobQueue`
2. Syncs blocks via `blockStateSynchronizer.sync()`
3. Syncs contracts via `contractSyncService.ensureContractSynced()`
4. Executes the private function (12s of WASM simulation)
5. Generates the ZK proof
6. Commits the job via `jobCoordinator.commitJob()` → `transactionAsync()`

## Next Steps to Reproduce

1. **Add a second EmbeddedWallet to the Playwright test** — create two wallets against the same node, have P2 mint cards while P1 runs create_game
2. **Add React-like microtask activity** — fire `queueMicrotask` callbacks during the `.send()` window to simulate React's state update flushing
3. **Add WebGL context creation** — create a canvas with WebGL context to simulate the GPU pressure from Three.js rendering
4. **Run the test multiple times** — the bug may be timing-dependent and need multiple attempts
