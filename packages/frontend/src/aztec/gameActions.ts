/**
 * Private-game actions (docs/plan/PRIVATE_GAMES.md sections 5.2-5.5): commit,
 * settle, cancel, claim, contest, finalize — and the import every resolution
 * ends with. Shared by the live game (useGameSession / useGameSettlement) and
 * the menu's recovery of a game left unfinished (useGame).
 *
 * Every chain write goes through `runPxeTx` (one tracked item on the serial
 * PXE queue); every WAIT — for a nullifier, for a chain clock — happens
 * outside it, so nothing holds the queue while time passes.
 *
 * Nothing here learns, needs or sends anything about the opponent beyond the
 * two records and the transcript: no address, randomness or blinding factor.
 */
import { runPxeTx, pxe, type PxeOps, type GameRef } from './pxe';
import { AZTEC_CONFIG } from './config';
import { AZTEC_SETTLE_TX_TIMEOUT, AZTEC_TX_TIMEOUT, TOTAL_MOVES } from './gameConstants';
import { addCards, type StoredCard } from './cardStore';
import { fetchTxEffectData, type TxEffectData } from './noteImporter';
import {
  blockTimestamp,
  findTxWithNullifier,
  lookupNullifiers,
  readGameChainState,
  releasedPreparedNotes,
  waitForNullifier,
  type FoundTx,
} from './gameChain';
import type { OpenCardsPayload } from './localGame';
import {
  abandonmentPosition,
  CLAIM_NUMBERS,
  defaultPrizeMove,
  handCommitOf,
  loserMoveIndices,
  NULLIFIER_INDEX,
  orderTranscript,
  placedOf,
  prizeMoveForCard,
  prizeOfMove,
  resolutionFromReleased,
  selectOwnNotes,
  winnerOf,
  type AbandonmentPosition,
  type ClaimNo,
  type GameChainState,
  type GameRecord,
  type GameSecrets,
  type OwnNote,
  type Resolution,
  type Side,
  type Winner,
} from './privateGame';
import {
  buildClaimForfeitArgs,
  buildSettleGameArgs,
  chooseForfeit,
  NO_FORFEIT,
  NO_FORFEIT_TERMS,
  OPEN_CARD_SLOTS,
  waitForAbandonBar,
  waitForDisputeWindow,
  type ChainClock,
  type ClaimForfeit,
  type ForfeitTerms,
} from './settlementArgs';
import { getCardById } from '../cards';
import type { MoveProofData } from '../types';

/** Everything a player keeps about a game they committed to. */
export interface PrivateGame {
  /** The relay's room id: the channel's associated data, the tx tracker's key. */
  roomId: string;
  role: Side;
  /** This player's five card ids, in the order they were committed. */
  hand: number[];
  gameKey: string;
  /** This player's note nonce at commit: re-derives every secret. */
  nonce: string;
  record1: GameRecord;
  /** Null until the joiner's record is known (for the creator: received). */
  record2: GameRecord | null;
  /**
   * The opponent's open cards with their proof, once it checked out: what an
   * abandonment claim takes one of their cards with. Absent if they never
   * sent them.
   */
  opponentOpen?: OpenCardsPayload | null;
  /** Our own open cards as sent: what a claim that takes nothing carries. */
  ownOpen?: OpenCardsPayload | null;
}

/** Who is acting, and the node they read from. */
export interface ActionContext {
  owner: string;
  node: unknown;
}

export function ownRecordOf(game: PrivateGame): GameRecord | null {
  return game.role === 1 ? game.record1 : game.record2;
}

export function opponentOf(side: Side): Side {
  return side === 1 ? 2 : 1;
}

function refOf(game: PrivateGame): GameRef {
  if (!game.record2) throw new Error('nobody has joined this game');
  return { gameKey: game.gameKey, record1: game.record1, record2: game.record2 };
}

function sendOpts(ctx: ActionContext, timeoutSeconds = AZTEC_TX_TIMEOUT) {
  return { node: ctx.node, timeoutMs: timeoutSeconds };
}

// ─── Reads (cached: both are deterministic) ─────────────────────────────────

const nullifierCache = new Map<string, string[]>();
const secretsCache = new Map<string, GameSecrets>();

