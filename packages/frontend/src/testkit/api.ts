/**
 * The window.__triadTest surface consumed by the playtest harness
 * (packages/playtest) via page.evaluate / page.waitForFunction.
 *
 * Everything returned by the sync snapshot is JSON-serializable.
 * Private-state reads go through txManager's PXE queue — the same serial
 * queue the app uses — because concurrent PXE access corrupts IndexedDB
 * transactions (see MASTER_PLAN ground rules).
 */
import txManager, { type TxEntry } from '../aztec/txManager';
import { txProgress, type TxProgressEvent } from '../aztec/txProgress';
import { ensureContracts } from '../aztec/contracts';
import { registry } from './registry';
import { getScreenXY, type ClickTarget } from './project';
import type { Player } from '../types';

export interface CellSnapshot {
  cardId: number | null;
  owner: Player | null;
  originalOwner: Player | null;
}

export interface PhaseSnapshot {
  seq: number;
  screen: string;
  aztecStatus: string;
  accountAddress: string | null;
  ownedCardIds: number[];
  tokenBalance: number;
  ws: {
    connected: boolean;
    gameId: string | null;
    playerNumber: 1 | 2 | null;
    matchmakingStatus: string;
    gameOver: { winner: Player | 'draw' } | null;
    opponentDisconnected: boolean;
  };
  game: {
    status: string;
    currentTurn: Player;
    isMyTurn: boolean;
    board: CellSnapshot[][];
    myHandCardIds: number[];
    myScore: number;
    opponentScore: number;
  } | null;
  chain: {
    onChainGameId: string | null;
    handProofStatus: string;
    moveProofStatus: string;
    canSettle: boolean;
    settleTxStatus: string;
    opponentSettled: boolean;
    takenCardId: number | null;
    onChainError: string | null;
  };
  interaction: {
    selectedCardIndex: number | null;
    flying: boolean;
    cascading: boolean;
  } | null;
}

export interface TriadTestApi {
  /** Monotonic publish counter — bump means state changed. */
  seq(): number;
  /** Cheap synchronous snapshot of app/game/chain state. Null until the app bridge publishes. */
  phase(): PhaseSnapshot | null;
  /** Viewport pixel coords for a board cell or hand-fan strip, via the live camera. */
  getScreenXY(target: ClickTarget): { x: number; y: number };
  /** Direct-dispatch escape hatch ("fast interaction" mode). Click mode is the default. */
  placeCard(handIndex: number, row: number, col: number): void;
  /** Card token IDs in THIS tab's PXE (serialized through the app's PXE queue). */
  getPrivateCards(): Promise<number[]>;
  /** Arena Token balance from THIS tab's PXE (serialized through the app's PXE queue). */
  getTokenBalance(): Promise<number>;
  /** Live txManager entries (create_game / join_game / settle_game lifecycle). */
  txEntries(): TxEntry[];
  /** Recent txProgress events (wallet-level phases incl. aztecTxHash). */
  txEvents(): TxProgressEvent[];
}

const PXE_READ_TIMEOUT_MS = 120_000;
/** FIFO behind all app work — reads never jump the PXE queue. */
const PXE_READ_PRIORITY = 9;

