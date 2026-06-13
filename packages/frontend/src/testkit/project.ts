/**
 * World→viewport projection for canvas click targets.
 *
 * Targets are resolved from the LIVE scene graph (meshes named by
 * BoardCell3D / PlayerHand3D) and projected through the LIVE camera at call
 * time, so the computed pixel follows whatever the camera and layout actually
 * are — the same path a human's eye-hand loop uses. The camera's idle drift
 * (±0.03m over ~60s) is irrelevant at click latency.
 */
import { Vector3 } from 'three';
import { getCardFanTransform } from '../components3d/utils/cardPositions';
import { registry } from './registry';
import { CELL_NAME, HAND_PLANE_NAME } from './names';
import type { ClickTarget } from './contract';

export type { ClickTarget };

/**
 * Viewport pixel coordinates (CSS px, relative to the page viewport) for a
 * click target. Throws with a precise reason when the target cannot be
 * resolved — the harness treats that as a real failure, not a retry signal.
 */
/** Margin (px) a click point must keep from the canvas edges. */
const EDGE_MARGIN_PX = 12;

export function getScreenXY(target: ClickTarget): { x: number; y: number } {
  const sceneState = registry.scene;
  if (!sceneState) throw new Error('testkit: no scene bridge published (is the game screen mounted?)');
  const { camera, scene, size, canvas } = sceneState;
  camera.updateMatrixWorld();
  const rect = canvas.getBoundingClientRect();

  const toPixels = (world: Vector3): { x: number; y: number; visible: boolean } => {
    const ndc = world.clone().project(camera);
    const x = rect.left + ((ndc.x + 1) / 2) * size.width;
    const y = rect.top + ((1 - ndc.y) / 2) * size.height;
    const visible = ndc.z <= 1
      && x >= rect.left + EDGE_MARGIN_PX && x <= rect.right - EDGE_MARGIN_PX
      && y >= rect.top + EDGE_MARGIN_PX && y <= rect.bottom - EDGE_MARGIN_PX;
    return { x, y, visible };
  };

  if (target.type === 'cell') {
    const mesh = scene.getObjectByName(CELL_NAME(target.row, target.col));
    if (!mesh) throw new Error(`testkit: cell mesh ${CELL_NAME(target.row, target.col)} not found in scene`);
    const px = toPixels(mesh.getWorldPosition(new Vector3()));
    if (!px.visible) {
      throw new Error(`testkit: cell [${target.row},${target.col}] projects off-screen at (${px.x.toFixed(0)},${px.y.toFixed(0)})`);
    }
    return { x: px.x, y: px.y };
  }

  const plane = scene.getObjectByName(HAND_PLANE_NAME);
  if (!plane) throw new Error(`testkit: hand hit plane ${HAND_PLANE_NAME} not found in scene`);
  const game = registry.game;
  const gameState = game?.ws.gameState;
  const playerNumber = game?.ws.playerNumber;
  if (!gameState || !playerNumber) throw new Error('testkit: no game state — cannot size the hand fan');
  const myHand = playerNumber === 1 ? gameState.player1Hand : gameState.player2Hand;
  const total = myHand.length;
  if (target.index < 0 || target.index >= total) {
    throw new Error(`testkit: hand index ${target.index} out of range (hand has ${total} cards)`);
  }

  // The hit plane tests ONLY the X coordinate (Hearthstone strips centered on
  // the fan X positions) — any Y on the plane selects the same card. The hand
  // sits deliberately low (cards poke up from the bottom edge), so the strip's
  // vertical center can project BELOW the viewport: scan from the plane's top
  // down and take the first point that lands inside the canvas.
  const fanX = getCardFanTransform(target.index, total, null, null).position[0];
  plane.updateWorldMatrix(true, false);
  const planeGeo = (plane as { geometry?: { parameters?: { height?: number } } }).geometry;
  const halfHeight = (planeGeo?.parameters?.height ?? 1) / 2;
  for (let yLocal = halfHeight * 0.9; yLocal >= -halfHeight; yLocal -= halfHeight / 8) {
    const px = toPixels(plane.localToWorld(new Vector3(fanX, yLocal, 0)));
    if (px.visible) return { x: px.x, y: px.y };
  }
  throw new Error(`testkit: hand strip ${target.index} has no on-screen point (plane fully clipped?)`);
}
