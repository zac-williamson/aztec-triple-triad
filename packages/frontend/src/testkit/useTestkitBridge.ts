import { useEffect } from 'react';
import type { UseAztecReturn } from '../hooks/useAztec';
import type { UseGameReturn } from '../hooks/useGame';
import { TESTKIT_ENABLED } from './enabled';
import { publishApp } from './registry';

/**
 * App-level bridge — the single testkit hook called from AppInner.
 * Publishes the live aztec/game hook values into the testkit registry on
 * every render. No-op (and no registry import side effects) in production.
 */
export function useTestkitBridge(aztec: UseAztecReturn, game: UseGameReturn): void {
  useEffect(() => {
    if (!TESTKIT_ENABLED) return;
    publishApp(aztec, game);
  });
}
