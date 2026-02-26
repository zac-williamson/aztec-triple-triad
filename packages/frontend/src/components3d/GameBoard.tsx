import { useState, useEffect, useMemo } from 'react';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import {
  TextureLoader, MeshStandardMaterial, RepeatWrapping,
  Group, Texture, Color,
} from 'three';
import type { Board } from '../types';
import { MODELS, TEXTURES } from '../assets/modelManifest';
import { useBoardPositions } from './hooks/useBoardPositions';
import { BoardCell3D } from './BoardCell3D';

interface GameBoardProps {
  board: Board;
  validPlacements: { row: number; col: number }[];
  capturedCells: { row: number; col: number }[];
  onCellClick?: (row: number, col: number) => void;
}

const CRATE_SCALE = 0.0035;
const CRATE_TOP = 0.375;
const SPACING = 0.385;

// ---------- Simple FBX model component (same pattern as SwampEnvironment) ----------

interface SmallModelProps {
  modelPath: string;
  texturePath: string;
  position: [number, number, number];
  rotation?: [number, number, number];
  scale?: number;
}

function SmallModel({ modelPath, texturePath, position, rotation = [0, 0, 0], scale = 0.01 }: SmallModelProps) {
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

      // FBX models from Synty have baked Unity scene positions on BOTH
      // the root group and child meshes (equal-and-opposite offsets).
      // Zero out ALL positions in the hierarchy to bring geometry to origin.
      fbx.position.set(0, 0, 0);
      fbx.rotation.set(0, 0, 0);

      let meshCount = 0;
      fbx.traverse((child: any) => {
        child.position.set(0, 0, 0);
        if (child.isMesh) {
          meshCount++;
          // Only show LOD0 (first mesh), hide LOD1 (second mesh)
          if (meshCount > 1) {
            child.visible = false;
            return;
          }
          // Use the gradient texture as a map with green color tint.
          // The CastleSHD shader in Unity uses a gradient for color ramping -
          // applying it as a diffuse map with a green tint gives natural moss variation.
          child.material = new MeshStandardMaterial({
            map: texture,
            color: new Color('#4a7a35'),
            roughness: 0.92,
            metalness: 0,
          });
          child.castShadow = true;
          child.receiveShadow = true;
        }
      });

      fbx.scale.setScalar(scale);
      setModel(fbx);
    }).catch((err) => {
      console.error('[SmallModel] LOAD FAILED:', modelPath, err);
    });

    return () => { cancelled = true; };
  }, [modelPath, texturePath, scale]);

  if (!model) return null;
  return (
    <group position={position} rotation={rotation}>
      <primitive object={model} />
    </group>
  );
}

// ---------- Per-crate configuration ----------

interface CrateConfig {
  tint: string;
  roughness: number;
  rotY: number;
}

const CRATE_CONFIGS: CrateConfig[] = [
  { tint: '#c8b898', roughness: 0.88, rotY: 0.05 },
  { tint: '#b8a888', roughness: 0.92, rotY: -0.04 },
  { tint: '#d0c0a0', roughness: 0.85, rotY: 0.07 },
  { tint: '#bab090', roughness: 0.90, rotY: -0.06 },
  { tint: '#c0b898', roughness: 0.87, rotY: 0.02 },
  { tint: '#a8a080', roughness: 0.93, rotY: -0.03 },
  { tint: '#d0c8a8', roughness: 0.86, rotY: 0.04 },
  { tint: '#b0a880', roughness: 0.91, rotY: -0.05 },
  { tint: '#c8c0a0', roughness: 0.89, rotY: 0.03 },
];

// Moss overlay definitions: which crate, which model, scale, rotation
// Scaled to be subtle corner/edge accents (~7-9cm) on 38cm crate tops:
//   MossMound_01: 222cm wide → scale 0.0004 = 8.9cm
//   MossMound_02: 120cm wide → scale 0.0006 = 7.2cm
//   MossMound_03: 207cm wide → scale 0.0004 = 8.3cm
interface MossOverlay {
  crateRow: number;
  crateCol: number;
  model: string;
  scale: number;
  rotY: number;
  offsetX: number;
  offsetZ: number;
}