function snapshotPhase(): PhaseSnapshot | null {
  const { aztec, game, gameScreen, seq } = registry;
  if (!aztec || !game) return null;

  const ws = game.ws;
  const gameState = ws.gameState;
  const playerNumber = ws.playerNumber;
  const myPlayer: Player | null = playerNumber === 1 ? 'player1' : playerNumber === 2 ? 'player2' : null;

  return {
    seq,
    screen: game.screen,
    aztecStatus: aztec.status,
    accountAddress: aztec.accountAddress,
    ownedCardIds: [...aztec.ownedCardIds],
    tokenBalance: aztec.tokenBalance,
    ws: {
      connected: ws.connected,
      gameId: ws.gameId,
      playerNumber,
      matchmakingStatus: ws.matchmakingStatus,
      gameOver: ws.gameOver,
      opponentDisconnected: ws.opponentDisconnected,
    },
    game: gameState && myPlayer
      ? {
          status: gameState.status,
          currentTurn: gameState.currentTurn,
          isMyTurn: gameState.currentTurn === myPlayer,
          board: gameState.board.map(row => row.map(cell => ({
            cardId: cell.card?.id ?? null,
            owner: cell.owner,
            originalOwner: cell.originalOwner ?? null,
          }))),
          myHandCardIds: (myPlayer === 'player1' ? gameState.player1Hand : gameState.player2Hand)
            .map(c => c.id),
          myScore: myPlayer === 'player1' ? gameState.player1Score : gameState.player2Score,
          opponentScore: myPlayer === 'player1' ? gameState.player2Score : gameState.player1Score,
        }
      : null,
    chain: {
      onChainGameId: game.onChainGameId,
      handProofStatus: game.handProofStatus,
      moveProofStatus: game.moveProofStatus,
      canSettle: game.canSettle,
      settleTxStatus: game.settleTxStatus,
      opponentSettled: game.opponentSettled,
      takenCardId: game.takenCardId,
      onChainError: game.onChainError,
    },
    interaction: gameScreen
      ? {
          selectedCardIndex: gameScreen.selectedCardIndex,
          flying: gameScreen.flying,
          cascading: gameScreen.cascading,
        }
      : null,
  };
}

function requireConnected() {
  const { aztec } = registry;
  if (!aztec?.wallet || !aztec.accountAddress) {
    throw new Error('testkit: wallet not connected');
  }
  return { wallet: aztec.wallet, accountAddress: aztec.accountAddress };
}

/**
 * Page through get_nfts_for_user — the same read the app performs after
 * note import (connectToAztec.ts). Runs inside the PXE serial queue.
 */
async function readPrivateCards(): Promise<number[]> {
  const { wallet, accountAddress } = requireConnected();
  return txManager.enqueuePxe(async () => {
    const { nftContract, AztecAddress } = await ensureContracts(wallet);
    const owner = AztecAddress.fromString(accountAddress);
    const ids: number[] = [];
    let pageIndex = 0;
    let hasMore = true;
    while (hasMore) {
      const { result } = await nftContract.methods
        .get_nfts_for_user(owner, pageIndex)
        .simulate({ from: owner });
      const page = result[0] ?? [];
      hasMore = result[1] === true;
      for (const val of page) {
        const id = Number(BigInt(val));
        if (id !== 0) ids.push(id);
      }
      pageIndex++;
    }
    return ids;
  }, PXE_READ_TIMEOUT_MS, PXE_READ_PRIORITY);
}

async function readTokenBalance(): Promise<number> {
  const { wallet, accountAddress } = requireConnected();
  return txManager.enqueuePxe(async () => {
    const { tokenContract, AztecAddress } = await ensureContracts(wallet);
    if (!tokenContract) throw new Error('testkit: token contract not configured');
    const owner = AztecAddress.fromString(accountAddress);
    const { result } = await tokenContract.methods
      .get_balance(owner)
      .simulate({ from: owner });
    return Number(BigInt(result.toString()));
  }, PXE_READ_TIMEOUT_MS, PXE_READ_PRIORITY);
}

const TX_EVENT_BUFFER = 100;

export function createApi(): TriadTestApi {
  const txEvents: TxProgressEvent[] = [];
  txProgress.subscribe(event => {
    txEvents.push(event);
    if (txEvents.length > TX_EVENT_BUFFER) txEvents.shift();
  });

  return {
    seq: () => registry.seq,
    phase: snapshotPhase,
    getScreenXY,
    placeCard: (handIndex, row, col) => {
      const game = registry.game;
      if (!game) throw new Error('testkit: app bridge not published');
      game.handlePlaceCard(handIndex, row, col);
    },
    getPrivateCards: readPrivateCards,
    getTokenBalance: readTokenBalance,
    txEntries: () => txManager.getEntries().map(e => ({ ...e })),
    txEvents: () => txEvents.map(e => ({ ...e })),
  };
}
