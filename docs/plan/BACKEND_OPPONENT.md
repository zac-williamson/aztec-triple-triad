# Backend opponent ("arena bot") — plan

Status: **planning + phase 1 build**, 2026-08-29. Author: Claude (autonomous session).
Supersedes nothing; this is the first written plan for the idea raised 2026-07-07.

## The ask, as given

> Remove the "play against computer" button. Build a backend service that monitors
> the matchmaking queue; if a player has been waiting ≥20s, the backend becomes the
> opponent, generating proofs and completely mimicking a player. Needs the backend
> player to hold a very large number of cards (contract update) and to track games
> in flight (cards committed to one game cannot be used in another). Start with one
> game at a time — player B waits in the queue while the bot plays player A. Plus a
> monitoring service for core metrics and breakage detection.

Also asked: how do other games canonically handle AI-pretending-to-be-a-player, and
what is this design missing?

---

## 1. What the codebase already gives us

| Piece | Status | Where |
|---|---|---|
| Bot move AI | **exists**, 3 difficulties (`random`/`greedy`/`lookahead`), seeded RNG | `packages/game-logic/src/bot.ts` |
| "Play against computer" | is **practice mode** — local, offline, no chain | `packages/frontend/src/practice/` |
| Matchmaking queue | `queuePlayer` / `tryMatch(livePlayerIds)` pops a **pair** | `packages/backend/src/GameManager.ts:384` |
| WS protocol | complete and symmetric; a Node client can speak it | `packages/backend/src/types.ts:41` |
| Node-side Aztec client | proven in this repo (EmbeddedWallet + PXE + bb.js in scripts) | `scripts/deploy-testnet.ts`, `scripts/provision-playtest-accounts.ts` |

## 2. Two assumptions in the ask that do not hold

**a) "Needs an update to the smart contract" — probably not.**
`mint_to_private(to, token_id, packed_ranks)` is gated on `minter`, a
`PublicImmutable` set at construction to the deployer, whose key we hold. It mints
to any address and delivers `onchain_constrained()`, so the recipient's PXE
discovers the note normally — no manual import. Reading a large collection is
already paginated: `get_nfts_for_user(owner, page_index) -> ([Field; 10], has_more)`,
and the testkit already loops pages.

So a large bot collection is **mintable and readable today**. Cost is one tx per
card, which is a one-time setup, not a per-game cost. Avoiding the contract change
also avoids a redeploy — which, given the testnet re-genesises roughly quarterly and
each recovery costs a day, is worth real money.

**RESOLVED on-chain (2026-08-29): `token_id`s are GLOBALLY UNIQUE.**
`mint_to_private` itself does not check, but it enqueues `finalize_mint`, which
asserts `!nft_exists` against a **contract-wide** map. Proven by a real mint failing
`Assertion failed: Token already exists`. Consequences, and they matter:

- Duplicates are **impossible**, not merely untested. The
  `commit_five_nfts_with_duplicate_leaves_one` test never spoke to this (it mints six
  DISTINCT cards and commits five).
- **The whole bot pool shares ONE 257-card budget.** Every identity needs a disjoint
  slice; `provision-arena-bot.ts` takes `--offset` and defaults to `index * cards`
  (correct only for a uniform pool — pass it explicitly otherwise, or the second mint
  fails).
- That budget is a hard ceiling on the pool's combined LOSS BUDGET. With no re-mint
  (the recommended default), total bot inventory across all identities can never
  exceed 257 minus whatever the mint path has already consumed. Sizing the pool is
  therefore a real economic decision, not a config knob.
- Player starter/pack cards do NOT consume it: those go through
  `get_cards_for_new_player` / `create_and_push_note`, which never touch
  `nft_exists`. Only the `mint_to_*` path registers ids.

**b) "One game at a time" makes the queue worse, not better.**
The stated goal is to avoid long queue waits. But if the bot plays one game at a
time and a bot game takes ~10 minutes (measured: our campaign games are 10.1/10.2/9.9
min for five games, so ~2 min each plus settlement), then player B — who queued to
avoid waiting 30 seconds — waits for the whole bot game instead. The mitigation is
strictly worse than the disease for everyone after the first player.

The fix is not complicated: a **pool of bot identities**, not one. Each is an
independent account with its own cards, so N concurrent bot games need no
cross-game card bookkeeping at all — the "cards committed to one game cannot be used
in another" problem dissolves, because no two games share an account. Phase 1 can
still run with `poolSize = 1`; it just must not be *designed* around one.

