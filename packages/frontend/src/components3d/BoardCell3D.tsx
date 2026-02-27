import { useState } from 'react';
import type { Board, Player } from '../types';
import { Card3D } from './Card3D';
import { BOARD_CARD_WIDTH } from './utils/cardPositions';

interface BoardCell3DProps {
  row: number;
  col: number;
  position: [number, number, number];
  cellSize: number;
  cell: Board[number][number];
  myPlayer: Player;
  isValid: boolean;
  isAnimating?: boolean;
  pendingCaptureOwner?: 'blue' | 'red';
  onCellClick?: (row: number, col: number) => void;
}

export function BoardCell3D({
  row,
  col,
  position,
  cellSize,
  cell,
  myPlayer,
  isValid,
  isAnimating = false,
  pendingCaptureOwner,
  onCellClick,
}: BoardCell3DProps) {
  const [hovered, setHovered] = useState(false);

  // Determine board card color: pendingCaptureOwner overrides with old color during cascade
  const boardOwner = pendingCaptureOwner
    ?? (cell.owner ? (cell.owner === myPlayer ? 'blue' : 'red') : undefined);

  const pulse = isValid ? 0.35 : 0;

  return (
    <group position={position}>
      {/* Click/hover target plane */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        onClick={(e) => {
          e.stopPropagation();
          if (isValid && onCellClick) onCellClick(row, col);
        }}
        onPointerEnter={(e) => {
          e.stopPropagation();
          setHovered(true);
          if (isValid) document.body.style.cursor = 'pointer';
        }}
        onPointerLeave={() => {
          setHovered(false);
          document.body.style.cursor = 'default';
        }}
      >
        <planeGeometry args={[cellSize * 0.92, cellSize * 0.92]} />
        <meshStandardMaterial
          color={isValid ? '#1a3a2a' : '#1a2a1a'}
          transparent
          opacity={isValid ? 0.5 : 0.2}
          roughness={0.9}
          emissive={isValid ? '#00ff44' : '#000000'}
          emissiveIntensity={isValid ? (hovered ? 0.6 : pulse) : 0}
        />
      </mesh>

      {/* Grid border */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.001, 0]}>
        <planeGeometry args={[cellSize * 0.98, cellSize * 0.98]} />
        <meshStandardMaterial
          color="#3a5a3a"
          transparent
          opacity={0.3}
          wireframe
        />
      </mesh>

      {/* 3D Card on board */}
      {cell.card && !isAnimating && boardOwner && (
        <group position={[0, 0.03 + row * 0.001, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <Card3D
            card={cell.card}
            boardOwner={boardOwner as 'blue' | 'red'}
            width={BOARD_CARD_WIDTH}
            renderOrder={row * 3 + col + 1}
            depthWrite={false}
          />
        </group>
      )}

      {/* Valid placement indicator dot */}
      {isValid && !cell.card && (
        <mesh position={[0, 0.02, 0]}>
          <sphereGeometry args={[0.03, 8, 8]} />
          <meshStandardMaterial
            color="#44ff66"
            emissive="#44ff66"
            emissiveIntensity={0.5}
            transparent
            opacity={0.7}
          />
        </mesh>
      )}
    </group>
  );
}
