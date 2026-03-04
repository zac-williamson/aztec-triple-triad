import { useState, useEffect, useCallback } from 'react';
import { useCardPacks, LOCATIONS, type LocationInfo } from '../hooks/useCardPacks';
import './CardPacks.css';

const LOCATION_ICONS: Record<string, string> = {
  River: '\uD83C\uDF0A',     // 🌊
  Forest: '\uD83C\uDF32',    // 🌲
  Beach: '\uD83C\uDFD6\uFE0F', // 🏖️
  City: '\uD83C\uDFD9\uFE0F',  // 🏙️
  Dockyard: '\u2693',        // ⚓
};

const LOCATION_HUNT_IMAGES: Record<string, { src: string; frames: number }> = {
  River: { src: '/ui-elements/swamp.png', frames: 4 },
  Forest: { src: '/ui-elements/forest.png', frames: 4 },
  Beach: { src: '/ui-elements/beach.png', frames: 4 },
  City: { src: '/ui-elements/city.png', frames: 5 },
  Dockyard: { src: '/ui-elements/docks.png', frames: 4 },
};

interface CardPacksProps {
  wallet: unknown | null;
  accountAddress: string | null;
  ownedCardIds: number[];
  onPackOpened: (location: string, cardIds: number[]) => void;
  onBack: () => void;
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return '00:00:00';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function CardPacks({ wallet, accountAddress, ownedCardIds, onPackOpened, onBack }: CardPacksProps) {
  const packs = useCardPacks(wallet, accountAddress);
  const [now, setNow] = useState(Date.now());

  // Tick countdown every second
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const handleHunt = useCallback(async (location: LocationInfo) => {
    try {
      const cardIds = await packs.hunt(location);
      onPackOpened(location.name, cardIds);
    } catch {
      // Error handled internally by useCardPacks
    }
  }, [packs, onPackOpened]);

  return (
    <div className="card-packs">
      <button className="card-packs__back" onClick={onBack}>
        &#8592; Back
      </button>

      <h1 className="card-packs__title">Card Packs</h1>
      <p className="card-packs__subtitle">Hunt for new axolotls in the wild</p>

      <div className="card-packs__grid">
        {LOCATIONS.map(loc => {
          const cooldownEnd = packs.cooldowns[loc.id] || 0;
          const isOnCooldown = cooldownEnd > now;
          const isHunting = packs.activeLocation === loc.name;
          const remainingMs = isOnCooldown ? cooldownEnd - now : 0;

          return (
            <div key={loc.id} className="card-packs__location">
              <span className="card-packs__location-icon">
                {LOCATION_ICONS[loc.name] || '?'}
              </span>
              <span className="card-packs__location-name">{loc.name}</span>
              <span className="card-packs__location-desc">{loc.description}</span>
              <span className="card-packs__location-cooldown">
                Cooldown: {loc.cooldownHours}h
              </span>

              {isHunting ? (
                <div className="card-packs__hunting">
                  {(() => {
                    const hunt = LOCATION_HUNT_IMAGES[loc.name] || { src: '/ui-elements/swamp.png', frames: 4 };
                    return (
                      <div
                        className="card-packs__hunting-sprite"
                        style={{
                          backgroundImage: `url('${hunt.src}')`,
                          backgroundSize: `${hunt.frames * 100}% 100%`,
                          animationTimingFunction: `steps(${hunt.frames})`,
                        } as React.CSSProperties}
                      />
                    );
                  })()}
                  <div className="card-packs__hunting-overlay">
                    <div className="card-packs__hunting-text">Hunting...</div>
                    <div className="card-packs__spinner" />
                  </div>
                </div>
              ) : isOnCooldown ? (
                <span className="card-packs__timer">{formatCountdown(remainingMs)}</span>
              ) : (
                <button
                  className="card-packs__hunt-btn"
                  onClick={() => handleHunt(loc)}
                  disabled={packs.txStatus === 'sending' || packs.txStatus === 'confirming'}
                >
                  Hunt
                </button>
              )}
            </div>
          );
        })}
      </div>

      {packs.error && (
        <div className="card-packs__error">{packs.error}</div>
      )}

      {/* Full-screen hunting overlay */}
      {packs.activeLocation && (
        <div className="card-packs__hunt-overlay">
          <div className="card-packs__hunt-overlay-scene">
            {(() => {
              const hunt = LOCATION_HUNT_IMAGES[packs.activeLocation] || { src: '/ui-elements/swamp.png', frames: 4 };
              return (
                <div
                  className="card-packs__hunt-overlay-sprite"
                  style={{
                    backgroundImage: `url('${hunt.src}')`,
                    backgroundSize: `${hunt.frames * 100}% 100%`,
                    animationTimingFunction: `steps(${hunt.frames})`,
                  } as React.CSSProperties}
                />
              );
            })()}
            <div className="card-packs__hunt-overlay-fireflies">
              <div className="card-packs__hunt-firefly" />
              <div className="card-packs__hunt-firefly" />
              <div className="card-packs__hunt-firefly" />
            </div>
          </div>
          <h2 className="card-packs__hunt-overlay-title">
            Hunting in {packs.activeLocation}...
          </h2>
          <p className="card-packs__hunt-overlay-status">
            {packs.txStatus === 'sending' ? 'Sending transaction to Aztec...' : 'Waiting for confirmation...'}
          </p>
          <div className="card-packs__spinner card-packs__spinner--large" />
        </div>
      )}
    </div>
  );
}
