import { Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { ACESFilmicToneMapping } from 'three';
import { EffectComposer, Bloom, Vignette } from '@react-three/postprocessing';
import type { Board } from '../types';
import { GameBoard } from './GameBoard';
import { WaterSurface } from './WaterSurface';
import { SwampEnvironment } from './SwampEnvironment';
import { PropLayout } from './PropLayout';
import { Particles } from './Particles';
import { CameraController } from './CameraController';

interface SwampSceneProps {
  board: Board;
  validPlacements: { row: number; col: number }[];
  capturedCells: { row: number; col: number }[];
  onCellClick?: (row: number, col: number) => void;
}

function SceneContent({ board, validPlacements, capturedCells, onCellClick }: SwampSceneProps) {
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
      {/* Green accent light - left */}
      <pointLight color="#44aa66" intensity={0.6} position={[-2, 2, -1]} distance={6} />
      {/* Blue accent light - right */}
      <pointLight color="#4466aa" intensity={0.4} position={[2, 2, 1]} distance={6} />

      {/* Fog - closer for smaller scene */}
      <fog attach="fog" args={['#0a1a0a', 4, 12]} />

      {/* Game board */}
      <GameBoard
        board={board}
        validPlacements={validPlacements}
        capturedCells={capturedCells}
        onCellClick={onCellClick}
      />

      {/* Water */}
      <Suspense fallback={null}>
        <WaterSurface />
      </Suspense>

      {/* Environment */}
      <SwampEnvironment />

      {/* Interactive props */}
      <PropLayout />

      {/* Particles */}
      <Particles />

      {/* Post-processing */}
      <EffectComposer>
        <Bloom
          luminanceThreshold={0.6}
          luminanceSmoothing={0.5}
          intensity={0.5}
        />
        <Vignette darkness={0.5} offset={0.3} />
      </EffectComposer>
    </>
  );
}

export function SwampScene({ board, validPlacements, capturedCells, onCellClick }: SwampSceneProps) {
  return (
    <Canvas
      shadows
      gl={{
        antialias: true,
        toneMapping: ACESFilmicToneMapping,
        toneMappingExposure: 1.0,
      }}
      camera={{ position: [0, 2.2, 1.8], fov: 50, near: 0.01, far: 50 }}
      style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}
    >
      <Suspense fallback={null}>
        <SceneContent
          board={board}
          validPlacements={validPlacements}
          capturedCells={capturedCells}
          onCellClick={onCellClick}
        />
      </Suspense>
    </Canvas>
  );
}
