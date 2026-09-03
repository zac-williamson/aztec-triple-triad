# Production readiness — open items

Working list, kept in priority order. Each item states what is wrong, how we
know, and what "done" looks like — because several things on this list were
previously believed done on the strength of a check that could not fail.

Status: `OPEN` · `IN PROGRESS` · `DONE` · `ACCEPTED` (a decision, not a defect)

Context: as of 31 Aug 2026 the full flow is verified on the deployed app, both
ways round. Against the bot — onboarding from an ETH-only wallet, a nine-move
game, and all three settlement paths (winner, loser, draw) with the wagered
card actually changing hands: `packages/playtest/scripts/prod-play.mts`. And
between two people, which is the intended primary path and exercises a
settlement relay the bot otherwise stands in for:
`packages/playtest/scripts/prod-pvp.mts`.

Items 1–13 are closed except the contract audit (item 11), which is a decision
for the project rather than a defect to fix, and two entries marked ACCEPTED
where the honest answer was a stated limit rather than a change.

**The contracts those items were verified against no longer exist.** They were
replaced on 1 Sep to fix a double-mint defect and to make a completed game
claimable. Items 14-25 cover that work. Both recovery paths — the `<= 8` prefix
and the complete-game `n == 9` — are now verified on the deployed instance
(item 15), so the contract audit (item 11) is the only thing left open. Re-read
item 11 with 14-25 in hand: two of its five audit areas changed.

---

## P1 — Correctness, unexplained

### 1. Winner's +20 ArenaToken did not appear · `DONE` (31 Aug)
Was the harness sampling early, not a lost reward — but only provably so after
the harness was made to wait for it.

The token note uses ONCHAIN_CONSTRAINED delivery and needs a PXE block sync, so
the app refreshes the balance ~5s AFTER the cards land. Reading both together
caught 100. With an explicit wait the run reports
`6 cards [1,2,3,4,5,5], 120 tokens`.

prod-play.mts now fails if the reward does not arrive, so this cannot be
assumed away again.

### 2. Cards stranded by abandoned games · `DONE` (31 Aug) — cause fixed
The bot no longer commits cards it could not recover.

Recovery requires BOTH hand proofs, and the bot used to commit as soon as
player 1's create_game confirmed — before the opponent had proved anything. A
player who left in that window stranded five cards permanently.

It now shares its randomness (which is what unblocks THEIR hand proof, so this
cannot deadlock), waits for that proof, and only then commits. If it never
arrives, nothing was ever at stake and the watchdog tidies up.

The five already stranded in `0x162a5204…` and `0x16db8bf8…` remain
unrecoverable — the claim needs a proof that was never made. Bounded, visible
as `cardsStranded`, and can no longer grow from this cause.