## 3. What other games actually do

Canonical patterns, roughly in order of how common they are:

1. **Backfill bots.** Halo Infinite, Apex, most mobile PvP. When matchmaking exceeds
   a latency budget, fill the empty slots with bots. The bot is a *session-scoped
   puppet* on the server — it has no persistent account, no inventory, no economy.
2. **Disguised bots / bot lobbies.** Common in mobile F2P, especially for new
   players' first sessions. Human-looking names and profiles. Ethically contentious
   and frequently the subject of press when discovered.
3. **Asynchronous ghosts.** Clash Royale-style: you play a *recording* or a
   statistical model of a real player's deck, not a live opponent. Extremely cheap —
   no live bot, no matchmaking at all.
4. **AI takeover on disconnect.** Rocket League, Overwatch. The AI inherits an
   existing player entity rather than creating one.
5. **Explicit, labelled practice mode.** No pretence. (What this app has today.)

**The load-bearing observation:** in essentially all of these, the bot is *not a real
economic actor*. It does not own persistent assets, and it cannot win or lose them.
That is the single biggest difference between the canonical pattern and the ask here,
and it is where the risk concentrates.

## 4. What the ask is missing

**The bot is a real economic actor, in both directions.** Settlement transfers a card
from loser to winner. So:

- **Players who beat the bot permanently extract cards from it.** A "very large
  number of cards" is not just a concurrency budget — it is a *loss budget*, and a
  determined player farms it. If the bot re-mints to replenish, it becomes an
  unbounded card faucet and card scarcity is gone. This needs an explicit, stated
  economic policy; it is a game-design decision, not an implementation detail.
- **The bot winning takes a real card from a real player**, who queued expecting a
  human. Undisclosed, that is materially worse than losing to a person.

**Real cost per bot game.** Three on-chain transactions plus eleven client proofs,
with the recursive settlement proof the expensive one. The bot pays Fee Juice every
game, so bot Fee Juice becomes an ops burden that scales with player count and must
be monitored and topped up — the same treasury-drain shape as the playtest pool.

**The threshold optimizes the wrong bottleneck.** On-chain create/join take ~2.5 minutes
in practice. A player matched at 30s still waits minutes for the chain. The queue is
not where the latency is. If the goal is "the app feels responsive when nobody else
is online", the higher-leverage fix is perceived-latency work on the create/join path,
not manufacturing opponents.

**Disclosure.** This app's stated purpose is to demonstrate Aztec's capabilities and
serve as a learning resource. An undisclosed bot that takes users' assets is a
reputational risk far out of proportion to the benefit — and a *disclosed* one is
arguably a better demo, because it shows the protocol working against an automated
player.

## 5. Recommendation

Build the bot, with three deviations from the ask:

1. **Bot identity pool, size configurable, default 1.** Removes the head-of-line
   block and dissolves the cross-game card-locking problem. This is the one change
   that materially decides whether the feature helps or hurts.
2. **Disclose the bot in the UI** ("Arena Bot" opponent label). Cheap, removes the
   integrity problem, better demo.
3. **Bounded bot treasury with metrics on net card flow**, and an explicit decision
   (yours) on whether it re-mints. Default for now: **no re-mint**, alert when the
   bot's collection drops below a threshold. A silently-refilling faucet is the
   failure mode that is hard to walk back.

Keep from the ask unchanged: real proofs, real on-chain settlement, complete
mimicry of a player over the existing WS protocol, and the monitoring service.

**Do not remove practice mode.** It is offline, free, instant, and it is the correct
answer for "I want to learn the game". The bot addresses a different problem (an
empty queue on a live chain). Removing it trades a good free feature for a costly one.
I have left it in place; say the word if you disagree.

## 5a. Constraints found by actually running it on-chain

Each of these was invisible to typechecking and unit tests, and each changes how
the feature must be operated.

1. **One identity per PROCESS.** `pxe.ts` binds the wallet in a module-level
   global (`setPxeWallet`), so two `BotChain`s in one process silently share the
   last-connected wallet. The pool in §5 is therefore N processes, not one
   process with N identities — better for CPU isolation anyway, since proving is
   the bottleneck. `BotChain` now throws rather than letting them merge.
