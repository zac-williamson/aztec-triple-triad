/**
 * The harness's snapshot keeps its shape now that the relay runs no game
 * (docs/plan/PRIVATE_GAMES.md section 6): board, hands, turn, scores, status
 * and the result come from the game the client runs itself (useGamePlay).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../aztec/contracts', () => ({ ensureContracts: vi.fn() }));
vi.mock('./project', () => ({ getScreenXY: vi.fn() }));
vi.mock('../aztec/txManager', () => ({ default: { getEntries: () => [], enqueuePxe: vi.fn() } }));
vi.mock('../aztec/txProgress', () => ({ txProgress: { subscribe: vi.fn() } }));

import { createApi } from './api';
import { registry, publishApp, publishGameScreen, publishScene, type SceneBridgeState } from './registry';
import { hiddenCard } from '../aztec/localGame';
import type { UseAztecReturn } from '../hooks/useAztec';
import type { UseGameReturn } from '../hooks/useGame';
import type { GameState } from '../types';

const card = (id: number) => ({ id, name: `c${id}`, ranks: { top: 1, right: 1, bottom: 1, left: 1 } });

function emptyBoard(): GameState['board'] {
  return Array.from({ length: 3 }, () => Array.from({ length: 3 }, () => ({ card: null, owner: null, originalOwner: null })));
}

beforeEach(() => {
  registry.aztec = null;
  registry.game = null;
  registry.gameScreen = null;
  registry.scene = null;
});

describe('phase() reads the client\'s own game', () => {
  it('board, hands (unseen cards as 0), turn, scores and result — with the relay holding none of it', () => {
    const board = emptyBoard();
    board[1][1] = { card: card(21), owner: 'player2', originalOwner: 'player2' };
    const gameState: GameState = {
      board,
      player1Hand: [card(11), card(12)],
      player2Hand: [card(22), hiddenCard()],
      currentTurn: 'player1', player1Score: 4, player2Score: 6, status: 'finished', winner: 'player2',
    };
    const game = {
      screen: 'game', onChainGameId: null, commitStatus: 'ready', moveProofStatus: 'ready', canSettle: true,
      settleTxStatus: 'idle', opponentSettled: false, takenCardId: null, onChainError: null,
      isClaimingAbandoned: false, abandonBarCountdown: null, abandonedDisputeCountdown: null,
      gameState, gameOver: { winner: 'player2' }, playerNumber: 1, roomId: 'room-1', protocolError: null,
      ws: { connected: true, gameId: 'room-1', playerNumber: 1, matchmakingStatus: 'matched', opponentDisconnected: false, abandonmentWarning: null },
    } as unknown as UseGameReturn;
    publishApp({ status: 'connected', accountAddress: '0xME', ownedCardIds: [], tokenBalance: 0 } as unknown as UseAztecReturn, game);

    const snap = createApi().phase()!;
    expect(snap.ws.gameOver).toEqual({ winner: 'player2' });
    expect(snap.ws.playerNumber).toBe(1);
    expect(snap.game).toMatchObject({
      status: 'finished', currentTurn: 'player1', isMyTurn: true,
      myHandCardIds: [11, 12], opponentHandCardIds: [22, 0], myScore: 4, opponentScore: 6, protocolError: null,
    });
    expect(snap.game!.board[1][1]).toEqual({ cardId: 21, owner: 'player2', originalOwner: 'player2' });
    expect(snap.chain.canSettle).toBe(true);
  });

  it('no game on screen: no game in the snapshot', () => {
    publishApp(
      { status: 'connected', accountAddress: '0xME', ownedCardIds: [], tokenBalance: 0 } as unknown as UseAztecReturn,
      { screen: 'main-menu', gameState: null, gameOver: null, playerNumber: null, roomId: null,
        ws: { connected: true, gameId: null, playerNumber: null, matchmakingStatus: 'idle', opponentDisconnected: false, abandonmentWarning: null } } as unknown as UseGameReturn,
    );
    const snap = createApi().phase()!;
    expect(snap.game).toBeNull();
    expect(snap.ws.gameOver).toBeNull();
  });
});

describe('phase() reports the interaction gates as the 3D scene has them', () => {
  const scene = (selectedCardIndex: number | null, isMyTurn: boolean): SceneBridgeState => ({
    camera: {} as SceneBridgeState['camera'], scene: {} as SceneBridgeState['scene'],
    size: { width: 1440, height: 900 }, canvas: {} as HTMLCanvasElement, selectedCardIndex, isMyTurn,
  });

  it('separately from the game screen, so a harness can wait for the canvas to catch up', () => {
    publishApp(
      { status: 'connected', accountAddress: '0xME', ownedCardIds: [], tokenBalance: 0 } as unknown as UseAztecReturn,
      { screen: 'game', gameState: null, gameOver: null, playerNumber: 1, roomId: 'room-1',
        ws: { connected: true, gameId: 'room-1', playerNumber: 1, matchmakingStatus: 'matched', opponentDisconnected: false, abandonmentWarning: null } } as unknown as UseGameReturn,
    );
    // The page has the card selected; the canvas — its own React root,
    // committed a scheduler task later — does not yet. A cell clicked now
    // drops the click, and the snapshot has to say so.
    publishGameScreen({ selectedCardIndex: 0, flying: false, cascading: false });
    publishScene(scene(null, true));
    expect(createApi().phase()!.interaction).toEqual({
      selectedCardIndex: 0, flying: false, cascading: false, sceneSelectedCardIndex: null, sceneIsMyTurn: true,
    });

    publishScene(scene(0, true));
    expect(createApi().phase()!.interaction).toMatchObject({ selectedCardIndex: 0, sceneSelectedCardIndex: 0 });
  });

  it('no scene mounted: the scene gates are null', () => {
    publishApp(
      { status: 'connected', accountAddress: '0xME', ownedCardIds: [], tokenBalance: 0 } as unknown as UseAztecReturn,
      { screen: 'game', gameState: null, gameOver: null, playerNumber: 2, roomId: 'room-1',
        ws: { connected: true, gameId: 'room-1', playerNumber: 2, matchmakingStatus: 'matched', opponentDisconnected: false, abandonmentWarning: null } } as unknown as UseGameReturn,
    );
    publishGameScreen({ selectedCardIndex: null, flying: false, cascading: false });
    expect(createApi().phase()!.interaction).toMatchObject({ sceneSelectedCardIndex: null, sceneIsMyTurn: null });
  });
});
