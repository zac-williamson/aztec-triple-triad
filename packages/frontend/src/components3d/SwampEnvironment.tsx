import { useState, useEffect } from 'react';
import {
  MeshStandardMaterial, RepeatWrapping,
  Group, Color,
} from 'three';
import { MODELS, TEXTURES } from '../assets/modelManifest';
import { loadFBX, loadTexture } from './hooks/useFBXModel';

interface EnvironmentModelProps {
  modelPath: string;
  texturePath: string;
  position: [number, number, number];
  rotation?: [number, number, number];
  scale?: number;
  tint?: string;
  alphaTest?: number;
}

function EnvironmentModel({ modelPath, texturePath, position, rotation = [0, 0, 0], scale = 1, tint, alphaTest = 0.5 }: EnvironmentModelProps) {
  const [model, setModel] = useState<Group | null>(null);

  useEffect(() => {
    let cancelled = false;

    Promise.all([loadFBX(modelPath), loadTexture(texturePath)]).then(([fbx, texture]) => {
      if (cancelled) return;
      texture.wrapS = RepeatWrapping;
      texture.wrapT = RepeatWrapping;

      const clone = fbx.clone(true);

      clone.traverse((child: any) => {
        if (child.isMesh) {
          child.material = new MeshStandardMaterial({
            map: texture,
            ...(tint ? { color: new Color(tint) } : {}),
            roughness: 0.9,
            metalness: 0.05,
            transparent: true,
            alphaTest,
          });
          child.castShadow = false;
          child.receiveShadow = true;
        }
      });

      clone.scale.setScalar(0.01 * scale);
      setModel(clone);
    });

    return () => { cancelled = true; };
  }, [modelPath, texturePath, scale, tint, alphaTest]);

  if (!model) return null;
  return <primitive object={model} position={position} rotation={rotation} />;
}

function FogRing() {
  const [model, setModel] = useState<Group | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadFBX(MODELS.fogRing).then((fbx) => {
      if (cancelled) return;
      const clone = fbx.clone(true);
      clone.traverse((child: any) => {
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
      clone.scale.setScalar(0.0006);
      setModel(clone);
    });
    return () => { cancelled = true; };
  }, []);

  if (!model) return null;
  return <primitive object={model} position={[0, 0.05, 0]} />;
}

export function SwampEnvironment() {
  const A = TEXTURES.swampAtlas;
  const LP1 = TEXTURES.lillyPads1Tex;
  const LP2 = TEXTURES.lillyPads2Tex;
  const R = TEXTURES.reedsTex;

  return (
    <group>
      <FogRing />

      {/* Dead trees - far background (atlas-textured) */}
      <EnvironmentModel
        modelPath={MODELS.treeDead1}
        texturePath={A}
        position={[-3.5, 0, -3]}
        rotation={[0, 0.5, 0]}
        scale={0.10}
      />
      <EnvironmentModel
        modelPath={MODELS.treeDead2}
        texturePath={A}
        position={[4, 0, -2.5]}
        rotation={[0, -0.7, 0]}
        scale={0.08}
      />

      {/* Swamp trees - even further back (atlas-textured) */}
      <EnvironmentModel
        modelPath={MODELS.treeSwamp3}
        texturePath={A}
        position={[-4.5, 0, 2]}
        rotation={[0, 1.2, 0]}
        scale={0.08}
      />
      <EnvironmentModel
        modelPath={MODELS.treeSwamp4}
        texturePath={A}
        position={[5, 0, 1.5]}
        rotation={[0, -1.5, 0]}
        scale={0.08}
      />

      {/* Lilly pads on water (dedicated lily pad textures) */}
      <EnvironmentModel
        modelPath={MODELS.lillyPads1}
        texturePath={LP1}
        position={[-2, -0.15, 1.5]}
        scale={0.12}
      />
      <EnvironmentModel
        modelPath={MODELS.lillyPads2}
        texturePath={LP2}
        position={[2, -0.15, 2]}
        rotation={[0, 1.5, 0]}
        scale={0.12}
      />

      {/* Reeds at water edge (dedicated reeds texture) */}
      <EnvironmentModel
        modelPath={MODELS.reeds1}
        texturePath={R}
        position={[-2.5, -0.1, 0.5]}
        rotation={[0, 0.3, 0]}
        scale={0.10}
      />
      <EnvironmentModel
        modelPath={MODELS.reeds2}
        texturePath={R}
        position={[2.5, -0.1, 0]}
        rotation={[0, -0.5, 0]}
        scale={0.10}
      />
    </group>
  );
}
