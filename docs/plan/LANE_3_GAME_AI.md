# Lane 3 — Game/AI (bot brain, house bot)

Branch `lane/3-game-ai` · Worktree `worktrees/lane-3-game-ai`
Owns: `packages/game-logic/`, `packages/bot/` (new).

## Mission
Give the game an opponent: first a local move-selection brain (shared by tutorial,
practice mode, playtest harness, and the house bot), then — if greenlit — a real
on-chain house bot that plays for stakes.

## Sequence

### D1a — Bot brain (0.5–1d) — START HERE, others are waiting on it
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

## Constraints
- game-logic stays pure TS, zero Aztec deps — that purity is what makes it reusable
  in-circuit-checking (harness) and in Node (bot).
- Ground rules in MASTER_PLAN.md apply to `packages/bot/` (EmbeddedWallet only,
  serial PXE, toFr helper, import_note after create_and_push_note).
