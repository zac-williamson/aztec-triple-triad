import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { AdditiveBlending } from 'three';

interface CardGlowProps {
  width: number;
  height: number;
  color: string;
  count?: number;
  renderOrder?: number;
}

/**
 * Animated particle glow that traces along a card's rectangular border.
 * Particles drift slowly along the perimeter and pulse in size/opacity.
 */
export function CardGlow({
  width,
  height,
  color,
  count = 40,
  renderOrder,
}: CardGlowProps) {
  const pointsRef = useRef<any>(null!);
  const timeRef = useRef(0);

  // Each particle: a position along the perimeter (0-1), a random phase, a random offset
  const particleData = useMemo(() => {
    const perimeterPositions = new Float32Array(count); // 0-1 along perimeter
    const phases = new Float32Array(count);             // random phase for twinkle
    const offsets = new Float32Array(count * 2);        // random XY offset from edge

    for (let i = 0; i < count; i++) {
      perimeterPositions[i] = Math.random();
      phases[i] = Math.random() * Math.PI * 2;
      offsets[i * 2] = (Math.random() - 0.5) * 0.015;     // perpendicular jitter
      offsets[i * 2 + 1] = (Math.random() - 0.5) * 0.015;
    }

    return { perimeterPositions, phases, offsets };
  }, [count]);

  // Position buffer for Points
  const positions = useMemo(() => new Float32Array(count * 3), [count]);

  // Convert a 0-1 perimeter parameter to XY on the card rectangle
  function perimToXY(t: number): [number, number] {
    const hw = width / 2;
    const hh = height / 2;
    const perim = 2 * (width + height);

    let d = ((t % 1) + 1) % 1 * perim; // distance along perimeter

    if (d < width) {
      // Bottom edge: left to right
      return [-hw + d, -hh];
    }
    d -= width;
    if (d < height) {
      // Right edge: bottom to top
      return [hw, -hh + d];
    }
    d -= height;
    if (d < width) {
      // Top edge: right to left
      return [hw - d, hh];
    }
    d -= width;
    // Left edge: top to bottom
    return [-hw, hh - d];
  }

  useFrame((_, delta) => {
    if (!pointsRef.current) return;
    timeRef.current += delta;
    const time = timeRef.current;

    const { perimeterPositions, phases, offsets } = particleData;

    for (let i = 0; i < count; i++) {
      // Slowly drift along perimeter
      const t = perimeterPositions[i] + time * 0.04;
      const [bx, by] = perimToXY(t);

      const i3 = i * 3;
      positions[i3] = bx + offsets[i * 2] + Math.sin(time * 2 + phases[i]) * 0.008;
      positions[i3 + 1] = by + offsets[i * 2 + 1] + Math.cos(time * 2.5 + phases[i]) * 0.008;
      positions[i3 + 2] = 0.001; // slightly in front of card
    }

    const geom = pointsRef.current.geometry;
    geom.attributes.position.array.set(positions);
    geom.attributes.position.needsUpdate = true;

    // Pulse overall opacity
    const mat = pointsRef.current.material as any;
    mat.opacity = 0.6 + 0.3 * Math.sin(time * 3);
  });

  return (
    <points ref={pointsRef} renderOrder={renderOrder}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          args={[positions, 3]}
        />
      </bufferGeometry>
      <pointsMaterial
        color={color}
        size={0.025}
        sizeAttenuation
        transparent
        opacity={0.8}
        depthWrite={false}
        blending={AdditiveBlending}
      />
    </points>
  );
}
