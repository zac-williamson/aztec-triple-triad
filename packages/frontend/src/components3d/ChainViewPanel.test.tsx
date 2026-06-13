/**
 * ChainViewPanel — the "you see / chain sees" privacy demo (lane item C).
 * Pins: hands render locally while the chain column shows only commitment
 * hashes; the 11-proof ticker tracks live proof state with prover timings;
 * settlement activity streams from txProgress; GameHUD's toggle mounts it.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ChainViewPanel, truncateHash, type ChainViewData } from './ChainViewPanel';
import { GameHUD } from './GameHUD';
import { txProgress } from '../aztec/txProgress';
import type { GameState, HandProofData, MoveProofData } from '../types';

const myHandProof: HandProofData = {
  proof: 'AA==',
  publicInputs: ['0xabc'],
  cardCommit: '0x1111111111111111111111111111111111111111111111111111111111111111',
  durationMs: 8200,
};

const oppHandProof: HandProofData = {
  proof: 'AA==',
  publicInputs: ['0xdef'],
  cardCommit: '0x2222222222222222222222222222222222222222222222222222222222222222',
};

function makeMoveProof(n: number): MoveProofData {
  return {
    proof: 'AA==',
    publicInputs: [],
    cardCommit1: '0x1',
    cardCommit2: '0x2',
    startStateHash: `0xstart${n}`,
    endStateHash: `0xend${n}aaaaaaaaaaaaaaaa`,
    gameEnded: false,
    winnerId: 0,
    durationMs: 3000 + n,
  };
}

const baseData: ChainViewData = {
  onChainGameId: '0x3333333333333333333333333333333333333333333333333333333333333333',
  myHandProof,
  opponentHandProof: oppHandProof,
  moveProofs: [makeMoveProof(1), makeMoveProof(2), makeMoveProof(3)],
  settleTxHash: null,
};

const myHand = [
  { id: 1, name: 'Mudwalker', ranks: { top: 1, right: 4, bottom: 1, left: 5 } },
  { id: 2, name: 'Blushy', ranks: { top: 5, right: 1, bottom: 1, left: 3 } },
];

describe('truncateHash', () => {
  it('truncates long hashes and preserves short ones', () => {
    expect(truncateHash('0x1234567890abcdef1234')).toBe('0x12345678…ef1234');
    expect(truncateHash('0xshort')).toBe('0xshort');
  });
});

describe('ChainViewPanel', () => {
  it('shows the local hand on the "you" side and only commitments on the chain side', () => {
    render(<ChainViewPanel data={baseData} myHand={myHand} opponentHandCount={4} onClose={() => {}} />);

    // You see: real card names
    expect(screen.getByText('Mudwalker')).toBeTruthy();
    expect(screen.getByText('Blushy')).toBeTruthy();
    expect(screen.getByText(/4 hidden cards/)).toBeTruthy();

    // Chain sees: truncated commitments, never card names
    expect(screen.getByText(truncateHash(myHandProof.cardCommit))).toBeTruthy();
    expect(screen.getByText(truncateHash(oppHandProof.cardCommit))).toBeTruthy();
    expect(screen.getByText(truncateHash(baseData.onChainGameId!))).toBeTruthy();
  });

  it('renders placeholders before the pipeline produced commitments', () => {
    render(
      <ChainViewPanel
        data={{ onChainGameId: null, myHandProof: null, opponentHandProof: null, moveProofs: [], settleTxHash: null }}
        myHand={myHand}
        opponentHandCount={5}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('not created yet')).toBeTruthy();
    expect(screen.getByText('proving…')).toBeTruthy();
    expect(screen.getByText('waiting…')).toBeTruthy();
    expect(screen.getByText('0/11')).toBeTruthy();
  });

  it('ticks the proof transcript: done count, per-proof prover timings, pending rows', () => {
    render(<ChainViewPanel data={baseData} myHand={myHand} opponentHandCount={4} onClose={() => {}} />);

    // 2 hand proofs + 3 move proofs done out of 11
    expect(screen.getByText('5/11')).toBeTruthy();
    // My hand proof carries its prover duration
    expect(screen.getByText('8.2s')).toBeTruthy();
    // Opponent's proof arrived without timing — row is done but shows no duration
    const moveRows = screen.getAllByText(/^Move proof \d$/);
    expect(moveRows).toHaveLength(9);
    // Moves 4..9 still pending
    expect(screen.getAllByText('pending')).toHaveLength(6);
  });

  it('streams live settlement activity from txProgress and links the settle tx hash', () => {
    render(
      <ChainViewPanel
        data={{ ...baseData, settleTxHash: '0x4444444444444444444444444444444444444444444444444444444444444444' }}
        myHand={[]}
        opponentHandCount={0}
        onClose={() => {}}
      />,
    );

    act(() => {
      txProgress.emit({
        txId: 'tx-1',
        label: 'Settling game...',
        phase: 'proving',
        startTime: 1000,
        phaseStartTime: 1000,
        phases: [{ name: 'simulate', duration: 2500, color: '#fff' }],
      });
    });

    expect(screen.getByTestId('chain-view-tx').textContent).toContain('Settling game...');
    expect(screen.getByText('proving')).toBeTruthy();
    expect(screen.getByText(/simulate 2\.5s/)).toBeTruthy();
    expect(screen.getByText(truncateHash('0x4444444444444444444444444444444444444444444444444444444444444444'))).toBeTruthy();
  });

  it('calls onClose from the close button', () => {
    const onClose = vi.fn();
    render(<ChainViewPanel data={baseData} myHand={myHand} opponentHandCount={4} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('Close chain view'));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('GameHUD chain-view toggle', () => {
  const gameState: GameState = {
    board: Array.from({ length: 3 }, () =>
      Array.from({ length: 3 }, () => ({ card: null, owner: null, originalOwner: null })),
    ),
    player1Hand: myHand,
    player2Hand: [{ id: 9, name: 'Hidden', ranks: { top: 1, right: 1, bottom: 1, left: 1 } }],
    currentTurn: 'player1',
    player1Score: 5,
    player2Score: 5,
    status: 'playing',
    winner: null,
  };

  const hudProps = {
    gameState,
    playerNumber: 1 as const,
    gameId: 'game-123',
    gameOver: null,
    opponentDisconnected: false,
    isMyTurn: true,
    isFinished: false,
    myPlayer: 'player1' as const,
    myScore: 5,
    opponentScore: 5,
    onBackToLobby: () => {},
  };

  it('mounts the panel from the toggle and closes it again', () => {
    render(<GameHUD {...hudProps} chainView={baseData} />);
    expect(screen.queryByTestId('chain-view-panel')).toBeNull();

    fireEvent.click(screen.getByTestId('chain-view-toggle'));
    expect(screen.getByTestId('chain-view-panel')).toBeTruthy();
    // Panel derives the hands from gameState: P1 sees own cards, 1 hidden opponent card
    expect(screen.getByText('Mudwalker')).toBeTruthy();
    expect(screen.getByText(/1 hidden card$/)).toBeTruthy();

    fireEvent.click(screen.getByTestId('chain-view-toggle'));
    expect(screen.queryByTestId('chain-view-panel')).toBeNull();
  });

  it('hides the toggle when no chainView data is provided', () => {
    render(<GameHUD {...hudProps} />);
    expect(screen.queryByTestId('chain-view-toggle')).toBeNull();
  });
});
