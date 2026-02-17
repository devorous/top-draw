import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  base: '/top-draw/',
  publicDir: 'public',
  server: {
    port: 3000,
    open: true,
    proxy: {
      '/ws': {
        target: 'ws://127.0.0.1:8000',
        ws: true,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ws/, ''),
      },
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks: {
          // Core vendor - protobufjs (lazy loaded but split for caching)
          'vendor-core': ['protobufjs'],
          // UI vendor - perfect-freehand
          'vendor-ui': ['perfect-freehand'],
          // Emoji data (lazy loaded)
          'vendor-emoji': ['emojibase-data/en/compact.json'],
          // Blur library (lazy loaded)
          'vendor-blur': ['stackblur'],
        },
        // Use hashed filenames for long-term caching
        chunkFileNames: 'assets/[name]-[hash].js',
        entryFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      },
    },
  },
});
