import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      include: ['buffer', 'process', 'stream', 'util', 'assert', 'crypto', 'events', 'path', 'string_decoder'],
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
    }),
  ],
  server: {
    port: 3000,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  build: {
    target: 'esnext',
  },
  resolve: {
    alias: {
      // Handle node: prefixed imports used by Aztec SDK
      'node:crypto': 'crypto-browserify',
      'node:fs': 'rollup-plugin-node-polyfills/polyfills/empty',
      'node:path': 'path-browserify',
      'node:os': 'rollup-plugin-node-polyfills/polyfills/empty',
      'node:stream': 'stream-browserify',
    },
  },
  optimizeDeps: {
    esbuildOptions: {
      target: 'esnext',
    },
    exclude: ['@aztec/bb.js', '@aztec/noir-noir_js'],
  },
  worker: {
    format: 'es',
  },
});
