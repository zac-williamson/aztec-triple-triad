import { useSyncExternalStore, useCallback } from 'react';
import txManager, { type TxEntry } from '../aztec/txManager';

export function useTxStatus(): TxEntry[] {
  const subscribe = useCallback(
    (onStoreChange: () => void) => txManager.subscribe(onStoreChange),
    [],
  );
  const getSnapshot = useCallback(() => txManager.getEntries(), []);
  return useSyncExternalStore(subscribe, getSnapshot);
}
