import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  base: '/',
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        // The assistant is opt-in: keep its lazy chunk (AI SDK + markdown)
        // out of the precache so users who never enable it never download
        // it. Opted-in users get it runtime-cached below on first visit.
        globIgnores: ['**/ChatScreen-*.js'],
        // Offline-first: cache Google Fonts (stylesheet + font files) at
        // runtime so Libertinus Serif survives without a network.
        runtimeCaching: [
          {
            urlPattern: /\/assets\/ChatScreen-[^/]+\.js$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'assistant-chunk',
              expiration: { maxEntries: 3, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\//,
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'google-fonts-styles' },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-files',
              expiration: { maxEntries: 12, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          // Map tiles (SPEC: minimise OSM usage). Cache-first with a large,
          // long-lived store so a given area is fetched once and then served
          // from disk — the map keeps working offline and OSM sees minimal
          // traffic. purgeOnQuotaError lets tiles yield if storage runs low.
          {
            urlPattern: /^https:\/\/[abc]\.tile\.openstreetmap\.org\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'osm-tiles',
              expiration: {
                maxEntries: 1000,
                maxAgeSeconds: 60 * 60 * 24 * 30,
                purgeOnQuotaError: true,
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      manifest: {
        name: 'Timebox',
        short_name: 'Timebox',
        description: 'Voice-first capture for time tracking and more',
        display: 'standalone',
        orientation: 'portrait',
        theme_color: '#F8F6F3',
        background_color: '#F8F6F3',
        start_url: '/',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
    }),
  ],
  test: {
    environment: 'node',
    // Live-API integration tests are opt-in: `npm run test:integration`.
    exclude: [
      '**/node_modules/**',
      ...(process.env.VITEST_INTEGRATION ? [] : ['**/*.integration.test.ts']),
    ],
  },
})
