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
private `settle_game` function (`triple_triad_game/src/main.nr:572`).

What the chain learns: nothing about the game. There is no public storage beyond
the deployment's immutables, no public call and no event
(`triple_triad_game/src/main.nr:324-338`). A game's state is a set of
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
  prove_hand/          Open cards: a hand's first three cards against its commitment,
                       checked by the opponent and, in an abandonment claim, on-chain
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
  (`game_id_of`, `:404`). It is never published; nobody without `game_key` can
  compute any of the game's nullifiers.
- **Seats.** A player is identified by `seat = H(H(nhk_app_game, game_key))`
  (`player_secret`/`seat_of`, `:376-388`): proving a seat means recomputing it
  from the player's own key, which is how cancel, claim and contest know who is
  calling without any address being recorded. The same account recomputes the
  same seat, so `join_game` refuses self-play.
- **State as nullifiers** (`n_created`…`n_forfeit`, `:419-476`): `N_created`
  (create), `N_seat2` (pushed by join AND cancel, so exactly one happens),
  `N_joined` (binds the joiner's record), `N_done` (pushed by settle, finalize
  and cancel, so a game resolves once), and the abandonment set (§8).
  Existence checks use `assert_nullifier_exists` (`assert_recorded`, `:480`);
  `joined_game` (`:490`) authenticates both records in one check, because the
  join itself verified record 1.
- `create_game` (`:507`), `join_game` (`:522`), `cancel_game` (`:549`). Cancel
  releases exactly the creator's five prepared return notes, so it cannot mint
  anything else.
- Clients read a game's state by looking up the siloed nullifiers that
  `game_nullifiers` (`:826`) computes; the node reports the block each one
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
with `preview_record` (`triple_triad_game/src/main.nr:811`).

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

`settle_game` (`triple_triad_game/src/main.nr:572`) takes `game_key`, both
records, the move VK, the nine proofs with their 8 public inputs each, and
`prize_move`:

1. `joined_game` authenticates both records (`N_joined` exists).
2. Verifies the nine proofs against the stored `move_vk_hash`.
3. `assert_transcript` (`:126`): every move bound to both records'
   `hand_commit`s, chained, anchored to the empty board
   (`compute_initial_state_hash`), only move 9 ending the game with winner 1, 2
   or 3.
4. Pushes `N_done(game_id)` — a second settlement, or one after an unwound
   abandonment, fails on it.
5. **Win:** `prize_of` (`:162`) reads the prize from the move `prize_move`,
   which must have the loser's parity (player 1 moves at even indices). The NFT
   releases the winner's five returns, the loser's four that were not the prize
   slot (`win_returns`, `:184`), and completes the winner's prize partial with
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

No transcript: claims are timed from the blocks their nullifiers landed in,
using `get_block_header_at` and `assert_nullifier_existed_by` /
`assert_nullifier_did_not_exist_by`. `MIN_ABANDON_SECONDS` = 480 and
`DISPUTE_SECONDS` = 600 (`triple_triad_game/src/main.nr:25-29`).

**Walking away costs a card.** A player who leaves a game the opponent joined
forfeits one of their three *open* cards — the ones the opponent already sees
— to the player who stayed. A creator who leaves before anyone joined loses
nothing: `cancel_game` has no bar and no window (§3), and the client sends it
by itself.

- **Claim** (`claim_abandoned_game`, `:668`): a player proves their seat; the
  clock nullifier (`N_joined` for claim 1, `N_contest(c-1)` after a contest)
  must have existed `MIN_ABANDON_SECONDS` before the anchor; `N_done` must not
  exist. The claim names what it takes by `forfeit_slot`: 0..2 is the OTHER
  player's open card in that hand slot, proven by their open-cards proof
  (`prove_hand`, verified against the stored `hand_vk_hash`) whose first input
  must be their record's `hand_commit` (`forfeit_card_of`, `open_cards_side`,
  `assert_open_cards_of`, `:257-294`); 3 takes nothing and carries the
  claimant's OWN open-cards proof, so a claim never depends on the leaver
  having sent theirs. Pushes `N_claim_slot(c)`, `N_claim(c, side)` and the
  terms `N_forfeit(c, side, slot, card)` (`:471`). Claims are numbered 1..3.
- **Contest** (`contest_abandonment`, `:715`): the OTHER player, inside the
  window — measured from a block in which the claim did not yet exist. Pushes
  `N_contested_by(side)` (once per side), `N_contest(c)` (restarts the clock)
  and `N_resolved(c)`. The claim and its forfeit are gone.
