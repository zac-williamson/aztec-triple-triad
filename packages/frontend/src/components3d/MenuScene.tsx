import { Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { ACESFilmicToneMapping } from 'three';
import { EffectComposer, Bloom, Vignette } from '@react-three/postprocessing';
import { ArenaSurface, BorderFrame } from './SwampFloor';
import { WaterSurface } from './WaterSurface';
import { SwampEnvironment } from './SwampEnvironment';
import { Particles } from './Particles';

function MenuSceneContent() {
  return (
    <>
      {/* Lighting */}
      <ambientLight color="#2a4a2a" intensity={0.5} />
      <directionalLight
        color="#ffeedd"
        intensity={1.5}
        position={[2, 5, 3]}
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-camera-left={-4}
        shadow-camera-right={4}
        shadow-camera-top={4}
        shadow-camera-bottom={-4}
      />
      <pointLight color="#44aa66" intensity={0.6} position={[-2, 2, -1]} distance={6} />
      <pointLight color="#4466aa" intensity={0.4} position={[2, 2, 1]} distance={6} />

      <fog attach="fog" args={['#0a1a0a', 4, 12]} />

      {/* Arena ground + border frame */}
      <ArenaSurface />
      <BorderFrame />

      <Suspense fallback={null}>
        <WaterSurface />
      </Suspense>

      <SwampEnvironment />
      <Particles />

      <EffectComposer>
        <Bloom luminanceThreshold={0.6} luminanceSmoothing={0.5} intensity={0.5} />
        <Vignette darkness={0.5} offset={0.3} />
      </EffectComposer>
    </>
  );
}

export function MenuScene() {
  return (
    <Canvas
      shadows
      gl={{
        antialias: true,
        toneMapping: ACESFilmicToneMapping,
        toneMappingExposure: 1.0,
      }}
      camera={{ position: [0, 4.5, 2.5], fov: 45, near: 0.01, far: 50 }}
      style={{ position: 'fixed', inset: 0, width: '100%', height: '100%' }}
    >
      <Suspense fallback={null}>
        <MenuSceneContent />
      </Suspense>
    </Canvas>
  );
}