/** The game's 21 siloed nullifiers. */
export async function nullifiersOf(game: PrivateGame, ctx: ActionContext, facade: PxeOps = pxe): Promise<string[]> {
  const key = [game.gameKey, ...game.record1, ...(game.record2 ?? ['-'])].join('|');
  const cached = nullifierCache.get(key);
  if (cached) return cached;
  const nullifiers = await facade.gameNullifiers(ctx.owner, game.gameKey, game.record1, game.record2);
  nullifierCache.set(key, nullifiers);
  return nullifiers;
}

/** This player's secrets for the game (from their own key and nonce). */
export async function secretsOf(game: Pick<PrivateGame, 'nonce'>, ctx: ActionContext, facade: PxeOps = pxe): Promise<GameSecrets> {
  const key = `${ctx.owner}|${game.nonce}`;
  const cached = secretsCache.get(key);
  if (cached) return cached;
  const secrets = await facade.computeGameSecrets(ctx.owner, game.nonce);
  secretsCache.set(key, secrets);
  return secrets;
}

/** Test seam. */
export function clearGameActionCaches(): void {
  nullifierCache.clear();
  secretsCache.clear();
}

export async function readGameState(
  game: PrivateGame,
  ctx: ActionContext,
  facade: PxeOps = pxe,
): Promise<{ nullifiers: string[]; state: GameChainState; position: AbandonmentPosition }> {
  const nullifiers = await nullifiersOf(game, ctx, facade);
  const state = await readGameChainState(ctx.node, nullifiers);
  return { nullifiers, state, position: abandonmentPosition(state) };
}

// ─── Commit: create and join ────────────────────────────────────────────────

/** What a commit prepared, persisted BEFORE its tx is sent. */
export interface PreparedCommit {
  nonce: string;
  record: GameRecord;
}

export interface CommitResult extends PreparedCommit {
  secrets: GameSecrets;
  /** The game's nullifiers given what this commit knows. */
  nullifiers: string[];
  txHash: string;
}

/** The player left before the commit was sent: nothing was committed. */
export class CommitAbandonedError extends Error {
  constructor() {
    super('left before the commit was sent — nothing was committed');
  }
}

/**
 * Create a game: read the nonce, derive the secrets, preview the record, and
 * send `create_game` — one queue item, so nothing advances the nonce between
 * the preview and the commit. `onPrepared` runs before the send: a tab that
 * dies mid-send still knows what it committed. `shouldSend` is asked just
 * before that: false (the player left) sends nothing and throws
 * CommitAbandonedError.
 */
export function createGameOnChain(
  ctx: ActionContext,
  opts: {
    roomId: string;
    gameKey: string;
    hand: number[];
    onPrepared?: (p: PreparedCommit) => void;
    shouldSend?: () => boolean;
  },
): Promise<CommitResult> {
  return runPxeTx({
    type: 'create_game',
    label: 'Creating game...',
    gameId: opts.roomId,
    execute: async (ops, setPhase) => {
      setPhase('simulating');
      const nonce = await ops.readNoteNonce(ctx.owner);
      const secrets = await ops.computeGameSecrets(ctx.owner, nonce);
      const record = await ops.previewRecord(ctx.owner, opts.gameKey, opts.hand, nonce);
      const nullifiers = await ops.gameNullifiers(ctx.owner, opts.gameKey, record, null);
      secretsCache.set(`${ctx.owner}|${nonce}`, secrets);
      if (opts.shouldSend && !opts.shouldSend()) throw new CommitAbandonedError();
      opts.onPrepared?.({ nonce, record });
      setPhase('sending');
      const txHash = await ops.sendCreateGame(ctx.owner, opts.gameKey, opts.hand, sendOpts(ctx));
      return { nonce, record, secrets, nullifiers, txHash };
    },
  });
}

/** Join the game whose creator committed `record1` (its `created` nullifier must be mined). */
export function joinGameOnChain(
  ctx: ActionContext,
  opts: { roomId: string; gameKey: string; hand: number[]; record1: GameRecord; onPrepared?: (p: PreparedCommit) => void },
): Promise<CommitResult> {
  return runPxeTx({
    type: 'join_game',
    label: 'Joining game...',
    gameId: opts.roomId,
    execute: async (ops, setPhase) => {
      setPhase('simulating');
      const nonce = await ops.readNoteNonce(ctx.owner);
      const secrets = await ops.computeGameSecrets(ctx.owner, nonce);
      const record = await ops.previewRecord(ctx.owner, opts.gameKey, opts.hand, nonce);
      const nullifiers = await ops.gameNullifiers(ctx.owner, opts.gameKey, opts.record1, record);
      secretsCache.set(`${ctx.owner}|${nonce}`, secrets);
      opts.onPrepared?.({ nonce, record });
      setPhase('sending');
      const txHash = await ops.sendJoinGame(ctx.owner, opts.gameKey, opts.record1, opts.hand, sendOpts(ctx));
      return { nonce, record, secrets, nullifiers, txHash };
    },
  });
}

