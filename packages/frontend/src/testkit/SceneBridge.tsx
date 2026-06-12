import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { TESTKIT_ENABLED } from './enabled';
import { publishScene } from './registry';

/**
 * In-canvas bridge — publishes the live R3F camera/scene/size so the testkit
 * can project world positions to viewport pixels through the exact camera the
 * raycaster uses. Renders nothing. Mounted once inside the game Canvas.
 */
export function SceneBridge() {
  const { camera, scene, size, gl } = useThree();

  useEffect(() => {
    if (!TESTKIT_ENABLED) return;
    publishScene({
      camera,
      scene,
      size: { width: size.width, height: size.height },
      canvas: gl.domElement,
    });
  }, [camera, scene, size.width, size.height, gl]);

  useEffect(() => {
    if (!TESTKIT_ENABLED) return;
    return () => publishScene(null);
  }, []);

  return null;
}
