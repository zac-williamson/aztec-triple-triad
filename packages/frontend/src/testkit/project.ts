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
export function getScreenXY(target: ClickTarget): { x: number; y: number } {
  const sceneState = registry.scene;
  if (!sceneState) throw new Error('testkit: no scene bridge published (is the game screen mounted?)');
  const { camera, scene, size, canvas } = sceneState;

  const world = new Vector3();

  if (target.type === 'cell') {
    const mesh = scene.getObjectByName(CELL_NAME(target.row, target.col));
    if (!mesh) throw new Error(`testkit: cell mesh ${CELL_NAME(target.row, target.col)} not found in scene`);
    mesh.getWorldPosition(world);
  } else {
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
    // The hand hit plane uses Hearthstone-style X strips centered on the fan
    // X positions (PlayerHand3D.hitTestCardIndex). Aim at the strip center.
    const fanX = getCardFanTransform(target.index, total, null, null).position[0];
    plane.localToWorld(world.set(fanX, 0, 0));
  }

  camera.updateMatrixWorld();
  const ndc = world.project(camera);
  if (ndc.z > 1) throw new Error('testkit: target is behind the camera');

  const rect = canvas.getBoundingClientRect();
  return {
    x: rect.left + ((ndc.x + 1) / 2) * size.width,
    y: rect.top + ((1 - ndc.y) / 2) * size.height,
  };
}
