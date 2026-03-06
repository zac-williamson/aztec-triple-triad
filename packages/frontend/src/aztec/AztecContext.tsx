import { createContext, useContext, useEffect, useRef } from 'react';
import { useAztec, type UseAztecReturn } from '../hooks/useAztec';

const AztecContext = createContext<UseAztecReturn | null>(null);

/**
 * Provider that manages Aztec wallet connection and exposes it to the tree.
 * Auto-connects on mount.
 */
export function AztecProvider({ children }: { children: React.ReactNode }) {
  const aztec = useAztec();
  const connectAttempted = useRef(false);

  useEffect(() => {
    if (aztec.status === 'disconnected' && !connectAttempted.current) {
      connectAttempted.current = true;
      aztec.connect();
    }
  }, [aztec.status, aztec.connect]);

  return (
    <AztecContext.Provider value={aztec}>
      {children}
    </AztecContext.Provider>
  );
}

/**
 * Access Aztec wallet state from any component in the tree.
 * Must be used within an AztecProvider.
 */
export function useAztecContext(): UseAztecReturn {
  const ctx = useContext(AztecContext);
  if (!ctx) throw new Error('useAztecContext must be used within AztecProvider');
  return ctx;
}
