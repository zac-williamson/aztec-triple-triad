import type { GameState, Player, Card } from '@aztec-triple-triad/game-logic';
import { placeCard, createGame } from '@aztec-triple-triad/game-logic';
import type {
  PlayerSession,
  HandProof,
  MoveProof,
  GameProofBundle,
  GameMoveInput,
} from './types.js';
import type { ProofService } from './prover.js';
import {
  boardToCircuitFormat,
  scoresToCircuitFormat,
  playerToField,
  winnerToField,
} from './state.js';

/**
 * Manages a complete proof-based game session for one player.
 * Tracks game state, generates proofs for each move, and collects
 * all proofs for on-chain settlement.
 */
export class GameSession {
  private gameState: GameState;
  private moveProofs: MoveProof[] = [];
  private myHandProof: HandProof | null = null;
  private opponentHandProof: HandProof | null = null;
  private stateHashes: string[] = [];
  private cardCommit1 = '';
  private cardCommit2 = '';

  constructor(
    private readonly proofService: ProofService,
    private readonly playerSession: PlayerSession,
    private readonly myPlayer: Player,
    private readonly gameId: string,
    private readonly computeStateHash: (fields: string[]) => Promise<string>,
  ) {
    // Will be initialized when game starts
    this.gameState = null as any;
  }

  /**
   * Initialize the game session by generating the hand proof.
   */
  async initializeHand(): Promise<HandProof> {
    this.myHandProof = await this.proofService.proveHand(
      this.playerSession.cardIds,
      this.playerSession.blindingFactor,
      this.playerSession.cardCommit,
    );
    return this.myHandProof;
  }

  /**
   * Set the opponent's hand proof (received via WebSocket).
   */
  setOpponentHandProof(proof: HandProof): void {
    this.opponentHandProof = proof;
  }

  /**
   * Start the game after both hand proofs are exchanged.
   * @param player1Cards - Card IDs for player 1
   * @param player2Cards - Card IDs for player 2
   */
  async startGame(player1Cards: Card[], player2Cards: Card[]): Promise<void> {
    this.gameState = createGame(player1Cards, player2Cards);

    // Set card commits based on player order
    if (this.myPlayer === 'player1') {
      this.cardCommit1 = this.myHandProof!.cardCommit;
      this.cardCommit2 = this.opponentHandProof!.cardCommit;
    } else {
      this.cardCommit1 = this.opponentHandProof!.cardCommit;
      this.cardCommit2 = this.myHandProof!.cardCommit;
    }

    // Compute initial state hash
    const hashInput = this.getStateHashInput();
    const initialHash = await this.computeStateHash(hashInput);
    this.stateHashes.push(initialHash);
  }

  /**
   * Make a move and generate the corresponding proof.
   * Returns the proof to send to the opponent.
   */
  async makeMove(handIndex: number, row: number, col: number): Promise<MoveProof> {
    const stateBefore = this.gameState;
    const card = this.getCurrentHand()[handIndex];

    // Apply the move
    const result = placeCard(stateBefore, this.myPlayer, handIndex, row, col);
    const stateAfter = result.newState;

    // Compute state hashes
    const startHash = this.stateHashes[this.stateHashes.length - 1];
    const endHashInput = this.getStateHashInputFor(stateAfter);
    const endHash = await this.computeStateHash(endHashInput);
    this.stateHashes.push(endHash);

    // Build circuit input
    const moveInput: GameMoveInput = {
      card_commit_1: this.cardCommit1,
      card_commit_2: this.cardCommit2,
      start_state_hash: startHash,
      end_state_hash: endHash,
      game_ended: stateAfter.status === 'finished' ? '1' : '0',
      winner_id: winnerToField(stateAfter.winner),
      current_player: playerToField(this.myPlayer),
      card_id: String(card.id),
      row: String(row),
      col: String(col),
      board_before: boardToCircuitFormat(stateBefore.board),
      board_after: boardToCircuitFormat(stateAfter.board),
      scores_before: scoresToCircuitFormat(stateBefore),
      scores_after: scoresToCircuitFormat(stateAfter),
      current_turn_before: playerToField(stateBefore.currentTurn),
      player_card_ids: this.playerSession.cardIds.map(String),
      blinding_factor: this.playerSession.blindingFactor,
    };

    // Generate proof
    const moveProof = await this.proofService.proveGameMove(moveInput);
    this.moveProofs.push(moveProof);

    // Update game state
    this.gameState = stateAfter;

    return moveProof;
  }

  /**
   * Apply an opponent's move (with proof) to the game state.
   */
  async applyOpponentMove(
    moveProof: MoveProof,
    handIndex: number,
    row: number,
    col: number,
  ): Promise<void> {
    const opponent: Player = this.myPlayer === 'player1' ? 'player2' : 'player1';

    // Apply the move
    const result = placeCard(this.gameState, opponent, handIndex, row, col);
    this.gameState = result.newState;

    // Update state hash
    const endHashInput = this.getStateHashInputFor(this.gameState);
    const endHash = await this.computeStateHash(endHashInput);
    this.stateHashes.push(endHash);

    // Store the opponent's proof
    this.moveProofs.push(moveProof);
  }

  /**
   * Get the complete proof bundle for on-chain settlement.
   * Only the winner should call this.
   */
  getProofBundle(selectedCardId: number): GameProofBundle {
    if (this.gameState.status !== 'finished') {
      throw new Error('Game is not finished');
    }
    if (!this.myHandProof || !this.opponentHandProof) {
      throw new Error('Hand proofs not available');
    }

    return {
      gameId: this.gameId,
      handProof1: this.myPlayer === 'player1' ? this.myHandProof : this.opponentHandProof,
      handProof2: this.myPlayer === 'player1' ? this.opponentHandProof : this.myHandProof,
      moveProofs: this.moveProofs,
      winner: this.gameState.winner!,
      selectedCardId,
    };
  }

  /** Get current game state. */
  getGameState(): GameState {
    return this.gameState;
  }

  /** Get the current player's hand. */
  getCurrentHand(): Card[] {
    return this.myPlayer === 'player1'
      ? this.gameState.player1Hand
      : this.gameState.player2Hand;
  }

  /** Check if it's this player's turn. */
  isMyTurn(): boolean {
    return this.gameState.currentTurn === this.myPlayer;
  }

  /** Check if the game is finished. */
  isFinished(): boolean {
    return this.gameState.status === 'finished';
  }

  /** Check if this player is the winner. */
  isWinner(): boolean {
    return this.gameState.winner === this.myPlayer;
  }

  private getStateHashInput(): string[] {
    return this.getStateHashInputFor(this.gameState);
  }

  private getStateHashInputFor(state: GameState): string[] {
    const board = boardToCircuitFormat(state.board);
    const scores = scoresToCircuitFormat(state);
    const turn = playerToField(state.currentTurn);
    return [...board, ...scores, turn];
  }
}
