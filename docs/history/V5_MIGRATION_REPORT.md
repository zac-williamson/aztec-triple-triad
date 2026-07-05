# Axolotl Arena — Aztec v4 → v5 Migration Report

_Status as of 2026-06-24. Audience: Aztec-literate, but new to this app._

---

## 1. What the app is (one paragraph)

**Axolotl Arena** is a two-player Triple Triad card game built on Aztec. Cards are
**private NFTs**; a match is played **off-chain**, peer-to-peer over a WebSocket
relay, with one **client-side ZK proof per move**. Only **three transactions
touch the chain per game**:

1. `create_game` — player 1 (P1) commits their five-card hand and opens a game.
2. `join_game` — player 2 (P2) commits their hand and joins.
3. `process_game` (we call it "settle") — recursively verifies the whole proof
   transcript (2 hand proofs + 9 move proofs) inside one private function, then
   transfers the wagered card and pays token rewards.

Everything else (matchmaking, the 9 moves, score-keeping) happens off-chain. So
"does the app work on v5" really means: **can two browsers create, join, play, and
settle a game against the live v5 testnet, reliably.**

---

## 2. The migration itself — DONE

The protocol jumped from v4 to **v5.0.0-rc.1** (v4 and v5 nodes can't share a
network), which left the app stranded. The migration bumped the entire matched
toolchain and redeployed:

| Component | Before | After |
|---|---|---|
| Aztec CLI / `@aztec/*` packages | 4.3.1 | **5.0.0-rc.1** |
| Noir (`@noir-lang/noir_js`, `nargo`) | 1.0.0-beta.21 | **1.0.0-beta.22** |
| `aztec-nr` git tags (contracts + circuits) | v4.3.1 | **v5.0.0-rc.1** |
| Node RPC endpoint | `rpc.testnet.aztec-labs.com` (v4) | **`v5.testnet.rpc.aztec-labs.com`** |

Work performed and completed:

- Bumped the version set everywhere (npm packages, `Nargo.toml` git tags, `.aztecrc`).
- Recompiled the three contracts and the standalone circuits; fixed the Noir API
  breaks the v5 compiler surfaced (proof/verification-key shapes, hashing, custom
  notes, storage-slot lookups).
- Fixed the TypeScript client breaks against the v5 SDK until typecheck and unit
  tests were green.
- Redeployed fresh contracts to the v5 testnet (a clean start — players re-mint
  starter cards; the in-browser PXE database also auto-wipes across the schema
  change, resetting every wallet regardless):

  | Contract | Address (v5 testnet) |
  |---|---|
  | NFT (cards) | `0x2b6ed04d7d177874e625526aa5ccbfe87ac36fa2651608620f8a64910b703553` |
  | Game | `0x011143a384776540426567dbfaef43afac23afe21528a86c2752c4baad93e3b0` |
  | Token (rewards) | `0x0c72bda092a9977984c7ffa8d2065d4c8955cc545317ea372d424f9b6235395c` |

- Shipped the rebuilt frontend to Vercel production; it serves the v5 build.

The migration landed on the `testnet` branch (commit `b8c4b8d`), followed by two
fixes for v5-testnet realities: producing empty L2 blocks so L1→L2 Fee Juice
bridging completes on the local sandbox (`093ea64`), and retrying account
deployment when the rc testnet prunes the anchor block during the long bridge
wait (`f28640f` — this becomes important below).

**Bottom line:** the app is migrated and live on v5. What remained — and what most
of this report is about — is *validating* the full game path end-to-end and the
problems that surfaced while doing so.

---

## 3. How we validate — the playtest harness

To prove the path works without a human clicking through two browsers, there is a
**Playwright harness** that drives **two real headless browsers** (we call the
players "alice" and "bob"), clicking actual UI elements, generating **real
client-side proofs**, and playing **five consecutive games** against the live v5
testnet. It uses **pre-funded accounts**: a provisioning script bridges Fee Juice
from an L1 treasury, deploys each account, and mints its starter cards + a card
pack ahead of time, then injects them into the browser.

This harness is the yardstick. The reference point throughout has been: **the v4
version of this same harness ran end-to-end with no flakes.** So any v5 flake is a
regression to be explained, not waved away.

---

## 4. Problems encountered