const MOSS_OVERLAYS: MossOverlay[] = [
  // Top-left crate: small mound near back-left corner
  { crateRow: 0, crateCol: 0, model: MODELS.mossMound2, scale: 0.0006, rotY: 0.3,  offsetX: -0.08, offsetZ: -0.06 },
  // Top-right crate: mound near front-right edge
  { crateRow: 0, crateCol: 2, model: MODELS.mossMound3, scale: 0.0004, rotY: 1.8,  offsetX: 0.07,  offsetZ: 0.05 },
  // Middle-left crate: mound near left edge
  { crateRow: 1, crateCol: 0, model: MODELS.mossMound1, scale: 0.0004, rotY: 0.9,  offsetX: -0.07, offsetZ: 0.02 },
  // Middle-right crate: small mound near back edge
  { crateRow: 1, crateCol: 2, model: MODELS.mossMound2, scale: 0.0005, rotY: 2.5,  offsetX: 0.03,  offsetZ: -0.07 },
  // Bottom-left crate: mound near front-left corner
  { crateRow: 2, crateCol: 0, model: MODELS.mossMound3, scale: 0.0004, rotY: 4.2,  offsetX: -0.06, offsetZ: 0.07 },
  // Bottom-right crate: small mound near right edge
  { crateRow: 2, crateCol: 2, model: MODELS.mossMound1, scale: 0.00035, rotY: 1.2, offsetX: 0.08,  offsetZ: -0.03 },
  // Center crate: tiny accent near back edge
  { crateRow: 1, crateCol: 1, model: MODELS.mossMound2, scale: 0.0004, rotY: 3.1,  offsetX: 0.02,  offsetZ: -0.08 },
];

// ---------- Crate grid (just crates, no overlays) ----------

function CrateGrid() {
  const [baseModel, setBaseModel] = useState<Group | null>(null);
  const [texture, setTexture] = useState<Texture | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loader = new FBXLoader();
    const texLoader = new TextureLoader();

    Promise.all([
      new Promise<Group>((resolve, reject) => loader.load(MODELS.crate, resolve, undefined, reject)),
      new Promise<Texture>((resolve, reject) => texLoader.load(TEXTURES.swampAtlas2, resolve, undefined, reject)),
    ]).then(([fbx, tex]) => {
      if (cancelled) return;
      tex.wrapS = RepeatWrapping;
      tex.wrapT = RepeatWrapping;
      setBaseModel(fbx);
      setTexture(tex);
    });

    return () => { cancelled = true; };
  }, []);

  const crates = useMemo(() => {
    if (!baseModel || !texture) return [];

    const result: { clone: Group; position: [number, number, number] }[] = [];

    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        const idx = row * 3 + col;
        const cfg = CRATE_CONFIGS[idx];

        const clone = baseModel.clone(true);
        clone.traverse((child: any) => {
          if (child.isMesh) {
            child.material = new MeshStandardMaterial({
              map: texture,
              color: new Color(cfg.tint),
              roughness: cfg.roughness,
              metalness: 0.05,
            });
            child.castShadow = true;
            child.receiveShadow = true;
          }
        });
        clone.scale.setScalar(CRATE_SCALE);
        clone.rotation.y = cfg.rotY;

        const x = (col - 1) * SPACING;
        const z = (row - 1) * SPACING;
        result.push({ clone, position: [x, 0, z] });
      }
    }
    return result;
  }, [baseModel, texture]);

  return (
    <group>
      {crates.map((crate, i) => (
        <primitive key={i} object={crate.clone} position={crate.position} />
      ))}
    </group>
  );
}

// ---------- Main board ----------

export function GameBoard({ board, validPlacements, capturedCells, onCellClick }: GameBoardProps) {
  const { positions, cellSize } = useBoardPositions();

  const isValid = (row: number, col: number) =>
    validPlacements.some(p => p.row === row && p.col === col);
  const isCaptured = (row: number, col: number) =>
    capturedCells.some(p => p.row === row && p.col === col);

  return (
    <group>
      <CrateGrid />

      {/* Moss overlays on crate tops */}
      {MOSS_OVERLAYS.map((m, i) => {
        const worldX = (m.crateCol - 1) * SPACING + m.offsetX;
        const worldZ = (m.crateRow - 1) * SPACING + m.offsetZ;
        return (
          <SmallModel
            key={`moss-${i}`}
            modelPath={m.model}
            texturePath={TEXTURES.gradient3}
            position={[worldX, CRATE_TOP, worldZ]}
            rotation={[0, m.rotY, 0]}
            scale={m.scale}
          />
        );
      })}

      {board.map((row, r) =>
        row.map((cell, c) => (
          <BoardCell3D
            key={`${r}-${c}`}
            row={r}
            col={c}
            position={[positions[r][c].x, positions[r][c].y, positions[r][c].z]}
            cellSize={cellSize}
            cell={cell}
            isValid={isValid(r, c)}
            isCaptured={isCaptured(r, c)}
            onCellClick={onCellClick}
          />
        ))
      )}
    </group>
  );
}
