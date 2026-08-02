import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  base: '/',
  plugins: [
    // Rewrite /agents to /agents/index.html for the rendered agent guide.
    // In production (GitHub Pages), /agents/ naturally serves /agents/index.html.
    // This middleware handles the dev/preview servers for the same behavior.
    {
      name: 'agents-rewrite',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.url === '/agents' || req.url === '/agents/')
            req.url = '/agents/index.html'
          next()
        })
      },
      configurePreviewServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.url === '/agents' || req.url === '/agents/')
            req.url = '/agents/index.html'
          next()
        })
      },
    },
    // Issue #66: vite.config.ts hardcodes the `ChatScreen-*.js` filename
    // pattern twice below (globIgnores + the assistant-chunk runtimeCaching
    // rule) so the lazy assistant chunk is precache-excluded but still
    // runtime-cacheable. Renaming/restructuring `ChatScreen` so it no longer
    // emits exactly one matching chunk would silently break both — this
    // fails the build instead.
    {
      name: 'assert-chatscreen-chunk',
      generateBundle(_options, bundle) {
        const matches = Object.keys(bundle).filter((file) => /ChatScreen-[^/]+\.js$/.test(file))
        if (matches.length !== 1) {
          this.error(
            `Expected exactly one ChatScreen-*.js chunk, found ${matches.length}` +
              (matches.length ? `: ${matches.join(', ')}` : '') +
              '. vite.config.ts workbox.globIgnores and the assistant-chunk runtimeCaching ' +
              'rule hardcode this filename pattern — update them if ChatScreen was renamed ' +
              'or its chunking changed.',
          )
        }
      },
    },
    react(),
    tailwindcss(),
    VitePWA({
      // 'prompt' (not 'autoUpdate'): a new SW installs and waits rather than
      // skipWaiting + force-reloading every open window the instant it
      // activates, which would silently blow away an in-progress recording
      // or a typed-but-unsent chat message (issue #61). src/main.tsx wires
      // the resulting onNeedRefresh callback to a "Reload" toast so updates
      // are visible and applied on the user's own schedule.
      registerType: 'prompt',
      workbox: {
        // The assistant is opt-in: keep its lazy chunk (AI SDK + markdown)
        // out of the precache so users who never enable it never download
        // it. Opted-in users get it runtime-cached below on first visit.
        globIgnores: ['**/ChatScreen-*.js'],
        // vite-plugin-pwa defaults navigateFallback to index.html for every
        // same-origin navigation once the SW controls the client. /agents is
        // a distinct static page (public/agents/index.html), not an SPA
        // route — without this denylist the SW would shadow it with the app
        // shell, which then bounces to "/" via the router's catch-all
        // (issue #68). The guide's HTML is already precached via the default
        // html glob, so it keeps working offline once excluded here.
        navigateFallbackDenylist: [/^\/agents/],
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
          // Reverse-geocoding (Nominatim). Its usage policy *requires* caching
          // results client-side; we also cache in IndexedDB. Cache-first here
          // is a second line of defence so repeat coordinate cells never
          // re-hit the donated server.
          {
            urlPattern: /^https:\/\/nominatim\.openstreetmap\.org\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'nominatim',
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 90 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      manifest: {
        name: 'Capture',
        short_name: 'Capture',
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
    // Installs the fake-indexeddb polyfill once for every test file (issue
    // #70), instead of each of the ~25 files that touch store/db.ts
    // repeating `import 'fake-indexeddb/auto'` itself.
    setupFiles: ['./src/testing/setup.ts'],
    // Live-API integration tests are opt-in: `npm run test:integration`.
    exclude: [
      '**/node_modules/**',
      ...(process.env.VITEST_INTEGRATION ? [] : ['**/*.integration.test.ts']),
    ],
  },
})
