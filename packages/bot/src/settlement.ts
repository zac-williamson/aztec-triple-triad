/**
 * Settling a private game, and taking the bot's own notes back from whatever
 * transaction resolved it (docs/plan/PRIVATE_GAMES.md section 5.4).
 *
 * Shared by the live game (ArenaBot) and the recovery sweep, because both end
 * the same way: a settle, a finalize or somebody else's settlement leaves the
 * bot's cards on-chain as notes nobody delivers, and only the bot can rebuild
 * them — from its own hand and secrets — and import them.
 *
 * Nothing here trusts the relay or the opponent about what happened. The
 * resolving tx is found from the game's own `done` nullifier, and which of the
 * bot's prepared notes it released is read off the tx itself. A SETTLED message
 * or a SETTLING prize index is at most a hint.
 */
import {
  loserMoveIndices,
  NULLIFIER_INDEX,
  placedOf,
  prizeOfMove,
  resolutionFromReleased,
  selectOwnNotes,
  defaultPrizeMove,
  type GameRecord,
  type GameSecrets,
  type Resolution,
  type Winner,
} from '../../frontend/src/aztec/privateGame.js';
import type { FoundTx } from '../../frontend/src/aztec/gameChain.js';
import { cardStrength } from '../../frontend/src/aztec/gameActions.js';
import type { MoveProofData } from '../../frontend/src/types.js';
import { BOT_SIDE, cardValue, checkTranscript, winnerFromOutcome, type Outcome } from './protocol.js';
import type { BotChainLike } from './chainTypes.js';

/** Arena Tokens each player earns from a settled game (REWARD_PER_GAME). */
const REWARD = 20;

/**
 * Everything the bot holds about one committed game. Its own secrets are not
 * here: they are re-derived from `nonce` whenever needed, so nothing that
 * persists this carries them.
 */
export interface BotGame {
  gameKey: string;
  /** Our note nonce before the commit: compute_game_secrets(nonce) re-derives the secrets. */
  nonce: string;
  /** Our hand, in committed order (slot i = return note i). */
  cardIds: number[];
  /** The creator's record, and ours. */
  record1: GameRecord;
  record2: GameRecord;
  /** The move proofs we hold, in any order. */
  moveProofs: MoveProofData[];
  /** The game's result from our seat, once all nine moves were in. */
  outcome: Outcome | null;
  /** The prize move, if known: ours when we settled, the winner's word otherwise. */
  prizeMove: number | null;
}

