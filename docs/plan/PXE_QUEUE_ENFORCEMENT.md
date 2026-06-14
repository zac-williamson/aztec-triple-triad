# PXE access: make the serial queue the ONLY door (Zac directive, urgent)

**Why (two linked defects Zac flagged):**
1. **Flake:** `useAztec.ts:172-220` `refreshTokenBalance` calls `get_balance().simulate()`
   **directly** (not via `txManager.enqueuePxe`) and fires it in a 15× timer poll on every
   connect. That unqueued read races queued PXE ops → IndexedDB `TransactionInactiveError`
   (violates ground rule #6, all PXE ops serial per wallet). The playtest harness was forced
   to *mask* the resulting throw (`expectEventually` retry-on-throw) — that mask is being
   ripped out in lane-8, so the flake must actually be gone.
2. **Leak (the deeper one):** `txManager.enqueuePxe` serializes PXE ops, but `contracts.ts`
   **exports `contractCache`** with the raw `gameContract`/`nftContract`/`tokenContract` (+
   `wallet`). Any module can import it and `.simulate()/.send()` directly, bypassing the
   queue. The invariant "all PXE access is serialized" is convention-only — a leaky
   abstraction. It already broke (defect #1). Fix it **structurally** so masking is never
   needed again.

**Goal:** it must be structurally impossible to touch the PXE except through the serial queue.

## Stage 1 — stop the bleeding (do FIRST, commit, STATUS)
- Route `refreshTokenBalance`'s `get_balance().simulate()` through `txManager.enqueuePxe`.
- Audit every other autonomous/timer-driven read and enqueue it too.
- Ship a test that fails if `refreshTokenBalance` runs unqueued.

## Stage 2 — enforce the invariant (the real fix)
1. **Stop exporting raw contracts/wallet.** `contractCache` becomes private to the PXE module
   (extend `txManager`, or a new `pxe.ts` that owns BOTH the contracts and the queue).
2. **Export ONLY queued operations.** Preferred: named ops — `readTokenBalance(addr)`,
   `readPrivateCards(addr)`, `readGameStatus(id)`, `getNoteNonce(addr)`, `send<Tx>(…)`, … —
   each `enqueuePxe(() => contract.methods.x().simulate()/send())`. Callers never receive a
   contract instance. (A generic `run(fn)` gate is NOT acceptable alone: the contract handed
   to `fn` can be captured into an outer variable and reused unqueued. Use named ops, or the
   Proxy in step 3.)
3. **Optional hardening (exfiltration-proof):** wrap each contract in a `Proxy` whose
   `.methods.*().simulate()/.send()` auto-route through `enqueuePxe`, so even an escaped
   reference serializes. Raw instances never leave the factory.
4. **Migrate ALL callers:** `useAztec`, `useGameSession`, `noteImporter`, `connectToAztec`,
   `useGameSettlement`. (`testkit/api.ts` already enqueues — point it at the same ops.)
5. **Add an ESLint guard:** `no-restricted-syntax` banning `.simulate(`/`.send(` and
   `no-restricted-imports` banning the raw-contract module — everywhere EXCEPT the one PXE
   module. CI fails on any future unqueued read.
6. **Remove the now-dead error-swallowing that only existed for the race:**
   `refreshTokenBalance`'s `catch → console.warn` and the scattered
   `refreshTokenBalance().catch(()=>{})` in `useGameSettlement.ts`/`useGame.ts`. Once
   serialized, reads don't throw from IDB conflicts — let real errors surface.

## Acceptance
- No `.simulate(`/`.send(` outside the PXE module (lint-enforced).
- `refreshTokenBalance` (and all reads) demonstrably run through the queue.
- A test that fails if a PXE op runs outside the queue.
- `tsc --noEmit` clean; the 9 existing frontend test files still pass.

This removes the flake (so the harness never masks it) AND the leak (so the queue cannot be
bypassed). Recommended scope: Stage 1 + Stage 2 steps 1-2-4-5-6; step 3 (Proxy) only if you
want capture-proofing too. STATUS with your plan before the big refactor.
