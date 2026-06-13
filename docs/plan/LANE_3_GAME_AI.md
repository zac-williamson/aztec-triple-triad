# Lane 3 — Game/AI (bot brain, house bot)

Branch `lane/3-game-ai` · Worktree `worktrees/lane-3-game-ai`
Owns: `packages/game-logic/`, `packages/bot/` (new).

## Mission
Give the game an opponent: first a local move-selection brain (shared by tutorial,
practice mode, playtest harness, and the house bot), then — if greenlit — a real
on-chain house bot that plays for stakes.

## Sequence

### D1a — Bot brain (0.5–1d) — DONE (lane/3-game-ai 4137406)
Delivered in `packages/game-logic`, exported from the package index:
`chooseBotMove(state, { difficulty: 'random'|'greedy'|'lookahead', seed? }): Move`,
plus `createSeededRng(seed)` and types `Move`/`BotDifficulty`/`ChooseBotMoveOptions`.
The bot moves for `state.currentTurn`; throws unless `status === 'playing'` and a
legal move exists. 100% covered; package thresholds now enforce the 99% bar.
In `packages/game-logic/`: `chooseBotMove(state: GameState, opts): Move`
- Difficulty tiers: `random` (valid random), `greedy` (maximize immediate captures,
  tiebreak on minimizing exposed edge ranks), `lookahead` (1–2 ply over greedy).
- Deterministic when seeded (`opts.seed`) — REQUIRED by the playtest harness for
  reproducible campaigns.
- Pure function, no React/Aztec imports. Unit tests against known board positions
  (capture-forced, chain-capture, deny-capture cases). Keep the 99% coverage bar.
- Consumers: Lane 2 D1b (practice), Lane 8 (campaign policy), D2 (house bot),
  optionally the tutorial's `pickCpuCell` replacement.

### D2 — On-chain house bot (5–10d) — after A2; launch-optional (Zac decision)
New `packages/bot/`: a headless Node player with real stakes.
- `EmbeddedWallet` in Node + Schnorr account (the wallet works in Node — the
  integration package proves it).
- Proving in Node via `packages/integration/src/prover.ts` + `noir-backend.ts`
  (already generate real proofs in tests — reuse, don't rebuild).
- Speaks the existing WS protocol as a normal client (QUEUE_MATCHMAKING,
  SUBMIT_HAND_PROOF, PLACE_CARD, SUBMIT_MOVE_PROOF, settlement messages).
- Join policy: enter the queue when a human has waited > N seconds (Lane 4 provides
  the queue-wait signal/hook).
- Serial-PXE discipline: ONE game at a time per bot account; scale by adding
  accounts, never by concurrent proving on one wallet.
- Ops: funded house account (Zac), systemd unit on Lightsail (Lane 4 owns deploy/).
- The bot must also handle LOSING: settlement transfers one of its cards away;
  it needs a card-pack/re-mint top-up policy so it can't run out of playable cards.

## Cross-lane contracts
- **Provide:** `chooseBotMove` (→2, →8, →D2).
- **Consume:** 4.3.1 SDK migration (←1/2) before D2; queue-wait hook (←4);
  harness campaigns to soak-test D2 (←8).

## ASSUMPTIONS (D1a — decisions where the brief left room)

1. **No player parameter.** The bot moves for `state.currentTurn`. Asking for a
   move out of turn is a caller bug, and `placeCard` would reject the result anyway.
2. **"Minimizing exposed edge ranks" read as minimizing flippability.** Exposure of
   a placement = Σ `(10 − rank)` over the placed card's edges that face an *empty*
   in-board cell (wall- and occupied-facing edges can never be attacked, so they
   count 0). Lower = weak edges hidden, strong edges shown. The literal reading
   (minimize the rank values shown) would be strategically backwards. Exposure of
   chain-flipped cards is not counted — only the placed card's.
3. **Lookahead is exactly 2-ply minimax** (brief allowed "1–2 ply over greedy"):
   own move, then the opponent's lead-minimizing reply; evaluation is card-count
   lead (`placeCard`-computed scores: hand + board). Ties broken by the greedy
   keys (captures, then exposure), then seeded random.
4. **Full information.** `chooseBotMove` trusts both hands in the given
   `GameState` — correct for tutorial/practice/harness. The D2 house bot does not
   know the real opponent hand and must pass a belief-state; with an empty
   opponent hand, lookahead degrades to static evaluation of its own move (tested).
5. **Determinism is per call, keyed only by `opts.seed`** (stateless function,
   fresh mulberry32 per call; mulberry32 is integer-op-only, so sequences are
   engine-independent). Campaigns wanting per-turn variety derive a per-turn seed
   (the self-play tests use `gameSeed * 100 + turnIndex`). Unseeded calls tie-break
   with `Math.random`.
6. **Ties resolve by seeded-random choice among equals,** not first-in-enumeration —
   keeps practice games varied while staying reproducible under a seed.
7. **Validation is minimal by design:** `status === 'playing'` and at least one
   legal move; hand/board parity is not checked, so crafted positions (tests,
   belief-states) are accepted.

## ASSUMPTIONS (card-DB consolidation — June 2026 handoff from lane 7)

8. **Kept the legacy export surface** (`CARD_DATABASE`, `getCardById`,
   `getCardsByIds`, `packRanks`, `unpackRanks`, `verifyCardRankConsistency`):
   backend `GameManager`, `packages/integration` tests, and
   `scripts/e2e-contract-test.ts` all import these names. Canonical ids 1-50
   were verified byte-identical (names + ranks) to the old 50-set, so the swap
   is a pure data extension — no consumer breaks, which is why this shipped
   without a question gate. Both outside consumers still typecheck (integration
   has two pre-existing `noir-backend.ts` SDK-arity errors, untouched by this).
9. **Intended backend behavior delta:** `getCardsByIds` now resolves ids
   51-256 instead of throwing, so `GameManager.validateCardIds` accepts the
   full canonical range its own WS validation (1-256) already advertises.
   Until now, any hand with a card above 50 was rejected at game creation.
10. **The ten duplicate legendaries are canonical:** ids 247-256 re-issue the
    original legendaries (ids 41-50, `oldId` in the JSON) with identical
    ranks. Tests document the duplication rather than deduping it.
11. **cards.ts is generated, not authored** (`npm run generate:cards`, pinned
    against `scripts/card-database-256.json` by tests). `axolotlCards.ts` was
    deleted outright: zero consumers outside this package, and its 4-tier
    `determineRarity` contradicted the NFT contract's 5-tier
    `CARDS_PER_POOL`/banding scheme. The 5-tier `Rarity` type now lives in
    `types.ts` and each generated card carries its `rarity`.

## Constraints
- game-logic stays pure TS, zero Aztec deps — that purity is what makes it reusable
  in-circuit-checking (harness) and in Node (bot).
- Ground rules in MASTER_PLAN.md apply to `packages/bot/` (EmbeddedWallet only,
  serial PXE, toFr helper, import_note after create_and_push_note).
