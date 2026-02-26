import { useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import type { Mesh } from 'three';
import type { Board } from '../types';
import { Card } from '../components/Card';

interface BoardCell3DProps {
  row: number;
  col: number;
  position: [number, number, number];
  cellSize: number;
  cell: Board[number][number];
  isValid: boolean;
  isCaptured: boolean;
  onCellClick?: (row: number, col: number) => void;
}

export function BoardCell3D({
  row,
  col,
  position,
  cellSize,
  cell,
  isValid,
  isCaptured,
  onCellClick,
}: BoardCell3DProps) {
  const meshRef = useRef<Mesh>(null!);
  const [hovered, setHovered] = useState(false);
  const captureFlashRef = useRef(0);

  useFrame((_, delta) => {
    if (!meshRef.current) return;
    const mat = meshRef.current.material as any;

    if (isCaptured) {
      captureFlashRef.current = 1;
    }
    if (captureFlashRef.current > 0) {
      captureFlashRef.current = Math.max(0, captureFlashRef.current - delta * 2);
      mat.emissive?.set(0xff2200);
      mat.emissiveIntensity = captureFlashRef.current * 0.8;
    } else if (isValid) {
      const pulse = Math.sin(Date.now() * 0.003) * 0.15 + 0.35;
      mat.emissive?.set(0x00ff44);
      mat.emissiveIntensity = hovered ? 0.6 : pulse;
    } else {
      mat.emissive?.set(0x000000);
      mat.emissiveIntensity = 0;
    }
  });

  return (
    <group position={position}>
      {/* Click/hover target plane */}
      <mesh
        ref={meshRef as any}
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

      {/* Card overlay using Html */}
      {cell.card && (
        <Html
          center
          transform
          distanceFactor={1.2}
          position={[0, 0.03, 0]}
          rotation={[-Math.PI / 2.5, 0, 0]}
          style={{ pointerEvents: 'none' }}
        >
          <div style={{ transform: 'scale(0.28)', pointerEvents: 'none' }}>
            <Card
              card={cell.card}
              owner={cell.owner}
              captured={isCaptured}
              size="large"
            />
          </div>
        </Html>
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
