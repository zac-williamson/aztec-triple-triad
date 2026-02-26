import { useState, useEffect } from 'react';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { TextureLoader, MeshStandardMaterial, RepeatWrapping, Group, Texture } from 'three';
import { MODELS, TEXTURES } from '../assets/modelManifest';

interface EnvironmentModelProps {
  modelPath: string;
  position: [number, number, number];
  rotation?: [number, number, number];
  scale?: number; // multiplier on top of base 0.01
}

function EnvironmentModel({ modelPath, position, rotation = [0, 0, 0], scale = 1 }: EnvironmentModelProps) {
  const [model, setModel] = useState<Group | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loader = new FBXLoader();
    const texLoader = new TextureLoader();

    Promise.all([
      new Promise<Group>((resolve, reject) => loader.load(modelPath, resolve, undefined, reject)),
      new Promise<Texture>((resolve, reject) => texLoader.load(TEXTURES.swampAtlas, resolve, undefined, reject)),
    ]).then(([fbx, texture]) => {
      if (cancelled) return;
      texture.wrapS = RepeatWrapping;
      texture.wrapT = RepeatWrapping;

      fbx.traverse((child: any) => {
        if (child.isMesh) {
          child.material = new MeshStandardMaterial({
            map: texture,
            roughness: 0.9,
            metalness: 0.05,
            transparent: true,
            alphaTest: 0.5,
          });
          child.castShadow = true;
          child.receiveShadow = true;
        }
      });

      // Base scale 0.01 (cm → meters), then apply user multiplier
      fbx.scale.setScalar(0.01 * scale);
      setModel(fbx);
    });

    return () => { cancelled = true; };
  }, [modelPath, scale]);

  if (!model) return null;
  return <primitive object={model} position={position} rotation={rotation} />;
}

function FogRing() {
  const [model, setModel] = useState<Group | null>(null);

  useEffect(() => {
    let cancelled = false;
    new FBXLoader().load(MODELS.fogRing, (fbx) => {
      if (cancelled) return;
      fbx.traverse((child: any) => {
        if (child.isMesh) {
          child.material = new MeshStandardMaterial({
            color: '#2a4a2a',
            transparent: true,
            opacity: 0.12,
            roughness: 1,
          });
          child.castShadow = false;
          child.receiveShadow = false;
        }
      });
      // Fog ring is ~7000 units wide → scale to ~4m radius
      fbx.scale.setScalar(0.0006);
      setModel(fbx);
    });
    return () => { cancelled = true; };
  }, []);

  if (!model) return null;
  return <primitive object={model} position={[0, 0.05, 0]} />;
}

export function SwampEnvironment() {
  return (
    <group>
      <FogRing />

      {/* Dead trees - far background, small scale */}
      <EnvironmentModel
        modelPath={MODELS.treeDead1}
        position={[-3.5, 0, -3]}
        rotation={[0, 0.5, 0]}
        scale={0.25}
      />
      <EnvironmentModel
        modelPath={MODELS.treeDead2}
        position={[4, 0, -2.5]}
        rotation={[0, -0.7, 0]}
        scale={0.22}
      />

      {/* Swamp trees - even further back */}
      <EnvironmentModel
        modelPath={MODELS.treeSwamp3}
        position={[-4.5, 0, 2]}
        rotation={[0, 1.2, 0]}
        scale={0.2}
      />
      <EnvironmentModel
        modelPath={MODELS.treeSwamp4}
        position={[5, 0, 1.5]}
        rotation={[0, -1.5, 0]}
        scale={0.2}
      />

      {/* Lilly pads on water - small */}
      <EnvironmentModel
        modelPath={MODELS.lillyPads1}
        position={[-2, -0.15, 1.5]}
        scale={0.3}
      />
      <EnvironmentModel
        modelPath={MODELS.lillyPads2}
        position={[2, -0.15, 2]}
        rotation={[0, 1.5, 0]}
        scale={0.3}
      />

      {/* Reeds at water edge - small */}
      <EnvironmentModel
        modelPath={MODELS.reeds1}
        position={[-2.5, -0.1, 0.5]}
        rotation={[0, 0.3, 0]}
        scale={0.3}
      />
      <EnvironmentModel
        modelPath={MODELS.reeds2}
        position={[2.5, -0.1, 0]}
        rotation={[0, -0.5, 0]}
        scale={0.3}
      />
    </group>
  );
}
