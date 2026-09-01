import { useEffect, useState } from 'react';
import { isBuildStale, onBuildStale } from '../aztec/staleBuild';
import './StaleBuildBanner.css';

/**
 * "This tab is running a build that no longer exists."
 *
 * A deploy replaces the content-hashed chunks this tab still expects, so the
 * next lazy import fails — and the lazy import that matters here is the proving
 * code. A proof that never generates is a game that cannot be settled, with five
 * cards committed on-chain behind it, so this is not a dismissible notice.
 *
 * It does NOT reload on its own. A reload with a transaction in flight is its
 * own hazard, and the player is the one who knows whether they are mid-move.
 * The game is saved either way, which the copy says, because the fear that
 * stops someone reloading is losing the game they are in.
 */
export function StaleBuildBanner() {
  const [stale, setStale] = useState(isBuildStale);
  useEffect(() => onBuildStale(setStale), []);
  if (!stale) return null;

  return (
    <div className="stale-build" role="alert" data-testid="stale-build">
      <div className="stale-build__text">
        <strong>The game was updated while this tab was open.</strong>
        <span>
          Parts of it can no longer load, so proofs will fail until you reload.
          Your game and your cards are saved.
        </span>
      </div>
      <button
        className="stale-build__btn"
        data-testid="stale-build-reload"
        onClick={() => window.location.reload()}
      >
        Reload
      </button>
    </div>
  );
}