2. **`token_id`s are globally unique** (`finalize_mint` asserts `!nft_exists`).
   The whole pool shares ONE 257-id budget and each identity needs a disjoint
   slice. That budget is the pool's combined loss ceiling.
3. **The bot must onboard like a player.** `note_nonce` is initialised only by
   `get_cards_for_new_player`; minting does not touch it, so a purely-minted bot
   could never commit a hand ("Note nonce not found").
4. **P2 must wait for P1's create to CONFIRM, not merely to be shared.** P1
   shares its game id early so P2 can prepare; joining on the share races the
   chain and fails "Game not in created state".
5. **Committed cards vanish from the PXE until settlement.** So "held" ≠
   "minted": provisioning must reason about what was minted (the manifest), and a
   bot with a game in flight legitimately holds fewer cards than it owns. A
   game that never settles strands its five cards indefinitely — which is the
   real operational risk behind the loss budget, and an argument for an
   abandonment sweep before the pool runs unattended.
6. **Every send needs the node** in its options (`getCurrentMinFees` fee
   headroom), or it fails with an unhelpful undefined-property error.

## 6. Execution phases

| Phase | Deliverable | Chain? |
|---|---|---|
| **1** | Bot service skeleton: WS client, joins a game, plays all 9 moves via `chooseBotMove`, off-chain only | no |
| **2** | Queue integration: 20s timer, bot claims a waiting player, disclosure flag in `GAME_START` | no |
| **3** | Chain integration: bot account + PXE, `commit_five_nfts`, move/hand proofs, settlement | local sandbox |
| **4** | Metrics + health: games played/won/lost, card net flow, Fee Juice balance, match latency, failure counters | — |
| **5** | Bot pool (`poolSize > 1`) and per-identity game tracking | local sandbox |
| **6** | Testnet validation + contract redeploy **only if** the duplicate-token_id risk forces one | testnet |

**Phases 1–4 are safe to build and validate without touching testnet.** Phase 6 is a
deliberate, human-approved step: a redeploy orphans the live contracts and the
remaining provisioned accounts, and must not happen while nobody is watching.

## 7. Session log

- 2026-08-29: plan written; findings above recorded.
- 2026-08-29: **phases 1, 2 and 4 done and green.** `packages/bot` (21 tests,
  incl. a real backend + real bot + simulated human playing a full game),
  `GET /queue`, `GET /metrics`, token-gated `REGISTER_BOT`, and the "⬡ Arena Bot"
  disclosure badge wired backend → hook → HUD (376 frontend tests).
  Bot outcome counters are recorded SERVER-side so they survive a bot restart.
  `botCardNetFlow` is documented as not-yet-wired rather than silently reading 0.
- 2026-08-29: **phase 3 groundwork**: `scripts/lib/arenaBotAccount.ts`
  (deterministic identity, 6 tests) and `scripts/provision-arena-bot.ts`
  (deploy + mint a collection via minter-gated `mint_to_private`, verified
  through the paginated reader). `--dry-run` works with no chain. **Not yet run
  against a chain** — that needs a sandbox, and is the next step.
- 2026-08-29: **phase 3 substantially done, validated on a local sandbox.**
  - `scripts/provision-arena-bot.ts` RUN FOR REAL: bot account funded and
    deployed, 12 cards minted via minter-gated `mint_to_private`, verified
    through the app's own paginated reader. **§2a is now proven, not argued: no
    contract change is needed.** Minting is idempotent (re-runs top up rather
    than minting duplicate token_ids).
  - The frontend's whole chain layer now RUNS IN NODE — `pxe.readPrivateCards`
    returned the bot's 12 cards. Required removing the last browser assumptions:
    pluggable circuit + contract artifact sources, a shared
    `registerGameContracts`, and `config.ts` falling back to `process.env`
    (the production bundle was rebuilt and asserted to still carry its
    addresses). The bot therefore executes the SAME code players do rather than
    a parallel implementation that could drift.
  - `BotChain` (chain adapter) + `ArenaBot` chain mode: the bot selects a hand
    from cards it ACTUALLY holds, commits via create_game as P1 / join_game as
    P2, shares the in-circuit-derived game id, and confirms the tx over the
    relay. 35 bot tests, 7 covering the commit paths.
  - Guards that fail at startup rather than per game: manifest rollupVersion vs
    the live node (re-genesis orphans the bot exactly as it does the playtest
    pool), derived address vs manifest, and a refusal to start half-configured.