- **Finalize** (`finalize_abandoned_game`, `:752`): anyone, once the window has
  passed since a block in which the claim's terms nullifier already existed —
  so the finalizer must name the claim's real terms (`forfeit_nullifiers`,
  `:861`, gives the four candidates). Pushes `N_resolved(c)` and `N_done`. A
  forfeit releases the claimant's five returns, the leaver's four (every slot
  but the forfeited one) and the card on the claimant's prize partial — the
  shape of a won prize; no forfeit releases both hands. Ten note hashes either
  way, no rewards. The leaver may finalize too: every note was prepared for
  its owner, so nothing can be redirected.

Contest and finalize of one claim both push `N_resolved(c)`, so only one lands;
no tx expiry is needed (an expiry would be a public fingerprint). A full
transcript outranks a standing claim: settlement needs only `N_done` to be free.

What the bar and the single contest cannot stop: with no transcript in a
claim, the player who is stalling may claim too. A client in a live game
therefore contests a claim against it as soon as it lands (§12); a staller who
claims again after that can win the card, because each side contests once.

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
| State machine as nullifiers (no public state) | `triple_triad_game/src/main.nr:419-476` |
| Private existence checks on nullifiers | `triple_triad_game/src/main.nr:480` (`assert_recorded`) |
| Historical block headers as a clock | `triple_triad_game/src/main.nr:668-804` |
| A client-side proof verified on-chain to bind a claim (open cards) | `triple_triad_game/src/main.nr:668` (`claim_abandoned_game`) |
| Cross-contract private calls | `triple_triad_game/src/main.nr:507-548` |
| Recursive UltraHonk verification in a private fn | `triple_triad_game/src/main.nr:572` |
| VK pinning via `PublicImmutable` (readable from private) | `triple_triad_game/src/main.nr:324-338` |
| Proof chaining (hash-linked state transcript) | `triple_triad_game/src/main.nr:126` |
| Unconstrained utility fns (`.simulate()`-only API) | `triple_triad_game/src/main.nr:826` ; `triple_triad_nft/src/main.nr:863` |
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

How a browser drives all of the above. All paths in this section are under
`packages/frontend/src/`. The protocol it implements is
[PRIVATE_GAMES.md](plan/PRIVATE_GAMES.md) §5–6: each client runs the game
itself, and the relay is a pipe for sealed messages.

### 12.1 Layering

The Aztec machinery lives **outside React**, as module-level code that
survives unmounts and navigation:

- `aztec/pxe.ts` is the one door to the wallet: one implementation per chain
  operation, all scheduled on the serial PXE queue (`pxe`, `:780`;
  `runPxeTx`, `:796`).
- `aztec/txManager.ts` is that queue (§12.8).
- `aztec/gameActions.ts` holds every game action — commit, settle, import,
  cancel, claim, contest, finalize. Every chain write goes through
  `runPxeTx`; every wait (for a nullifier, for chain time) happens outside it,
  so nothing holds the queue while time passes.

React sees it through one facade, `useGame` (`hooks/useGame.ts:152`), which
composes four hooks and is the only thing screens consume:

```
useGame                 screens, matchmaking, the menu's stuck games, persistence
 ├─ useGameChannel      key exchange; sealed PEER payloads in and out
 ├─ useGameSession      on-chain lifecycle: create / join, the records
 ├─ useGamePlay         the game itself: our moves proven, theirs checked
 └─ useGameSettlement   settle, import, abandonment
```

Values the UI renders are React state; values async code reads are refs; and
cross-hook access goes only through identity-stable accessors (`getPhase`,
`getGame`, `getMoveProofs`, `waitFor*`), so callbacks stay memoized while
reading current values.

### 12.2 The channel: key exchange and sealed payloads

At `MATCH_FOUND` each client makes an ephemeral P-256 key pair
(`generateGameKeyPair`, `aztec/gameKeys.ts:76`) and sends its public half as
`KEY_EXCHANGE`. From the opponent's half, `deriveGameChannel` (`:87`) derives
with HKDF the game's `game_key` (reduced into the field) and an AES-256-GCM
channel key; `sealPeerPayload` / `openPeerPayload` (`:116`, `:127`) bind the
room id as associated data. `hooks/useGameChannel.ts` (`:65`) runs the
exchange, persists the key pair with the game so a reload can still open the
channel, and delivers `PEER` payloads (`aztec/peerChannel.ts:25`: `RECORD`,
`OPEN_CARDS`, `SETTLING`, `SETTLED`, `CANCELLED`). The exchange is
unauthenticated (PRIVATE_GAMES.md §5.1).

### 12.3 The on-chain pipeline (useGameSession)

The lifecycle is an explicit state machine: `OnChainPhase` with a
legal-transition table (`hooks/useGameSession.ts:17-37`).

