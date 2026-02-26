import { Sparkles } from '@react-three/drei';

export function Particles() {
  return (
    <group>
      {/* Fireflies - green bioluminescent */}
      <Sparkles
        count={30}
        scale={[4, 2, 4]}
        size={1.5}
        speed={0.4}
        color="#7bc67e"
        opacity={0.5}
      />

      {/* Floating spores - subtle */}
      <Sparkles
        count={15}
        scale={[3, 1.5, 3]}
        size={0.8}
        speed={0.2}
        color="#aaddaa"
        opacity={0.25}
        position={[0, 1, 0]}
      />

      {/* Warm firelight particles near lanterns */}
      <Sparkles
        count={8}
        scale={[0.5, 0.5, 0.5]}
        size={1}
        speed={0.6}
        color="#ffaa44"
        opacity={0.3}
        position={[-0.9, 0.5, -0.5]}
      />
      <Sparkles
        count={8}
        scale={[0.5, 0.5, 0.5]}
        size={1}
        speed={0.6}
        color="#ffaa44"
        opacity={0.3}
        position={[0.9, 0.5, -0.5]}
      />
    </group>
  );
}
