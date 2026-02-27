import { useState, useEffect } from 'react';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import {
  TextureLoader, MeshStandardMaterial, RepeatWrapping,
  Group, Texture, Color,
} from 'three';
import { MODELS, TEXTURES } from '../assets/modelManifest';
import { InteractiveProp } from './InteractiveProp';

// ---------- Atlas material detection (shared with SwampFloor) ----------

const ATLAS_MAT_PREFIXES = ['Nature', 'Explorer_MAT', 'Nature_Base_Mat', 'lambert'];
function isAtlasMaterial(name: string): boolean {
  return ATLAS_MAT_PREFIXES.some(prefix => name.startsWith(prefix));
}

// ---------- Static diorama model (non-interactive) ----------

interface StaticModelProps {
  modelPath: string;
  texturePath: string;
  position: [number, number, number];
  rotation?: [number, number, number];
  scale?: number; // final scale = 0.01 * scale (cm → m)
  tint?: string;
  alphaTest?: number;
}

function StaticModel({ modelPath, texturePath, position, rotation = [0, 0, 0], scale = 1, tint, alphaTest = 0.5 }: StaticModelProps) {
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

// ---------- Diorama layout ----------
//
// Grid edge ≈ ±0.98m (crate centers ±0.66, half-crate 0.32).
// Arena border: ±1.5m (W) / ±1.2m (D).
// Each diorama is centered in the corner diagonal gap.
//
// Model sizes (measured from FBX bounding boxes, in cm):
//   RitualPyre:   403×655×376   Effigy1:  215×451×71   Effigy2:  136×367×70
//   DreamCatcher: 55×154×10     Lantern1: 128×279×105  Lantern2: similar
//   Tombstone1:   81×119×18     Tombstone3: 77×126×17
//   Skull:        37×36×43      Barrel1:  70×107×73
//   Fence1:       182×132×22    FenceBroken: 173×166×29
//   Stump:        303×196×262   Log1:     302×331×1140
//   Reeds:        95×356×102    MossMound2: 120×47×98
//   SwampGrassSmall: 182×197×193  Toetoe: 266×519×148
//
// Scale formula: final_height = FBX_height_cm * 0.01 * scale
// Target: focal pieces ~35-45cm, accents ~15-25cm

const A = TEXTURES.swampAtlas;

// ---- Back-left: Graveyard ----
// Focal: glowing lantern (279cm tall)
function GraveyardDiorama() {
  const cx = -2.0;
  const cz = -1.6;
  return (
    <group>
      {/* Lantern - interactive (279cm → scale 0.14 = 39cm) */}
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
      {/* Tombstone (119cm → scale 0.20 = 24cm) */}
      <StaticModel modelPath={MODELS.tombstone1} texturePath={A} position={[cx - 0.25, 0, cz + 0.10]} rotation={[0, 0.3, 0]} scale={0.20} tint="#6a7a6a" />
      {/* Tombstone (126cm → scale 0.18 = 23cm) */}
      <StaticModel modelPath={MODELS.tombstone3} texturePath={A} position={[cx + 0.20, 0, cz - 0.06]} rotation={[0, -0.2, 0]} scale={0.18} tint="#6a7a6a" />
      {/* Skull (36cm → scale 0.50 = 18cm) */}
      <StaticModel modelPath={MODELS.skull} texturePath={A} position={[cx + 0.08, 0, cz + 0.18]} rotation={[0, 1.2, 0]} scale={0.50} />
      {/* Moss mound ground cover (47cm → scale 0.30 = 14cm) */}
      <StaticModel modelPath={MODELS.mossMound2} texturePath={TEXTURES.gradient3} position={[cx - 0.05, 0, cz + 0.02]} rotation={[0, 0.8, 0]} scale={0.30} tint="#4a7a35" />
    </group>
  );
}

// ---- Back-right: Ritual Site ----
// Focal: ritual pyre (655cm tall)
function RitualDiorama() {
  const cx = 2.0;
  const cz = -1.6;
  return (
    <group>
      {/* Ritual pyre - interactive (655cm → scale 0.05 = 33cm) */}
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
      {/* Effigy (451cm → scale 0.06 = 27cm) */}
      <StaticModel modelPath={MODELS.effigy1} texturePath={A} position={[cx + 0.22, 0, cz - 0.12]} rotation={[0, -0.8, 0]} scale={0.06} />
      {/* Broken fence (166cm → scale 0.12 = 20cm) */}
      <StaticModel modelPath={MODELS.fenceBroken} texturePath={A} position={[cx - 0.25, 0, cz + 0.08]} rotation={[0, 0.6, 0]} scale={0.12} />
      {/* Barrel (107cm → scale 0.18 = 19cm) */}
      <StaticModel modelPath={MODELS.barrel1} texturePath={A} position={[cx - 0.12, 0, cz - 0.15]} rotation={[0, 1.0, 0]} scale={0.18} />
      {/* Grass accent */}
      <StaticModel modelPath={MODELS.swampGrassSmall} texturePath={TEXTURES.swampGrass} position={[cx + 0.15, 0, cz + 0.15]} rotation={[0, -0.3, 0]} scale={0.06} />
    </group>
  );
}

// ---- Front-left: Abandoned Dock ----
// Focal: dream catcher (154cm tall)
function DockDiorama() {
  const cx = -2.2;
  const cz = 1.7;
  return (
    <group>
      {/* Dream catcher - interactive (154cm → scale 0.25 = 39cm) */}
      <InteractiveProp
        modelPath={MODELS.dreamCatcher}
        position={[cx, 0, cz]}
        rotation={[0, 0.3, 0]}
        scale={0.25}
        idleAnimation="sway"
        clickReaction="spin"
      />
      {/* Stump (196cm → scale 0.10 = 20cm) */}
      <StaticModel modelPath={MODELS.stump1} texturePath={A} position={[cx - 0.20, 0, cz - 0.10]} rotation={[0, 0.5, 0]} scale={0.10} />
      {/* Fence post (132cm → scale 0.15 = 20cm) */}
      <StaticModel modelPath={MODELS.fence1} texturePath={A} position={[cx + 0.22, 0, cz - 0.10]} rotation={[0, -0.6, 0]} scale={0.15} />
      {/* Barrel (107cm → scale 0.18 = 19cm) */}
      <StaticModel modelPath={MODELS.barrel2} texturePath={A} position={[cx + 0.10, 0, cz + 0.15]} rotation={[0, 0.8, 0]} scale={0.18} />
      {/* Reeds (356cm → scale 0.06 = 21cm) */}
      <StaticModel modelPath={MODELS.reeds1} texturePath={TEXTURES.reedsTex} position={[cx - 0.15, 0, cz + 0.18]} rotation={[0, 0.9, 0]} scale={0.06} />
    </group>
  );
}

// ---- Front-right: Spirit Shrine ----
// Focal: effigy (367cm tall)
function ShrineDiorama() {
  const cx = 2.2;
  const cz = 1.7;
  return (
    <group>
      {/* Effigy - interactive (367cm → scale 0.10 = 37cm) */}
      <InteractiveProp
        modelPath={MODELS.effigy2}
        position={[cx, 0, cz]}
        rotation={[0, -0.5, 0]}
        scale={0.10}
        idleAnimation="bob"
        clickReaction="wobble"
      />
      {/* Lantern (279cm → scale 0.10 = 28cm) */}
      <StaticModel modelPath={MODELS.lantern2} texturePath={A} position={[cx - 0.20, 0, cz + 0.10]} rotation={[0, 0.7, 0]} scale={0.10} />
      {/* Skull (36cm → scale 0.50 = 18cm) */}
      <StaticModel modelPath={MODELS.skull} texturePath={A} position={[cx + 0.16, 0, cz - 0.13]} rotation={[0, -1.0, 0]} scale={0.50} />
      {/* Barrel (107cm → scale 0.18 = 19cm) */}
      <StaticModel modelPath={MODELS.barrel2} texturePath={A} position={[cx + 0.22, 0, cz + 0.15]} rotation={[0, -0.4, 0]} scale={0.18} />
      {/* Toetoe (519cm → scale 0.04 = 21cm) */}
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
