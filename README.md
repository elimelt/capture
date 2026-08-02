# Capture

Voice-first, offline-first PWA for capturing what you did and when.

Capture is a mobile-first Progressive Web App (TypeScript/React) for logging
activity transitions throughout the day, with voice as the primary input. It is
built around a few principles: **offline-first** (capture never needs a network
or a token), **append-only** (nothing is edited or deleted in place — every
change is a new event, and read state is always a deterministic fold over the
log), **voice-first capture** (record now, interpret later; no AI runs at
capture time), **Google Drive as the sync substrate** (there is no Capture
backend — the user's own Drive holds the replicated log, and external
chat-assistant "skills" read the same files), and **opt-in AI** (transcription,
captioning, and a chat assistant are best-effort enrichments that degrade to
no-ops when offline or disabled).

## Features

- One-tap voice capture with timestamp and location snapshot; works fully offline
- Append-only event log (`capture` / `amend` / `revoke`) with idempotent,
  crash-safe bidirectional sync to a `timebox/` folder tree in the user's Google
  Drive (file-scoped `drive.file` access, no refresh tokens, no backend) — each
  cycle pulls events other devices committed before pushing local ones, and the
  deterministic fold converges every replica to identical state
- Day view of folded entries, with undo-able delete (a delayed `revoke`)
- Read-only Google Calendar overlay on the Day view: pick a target calendar in
  Settings and see its events alongside your entries, deep-linking into Google
  Calendar (`calendar.readonly` scope; the app never writes calendar events)
- Post-capture enrichment: Whisper transcription of audio, vision-LLM
  captioning of photos — appended as ordinary `amend` events, never
  overwriting user edits
- Place matching and cached Nominatim reverse geocoding; offline-capable maps
  via runtime-cached OSM tiles
- Opt-in, lazy-loaded chat assistant: a client-side agent loop over the local
  log with strictly read-only tools; nothing stored server-side
- Installable PWA with auto-updating service worker and precached app shell

## Tech stack

- React 19 + TypeScript, built with Vite
- Zustand for app state; IndexedDB (via `idb`) for all persistent local state
- `vite-plugin-pwa` (Workbox) for the service worker and runtime caches
- Tailwind CSS 4 for styling; Leaflet / react-leaflet for maps
- Vercel AI SDK (`ai`, `@ai-sdk/react`, `@ai-sdk/openai-compatible`) for the assistant
- Vitest for tests; oxlint for linting

## Getting started

Prerequisites: Node.js (CI uses Node 24) and npm.

```sh
npm install        # install dependencies
npm run dev        # start the Vite dev server
npm test           # run the unit test suite (hermetic, no network)
npm run test:watch # run tests in watch mode
npm run lint       # oxlint
npm run build      # type-check (tsc -b) and build to dist/
npm run preview    # serve the production build locally
```

Integration tests that hit the live LLM endpoint are excluded from the default
suite and gated behind `VITEST_INTEGRATION=1`:

```sh
npm run test:integration   # runs src/assistant/transport.integration.test.ts
```

## Configuration

All configuration is build-time constants — there are no environment variables
or API keys. A fork needs to change:

- `src/config.ts` — `GOOGLE_CLIENT_ID` (the Google OAuth browser-client ID; a
  public identifier, safe to ship in the bundle) and `APP_ORIGIN` (the deployed
  origin, e.g. `https://time.elimelt.com`). You will need your own Google Cloud
  OAuth client authorized for your origin, with the `drive.file` and
  `calendar.readonly` scopes.
- `src/transcribe/api.ts` — the Whisper transcription endpoint
  (`https://transcribe.elimelt.com`).
- `src/vision/api.ts` — the vision-LLM captioning endpoint
  (`https://llm.elimelt.com/api/chat`).
- `src/assistant/config.ts` — the OpenAI-compatible assistant endpoint
  (`https://llm.elimelt.com/v1`).
- `index.html` — the Content-Security-Policy whitelists exactly the endpoints
  above (plus Google, OSM, and Nominatim); update it to match any changes.
- `vite.config.ts` — `base` path and PWA manifest, if deploying somewhere other
  than a domain root.

## Deployment

Deployment is GitHub Pages via `.github/workflows/deploy.yml`. On every push to
`main` (or manual dispatch), CI runs `npm ci`, `npm test`, and `npm run build`,
copies `dist/index.html` to `404.html` as an SPA fallback for deep links, and
publishes the artifact with `deploy-pages`.

## Documentation

- [SPEC.md](SPEC.md) — product spec and the Drive file contract (source code
  wins where they disagree)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — system shape, layering rules,
  and the append-only log + fold design
- Subsystem docs:
  - [docs/subsystems/data-and-sync.md](docs/subsystems/data-and-sync.md) —
    event log, fold, IndexedDB store, Drive auth, upload queue, and pull engine
  - [docs/subsystems/ai-and-enrichment.md](docs/subsystems/ai-and-enrichment.md) —
    transcription/vision pipelines, places, and the assistant
  - [docs/subsystems/app-and-ui.md](docs/subsystems/app-and-ui.md) — boot,
    routing, design system, and UI invariants
- Module docs in [docs/modules/](docs/modules/) for file-level detail
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to work on the codebase

Architectural dependency rules are enforced mechanically by
`src/layering.test.ts`, which fails the suite on forbidden imports.
