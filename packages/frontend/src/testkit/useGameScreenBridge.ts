import { useEffect } from 'react';
import { TESTKIT_ENABLED } from './enabled';
import { publishGameScreen } from './registry';

/**
 * GameScreen-level bridge — exposes the interaction gates that live in
 * GameScreen3D component state: which hand card is selected, and whether a
 * fly/capture animation is in progress (the click handlers ignore input
 * while one runs). Published every render; cleared on unmount.
 */
export function useGameScreenBridge(
  selectedCardIndex: number | null,
  flying: boolean,
  cascading: boolean,
): void {
  useEffect(() => {
    if (!TESTKIT_ENABLED) return;
    publishGameScreen({ selectedCardIndex, flying, cascading });
  });

  useEffect(() => {
    if (!TESTKIT_ENABLED) return;
    return () => publishGameScreen(null);
  }, []);
}