// ─── Settle ─────────────────────────────────────────────────────────────────

/** Edge-rank total: what "strongest" means for the default prize. */
export function cardStrength(cardId: number): number {
  const card = getCardById(cardId);
  if (!card) return 0;
  return card.ranks.top + card.ranks.right + card.ranks.bottom + card.ranks.left;
}

export interface SettlementPlan {
  winner: Winner;
  /** settle_game's `prize_move` (0 for a draw, where it is ignored). */
  prizeMove: number;
  /** The prize card and the loser's slot it came from; null on a draw. */
  prize: { cardId: number; slot: number } | null;
}

/**
 * Who won, and the prize move. `selectedCardId` is the card the winner picked
 * (it must be one the LOSER placed); without one, the loser's strongest
 * placed card.
 */
export function planSettlement(moveProofs: MoveProofData[], selectedCardId: number | null): SettlementPlan {
  const ordered = orderTranscript(moveProofs);
  const winner = winnerOf(ordered);
  if (winner === 'draw') return { winner, prizeMove: 0, prize: null };
  const prizeMove = selectedCardId
    ? prizeMoveForCard(ordered, winner, selectedCardId)
    : defaultPrizeMove(ordered, winner, cardStrength);
  return { winner, prizeMove, prize: prizeOfMove(ordered, winner, prizeMove) };
}

/**
 * The move circuit's verification key, from the artifact settlement proves
 * against — the same cached key the move checks used during play.
 */
async function loadMoveVk(): Promise<Uint8Array> {
  const { circuitVerificationKey } = await import('./proofWorker');
  return circuitVerificationKey('game_move');
}

/**
 * Send `settle_game` with both records, the nine move proofs and the prize
 * move. Anyone holding those can settle; the tx releases prepared notes and
 * delivers nothing, so the settler imports their own afterwards like everyone
 * else (`importResolution`). Returns the tx hash.
 */
export async function settleGame(
  game: PrivateGame,
  ctx: ActionContext,
  opts: { moveProofs: MoveProofData[]; prizeMove: number; onPhase?: (phase: 'proving' | 'sending') => void },
): Promise<string> {
  const ref = refOf(game);
  if (opts.moveProofs.length < TOTAL_MOVES) {
    throw new Error(`settlement needs all ${TOTAL_MOVES} move proofs, have ${opts.moveProofs.length}`);
  }
  return runPxeTx({
    type: 'settle_game',
    label: 'Settling game...',
    gameId: game.roomId,
    execute: async (ops, setPhase) => {
      setPhase('proving');
      opts.onPhase?.('proving');
      const [moveVk, { Fr }] = await Promise.all([loadMoveVk(), import('@aztec-labs/aztec.js/fields')]);
      const args = await buildSettleGameArgs({
        Fr,
        gameKey: ref.gameKey,
        record1: ref.record1,
        record2: ref.record2,
        moveVk,
        moveProofs: opts.moveProofs,
        prizeMove: opts.prizeMove,
      });
      setPhase('sending');
      opts.onPhase?.('sending');
      return ops.sendSettleGame(ctx.owner, args, sendOpts(ctx, AZTEC_SETTLE_TX_TIMEOUT));
    },
  });
}

// ─── Import ─────────────────────────────────────────────────────────────────

export interface ImportResult {
  txHash: string;
  resolution: Resolution;
  /** Card ids imported into this player's PXE (and the card store). */
  importedCardIds: number[];
  rewardImported: boolean;
  /** When this player lost: their card the winner took. */
  takenCardId: number | null;
  /** True when a won prize was imported without knowing which card it was. */
  prizeUncertain: boolean;
}

