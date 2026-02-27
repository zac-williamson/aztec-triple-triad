import { Vector3, Euler } from 'three';

// ── Fan layout constants ──
export const FAN_RADIUS = 1.8;
export const FAN_ANGLE_SPAN = 0.35; // radians (~20°)
export const CARD_TILT = -0.25; // forward tilt toward camera

// ── Hand positions (world space) ──
// Pushed low so default (small) cards are partially off-screen at the bottom
export const PLAYER_HAND_POS = new Vector3(0, 1.4, 2.4);
export const PLAYER_HAND_ROT = new Euler(-0.3, 0, 0);

export const OPPONENT_HAND_POS = new Vector3(0, 1.0, -1.8);
export const OPPONENT_HAND_ROT = new Euler(-0.3, Math.PI, 0);

// ── Card dimensions ──
export const CARD_ASPECT = 1387 / 978; // ~1.418
export const HAND_CARD_WIDTH = 0.38 * 1.75 * 0.7;  // 0.4655
export const HAND_CARD_HEIGHT = HAND_CARD_WIDTH * CARD_ASPECT;
export const BOARD_CARD_WIDTH = 0.58; // fits within 0.66 cell spacing
export const BOARD_CARD_HEIGHT = BOARD_CARD_WIDTH; // board cards are square (1:1)

// ── Scale constants ──
export const CARD_DEFAULT_SCALE = 0.5;   // small by default
export const CARD_HOVER_SCALE = 1.0;     // full size on hover
export const CARD_SELECTED_SCALE = 1.0;  // full size when selected

/**
 * Compute the local position, rotation, and scale of a card within a fan layout.
 * Hovered/selected cards pop up large and upright; default cards are small and fanned.
 */
export function getCardFanTransform(
  index: number,
  total: number,
  selectedIndex: number | null,
  hoveredIndex: number | null = null,
  invertArc: boolean = false,
): { position: [number, number, number]; rotation: [number, number, number]; scale: number } {
  const centerOffset = (total - 1) / 2;
  const t = total <= 1 ? 0 : (index - centerOffset) / (total - 1); // -0.5 to 0.5

  const angle = t * FAN_ANGLE_SPAN;
  const x = Math.sin(angle) * FAN_RADIUS;
  // Arc: center card highest (t=0 → max), edge cards dip down (t=±0.5 → 0)
  // invertArc: for opponent view, center card lowest, edges highest
  const ARC_HEIGHT = 0.2;
  const arcY = ARC_HEIGHT * (1 - 4 * t * t);
  const y = invertArc ? -arcY : arcY;
  const z = -Math.abs(t) * 0.05; // slight forward stagger for center cards

  const isSelected = selectedIndex === index;
  const isHovered = hoveredIndex === index;

  if (isHovered || isSelected) {
    // Pop up large — keep same X tilt as default cards, just remove fan Z-angle
    return {
      position: [x, 0.85, z + 0.15],
      rotation: [CARD_TILT, 0, 0],
      scale: isSelected ? CARD_SELECTED_SCALE : CARD_HOVER_SCALE,
    };
  }

  return {
    position: [x, y, z],
    rotation: [CARD_TILT, 0, -angle],
    scale: CARD_DEFAULT_SCALE,
  };
}

/**
 * Convert a fan-local card position to world space given the hand group transform.
 */
export function getHandCardWorldPosition(
  handCenter: Vector3,
  handRotation: Euler,
  cardIndex: number,
  totalCards: number,
  isOpponent: boolean,
): { position: Vector3; rotation: Euler } {
  const fan = getCardFanTransform(cardIndex, totalCards, null);

  // Apply hand group rotation to the local position
  const localPos = new Vector3(...fan.position);

  // Create a rotation matrix from the hand group euler
  localPos.applyEuler(handRotation);
  localPos.add(handCenter);

  const worldRotation = new Euler(
    handRotation.x + fan.rotation[0],
    handRotation.y + fan.rotation[1],
    handRotation.z + fan.rotation[2],
  );

  return { position: localPos, rotation: worldRotation };
}
