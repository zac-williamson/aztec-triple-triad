import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';
import './testkit/install'; // no-op unless VITE_TESTKIT=1 (lane 8 playtest harness)
import { watchForStaleBuild } from './aztec/staleBuild';

// Before anything lazy-loads: a deploy replaces this build's chunks, and the
// first failure is usually a proof that silently never generates.
watchForStaleBuild();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
