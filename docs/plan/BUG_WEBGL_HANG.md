# Campaign hung at WebGL Context Lost (orchestrator finding, 06-13)

The full 5-game real-proof run HUNG before reaching a single game move. Orchestrator
killed the zombie stack (all ports free: 8080/8545/5174/3000/3001). Do NOT just re-run —
two real problems must be fixed first.

## Verified evidence (from the dead run's artifacts)
- `run-*/browser-alice.log` + `browser-bob.log` both FROZE at ~22:10, identical pattern:
  `[noteImporter] Card pack: Imported 10 notes` → `THREE.WebGLRenderer: Context Lost.`
  → a burst of `[PXE-TRACE] ensureContracts called (cached=true)` → then **25 min of total
  silence**. The page died.
- `run-*/sandbox.log` kept producing blocks but every one is **`txCount:0`** — ZERO
  transactions after the pack mints. The campaign never reached a single `game_move`.
- So: both players opened packs (15 cards ✓), then the page lost its WebGL context at the
  pack→menu→game transition and froze. Same failure class as the pre-MenuScene-off hangs.

## Problem 1 — WebGL Context Lost RECURS despite `MenuScene off`
`MenuScene off` was insufficient. Root-cause which it is (don't guess, instrument):
- **Context LEAK** — R3F `<Canvas>`/`WebGLRenderer` not disposed on scene switch
  (pack-opening scene → menu → game scene), so live contexts pile up until the browser
  kills the oldest (Chrome caps ~16 live WebGL contexts). If so this is an **APP bug**
  (a real user opening packs + playing several games would hit it too) — a finding for
  lane-2/lane-6 to fix (dispose renderers / `gl.dispose()` on unmount), NOT a harness
  workaround. Verify by counting live contexts (`WEBGL_lose_context`, or log on
  renderer create/dispose).
- **Two-tab GPU exhaustion** — two headless tabs sharing one ANGLE/Metal GPU process
  exceed the context budget. If so, fix the HARNESS: run each player in a **separate
  browser process** (`chromium.launch()` twice → one `browser` per player), not two
  contexts in one browser. That isolates GPU/context budgets per player.

Diagnose leak-vs-exhaustion first; the fix differs and one of them is an app bug to file.

## Problem 2 — the hang-guards did NOT fire
A 25-min dead-page stall MUST fail-fast; it didn't. `withDeadline` (pack 15m / game 25m)
and `withTimeout` (pxeRead 180s) should have thrown long ago. Find why a `page.evaluate`
on a context-lost page slipped both guards (does the evaluate hang un-raced? is the phase
deadline not wrapping the post-pack asserts? is `Promise.race` not rejecting?). The
de-masking made thrown reads fatal — but a HANG is not a throw. The guards are the only
backstop against a dead page; make them actually catch it (add a Playwright
`page`/`context` close/crash listener that rejects in-flight waits, and/or a hard
per-step deadline that fires even if `page.evaluate` never returns).

## Then
Re-run the C-multi campaign clean. Report the per-game table or the first real carryover
failure — the actual multi-game bug class is still NOT reached; every blocker so far has
been harness/environment, and this is one more. Fix it for real, no masking.

---

## RESOLUTION (lane-8, 06-13)

### Problem 1 — root cause: shared GPU process (HARNESS bug, not an app leak)
Instrumented + measured, did not guess. **Decisive evidence**: across two independent
frozen runs the two tabs lost their WebGL context essentially *simultaneously* —
`alice 16:17:41.308Z / bob 16:17:41.324Z` (16 ms apart) and `alice 10:00:41.859Z /
bob 10:00:41.803Z` (56 ms apart) — then both froze at the same instant ~90 s later.
Independent per-tab R3F dispose leaks would desync (each tab hits its own limit at its own
time); a *simultaneous* loss across both tabs is the signature of one **shared GPU process
dying and taking both contexts with it**. The harness ran both players as
`browser.newContext()` in ONE Chromium process → ONE GPU process; sustained ClientIVC
proving (CPU pinned for minutes) starves it until the context is lost. So this is the
bug doc's "two-tab GPU exhaustion", NOT a per-tab app leak — nothing to file against
lane-2/lane-6.

**Fix (harness):** one isolated Chromium *process* per player (`src/browser.ts`
`launchIsolatedBrowser` → `PlayerDriver.launch`), so each player owns its GPU/context
budget and one player's proving can't kill the other's renderer. Plus a WebGL context
probe (`installWebglProbe`, injected via `addInitScript`) that counts created/lost/live
contexts and is logged per phase (`[webgl@after-packs]`, `[webgl@after-game-N]`) — this
confirms live-count stays low (crash-under-load), not climbing (which would mean a leak).
Combined with the already-landed MenuScene-off + pack-explosion-Canvas-off, each process
holds at most ONE live WebGL context (the game SwampScene) during play.

### Problem 2 — root cause: guards fired only at the full proof budget
`withDeadline` (15/25 min) and `withTimeout` (180 s) *do* fire (Node-side timers, page-state
independent) — but only at the happy-path proof-budget ceiling. A wedged-after-context-loss
page *limps* (answers slow `ensureContracts` retries, makes zero real progress), so nothing
detected it faster than the 25-min game budget.

**Fix (harness):** a liveness watchdog per driver (`startWatchdog`) that declares the page
dead — failing the run in ~2 min — on any of: (a) `page.on('crash')` (immediate),
(b) a WebGL context lost-and-not-restored for >120 s (the exact diagnosed mode; healthy
losses restore in <1 s and legit proving never loses a context, so no false positive),
or (c) ~60 s of unanswerable liveness pings. It rejects a `driver.dead` promise that both
`withDeadline` and the `waitPhase` primitive race against, so a dead page aborts in-flight
waits instead of stalling the budget.
