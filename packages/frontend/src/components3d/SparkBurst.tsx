import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { AdditiveBlending, BufferAttribute } from 'three';

interface SparkBurstProps {
  position: [number, number, number];
  color?: string;
  count?: number;
  duration?: number;
}

export function SparkBurst({
  position,
  color = '#ff8800',
  count = 24,
  duration = 0.6,
}: SparkBurstProps) {
  const pointsRef = useRef<any>(null!);
  const progressRef = useRef(0);
  const doneRef = useRef(false);

  // Initialize particle positions (all at origin) and velocities (random hemisphere)
  const { positions, velocities } = useMemo(() => {
    const pos = new Float32Array(count * 3);
    const vel = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      // Start at center
      pos[i3] = 0;
      pos[i3 + 1] = 0;
      pos[i3 + 2] = 0;

      // Random direction in upper hemisphere
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI * 0.4; // mostly upward
      const speed = 0.8 + Math.random() * 1.2;

      vel[i3] = Math.sin(phi) * Math.cos(theta) * speed;
      vel[i3 + 1] = Math.cos(phi) * speed + 0.3; // upward bias
      vel[i3 + 2] = Math.sin(phi) * Math.sin(theta) * speed;
    }
    return { positions: pos, velocities: vel };
  }, [count]);

  useFrame((_, delta) => {
    if (doneRef.current || !pointsRef.current) return;

    progressRef.current += delta;
    const t = Math.min(progressRef.current / duration, 1);

    const posAttr = pointsRef.current.geometry.attributes.position as BufferAttribute;
    const arr = posAttr.array as Float32Array;

    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      arr[i3] += velocities[i3] * delta;
      arr[i3 + 1] += velocities[i3 + 1] * delta;
      arr[i3 + 2] += velocities[i3 + 2] * delta;

      // Gravity
      velocities[i3 + 1] -= 2.5 * delta;
    }
    posAttr.needsUpdate = true;

    // Fade opacity
    const mat = pointsRef.current.material as any;
    mat.opacity = 1 - t;

    if (t >= 1) {
      doneRef.current = true;
      pointsRef.current.visible = false;
    }
  });

  if (doneRef.current) return null;

  return (
    <points ref={pointsRef} position={position}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          args={[positions, 3]}
        />
      </bufferGeometry>
      <pointsMaterial
        color={color}
        size={0.04}
        sizeAttenuation
        transparent
        opacity={1}
        depthWrite={false}
        blending={AdditiveBlending}
      />
    </points>
  );
}
