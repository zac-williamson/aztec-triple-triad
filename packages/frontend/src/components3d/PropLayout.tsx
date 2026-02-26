import { MODELS } from '../assets/modelManifest';
import { InteractiveProp } from './InteractiveProp';

// Board is ~1.2m wide, crate tops at y=0.389
// Props should be small decorations around the board edges, not scene-dominating
// Base FBX scale is 0.01 (cm→m) applied in InteractiveProp via useFBXModel
// The `scale` prop here is an ADDITIONAL multiplier on top of the 0.01 base

export function PropLayout() {
  return (
    <group>
      {/* Lanterns flanking the board - small, atmospheric */}
      <InteractiveProp
        modelPath={MODELS.lantern1}
        position={[-0.9, 0, -0.5]}
        rotation={[0, 0.3, 0]}
        scale={0.3}
        idleAnimation="glow"
        clickReaction="wobble"
        emissive="#ff8833"
        emissiveIntensity={0.4}
      />
      <InteractiveProp
        modelPath={MODELS.lantern2}
        position={[0.9, 0, -0.5]}
        rotation={[0, -0.3, 0]}
        scale={0.3}
        idleAnimation="glow"
        clickReaction="wobble"
        emissive="#ff8833"
        emissiveIntensity={0.4}
      />

      {/* Small tombstones - decorative, around board edges */}
      <InteractiveProp
        modelPath={MODELS.tombstone1}
        position={[-1.2, 0, 0.2]}
        rotation={[0, -0.2, 0]}
        scale={0.25}
        idleAnimation="none"
        clickReaction="wobble"
        tint="#6a7a6a"
      />
      <InteractiveProp
        modelPath={MODELS.tombstone3}
        position={[1.2, 0, 0.2]}
        rotation={[0, 0.2, 0]}
        scale={0.25}
        idleAnimation="none"
        clickReaction="wobble"
        tint="#6a7a6a"
      />

      {/* Skull - tiny accent piece */}
      <InteractiveProp
        modelPath={MODELS.skull}
        position={[0.7, 0, -0.9]}
        rotation={[0, -0.8, 0]}
        scale={0.2}
        idleAnimation="bob"
        clickReaction="spin"
      />

      {/* Barrels - small flanking pieces */}
      <InteractiveProp
        modelPath={MODELS.barrel1}
        position={[-1.0, 0, 0.8]}
        rotation={[0, 1.2, 0]}
        scale={0.25}
        idleAnimation="none"
        clickReaction="bounce"
      />
      <InteractiveProp
        modelPath={MODELS.barrel2}
        position={[1.0, 0, 0.8]}
        rotation={[0, -1.0, 0]}
        scale={0.25}
        idleAnimation="none"
        clickReaction="bounce"
      />

      {/* Far side decorations - small */}
      <InteractiveProp
        modelPath={MODELS.tombstone2}
        position={[-0.6, 0, -1.2]}
        rotation={[0, 0.4, 0]}
        scale={0.2}
        idleAnimation="none"
        clickReaction="wobble"
        tint="#5a6a5a"
      />
      <InteractiveProp
        modelPath={MODELS.tombstone4}
        position={[0, 0, -1.4]}
        rotation={[0, 0, 0]}
        scale={0.2}
        idleAnimation="none"
        clickReaction="wobble"
        tint="#5a6a5a"
      />
    </group>
  );
}
