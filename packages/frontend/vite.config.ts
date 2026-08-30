import { defineConfig, searchForWorkspaceRoot } from 'vite';
import react from '@vitejs/plugin-react';
import { nodePolyfills, type PolyfillOptions } from 'vite-plugin-node-polyfills';

const nodeModulesPath = `${searchForWorkspaceRoot(process.cwd())}/node_modules`;

// Fix for vite-plugin-node-polyfills resolveId issue in workspaces
// See: https://github.com/davidmyersdev/vite-plugin-node-polyfills/issues/81
const nodePolyfillsFix = (options?: PolyfillOptions | undefined) => {
  return {
    ...nodePolyfills(options),
    resolveId(source: string) {
      const m =
        /^vite-plugin-node-polyfills\/shims\/(buffer|global|process)$/.exec(
          source,
        );
      if (m) {
        return `${nodeModulesPath}/vite-plugin-node-polyfills/shims/${m[1]}/dist/index.cjs`;
      }
    },
  };
};

export default defineConfig({
  plugins: [
    react(),
    nodePolyfillsFix({
      // 'util' since 5.2: the unbundled sqlite-opfs store reaches @aztec/foundation,
      // which imports util.inspect; nothing else supplies the CJS->ESM interop for it.
      include: ['buffer', 'path', 'process', 'net', 'tty', 'util'],
    }),
  ],
  server: {
    port: 3000,
    // Under the playtest harness (VITE_TESTKIT) disable HMR. Heavy client-side
    // proving blocks the page's main thread long enough for the HMR websocket
    // to miss its ping; the vite client then declares "server connection lost"
    // and RELOADS the page mid-session, after which the PXE re-init hangs on
    // interrupted IndexedDB state (the multi-game zombie-hang). The harness
    // never live-edits, so HMR is pure liability. Prod/dev are unaffected.
    hmr: process.env.VITE_TESTKIT === '1' ? false : undefined,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      // 'require-corp' enables SharedArrayBuffer in all browsers including Safari.
      // All cross-origin fetches must use CORS mode with valid CORS response headers.
      // Verified: testnet RPC returns access-control-allow-origin: * and all app
      // resources (models, textures, contracts) are same-origin.
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  assetsInclude: ['**/*.glb', '**/*.gltf', '**/*.fbx'],
  define: {
    'process.env.LOG_LEVEL': JSON.stringify(process.env.LOG_LEVEL || 'info'),
  },
  build: {
    target: 'esnext',
    // The oversized chunks are Barretenberg's WASM glue and the Aztec kernel
    // circuits — vendor artifacts, already split into their own lazily loaded
    // chunks, and not divisible by any manualChunks arrangement we control.
    // Left at the default the warning fires on every build, which is how a
    // genuine bundle regression would go unnoticed. 5 MB clears the known
    // offenders (the largest is ~4.1 MB) and still trips on a new one.
    chunkSizeWarningLimit: 5000,
  },
  optimizeDeps: {
    esbuildOptions: {
      target: 'esnext',
    },
    // Force pre-bundle CJS packages so they work as ESM imports. The sqlite-opfs
    // subpath below is excluded, so anything IT reaches must be pre-bundled here or
    // the browser gets raw CJS with no named exports (msgpackr, sha3, ...).
    // kv-store's browser build imports '#msgpackr' -> 'msgpackr/index-no-eval'
    // (the no-eval CJS bundle, chosen for CSP). Name that exact specifier: a bare
    // 'msgpackr' include resolves to the ESM entry and leaves the .cjs unbundled,
    // so the browser gets no named 'Encoder' export.
    include: ['pino', 'pino/browser', 'msgpackr', 'msgpackr/index-no-eval', 'sha3'],
    // WASM-containing packages that esbuild corrupts, plus the SQLite-OPFS store.
    //
    // As of 5.2 the browser PXE keeps state in SQLite-OPFS, and that store spawns a
    // worker via `new Worker(new URL('./worker.js', import.meta.url))`. Pre-bundling
    // rewrites import.meta.url to the .vite/deps chunk, where no worker.js exists, so
    // the worker dies on load ("SQLite worker crashed: undefined") and onboarding ends
    // in aztecStatus='error'. Only the dev optimizer is affected -- the rollup
    // production build emits the worker correctly.
    //
    // Exclude the ./sqlite-opfs SUBPATH, not all of @aztec/kv-store: the package's
    // full closure is ~326 deps (AWS SDK, Koa, Google Cloud) and unbundling it just
    // trades this for an endless run of CJS named-export failures (util.inspect,
    // sha3.Keccak, ...). The subpath's own imports are narrow, so this is the
    // smallest cut that lets the worker URL resolve.
    exclude: [
      '@aztec/noir-noirc_abi',
      '@aztec/noir-acvm_js',
      '@aztec/bb.js',
      '@noir-lang/noir_js',
      '@aztec/kv-store/sqlite-opfs',
      '@aztec/sqlite3mc-wasm',
    ],
  },
  worker: {
    format: 'es',
  },
});
