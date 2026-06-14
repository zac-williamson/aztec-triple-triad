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
      include: ['buffer', 'path', 'process', 'net', 'tty'],
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
  },
  optimizeDeps: {
    esbuildOptions: {
      target: 'esnext',
    },
    // Force pre-bundle CJS packages so they work as ESM imports
    include: ['pino', 'pino/browser'],
    // Only exclude WASM-containing packages that esbuild corrupts
    exclude: ['@aztec/noir-noirc_abi', '@aztec/noir-acvm_js', '@aztec/bb.js', '@noir-lang/noir_js'],
  },
  worker: {
    format: 'es',
  },
});
