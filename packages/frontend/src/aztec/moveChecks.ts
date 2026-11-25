/**
 * Checking what the opponent sends (docs/plan/PRIVATE_GAMES.md section 6.3).
 *
 * The relay no longer runs the rules, so each client is its own referee. A
 * MOVE is accepted only if, in order:
 *
 *   1. it fits the game so far — the opponent's turn, their unplayed slot, the
 *      open card proven for that slot (or a hidden slot), an empty cell;
 *   2. applied to our board, it gives the state hashes its proof carries:
 *      start = our state now, end = our state after it;
 *   3. its public inputs are exactly what that board implies — both records'
 *      hand commitments, those hashes, game_ended and winner_id, the card and
 *      the slot it names;
 *   4. the proof verifies against the game_move verification key.
 *
 * OPEN_CARDS likewise: the proof's commitment is the opponent's record's
 * `hand_commit`, its open cards are the ones named, they fit the moves made so
 * far, and the open-cards (prove_hand) proof verifies.
 *
 * The rules and hashing are pure (localGame.ts); the hasher and the verifiers
 * are injected, so every rejection path is testable without bb.js.
 */
import {
  expectedMoveInputs,
  expectedOpenCardsInputs,
  MOVE_INPUT_NAMES,
  moveProofFromOutput,
  moveStateHashes,
  OPEN_CARDS_INPUT_NAMES,
  openCardsProblem,
  opponentMoveProblem,
  publicInputsMismatch,
  replay,
  type GameMove,
  type LocalGameFacts,
  type MovePayload,
  type OpenCardsPayload,
  type StateHasher,
  type TranscriptMove,
} from './localGame';
import { moverOf } from './privateGame';

/** The cryptography a check needs: the state hash and the two verifiers. */
export interface ProofChecks {
  hashState: StateHasher;
  /** Verify a game_move proof (base64) against its public inputs. */
  verifyMove: (proof: string, publicInputs: string[]) => Promise<boolean>;
  /** Verify an open-cards (prove_hand) proof (base64) against its public inputs. */
  verifyOpenCards: (proof: string, publicInputs: string[]) => Promise<boolean>;
  /** Optional: get ready ahead of time (compute the verification keys) while nothing waits on it. */
  prepare?: () => Promise<void>;
}

/**
 * A check's outcome. `retryable` marks a failure that says nothing about the
 * payload (the verifier itself threw): the payload is kept and checked again
 * later instead of being held against the opponent.
 */
export type CheckResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string; retryable: boolean };

const reject = (reason: string, retryable = false): { ok: false; reason: string; retryable: boolean } =>
  ({ ok: false, reason, retryable });

async function verified(
  verify: (proof: string, publicInputs: string[]) => Promise<boolean>,
  proof: string,
  publicInputs: string[],
): Promise<CheckResult<true>> {
  try {
    return (await verify(proof, publicInputs)) ? { ok: true, value: true } : reject('its proof does not verify');
  } catch (err) {
    return reject(`its proof could not be checked (${err instanceof Error ? err.message : String(err)})`, true);
  }
}

/** Both records' hand commitments: `card_commit_1` is the creator's, `card_commit_2` the joiner's. */
export interface HandCommits {
  commit1: string;
  commit2: string;
}

/**
 * Check the opponent's move `moveNumber` and, if it holds, return it as a
 * transcript link (its proof rebuilt from the public inputs, never from
 * fields the sender filled in).
 */
export async function checkOpponentMove(
  facts: LocalGameFacts,
  commits: HandCommits,
  moveNumber: number,
  payload: MovePayload,
  checks: ProofChecks,
): Promise<CheckResult<TranscriptMove>> {
  const move: GameMove = { moveNumber, cardId: payload.cardId, slot: payload.slot, row: payload.row, col: payload.col };
  const before = replay(facts);
  const problem = opponentMoveProblem(facts, before, move);
  if (problem) return reject(problem);

  let after;
  try {
    after = replay({ ...facts, moves: [...facts.moves, move] });
  } catch (err) {
    return reject(`it does not apply to this board (${err instanceof Error ? err.message : String(err)})`);
  }

  let hashes;
  try {
    hashes = await moveStateHashes(before.state, after.state, moverOf(moveNumber), checks.hashState);
  } catch (err) {
    return reject(`the board could not be hashed (${err instanceof Error ? err.message : String(err)})`, true);
  }
  const expected = expectedMoveInputs({ commit1: commits.commit1, commit2: commits.commit2, hashes, after: after.state, move });
  const mismatch = publicInputsMismatch(expected, payload.publicInputs, MOVE_INPUT_NAMES);
  if (mismatch) return reject(`its proof's ${mismatch}`);

  const proof = await verified(checks.verifyMove, payload.proof, payload.publicInputs);
  if (!proof.ok) return proof;

  return { ok: true, value: { ...move, proof: moveProofFromOutput(payload.proof, payload.publicInputs) } };
}

/**
 * Check the opponent's OPEN_CARDS against their record's hand commitment and
 * the moves made so far. Returns the three open cards.
 */
export async function checkOpenCards(
  facts: LocalGameFacts,
  opponentHandCommit: string,
  payload: OpenCardsPayload,
  checks: ProofChecks,
): Promise<CheckResult<number[]>> {
  const problem = openCardsProblem(facts, replay(facts), payload.cards);
  if (problem) return reject(problem);
  const mismatch = publicInputsMismatch(
    expectedOpenCardsInputs(opponentHandCommit, payload.cards),
    payload.publicInputs,
    OPEN_CARDS_INPUT_NAMES,
  );
  if (mismatch) return reject(`the open-cards proof's ${mismatch}`);
  const proof = await verified(checks.verifyOpenCards, payload.proof, payload.publicInputs);
  if (!proof.ok) return proof;
  return { ok: true, value: [...payload.cards] };
}
