import { useState, useEffect } from 'react';
import {
  MeshStandardMaterial, RepeatWrapping,
  Group, Color,
} from 'three';
import { MODELS, TEXTURES } from '../assets/modelManifest';
import { InteractiveProp } from './InteractiveProp';
import { loadFBX, loadTexture } from './hooks/useFBXModel';

// ---------- Static diorama model ----------

interface StaticModelProps {
  modelPath: string;
  texturePath: string;
  position: [number, number, number];
  rotation?: [number, number, number];
  scale?: number;
  tint?: string;
  alphaTest?: number;
}

function StaticModel({ modelPath, texturePath, position, rotation = [0, 0, 0], scale = 1, tint, alphaTest = 0.5 }: StaticModelProps) {
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

// ---------- Diorama layout ----------

const A = TEXTURES.swampAtlas;

function GraveyardDiorama() {
  const cx = -2.0;
  const cz = -1.6;
  return (
    <group>
      <InteractiveProp
        modelPath={MODELS.lantern1}
        position={[cx, 0, cz]}
        rotation={[0, 0.5, 0]}
        scale={0.14}
        idleAnimation="glow"
        clickReaction="wobble"
        emissive="#ffaa44"
        emissiveIntensity={0.3}
      />
      <StaticModel modelPath={MODELS.tombstone1} texturePath={A} position={[cx - 0.25, 0, cz + 0.10]} rotation={[0, 0.3, 0]} scale={0.20} tint="#6a7a6a" />
      <StaticModel modelPath={MODELS.tombstone3} texturePath={A} position={[cx + 0.20, 0, cz - 0.06]} rotation={[0, -0.2, 0]} scale={0.18} tint="#6a7a6a" />
      <StaticModel modelPath={MODELS.skull} texturePath={A} position={[cx + 0.08, 0, cz + 0.18]} rotation={[0, 1.2, 0]} scale={0.50} />
      <StaticModel modelPath={MODELS.mossMound2} texturePath={TEXTURES.gradient3} position={[cx - 0.05, 0, cz + 0.02]} rotation={[0, 0.8, 0]} scale={0.30} tint="#4a7a35" />
    </group>
  );
}

function RitualDiorama() {
  const cx = 2.0;
  const cz = -1.6;
  return (
    <group>
      <InteractiveProp
        modelPath={MODELS.ritualPyre}
        position={[cx, 0, cz]}
        rotation={[0, -0.4, 0]}
        scale={0.05}
        idleAnimation="glow"
        clickReaction="bounce"
        emissive="#ff6622"
        emissiveIntensity={0.25}
      />
      <StaticModel modelPath={MODELS.effigy1} texturePath={A} position={[cx + 0.22, 0, cz - 0.12]} rotation={[0, -0.8, 0]} scale={0.06} />
      <StaticModel modelPath={MODELS.fenceBroken} texturePath={A} position={[cx - 0.25, 0, cz + 0.08]} rotation={[0, 0.6, 0]} scale={0.12} />
      <StaticModel modelPath={MODELS.barrel1} texturePath={A} position={[cx - 0.12, 0, cz - 0.15]} rotation={[0, 1.0, 0]} scale={0.18} />
      <StaticModel modelPath={MODELS.swampGrassSmall} texturePath={TEXTURES.swampGrass} position={[cx + 0.15, 0, cz + 0.15]} rotation={[0, -0.3, 0]} scale={0.06} />
    </group>
  );
}

function DockDiorama() {
  const cx = -2.2;
  const cz = 1.7;
  return (
    <group>
      <InteractiveProp
        modelPath={MODELS.dreamCatcher}
        position={[cx, 0, cz]}
        rotation={[0, 0.3, 0]}
        scale={0.25}
        idleAnimation="sway"
        clickReaction="spin"
      />
      <StaticModel modelPath={MODELS.stump1} texturePath={A} position={[cx - 0.20, 0, cz - 0.10]} rotation={[0, 0.5, 0]} scale={0.10} />
      <StaticModel modelPath={MODELS.fence1} texturePath={A} position={[cx + 0.22, 0, cz - 0.10]} rotation={[0, -0.6, 0]} scale={0.15} />
      <StaticModel modelPath={MODELS.barrel2} texturePath={A} position={[cx + 0.10, 0, cz + 0.15]} rotation={[0, 0.8, 0]} scale={0.18} />
      <StaticModel modelPath={MODELS.reeds1} texturePath={TEXTURES.reedsTex} position={[cx - 0.15, 0, cz + 0.18]} rotation={[0, 0.9, 0]} scale={0.06} />
    </group>
  );
}

function ShrineDiorama() {
  const cx = 2.2;
  const cz = 1.7;
  return (
    <group>
      <InteractiveProp
        modelPath={MODELS.effigy2}
        position={[cx, 0, cz]}
        rotation={[0, -0.5, 0]}
        scale={0.10}
        idleAnimation="bob"
        clickReaction="wobble"
      />
      <StaticModel modelPath={MODELS.lantern2} texturePath={A} position={[cx - 0.20, 0, cz + 0.10]} rotation={[0, 0.7, 0]} scale={0.10} />
      <StaticModel modelPath={MODELS.skull} texturePath={A} position={[cx + 0.16, 0, cz - 0.13]} rotation={[0, -1.0, 0]} scale={0.50} />
      <StaticModel modelPath={MODELS.barrel2} texturePath={A} position={[cx + 0.22, 0, cz + 0.15]} rotation={[0, -0.4, 0]} scale={0.18} />
      <StaticModel modelPath={MODELS.toetoe1} texturePath={TEXTURES.toetoeTex} position={[cx - 0.08, 0, cz - 0.20]} rotation={[0, 0.4, 0]} scale={0.04} />
    </group>
  );
}

// ---------- Main PropLayout ----------

export function PropLayout() {
  return (
    <group>
      <GraveyardDiorama />
      <RitualDiorama />
      <DockDiorama />
      <ShrineDiorama />
    </group>
  );
}