### 2b. Original text, for the record · `CLOSED`
Five cards are locked in games the bot can never claim (its journal is missing
the opponent's hand proof), and two such games are known:
`0x162a5204…`, `0x16db8bf8…`. Health reports `cardsStranded: 5`.

Mostly self-inflicted during this session's runs, but a player who closes their
tab produces the same thing.

**Done when:** the sweep can recover a game whose opponent never proved, or we
can state precisely why it cannot and the loss is bounded and monitored.

---

## P2 — Confidence in the result

### 3. Nothing runs the production check on a schedule · `DONE` (31 Aug)
`RUNS=n ./scripts/prod-smoke.sh` plays real games against the deployed app and
fails loudly, and running it is now part of the release runbook
(`deploy/DEPLOY.md`, "Before announcing a release: play a real game").

It earned its place twice over.

On its second run it surfaced `Timed out waiting for move proofs: have 8/9` —
the winner unable to settle, and since a win has exactly one settler, five cards
a side stranded. That looked like the 30s `MOVE_PROOF_WAIT_TIMEOUT` being too
tight, so it went to 180s.

**It came back at 180s**, which is what finally identified the real cause. The
bot's log:

    23:12:01  move proof 5 submitted
    23:12:04  game over: player1 (bot was player2)

Three proofs where four were owed. The move that ENDS a game is proved after the
relay has announced GAME_OVER — the ordinary sequence — and on a loss the bot
has reset to idle by then, so its post-await `this.gameId !== gameId` check
dropped the finished proof in silence. No timeout could have been long enough;
the ninth proof was never coming. The frontend had the same shape, which would
have stranded a human opponent whenever a player left while their last proof was
still generating.

The 180s stays — proving does take time, and player-vs-player needs the
headroom — but it was never the bug. Two runs of this check are what separated
the two.

**Fixed and verified on production**, with the race landing the wrong way both
times, which is what makes it proof rather than luck:

    23:58:01  game over: player1 (bot was player2)
    23:58:01  move proof 7 submitted (after game over)
    00:00:06  imported 4 card(s) returned by the winner

    prod-smoke: 2 passed, 0 failed of 2

Both runs were WINS — the settling side, the one that used to strand — and both
settled. Under the old code those two games would have cost ten cards. The
`(after game over)` marker exists so the fixed branch is visible in the log
rather than inferred from timestamps.

It also cried wolf once, which was worse than useless: it decided pass/fail by
grepping for settlement wording that the losing path never prints, and reported
a perfect game as a failure. prod-play now prints one fixed-shape verdict line
and the script reads that.

**Not scheduled, deliberately.** Scheduling means a funding key in CI and ~25
minutes of runner time per run. The ten-minute uptime probe (item 4) answers
"is it up"; this answers "does it still work", on a human's decision to ship.
Worth revisiting if releases become frequent.

### 4. The uptime probe runs on the box it monitors · `DONE` (31 Aug) — with a caveat
`.github/workflows/uptime.yml` runs on GitHub's infrastructure, so it survives
anything that takes the box with it. It checks
only what an outsider can see — the relay answers, the site serves an app
bundle, and the testnet has not re-genesised (a pinned `rollupVersion`, since
that failure looks like a perfectly healthy site with a game that can never
start). The bot's internals stay with the on-box probe, whose /health is bound
to localhost on purpose.

**Two things to know.**

Scheduled workflows only run from the DEFAULT branch, which is `main` — 507
commits behind `testnet`. The file has to be on `main` to fire at all. It needs
no checkout, so a stale `main` costs it nothing.

And **the schedule is a hope, not a guarantee.** At `*/10` it did not fire once
in three and a half hours — zero scheduled runs repo-wide — while a manual
dispatch of the same file passed in ten seconds. Nothing was misconfigured: the
workflow is active, on the default branch, in a public non-fork repo with
Actions fully enabled. GitHub's scheduler is best-effort and drops runs under
load. It is now on `7,22,37,52`, which follows GitHub's own advice to avoid the
hour boundary and the shortest interval, but **it has not yet been observed
firing on its own** and that should be checked before this is relied on.

What this does deliver either way is a probe that runs somewhere other than the
box it watches. The on-box `deploy/triad-health.timer` is the one on a real
timer; this covers the failure that one can never report.

### 5. Player-vs-player never exercised on production · `DONE` (31 Aug)
Two browsers, two throwaway accounts, one game on the deployed app.
`packages/playtest/scripts/prod-pvp.mts` drives both sides and checks both.

That it was player-vs-player is proven rather than assumed: both of the
harness's own pages report the SAME on-chain game id, one as player 1 and one
as player 2, so the bot cannot also have been in it.

    MATCHED player-vs-player in 0x1cb26389… — north is player 1, south is player 2
    move 9: north → [2,1] — board 9/9, score 8-2
    [north] settlement CONFIRMED on-chain  (0x1fbfae5c…)
    [south] told: the winner took card 1
    north: 6 cards [1,1,2,3,4,5], 120 tokens
    south: 4 cards [2,3,4,5], 120 tokens

The part that had never run on production is the last two lines. Against the
bot, the bot relays the settlement note data that lets the loser import their
returned cards and their +20. Between two people that relay IS the winner's
browser, and if it were broken the loser would silently end four cards down and
twenty tokens short. Both sides ended correct.

Two runs have now passed end to end with the harness reporting its own verdict:

    RESULT: pass winner=player1 moved=1 winner_cards=6 loser_cards=4 \
            winner_tokens=120 loser_tokens=120

Three bugs in the harness, not the app, surfaced on the way and are fixed. The
conservation check compared card lists as sets, so a winner who won a SECOND
copy of a card they already held read as having gained nothing. An unbounded
`browser.close()` wedged a run after every assertion had passed, printing
nothing and refunding neither account. And the summary line was built from a
snapshot taken before the reward wait, so a passing run printed
`loser_tokens=100` beside its own pass — a verdict line that disagrees with its
verdict is worse than none.

---

### 13. Sweep retries a claim that cannot succeed · `DONE` (31 Aug)
The abandonment sweep repeatedly attempts a game with 7/9 moves and fails:

    sweep: 0x141176f6… abandoned (242min, 7/9 moves) — claiming
    sweep: 0x141176f6… FAILED — Assertion failed:
      It must be opponent's turn to claim abandonment

Every fifteen minutes, indefinitely, each attempt spending a proof and a
transaction on something the contract will always reject. The claim is only
valid when it is the ABSENT player's turn; the sweep does not check the move
parity before trying.

**Fixed.** The bot is always player 2, and the contract accepts an
abandonment claim only when it is the OTHER side's turn — an even move count.
An odd count means the next move is ours: we stalled, nobody abandoned, and
the assertion can never pass. The sweep now checks parity, reports the game as
not claimable by us once, and counts the locked cards instead of retrying.

The test fixture had encoded the same misunderstanding — a three-move record
for a player-2 claimant describes a game the chain would always refuse.

---

## P3 — Operability

### 6. An abandoned game locks the bot for 30 minutes · `DONE` (31 Aug)
The relay had been sending `OPPONENT_DISCONNECTED` the whole time and the bot
ignored the message, then sat in `playing` until a thirty-minute watchdog meant
for SILENCE — which cannot tell a slow player from a departed one, and so has
to be generous. A disconnect is not silence: the relay watched it happen.

The bot now starts a 90s countdown on it and cancels on `OPPONENT_RECONNECTED`
(also already sent). 90s because the relay's own reconnection window is 60s, so
a wifi blip is not a forfeit.

Two things it deliberately does not do. It does not abandon a game it is
settling — the loser closing their tab the moment the result appears is
ordinary, and arrives while the winner is still assembling an 11-proof
transcript. And it does not change what abandoning means: committed cards stay
locked pending the abandonment claim and are still counted on `/health`. The
gain is the twenty-eight minutes, not the cards.

Six tests, each failing without the part of the fix it covers, and verified on
production by matching a real game and closing the tab:

    22:00:57  matched into 0x80e1f059… as player2
    22:01:02  opponent disconnected — giving them 90s to come back
    22:02:34  opponent disconnected and did not come back — abandoning
    22:02:39  state=idle

Ninety-seven seconds, against thirty minutes before. `cardsStranded: 0`, since
nothing had been committed — item 2's fix and this one meeting as intended.

### 7. `readPrivateCards` is O(collection) · `ACCEPTED` (31 Aug) — with a ceiling
It is worse than O(collection): it is **quadratic**, and the reason matters,
because it rules out the obvious fixes.

The contract asks for ten notes at an offset, but the PXE never pushes that
offset down to storage. `NoteService.getNotes` passes no limit or offset to the
note store — it loads EVERY note for the slot — and `pickNotes` then does
`.slice(offset, offset + limit)` on the resulting array in memory. Every page
costs a full collection scan, so reading N cards costs about N²/10 note loads.
(aztec-packages `pxe/src/notes/note_service.ts` and
`pxe/src/contract_function_simulator/pick_notes.ts`.) A larger page size would
not help; the per-page cost is the scan, not the ten.

**The ceiling:** comfortable into the low hundreds of cards, unpleasant past
roughly five hundred, 46s at 1,382. A player's collection is five starter cards
plus ten per pack plus one per win, so reaching that means buying about fifty
packs. The only holder anywhere near it is the bot, which caches.

**Why not fixed:** a bigger page needs a contract change, and a redeploy
orphans every player's cards. Refreshing by delta instead of re-reading avoids
the scan but introduces a local idea of the collection that can drift from the
PXE's — which is exactly the failure this codebase has already paid for
("Could not find all 5 cards").

A read over five seconds now records a diagnostic line, so a player who does
reach the slow end is visible to support instead of just finding the app
sluggish.

### 8. `[pxe-queue]` diagnostics log to player consoles · `DONE` (31 Aug)
Recording and printing are now separate concerns. Every line goes into a
200-entry ring buffer always; it is printed only when `triad_debug` is set or
the page is under the harness. Support can ask a player to run
`__triadDiagnostics()` and paste the result.

A flag alone would have been the wrong fix: whoever hits the problem has the
flag off, and turning it on means asking them to reproduce a bug that took an
hour to hit once. The buffer also survives a localStorage that throws (private
mode, sandboxed frame, storage disabled), which is where support is hardest.

---

## P4 — Cosmetic, on the deployed site

### 9. Four assets 404 · `DONE` (31 Aug)
Two unrelated causes.

`aztec-symbol.png` was a favicon reference to a file that was never in the
repo — and the wrong brand anyway, since the game is Axolotl Arena. Replaced
with an actual `favicon.svg` in the app's own palette.

The three textures are named inside the FBX models, from the artist's original
project (one is a `.psd`), and the pack never shipped them. The app assigns its
own materials from `/textures`, so the references are dead weight — but the
loader still fetched each one. The FBX loader now runs through a
`LoadingManager` that answers any texture request under `/models` with a
transparent pixel, which is structural rather than a list of filenames:
`/models` holds `.fbx` and nothing else, so every texture asked for there is
one we do not have. That covers the other thirteen names in those files too.

### 10. Overlapping controls, bottom right · `DONE` (31 Aug)
Both buttons were `position: fixed; bottom: 16px; right: 16px`, so each claimed
the same corner. They now sit in one flex row that owns the corner.

While there: one of them repairs and the other is irreversible, and they looked
identical. "Clear All State" now gets a distinguishing hover and the title text
the repair button already had.

### 25. A deploy could kill an in-flight settlement · `DONE` (3 Sep)
Settlement pulls the SDK, the proving stack, the circuit loader and `pxe` in
through dynamic `import()`. Those resolve to hashed chunk files, and a deploy
replaces them — so a tab opened before the deploy asks for a chunk that no
longer exists and settlement dies with "Failed to fetch dynamically imported
module", with the game over and the wager already committed. Every open tab is
exposed for as long as it stays open.

It happened here, to the game that became item 15's test case: a Vercel deploy
landed between the last move and the settle. It was first misread as RPC
flakiness — the retry noise was the visible part — until the line above it
turned out to be the staleBuild warning.

`staleBuild.ts` detects this and asks the player to reload. Detection is not
mitigation: by the time it fires the settlement has already failed.

A module that has been imported lives in the tab's registry and a deploy cannot
take it away, so they are now imported as soon as a game screen opens, while
nothing is at stake. Failures are swallowed — this changes WHEN a module loads
and must never become a new reason a game cannot start. A test reads
`useGameSettlement`'s source and fails on any dynamic import the warmer misses;
it immediately caught `@aztec/bb.js` and `@noir-lang/noir_js`, the two largest
chunks on the path.

**Still true, and worth stating:** this protects tabs that are already open at
warm-up time. A player who loads the app DURING a deploy still gets whatever
the CDN serves, and the staleBuild banner remains the answer for that.

---

## Mainnet — beyond testnet-ready

### 11. No contract audit · `OPEN` — not ours to close, but scoped
The card-commitment binding bug found earlier in this project — where nothing
tied claimed card ids to the commitment — is precisely what an audit exists to
catch, and it was found by chance. Commissioning one is a decision for the
project, not something this work can close.

What it can do is say where to look. The five places where a bug is
unrecoverable, in rough order of how much a mistake would cost:

1. **Settlement binding.** `process_game` must make it impossible to claim a
   card the loser never committed. The current chain is: stored
   `card_commit_1/2` → every move proof asserts both → the transferred card is
   asserted present in the opponent's card list. The historical bug was a gap
   in exactly this chain, and it is the thing to re-derive from scratch rather
   than read for plausibility.
2. **Transcript integrity.** Two hand proofs and nine move proofs verify
   recursively. The question is not whether each proof verifies but whether a
   set of proofs that all verify can describe a game that never happened —
   reordering, replaying a move, or colliding on a board-state hash.
3. **Abandonment and recovery.** The claim turns on move parity, EXCEPT when
   the transcript is complete (`n == 9`), where parity is deliberately skipped
   because a finished game has no next mover. Recovery then rests on a
   ten-minute dispute window (`DISPUTE_SECONDS`), a one-hour staleness bar
   (`MIN_ABANDON_SECONDS`), `contest_abandonment`, and a per-player
   `game_recovered` flag. Both players recovering the same cards, a claim
   inside the window, or a contest accepted from a non-player would each mint
   value from nothing. The `n == 9` exemption is the newest of these and the
   one with the least production mileage.
4. **Idempotence.** `settled`, and the status transitions around it. Settling
   twice must be impossible, not merely unlikely. This is not hypothetical: a
   version deployed on 1 Sep guarded `settle_game` on the `game_settled` flag
   alone, which a claimed game does not set — so a game already claimed through
   the abandonment path could be settled again and mint the wagered card a
   second time. Both settle paths now assert `status == 2` (see item 14). An
   auditor should treat every status transition as a place the same mistake
   can recur, not just the two that were fixed.
5. **The draw path**, which is the one settlement route where nothing changes
   hands — and therefore the one where a coerced transfer would be least
   expected.

## September — contract changes and what they cost

Everything above was closed against the contracts deployed on 31 Aug. Those
contracts have since been replaced, so this section carries what changed and
what is and is not yet proven against the running instance. Current addresses:
NFT `0x246276ad…`, Game `0x25dac7c3…`, Token `0x1407ddf7…`.

### 14. `settle_game` could mint a second time · `DONE` (1 Sep) — a defect I shipped
`settle_game` asserted only on `game_settled`. A game recovered through
`claim_abandoned_game` never sets that flag — it moves the status instead — so
a claimed game remained settleable, and settling it minted the wagered card
again from a transcript that had already paid out.

Both `settle_game` and `settle_game_draw` now assert `status == 2` ("active")
before doing anything. That is the invariant the flag was standing in for, and
it holds across every path that ends a game rather than only the one that was
in mind when the flag was written.

Found while writing the abandonment tests, not by the tests that existed — the
suite covered settling twice and claiming twice, and never the pair.

### 15. A finished game nobody settles was unclaimable · `DONE` (1 Sep) · **VERIFIED on production (3 Sep)**
`claim_abandoned_game` capped the transcript at eight moves and required the
claimant not to be next to move. A completed game has no next mover, so a game
that ran the full nine moves and whose winner then vanished could not be
claimed by anyone — ten cards locked forever, in the one case where the whole
transcript exists and settlement is provably owed.

`num_valid_moves` now accepts 9; the ninth move may end the game and must name
a valid winner; parity is skipped when `n == 9` because there is nobody whose
turn it is.

**Verification is the open part.** Reaching this state on production is
genuinely hard — winners settle within a minute, and draws are settled by
convention — and four attempts to race it by killing the harness on a health
poll produced three incomplete transcripts (7 or 8 proofs, a DIFFERENT contract
branch that reads identically in the log) and one game settled out from under
the cut. `STOP_BEFORE_SETTLE=1` now makes the harness decline to settle a game
it won, after confirming from `/arena-health` that the bot holds all nine move
proofs. `scripts/make-unsettled-complete-game.sh` drives it.

**Verified 3 Sep on the deployed instance.** Game `0x23ab318b…` ran all nine
moves; its winner's settlement died mid-flight (see item 25) and that account
was gone for good. The bot, as the loser, held the whole transcript:

```
sweep: 0x23ab318b… abandoned (67min, 9/9 moves) — complete but never settled
       by its winner — claiming
sweep: 0x23ab318b… claimed 0x26497fbd…
sweep: waiting out the 600s dispute window
sweep: 0x23ab318b… RECOVERED 5 card(s) 0x22b42984…
```

The 9/9 in that first line is itself the proof of item 21: an hour earlier the
same game would have read 8/9 for ever.

The `<= 8` prefix path was verified in the same hour, on `0x2dfec26f…` — also
claimed, disputed and recovered, 5 cards back.

Two things had to be fixed mid-verification, both found because the run
refused to fake a pass:

- The harness cut read `journal[0]`, and the bot's worklist is oldest-first, so
  it read an EARLIER game's 8 proofs and would have discarded a good run.
- The bot imports the browser's `settlementArgs`, and it had been restarted
  before the commit that lifted the client-side `0..8` cap — so the first n = 9
  claim failed with an error string that no longer existed in the source. That
  is what prompted `deployedCommit` on /arena-health (item 20's sibling):
  nothing from outside the box could say which code was live.

### 16. Abandonment measured time in blocks · `DONE` (1 Sep)
`MIN_ABANDON_BLOCKS = 300` assumed 12-second blocks. Measured testnet intervals
ran 27–72 seconds, so the intended one-hour bar was somewhere between two and
six hours, varying with load. aztec-nr says outright that block intervals are
not a reliable clock.

Now `MIN_ABANDON_SECONDS = 3600` and `DISPUTE_SECONDS = 600` off
`context.timestamp()`. Two callers assumed the old units and were fixed with
it: the sweep's `minAgeMs` and the frontend's recovery button.

### 17. The contest window was designed and never built · `DONE` (1 Sep)
The original intent for abandonment was a challenge window — the opponent gets
to say "I am still here" before their cards are taken. The claim path shipped;
the contest half never did, so a claim was unanswerable.

`contest_abandonment` asserts the game is claimed (status 5), the contester is
a player and not the claimant, the window is still open, and they have not
contested already; it returns the game to active and clears the claim. The
frontend surfaces it as one of five stuck-game states.

### 18. The bot dropped its final move proof · `DONE` (1 Sep)
A proof that finished after the bot had already left the game was discarded,
because the handler returned early when the game id no longer matched. The
opponent then held 8 of 9 and could not settle — which presented as the 30s
`MOVE_PROOF_WAIT_TIMEOUT` being too tight, and survived being raised to 180s.

The proof is now always sent; only the local bookkeeping is skipped when the
game has moved on. Observed firing twice on production.

### 19. Nothing could see what the bot was doing · `DONE` (2 Sep)
Diagnosing a live game meant SSHing to the box and reading a journal after the
fact, and inferring state that way was wrong as often as right — seven proofs
read as nine, a sweep assumed to have run that had not.

`getStats()` now builds the live game and the sweep's worklist fresh on every
read, `/arena-health` republishes them CORS-open and uncached with a
server-stamped `generatedAt`, and there is a dashboard that polls it.

### 21. Nobody who LOST could recover a stuck game · `DONE` (3 Sep)
One bug in five places, and it took all of them being wrong to hide it: **state
needed for recovery was discarded the moment the happy path ended.**

Moves are 0-indexed, so player 1 plays 0,2,4,6,8 and player 2 plays 1,3,5,7 —
the final proof of every game belongs to player 1 and arrives AFTER game over,
while their browser is still proving it. Everything below is about that proof.

- The bot dropped it on SEND: a proof that finished after it had left the game
  was discarded (item 18, fixed 1 Sep).
- The bot then SENT that proof but did not KEEP it — found 3 Sep, after this
  item was first written, which is why the count below says five and not four.
  `resetToIdle()` clears the live proof map, so a proof taking the late path was
  delivered to whoever needed it to settle and lost from our OWN transcript,
  leaving us one short of claiming if they never did. Production showed a game
  finishing at 8/9 with every move in fact proved. It also means the 9/9
  verified earlier that day held by timing rather than by correctness — that
  game's own proofs happened to land before GAME_OVER. Chasing an 8/9 that had
  been noticed and passed over is what found it.
- The bot dropped it on RECEIVE: `MOVE_PROVEN` was gated on
  `msg.gameId === this.gameId`, and GAME_OVER nulls `gameId` first. The bot only
  ever joins, so it is always player 2 — it therefore depended on this proof in
  EVERY game and never once kept it. Its journal froze at 8 of 9.
- The frontend deleted the whole transcript at GAME_OVER (`storage.clearGame()`),
  destroying the player's only copy of their own proofs at the exact moment
  they stopped needing the game and started needing the evidence.
- The frontend also expired any record after two hours. Two hours is how long a
  game is worth RESUMING; a claim cannot even be attempted for one hour, and
  people come back the next day. Reading for one purpose destroyed the data the
  other purpose needed.
- And the frontend's save effect only runs on the game screen, so a proof
  arriving after the player clicked back to the menu was not persisted — the
  likeliest case of all, since a loser leaves promptly.

Each looked local. Together they meant that if a winner walked away, the loser
could never claim, in the one situation where the whole transcript exists and
settlement is provably owed.

Fixed with `loadClaimable()` (recovery-side reader: ignores the resume window,
requires an on-chain id, keeps thirty days), `markFinished()` (not resumable,
not deleted, cleared only when the chain says the game resolved),
`mergeMoveProof()` (persists a proof from any screen, deduped), and the bot's
`absorbLateMoveProof` (fifteen minutes past game over, straight into the
journal the sweep claims from).

Confirmed on production twice. First a game finished with the journal reading
9/9 where an hour earlier it would have read 8/9 forever; then, after the
own-late-proof gap was closed, again — `late move proof absorbed … journal now
holds 9/9 (transcript COMPLETE — claimable)`.

Then production produced the case itself, on the first repetition run after the
fix — both late paths in one game:

```
06:24:18  Generating game_move proof (card 9 at [1,2])...   <- proving our move 7
06:24:20  game over: player1                                 <- ends WHILE we prove
06:24:20  game_move proof generated in 1.6s                  <- completes after
06:24:20  late move proof absorbed - journal now holds 8/9    <- OUR OWN, kept
06:24:20  move proof 7 submitted (after game over)            <- and sent
06:24:20  late move proof absorbed - journal now holds 9/9 (COMPLETE - claimable)
```

Without the keep-our-own fix that game ends at 8/9: one short of claimable, and
the loser stuck if the winner never returns. It is a timing accident — which is
precisely why a single green run proved nothing, and why the earlier 9/9 was
not evidence that this branch worked.

### 22. The human half of the n == 9 claim was never wired · `DONE` (3 Sep)
Item 15 changed the contract and the bot. The browser still enforced the old
rule in two places: a complete game was reported as `awaiting-winner` — a dead
end with no button, whose text told the player only the winner could act — and
`buildClaimAbandonedArgs` threw outright for nine proofs. So the fix existed on
chain and was unreachable from the app.

A finished game is now offered as `claimable`, on the same one-hour terms as
any other; claiming earlier would race the winner's settlement and take the
card they had won.

### 23. The dispute wait counted blocks · `DONE` (3 Sep)
The contract measures `DISPUTE_SECONDS` (600) of chain time. The settle path
waited 5 BLOCKS, left over from when the contract counted blocks too — 135-360s
at this testnet's real 27-72s intervals, against a 600s requirement. Every
human recovery would have reverted at the last step and reported failure.

`waitForDisputeWindow`, which polls the chain's own timestamp and is immune to
block-rate variance and local clock skew alike, was written when the contract
moved to seconds — and never called. Dead code sitting beside the bug it was
written to fix. Item 16 fixed the constant and missed the caller.

### 24. A reverting claim retried forever · `DONE` (3 Sep)
The auto-trigger gated on the flow's IN-FLIGHT guard, which the `finally` block
clears on failure as well as success, and the effect re-runs whenever
`handleAbandonedGame`'s identity changes — which any state update does. Every
failure re-armed the trigger.

Against a claim that reverts for a persistent reason — "Too soon to call this
game abandoned", "Game must be in active state" — that is an unbounded loop,
and each turn of it builds a recursive proof and sends a transaction. The
ground rule against masking failures with retries was being broken by a loop
nobody wrote on purpose.

One automatic attempt per game now; a deliberate retry from the menu still
works. The test that should have caught this rejected only the FIRST claim, so
a succeeding one ran behind it and it asserted nothing about the failure it was
named for.

### 20. Two systemd keys were in the wrong section · `DONE` (2 Sep)
`OnFailure=` in `[Service]` meant the health alert never fired. Then
`StartLimitIntervalSec` / `StartLimitBurst` in `[Service]` meant the bot ran
`Restart=always` with no rate limit. systemd logs "Unknown key … ignoring" and
carries on; `systemctl cat` still shows the key, so the file reads correct
while the service is not.

`scripts/systemdUnits.test.ts` now parses every unit in `deploy/` and fails on
a section-only key in the wrong section. The check that catches this on a live
box is `systemctl show -p <Key>`, never the unit file.

---

### 12. `DEFAULT_FEE_JUICE_TARGET` uncalibrated · `DONE` (31 Aug)
Measured, and the old number was not merely unproven — it was wrong by about
7x, in the dangerous direction.

Fee Juice balances live in public storage, so any account can be read with
nothing but its address (`scripts/fee-juice-used.ts`, no keys, no PXE). Eight
throwaway accounts from real production runs come out cleanly bimodal:

    deploy + create_game + play, no settlement   4.217 – 4.343e18   (4 accounts)
    the same, plus settling the game             6.676 – 6.751e18   (4 accounts)

So onboarding plus one game is ~4.3e18 and settlement adds ~2.4e18. At 1e18 a
mainnet player would have run dry before their first move — the exact failure
the constant exists to prevent, since they cannot buy more without leaving the
app.

Now 50e18: onboarding plus roughly five settled games with ~75% headroom.
Erring high is the cheap direction — too much means Fee Juice bought early,
too little means a game that cannot be finished. Three tests hold it against
the measurements.

**No effect on testnet**, where the fee asset has a faucet: `resolveAcquireRoute`
returns the mint route before it ever reads the target, and the faucet mints
1e21 regardless. This is the mainnet swap path only, and should be re-measured
against mainnet's fee market before launch.

---

## Decided, not defects

- **Single box** · `ACCEPTED` — no failover for relay or bot. Fine at launch;
  see item 4, which is the part that still needs doing.
- **Bot capacity** · `ACCEPTED` — one concurrent game. With real traffic players
  match each other and the bot is a cold-start amenity.
- **Card supply / minting** · `ACCEPTED` — the bot wagers weak duplicate starter
  cards with no intrinsic value, so refilling by minting dilutes nothing.
  Runbook in `deploy/DEPLOY.md`.
- **Offsite manifest backup** · `ACCEPTED` — the cards are worthless test
  assets, so losing the manifest costs a re-provision, not value. Revisit for
  mainnet. Note the file also holds the bot's account keys, so any copy is
  encrypted.
