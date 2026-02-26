// Central path registry for all 3D models and textures

export const TEXTURES = {
  swampAtlas: '/textures/PolygonNatureBiomes_Swamp_Texture_01.png',
  swampAtlas2: '/textures/PolygonNatureBiomes_Swamp_Texture_02.png',
  waterNormals1: '/textures/WaterNormals_01.png',
  waterNormals2: '/textures/WaterNormals_02.png',
  waterRefraction: '/textures/Water_Refraction_Map.png',
  noiseMid: '/textures/Noise_Mid.png',
  noiseWave: '/textures/Noise_Wave.png',
  noiseBig: '/textures/Noise_Big.png',
  glow: '/textures/Grass_01_Glow_01.png',
  gradient3: '/textures/Gradient_3.png',
  gradient4: '/textures/Gradient_4.png',
} as const;

export const MODELS = {
  // P0 - Core
  table: '/models/SM_Prop_Wooden_Table_01.fbx',
  crate: '/models/SM_Prop_Crate_02.fbx',
  mossMound1: '/models/SM_Env_MossMound_01.fbx',
  mossMound2: '/models/SM_Env_MossMound_02.fbx',
  mossMound3: '/models/SM_Env_MossMound_03.fbx',
  swampGrassSmall: '/models/SM_Env_SwampGrass_Small_01.fbx',
  swampLeaves1: '/models/SM_Env_Swamp_Leaves_01.fbx',
  swampLeaves2: '/models/SM_Env_Swamp_Leaves_02.fbx',
  waterPlane: '/models/SM_Env_Water_Plane_01.fbx',
  fogRing: '/models/SM_Env_Fog_Ring_01.fbx',

  // P1 - Interactive Props
  lantern1: '/models/SM_Prop_Swamp_Lantern_01.fbx',
  lantern2: '/models/SM_Prop_Swamp_Lantern_02.fbx',
  tombstone1: '/models/SM_Prop_Tombstone_01.fbx',
  tombstone2: '/models/SM_Prop_Tombstone_02.fbx',
  tombstone3: '/models/SM_Prop_Tombstone_03.fbx',
  tombstone4: '/models/SM_Prop_Tombstone_04.fbx',
  skull: '/models/SM_Prop_Bone_Skull_01.fbx',
  barrel1: '/models/SM_Prop_Barrel_01.fbx',
  barrel2: '/models/SM_Prop_Barrel_02.fbx',

  // P2 - Environment
  treeDead1: '/models/SM_Env_Tree_Dead_01.fbx',
  treeDead2: '/models/SM_Env_Tree_Dead_02.fbx',
  lillyPads1: '/models/SM_Env_LillyPads_01.fbx',
  lillyPads2: '/models/SM_Env_LillyPads_02.fbx',
  reeds1: '/models/SM_Env_Reeds_01.fbx',
  reeds2: '/models/SM_Env_Reeds_02.fbx',
  dreamCatcher: '/models/SM_Prop_DreamCatcher_01.fbx',
  canoe: '/models/SM_Prop_Canoe_01.fbx',

  // P3 - Background atmosphere
  treeSwamp3: '/models/SM_Env_Tree_Swamp_03.fbx',
  treeSwamp4: '/models/SM_Env_Tree_Swamp_04.fbx',
  effigy1: '/models/SM_Prop_Effigy_01.fbx',
  effigy2: '/models/SM_Prop_Effigy_02.fbx',
  ritualPyre: '/models/SM_Prop_Swamp_RitualPyre_01.fbx',
} as const;
