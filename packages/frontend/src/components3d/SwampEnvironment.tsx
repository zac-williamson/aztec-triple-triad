import { useState, useEffect } from 'react';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import {
  TextureLoader, MeshStandardMaterial, RepeatWrapping,
  Group, Texture, Color,
} from 'three';
import { MODELS, TEXTURES } from '../assets/modelManifest';

// Same atlas-material detection as SwampFloor — hides atlas-UV meshes
// when a dedicated (non-atlas) texture is applied, preventing "green
// rectangle" artifacts from incompatible UV layouts.
const ATLAS_MAT_PREFIXES = ['Nature', 'Explorer_MAT', 'Nature_Base_Mat', 'lambert'];
function isAtlasMaterial(name: string): boolean {
  return ATLAS_MAT_PREFIXES.some(prefix => name.startsWith(prefix));
}

interface EnvironmentModelProps {
  modelPath: string;
  texturePath: string;
  position: [number, number, number];
  rotation?: [number, number, number];
  scale?: number; // multiplier on top of base 0.01
  tint?: string;
  alphaTest?: number;
}

function EnvironmentModel({ modelPath, texturePath, position, rotation = [0, 0, 0], scale = 1, tint, alphaTest = 0.5 }: EnvironmentModelProps) {
  const [model, setModel] = useState<Group | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loader = new FBXLoader();
    const texLoader = new TextureLoader();

    Promise.all([
      new Promise<Group>((resolve, reject) => loader.load(modelPath, resolve, undefined, reject)),
      new Promise<Texture>((resolve, reject) => texLoader.load(texturePath, resolve, undefined, reject)),
    ]).then(([fbx, texture]) => {
      if (cancelled) return;
      texture.wrapS = RepeatWrapping;
      texture.wrapT = RepeatWrapping;

      const isAtlasTexture = texturePath.includes('PolygonNatureBiomes');
      let keptOne = false;

      fbx.traverse((child: any) => {
        if (child.isMesh) {
          const origMatName = child.material?.name || '';

          if (isAtlasMaterial(origMatName) && !isAtlasTexture) {
            child.visible = false;
            return;
          }

          // Only keep the first compatible mesh — hide duplicate LODs
          // to prevent z-fighting flicker from overlapping geometry.
          if (keptOne) {
            child.visible = false;
            return;
          }
          keptOne = true;

          child.material = new MeshStandardMaterial({
            map: texture,
            color: tint ? new Color(tint) : undefined,
            roughness: 0.9,
            metalness: 0.05,
            transparent: true,
            alphaTest,
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
  }, [modelPath, texturePath, scale, tint, alphaTest]);

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

// EnvironmentModel scale multiplier reference:
// Synty trees are ~800-2000cm tall
// scale=0.08 → 0.0008 → 800cm tree = 0.64m (small background tree)
// scale=0.10 → 0.001 → 800cm tree = 0.80m

export function SwampEnvironment() {
  const A = TEXTURES.swampAtlas; // atlas for UV-mapped tree models
  const LP1 = TEXTURES.lillyPads1Tex; // dedicated lily pad texture
  const LP2 = TEXTURES.lillyPads2Tex;
  const R = TEXTURES.reedsTex; // dedicated reeds texture

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
