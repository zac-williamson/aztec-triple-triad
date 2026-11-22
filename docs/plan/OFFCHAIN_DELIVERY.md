# Card notes on v6: `offchain_receive` instead of `import_note`

**Status:** shipped with the 22 November 2026 redeploy; see [Steps](#steps).
Every player-facing card mint in production delivers its notes as offchain
messages. Our contracts are not upgradeable, so this waited for a redeploy;
what else that redeploy carried is in [NETWORK_MOVE.md](../NETWORK_MOVE.md).

## How card notes worked before

Every card note was made by `create_and_push_note`. It computed the note hash
from randomness we choose, derived from the owner's `nhk_app` secret and a
nonce, then notified the local PXE and pushed the hash. It sent no message.
Eleven functions used it: starter cards, packs, the settlement and abandonment
mints, the bot's stock, and four test helpers.

With no message, the PXE could not find these notes. So every recipient
imported each note by hand:

1. Fetch the tx effect from the node, polling 5 × 3 s.
2. Pad its note hashes to 64.
3. Recompute the card ids and randomness.
4. Call our `import_note` utility once per note.

`import_note` (with a twin in `arena_token`) re-encodes the note as a
private-note message. It then calls aztec-nr's `process_private_note_msg` and
`validate_and_store_enqueued_notes_and_events` directly. In effect it runs the
framework's message pipeline from outside the framework. The earlier version of
this approach broke when `attempt_note_discovery` went private in 4.3.1.

Ten client call sites depended on it:
- frontend: `connectToAztec.ts` ×3, `useCardPacks.ts`, `useGameSettlement.ts` ×2;
- bot: `ArenaBot.ts` ×2, `BotChain.ts`, `AbandonmentSweep.ts`.

The deterministic randomness is the part worth keeping. A player can always
re-derive their own notes and import them, needing nothing from anyone else.
The settlement and abandonment recovery paths depend on that.

### Dead code found along the way

Ten mint sites also emitted a `CardCreated { note_tag, note_payload }` event
next to each note, delivered with `MessageDelivery::offchain()`. Nothing
received these events:
- No TypeScript read `offchainMessages`. `instrumentedWallet.sendTx` returned
  them and every caller dropped them.
- Importers recomputed ids and randomness themselves (`previewCardPack` and
  `computeNoteRandomness` in `useCardPacks.ts`).

ARCHITECTURE.md §7 used to describe recipients tag-scanning these events; no
code ever did. The events cost proving time: `derive_note_tag` and
`encrypt_card_payload` ran in constrained code for every card minted. Step 2
measured it (gates, below).

## What v6 provides

- **Sender side.** `NoteMessage::deliver(MessageDelivery::offchain())`
  encrypts the standard note message to the recipient. The encryption runs in
  unconstrained code, so it adds no gates. The message comes out as an offchain
  effect:
  - no fee and no log;
  - no tagging index, so bulk mints are not capped by the 84-index tagging
    window that `mint_bot_cards` works around.
- **Transport.** `send()` returns those messages as `offchainMessages`
  (`recipient`, `payload`, `contractAddress`, `anchorBlockTimestamp`),
  including those emitted by nested calls — a settlement's carry messages for
  both players.
- **Receiver side.** The recipient hands the messages to `offchain_receive`, a
  utility that `#[aztec]` injects into every contract; all three of ours have
  it.
  - Each call takes up to 16 messages. Each message is
    `{ ciphertext, recipient, tx_hash: Option<Field>, anchor_block_timestamp }`.
  - The PXE keeps the messages in a persistent inbox, scoped to the recipient
    account. At each contract sync it looks up the tx of every message still
    in the inbox, and processes each one whose tx is found on-chain at its
    anchor block, through the same pipeline as on-chain messages.
  - After a reorg, a processed message goes back to be processed again. It
    leaves the inbox only once its block finalizes — **and until then every
    sync re-fetches its tx receipt** (`sync_inbox` resolves every active
    reception, processed or not).
  - If its tx is never found, a message is dropped after
    `MAX_TX_LIFETIME + 2 h`. A message that arrives late for a tx already mined
    is still processed (`aztec/src/messages/processing/offchain/reception.nr`,
    `step`).

That is the job `import_note` does, done by the framework, and with reorg
handling we don't have.

## Keeping our randomness

`create_note` chooses random randomness, which would lose the recovery
property. We don't need `create_note`, though. `NewNote`
(`aztec::note::lifecycle`) has all-public fields and `NoteMessage::new` is
public. So we keep our own hash computation and return the message:

```noir
// push_card_note: hash + notify_created_note + push_note_hash, as before
NewNote { note, owner, storage_slot, randomness, note_hash_counter }

// create_and_push_note
NoteMessage::new(push_card_note(context, owner, value, randomness), context)

// every player-facing call site
create_and_push_note(self.context, owner, card_id, note_randomness)
    .deliver(MessageDelivery::offchain());
```

Notes stay derivable, so recovery still needs nothing from the sender.

## Design

| Flow | Sender → owner | Normal path afterwards | Recovery |
|---|---|---|---|
| Starter cards, packs | player → self | `offchain_receive` with the send's own messages | re-derive + `import_note` (unchanged) |
| Settlement (win and draw), abandonment recovery | settler → both players / caller → self | the settler receives its own; the other player still gets the plaintext over the relay and imports it (step 3 would forward the messages instead) | each player re-derives their own (unchanged) |
| Bot stock (`mint_bot_cards`) | deployer → bot | **unchanged**: no message; the bot imports from the provisioner's manifest | manifest randomness + `import_note` |

The bot's stock stays on `import_note`. The proposal had the provisioner
write messages into the manifest for the bot to receive, but that misses the
inbox's cost: a received message keeps its tx receipt being re-fetched on every
contract sync until its block finalizes. A player has one to three such txs at
a time. A thousand-card stock minted ten per tx is a hundred, so a hundred
receipt reads per sync — a burst the PXE fires in parallel, against an RPC
that rate-limits. A manifest import is paid once: nothing revisits a stored
note. `mint_bot_cards` therefore sends no message, and a TXE test pins that.

`CardCreated`, `derive_note_tag`, `encrypt_card_payload`, the symmetric
encryption helpers and their two IVs are gone.

`import_note` stays, for recovery: the boot-time restore from the card store
(a wiped PXE, or a receive that failed after the card was stored), the
settlement loser until step 3, and the bot's stock. It still drives aztec-nr
internals, but no longer on the path every mint takes.

### Steps

1. **Spike: done 20 November 2026** on `spike/offchain-delivery`.
   `get_cards_for_new_player` and `purchase_card_pack` built their notes with
   a `NewNote` literal and delivered them offchain. Results:
   - A `NewNote` struct literal compiles from our crate, with no warnings.
   - In TXE (`triple_triad_nft/src/test/offchain_delivery.nr`), the cards
     are invisible after the tx and appear after `offchain_receive` with no
     `import_note` and no explicit sync. Receiving the same messages twice
     does not duplicate them.
   - A received note proves the randomness survived. The inbox stores a
     note only if its hash matches one the tx committed, and that hash was
     computed in-circuit from our derivable randomness.
   - TypeScript encoding, checked against the deployed NFT ABI: each message
     is `{ ciphertext: msg.payload, recipient, tx_hash, anchor_block_timestamp }`.
     A bare `tx_hash` encodes as `Some` and `null` as `None`; plain arrays
     encode as `BoundedVec`s.
2. **Built 21 November 2026** on the same branch, for the next redeploy.
   - **Contract.** Every player-facing mint delivers offchain: starter,
     pack, `mint_for_game_winner`, `mint_for_game_loser` and
     `mint_for_game_draw_offchain`. The bot's stock sends none (above).
   - **Gates** (each function's own circuit; the kernels dominate a full
     proof):

     | Function | Before | After |
     |---|---:|---:|
     | `get_cards_for_new_player` | 30,096 | 29,439 |
     | `purchase_card_pack` | 36,161 | 34,679 |
     | `mint_for_game_winner` | 8,912 | 8,125 |
     | `mint_for_game_loser` | 8,513 | 7,988 |
     | `mint_for_game_draw_offchain` | 8,700 | 8,043 |
     | `mint_single_card_private` (since removed) | 7,901 | 7,768 |
     | `mint_bot_cards` | 11,153 | 11,153 |

   - **TXE:** NFT 32/32, Game 109/109, Token 11/11. New: a settlement's
     messages are addressed to each card's owner, not the settler, and only
     the owner gains the cards; the bot's stock mint sends no messages.
   - **Frontend.** The minting sends return their messages (`MintedTx`), and
     `receiveCardMessages` (`aztec/pxe.ts`) hands the ones addressed to us,
     from the NFT contract, to `offchain_receive` in batches of 16. Starter
     cards (both onboarding branches), packs, the winner's settlement return
     and the abandoned-game recovery all receive; each writes the card store
     first, so the boot-time restore keeps a record if a receive fails.
   - **Bot.** Its settlement return and the abandonment sweep receive, then
     check the cards surfaced; the journal keeps each game's randomness for
     `import_note` should one not.
   - **Unit tests:** frontend 532, bot 186, scripts 74. They include the
     failure cases: a store that throws, or a tx effect the node never
     serves, must not cost the receive.
   - **Browser, local network, 21 November 2026:** `draw-game`,
     `full-game` (both tests) and `multi-game` with two games — 4 passed in
     9.8 min, and again in 12.2 min on the branch's final commit. The specs now assert from each page's console which path
     delivered a mint (`expectCardsReceivedNotImported`), next to the
     existing checks that the cards arrived. The multi-game consoles:

     | | Alice | Bob |
     |---|---|---|
     | Starter | 5 messages received | 5 messages received |
     | Pack | 10 received, no `import_note` | 10 received, no `import_note` |
     | Game 1 (Alice won, claimed #4) | winner: 6 received, no `import_note` | loser: 4 imported from the relay |
     | Game 2 (draw, Bob settled) | 5 imported from the relay | settler: 5 received, no `import_note` |

     Each connect also shows the boot-time restore importing the starter
     cards (above).

     The abandoned-game recovery came last. `abandonment.spec.ts` could not
     pass from 31 August: it claimed at the relay's 60-second idle mark, and
     the contract wanted an hour since the game went active — the claim
     reverted in `claim_abandoned_game_public`. With the bar lowered to eight
     minutes on this branch (ARCHITECTURE §8) and the claim flow waiting it
     out, it passes: the claimant's five cards arrive as offchain messages
     with no `import_note`, and its phase stays idle afterwards (the first
     passing run showed the create/join pipeline restarting on the dead game,
     fixed in the same series).
   - **Testnet, against the redeployed contracts, 22 November 2026:**
     `abandonment.spec` passed on the real chain. The claim mined once the
     game was eight minutes old by chain time, and after the ten-minute
     dispute window the claimant's five cards arrived as offchain messages
     (26.3 min). `multi-game` (a pack and five games) passed in 16.2 min.
3. **Later, optional.** Forward the counterparty's settlement messages over
   the relay, so the player who didn't settle needs no `import_note` either.
   It would not hide anything new from the relay server, which already sees
   both players' per-game randomness (`OPPONENT_AZTEC_INFO`). The loser's +20
   reward (`ArenaToken.mint_reward`) would move with it; it still sends no
   message.

### What building it found

- **A phantom card.** The abandoned-game recovery listed the claimed opponent
  card at `randomness[5]` alongside the caller's five, from when
  `settle_abandoned_game` minted one. It no longer does, so that card went
  into the card store and the collection although it does not exist. Fixed,
  with a test. `mint_single_card_private`, which used to mint that card, had
  no caller left, so the redeploy removed it.
- **A pack no longer depends on the tx effect.** The card store needs the tx
  effect; delivery does not. Before, a tx effect the node never served meant
  the pack's cards were never imported at all.
- **The starter cards arrive twice on their first connect.** The boot-time
  restore re-imports every stored card on every connect, so right after the
  starter cards' messages are received it imports them again. Harmless — the
  PXE keys notes by nullifier and stores one — and deliberate: skipping them
  would let the restore's reconcile step drop them from the card store if
  their messages had not been processed yet.

### What it does not change

- Fees: `CardCreated` was already offchain, and so is its replacement.
- The transaction count: packs stay one transaction (ground rule 12).
- The settlement proof.
- Who can recover what.