/**
 * Import this player's OWN notes from the tx that resolved their game — the
 * same code for the winner, the loser, a draw, an unwind and a cancel.
 *
 * `resolution` is what the caller knows the tx was (it sent it, or the settler
 * said). Without one — the tx was found from the `done` nullifier — it is read
 * off which of this player's prepared notes the tx released. A loser
 * double-checks the prize slot the same way, because only the chain is
 * authoritative about which return was withheld.
 */
export async function importResolution(
  game: PrivateGame,
  ctx: ActionContext,
  opts: {
    txHash: string;
    txEffect?: TxEffectData;
    resolution?: Resolution;
    /** The transcript, for the winner and the prize when nobody said. */
    moveProofs?: MoveProofData[];
    facade?: PxeOps;
    label?: string;
  },
): Promise<ImportResult> {
  const facade = opts.facade ?? pxe;
  const label = opts.label ?? 'Game import';
  const txEffect = opts.txEffect ?? await fetchTxEffectData(ctx.node, opts.txHash);
  if (!txEffect) throw new Error(`${label}: the node does not have tx ${opts.txHash} yet`);
  const secrets = await secretsOf(game, ctx, facade);

  const transcriptWinner = winnerFromTranscript(opts.moveProofs);
  let resolution = opts.resolution ?? await classifyResolution(game, txEffect, transcriptWinner);
  if (opts.resolution && resolution.kind === 'settled' && resolution.winner === opponentOf(game.role)) {
    resolution = await confirmLoserPrize(game, txEffect, resolution, label);
  }

  const plan = selectOwnNotes({ role: game.role, hand: game.hand, secrets, resolution });
  let prizeUncertain = false;
  const toImport: OwnNote[] = [...plan.cards];
  if (resolution.kind === 'settled' && resolution.winner === game.role && !resolution.prize) {
    // A win whose prize nobody named: try each card the loser placed. The
    // contract discards every guess but the right one, so this imports the
    // prize without inventing anything — but we cannot say which it was.
    const candidates = prizeCandidates(opts.moveProofs, game.role);
    for (const cardId of candidates) toImport.push({ tokenId: cardId, randomness: secrets.prize, kind: 'prize' });
    prizeUncertain = candidates.length > 0;
    console.warn(`[gameActions] ${label}: won, but the prize was not named — trying ${candidates.length} candidate(s)`);
  }

  if (toImport.length > 0) {
    await facade.importCardNotes(ctx.owner, opts.txHash, toImport.map(n => ({ tokenId: n.tokenId, randomness: n.randomness })), label, txEffect);
  }
  let rewardImported = false;
  if (plan.reward) {
    rewardImported = await facade.importTokenRewardNote(ctx.owner, opts.txHash, plan.reward.amount, plan.reward.randomness, txEffect);
  }

  // The card store is what restores cards after a PXE wipe. Only notes we
  // KNOW are ours go in: a guessed prize that did not match would sit there
  // as a card that does not exist.
  const known = plan.cards;
  const stored: StoredCard[] = known.map(n => ({
    cardId: n.tokenId,
    randomness: n.randomness,
    txHash: opts.txHash,
    noteHashes: txEffect.noteHashes,
    firstNullifier: txEffect.firstNullifier,
  }));
  try {
    addCards(ctx.owner, stored);
  } catch (err) {
    console.error(`[gameActions] ${label}: could not store the cards for restore:`, err);
  }

  return {
    txHash: opts.txHash,
    resolution,
    importedCardIds: known.map(n => n.tokenId),
    rewardImported,
    takenCardId: plan.takenCardId,
    prizeUncertain,
  };
}

function winnerFromTranscript(moveProofs: MoveProofData[] | undefined): Winner | null {
  if (!moveProofs || moveProofs.length < TOTAL_MOVES) return null;
  try {
    return winnerOf(orderTranscript(moveProofs));
  } catch {
    return null;
  }
}

function prizeCandidates(moveProofs: MoveProofData[] | undefined, winner: Side): number[] {
  if (!moveProofs || moveProofs.length < TOTAL_MOVES) return [];
  try {
    const ordered = orderTranscript(moveProofs);
    return loserMoveIndices(winner).map(i => placedOf(ordered[i]).cardId).filter(id => id > 0);
  } catch {
    return [];
  }
}

