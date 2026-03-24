/**
 * Browser-side script to reproduce TransactionInactiveError.
 *
 * Calls the SAME connectToAztec() function that the React app uses,
 * exercising the exact same code path through the PXE's IndexedDB backend.
 */

import { connectToAztec } from './src/aztec/connectToAztec';

const log = (msg: string) => {
  const el = document.getElementById('log');
  if (el) el.textContent += '\n' + msg;
  console.log('[idb-test]', msg);
};

async function run() {
  const t0 = performance.now();
  try {
    const result = await connectToAztec({
      skipLocalStorage: true,
      log,
    });

    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    log(`\nSUCCESS in ${elapsed}s — account: ${result.accountAddress}, cards: ${JSON.stringify(result.ownedCardIds)}`);
    (window as any).__IDB_TEST_RESULT__ = {
      success: true,
      totalElapsed: elapsed,
      accountAddress: result.accountAddress,
      ownedCardIds: result.ownedCardIds,
    };
  } catch (err: any) {
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    const isIDB = err.message?.includes('TransactionInactiveError') ||
      err.message?.includes('transaction is inactive or finished') ||
      err.name === 'TransactionInactiveError';
    log(`\nFAILED in ${elapsed}s: ${err.message}`);
    (window as any).__IDB_TEST_RESULT__ = {
      success: false,
      error: err.message,
      name: err.name,
      isTransactionInactiveError: isIDB,
      totalElapsed: elapsed,
    };
  }
}

run();
