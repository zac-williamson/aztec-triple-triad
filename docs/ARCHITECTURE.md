# Architecture — Axolotl Arena on Aztec

How a hidden-information card game runs on Aztec with three on-chain
transactions per game and **no public game state**. This document covers the
**contract and protocol layer**: the Noir contracts, the standalone proof
circuits, and the note lifecycle that moves cards between players. Every claim
carries a `file:line` anchor into the source. The design rationale and threat
model are in [docs/plan/PRIVATE_GAMES.md](plan/PRIVATE_GAMES.md).

> **Scope note:** [§12](#12-frontend-layer) documents the frontend. Sections
> 1–11 cover the contract/protocol layer.

## 1. Design at a glance

A full game costs exactly three transactions, regardless of how the match goes:

| Tx | Who | What |
|----|-----|------|
| 1 | Player 1 | `create_game` — burn 5 card notes, prepare every payout, record only hashes |
| 2 | Player 2 | `join_game` — the same, against player 1's record |
| 3 | Anyone holding the records and the transcript (normally the winner) | `settle_game` — verify the whole match, release the prepared notes |

The nine moves in between never touch the chain. Each move is a client-side ZK
proof (`circuits/game_move/`) exchanged peer-to-peer over a WebSocket relay
(`packages/backend/`). Settlement verifies the nine move proofs *inside* the
private `settle_game` function (`triple_triad_game/src/main.nr:494`).

What the chain learns: nothing about the game. There is no public storage beyond
the deployment's immutables, no public call and no event
(`triple_triad_game/src/main.nr:264-275`). A game's state is a set of
**nullifiers** derived from `game_key`, a secret only its two players share
(§3), so create, join and settle are unlinkable to each other and to the game
contract. What any tx still shows: its fee payer, gas, counts of nullifiers and
note hashes, and its time.

Why this shape: Aztec private functions execute client-side and can recursively
verify UltraHonk proofs (`verify_honk_proof`). That turns "9 on-chain moves +
dispute games" into "1 proof-of-the-whole-game", with latency and fees paid once.

## 2. System pieces

```
packages/contracts/
  triple_triad_nft/    Card NFTs: private CardNotes (two-step hash, §7), commit a hand
                       and prepare its payouts, release prepared notes
  triple_triad_game/   Private game lifecycle as nullifiers + 9-proof settlement
  arena_token/         Private fungible reward token (BalanceSet)
circuits/
  game_move/           "This move is legal" (full capture rules in-circuit)
  dummy_move/          Zero-constraint move stand-in, accepted only by
                       --permissive-vks TEST deployments
  prove_hand/          Not used by the Phase A protocol (see PRIVATE_GAMES.md §4)
  card_data/           Shared 256-card rank table (CARD_RANKS / get_card_ranks)
```

The contracts are wired at deploy time: the game contract address is stored in
the NFT and the token, and gates every game-flow call (`commit_hand`,
`release_game_cards`, `release_reward_notes`); the NFT and token addresses are
`PublicImmutable` in the game contract.

## 3. Game lifecycle

```
P1 browser                  On-chain (nullifiers only)           P2 browser
──────────                  ──────────────────────────           ──────────
      ◄═══════ key exchange over the relay (gameKeys.ts) ═══════►
      both derive game_key; the relay sees only the public keys

create_game(game_key, ids) ─► N_created(game_id)
  record_1 ──────────────────── sealed PEER via relay ─────────► join_game(game_key, record_1, ids)
                              N_seat2, N_joined(game_id, rec_2) ◄─┘
  ◄──────────────────────────── sealed PEER: record_2 ──────────
   ◄════ 9 alternating game_move proofs (no txs) ════►
winner: settle_game(game_key, record_1, record_2, 9 proofs, prize_move) ─► N_done(game_id)
  └─ releases the prepared notes; each player imports their own
```

- **Records.** Each player's commit returns a 9-field record
  `[seat, hand_commit, ret_0..ret_4, prize_partial, reward_note_hash]`
  (`triple_triad_game/src/main.nr:36-41`). Every field is a hiding hash.
- **Game id.** `game_id = poseidon2_sep([game_key, record_hash(record_1)])`
  (`game_id_of`, `:338`). It is never published; nobody without `game_key` can
  compute any of the game's nullifiers.
- **Seats.** A player is identified by `seat = H(H(nhk_app_game, game_key))`
  (`player_secret`/`seat_of`, `:310-322`): proving a seat means recomputing it
  from the player's own key, which is how cancel, claim and contest know who is
  calling without any address being recorded. The same account recomputes the
  same seat, so `join_game` refuses self-play.
- **State as nullifiers** (`n_created`…`n_resolved`, `:353-399`): `N_created`
  (create), `N_seat2` (pushed by join AND cancel, so exactly one happens),
  `N_joined` (binds the joiner's record), `N_done` (pushed by settle, finalize
  and cancel, so a game resolves once), and the abandonment set (§8).
  Existence checks use `assert_nullifier_exists` (`assert_recorded`, `:402`);
  `joined_game` (`:412`) authenticates both records in one check, because the
  join itself verified record 1.
- `create_game` (`:429`), `join_game` (`:444`), `cancel_game` (`:471`). Cancel
  releases exactly the creator's five prepared return notes, so it cannot mint
  anything else.
- Clients read a game's state by looking up the siloed nullifiers that
  `game_nullifiers` (`:699`) computes; the node reports the block each one
  landed in, which the abandonment functions use as a clock.

## 4. Hiding a hand and preparing its payouts

When a player commits, the NFT contract (`commit_hand`,
`triple_triad_nft/src/main.nr:616`):

1. Checks the hand: five distinct ids in 1..256 (`validate_hand`, `:63`). This
   used to be the hand proof's job; checking it on-chain at commit time is what
   lets settlement drop the two hand proofs.
2. Fetches the player's app-siloed nullifier secret `nhk_app_secret` via
   `request_nhk_app`, pops the player's single **nonce note** and the five card
   notes (`pop_cards_by_id`, `:323`) — the cards are *burned*, not escrowed.
3. Derives eight per-game secrets from `nhk_app_secret` and the nonce
   (`derive_game_secrets`, `:262`): return randomness `r_0..r_4`, the prize
   randomness `w`, the reward randomness `u` and the hand blinding `b`. The
   nonce note is re-inserted as `nonce + 8`.
4. Prepares the payouts (`prepared_payouts`, `:274`):
   `hand_commit = poseidon2([ids…, b])`; one fully formed return note per hand
   slot, owned by the committer; a prize **partial** commitment
   `H(owner, w)`; and the reward note `UintNote{20}` for the owner.

Nothing derived here leaves the player's device. The client reads its own
secrets with the simulate-only `compute_game_secrets` (`:840`) and its record
with `preview_record` (`triple_triad_game/src/main.nr:684`).

This is why **ground rule #10** exists: per-game values are derived in-circuit
from the player's own keys, never supplied by the client, so they cannot be
ground or reused, and they are recoverable from the account keys.

## 5. Playing in zero knowledge: the move circuit

Every move produces one `game_move` proof (`circuits/game_move/src/main.nr:79`).
Public inputs:

```
[card_commit_1, card_commit_2, start_state_hash, end_state_hash, game_ended, winner_id,
 placed_card_id, placed_slot]
```

`placed_card_id` and `placed_slot` (`:93-94`) are face-up information (the card
lands on the board); they are public so settlement knows which of the loser's
prepared return notes to hold back for the prize. They reach the chain only as
private inputs of the settle tx.

State hashes are `pedersen([board[18], score1, score2, current_turn,
original_owners[9]])` (`hash_board_state`, `:35`, 30 fields). `original_owners[i]`
is the player who FIRST placed the card on cell `i` — set at placement, never
changed by capture, publicly agreed by both peers. The circuit constrains:

1. **Turn legality** — the mover matches `current_turn_before`.
2. **Hand binding** — recompute the mover's commitment from private
   `player_card_ids + blinding_factor`; it must equal `card_commit_1` or `_2`
   per the mover's seat; and `player_card_ids[placed_slot] == placed_card_id`
   with `placed_slot` a real slot (`:145`). You cannot play a card you didn't
   commit, or name a slot it isn't in.
3. **Replay prevention** — a player may not place a card they already placed:
   reject if any cell holds the card AND `original_owner == current_player`
   (section 4b of the circuit).
4. **Placement** — target cell empty before, card+owner written after.
5. **Capture rules** — full Triple Triad chain capture in-circuit (rank table
   `circuits/card_data/src/lib.nr`, 8 BFS passes over `NEIGHBORS`/`DIR_RANKS`).
6. **Frame rule** — every non-placed cell keeps its card id; owner changes iff
   captured.
7. **State hashing** — `start_state_hash` matches `board_before`;
   `end_state_hash` matches `board_after` with the turn flipped.
8. **Game end** — forced by the board: 9 cells filled ⇒ ended, winner by score,
   `3` = draw.
9. **Score integrity** — recomputed from board ownership plus remaining hand
   counts, not trusted.

Because each proof's `end_state_hash` is the next proof's `start_state_hash`
(checked at settlement, §6), the nine proofs form a hash-linked chain from the
canonical empty board to the final position.

## 6. Settlement: settle_game

`settle_game` (`triple_triad_game/src/main.nr:494`) takes `game_key`, both
records, the move VK, the nine proofs with their 8 public inputs each, and
`prize_move`:

1. `joined_game` authenticates both records (`N_joined` exists).
2. Verifies the nine proofs against the stored `move_vk_hash`.
3. `assert_transcript` (`:106`): every move bound to both records'
   `hand_commit`s, chained, anchored to the empty board
   (`compute_initial_state_hash`), only move 9 ending the game with winner 1, 2
   or 3.
4. Pushes `N_done(game_id)` — a second settlement, or one after an unwound
   abandonment, fails on it.
5. **Win:** `prize_of` (`:142`) reads the prize from the move `prize_move`,
   which must have the loser's parity (player 1 moves at even indices). The NFT
   releases the winner's five returns, the loser's four that were not the prize
   slot (`win_returns`, `:164`), and completes the winner's prize partial with
   the prize card. **Draw:** both hands' ten returns.
   Either way 12 note hashes are released (10 cards + 2 rewards), so the count
   does not reveal the result.
6. The token releases both prepared reward notes.

Settlement needs no address, randomness, blinding factor or unplayed card:
anyone holding the two records and the transcript may call it. Nothing is
checked against the caller.

## 7. The note lifecycle

**Card notes** are `CardNote { card_id }` with a two-step hash, like aztec-nr's
`UintNote` (`triple_triad_nft/src/card_note.nr`):

```
partial   = poseidon2_sep([owner, randomness], DOM_SEP__PARTIAL_NOTE_COMMITMENT)
note_hash = compute_note_hash(storage_slot, [partial, card_id])
```

A card can be created the ordinary way (owner and randomness known) or by
completing a `partial` someone prepared earlier without learning its owner —
and both give the same hash (`card_partial_commitment`/`complete_card_note_hash`,
`card_note.nr:76-82`). Unlike aztec-nr's partial notes, no completion log is
emitted: the owner always knows the value already.

- **Minting** (starter cards, packs, bot stock, admin mints, transfers) creates
  `CardNote`s as before; starter and pack cards are delivered offchain to their
  owner (`get_cards_for_new_player`, `:380`; `purchase_card_pack`, `:420`).
- **Committing** burns the hand and prepares its payouts (§4).
- **Releasing** (`release_game_cards`, `:660`; game-only) pushes prepared note
  hashes and, for a prize, the completed partial. Nothing is delivered: each
  owner rebuilds their own notes from secrets they already hold and imports
  them from the settlement tx's effects with `import_note` (`:863`). The loser's
  import is the same code as the winner's; no note data ever crosses the relay.

**Reward notes** are `UintNote`s prepared at commit and released by
`release_reward_notes` (`arena_token/src/main.nr:101`); the owner imports with
`(owner, 20, u)`.

## 8. Abandoned games

No proofs and no transcript: claims are timed from the blocks their nullifiers
landed in, using `get_block_header_at` and `assert_nullifier_existed_by` /
`assert_nullifier_did_not_exist_by`. `MIN_ABANDON_SECONDS` = 480 and
`DISPUTE_SECONDS` = 600 (`triple_triad_game/src/main.nr:25-29`).

- **Claim** (`claim_abandoned_game`, `:582`): a player proves their seat; the
  clock nullifier (`N_joined` for claim 1, `N_contest(c-1)` after a contest)
  must have existed `MIN_ABANDON_SECONDS` before the anchor; `N_done` must not
  exist. Pushes `N_claim_slot(c)` and `N_claim(c, side)`. Claims are numbered
  1..3.
- **Contest** (`contest_abandonment`, `:617`): the OTHER player, inside the
  window — measured from a block in which the claim did not yet exist. Pushes
  `N_contested_by(side)` (once per side), `N_contest(c)` (restarts the clock)
  and `N_resolved(c)`.
- **Finalize** (`finalize_abandoned_game`, `:650`): anyone, once the window has
  passed since a block in which the claim already existed. Pushes `N_resolved(c)`
  and `N_done`, and releases both players' own five cards. No rewards.

Contest and finalize of one claim both push `N_resolved(c)`, so only one lands;
no tx expiry is needed (an expiry would be a public fingerprint). A full
transcript outranks a standing claim: settlement needs only `N_done` to be free.

## 9. ArenaToken

A minimal private fungible token (`packages/contracts/arena_token/src/main.nr`):
`Owned<BalanceSet>` storage, `mint_private` gated to admin/NFT/game
(`:83`), `release_reward_notes` gated to the game (`:101`), `burn_from` gated to
the NFT, `import_note` and unconstrained `get_balance`. Economy: +100 at
onboarding, +20 per settled game per player, −100 per card pack.

## 10. Aztec concept → code index

| Aztec concept | Where to read it |
|---------------|------------------|
| Private state via notes (`Owned<PrivateSet<N>>`) | `triple_triad_nft/src/main.nr:177,184` |
| A custom note with a two-step (partial) hash | `triple_triad_nft/src/card_note.nr` |
| Completing a partial note without knowing its owner | `triple_triad_nft/src/main.nr:660` (`release_game_cards`) |
| Note pop by token id (one oracle select per card) | `triple_triad_nft/src/main.nr:323` (`pop_cards_by_id`) |
| App-siloed key material (`request_nhk_app`) as KDF seed | `triple_triad_nft/src/main.nr:262` ; `triple_triad_game/src/main.nr:310` |
| Manual note creation (hash + `notify_created_note`) | `triple_triad_nft/src/main.nr:469` (`push_card_note`) |
| Offchain note delivery | `triple_triad_nft/src/main.nr` `create_and_push_note` and its callers |
| Manual note import from a tx's effects | `triple_triad_nft/src/main.nr:863` (`import_note`) |
| `storage_layout()` instead of hardcoded slots | `triple_triad_nft/src/main.nr` `prepared_payouts`, `push_card_note` |
| State machine as nullifiers (no public state) | `triple_triad_game/src/main.nr:353-399` |
| Private existence checks on nullifiers | `triple_triad_game/src/main.nr:402` (`assert_recorded`) |
| Historical block headers as a clock | `triple_triad_game/src/main.nr:582-680` |
| Cross-contract private calls | `triple_triad_game/src/main.nr:429-470` |
| Recursive UltraHonk verification in a private fn | `triple_triad_game/src/main.nr:494` |
| VK pinning via `PublicImmutable` (readable from private) | `triple_triad_game/src/main.nr:264-275` |
| Proof chaining (hash-linked state transcript) | `triple_triad_game/src/main.nr:106` |
| Unconstrained utility fns (`.simulate()`-only API) | `triple_triad_game/src/main.nr:699` ; `triple_triad_nft/src/main.nr:863` |
| Private fungible balances (`BalanceSet`) | `arena_token/src/main.nr` |
| Contract-to-contract authorization (msg_sender gating) | `triple_triad_nft/src/main.nr:616,660` ; `arena_token/src/main.nr:101` |
| Pure-Noir game rules in a circuit | `circuits/game_move/src/main.nr:79` |

## 11. Extending it

**Add or rebalance a card.** Ranks live in four places that must agree:
`scripts/card-database-256.json` (generator source of truth),
`circuits/card_data/src/lib.nr` (what proofs enforce),
`packages/frontend/src/cards.ts` (what players see), and
`packages/game-logic/src/cards.ts` (what the engine and backend simulate and
validate — regenerate with `npm run generate:cards` in `packages/game-logic`).
The contract's pool constants (`CARDS_PER_POOL`, `triple_triad_nft/src/main.nr:8`)
and the hand check (1–256, `validate_hand`) bound the id space — growing past
256 touches both. Regenerate, don't hand-edit.

**Change a game rule.** The capture logic exists twice by design: TypeScript
(`packages/game-logic/`) and Noir (`circuits/game_move/src/main.nr`). A rule
change must land in both plus their tests in the same change. The settlement
contract only checks the proof *chain*, so rule changes that keep the
public-input shape don't touch the contracts — but they DO change the move
circuit's VK: redeploy with the new `move_vk_hash`.

**Fork it for another hidden-information game.** The reusable skeleton is:
commit hands and prepare payouts in-circuit (§4) → hash-chained move proofs (§5)
→ recursive verification and release of prepared notes (§6–7) → nullifier state
and block-timed abandonment (§3, §8). Swap the move circuit's rule block and
state encoding; keep everything else.

## 12. Frontend layer

How a browser drives all of the above. Anchors target the post-decomposition
layout (revival work item B). All paths in this section are under
`packages/frontend/src/`.

### 12.1 Layering: React hooks over module-level infrastructure

The Aztec machinery deliberately lives **outside React**: `txManager`
(`aztec/txManager.ts:1-13`) and the contract cache (`aztec/contracts.ts:28-49`)
are module-level singletons, so in-flight transactions and PXE state survive
component unmounts and screen navigation. React hooks subscribe to them
(`useSyncExternalStore` snapshots, `aztec/txManager.ts:91-97`) and translate
them into render state. One provider (`aztec/AztecContext.tsx:11`) exposes the
wallet layer to every hook via `useAztecContext` (`:33`).

The game logic itself is a facade plus three hooks, composed once
(`hooks/useGame.ts:93-118`) and consumed only through the facade:

```
useGame (hooks/useGame.ts:100)         facade: screens, matchmaking, persistence
 ├─ useGameSession                     on-chain lifecycle (create/join pipeline)
 ├─ useGamePlay                        proof orchestration (hand + 9 moves)
 └─ useGameSettlement                  process_game + abandoned-game flows
       consumes session/play ONLY through identity-stable accessor functions
       (SettlementSessionDeps/SettlementPlayDeps, hooks/useGameSettlement.ts:20-39)
```

Two design rules carry the whole layer (stated in the architecture comment at
`hooks/useGame.ts:62-91`): values the UI renders are React state; values read
by async closures are refs; and **cross-hook access goes only through
identity-stable functions** (`getPhase`, `getSettlementInfo`, `getMoveProofs`,
`waitFor*`) — never raw refs — so callbacks stay memoized while always reading
current values. Where an effect must read live WebSocket state without
re-firing on every message, the hook mirrors that state into render-updated
refs (`hooks/useGameSession.ts:126-138`).

### 12.2 The on-chain pipeline (useGameSession)

The lifecycle is an explicit state machine: `OnChainPhase`
(`hooks/useGameSession.ts:15-24`) with a legal-transition table enforced by
`transitionPhase` (`:26-36,140-156`). One consolidated effect drives the
pipeline (`:417-545`): player 1 runs `create_game` (`:426-469`), player 2 runs
a read-only prepare step (`:472-511`) and then `join_game` once P1's tx is
confirmed (`:514-540`) — each step wrapped in `txManager.runTx` with
`postEffects` that share data with the opponent and advance the phase.

`createGameOnChain` (`:202-299`) shows the simulate-then-send shape: four
**serial** `.simulate()` calls (`get_note_nonce` → `preview_game_data` →
`get_game_status` → `compute_blinding_factor`, `:215-231`) recover the
in-circuit-derived `game_id`, randomness, and blinding factor *before* the tx,
including a stale-nonce guard (`:233-235`); then `create_game` is sent
(`:263-265`). The preview values are shared with the opponent over the relay
the moment React state updates — a deliberate effect *outside* the PXE
execution context (`:359-375`).

Settlement's inputs accumulate in `settlementInfoRef`
(`SettlementInfo`, `:43-50`): seeded by pipeline postEffects (`:453-461`),
merged synchronously when `OPPONENT_AZTEC_INFO`/`GAME_OVER` arrive (a raw
message listener, not an effect — `:381-407`), and backfilled on demand from
the ws-mirror refs for any field a race left empty (`:173-194`). It is
deliberately **not** cleared on navigation (`:557-563` explains the spurious
`create_game` race that motivates this).

### 12.3 Proof orchestration (useGamePlay)

The hand proof auto-generates the moment its preconditions are met
(`hooks/useGamePlay.ts:246-278`): a 5-card hand, the session's blinding
factor, and the **opponent's 6 randomness values** received over the relay —
§4's randomness exchange, consumed here. Commitment and state hashes are
recomputed client-side to match the circuits exactly
(`aztec/proofWorker.ts:146-159,161-178,185-192` — poseidon2/pedersen via the
shared bb.js API).

Placement is optimistic: `handlePlaceCard` (`:357-407`) sends the move to the
relay immediately (`:374`), applies the rules locally via the game-logic
engine, and then either proves the move now (both hand proofs ready, `:387-394`)
or queues it (`:396-402`). Queued moves replay later against board snapshots
recorded per move number (`gameStateHistoryRef`, `:209-225`, drained at
`:289-345`) — proofs are deferred, never skipped. Both players accumulate all
nine move proofs (own + opponent's via relay, deduped by state-hash pair,
`:127-135`), so **either** player holds a full transcript at game end
(`canSettle`, `:91`).

Proof generation itself (`aztec/proofWorker.ts`) is `Noir.execute` (witness) +
`UltraHonkBackend.generateProof` per circuit, with backends cached per circuit
(`:16-27`) over one Barretenberg instance (`aztec/proofBackend.ts`). Circuit
artifacts are fetched from `/circuits/*.json` (`aztec/circuitLoader.ts:19,30,42`
— the compiled outputs `npm run copy-circuits` publishes). The module itself
runs on the main thread, but bb.js runs the prover in its own Web Workers (the
build's `main.worker`/`thread.worker` assets), so only witness generation and
marshalling touch the main thread. Measured in Chrome on a 12-core Mac with v6
(20 Nov 2026): a `game_move` proof takes ~0.45 s, cold or warm, with one
~60-70 ms main-thread task; `prove_hand` ~0.2 s with one ~66 ms task. No visible
freeze, so moving this into a worker would buy nothing. The cost also overlaps
the opponent's thinking time by construction: the move is relayed before
proving starts (`hooks/useGamePlay.ts:374` vs `:387-394`).

### 12.4 Settlement (useGameSettlement)

`handleSettle` (`hooks/useGameSettlement.ts:228-465`) is one `txManager.runTx`
whose `execute` is a wait-ladder: wait for the on-chain phase to reach
`active` (`:259-268`), for both hand proofs (`:270-281`), for the settlement
info (`:283-285`), for all nine move proofs (`:291-292`), then backfill any
race-emptied fields (`:294-298`). Only then does it prove: load both circuits,
derive the two VKs in-browser, order the move proofs into the hash chain
(`sortProofChain`, `:746-763`, seeded from the canonical initial hash
`:765-770`), and call `process_game` with all 31 arguments (`:382-399`).

`postEffects` (`:406-451`) then mirrors the contract's settlement math in
TypeScript: the winner's 6 note randomness pairs and the loser's 4 (same
duplicate-aware removal as `triple_triad_game/src/main.nr:683-697`), relays
the loser's plaintext note data over the WebSocket (`:439`), imports the
winner's own notes (§12.6), and releases the phase machine.

The abandoned-game flow (`:468-689`) auto-triggers when the opponent
disconnects mid-game with moves on the table (`:691-699`). The claimant
generates the **dummy padding proofs in-browser** — `Noir.execute` over the
zero-constraint circuit, one per missing move (`:539-555`) — sends
`claim_abandoned_game` (`:587-603`), counts down the dispute window in the UI
(65 s for 5 blocks, `:611-618`), then sends `settle_abandoned_game`
(`:620-679`).

The loser's side is event-driven: `OPPONENT_SETTLING` parks a synthetic
txManager entry so the navigation guard holds (`:179-216`), and `NOTE_DATA`
delivers the plaintext notes for import (`:145-172`), including detecting
which card was taken (`:151-154`).

### 12.5 PXE serialization (txManager)

Ground rule #6 — all PXE operations serial per wallet — is enforced
structurally, not by convention: every simulate/prove/send funnels through one
queue that processes a single item at a time (`aztec/txManager.ts:200-221`).
Two policies matter:

- **Priority within a game, FIFO across games** (`:170-198`): lifecycle txs
  (`deploy_account` 0, `create_game`/`join_game` 1) jump ahead of settlement
  (3–4) *only* among items of the same game (`TX_PRIORITY`, `:22-30`) —
  preventing the deadlock where a queued settlement waits forever on a
  `join_game` stuck behind it.
- **`execute` and `postEffects` run as one queue item** (`:244-258`), so a
  queued settlement can never start between `create_game`'s tx and the
  postEffect that records its result.

### 12.6 Card delivery and persistence

Every mint the player sent — starter cards (`connectToAztec.ts`
`storeAndReceiveStarterCards`), packs (`hooks/useCardPacks.ts`), the
winner's settlement return and the abandoned-game recovery
(`hooks/useGameSettlement.ts` `receiveOwnCards`) — does two things, in this
order (§7; ground rule #9):

1. **Persist** each card's `(cardId, randomness, txHash, noteHashes,
   firstNullifier)` to the card store (`aztec/cardStore.ts`) — enough to
   replay the notes into a fresh PXE after its store is wiped. The note hashes
   come from the `TxEffect` (`fetchTxEffectData`, `aztec/noteImporter.ts`,
   retried because the tx may have just mined).
2. **Receive** the send's offchain messages: `receiveCardMessages`
   (`aztec/pxe.ts`) passes the ones addressed to us, from the NFT contract,
   to `offchain_receive` in batches of 16. The notes appear at the next NFT
   read, which triggers the contract sync that processes them.

Persisting first means a receive that fails still leaves a record. On every
connect the boot-time restore (`connectToAztec.ts`) re-imports every stored
card with `import_note` and reconciles the store against what the PXE holds —
the recovery path; it is idempotent, because the PXE keys notes by nullifier.

The settlement **loser** is the one remaining import on the normal path:
their messages stayed in the winner's browser, so the winner relays the
plaintext (`RELAY_NOTE_DATA`) and the loser imports it
(`importRelayedCards`). The loser's +20 ArenaToken reward is likewise an
untagged note (`mint_reward`), imported with `importTokenRewardNote`; the
winner's own reward is `ONCHAIN_CONSTRAINED` and needs only the PXE to sync
the settlement block, hence the balance-refresh delay.

### 12.7 The relay (useWebSocket) and wallet layer

The WebSocket hook (`hooks/useWebSocket.ts:9-54` is the full surface) carries
four traffic families: matchmaking, game moves, **proof exchange**
(`submitHandProof`/`submitMoveProof` and their opponent-side mirrors), and
**settlement coordination** (`shareAztecInfo` for address+randomness,
`notifyTxConfirmed` for the create/join handshake, `notifySettleStarted`, and
`relayNoteData` for the loser's plaintext notes). Sessions survive reconnects:
a stored session token is replayed via `RESUME` (`:99-106`) with exponential
backoff (`:108-121`), and `connected` only turns true on
`SESSION_ESTABLISHED`. For async code that cannot wait on React's render
cycle, `addMessageListener` (`:50-53`) delivers messages synchronously in the
`onmessage` tick — the bridge that keeps `settlementInfoRef` current
(§12.2).

Before anything connects, the player chooses a wallet
(`components/WalletChooser.tsx`; remembered in `aztec/walletChoice.ts`, asked
again from the menu's Switch Wallet):

- **Nulo**, an Aztec wallet extension for Chrome and Firefox, reached through
  the standard `@aztec-labs/wallet-sdk` (`aztec/nuloWallet.ts`). Discovery the
  player allows in Nulo, an emoji check that both ends derived the same channel
  key (the app writes each emoji the way Nulo's grid draws it, so the two look
  alike), then one capability request scoped to our three contracts, in which
  the player picks the account. Nulo enforces that request call by call: the
  address book (`data.addressBook`) is in it because registering the
  contracts as note senders needs it. `setupConnectedWallet`
  (`aztec/connectToAztec.ts`) registers the contracts, restores this browser's
  stored cards, and claims the starter cards for an account that has none.
  Nulo asks the player to approve every transaction, and the player picks how
  it pays there (Fee Juice, or the network's sponsor); the tx toasts say to
  look in Nulo.
- **The in-browser wallet**, described next.

Everything after connect goes through the `pxe.ts` facade, which holds the
wallet as an aztec.js `Wallet`. The in-browser wallet's PXE upkeep
(`resyncPxe`, `pxeKeepSynced.ts`) does nothing for Nulo, which syncs its own.

The in-browser wallet is the two-phase onboarding documented at
`aztec/connectToAztec.ts:1-11` — prepare (derive keys, show address) → user
funds it → `deployAndRegister` (deploy account, register contracts, mint
starter cards), driven by `hooks/useAztec.ts` and wrapped in
`InstrumentedWallet`, an `EmbeddedWallet` subclass that emits per-phase timing
events for the tx-progress UI (`aztec/instrumentedWallet.ts:1-8`). Field
decoding throughout uses the prefix-checking helpers
(`toFr`/`safeToField`, `aztec/fieldUtils.ts:23`,
`aztec/proofWorker.ts:93-107`) — ground rule #8, because `.simulate()`
results stringify as decimal.

> **Known divergence (work item I):** game transactions currently pay fees via
> `SponsoredFeePaymentMethod` built in `aztec/contracts.ts:9-26` — the method
> the ground rules ban. The Fee Juice onboarding path already exists
> (`FeeJuicePaymentMethodWithClaim`, `aztec/connectToAztec.ts`); migrating the
> in-game fee path to it is revival work item I. Do not copy the SponsoredFPC
> pattern into new code.

### 12.8 Ground rules → frontend code

| Ground rule | Where it's enforced |
|-------------|---------------------|
| #6 serial PXE ops | the txManager queue (`aztec/txManager.ts:200-221`) — nothing touches PXE outside it |
| #8 decimal `.simulate()` results | `toFr` (`aztec/fieldUtils.ts:23`), `safeToField` (`aztec/proofWorker.ts:97-107`) |
| #9 untagged card notes need delivering | `receiveCardMessages` (`aztec/pxe.ts`) after every mint we send; `import_note` for the boot-time restore and the loser's relayed cards (§12.6) |
| #10 in-circuit `game_id`/randomness | frontend only *previews* them via `.simulate()` (`hooks/useGameSession.ts:215-231`), never supplies them to a tx |
