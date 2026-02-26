import { useMemo, useEffect, useState } from 'react';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { TextureLoader, MeshStandardMaterial, RepeatWrapping, Group, Texture } from 'three';
import { TEXTURES } from '../../assets/modelManifest';

// Simple sync cache for loaded assets
const fbxCache = new Map<string, Group>();
const textureCache = new Map<string, Texture>();

function loadFBX(path: string): Promise<Group> {
  if (fbxCache.has(path)) return Promise.resolve(fbxCache.get(path)!);
  return new Promise((resolve, reject) => {
    new FBXLoader().load(path, (group) => {
      fbxCache.set(path, group);
      resolve(group);
    }, undefined, reject);
  });
}

function loadTexture(path: string): Promise<Texture> {
  if (textureCache.has(path)) return Promise.resolve(textureCache.get(path)!);
  return new Promise((resolve, reject) => {
    new TextureLoader().load(path, (tex) => {
      textureCache.set(path, tex);
      resolve(tex);
    }, undefined, reject);
  });
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
  const [fbx, setFbx] = useState<Group | null>(() => fbxCache.get(modelPath) ?? null);
  const [texture, setTexture] = useState<Texture | null>(() => textureCache.get(texturePath) ?? null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadFBX(modelPath), loadTexture(texturePath)]).then(([f, t]) => {
      if (!cancelled) {
        setFbx(f);
        setTexture(t);
      }
    });
    return () => { cancelled = true; };
  }, [modelPath, texturePath]);

  const model = useMemo(() => {
    if (!fbx || !texture) return new Group();

    const clone = fbx.clone(true);

    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;

    clone.traverse((child: any) => {
      if (child.isMesh) {
        const mat = new MeshStandardMaterial({
          map: texture,
          roughness: 0.8,
          metalness: 0.1,
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
  }, [fbx, texture, options?.scale, options?.tint, options?.emissive, options?.emissiveIntensity]);

  return model;
}
