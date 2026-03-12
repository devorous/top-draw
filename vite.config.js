/** @fileoverview Vite configuration for Top Draw, defining build, server, and proxy settings. */

import { defineConfig } from 'vite';

/**
 * Defines the Vite project configuration.
 */
export default defineConfig({
  root: '.',
  base: '/top-draw/',
  publicDir: 'public',
  server: {
    port: 3000,
    open: true,
    proxy: {
      '/ws': {
        target: 'http://127.0.0.1:8000',
        ws: true,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ws/, '') || '/',
      },
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-core': ['protobufjs'],
          'vendor-ui': ['perfect-freehand'],
          'vendor-blur': ['stackblur'],
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        entryFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      },
    },
  },
});