function addressesForClassification(): { nft: string; token: string } {
  const nft = AZTEC_CONFIG.nftContractAddress;
  const token = AZTEC_CONFIG.tokenContractAddress;
  if (!nft || !token) throw new Error('cannot read a resolution without the NFT and token contract addresses');
  return { nft, token };
}

/** What a tx did with this player's notes, read off the tx itself. */
async function classifyResolution(game: PrivateGame, txEffect: TxEffectData, winner: Winner | null): Promise<Resolution> {
  const own = ownRecordOf(game);
  if (!own) throw new Error('this player never committed to the game');
  const released = await releasedPreparedNotes(txEffect, own, addressesForClassification());
  return resolutionFromReleased({
    role: game.role,
    hand: game.hand,
    returns: released.returns,
    reward: released.reward,
    winner,
    joined: !!game.record2,
  });
}

/**
 * The settler names the prize; the chain says which return it withheld. When
 * the two disagree the chain wins — a settler who misreports the prize must
 * not cost the loser a card. When the check itself finds none of our notes
 * (it cannot be right about a settlement that paid us nothing) the settler's
 * word stands.
 */
async function confirmLoserPrize(
  game: PrivateGame,
  txEffect: TxEffectData,
  claimed: Extract<Resolution, { kind: 'settled' }>,
  label: string,
): Promise<Resolution> {
  try {
    const own = ownRecordOf(game);
    if (!own) return claimed;
    const released = await releasedPreparedNotes(txEffect, own, addressesForClassification());
    const found = released.returns.filter(Boolean).length;
    if (found !== released.returns.length - 1) {
      console.warn(`[gameActions] ${label}: the tx shows ${found} of our returns; keeping the settler's prize slot`);
      return claimed;
    }
    const slot = released.returns.findIndex(r => !r);
    if (claimed.prize && claimed.prize.slot === slot) return claimed;
    console.warn(`[gameActions] ${label}: the settler named slot ${claimed.prize?.slot}, the tx withheld slot ${slot} — using the tx`);
    return { ...claimed, prize: { cardId: game.hand[slot], slot } };
  } catch (err) {
    console.warn(`[gameActions] ${label}: could not check the prize slot against the tx (${err}); keeping the settler's`);
    return claimed;
  }
}

/** The tx that resolved the game, found from its `done` nullifier; null while unresolved. */
export async function discoverResolution(game: PrivateGame, ctx: ActionContext, facade: PxeOps = pxe): Promise<FoundTx | null> {
  const { nullifiers, state } = await readGameState(game, ctx, facade);
  if (!state.done) return null;
  const found = await findTxWithNullifier(ctx.node, state.done.blockNumber, nullifiers[NULLIFIER_INDEX.done]);
  if (!found) throw new Error(`the game resolved in block ${state.done.blockNumber}, but no tx there carries its nullifier`);
  return found;
}

/**
 * What a settler's announcement (SETTLING's prize move, or the one stored
 * with the game) and our transcript say a settlement did — or undefined when
 * they cannot say. A draw needs no announcement.
 */
export function announcedResolution(moveProofs: MoveProofData[] | undefined, prizeMove: number | null | undefined): Resolution | undefined {
  if (!moveProofs || moveProofs.length < TOTAL_MOVES) return undefined;
  try {
    const ordered = orderTranscript(moveProofs);
    const winner = winnerOf(ordered);
    if (winner === 'draw') return { kind: 'settled', winner };
    if (prizeMove === undefined || prizeMove === null) return undefined;
    return { kind: 'settled', winner, prize: prizeOfMove(ordered, winner, prizeMove) };
  } catch {
    return undefined; // an announcement that does not fit the transcript proves nothing
  }
}

/**
 * Find whatever resolved the game (from its `done` nullifier) and import our
 * notes from it; null while it is unresolved. Nobody said what the tx was — a
 * settlement, an unwind, a cancel — so the tx itself is read first, and
 * `fallback` (what an announcement said) is used only if that read fails.
 */
