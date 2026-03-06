import { useRef, useState, useCallback, useEffect, Suspense } from 'react';
import { useFrame } from '@react-three/fiber';
import type { Group, MeshStandardMaterial } from 'three';
import { useFBXModel } from './hooks/useFBXModel';

type IdleAnimation = 'bob' | 'sway' | 'glow' | 'none';
type ClickReaction = 'wobble' | 'bounce' | 'spin';

interface InteractivePropProps {
  modelPath: string;
  texturePath?: string;
  position: [number, number, number];
  rotation?: [number, number, number];
  scale?: number;
  idleAnimation?: IdleAnimation;
  clickReaction?: ClickReaction;
  tint?: string;
  emissive?: string;
  emissiveIntensity?: number;
}

function PropInner({
  modelPath,
  texturePath,
  position,
  rotation = [0, 0, 0],
  scale = 1,
  idleAnimation = 'none',
  clickReaction = 'wobble',
  tint,
  emissive,
  emissiveIntensity,
}: InteractivePropProps) {
  const model = useFBXModel(modelPath, texturePath, { scale: scale * 0.01, tint, emissive, emissiveIntensity });
  const groupRef = useRef<Group>(null!);
  const [hovered, setHovered] = useState(false);
  const clickTimeRef = useRef(0);
  const baseY = position[1];
  // Cache emissive materials to avoid traversal every frame
  const emissiveMatsRef = useRef<MeshStandardMaterial[]>([]);

  useEffect(() => {
    if (idleAnimation !== 'glow') return;
    const mats: MeshStandardMaterial[] = [];
    model.traverse((child: any) => {
      if (child.isMesh && child.material?.emissiveIntensity !== undefined) {
        mats.push(child.material);
      }
    });
    emissiveMatsRef.current = mats;
  }, [model, idleAnimation]);

  const handleClick = useCallback((e: any) => {
    e.stopPropagation();
    clickTimeRef.current = 1;
  }, []);

  useFrame((_, delta) => {
    if (!groupRef.current) return;
    const t = Date.now() * 0.001;

    switch (idleAnimation) {
      case 'bob':
        groupRef.current.position.y = baseY + Math.sin(t * 1.5) * 0.015;
        break;
      case 'sway':
        groupRef.current.rotation.z = Math.sin(t * 0.8) * 0.05;
        break;
      case 'glow': {
        const intensity = 0.2 + Math.sin(t * 2) * 0.15;
        for (const mat of emissiveMatsRef.current) {
          mat.emissiveIntensity = intensity;
        }
        break;
      }
    }

    if (clickTimeRef.current > 0) {
      clickTimeRef.current = Math.max(0, clickTimeRef.current - delta * 3);
      const springVal = clickTimeRef.current;

      switch (clickReaction) {
        case 'wobble':
          groupRef.current.rotation.z = Math.sin(springVal * 15) * springVal * 0.3;
          break;
        case 'bounce':
          groupRef.current.position.y = baseY + Math.sin(springVal * Math.PI) * 0.1;
          break;
        case 'spin':
          groupRef.current.rotation.y += delta * 8 * springVal;
          break;
      }
    }

    const targetScale = hovered ? 1.05 : 1;
    const currentScale = groupRef.current.scale.x;
    const newScale = currentScale + (targetScale - currentScale) * delta * 8;
    groupRef.current.scale.setScalar(newScale);
  });

  return (
    <group
      ref={groupRef as any}
      position={position}
      rotation={rotation}
      onClick={handleClick}
      onPointerEnter={(e) => {
        e.stopPropagation();
        setHovered(true);
        document.body.style.cursor = 'pointer';
      }}
      onPointerLeave={() => {
        setHovered(false);
        document.body.style.cursor = 'default';
      }}
    >
      <primitive object={model} />
    </group>
  );
}

export function InteractiveProp(props: InteractivePropProps) {
  return (
    <Suspense fallback={null}>
      <PropInner {...props} />
    </Suspense>
  );
}