### 4.1 A "draw" that looked like a bug — RESOLVED (not a bug)

The first v5 playtest ended a game in a **5–5 draw**, which never happened on v4.
Cause: in v5 the **nullifier secret key is derived from verification keys** (the
cryptography changed). That key feeds the per-player randomness that determines
which cards a pack contains, so the two players simply drew **different decks**
than they would have on v4, and one game happened to tie. It's a legitimate game
outcome, not a defect — but it exposed that the app had no way to *settle* a draw.

### 4.2 Draw settlement — a real design fix (and a lesson about failing transactions)

A draw still has to settle on-chain: both wagered hands must be returned and both
players paid. The first implementation had **both players fire `process_game`**
("both attempt"). That is wrong by construction: a game settles **once**, so the
second transaction *always* hits an already-settled game and **reverts**. The
initial response was to pattern-match that revert and treat it as benign — i.e.
to mask a failing transaction.

That was the wrong instinct and was corrected: **a reverting transaction is a
failure, not something to paper over.** The design was changed to a
**single-settler** model — exactly mirroring how the win path already works: the
**winner** sends the one settle transaction; the **loser never sends a
transaction at all**, it just receives its re-minted cards via the relay. For a
draw, one designated player (P1) settles and relays the other's cards. One
transaction, it succeeds, nobody reverts. (If the settler drops offline, the
game's existing abandonment path covers it.)

### 4.3 The rate-limiter — a regression I introduced, then misattributed — RESOLVED

This is the most important entry, and it was a self-inflicted wound.

**The symptom:** some testnet runs failed with what the browser reported as "CORS
errors." The v5 RPC sits behind a gateway that caps requests at **300 per minute
per IP**, and a 429 (rate-limited) response lacks the CORS header, so the browser
mislabels it. I concluded the harness was exceeding the cap and **added a
client-side rate-limiter** that throttled each browser's outgoing requests.

**Why that was wrong, two ways:**

1. **It wasn't needed.** When I finally *measured* the actual request rate, two
   browsers sharing one IP peaked at **~188 requests/min — nowhere near the 300
   cap.** The occasional 429s were rare, transient, and **already retried
   successfully by the SDK's own fetch layer**. A clean run takes 44 of them in
   stride and still passes. I had built a governor for a problem that essentially
   wasn't there.

2. **It actively broke things.** The in-browser PXE issues bursts of requests
   while proving and syncing. Throttling them below the natural rate didn't just
   slow the bulk reads — it **delayed the critical calls too** (chain-tip sync,
   transaction-receipt polling, transaction submission). A starved sync means the
   PXE falls behind the chain, so it "can't find" a transaction that did land, or
   builds a transaction against a stale anchor that then gets dropped. In other
   words, the throttle *manufactured* the very "dropped / not-found / reorg-looking"
   failures I was seeing.

**And then I compounded it:** I attributed those throttle-induced failures to
"v5 testnet instability." That was wrong and unfair to the testnet. The correct
diagnosis only emerged after (a) removing the throttle entirely and reverting to a
**vanilla node client** — identical to what a single real player and the v4
harness use — and (b) confirming a vanilla run plays and settles **5/5 games in
normal time**, with the 429s harmlessly retried.

**Resolution:** the rate-limiter and the request-batching that came with it are
**removed**. The node client is back to stock. The lesson: a single two-minute
measurement of the real request rate would have prevented the entire detour.

### 4.4 Account-provisioning flakiness on the rc testnet — MITIGATED

The pre-funding script (bridge Fee Juice → deploy account → mint cards)
occasionally failed because the **rc testnet is slow to include or prune-happy**:
a deploy transaction would time out waiting to be mined, then actually land late,
so a retry hit a "nullifier conflict" (the account already existed). These are
genuine transient conditions on a release-candidate network. The script's existing
deploy-retry was extended to recognize the slow-mine timeout and the late-land
("already deployed") case, so provisioning recovers instead of aborting.

---

## 5. Current state

- **Migration:** complete; app is live on v5 (Vercel production serves the v5 build).
- **Core game path:** **works.** A vanilla two-browser run has played and settled
  **five consecutive games** end-to-end against the live v5 testnet in ~10 minutes.
- **The rate-limiter regression:** removed; node client is back to stock.
- **Draw settlement:** rebuilt as single-settler (no failing transaction);
  unit-tested.
- **Typecheck + unit tests:** green across the frontend.

---

## 6. Outstanding issues

### 6.1 The "anchor-pruning wedge" on the idle joiner — MAIN OPEN ISSUE

This is the real, remaining cause of harness flakiness, and it is now diagnosed
precisely.

In the two-player harness, the **joining player (P2) sits idle for ~40 seconds**
while waiting for P1's `create_game` to be mined. During that idle wait, **P2's
PXE falls behind the chain tip** — its fully-synced anchor block lags well behind
the block it has *polled*. The rc testnet **prunes** old blocks aggressively, so
by the time P2 builds its `join_game`, the block its proof is anchored to has been
pruned. The node rejects the world-state query for that block hash, and — the
nasty part — **P2's PXE then wedges**: the very sync that would advance it past the
pruned block re-queries that same dead block hash and throws. P2 re-anchors to the
identical dead block on every attempt and the join never recovers, so the run
fails. (Observed directly: the same anchor hash on three consecutive attempts.)

**Why this is harness-specific (and consistent with "a single player is fine"):**
a real solo player never idles waiting for a second player, so its anchor stays
fresh and never gets pruned. The harness is also two heavyweight browsers sharing
**one machine's CPU**; the leading hypothesis is that while one browser is
CPU-pinned generating a proof, the other's background sync starves and slips out
of the node's narrow prune window.

**What does _not_ fix it:** a retry-after-the-fact. Once the anchor is pruned the
PXE is wedged, so re-proving just re-anchors the dead block. (An earlier attempt
to "wait and retry" was also flawed because the wait was a passive sleep *inside
the PXE's serial operation queue* — it held the queue and blocked the very sync it
was waiting for.)

**Fix direction (not yet implemented):** keep P2's PXE actively synced *during* the
idle wait so its anchor never goes stale in the first place — and/or reduce the
two-browsers-on-one-CPU contention. The open question is the cleanest way to force
a joiner-side sync through the wallet/PXE API; this is the next concrete step.

### 6.2 Harness reliability

The two-browser testnet harness is currently roughly **one run in three green**.
The failures are the wedge above, plus the occasional genuinely-transient network
blip (one run hung on a momentary IPv6 connect-timeout to the RPC; IPv6 and IPv4
to the endpoint are both healthy under direct test). The core game logic is not in
question — a single clean run settles all five games — it's the harness's
two-idle-coordinated-browsers shape that exposes the edge cases.

### 6.3 Draw settlement not yet validated end-to-end on testnet

The single-settler draw path is built and unit-tested, but a draw is
deck-determined and not reproducible on demand, so it hasn't yet completed a full
testnet run. (When a draw did occur on an earlier build, the settlement
transaction itself succeeded on-chain — the failures around it were the
since-removed throttle and a test-harness wait that didn't apply to draws.)

### 6.4 Uncommitted work

The migration itself is committed (`b8c4b8d` and follow-ups). The
validation/cleanup work from this effort is **still in the working tree, not yet
committed**: the rate-limiter removal, the single-settler draw, the provisioning
retry hardening, and the harness/test changes. There is also a temporary RPC-rate
measurement probe in the harness that should be removed or formalized before commit.

---

## 7. Honest assessment and lessons

- **The migration is sound.** The contracts, circuits, and client are on v5, the
  app is deployed, and the core game path demonstrably works against the live
  network.
- **The biggest time sink was self-inflicted:** a rate-limiter built for a cap
  that wasn't being hit, which then starved the client and produced failures I
  wrongly blamed on the network. Measuring the real request rate first would have
  avoided it. Removed.
- **The one genuine open bug** is the idle-joiner anchor-pruning wedge — a real
  interaction between the harness's coordination pattern, shared-CPU contention,
  and the rc testnet's aggressive pruning. It is precisely diagnosed and has a
  clear fix direction (keep the idle joiner synced), but is not yet implemented or
  validated.
- **Caveat:** this is a release-candidate testnet. Some transient slowness and
  pruning behavior is the network's, not the app's, and should ease as v5
  stabilizes — but the app should still be made resilient to it rather than
  depend on it.
