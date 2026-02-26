import { useRef, useState, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import { TextureLoader, RepeatWrapping, Vector2, Texture } from 'three';
import type { Mesh } from 'three';
import { TEXTURES } from '../assets/modelManifest';

export function WaterSurface() {
  const meshRef = useRef<Mesh>(null!);
  const [normalMap, setNormalMap] = useState<Texture | null>(null);

  useEffect(() => {
    let cancelled = false;
    new TextureLoader().load(TEXTURES.waterNormals1, (tex) => {
      if (cancelled) return;
      tex.wrapS = tex.wrapT = RepeatWrapping;
      tex.repeat.set(8, 8);
      setNormalMap(tex);
    });
    return () => { cancelled = true; };
  }, []);

  useFrame((_, delta) => {
    if (!normalMap) return;
    normalMap.offset.x += delta * 0.02;
    normalMap.offset.y += delta * 0.015;
  });

  return (
    <mesh
      ref={meshRef as any}
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, -0.15, 0]}
      receiveShadow
    >
      <planeGeometry args={[15, 15, 32, 32]} />
      <meshStandardMaterial
        color="#1a3a1a"
        normalMap={normalMap as any}
        normalScale={new Vector2(0.3, 0.3) as any}
        roughness={0.3}
        metalness={0.1}
        transparent
        opacity={0.85}
      />
    </mesh>
  );
}
