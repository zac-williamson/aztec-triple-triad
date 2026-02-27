import { useState, useEffect } from 'react';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import {
  TextureLoader, MeshStandardMaterial, RepeatWrapping,
  Group, Texture, Color,
} from 'three';
import { MODELS, TEXTURES } from '../assets/modelManifest';

// ---------- Board dimensions ----------

const ARENA_W = 3.0;
const ARENA_D = 2.4;
const HALF_W = ARENA_W / 2;
const HALF_D = ARENA_D / 2;
const BORDER_THICKNESS = 0.12;
const BORDER_HEIGHT = 0.08;

// ---------- Per-mesh material detection ----------
// Synty FBX vegetation models contain multiple LOD meshes with DIFFERENT
// material types. LOD0 uses atlas UVs (tiny pixel region = flat color),
// while LOD1/LOD2 use dedicated plant textures with full 0-1 UV range.
// Applying a single dedicated texture to atlas-UV meshes causes "green
// rectangles" because the tiny UV coords sample a random spot on the
// dedicated texture. We detect atlas-material meshes by their material
// name and hide them when a non-atlas texture is being applied.

const ATLAS_MAT_PREFIXES = ['Nature', 'Explorer_MAT', 'Nature_Base_Mat', 'lambert'];

function isAtlasMaterial(name: string): boolean {
  return ATLAS_MAT_PREFIXES.some(prefix => name.startsWith(prefix));
}

// ---------- Generic FBX model with explicit texture path ----------

interface FloorModelProps {
  modelPath: string;
  texturePath: string;
  position: [number, number, number];
  rotation?: [number, number, number];
  scale?: number;
  tint?: string;
  alphaTest?: number;
}

function FloorModel({ modelPath, texturePath, position, rotation = [0, 0, 0], scale = 1, tint, alphaTest = 0.5 }: FloorModelProps) {
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

          // Hide atlas-UV meshes when applying a dedicated texture.
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

      fbx.scale.setScalar(0.01 * scale);
      setModel(fbx);
    });

    return () => { cancelled = true; };
  }, [modelPath, texturePath, scale, tint, alphaTest]);

  if (!model) return null;
  return <primitive object={model} position={position} rotation={rotation} />;
}

// ---------- Rectangular arena ground ----------
// Uses the dedicated mud path texture (tileable).

function ArenaSurface() {
  const [texture, setTexture] = useState<Texture | null>(null);

  useEffect(() => {
    let cancelled = false;
    new TextureLoader().load(TEXTURES.mudPath, (tex) => {
      if (cancelled) return;
      tex.wrapS = RepeatWrapping;
      tex.wrapT = RepeatWrapping;
      tex.repeat.set(3, 2.4);
      setTexture(tex);
    });
    return () => { cancelled = true; };
  }, []);

  if (!texture) return null;

  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]} receiveShadow>
      <planeGeometry args={[ARENA_W, ARENA_D]} />
      <meshStandardMaterial
        map={texture as any}
        color="#7a6a55"
        roughness={0.95}
        metalness={0.02}
      />
    </mesh>
  );
}

// ---------- Wooden border frame ----------
// Uses mud path texture tinted darker for a wooden-plank look.

function BorderFrame() {
  const [texture, setTexture] = useState<Texture | null>(null);

  useEffect(() => {
    let cancelled = false;
    new TextureLoader().load(TEXTURES.mudPath, (tex) => {
      if (cancelled) return;
      tex.wrapS = RepeatWrapping;
      tex.wrapT = RepeatWrapping;
      tex.repeat.set(8, 1);
      setTexture(tex);
    });
    return () => { cancelled = true; };
  }, []);

  if (!texture) return null;

  return (
    <group>
      <mesh position={[0, BORDER_HEIGHT / 2, -HALF_D]} receiveShadow castShadow>
        <boxGeometry args={[ARENA_W + BORDER_THICKNESS * 2, BORDER_HEIGHT, BORDER_THICKNESS]} />
        <meshStandardMaterial map={texture as any} color="#5a4535" roughness={0.88} metalness={0.05} />
      </mesh>
      <mesh position={[0, BORDER_HEIGHT / 2, HALF_D]} receiveShadow castShadow>
        <boxGeometry args={[ARENA_W + BORDER_THICKNESS * 2, BORDER_HEIGHT, BORDER_THICKNESS]} />
        <meshStandardMaterial map={texture as any} color="#5a4535" roughness={0.88} metalness={0.05} />
      </mesh>
      <mesh position={[-HALF_W, BORDER_HEIGHT / 2, 0]} receiveShadow castShadow>
        <boxGeometry args={[BORDER_THICKNESS, BORDER_HEIGHT, ARENA_D]} />
        <meshStandardMaterial map={texture as any} color="#5a4535" roughness={0.88} metalness={0.05} />
      </mesh>
      <mesh position={[HALF_W, BORDER_HEIGHT / 2, 0]} receiveShadow castShadow>
        <boxGeometry args={[BORDER_THICKNESS, BORDER_HEIGHT, ARENA_D]} />
        <meshStandardMaterial map={texture as any} color="#5a4535" roughness={0.88} metalness={0.05} />
      </mesh>
    </group>
  );
}

