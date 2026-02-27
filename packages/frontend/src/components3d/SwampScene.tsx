import { Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { ACESFilmicToneMapping, Vector3, Euler } from 'three';
import { EffectComposer, Bloom, Vignette } from '@react-three/postprocessing';
import type { Board, Card, Player } from '../types';
import { GameBoard } from './GameBoard';
import { WaterSurface } from './WaterSurface';
import { SwampFloor } from './SwampFloor';
import { SwampEnvironment } from './SwampEnvironment';
import { PropLayout } from './PropLayout';
import { Particles } from './Particles';
import { CameraController } from './CameraController';
import { PlayerHand3D } from './PlayerHand3D';
import { OpponentHand3D } from './OpponentHand3D';
import { FlyingCard } from './FlyingCard';
import { CaptureFlipCard } from './CaptureFlipCard';
import { SparkBurst } from './SparkBurst';
import type { FlyingCardState } from './hooks/useCardAnimation';
import type { CaptureAnimationEntry } from './hooks/useCaptureAnimation';
import {
  getHandCardWorldPosition,
  PLAYER_HAND_POS,
  PLAYER_HAND_ROT,
  OPPONENT_HAND_POS,
  OPPONENT_HAND_ROT,
} from './utils/cardPositions';

interface SwampSceneProps {
  board: Board;
  validPlacements: { row: number; col: number }[];
  onCellClick?: (row: number, col: number) => void;
  // 3D hand props
  myHand: Card[];
  opponentHand: Card[];
  myPlayer: Player;
  selectedCardIndex: number | null;
  isMyTurn: boolean;
  isFinished: boolean;
  onCardClick: (index: number) => void;
  onDeselect: () => void;
  // Fly animation
  flyingCard: FlyingCardState | null;
  onFlyComplete: () => void;
  isAnimatingCell: (row: number, col: number) => boolean;
  // Capture cascade animation
  activeCaptureEntry: CaptureAnimationEntry | null;
  captureActiveIndex: number;
  onCaptureAnimComplete: () => void;
  isCaptureAnimatingCell: (row: number, col: number) => boolean;
  getPendingCaptureOwner: (row: number, col: number) => 'blue' | 'red' | undefined;
}

function SceneContent(props: SwampSceneProps) {
  const {
    board, validPlacements, onCellClick,
    myHand, opponentHand, myPlayer, selectedCardIndex, isMyTurn, isFinished,
    onCardClick, flyingCard, onFlyComplete, isAnimatingCell,
    activeCaptureEntry, captureActiveIndex, onCaptureAnimComplete,
    isCaptureAnimatingCell, getPendingCaptureOwner,
  } = props;

  const opponentPlayer: Player = myPlayer === 'player1' ? 'player2' : 'player1';

  // Compute flying card world positions
  let flyFrom: { position: Vector3; rotation: Euler } | null = null;
  let flyTo: { position: Vector3; rotation: Euler } | null = null;

  if (flyingCard) {
    const handPos = flyingCard.isOpponent ? OPPONENT_HAND_POS : PLAYER_HAND_POS;
    const handRot = flyingCard.isOpponent ? OPPONENT_HAND_ROT : PLAYER_HAND_ROT;
    const totalCards = flyingCard.isOpponent ? opponentHand.length + 1 : myHand.length + 1;

    flyFrom = getHandCardWorldPosition(
      handPos, handRot, flyingCard.fromHandIndex, totalCards, flyingCard.isOpponent,
    );

    const cellX = (flyingCard.toCol - 1) * 0.66;
    const cellZ = (flyingCard.toRow - 1) * 0.66;
    flyTo = {
      position: new Vector3(cellX, 0.678, cellZ),
      rotation: new Euler(-Math.PI / 2, 0, 0),
    };
  }

  return (
    <>
      <CameraController />

      {/* Lighting */}
      <ambientLight color="#2a4a2a" intensity={0.5} />
      <directionalLight
        color="#ffeedd"
        intensity={1.5}
        position={[2, 5, 3]}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-4}
        shadow-camera-right={4}
        shadow-camera-top={4}
        shadow-camera-bottom={-4}
      />
      <pointLight color="#44aa66" intensity={0.6} position={[-2, 2, -1]} distance={6} />
      <pointLight color="#4466aa" intensity={0.4} position={[2, 2, 1]} distance={6} />

      <fog attach="fog" args={['#0a1a0a', 4, 12]} />

      {/* Game board */}
      <GameBoard
        board={board}
        myPlayer={myPlayer}
        validPlacements={validPlacements}
        onCellClick={onCellClick}
        isAnimatingCell={isAnimatingCell}
        isCaptureAnimatingCell={isCaptureAnimatingCell}
        getPendingCaptureOwner={getPendingCaptureOwner}
      />

      {/* Player hand (near camera, bottom of viewport) */}
      <PlayerHand3D
        cards={myHand}
        owner={myPlayer}
        selectedIndex={selectedCardIndex}
        isMyTurn={isMyTurn}
        onCardClick={onCardClick}
        flyingCardIndex={flyingCard && !flyingCard.isOpponent ? flyingCard.fromHandIndex : null}
      />

      {/* Opponent hand (far side, top of viewport) */}
      <OpponentHand3D
        cards={opponentHand}
        owner={opponentPlayer}
        flyingCardIndex={flyingCard?.isOpponent ? flyingCard.fromHandIndex : null}
        isFinished={isFinished}
      />

      {/* Flying card animation */}
      {flyingCard && flyFrom && flyTo && (
        <FlyingCard
          key={`fly-${flyingCard.toRow}-${flyingCard.toCol}-${flyingCard.isOpponent}`}
          card={flyingCard.card}
          owner={flyingCard.owner}
          fromPosition={flyFrom.position}
          fromRotation={flyFrom.rotation}
          toPosition={flyTo.position}
          toRotation={flyTo.rotation}
          faceDown={flyingCard.faceDown}
          onComplete={onFlyComplete}
        />
      )}

      {/* Capture flip animation */}
      {activeCaptureEntry && (
        <CaptureFlipCard
          key={`capture-${captureActiveIndex}`}
          card={activeCaptureEntry.card}
          cellPosition={[
            (activeCaptureEntry.col - 1) * 0.66,
            0.648,
            (activeCaptureEntry.row - 1) * 0.66,
          ]}
          row={activeCaptureEntry.row}
          col={activeCaptureEntry.col}
          oldOwner={activeCaptureEntry.oldOwner}
          newOwner={activeCaptureEntry.newOwner}
          onComplete={onCaptureAnimComplete}
        />
      )}

      {/* Spark burst for capture */}
      {activeCaptureEntry && (
        <SparkBurst
          key={`spark-${captureActiveIndex}`}
          position={[
            (activeCaptureEntry.col - 1) * 0.66,
            0.68,
            (activeCaptureEntry.row - 1) * 0.66,
          ]}
          color={activeCaptureEntry.newOwner === 'blue' ? '#4488ff' : '#ff4422'}
        />
      )}

      {/* Ground island + vegetation */}
      <SwampFloor />

      <Suspense fallback={null}>
        <WaterSurface />
      </Suspense>

      <SwampEnvironment />
      <PropLayout />
      <Particles />

      <EffectComposer>
        <Bloom luminanceThreshold={0.6} luminanceSmoothing={0.5} intensity={0.5} />
        <Vignette darkness={0.5} offset={0.3} />
      </EffectComposer>
    </>
  );
}

export function SwampScene(props: SwampSceneProps) {
  return (
    <Canvas
      shadows
      gl={{
        antialias: true,
        toneMapping: ACESFilmicToneMapping,
        toneMappingExposure: 1.0,
      }}
      camera={{ position: [0, 3.8, 3.0], fov: 50, near: 0.01, far: 50 }}
      style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}
      onPointerMissed={props.onDeselect}
    >
      <Suspense fallback={null}>
        <SceneContent {...props} />
      </Suspense>
    </Canvas>
  );
}
