import { useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';

export function CameraController() {
  const { camera } = useThree();
  const timeRef = useRef(0);

  useFrame((_, delta) => {
    timeRef.current += delta;
    const t = timeRef.current;

    // Subtle figure-8 idle drift
    const driftX = Math.sin(t * 0.1) * 0.03;
    const driftZ = Math.sin(t * 0.2) * Math.cos(t * 0.1) * 0.02;

    // Camera positioned to frame 3m × 2.4m arena with 0.643m tall crates.
    // Higher up and further back to keep board below the opponent HUD.
    camera.position.set(0 + driftX, 3.8, 3.0 + driftZ);
    camera.lookAt(0, 0.3, 0);
  });

  return null;
}
