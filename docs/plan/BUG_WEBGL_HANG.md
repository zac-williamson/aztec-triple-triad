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

---

## ORCHESTRATOR RE-VERIFICATION (06-13) — confirmation run STILL hung; the post-pack hang is NOT WebGL, and the guards STILL didn't fire

The 2-game confirmation run (`run-2026-06-14T06-08-32`) HUNG at the same post-pack stage; I
killed it. Verified via artifacts (NOT the STATUS): both `browser-{alice,bob}.log` frozen at
content 23:16:35 / mtime 23:16, unchanged across a 5-min re-sample; sandbox `txCount:0`;
the playwright process still alive = zombie. (I nearly mis-read the first sample as "fresh" —
it was 14 s after the freeze.)

Two corrections to the RESOLUTION above:
1. **The WebGL fix worked — for WebGL.** 0 `Context Lost` this run; the probe logged
   `[webgl@after-packs] alice live=0 created=0 lost=0 | bob live=0 created=0 lost=0` — zero
   contexts created/lost. Isolated-process + Canvas-off eliminated the GPU crash. KEEP them.
2. **But the post-pack hang PERSISTS with zero WebGL involved** → the real pack→matchmaking
   freeze was NEVER (only) WebGL. The page dies right after pack-import + a burst of
   `ensureContracts called (cached=true)` (alice pack 23:16:11 → ensureContracts to 23:16:35 →
   dead). Root-cause THIS non-WebGL freeze: what runs between "pack imported" and matchmaking
   (post-pack `expectEventually(card=15/tokens=0)`, then `startMatchmaking`)? The repeated
   `ensureContracts(cached=true)` right before the freeze is the lead.

**The guards STILL did not fire (frozen ~5 min; watchdog target ~2 min, withTimeout 180 s).**
Likely cause: a frozen-page `page.evaluate` neither returns nor rejects, so any guard that
*awaits* one (the watchdog liveness ping; maybe the read path) hangs with it. FIX: every guard
must be driven by a **Node-side timer that fires regardless of page state** — the watchdog ping
must be `Promise.race([page.evaluate(ping), nodeTimeout])`, and there must be a hard per-step
Node deadline that aborts even if no page call ever returns. **Prove the watchdog fires by
testing it against a deliberately-frozen page** (don't assume).

Do NOT declare the harness fixed until BOTH: (a) a deliberately-frozen page FAILS FAST via the
guards, and (b) a clean run actually reaches the consecutive games (txCount>0, per-game table).

---

## ROUND-2 RESOLUTION (lane-8) — the guards' gap was UNBOUNDED CLICKS (proven, fixed)

Did not guess — built a frozen-page probe (`scripts/probe-frozen-guard.ts`, while(true) on the
page main thread) and measured each guard:
- `Promise.race([page.evaluate, NodeTimer])` (the read guard, `withTimeout`) **fires** at the
  timer (5001 ms) even though the frozen evaluate never returns. So reads were already covered.
- A bare `locator.click()` (no `{timeout}`) **HUNG past 6 s with no self-timeout.** ROOT CAUSE:
  **Playwright's default `actionTimeout` is 0 = UNBOUNDED**, and `use.actionTimeout` in the
  config does NOT reach contexts we launch ourselves (`PlayerDriver.launch`). `startMatchmaking`
  fires the post-pack `menu-play`/`card-select`/`hand-confirm` clicks with no timeout — so once
  the 4 pre-game reads finished (their `ensureContracts` logs end exactly at the 23:16:35 freeze),
  the very next op was an **unbounded `menu-play.click()`** that hangs until the 60-min test
  timeout. That is why "the guards didn't fire": the hang was on a click no node-timer guarded.
- A click WITH a timeout rejects at the timeout (5004 ms). Teardown does not hang (16/61 ms),
  ruling out the zombie-teardown theory.

**Fix:** `context.setDefaultTimeout(60s)` + `setDefaultNavigationTimeout(120s)` on every
launched context (`src/browser.ts`), and `actionTimeout`/`navigationTimeout` in the config for
fixture specs — so NO bare action can hang unbounded. `startMatchmaking` clicks now go through
`clickTestId`, which on failure reports the player's `screen`+`aztecStatus` (so the wedge's
cause is visible). The watchdog/read guards are kept. `probe-frozen-guard.ts` now ASSERTS all
three guard classes (read, click, watchdog) fail fast and EXITS NON-ZERO otherwise — run it to
re-prove requirement (a): **GUARD PROOF PASSED** (read 3002 ms, click 2004 ms, watchdog 3310 ms).

Requirement (b) (a clean run reaches the games) is the next step: with clicks bounded, the
re-run will fail FAST at the wedged post-pack op WITH the screen state — which finally exposes the
non-WebGL app cause (why `menu-play` won't land after packs), instead of zombie-hanging.

---

## NON-WEBGL ROOT CAUSE FOUND — a real FRONTEND bug the harness caught (req a MET)

The bounded-click re-run (`run-2026-06-14T06-46-26`) did exactly its job: it **failed FAST in
13 min** (not a zombie) at `hand-confirm` with a precise reason —
`alice: click 'hand-confirm' did not land [screen=card-selector aztec=connected
ws.connected=true matchmaking=idle cards=15]`. So `menu-play` + all 5 `card-select` clicks
landed; the aria snapshot shows **`5/5 cards selected` and the "Play!" button present and
enabled**. The trace's actionability log gives the cause verbatim:

> `<span ...>Preparing: 1m 19.2s</span> from <div class="txnc-root">…</div> subtree intercepts
> pointer events` — retried for the full 60 s, never yielded.

**Root cause (FRONTEND, lane-2 — dispatched by Zac):**
1. The **TxNotificationCenter toast** (`.txnc-root`, `position:fixed; bottom; right;
   z-index:1400`, toast `pointer-events:auto`) overlaps and **intercepts clicks on the
   CardSelector "Play!"/hand-confirm button** (`.card-selector__play-btn`, in a fixed bottom
   panel at `z-index ~15`). 1400 ≫ 15 and both bottom-anchored → the toast sits on top.
2. The **pack-purchase notification is stuck in "Preparing"** (1m19s and counting) long after the
   pack mined (15 cards imported) — it never transitions to done/clears, so the overlay persists
   and permanently blocks the button.

Multi-game/pack-specific: Phase-1's full-game never opens a pack, so no lingering pack-tx toast —
`hand-confirm` was always clickable there. This is **not WebGL and not the harness**; it is a real
post-pack UX blocker (a user who opens a pack then hits "Play" is blocked the same way).

**No masking (Zac's bar):** the harness does NOT dismiss the toast to get green (a "Hide
notifications" workaround would re-block at settlement anyway and would hide a real bug). The fix
belongs in lane-2: the toast must not intercept game-button clicks, and the pack-tx notification
must clear on completion. The harness is **STATUS: blocked** on that fix; the moment it lands and
is merged, rebase + re-run to reach the consecutive carryover games (req b).

**Guards (req a) — MET, proven twice:** synthetically (`scripts/probe-frozen-guard.ts`:
read/click/watchdog all fail fast) AND in this real run (fast, clear reason, no zombie).