// ---------- Arena border corner barrels (ambient decoration) ----------
// Interactive corner widgets (lanterns, skull, dream catcher) are in PropLayout.

function CornerBarrels() {
  const T = TEXTURES.swampAtlas;
  return (
    <group>
      <FloorModel modelPath={MODELS.barrel1} texturePath={T} position={[-HALF_W, 0, HALF_D]} rotation={[0, 0.3, 0]} scale={0.06} />
      <FloorModel modelPath={MODELS.barrel2} texturePath={T} position={[HALF_W, 0, HALF_D]} rotation={[0, -0.4, 0]} scale={0.06} />
    </group>
  );
}

// ---------- Edge decorations ----------

function EdgeDecorations() {
  const T = TEXTURES.swampAtlas;
  return (
    <group>
      {/* Tombstones along back edge (atlas-textured) */}
      <FloorModel modelPath={MODELS.tombstone1} texturePath={T} position={[-0.7, 0, -HALF_D + 0.15]} rotation={[0, 0.1, 0]} scale={0.06} tint="#6a7a6a" />
      <FloorModel modelPath={MODELS.tombstone3} texturePath={T} position={[0.6, 0, -HALF_D + 0.12]} rotation={[0, -0.15, 0]} scale={0.055} tint="#6a7a6a" />

      {/* Small vegetation against edges (dedicated swamp grass texture) */}
      <FloorModel modelPath={MODELS.swampGrassSmall} texturePath={TEXTURES.swampGrass} position={[-HALF_W + 0.15, 0, -0.4]} rotation={[0, 0.5, 0]} scale={0.035} />
      <FloorModel modelPath={MODELS.swampGrassSmall} texturePath={TEXTURES.swampGrass} position={[HALF_W - 0.15, 0, 0.3]} rotation={[0, -0.8, 0]} scale={0.03} />
      <FloorModel modelPath={MODELS.swampGrassMedium} texturePath={TEXTURES.swampGrass} position={[-0.3, 0, HALF_D - 0.12]} rotation={[0, 1.2, 0]} scale={0.025} />
      <FloorModel modelPath={MODELS.swampGrassMedium} texturePath={TEXTURES.swampGrass} position={[0.4, 0, -HALF_D + 0.1]} rotation={[0, -0.6, 0]} scale={0.025} />

      {/* Scum patches (dedicated scum texture) */}
      <FloorModel modelPath={MODELS.swampScum1} texturePath={TEXTURES.swampScum1Tex} position={[-0.9, -0.005, 0.6]} rotation={[0, 0.3, 0]} scale={0.03} />
      <FloorModel modelPath={MODELS.swampScum2} texturePath={TEXTURES.swampScum2Tex} position={[0.8, -0.005, -0.7]} rotation={[0, 1.5, 0]} scale={0.025} />
    </group>
  );
}

// ---------- Outer vegetation (outside border) ----------

