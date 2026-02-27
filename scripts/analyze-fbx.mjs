/**
 * Analyze FBX models to understand mesh structure, material names, and UV bounds.
 * This helps determine which meshes use atlas UVs vs dedicated texture UVs.
 *
 * Usage: node scripts/analyze-fbx.mjs
 */

import { readFileSync } from 'fs';
import { join } from 'path';

// Polyfill minimal DOM APIs required by FBXLoader when parsing embedded textures
// FBXLoader calls document.createElement('img') for embedded image data
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    createElement(tag) {
      if (tag === 'img') {
        return {
          src: '',
          width: 0,
          height: 0,
          onload: null,
          onerror: null,
          set crossOrigin(v) {},
          addEventListener() {},
          removeEventListener() {},
        };
      }
      if (tag === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext() {
            return {
              drawImage() {},
              getImageData() { return { data: new Uint8Array(0) }; },
              putImageData() {},
              createImageData() { return { data: new Uint8Array(0) }; },
            };
          },
          toDataURL() { return ''; },
        };
      }
      return {};
    },
    createElementNS(ns, tag) {
      return this.createElement(tag);
    },
  };
}
if (typeof globalThis.self === 'undefined') {
  globalThis.self = globalThis;
}
if (typeof globalThis.window === 'undefined') {
  globalThis.window = globalThis;
}
if (typeof globalThis.Blob === 'undefined') {
  globalThis.Blob = class Blob {
    constructor(parts, opts) { this._parts = parts; this._opts = opts; }
  };
}
if (typeof globalThis.URL === 'undefined' || !globalThis.URL.createObjectURL) {
  const origURL = globalThis.URL;
  globalThis.URL = class extends origURL {
    static createObjectURL(blob) { return 'blob:mock'; }
    static revokeObjectURL(url) {}
  };
}
if (typeof globalThis.atob === 'undefined') {
  globalThis.atob = (str) => Buffer.from(str, 'base64').toString('binary');
}

// Three.js imports
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

// Models to analyze
const MODELS_DIR = join(import.meta.dirname, '..', 'packages', 'frontend', 'public', 'models');

const modelsToAnalyze = [
  'SM_Env_Grass_Tall_Clump_01.fbx',
  'SM_Prop_Swamp_Lantern_01.fbx',
  'SM_Prop_Tombstone_01.fbx',
  'SM_Env_SwampGrass_Small_01.fbx',
  'SM_Env_Bush_Bramble_01.fbx',
  'SM_Env_Toetoe_01.fbx',
  'SM_Env_Swamp_Scum_01.fbx',
  'SM_Prop_Barrel_01.fbx',
  'SM_Env_Rock_Swamp_01.fbx',
  'SM_Env_SwampGrass_Group_01.fbx',
  'SM_Env_Grass_Swamp_01.fbx',
  'SM_Env_SwampGrass_Medium_01.fbx',
];

