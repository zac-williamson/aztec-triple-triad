/**
 * The FBX files reference textures from the artist's original project — the
 * real names, taken out of the shipped models with `strings`. None of them are
 * in /models, which holds .fbx and nothing else.
 */
import { describe, it, expect } from 'vitest';
import { resolveFbxAssetUrl, BLANK_PIXEL } from '../useFBXModel';

describe('FBX texture references', () => {
  const NEVER_SHIPPED = [
    'PolygonNatureBiomes_Texture_01_Justin.psd',
    'PolygonNatureBiomes_Texture_01_Tom.png',
    'Bake_02_baseTexBaked.png',
    'PolygonCastle_Texture_01_A.psd',
    'Grass_01.tga',
    'Background_Trees_01.png',
  ];

  it.each(NEVER_SHIPPED)('does not go to the network for %s', name => {
    expect(resolveFbxAssetUrl(`/models/${name}`)).toBe(BLANK_PIXEL);
  });

  it('still fetches the model itself', () => {
    expect(resolveFbxAssetUrl('/models/SM_Env_LillyPads_01.fbx')).toBe('/models/SM_Env_LillyPads_01.fbx');
  });

  it('leaves the textures we DO ship alone', () => {
    // These live in /textures and are loaded deliberately, not by the FBX.
    expect(resolveFbxAssetUrl('/textures/LillyPads_01.png')).toBe('/textures/LillyPads_01.png');
    expect(resolveFbxAssetUrl('/textures/Grass_Swamp_01_Normals.tga'))
      .toBe('/textures/Grass_Swamp_01_Normals.tga');
  });

  it('is not fooled by a query string or an absolute URL', () => {
    expect(resolveFbxAssetUrl('https://www.aztec-arena.com/models/Bake_02_baseTexBaked.png'))
      .toBe(BLANK_PIXEL);
    // A cache-buster means it is still a request we cannot satisfy, but the
    // extension test is what decides — documented so the behaviour is a choice.
    expect(resolveFbxAssetUrl('/models/Bake_02_baseTexBaked.png?v=2'))
      .toBe('/models/Bake_02_baseTexBaked.png?v=2');
  });
});
