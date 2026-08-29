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

*Open risk, narrowed:* cards are `token_id`s drawn from a 257-card database, so a
collection larger than 257 needs **duplicate** ids. `mint_to_private` does not check
`nft_exists` (only `mint_to_public` does), so duplicates are mintable — but their
behaviour under `commit_five_nfts` is untested. The similarly-named
`commit_five_nfts_with_duplicate_leaves_one` test is NOT about this: it mints six
DISTINCT cards (1..6) and commits five, leaving one. So: **stay ≤257 distinct cards
until a TXE test proves duplicates commit correctly.** `provision-arena-bot.ts`
enforces that limit rather than trusting it. 257 is ample for phase 1 anyway.

**b) "One game at a time" makes the queue worse, not better.**
The stated goal is to avoid long queue waits. But if the bot plays one game at a
time and a bot game takes ~10 minutes (measured: our campaign games are 10.1/10.2/9.9
min for five games, so ~2 min each plus settlement), then player B — who queued to
avoid waiting 20 seconds — waits for the whole bot game instead. The mitigation is
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

**20 seconds optimizes the wrong bottleneck.** On-chain create/join take ~2.5 minutes
in practice. A player matched at 20s still waits minutes for the chain. The queue is
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
- Still open: phase 3 proper (the bot generating hand/move proofs and settling
  on-chain — `circuitLoader.ts` fetches `/circuits/*.json` over HTTP and needs a
  Node file-reading equivalent; `proofBackend.ts` already guards `navigator`/
  `localStorage` so it looks portable), phase 5 (identity pool), phase 6
  (testnet).
