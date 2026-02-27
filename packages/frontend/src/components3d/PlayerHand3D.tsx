import { useRef, useState, useCallback, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { Quaternion, Vector3 } from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { Card, Player } from '../types';
import { Card3D } from './Card3D';
import {
  getCardFanTransform,
  PLAYER_HAND_POS,
  PLAYER_HAND_ROT,
  HAND_CARD_WIDTH,
  HAND_CARD_HEIGHT,
  FAN_ANGLE_SPAN,
  FAN_RADIUS,
} from './utils/cardPositions';

interface PlayerHand3DProps {
  cards: Card[];
  owner: Player;
  selectedIndex: number | null;
  isMyTurn: boolean;
  onCardClick: (index: number) => void;
  flyingCardIndex?: number | null;
}

const LERP_SPEED = 10;

// Reusable objects to avoid per-frame allocation
const _parentQuat = new Quaternion();
const _localQuat = new Quaternion();
const _targetWorldQuat = new Quaternion();
const _fanZQuat = new Quaternion();
const _zAxis = new Vector3(0, 0, 1);

/**
 * Compute the X positions of each card in the fan for hit-testing.
 */
function getCardXPositions(total: number): number[] {
  const positions: number[] = [];
  for (let i = 0; i < total; i++) {
    const centerOffset = (total - 1) / 2;
    const t = total <= 1 ? 0 : (i - centerOffset) / (total - 1);
    const angle = t * FAN_ANGLE_SPAN;
    positions.push(Math.sin(angle) * FAN_RADIUS);
  }
  return positions;
}

/**
 * Given a pointer X in local hand space, find the nearest card index.
 * Uses midpoints between adjacent cards as boundaries (Hearthstone-style strips).
 */
function hitTestCardIndex(localX: number, cardXPositions: number[]): number | null {
  const n = cardXPositions.length;
  if (n === 0) return null;
  if (n === 1) return 0;

  // Build boundaries: midpoints between adjacent cards
  for (let i = 0; i < n - 1; i++) {
    const mid = (cardXPositions[i] + cardXPositions[i + 1]) / 2;
    if (localX < mid) return i;
  }
  return n - 1;
}

export function PlayerHand3D({
  cards,
  owner,
  selectedIndex,
  isMyTurn,
  onCardClick,
  flyingCardIndex,
}: PlayerHand3DProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  // Use `any` to avoid dual @types/three version conflicts
  const cardGroupRefs = useRef<(any)[]>([]);

  // Precompute card X positions for hit testing
  const cardXPositions = useMemo(() => getCardXPositions(cards.length), [cards.length]);

  // Ensure refs array matches card count
  if (cardGroupRefs.current.length !== cards.length) {
    cardGroupRefs.current = cards.map((_, i) => cardGroupRefs.current[i] ?? null);
  }

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05); // Clamp for tab-away
    const camera = state.camera;

    for (let i = 0; i < cards.length; i++) {
      const ref = cardGroupRefs.current[i];
      if (!ref) continue;

      const target = getCardFanTransform(i, cards.length, selectedIndex, hoveredIndex);
      const isActiveCard = hoveredIndex === i || selectedIndex === i;

      // Lerp position
      ref.position.x += (target.position[0] - ref.position.x) * dt * LERP_SPEED;
      ref.position.y += (target.position[1] - ref.position.y) * dt * LERP_SPEED;
      ref.position.z += (target.position[2] - ref.position.z) * dt * LERP_SPEED;

      // All cards face the camera (parallel to screen)
      // Non-hovered cards get fan Z-rotation in screen space; hovered/selected are straight
      _targetWorldQuat.copy(camera.quaternion);
      if (!isActiveCard) {
        _fanZQuat.setFromAxisAngle(_zAxis, target.rotation[2]);
        _targetWorldQuat.multiply(_fanZQuat);
      }
      ref.parent.getWorldQuaternion(_parentQuat);
      _localQuat.copy(_parentQuat).invert().multiply(_targetWorldQuat);
      ref.quaternion.slerp(_localQuat, dt * LERP_SPEED);

      // Lerp scale
      const s = ref.scale.x + (target.scale - ref.scale.x) * dt * LERP_SPEED;
      ref.scale.set(s, s, s);
    }
  });

  // ── Hit plane handlers (Hearthstone-style horizontal strips) ──

  const handleHitMove = useCallback((e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    if (cards.length === 0) return;
    const localX = e.point.x - PLAYER_HAND_POS.x;
    // Account for the parent group's position — e.point is in world space,
    // but card X positions are in the hand group's local space.
    // The hand group only rotates around X, so world X ≈ local X.
    const idx = hitTestCardIndex(localX, cardXPositions);
    if (idx !== null && idx !== flyingCardIndex) {
      setHoveredIndex(idx);
      if (isMyTurn) document.body.style.cursor = 'pointer';
    }
  }, [cards.length, cardXPositions, flyingCardIndex, isMyTurn]);

  const handleHitLeave = useCallback(() => {
    setHoveredIndex(null);
    document.body.style.cursor = 'default';
  }, []);

  const handleHitClick = useCallback((e: ThreeEvent<MouseEvent>) => {
    if (!isMyTurn || cards.length === 0) return;
    e.stopPropagation();
    const localX = e.point.x - PLAYER_HAND_POS.x;
    const idx = hitTestCardIndex(localX, cardXPositions);
    if (idx !== null && idx !== flyingCardIndex) {
      onCardClick(idx);
    }
  }, [cards.length, cardXPositions, flyingCardIndex, isMyTurn, onCardClick]);

  // Compute hit plane width: span all card positions plus padding
  const hitPlaneWidth = useMemo(() => {
    if (cardXPositions.length <= 1) return HAND_CARD_WIDTH * 2;
    const minX = cardXPositions[0];
    const maxX = cardXPositions[cardXPositions.length - 1];
    return (maxX - minX) + HAND_CARD_WIDTH * 2; // pad each side by one card width
  }, [cardXPositions]);

  return (
    <group
      position={[PLAYER_HAND_POS.x, PLAYER_HAND_POS.y, PLAYER_HAND_POS.z]}
      rotation={[PLAYER_HAND_ROT.x, PLAYER_HAND_ROT.y, PLAYER_HAND_ROT.z]}
    >
      {/* Card visuals */}
      {cards.map((card, i) => {
        if (i === flyingCardIndex) return null;

        const initial = getCardFanTransform(i, cards.length, selectedIndex, hoveredIndex);

        const isActive = selectedIndex === i || hoveredIndex === i;
        const glowColor = selectedIndex === i ? '#ffcc00' : hoveredIndex === i ? '#44ff66' : null;
        const ro = isActive ? 50 + i : 10 + i;

        return (
          <group
            key={card.id}
            ref={(el) => { cardGroupRefs.current[i] = el; }}
            position={initial.position}
            rotation={initial.rotation}
            scale={[initial.scale, initial.scale, initial.scale]}
          >
            <Card3D
              card={card}
              width={HAND_CARD_WIDTH}
              renderOrder={ro}
              depthWrite={false}
              glowColor={glowColor ?? undefined}
            />
          </group>
        );
      })}

      {/* Single invisible hit plane for Hearthstone-style hover detection */}
      <mesh
        position={[0, 0, 0.1]}
        onPointerMove={handleHitMove}
        onPointerLeave={handleHitLeave}
        onClick={handleHitClick}
      >
        <planeGeometry args={[hitPlaneWidth, HAND_CARD_HEIGHT * 1.5]} />
        <meshBasicMaterial visible={false} />
      </mesh>
    </group>
  );
}