export async function importDiscoveredResolution(
  game: PrivateGame,
  ctx: ActionContext,
  opts: { moveProofs?: MoveProofData[]; fallback?: Resolution; label?: string } = {},
): Promise<ImportResult | null> {
  const found = await discoverResolution(game, ctx);
  if (!found) return null;
  const label = opts.label ?? 'Game resolution';
  // An abandonment's terms are on-chain: read them rather than infer them from
  // the tx, where the card a claimant took is not one of its prepared notes.
  let fromClaim: Resolution | undefined;
  try {
    const finalized = await finalizedClaimOf(game, ctx);
    if (finalized) fromClaim = resolutionOfClaim(finalized.claim.claimSide, finalized.terms);
  } catch (err) {
    console.warn(`[gameActions] ${label}: could not read the abandonment claim's terms (${err}); reading the tx instead`);
  }
  try {
    return await importResolution(game, ctx, {
      txHash: found.txHash, txEffect: found, resolution: fromClaim, moveProofs: opts.moveProofs, label,
    });
  } catch (err) {
    if (!opts.fallback) throw err;
    console.warn(`[gameActions] ${label}: could not read the resolution off the tx (${err}); using the announcement`);
    return importResolution(game, ctx, {
      txHash: found.txHash, txEffect: found, resolution: opts.fallback, moveProofs: opts.moveProofs, label,
    });
  }
}

// ─── Cancel ─────────────────────────────────────────────────────────────────

/**
 * Cancel a game nobody joined and take back the creator's five cards.
 * Checked against the chain first: a join (or an earlier cancel) closes seat 2
 * and the tx would only revert.
 */
export async function cancelGame(game: PrivateGame, ctx: ActionContext): Promise<ImportResult> {
  if (game.role !== 1) throw new Error('only the creator can cancel a game');
  const { state } = await readGameState(game, ctx);
  if (!state.created) throw new Error('the game was never created on-chain — there is nothing to cancel');
  if (state.done) throw new Error('the game is already resolved');
  if (state.seat2) throw new Error('someone has joined the game — it can no longer be cancelled');
  const txHash = await runPxeTx({
    type: 'cancel_game',
    label: 'Cancelling game...',
    gameId: game.roomId,
    execute: (ops, setPhase) => {
      setPhase('sending');
      return ops.sendCancelGame(ctx.owner, game.gameKey, game.record1, sendOpts(ctx));
    },
  });
  return importResolution(game, ctx, { txHash, resolution: { kind: 'cancelled' }, label: 'Cancel' });
}

// ─── Abandonment ────────────────────────────────────────────────────────────

/** A claim standing on-chain. */
export interface OpenClaim {
  claimNo: ClaimNo;
  claimSide: Side;
  claimBlock: number;
  /**
   * What the claim takes, when known: the claimant knows; anyone else looks
   * it up (`claimTermsOf`).
   */
  terms?: ForfeitTerms;
}

/** The opponent moved while a claim waited for the abandonment bar. */
export class OpponentResumedError extends Error {
  constructor() {
    super('the opponent moved — the game is not abandoned');
  }
}

/** The claim was contested before its window closed: the game goes on. */
export class ClaimContestedError extends Error {
  constructor(claimNo: number) {
    super(`claim ${claimNo} was contested — the game goes on`);
  }
}

/** The open-cards circuit's VK: what a claim's proof is verified against. */
async function loadHandVk(): Promise<Uint8Array> {
  const { circuitVerificationKey } = await import('./proofWorker');
  return circuitVerificationKey('prove_hand');
}

/**
 * The proof this player's claim carries (docs/plan/PRIVATE_GAMES.md §3.4).
 * Walking away costs the leaver one of their open cards: with the opponent's
 * checked open-cards proof, the claim takes the strongest of their three. A
 * claimant who never got it (they left before sending it) takes nothing and
 * carries its own open-cards proof instead.
 */
export async function claimForfeitFor(game: PrivateGame, ctx: ActionContext, facade: PxeOps = pxe): Promise<ClaimForfeit> {
  const theirs = game.opponentOpen;
  if (theirs && theirs.cards.length === OPEN_CARD_SLOTS) {
    return { terms: chooseForfeit(theirs.cards, cardStrength), proof: theirs.proof, publicInputs: theirs.publicInputs };
  }
  const own = game.ownOpen ?? await proveOwnOpenCards(game, ctx, facade);
  return { terms: NO_FORFEIT_TERMS, proof: own.proof, publicInputs: own.publicInputs };
}