- 2026-08-29: **proof generation done.** `BotProofs` calls the frontend's own
  proofWorker, so the bot proves with the SAME circuits and witness encoding a
  player does. Verified in Node against the compiled circuits: `prove_hand`
  (2 public inputs, 458 fields, commitment bound as the first public input) and
  `game_move` (6 public inputs, state hash advances). 458 = the
  `RECURSIVE_ZK_PROOF_LENGTH` checked during the 5.2 migration, so the shapes
  are what settlement expects. Proving is serialised and survives a rejection.
  `ArenaBot` submits the hand proof once BOTH its own preview and the
  opponent's randomness exist, and a move proof after each of its own moves.
  Per-game proof inputs are cleared on game end so a stale blinding factor
  cannot leak into the next game. 45 bot tests.
- 2026-08-29: **settlement done.** `settlementArgs.ts` extracts the ordered
  `process_game` transcript assembly out of `useGameSettlement` so browser and
  bot build it identically (a wrong order is only rejected on-chain, after the
  recursive verification). The bot gathers the transcript from both players over
  the relay, keys move proofs by chain link so replays collapse, settles on a
  win, settles a draw ONLY as player 1 (single-settler — a second settler
  reverts), and refuses an incomplete transcript naming what is missing.
  50 bot tests.
- **Phase 3 is functionally complete**: the bot funds, deploys, holds cards,
  commits, proves and settles. What remains is a full chain-mode game end to end
  on the sandbox (bot vs a scripted human, all three txs) — the pieces are each
  verified but have not yet been run together.
- 2026-08-29: **chain path exercised on a sandbox, piece by piece.** Observed
  working in real runs: the bot funds and deploys, claims its nonce, holds a
  minted collection, offers a game to a waiting player, is matched by ordinary
  matchmaking with `opponentIsBot=true` disclosed, commits via `join_game`,
  submits its hand proof, and submits ALL FOUR of its move proofs. It also won a
  game and entered settlement.
- **NOT yet observed: a settled game on-chain.** The blocker is the test
  harness, not the bot: the scripted opponent's own move proof fails
  "Circuit execution failed: Owner not set correctly" (the bot's succeed in the
  same run), so the 9-link transcript never completes and neither side can
  settle. Fixing that opponent is the next step — it is test code.
- Nine defects were found ONLY by running against a chain, every one invisible
  to typechecking and 56 unit tests: missing `node` on sends, one-identity-per-
  process, globally-unique token ids, the missing `note_nonce`, joining before
  confirmation, held-vs-minted accounting, a commit/turn deadlock, reading proof
  inputs across an await, and re-queueing during the /queue fetch.
- 2026-08-29 (late): the "Owner not set correctly" failure was ROOT-CAUSED from
  the circuit rather than another chain run. `game_move/main.nr:168` asserts
  `board_after[cell].owner == current_player`, and both the bot and the harness
  accepted ANY later board as the move's `after` — by which point our card may
  already have been captured, so the owner reads as the opponent. Both now
  require exactly `moveNumber + 1`. The bug was latent in the BOT too, not just
  the harness; it had simply been lucky with message timing. Unit-tested; **not
  yet verified on-chain** (see below).
- **The "sandbox is broken" entry above was WRONG, and the bug was mine.** I had
  been restarting the sandbox with `pkill -f "aztec start --local-network"`. That
  pattern never matches: the real argv is `node …/index.js start --local-network`,
  so `pkill` matched nothing and exited non-zero, every "clean restart" silently
  left the OLD sandbox running, the new one died on `EADDRINUSE`, and I kept
  talking to a stale instance whose L1 clock had drifted hours from wall time —
  hence "No L1 to L2 message found" and `runBuild returned undefined`. It looked
  like a regression precisely because it was perfectly reproducible. **Kill the
  sandbox by port — `kill -9 $(lsof -tiTCP:8080 -sTCP:LISTEN)` — and verify the
  port is free before starting another.** No Aztec defect involved; the two early
  successes were simply the first, un-stale instance.
- Still open: phase 5 (identity pool, as N processes — the per-identity store
  above is its prerequisite and is now in place); phase 6 (testnet, which needs a
  deliberate, watched redeploy); and the abandonment sweep below.

