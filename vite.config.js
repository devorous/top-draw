/** @fileoverview Vite configuration for ddraw — MPA with Svelte landing/gallery + vanilla JS drawing app. */

import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Inject APP_VERSION from package.json
function versionInjectionPlugin() {
  const packageJson = JSON.parse(fs.readFileSync(resolve(__dirname, 'package.json'), 'utf8'));
  const version = packageJson.version;

  return {
    name: 'version-injection',
    resolveId(id) {
      if (id === 'virtual-version') {
        return id;
      }
    },
    load(id) {
      if (id === 'virtual-version') {
        return `export const APP_VERSION = '${version}';`;
      }
    },
    transform(code) {
      // Inject into HTML as global variable
      if (code.includes('<!DOCTYPE html>') || code.includes('<html')) {
        return {
          code: code.replace(
            '</head>',
            `<script>window.APP_VERSION = '${version}';</script>\n  </head>`
          ),
          map: null
        };
      }
    }
  };
}

export default defineConfig({
  root: '.',
  base: './',
  publicDir: 'public',
  appType: 'mpa',
  plugins: [
    svelte(),
    versionInjectionPlugin(),
    {
      name: 'go-spa-fallback',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          // Serve go/index.html for /go/* paths (SPA fallback)
          if (req.url.startsWith('/go/') && !req.url.includes('.')) {
            req.url = '/go/index.html';
          }
          next();
        });
      },
    },
  ],
  server: {
    port: 3000,
    open: '/go',
    proxy: {
      '/ws': {
        target: 'http://127.0.0.1:8000',
        ws: true,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ws/, '') || '/',
      },
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        go: resolve(__dirname, 'go/index.html'),
        chat: resolve(__dirname, 'chat/index.html'),
        boardViewer: resolve(__dirname, 'board-viewer/index.html'),
        gallery: resolve(__dirname, 'gallery/index.html'),
      },
      output: {
        manualChunks(id) {
          if (id.includes('protobufjs')) return 'vendor-proto';
          if (id.includes('perfect-freehand')) return 'vendor-freehand';
          if (id.includes('stackblur')) return 'vendor-blur';
          if (id.includes('node_modules/svelte')) return 'vendor-svelte';
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        entryFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      },
    },
  },
  css: {
    preprocessorOptions: {
      scss: {
        api: 'modern-compiler',
      },
    },
  },
});