export interface SettlementDeps {
  chain: BotChainLike;
  /** Send options for pxe.ts. Its `timeoutMs` is handed to the SDK's wait, which counts SECONDS. */
  sendOpts: () => { node: unknown; timeoutMs: number };
  log: (msg: string) => void;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * The tx that resolved the game — a settlement, an unwind (finalize) or, for a
 * creator, a cancel — found the way anyone can find it (§5.4 step 3): look up
 * the game's `done` nullifier, then the tx in that block that pushed it. Null
 * while the game is unresolved. `waitMs` tolerates a node that has not yet
 * seen a tx that was just mined.
 */
export async function findResolvingTx(
  deps: SettlementDeps,
  game: Pick<BotGame, 'gameKey' | 'record1' | 'record2'>,
  opts: { waitMs?: number; pollMs?: number } = {},
): Promise<FoundTx | null> {
  const { chain } = deps;
  const nullifiers = await chain.pxe.gameNullifiers(chain.address, game.gameKey, game.record1, game.record2);
  const done = nullifiers[NULLIFIER_INDEX.done];
  const deadline = Date.now() + (opts.waitMs ?? 0);
  for (;;) {
    const [hit] = await chain.lookupNullifiers([done]);
    if (hit) {
      const tx = await chain.findTxWithNullifier(hit.blockNumber, done);
      if (!tx) throw new Error(`block ${hit.blockNumber} resolved the game, but no tx in it carries the resolution`);
      return tx;
    }
    if (Date.now() >= deadline) return null;
    await sleep(opts.pollMs ?? 5_000);
  }
}

/** The transcript, if we hold all of it and it settles this game. */
function readTranscript(game: BotGame): { ordered: MoveProofData[]; winner: Winner } | null {
  try { return checkTranscript(game.moveProofs, game.record1, game.record2); } catch { return null; }
}

/**
 * The prize move a settlement should name: none for a draw (0). Winning, the
 * loser's placed card the bot values most. Settling a LOSS for a winner who
 * never came back, the card that winner is owed by default — the loser's
 * strongest placed card, by the same measure every client uses
 * (gameActions.cardStrength) — not the one the bot would least mind losing.
 */
export function choosePrizeMove(ordered: MoveProofData[], winner: Winner): number {
  if (winner === 'draw') return 0;
  return defaultPrizeMove(ordered, winner, winner === BOT_SIDE ? cardValue : cardStrength);
}

/**
 * Send settle_game for a complete transcript. Anyone may settle; the contract
 * checks the transcript and releases each player's prepared notes, so this
 * needs nothing of the opponent's but their record.
 */
export async function settleGame(
  deps: SettlementDeps,
  game: BotGame,
  prizeMove: number,
  moveVk: Uint8Array,
): Promise<string> {
  const { Fr } = await import('@aztec-labs/aztec.js/fields');
  const { buildSettleGameArgs } = await import('../../frontend/src/aztec/settlementArgs.js');
  const args = await buildSettleGameArgs({
    Fr,
    gameKey: game.gameKey,
    record1: game.record1,
    record2: game.record2,
    moveVk,
    moveProofs: game.moveProofs,
    prizeMove,
  });
  return deps.chain.pxe.sendSettleGame(deps.chain.address, args, deps.sendOpts());
}

/** What importOwnNotes did. */
export interface ImportResult {
  txHash: string;
  resolution: Resolution;
  /** Card notes that should now be in the PXE (a prize counts once however many candidates were tried). */
  expectedCards: number;
  /** How many more cards the PXE holds afterwards — the honest measure. */
  gainedCards: number;
  rewardImported: boolean;
}

/** A card note to import. */
interface NoteToImport { tokenId: number; randomness: string }

/**
 * The notes to import from `tx`, decided from what the tx itself released.
 *
 * Which of our five return notes and whether our reward note are in the tx is
 * read off its note hashes (§5.4), so a win, a loss, a draw and an unwind are
 * told apart without anyone's word — the withheld return of a loss even names
 * the slot the winner took. The one thing the tx cannot say is which card OUR
 * prize is (the completed prize note's hash needs the card id), so on a win it
 * is the card our own prize move names, or — when somebody else settled and
 * did not say — each card the loser placed, of which import_note keeps only
 * the one that is really there.
 */
export function planOwnImport(opts: {
  game: BotGame;
  secrets: GameSecrets;
  released: { returns: boolean[]; reward: boolean };
  log?: (msg: string) => void;
}): { resolution: Resolution; cards: NoteToImport[]; expectedCards: number; reward: { amount: number; randomness: string } | null } {
  const { game, secrets, released } = opts;
  const transcript = readTranscript(game);
  const winner: Winner | null = transcript?.winner ?? (game.outcome ? winnerFromOutcome(game.outcome) : null);

  let resolution: Resolution;
  try {
    resolution = resolutionFromReleased({
      role: BOT_SIDE, hand: game.cardIds, returns: released.returns, reward: released.reward, winner, joined: true,
    });
  } catch (err) {
    // The tx pushed this game's `done`, yet none of our notes matched it.
    // Something about the match is wrong, not the chain: import every note we
    // could own instead. import_note discards whatever the tx does not hold,
    // so guessing too much costs a few simulations; guessing too little
    // strands cards invisibly, which is the failure this code exists to stop.
    opts.log?.(`WARNING: ${(err as Error).message} — importing every note we could own instead`);
    const cards: NoteToImport[] = game.cardIds.map((tokenId, slot) => ({ tokenId, randomness: secrets.returns[slot] }));
    const prizes = winner === BOT_SIDE ? prizeCandidates(game, transcript) : [];
    for (const id of prizes) cards.push({ tokenId: id, randomness: secrets.prize });
    const expectedCards = (winner === BOT_SIDE ? 1 : 0) + (winner !== null && winner !== 'draw' && winner !== BOT_SIDE ? 4 : 5);
    return {
      resolution: winner === null ? { kind: 'unwound' } : { kind: 'settled', winner },
      cards,
      expectedCards,
      reward: { amount: REWARD, randomness: secrets.reward },
    };
  }

  let candidates: number[] = [];
  if (resolution.kind === 'settled' && resolution.winner === BOT_SIDE && !resolution.prize) {
    const known = knownPrize(game, transcript);
    if (known) resolution = { ...resolution, prize: known };
    else candidates = prizeCandidates(game, transcript);
  }
  const own = selectOwnNotes({ role: BOT_SIDE, hand: game.cardIds, secrets, resolution });
  const cards: NoteToImport[] = own.cards.map(n => ({ tokenId: n.tokenId, randomness: n.randomness }));
  for (const id of candidates) cards.push({ tokenId: id, randomness: secrets.prize });
  return {
    resolution,
    cards,
    expectedCards: own.cards.length + (candidates.length > 0 ? 1 : 0),
    reward: own.reward,
  };
}

/** Our prize card, when our own prize move (or the winner's word) names it. */
function knownPrize(
  game: BotGame,
  transcript: { ordered: MoveProofData[] } | null,
): { cardId: number; slot: number } | null {
  if (game.prizeMove === null || !transcript) return null;
  try { return prizeOfMove(transcript.ordered, BOT_SIDE, game.prizeMove); } catch { return null; }
}

/** Every card the loser placed — one of them is our prize. */
function prizeCandidates(game: BotGame, transcript: { ordered: MoveProofData[] } | null): number[] {
  const ids = transcript
    ? loserMoveIndices(BOT_SIDE).map(i => placedOf(transcript.ordered[i]).cardId)
    // Without the order we cannot tell whose move was whose; trying our own
    // placed cards too costs a simulation each and imports nothing false.
    : game.moveProofs.map(p => placedOf(p).cardId);
  return [...new Set(ids)].filter(id => Number.isInteger(id) && id > 0);
}

/**
 * Import our own notes from the tx that resolved the game, and measure that
 * they arrived. import_note swallows per-note failures, so the only honest
 * check is whether the wallet can see more cards afterwards.
 */
export async function importOwnNotes(deps: SettlementDeps, game: BotGame, tx: FoundTx): Promise<ImportResult> {
  const { chain, log } = deps;
  const secrets = await chain.pxe.computeGameSecrets(chain.address, game.nonce);
  const released = await chain.releasedPreparedNotes(tx, game.record2);
  const plan = planOwnImport({ game, secrets, released, log });

  const before = await chain.readCards();
  if (plan.cards.length > 0) {
    await chain.pxe.importCardNotes(chain.address, tx.txHash, plan.cards, 'game resolution', tx);
  }
  let rewardImported = false;
  if (plan.reward) {
    rewardImported = await chain.pxe.importTokenRewardNote(
      chain.address, tx.txHash, plan.reward.amount, plan.reward.randomness, tx,
    );
  }
  // Cards have definitely moved: the next read must not come from the cache.
  chain.invalidateCards?.();
  const after = await chain.readCards({ force: true });
  return {
    txHash: tx.txHash,
    resolution: plan.resolution,
    expectedCards: plan.expectedCards,
    gainedCards: after.length - before.length,
    rewardImported,
  };
}

/** A resolution, for the log. */
export function describeResolution(r: Resolution): string {
  if (r.kind === 'unwound') return 'unwound (both hands returned)';
  if (r.kind === 'cancelled') return 'cancelled';
  if (r.winner === 'draw') return 'settled as a draw';
  if (r.winner === BOT_SIDE) return r.prize ? `settled — we won card ${r.prize.cardId}` : 'settled — we won';
  return r.prize ? `settled — we lost card ${r.prize.cardId}` : 'settled — we lost';
}
