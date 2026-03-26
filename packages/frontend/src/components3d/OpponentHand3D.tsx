import { useRef, useState, useCallback, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import type { ThreeEvent } from '@react-three/fiber';
import { DoubleSide } from 'three';
import type { Card, Player } from '../types';
import { Card3D } from './Card3D';
import {
  getCardFanTransform,
  OPPONENT_HAND_POS,
  OPPONENT_HAND_ROT,
  HAND_CARD_WIDTH,
  HAND_CARD_HEIGHT,
  CARD_DEFAULT_SCALE,
  CARD_HOVER_SCALE,
  FAN_ANGLE_SPAN,
  FAN_RADIUS,
} from './utils/cardPositions';

interface OpponentHand3DProps {
  cards: Card[];
  owner: Player;
  flyingCardIndex?: number | null;
  isFinished?: boolean;
  /** Tutorial: how many cards to show face-up (from index 0). Undefined = use default logic. */
  revealCount?: number;
}

// Opponent cards are 50% larger than player cards
const OPP_DEFAULT_SCALE = CARD_DEFAULT_SCALE * 1.5;
const OPP_HOVER_SCALE = CARD_HOVER_SCALE * 1.5;

const LERP_SPEED = 10;

function getCardXPositions(total: number): number[] {
  const positions: number[] = [];
  for (let i = 0; i < total; i++) {
    const centerOffset = (total - 1) / 2;
    const t = total <= 1 ? 0 : (i - centerOffset) / (total - 1);
    positions.push(Math.sin(t * FAN_ANGLE_SPAN) * FAN_RADIUS);
  }
  return positions;
}

function hitTestCardIndex(localX: number, cardXPositions: number[]): number | null {
  const n = cardXPositions.length;
  if (n === 0) return null;
  if (n === 1) return 0;
  for (let i = 0; i < n - 1; i++) {
    const mid = (cardXPositions[i] + cardXPositions[i + 1]) / 2;
    if (localX < mid) return i;
  }
  return n - 1;
}

export function OpponentHand3D({
  cards,
  owner,
  flyingCardIndex,
  isFinished = false,
  revealCount,
}: OpponentHand3DProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const cardGroupRefs = useRef<(any)[]>([]);

  const cardXPositions = useMemo(() => getCardXPositions(cards.length), [cards.length]);

  if (cardGroupRefs.current.length !== cards.length) {
    cardGroupRefs.current = cards.map((_, i) => cardGroupRefs.current[i] ?? null);
  }

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.05);
    for (let i = 0; i < cards.length; i++) {
      const ref = cardGroupRefs.current[i];
      if (!ref) continue;
      const targetScale = hoveredIndex === i ? OPP_HOVER_SCALE : OPP_DEFAULT_SCALE;
      const s = ref.scale.x + (targetScale - ref.scale.x) * dt * LERP_SPEED;
      ref.scale.set(s, s, s);
    }
  });

  // The opponent group has Math.PI Y rotation, which negates local X relative to world X.
  // So local X = -(world X - group center X).
  const handleHitMove = useCallback((e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    if (cards.length === 0) return;
    const localX = -(e.point.x - OPPONENT_HAND_POS.x);
    const idx = hitTestCardIndex(localX, cardXPositions);
    if (idx !== null && idx !== flyingCardIndex) {
      setHoveredIndex(idx);
    }
  }, [cards.length, cardXPositions, flyingCardIndex]);

  const handleHitLeave = useCallback(() => {
    setHoveredIndex(null);
  }, []);

  const hitPlaneWidth = useMemo(() => {
    if (cardXPositions.length <= 1) return HAND_CARD_WIDTH * 2;
    const minX = cardXPositions[0];
    const maxX = cardXPositions[cardXPositions.length - 1];
    return (maxX - minX) + HAND_CARD_WIDTH * 2;
  }, [cardXPositions]);

  return (
    <group
      position={[OPPONENT_HAND_POS.x, OPPONENT_HAND_POS.y, OPPONENT_HAND_POS.z]}
      rotation={[OPPONENT_HAND_ROT.x, OPPONENT_HAND_ROT.y, OPPONENT_HAND_ROT.z]}
    >
      {cards.map((card, i) => {
        if (i === flyingCardIndex) return null;

        // invertArc=true gives the correct card positions; negate Z rotation to correct
        // for the Math.PI Y rotation on the parent group which mirrors the local X axis.
        const { position, rotation } = getCardFanTransform(i, cards.length, null, null, true);
        const correctedRotation: [number, number, number] = [rotation[0], rotation[1], -rotation[2]];
        const isHovered = hoveredIndex === i;
        const ro = isHovered ? 50 + i : 5 + (cards.length - 1 - i);

        return (
          <group
            key={i}
            ref={(el) => { cardGroupRefs.current[i] = el; }}
            position={position}
            rotation={correctedRotation}
            scale={[OPP_DEFAULT_SCALE, OPP_DEFAULT_SCALE, OPP_DEFAULT_SCALE]}
          >
            {/* scale-x=-1 cancels the horizontal mirror caused by the Math.PI Y rotation on the parent group */}
            <group scale={[-1, 1, 1]}>
              <Card3D
                card={card}
                faceDown={revealCount !== undefined ? i >= revealCount : (card.id === 0 && !isFinished)}
                width={HAND_CARD_WIDTH}
                renderOrder={ro}
                depthWrite={false}
                depthTest={false}
              />
            </group>
          </group>
        );
      })}

      {/* Single invisible hit plane — same Hearthstone-style approach as PlayerHand3D.
          Avoids magnified cards blocking hover detection for cards behind them. */}
      {/* z=-0.2 in local space: after Math.PI Y rotation local+Z maps to world-Z,
          so -0.2 local puts the plane in front of (closer to camera than) the cards.
          DoubleSide is required because the Math.PI Y rotation flips the plane's
          normal away from the camera, causing FrontSide-only raycasts to miss it. */}
      <mesh
        position={[0, 0, -0.2]}
        onPointerMove={handleHitMove}
        onPointerLeave={handleHitLeave}
      >
        <planeGeometry args={[hitPlaneWidth, HAND_CARD_HEIGHT * 1.5]} />
        <meshBasicMaterial visible={false} side={DoubleSide} depthTest={false} />
      </mesh>
    </group>
  );
}
