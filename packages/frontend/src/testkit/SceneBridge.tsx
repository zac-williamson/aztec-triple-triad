import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { TESTKIT_ENABLED } from './enabled';
import { publishScene } from './registry';

/**
 * In-canvas bridge — publishes the live R3F camera/scene/size so the testkit
 * can project world positions to viewport pixels through the exact camera the
 * raycaster uses, and the selection and turn as the scene has them (see
 * SceneBridgeState: they can lag the game screen's). Renders nothing. Mounted
 * once inside the game Canvas.
 */
export function SceneBridge({ selectedCardIndex, isMyTurn }: { selectedCardIndex: number | null; isMyTurn: boolean }) {
  const { camera, scene, size, gl } = useThree();

  useEffect(() => {
    if (!TESTKIT_ENABLED) return;
    publishScene({
      camera,
      scene,
      size: { width: size.width, height: size.height },
      canvas: gl.domElement,
      selectedCardIndex,
      isMyTurn,
    });
  }, [camera, scene, size.width, size.height, gl, selectedCardIndex, isMyTurn]);

  useEffect(() => {
    if (!TESTKIT_ENABLED) return;
    return () => publishScene(null);
  }, []);

  return null;
}