- 2026-08-29 (later): **a full chain game SETTLES, in both directions.** Three
  defects stood between the previous entry and this one, and all three were
  invisible to typechecking and to 65 unit tests:
  1. **An unprovable first move.** A move proof binds BOTH card commitments and
     must be proved against the EXACT post-move board. Player 1 moves first, so
     it routinely played before the opponent's hand proof arrived; the proof was
     then impossible — not then (no commitment) and not later (the board has
     moved on, and our card may be captured). The pending move was dropped in
     silence and the transcript stuck at 8/9. Both sides now hold the turn until
     both commitments are known, and **both** completions release it — covering
     one direction only converts the dropped proof into a deadlock.
  2. **Two identities sharing one LMDB store.** `EmbeddedWallet` defaults to
     `aztec-wallet-data`, keyed only by chain id and rollup address, so the two
     processes the design *requires* opened the same store and wedged it:
     "New highest finalized index (1) must be higher than the current one (2)",
     once per sync, forever. Now `aztec-wallet-data/identity-<n>`. This was
     always going to break the N-process pool; it broke the harness first.
  3. **Leaving at GAME_OVER drops the last move proof**, which is generated
     *after* the relay ends the game. The winner then waits out its whole settle
     window for a 9th link nobody will send. This applied to the real browser
     client too — **now fixed there**: `useGamePlay` tracks `owedMoveProofs` and
     `useUnloadGuard` prompts before unload while any move proof is unsent or a
     settlement is in flight. It converts an accidental close into a deliberate
     one; it cannot stop a crash, which is what the sweep is for.
  Verified on a local sandbox: player wins → player settles and takes a bot
  card; **bot wins → the BOT settles on-chain** and takes a player card
  (`settlements: 1`). That second path is the one with real consequences and it
  had never run before.
- 2026-08-29: **provisioning also needed ArenaToken registered.**
  `get_cards_for_new_player` calls `ArenaToken.mint_private`, so a PXE that knew
  only the NFT failed the starter claim with "No contract instance found" —
  raised from a call the script never makes directly, so it reads as an NFT bug.

- 2026-08-29 (final): **six settled chain games, and a fourth defect.** After
  the three fixes above, a repeat run deadlocked — both processes at 0% CPU, no
  L2 blocks, fourteen minutes. Cause was one of those fixes: releasing a held
  turn gave `maybeMove` three callers, and two firing for the same turn
  scheduled two `PLACE_CARD`s. Under `difficulty: 'random'` the second picks a
  DIFFERENT cell, so the relay applies the first while `pendingMove` describes
  the second — no echoed board matches it again, and the bot stops proving AND
  stops playing. Guarded with a monotonic `moveScheduledFor`, checked BEFORE
  choosing the move (the non-determinism is what makes the duplicate harmful
  rather than merely redundant). **The first regression test I wrote for this
  passed without the guard** — it never reached the duplicate path; reverting
  the fix to watch the test fail is the only thing that caught that.
  Final tally on the sandbox: **6 settled games, 3 consecutive green at the end,
  zero move/commit/proof/settle failures.**
- 2026-08-29: the harness now **fails fast on a card shortage**. The bot logs it
  and correctly stays idle, but the harness sat out its full 30-minute deadline
  waiting for a game that could never start.

**Operational note from testing, now measured.** Every incomplete game strands
its five committed cards. After a session of debugging, each identity showed
**25 cards committed to unsettled games** — five aborted runs apiece — on top of
the cards genuinely lost to settlements. The bot ran itself down to ONE spendable
card and stopped queueing.

That is the loss budget in miniature, and it makes two things concrete:
- an **abandonment sweep is a prerequisite** for running the pool unattended,
  not a nice-to-have. The bot cannot cancel (it only joins), so stranding is its
  only failure mode and it is monotonic. **Built and verified on-chain**
  (2026-08-29): `GameJournal` persists each game's transcript as it grows, and
  `AbandonmentSweep` claims → waits the dispute window → settles → imports the
  re-minted notes. Opponent walks out after 2 moves → spendable 6 → 11 (+5).
  One defect it took a chain run to find: `settle_abandoned_game` re-mints via
  `create_and_push_note`, so without an explicit `import_note` the cards are
  ours on-chain and INVISIBLE — a recovery that reports success and returns
  nothing.
- `cardsStranded` and the spendable count are the metrics to alert on. A bot
  that is out of cards fails *quietly and correctly* — it stays idle — which is
  precisely why nobody would notice.
