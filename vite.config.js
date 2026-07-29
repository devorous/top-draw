/** @fileoverview Vite configuration for ddraw — MPA with Svelte landing/gallery + vanilla JS drawing app. */

import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const devBackendTarget = process.env.VITE_DEV_BACKEND_TARGET || 'http://127.0.0.1:8030';

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
    // transformIndexHtml runs in dev serve AND build (the old `transform` hook
    // only fired at build time, so dev showed "Version unknown").
    transformIndexHtml(html) {
      return html.replace(
        '</head>',
        `<script>window.APP_VERSION = '${version}';</script>\n  </head>`
      );
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
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: [
        'images/pepper.ico',
        'images/pwa-192.png',
        'images/pwa-512.png',
        'images/pwa-512-maskable.png',
      ],
      manifest: {
        name: 'Top Draw',
        short_name: 'TopDraw',
        description: 'Real-time collaborative drawing — works offline too.',
        start_url: '/go/',
        scope: '/',
        display: 'standalone',
        background_color: '#1a1a1a',
        theme_color: '#1a1a1a',
        orientation: 'any',
        icons: [
          { src: 'images/pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'images/pwa-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'images/pwa-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,ico,woff2,png,webmanifest}'],
        globIgnores: ['**/brushes/**', '**/snapshots/**'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        navigateFallback: '/go/index.html',
        navigateFallbackDenylist: [/^\/api/, /^\/ws/, /^\/gallery/, /^\/chat/, /^\/board-viewer/],
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            urlPattern: /\/brushes\/.*\.(gbr|gih|json)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'brushes',
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com/,
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'google-fonts-stylesheets' },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-webfonts',
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
          {
            urlPattern: /^https:\/\/unpkg\.com\/vanilla-picker/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'vendor-cdn',
              expiration: { maxEntries: 5, maxAgeSeconds: 60 * 60 * 24 * 90 },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
    {
      name: 'go-spa-fallback',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          // Serve go/index.html for /go/* and /embed(/*) paths (SPA fallback).
          // The embed variant boots straight into the canvas (see src/main.js).
          if (req.url.startsWith('/go/') && !req.url.includes('.')) {
            req.url = '/go/index.html';
          } else if (/^\/embed(\/|$|\?)/.test(req.url) && !req.url.split('?')[0].includes('.')) {
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
        target: devBackendTarget,
        ws: true,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ws/, '') || '/',
      },
      '/api': {
        target: devBackendTarget,
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
        galleryGrid: resolve(__dirname, 'gallery/grid/index.html'),
        board: resolve(__dirname, 'board/index.html'),
      },
      output: {
        manualChunks(id) {
          // Vendor chunks
          if (id.includes('protobufjs')) return 'vendor-proto';
          if (id.includes('perfect-freehand')) return 'vendor-freehand';
          if (id.includes('stackblur')) return 'vendor-blur';
          if (id.includes('node_modules/svelte')) return 'vendor-svelte';

          // App code chunks (via dynamic imports in main.js)
          // auth-landing.js and its dependencies (Auth, LandingPage, WebSocketClient, etc.)
          // are dynamically imported and will form their own chunk
          if (id.includes('/auth/Auth.js') ||
              id.includes('/ui/LandingPage.js') ||
              (id.includes('/network/WebSocketClient.js') && !id.includes('App.js'))) {
            return 'auth-landing';
          }

          // Large Svelte components that are part of the drawing app
          // These stay with App.js for now since they're loaded with the app
          // Individual lazy-loading can be added later if needed
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
