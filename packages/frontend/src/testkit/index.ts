/**
 * Testkit public surface for the app's wiring touchpoints.
 * Everything here is a no-op unless the frontend runs with VITE_TESTKIT=1.
 */
export { useTestkitBridge } from './useTestkitBridge';
export { useGameScreenBridge } from './useGameScreenBridge';
export { SceneBridge } from './SceneBridge';
export { CELL_NAME, HAND_PLANE_NAME } from './names';
