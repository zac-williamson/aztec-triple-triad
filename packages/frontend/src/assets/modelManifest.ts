// Central path registry for all 3D models and textures

export const TEXTURES = {
  // Atlas textures (for UV-mapped FBX props)
  swampAtlas: '/textures/PolygonNatureBiomes_Swamp_Texture_01.png',
  swampAtlas2: '/textures/PolygonNatureBiomes_Swamp_Texture_02.png',

  // Tileable ground texture
  mudPath: '/textures/Footpath_Tiles_Mud_Texture_01.png',

  // Plant-specific textures (dedicated per-model textures, NOT atlas)
  grassSwamp: '/textures/Grass_Swamp_01.png',
  swampGrass: '/textures/SwampGrass_01.png',
  lillyPads1Tex: '/textures/LillyPads_01.png',
  lillyPads2Tex: '/textures/LillyPads_02.png',
  reedsTex: '/textures/Reeds_01.png',
  swampScum1Tex: '/textures/Swamp_Scum_01.png',
  swampScum2Tex: '/textures/Swamp_Scum_02.png',
  toetoeTex: '/textures/ToeToe_Leaf_01.png',
  branchesTex: '/textures/Branches_01.png',
  treeBeards1: '/textures/TreeBeards_01.png',
  treeBeards2: '/textures/TreeBeards_02.png',
  backgroundTreesTex: '/textures/Background_Trees_01.png',
  leafPatch05: '/textures/leafPatch_05.png',
  leafPatch07: '/textures/leafPatch_07.png',

  // Gradient textures (for CastleSHD models like moss mounds)
  gradient3: '/textures/Gradient_3.png',
  gradient4: '/textures/Gradient_4.png',

  // Water & effects
  waterNormals1: '/textures/WaterNormals_01.png',
  waterNormals2: '/textures/WaterNormals_02.png',
  waterRefraction: '/textures/Water_Refraction_Map.png',
  fogGradient: '/textures/Fog_Gradient.png',
  glow: '/textures/Grass_01_Glow_01.png',

  // Noise textures (from Swamp_Source_Files/Textures/Core)
  noiseMid: '/textures/Noise_Mid.png',
  noiseWave: '/textures/Noise_Wave.png',
  noiseBig: '/textures/Noise_Big.png',

  // Card textures
  cardBack: '/cards/card_back.png',
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

  // Ground & vegetation
  backgroundLand: '/models/SM_Env_Background_Land_01.fbx',
  grassTallClump1: '/models/SM_Env_Grass_Tall_Clump_01.fbx',
  grassTallClump2: '/models/SM_Env_Grass_Tall_Clump_02.fbx',
  grassTallClump3: '/models/SM_Env_Grass_Tall_Clump_03.fbx',
  swampGrassGroup1: '/models/SM_Env_SwampGrass_Group_01.fbx',
  swampGrassGroup2: '/models/SM_Env_SwampGrass_Group_02.fbx',
  swampGrassGroup3: '/models/SM_Env_SwampGrass_Group_03.fbx',
  swampGrassMedium: '/models/SM_Env_SwampGrass_Medium_01.fbx',
  swampGrassTall: '/models/SM_Env_SwampGrass_Tall_01.fbx',
  grassSwamp1: '/models/SM_Env_Grass_Swamp_01.fbx',
  bushBramble1: '/models/SM_Env_Bush_Bramble_01.fbx',
  bushBramble2: '/models/SM_Env_Bush_Bramble_02.fbx',
  rockSwamp: '/models/SM_Env_Rock_Swamp_01.fbx',
  swampScum1: '/models/SM_Env_Swamp_Scum_01.fbx',
  swampScum2: '/models/SM_Env_Swamp_Scum_02.fbx',
  swampLog1: '/models/SM_Prop_Swamp_Log_01.fbx',
  swampLog2: '/models/SM_Prop_Swamp_Log_02.fbx',
  stump1: '/models/SM_Prop_Stump_01.fbx',
  toetoe1: '/models/SM_Env_Toetoe_01.fbx',
  toetoe2: '/models/SM_Env_Toetoe_02.fbx',
  fence1: '/models/SM_Prop_Fence_01.fbx',
  fence2: '/models/SM_Prop_Fence_02.fbx',
  fence3: '/models/SM_Prop_Fence_03.fbx',
  fenceBroken: '/models/SM_Prop_Fence_Broken_01.fbx',
  swampLog3: '/models/SM_Prop_Swamp_Log_03.fbx',
  swampLog4: '/models/SM_Prop_Swamp_Log_04.fbx',
} as const;
