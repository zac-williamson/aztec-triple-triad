import { useState, useEffect, useCallback, Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { getCardById } from '../cards';
import { SparkBurst } from '../components3d/SparkBurst';
import './PackOpening.css';

type Phase = 'pack-idle' | 'pack-shudder' | 'explosion' | 'reveal' | 'dissolve';

interface PackOpeningProps {
  location: string;
  cardIds: number[];
  onComplete: () => void;
}

function ExplosionScene() {
  return (
    <>
      <ambientLight intensity={0.5} />
      <SparkBurst position={[0, 0, 0]} color="#ffaa22" count={60} duration={1.2} />
      <SparkBurst position={[0.1, 0, -0.1]} color="#ff6600" count={40} duration={1.0} />
      <SparkBurst position={[-0.1, 0, 0.1]} color="#ffffff" count={20} duration={0.8} />
    </>
  );
}

export function PackOpening({ location, cardIds, onComplete }: PackOpeningProps) {
  const [phase, setPhase] = useState<Phase>('pack-idle');
  const [flipped, setFlipped] = useState<Set<number>>(new Set());
  const allFlipped = flipped.size >= cardIds.length;

  // Phase transitions
  useEffect(() => {
    // A: idle for 1s then shudder
    const t1 = setTimeout(() => setPhase('pack-shudder'), 1000);
    // B: shudder for 2s then explosion
    const t2 = setTimeout(() => setPhase('explosion'), 3000);
    // C: explosion for 1.5s then reveal
    const t3 = setTimeout(() => setPhase('reveal'), 4500);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, []);

  const handleFlip = useCallback((idx: number) => {
    if (phase !== 'reveal') return;
    setFlipped(prev => {
      const next = new Set(prev);
      next.add(idx);
      return next;
    });
  }, [phase]);

  const handleContinue = useCallback(() => {
    if (!allFlipped) return;
    setPhase('dissolve');
    setTimeout(onComplete, 800);
  }, [allFlipped, onComplete]);

  const cards = cardIds.map(id => getCardById(id));

  // Pack display phases
  if (phase === 'pack-idle' || phase === 'pack-shudder') {
    const packClass = phase === 'pack-idle' ? 'pack-opening__pack--idle' : 'pack-opening__pack--shudder';
    return (
      <div className="pack-opening">
        <div className={`pack-opening__pack ${packClass}`}>
          <img
            className="pack-opening__pack-img"
            src="/ui-elements/card-pack.png"
            alt="Card Pack"
            draggable={false}
          />
        </div>
      </div>
    );
  }

  // Explosion phase
  if (phase === 'explosion') {
    return (
      <div className="pack-opening">
        <div className="pack-opening__explosion">
          <Canvas camera={{ position: [0, 0, 2], fov: 60 }}>
            <Suspense fallback={null}>
              <ExplosionScene />
            </Suspense>
          </Canvas>
        </div>
      </div>
    );
  }

  // Reveal + dissolve phases
  return (
    <div className="pack-opening" onClick={allFlipped ? handleContinue : undefined}>
      <div className="pack-opening__cards">
        {cards.map((card, idx) => {
          const isFlipped = flipped.has(idx);
          const isDissolving = phase === 'dissolve';

          return (
            <div
              key={idx}
              className={`pack-opening__card-wrapper ${isDissolving ? 'pack-opening__card-wrapper--dissolving' : ''}`}
              style={{ '--dissolve-delay': `${idx * 0.05}s` } as React.CSSProperties}
              onClick={() => handleFlip(idx)}
            >
              <div className={`pack-opening__card-flipper ${isFlipped ? 'pack-opening__card-flipper--flipped' : ''}`}>
                <div className="pack-opening__card-back">
                  <img
                    className="pack-opening__card-back-img"
                    src="/cards/card_back.png"
                    alt="Card back"
                    draggable={false}
                    style={{ '--wobble-delay': `${idx * 0.15}s` } as React.CSSProperties}
                  />
                </div>
                <div className={`pack-opening__card-front ${isFlipped ? 'pack-opening__card-glow' : ''}`}>
                  <img
                    className="pack-opening__card-front-img"
                    src={card ? `/cards/final/card-${card.id}.png` : ''}
                    alt={card?.name || 'Unknown card'}
                    draggable={false}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {allFlipped && phase === 'reveal' && (
        <div className="pack-opening__continue">
          Click anywhere to continue
        </div>
      )}
    </div>
  );
}