function analyzeModel(filename) {
  const filepath = join(MODELS_DIR, filename);
  let buffer;
  try {
    buffer = readFileSync(filepath);
  } catch (e) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`ERROR: Could not read ${filename}: ${e.message}`);
    return;
  }

  const loader = new FBXLoader();
  let fbx;
  try {
    // FBXLoader.parse expects an ArrayBuffer
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    fbx = loader.parse(arrayBuffer, '');
  } catch (e) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`ERROR: Could not parse ${filename}: ${e.message}`);
    return;
  }

  console.log(`\n${'='.repeat(80)}`);
  console.log(`MODEL: ${filename}`);
  console.log(`${'='.repeat(80)}`);

  let meshCount = 0;
  const meshes = [];

  fbx.traverse((child) => {
    if (child.isMesh) {
      meshCount++;
      const mesh = child;
      const meshInfo = {
        name: mesh.name,
        materials: [],
        uvBounds: null,
        vertexCount: 0,
        hasMultipleMaterials: false,
      };

      // Vertex count
      if (mesh.geometry && mesh.geometry.attributes.position) {
        meshInfo.vertexCount = mesh.geometry.attributes.position.count;
      }

      // Material info
      if (Array.isArray(mesh.material)) {
        meshInfo.hasMultipleMaterials = true;
        mesh.material.forEach((mat, idx) => {
          meshInfo.materials.push({
            index: idx,
            name: mat.name || '(unnamed)',
            type: mat.type,
            color: mat.color ? `#${mat.color.getHexString()}` : 'none',
            mapName: mat.map ? (mat.map.name || mat.map.image?.src || '(has map)') : 'none',
          });
        });
      } else if (mesh.material) {
        const mat = mesh.material;
        meshInfo.materials.push({
          index: 0,
          name: mat.name || '(unnamed)',
          type: mat.type,
          color: mat.color ? `#${mat.color.getHexString()}` : 'none',
          mapName: mat.map ? (mat.map.name || mat.map.image?.src || '(has map)') : 'none',
        });
      }

      // UV bounds analysis
      if (mesh.geometry && mesh.geometry.attributes.uv) {
        const uv = mesh.geometry.attributes.uv;
        let minU = Infinity, maxU = -Infinity;
        let minV = Infinity, maxV = -Infinity;
        for (let i = 0; i < uv.count; i++) {
          const u = uv.getX(i);
          const v = uv.getY(i);
          if (u < minU) minU = u;
          if (u > maxU) maxU = u;
          if (v < minV) minV = v;
          if (v > maxV) maxV = v;
        }
        meshInfo.uvBounds = {
          minU: minU.toFixed(4),
          maxU: maxU.toFixed(4),
          minV: minV.toFixed(4),
          maxV: maxV.toFixed(4),
          rangeU: (maxU - minU).toFixed(4),
          rangeV: (maxV - minV).toFixed(4),
        };
      } else {
        meshInfo.uvBounds = 'NO UVs';
      }

      // Check for geometry groups (sub-meshes with different material indices)
      if (mesh.geometry && mesh.geometry.groups && mesh.geometry.groups.length > 0) {
        meshInfo.groups = mesh.geometry.groups.map(g => ({
          materialIndex: g.materialIndex,
          start: g.start,
          count: g.count,
        }));
      }

      meshes.push(meshInfo);
    }
  });

  console.log(`\nTotal meshes: ${meshCount}`);

  meshes.forEach((m, i) => {
    console.log(`\n--- Mesh ${i + 1}: "${m.name}" ---`);
    console.log(`  Vertices: ${m.vertexCount}`);
    console.log(`  Has multiple materials: ${m.hasMultipleMaterials}`);
    console.log(`  Materials:`);
    m.materials.forEach((mat) => {
      console.log(`    [${mat.index}] name="${mat.name}" type=${mat.type} color=${mat.color} map=${mat.mapName}`);
    });
    if (m.uvBounds === 'NO UVs') {
      console.log(`  UV Bounds: NO UVs`);
    } else if (m.uvBounds) {
      console.log(`  UV Bounds: U=[${m.uvBounds.minU}, ${m.uvBounds.maxU}] V=[${m.uvBounds.minV}, ${m.uvBounds.maxV}]`);
      console.log(`  UV Range:  dU=${m.uvBounds.rangeU}  dV=${m.uvBounds.rangeV}`);

      // Interpretation
      const rangeU = parseFloat(m.uvBounds.rangeU);
      const rangeV = parseFloat(m.uvBounds.rangeV);
      const maxU = parseFloat(m.uvBounds.maxU);
      const maxV = parseFloat(m.uvBounds.maxV);
      const minU = parseFloat(m.uvBounds.minU);
      const minV = parseFloat(m.uvBounds.minV);

      if (rangeU > 0.8 && rangeV > 0.8 && minU >= -0.05 && minV >= -0.05 && maxU <= 1.05 && maxV <= 1.05) {
        console.log(`  --> LIKELY DEDICATED TEXTURE (UVs span ~full 0-1 range)`);
      } else if (rangeU < 0.5 || rangeV < 0.5) {
        console.log(`  --> LIKELY ATLAS REGION (UVs span partial range)`);
      } else if (maxU > 1.1 || maxV > 1.1 || minU < -0.1 || minV < -0.1) {
        console.log(`  --> TILING/WRAPPING UVs (extends beyond 0-1)`);
      } else {
        console.log(`  --> MODERATE UV RANGE (could be atlas or dedicated)`);
      }
    }
    if (m.groups) {
      console.log(`  Geometry groups (sub-mesh material assignments):`);
      m.groups.forEach((g) => {
        console.log(`    materialIndex=${g.materialIndex} start=${g.start} count=${g.count}`);
      });
    }
  });
}

// Run analysis for all models
console.log('FBX MODEL ANALYSIS');
console.log('==================');
console.log(`Analyzing ${modelsToAnalyze.length} models from: ${MODELS_DIR}`);

for (const model of modelsToAnalyze) {
  analyzeModel(model);
}

console.log(`\n${'='.repeat(80)}`);
console.log('ANALYSIS COMPLETE');
console.log(`${'='.repeat(80)}`);
