import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Vector3, Euler, Quaternion } from 'three';
import type { Card, Player } from '../types';
import { Card3D } from './Card3D';
import { HAND_CARD_WIDTH, BOARD_CARD_WIDTH } from './utils/cardPositions';

interface FlyingCardProps {
  card: Card;
  owner: Player;
  fromPosition: Vector3;
  fromRotation: Euler;
  toPosition: Vector3;
  toRotation: Euler;
  duration?: number;
  onComplete: () => void;
  faceDown?: boolean;
}

const ARC_HEIGHT = 1.2;

export function FlyingCard({
  card,
  owner,
  fromPosition,
  fromRotation,
  toPosition,
  toRotation,
  duration = 0.6,
  onComplete,
  faceDown = false,
}: FlyingCardProps) {
  const groupRef = useRef<any>(null!);
  const progressRef = useRef(0);
  const completedRef = useRef(false);

  // Precompute quaternions
  const qFrom = useRef(new Quaternion().setFromEuler(fromRotation)).current;
  const qTo = useRef(new Quaternion().setFromEuler(toRotation)).current;

  useFrame((_, delta) => {
    if (completedRef.current || !groupRef.current) return;

    progressRef.current = Math.min(1, progressRef.current + delta / duration);
    const t = progressRef.current;

    // Ease-in-out
    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

    // Position: lerp XZ, parabolic arc Y
    const x = fromPosition.x + (toPosition.x - fromPosition.x) * eased;
    const z = fromPosition.z + (toPosition.z - fromPosition.z) * eased;
    const baseY = fromPosition.y + (toPosition.y - fromPosition.y) * eased;
    const arcY = 4 * ARC_HEIGHT * t * (1 - t);
    groupRef.current.position.set(x, baseY + arcY, z);

    // Rotation: slerp
    const qCurrent = new Quaternion().slerpQuaternions(qFrom, qTo, eased);

    // Opponent cards flip mid-flight (Y rotation PI → 0)
    if (faceDown) {
      const flipAngle = Math.PI * (1 - eased);
      const qFlip = new Quaternion().setFromEuler(new Euler(0, flipAngle, 0));
      qCurrent.multiply(qFlip);
    }

    groupRef.current.quaternion.copy(qCurrent);

    // Scale: subtle grow at peak
    const widthLerp = HAND_CARD_WIDTH + (BOARD_CARD_WIDTH - HAND_CARD_WIDTH) * eased;
    const scaleBoost = 1 + 0.15 * Math.sin(t * Math.PI);
    const s = (widthLerp / HAND_CARD_WIDTH) * scaleBoost;
    groupRef.current.scale.setScalar(s);

    if (t >= 1 && !completedRef.current) {
      completedRef.current = true;
      onComplete();
    }
  });

  return (
    <group ref={groupRef} position={fromPosition.toArray() as [number, number, number]}>
      <Card3D
        card={card}
        faceDown={faceDown && progressRef.current < 0.5}
        width={HAND_CARD_WIDTH}
        renderOrder={20}
      />
    </group>
  );
}