/** Our open-cards proof, made afresh when none was kept (it takes well under a second). */
async function proveOwnOpenCards(game: PrivateGame, ctx: ActionContext, facade: PxeOps): Promise<OpenCardsPayload> {
  const own = ownRecordOf(game);
  if (!own) throw new Error('this player never committed to the game');
  const secrets = await secretsOf(game, ctx, facade);
  const { generateOpenCardsProof } = await import('./proofWorker');
  return generateOpenCardsProof(game.hand, secrets.blinding, handCommitOf(own));
}

/**
 * File the next abandonment claim for this player, once the contract will
 * take it: MIN_ABANDON_SECONDS of chain time after the claim's clock block.
 * `shouldStop` is checked while waiting — return true (the opponent moved)
 * and the claim is not filed. Returns the standing claim, with its terms.
 *
 * If a claim already stands, nothing is filed and that claim is returned:
 * the caller decides whether to contest it (theirs) or wait it out (ours).
 */
export async function claimAbandonment(
  game: PrivateGame,
  ctx: ActionContext,
  opts: { onBarProgress?: (secondsLeft: number) => void; shouldStop?: () => boolean } = {},
): Promise<OpenClaim> {
  const ref = refOf(game);
  const { nullifiers, position } = await readGameState(game, ctx);
  if (position.kind === 'open-claim') return position;
  if (position.kind !== 'can-claim') throw new Error(`no claim can be filed: the game is ${position.kind}`);

  // Ready before the wait, so the claim goes out the moment the bar passes.
  const forfeit = await claimForfeitFor(game, ctx);

  const clockSeconds = await blockTimestamp(ctx.node, position.clockBlock);
  await waitForAbandonBar(ctx.node as ChainClock, clockSeconds, {
    onProgress: secondsLeft => {
      if (opts.shouldStop?.()) throw new OpponentResumedError();
      opts.onBarProgress?.(secondsLeft);
    },
  });
  if (opts.shouldStop?.()) throw new OpponentResumedError();

  await runPxeTx({
    type: 'claim_abandoned_game',
    label: forfeit.terms.slot === NO_FORFEIT ? 'Claiming abandoned game...' : 'Claiming abandoned game and a forfeited card...',
    gameId: game.roomId,
    execute: async (ops, setPhase) => {
      setPhase('sending');
      const [handVk, { Fr }] = await Promise.all([loadHandVk(), import('@aztec-labs/aztec.js/fields')]);
      return ops.sendClaimAbandonedGame(
        ctx.owner,
        ref,
        { side: game.role, claimNo: position.claimNo, clockBlock: position.clockBlock },
        await buildClaimForfeitArgs(Fr, handVk, forfeit),
        sendOpts(ctx),
      );
    },
  });
  const hit = await waitForNullifier(ctx.node, nullifiers[NULLIFIER_INDEX.claim(position.claimNo, game.role)], 'the claim', {
    maxMs: 3 * 60_000,
  });
  return { claimNo: position.claimNo, claimSide: game.role, claimBlock: hit.blockNumber, terms: forfeit.terms };
}

/**
 * The open cards a claim by `claimSide` could take, as far as this player
 * knows them: their own first three if the claim is against them, the
 * opponent's checked open cards if it is theirs; null if unknown.
 */
function candidateOpenCards(game: PrivateGame, claimSide: Side): number[] | null {
  if (claimSide !== game.role) return game.hand.slice(0, OPEN_CARD_SLOTS);
  const theirs = game.opponentOpen?.cards;
  return theirs && theirs.length === OPEN_CARD_SLOTS ? [...theirs] : null;
}

/**
 * A standing claim's terms, read off the chain: each claim pushes exactly one
 * of four terms nullifiers (each open card, or nothing). Throws if none is
 * found: the claim is not in the chain yet, or it took a card this player
 * cannot name (it never saw the opponent's open cards).
 */
export async function claimTermsOf(
  game: PrivateGame,
  ctx: ActionContext,
  claim: OpenClaim,
  facade: PxeOps = pxe,
): Promise<ForfeitTerms> {
  if (claim.terms) return claim.terms;
  const cards = candidateOpenCards(game, claim.claimSide);
  // Unknown cards hash to terms nothing pushed; "nothing taken" is still checked.
  const nullifiers = await facade.forfeitNullifiers(
    ctx.owner, game.gameKey, game.record1, claim.claimNo, claim.claimSide, cards ?? [0, 0, 0],
  );
  const hits = await lookupNullifiers(ctx.node, nullifiers);
  const found = hits.findIndex(Boolean);
  if (found < 0) {
    throw new Error(`claim ${claim.claimNo}: none of its possible terms is on-chain${cards ? '' : ' (the opponent\'s open cards are unknown here)'}`);
  }
  if (found === OPEN_CARD_SLOTS) return NO_FORFEIT_TERMS;
  return { slot: found, cardId: cards![found] };
}

