import { useState, useCallback, useMemo } from 'react';
import type { Card } from '../../types';

export interface CaptureAnimationEntry {
  row: number;
  col: number;
  card: Card;
  oldOwner: 'blue' | 'red';
  newOwner: 'blue' | 'red';
}

export function useCaptureAnimation() {
  const [queue, setQueue] = useState<CaptureAnimationEntry[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);

  const pendingCells = useMemo(() => {
    const set = new Set<string>();
    for (let i = Math.max(0, activeIndex); i < queue.length; i++) {
      set.add(`${queue[i].row},${queue[i].col}`);
    }
    return set;
  }, [queue, activeIndex]);

  const activeCaptureEntry = activeIndex >= 0 && activeIndex < queue.length
    ? queue[activeIndex]
    : null;

  const isCascadeActive = activeIndex >= 0 && activeIndex < queue.length;

  const startCascade = useCallback((entries: CaptureAnimationEntry[]) => {
    if (entries.length === 0) return;
    setQueue(entries);
    setActiveIndex(0);
  }, []);

  const onCaptureAnimComplete = useCallback(() => {
    setActiveIndex(prev => {
      const next = prev + 1;
      if (next >= queue.length) {
        // Cascade done — reset on next tick to avoid stale renders
        return next;
      }
      return next;
    });
  }, [queue.length]);

  const isCellCaptureAnimating = useCallback(
    (row: number, col: number) => {
      return activeCaptureEntry !== null &&
        activeCaptureEntry.row === row &&
        activeCaptureEntry.col === col;
    },
    [activeCaptureEntry],
  );

  const isCellCapturePending = useCallback(
    (row: number, col: number) => {
      return pendingCells.has(`${row},${col}`);
    },
    [pendingCells],
  );

  return {
    queue,
    activeIndex,
    activeCaptureEntry,
    isCascadeActive,
    startCascade,
    onCaptureAnimComplete,
    isCellCaptureAnimating,
    isCellCapturePending,
  };
}
