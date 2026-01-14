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
        target: 'ws://localhost:3001',
        ws: true,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ws/, ''),
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
