# QA Campaign Backlog

Owner: **Lane 5 (QA)** · Implementor: **Lane 8 (Playtest harness)** · Status: v1, 2026-06-12

These are the executable campaign specs for the autonomous playtest harness
(`docs/plan/PLAYTEST_HARNESS.md`). Each campaign converts a piece of manual
two-browser testing knowledge into setup + steps + assertions across four layers.
Every fact below is grounded in the code as of `lane/5-qa` @ e860ec0; file:line
references point at the source of truth so the harness never has to guess.

Environment baseline: **4.2.0-nightly.20260323 local sandbox** (harness Phase 1).
After A1/A2 land, the same campaigns re-run on 4.3.1 and serve as the upgrade's
acceptance suite. Release smoke at F3 is a separate checklist (LANE_5_QA.md §F3),
not part of this backlog.

---

## 1. Conventions (apply to every campaign)

### 1.1 Assertion layers

The brief's "three layers" are frontend / backend / chain, with chain split into
public and private:

| Layer | What | Read mechanism |
|-------|------|----------------|
| **L1 Frontend** | What each player's tab shows + that tab's app-level state | `window.__triadTest` read hooks (per-tab PXE via the app's own utilities) + DOM/HUD selectors. Testkit per PLAYTEST_HARNESS.md §2 |
| **L2 Backend** | Relay/lobby truth | `GET /health`, `GET /games`, `GET /games/{id}` (`server.ts:80-130`); Redis key reads when `REDIS_URL` set (key schema `RedisGameStore.ts:4-14`); per-tab WS message logs recorded by the testkit |
| **L3 Chain-public** | Public storage + decoded public events, read by the harness's own Node client — independent of both browsers | View fns: `get_game_status`, `is_game_settled`, `get_game_player1/2` (game `main.nr:863-906`), `public_owner_of` (nft `main.nr:941`). Events: `GameCreated`, `GameJoined`, `GameSettled`, `GameCancelled`, `GameAbandoned`, `AbandonedGameSettled` (game `main.nr:41-79`). Call shapes + decode rules: §1.7 |
| **L4 Chain-private** | Each player's private notes/balance, asserted INSIDE that player's browser context (the only place that PXE exists) | `get_nfts_for_user(addr, page)` paginated (`connectToAztec.ts:359-373`), `ArenaToken.get_balance(owner)` (token `main.nr:83`), `get_note_nonce(owner)`. Call shapes + decode rules: §1.7 |

L4 card assertions are **multiset** comparisons of token ids, not set comparisons:
duplicate token ids are legal (both players start with ids 1–5; packs can repeat
ids; `mint_for_game_loser` skips the first match only, game `main.nr:689-697`).

`CardCreated` events are encrypted and OFFCHAIN-delivered (nft `main.nr:400-403`)
— they are **not** assertable at L3. L3 sees tx inclusion + public storage + the
six public game events only.

### 1.2 Wait discipline — no sleeps

- Tx lifecycle: subscribe `txProgress` (`frontend/src/aztec/txProgress.ts`) via
  `page.exposeFunction`; phases are `simulating → proving → sending → mining →
  complete | error`, with `label` and `aztecTxHash`. Wait on phase transitions
  with generous ceilings (fast mode: 90s/tx; real-proof: 30 min for settlement).
- Relay events: wait on specific WS message types (testkit message log), never on
  time.
- Private-state convergence (note discovery, balance refresh): poll the L4 read
  hook until expected value, bounded by a ceiling — the poll is the wait
  condition, not a sleep.
- Block advancement (C3 dispute window): `advanceBlocks(n)` harness helper.
  Sandbox mines on txs, so wall-clock waiting does nothing. Implementation is
  Lane 8's choice (node cheat-code preferred, else n trivial filler txs).

### 1.3 Reset + fixture accounts

Per PLAYTEST_HARNESS.md §1, every campaign starts from: fresh contract deploy,
Redis `FLUSHDB`, fresh browser contexts with clean storage.

**Fixture accounts use pinned secrets** (secret/salt/signing key seeded into
localStorage keys per `connectToAztec.ts` before first app load), NOT random
ones. Reason: pack contents are derived from `nhk_app_secret` + note nonce
(nft `main.nr:428-432`), so pinned keys ⇒ deterministic pack cards ⇒ precomputed
move scripts stay valid across runs.

"Onboarded P1/P2" as a setup line means: the C8 flow has been run for that
account as a fixture (auto fee-juice funding on sandbox, account deploy +
`get_cards_for_new_player` — cards 1–5 + 100 tokens). C8 itself is the only
campaign where onboarding is the subject under test.

### 1.4 Economics reference (verified against code)

| Constant | Value | Contract | Frontend mirror |
|----------|-------|----------|-----------------|
| Starter cards | ids `[1,2,3,4,5]` | nft `main.nr:52` | `gameConstants.ts:38` |
| Starter tokens | 100 | nft `main.nr:411` | `gameConstants.ts:41` |
| Reward per **completed** game (win or draw) | +20 to **both** players | game `main.nr:705-706, 732-733` | `gameConstants.ts:42` |
| Abandoned-claim reward | +20 to claimant, **only if** `claimed_card_id != 0`; opponent +0 | game `main.nr:462-468` | — |
| Pack cost / size | 100 tokens / 10 cards | nft `main.nr:55, 424, 428` | `gameConstants.ts:31,43` |
| Dispute window | ≥ 5 blocks after claim | game `main.nr:494` | — |

Game status lifecycle (public, `get_game_status`): `0` none → `1` created →
`2` active → `3` settled / `4` cancelled / `5` abandoned_claimed → `3` settled.
ALL settlement paths end at `game_settled = true` + status `3`
(game `main.nr:801-802, 848-849, 511-512`).

### 1.5 The hand-size invariant (why ladder outcomes are scripted)

`create_game`/`join_game` commit exactly 5 owned card notes. Every decisive game
moves one card loser→winner. **A player holding exactly 5 cards who loses drops
to 4 and cannot play again until they buy a pack.** Consecutive-game campaigns
must therefore script per-game outcomes and schedule pack purchases so both
players always hold ≥ 5 cards and can afford the packs the schedule requires.
Move scripts are precomputed against `@axolotl-arena/game-logic` by a
fixture-gen script; each fixture self-checks that the engine's computed outcome
equals the scheduled outcome (this doubles as the rules-divergence tripwire of
PLAYTEST_HARNESS.md §3).

### 1.6 Standard check blocks (referenced as SC-*)

**SC-CREATE/JOIN** (after create or join tx `complete`):
- L1 both: phase reaches `active` (`useGame.ts:136`); board renders empty.
- L2: `GET /games/{id}` → `status: 'playing'`, both `playerConnected` flags true.
- L3: `get_game_status == 2` [U-STATUS]; `get_game_player1/2` == fixture
  addresses [U-PLAYERS]; `GameCreated` + `GameJoined` events decoded with
  matching `game_id` [U-EVENTS].
- L4 both: the 5 committed ids are **absent** from `get_nfts_for_user`
  [U-NFTS] (notes nullified into the game commitment) — the "escrowed while
  playing" property.

**SC-MOVE** (after every placement):
- L1 both: board equals the game-logic projection of the move script so far;
  turn indicator flips; capture flips rendered.
- L2: `GAME_STATE` relayed carrying the correct `gameId`; relayed opponent hands
  are sanitized — last 2 hand slots zeroed (`server.ts:194` HIDDEN_COUNT=2).
- Proof exchange: `MOVE_PROVEN` received by opponent for each move (9 total).

**SC-SETTLE-WIN** (decisive game; winner W, loser L, claimed card X):
- L1 W: result screen offers L's cards; pick X; settle tx phases
  `simulating→…→complete`; collection +X.
- L1 L: `OPPONENT_SETTLING` received with X; post-settle collection shows −X.
- L2: room `status: 'finished'`; both `player:{id}:game` mappings released
  (`GameManager.ts:203-211`); `NOTE_DATA` relayed W→L (or buffered to L's inbox
  if L offline — `server.ts:30-36`).
- L3: `get_game_status == 3` [U-STATUS]; `is_game_settled == true`
  [U-SETTLED]; `GameSettled { game_id, winner: W, loser: L,
  transferred_card_id: X }` [U-EVENTS]; **no** `public_owners` entries appear
  for any of the 10 committed ids [U-PUBOWNER] (win path is fully private).
- L4 W: inventory == prior + X (committed 5 return + X) [U-NFTS]; balance +20
  [U-BAL].
- L4 L: inventory == prior − X [U-NFTS]; balance +20 [U-BAL] (mint is
  ONCHAIN_CONSTRAINED — arrives by PXE sync, no relay needed; poll per §1.2).

**SC-PACK** (buyer B):
- L1 B: reveal screen shows exactly the 10 ids that
  `preview_card_ids(nonce).simulate()` returned **before** the tx [U-PREVIEW]
  (`useCardPacks.ts:105-124`); collection +10.
- L3: tx mined; nothing else public.
- L4 B: inventory +10 (exact ids) [U-NFTS]; balance −100 [U-BAL];
  `get_note_nonce` +10 [U-NONCE].
- L2: n/a (packs never touch the backend).

### 1.7 Chain-read utility map (L3/L4 → concrete calls)

Every chain-layer assertion in this document carries a `[U-*]` tag resolving
here, so each spec is implementable without re-deriving call shapes. Two
execution contexts:

- **in-tab** (L4): MUST run inside the owning player's browser context
  (`page.evaluate` → testkit read hook) — it reads private notes that exist
  only in that tab's PXE/IndexedDB.
- **Node** (L3): the harness's own process, independent of both browsers.
  Boot pattern U-NODE below; in-repo precedent for public reads:
  `packages/integration/tests/e2e-aztec-settlement.test.ts:417`.

| Tag | Call (TS) | Context | Returns / decode notes | Source |
|-----|-----------|---------|------------------------|--------|
| U-NFTS | `nft.methods.get_nfts_for_user(owner, page).simulate({ from: owner })` | in-tab | `[ids: [Field; MAX_NOTES_PER_PAGE], hasMore: bool]` — loop `page++` while `hasMore`, drop zero slots, compare as **multiset** of `Number(BigInt(v))`. Canonical loop: `connectToAztec.ts:359-373` | nft `main.nr:1075` |
| U-BAL | `token.methods.get_balance(owner).simulate({ from: owner })` | in-tab | u128 → compare as `BigInt`, exact equality (§1.2: poll to convergence, then assert) | arena_token `main.nr:83` |
| U-NONCE | `nft.methods.get_note_nonce(owner).simulate({ from: owner })` | in-tab | Field; **returns 0 when no nonce note exists** (pre-onboarding state) | nft `main.nr:1092-1096` |
| U-PREVIEW | `nft.methods.preview_card_ids(nonce).simulate({ from: owner })` | in-tab | `[Field; 10]`; result is msg_sender-dependent (derived from that account's keys) | nft `main.nr:448` |
| U-STATUS | `game.methods.get_game_status(gid).simulate({ from })` | Node or in-tab | Field `0–5` per §1.4 lifecycle; compare as `BigInt` | game `main.nr:869` |
| U-SETTLED | `game.methods.is_game_settled(gid).simulate({ from })` | Node or in-tab | bool | game `main.nr:863` |
| U-PLAYERS | `game.methods.get_game_player1/2(gid).simulate({ from })` | Node or in-tab | AztecAddress — compare canonically (`.equals()` / `.toString()`), never raw simulate output | game `main.nr:875-882` |
| U-PUBOWNER | `nft.methods.public_owner_of(token_id).simulate({ from })` | Node or in-tab | AztecAddress; zero address ⇒ no public owner | nft `main.nr:941` |
| U-EVENTS | `getDecodedPublicEvents` (`@aztec/aztec.js/events`) with `TripleTriadGame.events.<Name>` metadata over a block range | Node | **No in-repo usage precedent — the harness chain client builds this once.** The checked-in codegen metadata is stale (QA-F4): regenerate before building this | events: game `main.nr:41-79`; metadata: `target/codegen/TripleTriadGame.ts:217` (after regen) |

**U-NODE — harness chain-client boot:** `createAztecNodeClient(url)` →
`EmbeddedWallet.create(node, { ephemeral: true })` → typed handles
`TripleTriadGame.at(addr, wallet)` / `TripleTriadNFT.at(…)` / `ArenaToken.at(…)`
from `packages/contracts/target/codegen/` (**regenerated** — QA-F4), addresses
from the deploy step (`scripts/deploy-contracts.ts` writes `frontend/.env`).
The chain client is **read-only** (`.simulate` only) — no fee setup needed. If
it ever sends txs (e.g. C3's `advanceBlocks` filler), Fee Juice only:
`packages/integration/tests/e2e-*` still carry the banned SponsoredFPC pattern
(QA-F5) — do NOT copy their fee/deploy code.

Decode rule (ground rule 8): `.simulate()` results stringify as **decimal** —
never hex-parse them; compare via `BigInt`. In-tab `Fr` construction uses the
prefix-checking `toFr` helper (`packages/frontend/src/aztec/fieldUtils.ts`).

---

## 2. Campaign summary

| ID | Name | Guards against | Modes | Pri | Est (fast) |
|----|------|----------------|-------|-----|-----------|
| C1 | ladder-with-pack | regression of the whole core loop (Zac's scenario) | fast per-merge; **real-proof REQUIRED for A1/A2 sign-off** | P0 | ~15 min |
| C2 | draw settlement | `settle_game_draw` path rot | fast; real once per upgrade | P1 | ~4 min |
| C3 | abandoned game | claim/dummy-padding/dispute-window rot | **real-proof REQUIRED** (see C3 note); fast for flow | P1 | ~5 min |
| C4 | cancel unjoined game | escrowed-cards-lost-on-cancel | fast | P1 | ~2 min |
| C5 | disconnect + RESUME | session/inbox-replay breaking proof chain | fast; real nightly | P1 | ~5 min |
| C6 | settlement race (loser leaves) | `settlementInfoRef` bug class | fast; real once per upgrade | P1 | ~4 min |
| C7 | pack with insufficient tokens | dirty failure / phantom state change | fast only (no proving involved) | P2 | ~2 min |
| C8 | new-player onboarding | broken first-minute experience | proving mode N/A (account deploy is always real) | P0 | ~2 min |
| C9 | token-economy ledger | balance drift / display≠chain | fast | P2 | ~8 min |
| C10 | two concurrent games | cross-game state bleed | fast (real only pre-release, optional) | P2 | ~8 min |

Harness Phase 1 (PLAYTEST_HARNESS.md) == C1 reduced to its first game; build that
first, then generalize.

---

## 3. Campaigns

### C1 — ladder-with-pack (flagship)

**Guards against:** any regression in the core loop: matchwork → 9 proven moves →
11-proof settlement → card transfer → rewards → pack → repeat.
**Setup:** P1, P2 onboarded (5 cards / 100 tokens each). Fixture: per-game
committed hands + move scripts with this scheduled outcome ledger (per §1.5 a
mid-ladder pack is unavoidable — a 5-card loser can't field the next game):

| Step | Event | P1 cards | P2 cards | P1 tok | P2 tok |
|------|-------|----------|----------|--------|--------|
| 0 | fixtures onboarded | 5 | 5 | 100 | 100 |
| 1 | **G1**: P1 wins, claims X₁ | 6 | 4 | 120 | 120 |
| 2 | P2 buys pack | 6 | 14 | 120 | 20 |
| 3 | **G2**: P2 wins, claims X₂ | 5 | 15 | 140 | 40 |
| 4 | **G3**: P1 wins, claims X₃ | 6 | 14 | 160 | 60 |
| 5 | **G4**: P2 wins, claims X₄ | 5 | 15 | 180 | 80 |
| 6 | P1 buys pack | 15 | 15 | 80 | 80 |
| 7 | **G5**: P1 wins, claims X₅ | 16 | 14 | 100 | 100 |

**Steps:** for each Gᵢ: create (committer per fixture) → join → SC-CREATE/JOIN →
play scripted 9 moves (SC-MOVE each) → wait `GAME_OVER` → winner picks scheduled
Xᵢ → SC-SETTLE-WIN. After steps 2/6: SC-PACK. Click-interaction mode (testkit
`getScreenXY`) for G1; `placeCard` fast mode acceptable for G2–G5.
**Assertions:** SC blocks at every step, PLUS the ledger row after each step at
L4 (both players: exact inventory multiset [U-NFTS] + exact balance [U-BAL])
and L1 (HUD shows the same numbers). Final state: both players at exactly 100 tokens, 16/14 cards.
**Negative paths:** none — this is the happy-path regression net.
**Notes:** Real-proof run of C1 is the **merge gate for A1/A2** (LANE_5_QA.md).
Fixture-gen must account for note-nonce consumption per game
(`gameRandomness` is 6 fields ⇒ expected +6 per player per game — **CONFIRM in
`commit_five_nfts_create/join`**, flagged in §5).

### C2 — draw game

**Guards against:** `settle_game_draw` path rot (game `main.nr:714-740, 815-856`).
**Setup:** P1, P2 onboarded. Fixture: move script whose game-logic outcome is
`draw` with starter hands (fixture-gen searches for it; self-check per §1.5).
**Steps:** create → join (SC-CREATE/JOIN) → play the scripted draw line
(SC-MOVE each) → `GAME_OVER` with `winner: 'draw'` → P1 initiates settlement
(no card pick) → wait settle `complete` → both tabs return to menu.
**Assertions:**
- L1 both: result screen shows draw; **no claim picker is offered to either
  player**; collections unchanged afterward.
- L2: room `finished`, `winner: 'draw'`; players released; `NOTE_DATA` relayed
  to P2 (draw re-mints are OFFCHAIN-randomness notes needing import, nft
  `main.nr:727-742`).
- L3: status 3 [U-STATUS], settled [U-SETTLED]; `GameSettled { winner: 0x0,
  loser: 0x0, transferred_card_id: 0 }` [U-EVENTS] (game `main.nr:851-856`).
- L4 both: inventory multiset identical to pre-game (all 5 committed ids back)
  [U-NFTS]; balance +20 each [U-BAL].
**Negative paths:** after P1's settle completes, P2's client must NOT attempt a
second settlement (`game_settled` guard, game `main.nr:823-825`); assert P2's
tab reaches idle with no error toast.
**Open question (→Lane 2):** which client is expected to initiate a draw
settlement — both see a settle button, or deterministic chooser? Spec assumes
"first to click wins; other side degrades gracefully".

### C3 — abandoned game: claim, dispute window, settle

**Guards against:** rot in the dummy-proof padding path, claim-turn parity,
dispute-window enforcement, public-remainder minting.
**Mode note:** in fast mode the move VK *is* the dummy VK, so real-vs-dummy VK
discrimination in `claim_abandoned_game` (game `main.nr:280-316`) collapses —
**only a real-proof run exercises it**. Fast mode still covers flow + public
state + parity asserts (those are public-input checks, valid in both modes).
**Setup:** P1, P2 onboarded. Fixture: 3-move script prefix (P1 m1, P2 m2, P1 m3
— N=3 odd ⇒ P2's turn ⇒ P1 is the valid claimant, game `main.nr:365-375`).
Claim target X ∈ P2's committed hand.
**Steps:**
1. Create/join (SC-CREATE/JOIN); play moves 1–3 (SC-MOVE).
2. P2 hard-quits: close the browser context (no GAME_OVER, no graceful leave).
3. P1 receives `OPPONENT_DISCONNECTED`; after the 60s grace
   (`DISCONNECT_TIMEOUT_MS`, `server.ts:14`) the UI offers the abandoned-claim
   flow. [Open question →Lane 2: exact affordance + enablement timing.]
4. P1 runs `claim_abandoned_game` (11 proofs: 2 hand + 3 real moves + 6 dummy)
   → wait `complete`.
5. **Negative:** if `current_block − claim_block < 5`, P1 attempts
   `settle_abandoned_game` → assert revert "Dispute window not elapsed"
   (game `main.nr:494`) and that the UI surfaces it cleanly (txProgress
   `error`, no wedged state). Skip the attempt if blocks already advanced.
6. `advanceBlocks(5)` (§1.2), then P1 settles with `claimed_card_id = X` →
   wait `complete`.
**Assertions:**
- After step 4 — L3: status 5 [U-STATUS]; `GameAbandoned { game_id, claimant:
  P1, num_valid_moves: 3 }` [U-EVENTS — needs regenerated codegen, QA-F4: the
  checked-in metadata predates this event].
- After step 6 — L3: status 3 [U-STATUS], settled [U-SETTLED];
  `AbandonedGameSettled { game_id, claimant: P1, claimed_card_id: X }`
  [U-EVENTS — same QA-F4 caveat]; `public_owner_of(t) == P2` for each of P2's
  4 remaining committed ids [U-PUBOWNER] (nft `main.nr:774-784`); no public
  owner for X [U-PUBOWNER].
- L4 P1: inventory == prior + X [U-NFTS]; balance +20 [U-BAL].
- L4 P2 (n/a live — context closed; assert via a re-opened context with P2's
  pinned creds): private inventory == prior − committed 5 [U-NFTS]; balance
  unchanged (+0: no reward for the abandoner, game `main.nr:462-468`) [U-BAL].
- L2: **P1 can immediately create a new game after settling.** Expected to FAIL
  today — see finding QA-F3 (§5): abandoned rooms never hit GAME_OVER, so the
  backend never releases `player:{id}:game` until the 30-min stale sweep,
  blocking the claimant from new games. This assertion specs the *intended*
  behavior; Lane 4 owns the fix.
- L1 P1: post-settle collection +X; claim flow completes without manual reload.
**Negative paths (parity, optional fast-mode extension):** P1 attempting to
claim after N=2 (even) must fail in simulation ("It must be opponent's turn",
game `main.nr:371`); assert clean txProgress `error`.
**Open question (→Lane 1):** what can the opponent actually DO during the
5-block window? No counter-claim function exists (status 5 blocks
`process_game`, which needs status 2). If the answer is "nothing", the window
is dead weight — confirm intent before we spec a dispute campaign.

### C4 — cancel unjoined game

**Guards against:** creator's escrowed cards lost or stuck after cancel.
**Setup:** P1, P2 onboarded. P2 idle (control: must be unaffected throughout).
**Steps:** P1 creates a game (on-chain create + lobby room) → SC-CREATE checks
for the created-but-unjoined state (L3 status 1, L4 P1 committed ids absent) →
P1 cancels from the lobby → wait cancel tx `complete` and `GAME_CANCELLED` WS →
**P1 immediately creates a NEW game committing the SAME 5 ids** (the strongest
proof the re-minted notes are spendable) → cancel it again to leave clean state.
**Assertions:**
- L3: status 4 after cancel [U-STATUS] (`GameCancelled` event [U-EVENTS], game
  `main.nr:217-219`); the follow-up create succeeds with a fresh game_id
  (status 1) [U-STATUS].
- L4 P1: all 5 ids back in `get_nfts_for_user` [U-NFTS] **without any
  NOTE_DATA relay or manual import** — cancel re-mints use ONCHAIN_CONSTRAINED
  delivery (nft `main.nr:711-723`), discovered by PXE tag sync alone; poll per
  §1.2. Balance unchanged (no reward on cancel) [U-BAL].
- L2: room removed (`GET /games` no longer lists it); P1's player→game mapping
  released (the follow-up create succeeding proves it end-to-end).
- L1 P1: lobby shows no stale entry; collection shows 5 cards again.
- L1/L2 P2: nothing received, nothing rendered (isolation control).
**Negative paths:** P2 attempts to join the cancelled game id (race: join click
after cancel) → clean rejection (on-chain "Game not in created state",
game `main.nr:178`; lobby error toast; P2 not wedged).

### C5 — mid-game disconnect + RESUME

**Guards against:** session resume or inbox replay breaking the move/proof
chain; buffered-proof loss.
**Setup:** P1, P2 onboarded; any decisive fixture (reuse C1-G1's).
**Steps:**
1. Play moves 1–4 normally (SC-MOVE).
2. After P2's move 4 proof relays, sever P2's socket only
   (`context.setOffline(true)` or testkit socket close — page stays alive).
3. Assert P1 receives `OPPONENT_DISCONNECTED`.
4. P1 plays move 5 while P2 is offline → its `MOVE_PROVEN` lands in P2's inbox
   (buffered types, `server.ts:30-36`).
5. Within the 60s grace, restore connectivity → client auto-reconnects and
   sends `RESUME` with the stored token (`useWebSocket.ts:100-104`).
6. Play moves 6–9 to completion → SC-SETTLE-WIN (whoever the fixture says).
**Assertions:**
- L2: `SESSION_ESTABLISHED { resumed: true, gameId }` with the SAME playerId
  (session continuity, `server.ts:331-414`); P1 receives
  `OPPONENT_RECONNECTED`; P2's inbox drained after replay (Redis
  `LLEN inbox:{playerId} == 0`); room still `playing` throughout the gap.
- L1 P2: buffered move 5 replays — board converges to the game-logic projection
  including move 5, no duplicate or skipped move; turn indicator correct.
- L1/L4: settlement completes normally (SC-SETTLE-WIN) — the end-to-end proof
  that the relayed proof chain survived the gap intact. This is the campaign's
  point: a settlement-time chaining failure (game `main.nr:613`) means replay
  corrupted the transcript.
**Negative paths:** none in v1. (Reconnect after >60s grace is governed by work
item G's staleness semantics — spec a C5b once Lane 4 lands G; see §5 QA-A4.)
**Variant C5b (stretch, after G):** full page reload instead of socket sever —
exercises localStorage game restore (`useGameStorage.ts`) + RESUME + replay.

### C6 — settlement race: loser leaves before winner settles

**Guards against:** the `settlementInfoRef` bug class — post-settle state for a
player who is no longer on the game screen (`useGame.ts:211-218, 1036-1064`;
the ref is intentionally NOT cleared by back-to-menu, `useGame.ts:1539-1554`).
**Setup:** P1, P2 onboarded; decisive fixture, P1 wins, claims X.
**Steps:** play to `GAME_OVER` → **P2 navigates back to the main menu BEFORE P1
settles** (WS stays connected — leaveGame resets game state, not the socket) →
P1 picks X and settles → wait P1 `complete` → P2 stays at menu.
**Assertions:**
- L1 P2 (at menu): `NOTE_DATA` import still fires (`incomingNoteData` effect)
  — collection (menu/collection view) eventually shows prior − X; balance HUD
  eventually +20; no error toast; no navigation hijack back into the game.
- L4 P2: inventory == prior − X [U-NFTS]; balance +20 [U-BAL] — asserted at
  the menu, then ALSO after a full page reload (localStorage `cardStore` + PXE
  re-import path, `connectToAztec.ts:336-381` — the April persistence work
  this guards).
- L1/L4 P1: standard SC-SETTLE-WIN winner-side checks.
- L3: standard SC-SETTLE-WIN chain checks.
- L2: `NOTE_DATA` delivered live to P2's connected socket (not buffered).
**Negative paths / variant:** C6b (stretch): P2 closes the tab entirely after
GAME_OVER, reopens after P1's settle → `NOTE_DATA` must arrive via inbox replay
on RESUME, then import. Covers the buffered branch of the same bug class.

### C7 — pack purchase with insufficient tokens

**Guards against:** dirty failure: phantom cards, balance mutation, wedged UI,
or a tx escaping to chain when the burn can't succeed.
**Setup:** P1 onboarded, then SC-PACK once as fixture (balance now exactly 0,
15 cards, nonce 15). No P2.
**Steps:** P1 opens the pack screen and attempts a second purchase.
**Assertions:**
- L1: txProgress sequence is `simulating → error` with **no `sending`/`mining`
  phase** (the `burn_from` assert fails in simulation; there is deliberately no
  frontend pre-guard — `useCardPacks.ts:165-169`); error surfaced in the pack
  UI; **no reveal animation, no cards added to the collection view**; user can
  navigate away and back (not wedged).
- L4: balance still 0 [U-BAL]; inventory still 15 (exact multiset unchanged)
  [U-NFTS]; `get_note_nonce` unchanged at 15 [U-NONCE].
- L3: nothing reached the chain. Implementable as: the attempt's txProgress
  stream contains no `sending`/`mining` phase and no `aztecTxHash` — combined
  with the unchanged [U-NONCE]/[U-BAL]/[U-NFTS] reads above this proves no
  state mutation. (There is no per-account tx index to query node-side; do not
  invent one.)
- L2: n/a.
**Negative paths:** this whole campaign is the negative path. Optional boundary
companion: with balance exactly 100, purchase succeeds to 0 (covered by the
fixture step — assert it as a boundary case, 100 is not rejected).

### C8 — new-player onboarding

**Guards against:** broken first-minute experience (master plan goal #3).
**Setup:** completely fresh browser context, pinned-secret fixture creds seeded,
sandbox running. No prior accounts.
**Steps:** load app → click connect/play → auto fee-juice funding (sandbox path,
`fundDevnet.ts`; **no SponsoredFPC anywhere** — banned by ground rules) → single
combined tx: account deploy + `get_cards_for_new_player` (nft `main.nr:384-412`)
→ wait status `connected` → record elapsed wall-clock from first load to
playable menu as a metric (target <60s informational, not a gate) → reload the
page (returning-player path).
**Assertions:**
- L1: menu shows balance 100 and 5-card collection (ids 1–5); localStorage has
  accountAddress, `deploymentStatus: 'deployed'`, and 5 StoredCards with
  txHash/noteHashes (`cardStore.ts:8-21`) — starter notes are
  `create_and_push_note` + OFFCHAIN events, so the app-side `importNotesFromTx`
  path MUST have run (ground rule: such notes are never auto-discovered).
- L4: `get_nfts_for_user == {1,2,3,4,5}` [U-NFTS]; `get_balance == 100`
  [U-BAL]; `get_note_nonce == 5` [U-NONCE] (asserting the 0→5 transition —
  U-NONCE returns 0 pre-onboarding).
- L3: deploy+mint tx mined (txProgress `complete` with `aztecTxHash`); the
  functional account-existence proof is the in-tab U-NFTS/U-BAL reads above
  succeeding `{ from: accountAddress }` — no separate node-side existence
  check is required.
- L2: WS `SESSION_ESTABLISHED` received; session token persisted
  (`aztec_tt_ws_session_token`).
- **After reload:** connects via the `alreadyDeployed` path with NO second mint
  — balance still exactly 100, still exactly 5 cards. (This is the only
  double-claim protection that exists today — see finding QA-F1, §5: the
  contract itself has NO on-chain guard; a direct second call would mint
  another starter set + 100 tokens. Once Lane 1 adds a guard, extend this
  campaign with: direct `get_cards_for_new_player` call from the console →
  assert revert.)
**Negative paths:** kill the page mid-deploy (after tx sent, before
`connected`), reload → app must recover to a consistent state (either resumes
to connected or restarts onboarding cleanly; no half-state where tokens exist
but cards were never imported). [Open question →Lane 2: which recovery is the
intended one — spec assumes "resume to connected via stored creds + re-import".]

### C9 — token-economy ledger over a session

**Guards against:** balance drift and display≠chain divergence across mixed
reward/burn flows, including the draw reward C1 never touches.
**Setup:** P1, P2 onboarded. Fixtures: decisive line (P1 wins), draw line
(reuse C2's), decisive line (P2 wins).
**Steps + expected ledger** (assert FULL row after every step):

| Step | Action | P1 tok | P2 tok | P1 cards | P2 cards |
|------|--------|--------|--------|----------|----------|
| 0 | onboard | 100 | 100 | 5 | 5 |
| 1 | G1: P1 wins, claims X₁ | 120 | 120 | 6 | 4 |
| 2 | P2 buys pack | 120 | 20 | 6 | 14 |
| 3 | G2: **draw** | 140 | 40 | 6 | 14 |
| 4 | G3: P2 wins, claims X₂ | 160 | 60 | 5 | 15 |

**Assertions:** after every step, at BOTH of:
- L4: `get_balance` exactly equals the ledger cell [U-BAL] (no ±, no
  eventual-ish tolerance — poll to convergence per §1.2, then assert
  equality); inventory multiset matches [U-NFTS].
- L1: the HUD/menu balance displays the same number L4 returned — the campaign
  exists to catch display drift as much as chain drift.
- L3 per game: matching `GameSettled` events [U-EVENTS] (G2's with zero
  winner/loser/card per C2).
**Negative paths:** none; C7 owns the failure-side economics.

### C10 — two concurrent games, four players

**Guards against:** cross-game state bleed in backend/relay; pairing mistakes.
**Setup:** four onboarded players A, B, C, D in four browser contexts (four
isolated PXEs — the serial-PXE rule is per-player and unaffected). Game 1 (A–B)
via explicit create/join; Game 2 (C–D) via the **matchmaking queue** (covers
`QUEUE_MATCHMAKING → MATCH_FOUND` pairing, `GameManager.ts:269-325`). Decisive
fixtures for both.
**Steps:** start both games so move phases overlap; interleave moves
(scheduler alternates tabs A,C,B,D,…); settle both (Game 1 first, Game 2 while
Game 1's settlement is mining if timing allows).
**Assertions:**
- L2: `GET /health` shows `games: 2`; `GET /games` lists both with correct
  independent statuses throughout; each room's `currentTurn` evolves
  independently; per-game move locks never block the other game
  (`game:{id}:lock` is id-scoped, `GameManager.ts:114-151`).
- L2 (the core one): each tab's full WS message log contains **only its own
  gameId** — no message of any type ever crosses rooms; D's MATCH_FOUND pairs
  D with C, never with A/B.
- L3: two distinct on-chain game_ids; each settles with its own `GameSettled`
  [U-EVENTS]; statuses never interfere (Game 2 still `2` while Game 1 is `3`,
  then both `3`) [U-STATUS, U-SETTLED — poll both gids at each transition].
- L4 all four: inventory/balance deltas correspond ONLY to each player's own
  game outcome (e.g. A's claimed card never appears in C's or D's inventory)
  [U-NFTS, U-BAL per tab].
- L1 all four: each tab renders only its own board; no flicker/overwrite from
  the other game's GAME_STATE.
**Negative paths:** while in Game 1, A sends a `JOIN_GAME` for Game 2's id
(testkit raw-send) → backend rejects (player already in a game,
`getValidPlayerGame` `GameManager.ts:38-48`); Game 2 unaffected.

---

## 4. What "green" means

A campaign passes only if **every** listed assertion at **every** layer holds —
a frontend-green/chain-red run is a failure (that divergence is exactly what
the layers exist to catch). On failure the harness emits the PLAYTEST_HARNESS.md
§5 artifact bundle (trace, video, console, PXE logs, three-layer state dump at
the failed assertion); Lane 5 triages and files against the owning lane.

Merge-gate usage (binding, per LANE_5_QA.md): fast-mode green is necessary but
NOT sufficient for version-critical merges; A1/A2 sign-off requires a
**real-proof** C1 (and C3, which fast mode cannot meaningfully exercise).

## 5. Findings & assumptions discovered while writing this backlog

Filed here so owning lanes see them at the next sweep; also mirrored in
LANE_5_QA.md ASSUMPTIONS.

- **QA-F1 (→Lane 1, contract):** `get_cards_for_new_player` has NO on-chain
  double-claim guard (nft `main.nr:384-412` — `push_note_nonce` inserts
  unconditionally, `main.nr:365-377`). A second direct call mints 5 more cards
  + 100 more tokens and inserts a second value-5 nonce note (subsequent
  `pop_note_nonce(limit 1)` then pops an arbitrary one, and starter randomness
  derivation reuses nonce 0). Only the frontend's localStorage
  `deploymentStatus` flag prevents it today. Free-token faucet + nonce
  corruption — needs an on-chain guard before launch.
- **QA-F2 (→Lane 4, verify):** LANE_4_BACKEND.md's "3 test assertion fixes"
  appear already consistent on current main — `server.test.ts` hand-sanitization
  asserts indices 3–4 only, matching `HIDDEN_COUNT = 2` (`server.ts:194`).
  Re-verify before spending G effort there.
- **QA-F3 (→Lane 4 + Lane 2, product gap):** abandoned games never emit
  GAME_OVER, so `releasePlayersFromGame` never runs — after an on-chain
  abandoned-claim settle, the claimant's `player:{id}:game` mapping persists
  until the 30-min stale sweep, likely blocking them from creating/joining a
  new game. C3 specs the intended behavior (immediate new game) and will fail
  until this is wired (e.g. release room when the claim flow completes).
- **QA-F4 (→Lane 1, build artifact):** the checked-in codegen
  (`packages/contracts/target/codegen/`, last regenerated at 52f9c95) predates
  the abandoned-game flow (43dd513): it has NO `claim_abandoned_game` /
  `settle_abandoned_game` methods and NO `GameAbandoned` /
  `AbandonedGameSettled` event metadata. Anything Node-side (U-NODE, U-EVENTS)
  must regenerate first (`aztec compile && aztec codegen target/ -o
  target/codegen`) and treat codegen as a build artifact — never trust the
  checked-in copy. A1 regenerates as part of the upgrade anyway.
- **QA-F5 (→orchestrator; ownership unassigned):**
  `packages/integration/tests/e2e-*.test.ts` still use SponsoredFPC
  (`e2e-aztec-settlement.test.ts:144,209`) — banned by ground rule 5. Lane 8
  must not copy that fee/deploy code into the harness chain client (§1.7
  U-NODE); the tests themselves need migrating to Fee Juice, but
  `packages/integration` has no owning lane in MASTER_PLAN.md.
- **QA-A1 (assumption):** opponent-hand sanitization hiding only the LAST 2
  hand slots (3 of 5 visible) is intended game design, not a leak. Campaign
  asserts current behavior; if design changes, SC-MOVE's L2 check changes.
- **QA-A2 (assumption):** note-nonce delta per game per player is +6
  (gameRandomness is `[Field; 6]`) — used by fixture-gen determinism. CONFIRM
  in `commit_five_nfts_create/join` before relying on predicted pack contents
  after games.
- **QA-A3 (assumption):** sandbox block time makes `advanceBlocks(5)`
  tx-driven; if the 4.3.1 sandbox auto-mines on an interval instead, C3's
  helper simplifies but the no-sleep rule still applies.
- **QA-A4 (assumption):** C5 asserts current 60s-grace semantics
  (`DISCONNECT_TIMEOUT_MS`, `server.ts:14`); work item G must not change
  behavior *within* the grace window. C5b (post-G staleness behavior) is spec'd
  only after G lands.

## 6. Consolidated open questions

| # | Question | Owner |
|---|----------|-------|
| 1 | Draw settlement: which client initiates; does the other degrade gracefully? (C2) | Lane 2 |
| 2 | Abandoned-claim UI affordance + when it enables (after 60s grace? immediately on disconnect?) (C3) | Lane 2 |
| 3 | Purpose of the 5-block dispute window given no counter-claim function exists (C3) | Lane 1 |
| 4 | Does any UI surface publicly-owned cards (abandon remainder)? If not, P2's 4 public cards are invisible to them forever (C3) | Lane 2 |
| 5 | Intended recovery when onboarding dies mid-deploy (C8 negative path) | Lane 2 |
| 6 | Note-nonce delta at create/join (QA-A2) | Lane 1 |