function OuterVegetation() {
  const G = TEXTURES.grassSwamp; // tall grass clumps
  const SG = TEXTURES.swampGrass; // swamp grass groups, small/medium
  const TT = TEXTURES.toetoeTex; // toetoe plants
  const BR = TEXTURES.branchesTex; // bush brambles

  return (
    <group>
      {/* Dense grass behind back border */}
      <FloorModel modelPath={MODELS.grassTallClump1} texturePath={G} position={[-1.0, 0, -HALF_D - 0.3]} rotation={[0, 0.3, 0]} scale={0.06} />
      <FloorModel modelPath={MODELS.grassTallClump2} texturePath={G} position={[0.2, 0, -HALF_D - 0.4]} rotation={[0, -0.5, 0]} scale={0.07} />
      <FloorModel modelPath={MODELS.grassTallClump3} texturePath={G} position={[1.1, 0, -HALF_D - 0.3]} rotation={[0, 0.8, 0]} scale={0.06} />
      <FloorModel modelPath={MODELS.bushBramble1} texturePath={BR} position={[-0.4, 0, -HALF_D - 0.5]} rotation={[0, 1.0, 0]} scale={0.05} />
      <FloorModel modelPath={MODELS.swampGrassGroup1} texturePath={SG} position={[0.7, 0, -HALF_D - 0.35]} rotation={[0, -0.3, 0]} scale={0.05} />

      {/* Left side */}
      <FloorModel modelPath={MODELS.grassTallClump1} texturePath={G} position={[-HALF_W - 0.3, 0, -0.5]} rotation={[0, 1.5, 0]} scale={0.06} />
      <FloorModel modelPath={MODELS.bushBramble2} texturePath={BR} position={[-HALF_W - 0.4, 0, 0.4]} rotation={[0, 0.2, 0]} scale={0.05} />
      <FloorModel modelPath={MODELS.swampGrassGroup2} texturePath={SG} position={[-HALF_W - 0.3, 0, 0.0]} rotation={[0, 0.7, 0]} scale={0.05} />
      <FloorModel modelPath={MODELS.toetoe1} texturePath={TT} position={[-HALF_W - 0.5, 0, 0.8]} rotation={[0, 0.7, 0]} scale={0.04} />

      {/* Right side */}
      <FloorModel modelPath={MODELS.grassTallClump2} texturePath={G} position={[HALF_W + 0.3, 0, 0.2]} rotation={[0, -1.2, 0]} scale={0.06} />
      <FloorModel modelPath={MODELS.bushBramble1} texturePath={BR} position={[HALF_W + 0.4, 0, -0.6]} rotation={[0, -0.5, 0]} scale={0.05} />
      <FloorModel modelPath={MODELS.swampGrassGroup3} texturePath={SG} position={[HALF_W + 0.3, 0, 0.8]} rotation={[0, 2.1, 0]} scale={0.05} />
      <FloorModel modelPath={MODELS.toetoe2} texturePath={TT} position={[HALF_W + 0.5, 0, -0.9]} rotation={[0, -1.0, 0]} scale={0.04} />

      {/* Front (sparse) */}
      <FloorModel modelPath={MODELS.swampGrassGroup1} texturePath={SG} position={[-0.8, 0, HALF_D + 0.25]} rotation={[0, -0.4, 0]} scale={0.035} />
      <FloorModel modelPath={MODELS.swampGrassSmall} texturePath={SG} position={[0.6, 0, HALF_D + 0.2]} rotation={[0, 0.6, 0]} scale={0.04} />

      {/* Rock (use gradient for CastleSHD rock) */}
      <FloorModel modelPath={MODELS.rockSwamp} texturePath={TEXTURES.gradient3} position={[-HALF_W - 0.2, 0, -HALF_D - 0.2]} rotation={[0, 0.6, 0]} scale={0.04} tint="#5a5a52" />

      {/* Logs and stump (atlas-textured props) */}
      <FloorModel modelPath={MODELS.swampLog1} texturePath={TEXTURES.swampAtlas} position={[HALF_W + 0.15, 0, HALF_D + 0.15]} rotation={[0, -0.4, 0]} scale={0.03} />
      <FloorModel modelPath={MODELS.stump1} texturePath={TEXTURES.swampAtlas} position={[-HALF_W - 0.3, 0, HALF_D + 0.1]} rotation={[0, 0.3, 0]} scale={0.04} />
    </group>
  );
}

// ---------- Main SwampFloor ----------

export function SwampFloor() {
  return (
    <group>
      <ArenaSurface />
      <BorderFrame />
      <CornerBarrels />
      <EdgeDecorations />
      <OuterVegetation />
    </group>
  );
}
