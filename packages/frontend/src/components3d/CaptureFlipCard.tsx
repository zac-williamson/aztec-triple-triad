import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { Card } from '../types';
import { Card3D } from './Card3D';
import { BOARD_CARD_WIDTH } from './utils/cardPositions';

interface CaptureFlipCardProps {
  card: Card;
  cellPosition: [number, number, number];
  row: number;
  col: number;
  oldOwner: 'blue' | 'red';
  newOwner: 'blue' | 'red';
  duration?: number;
  onComplete: () => void;
}

const JUMP_HEIGHT = 0.35;

export function CaptureFlipCard({
  card,
  cellPosition,
  row,
  col,
  oldOwner,
  newOwner,
  duration = 0.5,
  onComplete,
}: CaptureFlipCardProps) {
  const groupRef = useRef<any>(null!);
  const progressRef = useRef(0);
  const completedRef = useRef(false);
  const ownerRef = useRef<'blue' | 'red'>(oldOwner);

  useFrame((_, delta) => {
    if (completedRef.current || !groupRef.current) return;

    progressRef.current = Math.min(1, progressRef.current + delta / duration);
    const t = progressRef.current;
    // Ease-in-out cubic (same as FlyingCard)
    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

    // Jump arc (parabolic)
    const jumpY = 4 * JUMP_HEIGHT * eased * (1 - eased);
    groupRef.current.position.y = 0.03 + row * 0.001 + jumpY;

    // 360° flip around local X axis
    groupRef.current.rotation.x = eased * Math.PI * 2;

    // Scale pulse
    const s = 1 + 0.12 * Math.sin(eased * Math.PI);
    groupRef.current.scale.setScalar(s);

    // Swap color at midpoint
    ownerRef.current = eased < 0.5 ? oldOwner : newOwner;

    if (t >= 1 && !completedRef.current) {
      completedRef.current = true;
      onComplete();
    }
  });

  return (
    <group position={cellPosition}>
      <group
        ref={groupRef}
        position={[0, 0.03 + row * 0.001, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
      >
        <Card3D
          card={card}
          boardOwner={ownerRef.current}
          width={BOARD_CARD_WIDTH}
          renderOrder={100 + row * 3 + col}
          depthWrite={false}
        />
      </group>
    </group>
  );
}
