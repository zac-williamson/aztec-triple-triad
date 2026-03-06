import { useMemo, useEffect, useState } from 'react';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { TextureLoader, MeshStandardMaterial, RepeatWrapping, Group, Texture } from 'three';
import { TEXTURES } from '../../assets/modelManifest';

// Shared cache for loaded assets — exported so all model components can reuse
const modelCache = new Map<string, Group>();
const textureCache = new Map<string, Texture>();
const modelPromises = new Map<string, Promise<Group>>();
const texturePromises = new Map<string, Promise<Texture>>();

// Singleton loaders
const _fbxLoader = new FBXLoader();
const _texLoader = new TextureLoader();

/**
 * Strip a loaded FBX group down to only the lowest-LOD mesh.
 * Synty models contain LOD0 (high), LOD1 (medium), LOD2 (low) meshes.
 * We keep only the lowest-poly mesh and dispose the rest, reducing GPU memory.
 */
function stripToLowestLOD(group: Group): void {
  const meshes: any[] = [];
  group.traverse((child: any) => {
    if (child.isMesh) meshes.push(child);
  });
  if (meshes.length <= 1) return;

  // Find the mesh with the fewest vertices (lowest LOD)
  let bestMesh = meshes[0];
  let bestVerts = bestMesh.geometry?.attributes?.position?.count ?? Infinity;
  for (let i = 1; i < meshes.length; i++) {
    const verts = meshes[i].geometry?.attributes?.position?.count ?? Infinity;
    if (verts < bestVerts) {
      bestVerts = verts;
      bestMesh = meshes[i];
    }
  }

  // Remove and dispose all meshes except the best
  for (const mesh of meshes) {
    if (mesh !== bestMesh) {
      mesh.geometry?.dispose();
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach((m: any) => m.dispose());
      } else {
        mesh.material?.dispose();
      }
      mesh.removeFromParent();
    }
  }
}

export function loadModel(path: string): Promise<Group> {
  if (modelCache.has(path)) return Promise.resolve(modelCache.get(path)!);
  if (modelPromises.has(path)) return modelPromises.get(path)!;
  const p = new Promise<Group>((resolve, reject) => {
    _fbxLoader.load(path, (group) => {
      stripToLowestLOD(group);
      modelCache.set(path, group);
      modelPromises.delete(path);
      resolve(group);
    }, undefined, reject);
  });
  modelPromises.set(path, p);
  return p;
}

export const loadFBX = loadModel;

export function loadTexture(path: string): Promise<Texture> {
  if (textureCache.has(path)) return Promise.resolve(textureCache.get(path)!);
  if (texturePromises.has(path)) return texturePromises.get(path)!;
  const p = new Promise<Texture>((resolve, reject) => {
    _texLoader.load(path, (tex) => {
      textureCache.set(path, tex);
      texturePromises.delete(path);
      resolve(tex);
    }, undefined, reject);
  });
  texturePromises.set(path, p);
  return p;
}

export function useFBXModel(
  modelPath: string,
  texturePath: string = TEXTURES.swampAtlas,
  options?: {
    scale?: number;
    tint?: string;
    emissive?: string;
    emissiveIntensity?: number;
  }
): Group {
  const [model, setModel] = useState<Group | null>(() => modelCache.get(modelPath) ?? null);
  const [texture, setTexture] = useState<Texture | null>(() => textureCache.get(texturePath) ?? null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadModel(modelPath), loadTexture(texturePath)]).then(([m, t]) => {
      if (!cancelled) {
        setModel(m);
        setTexture(t);
      }
    });
    return () => { cancelled = true; };
  }, [modelPath, texturePath]);

  const result = useMemo(() => {
    if (!model || !texture) return new Group();

    const clone = model.clone(true);

    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;

    clone.traverse((child: any) => {
      if (child.isMesh) {
        const mat = new MeshStandardMaterial({
          map: texture,
          roughness: 0.8,
          metalness: 0.1,
          transparent: true,
          alphaTest: 0.5,
        });
        if (options?.tint) {
          mat.color.set(options.tint);
        }
        if (options?.emissive) {
          mat.emissive.set(options.emissive);
          mat.emissiveIntensity = options?.emissiveIntensity ?? 0.3;
        }
        child.material = mat;
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });

    if (options?.scale) {
      clone.scale.setScalar(options.scale);
    }

    return clone;
  }, [model, texture, options?.scale, options?.tint, options?.emissive, options?.emissiveIntensity]);

  return result;
}