- **Creator** (`:386`): `createGameOnChain` (`aztec/gameActions.ts:186`) reads
  the note nonce, derives the secrets, previews the record and persists it
  BEFORE sending `create_game` — all in one queue item, so nothing advances
  the nonce in between. Once `created` is visible on the node,
  `announceRecord` (`:255`) sends the sealed `RECORD` and `TX_CONFIRMED`.
- **Leaving before a join.** Leave works in every phase before a join. A
  creator who leaves during the preview sends nothing (`shouldSend`,
  `CommitAbandonedError`, `gameActions.ts:172`); one whose create was already
  on its way tells nobody when it lands — no `RECORD`, no `TX_CONFIRMED`, so
  no opponent joins — and the menu cancels the game (§12.7).
- **Joiner** (`:451`): on the creator's `RECORD` it waits for `created`, then
  `joinGameOnChain` (`gameActions.ts:217`) and replies with its own `RECORD`.
  `acceptRecord` (`:269`) authenticates a joiner's record by its `joined`
  nullifier before the game becomes `active`.
- `getGame` (`:192`) is everything the chain actions need: hand, key, nonce,
  both records, and both sides' open cards (read from storage when asked,
  `openCardsOf`, `hooks/useGameStorage.ts`).

### 12.4 The game (useGamePlay)

Each client runs the game with `packages/game-logic` (`aztec/localGame.ts`):
its own hand is its five committed cards in committed order; the opponent's
is their three open cards plus two hidden placeholders, filled in as they are
played.

- **Open cards.** Once both records are known, each client proves its hand's
  first three cards against its hand commitment (`generateOpenCardsProof`,
  `hooks/useGamePlay.ts:493`) and sends `OPEN_CARDS` (`sendOpenCards`, `:243`).
  The opponent's are checked (`checkOpenCards`, `aztec/moveChecks.ts:128`,
  called at `useGamePlay.ts:268`) before any of their moves; the checked
  payload stays in storage, because an abandonment claim takes one of those
  cards with it (§12.6).
- **Our move** (`handlePlaceCard`, `:400`): applied locally, proven with
  `game_move` (8 public inputs, including `placed_card_id` and `placed_slot`),
  sealed and sent as `MOVE {moveNumber}`.
- **Their move**: opened and checked — bounds, the local transition and its
  state hashes, the proof's public inputs, and the proof itself
  (`checkOpponentMove`, `moveChecks.ts:89`, called at `useGamePlay.ts:307`). A
  move that fails is refused; such a game can never settle and goes the
  abandonment way.
- All bb.js work — our proofs and our checks of theirs — runs one at a time on
  `onProver` (`aztec/proverQueue.ts:15`).
- **Reconnects.** The transcript is persisted as it grows. After a `RESUME`
  the relay replays the opponent's sealed moves from its log, and
  `ROOM_STATE` tells the client which of its own to resend (`:520-531`).

### 12.5 Settlement and import (useGameSettlement)

The winner settles (`handleSettle`, `hooks/useGameSettlement.ts:271`):
`SETTLING {prizeMove}`, then `settleGame` (`aztec/gameActions.ts:287`), then
`SETTLED {txHash}`. A draw is settled by player 1 alone.

Everyone then imports their OWN notes: `importResolution` (`:344`) rebuilds
each note from the player's own hand and secrets (`selectOwnNotes`,
`aztec/privateGame.ts`) and imports it from the tx effect with `import_note`;
a wrong guess imports nothing rather than something false. The other player
finds the tx from `SETTLED` or — with nobody to tell them — from the game's
`done` nullifier (`importTheirResolution`, `useGameSettlement.ts:183`;
`importDiscoveredResolution`, `gameActions.ts:523`). Nothing about the
opponent is needed beyond the two records and the transcript.

### 12.6 Abandonment

- **Claiming** (`handleAbandonedGame`, `useGameSettlement.ts:362`), from the
  relay's idle warning or an opponent's disconnect. `claimAbandonment`
  (`gameActions.ts:646`) prepares the forfeit first (`claimForfeitFor`,
  `:619`): the opponent's strongest checked open card by `cardStrength`, with
  their open-cards proof — or, without it, nothing, with our own proof. It
  waits for the bar on chain time, sends the claim, then
  `finalizeAbandonment` (`:742`) waits out the window, finalizes with the
  claim's terms and imports: our five plus the card. A contested claim
  stands down and the game goes on.
- **Terms we did not choose.** `claimTermsOf` (`:707`) looks up the four
  `forfeit_nullifiers` of a claim; `finalizedClaimOf` (`:791`) reads a
  finished abandonment's terms, so an import knows whether we took a card or
  lost one.
