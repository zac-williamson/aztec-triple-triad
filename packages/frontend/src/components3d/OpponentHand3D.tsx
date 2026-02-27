import type { Card, Player } from '../types';
import { Card3D } from './Card3D';
import {
  getCardFanTransform,
  OPPONENT_HAND_POS,
  OPPONENT_HAND_ROT,
  HAND_CARD_WIDTH,
} from './utils/cardPositions';

interface OpponentHand3DProps {
  cards: Card[];
  owner: Player;
  flyingCardIndex?: number | null;
  isFinished?: boolean;
}

export function OpponentHand3D({
  cards,
  owner,
  flyingCardIndex,
  isFinished = false,
}: OpponentHand3DProps) {
  return (
    <group
      position={[OPPONENT_HAND_POS.x, OPPONENT_HAND_POS.y, OPPONENT_HAND_POS.z]}
      rotation={[OPPONENT_HAND_ROT.x, OPPONENT_HAND_ROT.y, OPPONENT_HAND_ROT.z]}
    >
      {cards.map((card, i) => {
        if (i === flyingCardIndex) return null;

        const { position, rotation } = getCardFanTransform(i, cards.length, null, null, true);

        return (
          <group key={i} position={position} rotation={rotation}>
            <Card3D
              card={card}
              faceDown={!isFinished}
              width={HAND_CARD_WIDTH}
              renderOrder={5 + i}
              depthWrite={false}
            />
          </group>
        );
      })}
    </group>
  );
}