/** What finalizing a claim with these terms does to the game. */
function resolutionOfClaim(claimSide: Side, terms: ForfeitTerms): Resolution {
  if (terms.slot === NO_FORFEIT) return { kind: 'unwound' };
  return { kind: 'forfeited', claimSide, card: { cardId: terms.cardId, slot: terms.slot } };
}

/**
 * Wait out a claim's dispute window, then finalize it: the claimant gets
 * their five back plus the open card the claim took, the other player the
 * rest (both hands, if it took nothing). Anyone may finalize. Stops
 * (ClaimContestedError) if the claim was contested meanwhile; returns null if
 * the game resolved some other way (a settlement beats a claim) — import that
 * with `discoverResolution`.
 */
export async function finalizeAbandonment(
  game: PrivateGame,
  ctx: ActionContext,
  claim: OpenClaim,
  opts: { onDisputeProgress?: (secondsLeft: number) => void } = {},
): Promise<ImportResult | null> {
  const ref = refOf(game);
  const terms = await claimTermsOf(game, ctx, claim);
  const claimSeconds = await blockTimestamp(ctx.node, claim.claimBlock);
  await waitForDisputeWindow(ctx.node as ChainClock, claimSeconds, { onProgress: opts.onDisputeProgress });

  const { state } = await readGameState(game, ctx);
  if (state.done) return null;
  if (state.resolved[claim.claimNo - 1]) throw new ClaimContestedError(claim.claimNo);

  const txHash = await runPxeTx({
    type: 'finalize_abandoned_game',
    label: 'Recovering cards from an abandoned game...',
    gameId: game.roomId,
    execute: (ops, setPhase) => {
      setPhase('sending');
      return ops.sendFinalizeAbandonedGame(ctx.owner, ref, claim, terms, sendOpts(ctx));
    },
  });
  return importResolution(game, ctx, {
    txHash,
    resolution: resolutionOfClaim(claim.claimSide, terms),
    label: 'Abandoned game recovery',
  });
}

/**
 * The claim a finished abandonment was finalized from, with its terms; null
 * when the game was resolved some other way (settled, cancelled) or not yet.
 * A finalized claim is one resolved without a contest.
 */
export async function finalizedClaimOf(
  game: PrivateGame,
  ctx: ActionContext,
  facade: PxeOps = pxe,
): Promise<{ claim: OpenClaim; terms: ForfeitTerms } | null> {
  if (!game.record2) return null;
  const { state } = await readGameState(game, ctx, facade);
  if (!state.done) return null;
  for (const c of CLAIM_NUMBERS) {
    const resolved = state.resolved[c - 1];
    if (!resolved || state.contests[c - 1]) continue;
    const [bySide1, bySide2] = state.claims[c - 1];
    const filed = bySide1 ?? bySide2;
    if (!filed) continue;
    const claim: OpenClaim = { claimNo: c, claimSide: bySide1 ? 1 : 2, claimBlock: filed.blockNumber };
    return { claim, terms: await claimTermsOf(game, ctx, claim, facade) };
  }
  return null;
}

/**
 * Contest the other player's standing claim: "I am still here." Must land
 * within DISPUTE_SECONDS of the claim; each side contests once. The game then
 * goes on, and its abandonment clock restarts at this contest.
 */
export async function contestClaim(game: PrivateGame, ctx: ActionContext, claim: OpenClaim): Promise<string> {
  const ref = refOf(game);
  if (claim.claimSide === game.role) throw new Error('a player cannot contest their own claim');
  return runPxeTx({
    type: 'contest_abandonment',
    label: 'Contesting the abandonment claim...',
    gameId: game.roomId,
    execute: (ops, setPhase) => {
      setPhase('sending');
      return ops.sendContestAbandonment(
        ctx.owner,
        ref,
        { side: game.role, claimNo: claim.claimNo, claimSide: claim.claimSide, beforeClaimBlock: claim.claimBlock - 1 },
        sendOpts(ctx),
      );
    },
  });
}
