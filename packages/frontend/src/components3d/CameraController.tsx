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

    // Camera positioned for crate-based board:
    // Crate grid is ~1.2m wide, top at y=0.389. Looking down at ~50 degrees.
    camera.position.set(0 + driftX, 2.2, 1.8 + driftZ);
    camera.lookAt(0, 0.2, 0);
  });

  return null;
}