- **The watcher.** A client in a live game checks every `CLAIM_WATCH_MS`
  (`useGameSettlement.ts:34`) for a claim against it and contests it as it
  lands (`:454-488`): the player is demonstrably here.
- **Races.** Anyone may finalize and both clients do; the loser of a race
  sees `done`, returns null and imports from the winning tx.

### 12.7 The menu: games that still hold cards

`inspectStuckGame` (`hooks/stuckGameCheck.ts:73`) walks the stored records
whenever the player sits on the menu, and once a minute while one needs
them. `assessStuckGame` (`aztec/stuckGame.ts:80`) offers only what the
contract will accept right now — cancellable, settleable, claimable,
contestable, finalizable — or says how long to wait. Resolved games are
imported and forgotten.

What needs no decision happens without a click: a game nobody joined is
cancelled, and a claim whose window has closed is finalized, whichever side
the player is on (`AUTO_RECOVER_KINDS`, `hooks/useGame.ts:39`; `:263`), once
per game per page load. Claims and contests stay buttons.

### 12.8 PXE serialization (txManager)

Ground rule #6 — all PXE operations serial per wallet — is enforced
structurally: every simulate, prove and send funnels through one queue that
runs a single item at a time. Lifecycle txs jump ahead of settlement only
among items of the same game (`TX_PRIORITY`, `aztec/txManager.ts:27`), and a
tx's `execute` and `postEffects` run as one queue item (`runTx`, `:282-299`), so a
queued settlement can never start between a commit and the step that records
it. React reads the queue through `useSyncExternalStore` (`:92-102`).

### 12.9 Card delivery and persistence

Starter cards and packs are delivered as offchain messages: the client passes
the ones addressed to it to the NFT's `offchain_receive` and persists each
card's `(cardId, randomness, txHash, noteHashes, firstNullifier)` to the card
store (`aztec/cardStore.ts`) first, so a failed receive still leaves a record.
Game payouts are never delivered: every owner imports their own from the
resolving tx (§12.5), and the import writes the same card-store entries. On
every connect, `restoreStoredCards` (`aztec/connectToAztec.ts:309`) re-imports
the stored cards with `import_note` — idempotent, because the PXE keys notes
by nullifier — which is what survives a wiped PXE store.

### 12.10 The relay, and what it sees

`hooks/useWebSocket.ts` (`:69`) is the client's whole relay surface. In clear,
the relay reads room ids, public keys, move numbers, tx types and session
tokens; `PEER` and `MOVE` bodies are AES-GCM ciphertext under the channel key.
It pairs players, forwards and buffers sealed payloads, keeps each room's
sealed moves for replay, and times turns for the idle warning
(`GAME_ABANDONMENT_WARNING`, which names the idle player and nothing else). It
sees IPs, pairing, message kinds and sizes, the move count and its timing —
no cards, moves, results, records or keys. Sessions survive reconnects: a
stored token is replayed with `RESUME`, and `connected` turns true only on
`SESSION_ESTABLISHED`.

### 12.11 The wallet

Before anything connects, the player chooses a wallet
(`components/WalletChooser.tsx`; remembered in `aztec/walletChoice.ts`):

- **Nulo**, an Aztec wallet extension, reached through
  `@aztec-labs/wallet-sdk` (`aztec/nuloWallet.ts`): discovery the player
  allows, an emoji check that both ends derived the same channel key, then one
  capability request scoped to our three contracts. `setupConnectedWallet`
  (`aztec/connectToAztec.ts:357`) registers the contracts, restores this
  browser's stored cards and claims the starter cards for a new account. Nulo
  asks the player to approve every transaction.
- **The in-browser wallet**: the two-phase onboarding of
  `aztec/connectToAztec.ts` — prepare (derive keys, show the address), the
  player funds it, then `deployAndRegister` (`:169`) deploys the account,
  registers the contracts and mints the starter cards.

Either way, every transaction pays its own fee in Fee Juice with headroom over
the live base fee (`gasSettingsWithHeadroom`, `aztec/feeSettings.ts`);
sponsored fee payment is banned (`aztec/contracts.ts:19`).

### 12.12 Ground rules → frontend code

| Ground rule | Where it's enforced |
|-------------|---------------------|
| #6 serial PXE ops | the txManager queue (`aztec/txManager.ts`) — nothing touches the PXE outside `aztec/pxe.ts` |
| #8 decimal `.simulate()` results | `normalizeField` (`aztec/privateGame.ts:34`), `toFr` (`aztec/fieldUtils.ts`) |
| #9 untagged notes need delivering | `offchain_receive` for starters and packs; `import_note` by each owner for every game payout (§12.5) |
| #10 per-game values derived in-circuit | the client reads its own with simulate-only `compute_game_secrets` and `preview_record`, and never supplies them to a tx |
