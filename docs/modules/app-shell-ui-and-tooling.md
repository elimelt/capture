# App shell, UI design system, and tooling

This document covers the application shell (`src/App.tsx`, `src/main.tsx`, `src/config.ts`, `index.html`), the design-system primitives in `src/ui/`, the settings screen, and the build/test/deploy tooling (Vite + PWA, TypeScript configs, npm scripts, icon generation, GitHub Pages workflow).

## Overviews

### App shell

`index.html` boots a pure-HTML/CSS splash screen, loads the Google Identity Services script (the only third-party runtime script), and sets a strict Content-Security-Policy plus iOS standalone-PWA meta tags. `src/main.tsx` registers the service worker, requests persistent storage, and renders `<App />` inside `StrictMode → ErrorBoundary → BrowserRouter`. `src/App.tsx` owns the route table (Capture `/`, Day `/day` and `/day/:date`, opt-in Chat `/chat`, Settings `/settings`), the fixed bottom tab bar, and app-level lifecycle effects: hydrating the Zustand store, fading out the splash, refreshing local state when the app returns to the foreground (Drive sync is manual-only, via "Sync now" in Settings), running background transcription/captioning whenever entries change, and showing a global error toast. `src/config.ts` holds the two build-time constants (public Google OAuth client ID and the app origin).

### `src/ui` design-system primitives

`src/ui/` is the single place visual identity lives (SPEC C15). `tokens.ts` exports class-string tokens (`tone`, `shape`, `type_`, `motion`, `tap`) plus the `cx` class combiner; the raw palette and keyframes are defined in `src/index.css` under Tailwind v4's `@theme`. Components (`Button`, `IconButton`, `Card`, `Section`, `EmptyState`, `Sheet`, `Toast`, form fields, `ScreenHeader`, `ErrorBoundary`) compose the tokens; screens import everything from the `src/ui` barrel (`index.ts`) and never hardcode palette/shape classes. A future visual redesign edits `tokens.ts`/`index.css` and the primitives, not the screens.

### Settings screen

`src/settings/SettingsScreen.tsx` is Screen 3 (SPEC §4.3, M1 subset). It reads and writes app state exclusively through the `useAppStore` Zustand store: Google Drive connect/disconnect/sync, capture settings (max clip length, keep audio locally), location toggle and geofenced "places" management (with reverse geocoding), assistant enablement, storage usage display, and a two-tap local-data wipe.

### Build, tooling, and deploy

- **Vite** (`vite.config.ts`): React plugin, Tailwind v4 plugin, and `vite-plugin-pwa` with an auto-updating Workbox service worker. The lazy assistant chunk is excluded from precache and runtime-cached instead; Google Fonts, OSM map tiles, and Nominatim geocoding responses are runtime-cached for offline use and to minimise third-party traffic. The same file carries the Vitest config (node environment; live-API integration tests opt-in via `VITEST_INTEGRATION`).
- **TypeScript**: a solution-style root `tsconfig.json` referencing `tsconfig.app.json` (browser code in `src/`, `vite/client` types only — no node types) and `tsconfig.node.json` (`vite.config.ts`, node types).
- **npm scripts** (`package.json`): `dev`, `build` (`tsc -b && vite build`), `lint` (oxlint), `preview`, `test` (`vitest run`), `test:integration`, `test:watch`.
- **Icons**: `scripts/gen-icons.mjs` generates placeholder PNG icons from scratch with zero dependencies.
- **Deploy**: `.github/workflows/deploy.yml` tests, builds, and publishes `dist/` to GitHub Pages on pushes to `main`, copying `index.html` to `404.html` as the SPA fallback.

## File-by-file

### src/App.tsx

Default-exports the root `App` component. Responsibilities:

- **Routing**: `Routes` for `/` (CaptureScreen), `/day` and `/day/:date` (DayScreen), `/chat` (lazy `ChatScreen`, guarded by `assistantEnabled` — otherwise `Navigate` to `/`), `/settings` (SettingsScreen), and a catch-all redirect to `/`. `ChatScreen` is `lazy()`-loaded so users who never enable the assistant never download the AI SDK + markdown bundle.
- **Tab bar**: a fixed, translucent, backdrop-blurred bottom `nav` built from the `TABS` array; the Chat tab is filtered out unless `appSettings.assistantEnabled` is true. Active tabs use `tone.accent`, inactive `tone.textMuted`.
- **Splash teardown**: when the store reports `ready`, adds the `done` class to `#splash` (defined in `index.html`) and removes the element after a 400 ms fade.
- **Lifecycle effects**: on mount calls `init()`; on `visibilitychange` (visible) calls `refresh()` only — returning to the foreground re-reads local state. There is no `online` listener and no automatic `drainSync`: Drive sync is manual-only, via the "Sync now" button in Settings (SPEC §8.4).
- **Background media understanding**: whenever `entries` change, runs `drainTranscriptions(currentStreamId)` and `drainCaptions(currentStreamId)` in parallel; if either produced results, calls `refresh()`, which re-runs the effect until nothing is pending.
- **Global error toast**: renders `Toast` with a Dismiss action when `useAppStore().lastError` is set, auto-clearing after 6 s.
- **Layout**: `max-w-md` column, `pb-24` to clear the tab bar, `pt-[env(safe-area-inset-top)]` because the iOS status bar style is `black-translucent` (content extends underneath it). Renders `ReconnectPill` (Drive re-auth prompt) above the routes.

### src/main.tsx

Entry point. Calls `registerSW()` from `virtual:pwa-register` (auto-update service worker), then `navigator.storage?.persist?.()` — Safari can evict script-writable storage after ~7 days of disuse and Drive backup is the only other copy, so persistence is requested up front (SPEC §2.3). Renders `App` under `StrictMode → ErrorBoundary → BrowserRouter` into `#root`, and imports `./index.css`.

### src/config.ts

Build-time constants: `GOOGLE_CLIENT_ID` (a public OAuth browser-client identifier — safe to ship in the bundle per SPEC §9.2), `APP_ORIGIN` (`https://time.elimelt.com`), and the OAuth scopes — `DRIVE_SCOPE`, `CALENDAR_READONLY_SCOPE`, and the combined `GOOGLE_SCOPES` requested in one consent. The scopes live in this neutral module (not in `drive/` or `gcal/`) so generic layers can compose them without breaking the SPEC §10 layering rule. No secrets live here.

### src/ui/index.ts

Barrel for the design system. Re-exports the tokens (`cx`, `motion`, `shape`, `tap`, `tone`, `type_`), every primitive: `Button`, `IconButton`, `Card`, `EmptyState`, `Section`, `ErrorBoundary`, `Sheet`, `useKeyboardInset`, `Toast`, `FieldRow`, `Select`, `TextArea`, `TextInput`, `Toggle`, `ScreenHeader`, and the shared icon set (`MicIcon`, `CameraIcon`, `PencilIcon`, `PlusIcon`, `PinIcon`, `TrashIcon`, `captureIcon`, types `CaptureKind`/`IconProps`). Screens import from here — never from token/palette classes directly (C15).

### src/ui/tokens.ts

Design tokens as constant objects of Tailwind class strings ("Warm Editorial Slate": Libertinus serif for content the user reads, system sans for UI chrome; palette values live in `src/index.css` `@theme`):

- `tone` — surface/background (`bg`, `surface`, `sunken`), borders (`border`, `borderStrong`), text ramp (`textPrimary`…`textFaint`), spruce accent (`accent`, `accentBg`, `accentBgActive`, `accentWash`), clay danger (`danger`, `dangerBg`, `dangerBgActive`, `dangerWash`), and `pressWash` for pressed states. Every entry pairs light and `dark:` classes.
- `shape` — `card` (14 px radius), `control` (`rounded-xl`), `pill` (`rounded-full`).
- `type_` — typography scale: `title` (serif 26 px), `heading` (serif 17 px), `body` (serif 16 px), `sub` (sans 13 px), `caption` (sans 12 px), `overline` (sans 11 px uppercase), `ui` (sans 15 px, "chrome, never serif"). Named `type_` because `type` is reserved-ish.
- `motion` — entrance animations only (`fadeIn`, `riseIn`, `scaleIn`, `sheetIn`, `toastIn`); exits are instant via conditional rendering. Keyframes live in `index.css`.
- `tap` — `'min-h-11 min-w-11'`, the 44 pt Apple HIG minimum tap target.
- `cx(...parts)` — joins truthy class strings.

### src/ui/Button.tsx

- `Button({ variant?, size?, block?, ...rest })` — extends `ButtonHTMLAttributes<HTMLButtonElement>`. `ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'dangerGhost'` (default `secondary`); `ButtonSize = 'md' | 'sm'` (default `md`; `md` uses the `tap` minimum, `sm` is `min-h-9`). `block` stretches to full width. Variants map to token compositions (e.g. `primary` = accent background + white text).
- `IconButton({ 'aria-label', variant?, ...rest })` — 44×44 px pill icon button, `variant: 'outline' | 'ghost'` (default `outline`). `aria-label` is a required prop so icon-only buttons stay accessible.

### src/ui/Card.tsx

- `Card({ className?, children })` — bordered surface with 14 px radius, `p-3`, medium shadow in light mode and elevated shadow in dark mode for clear separation from the background.
- `Section({ title, children })` — titled `<section>` card (`p-4`, serif `type_.heading` `<h2>`); used for settings/content groups.
- `EmptyState({ title, children? })` — centered italic-serif empty message with optional sub-content.

### src/ui/ErrorBoundary.tsx

Class component (the only way to catch render errors). On error it renders a full-height fallback with the error message and a Reload `Button`; `componentDidCatch` removes the `#splash` element so a crash during boot cannot leave the HTML splash covering the fallback. Wraps the whole app in `main.tsx`.

### src/ui/Sheet.tsx

- `useKeyboardInset(): number` — hook tracking how much of the iOS software keyboard overlaps the layout viewport, via `window.visualViewport` resize/scroll listeners (`innerHeight − vv.height − vv.offsetTop`, clamped ≥ 0). Exported for fixed composers too (C12).
- `Sheet({ title, onClose, children })` — modal bottom sheet (`role="dialog"`, `aria-modal`). Backdrop tap closes; inner clicks `stopPropagation()`. While mounted it freezes the page with `body { position: fixed; top: -scrollY }` (iOS ignores `overflow: hidden` and scrolls the body through fixed overlays) and restores scroll on unmount. Bottom padding is `max(safe-area-inset-bottom, 1rem) + keyboardInset` so content lifts above the keyboard. Overlay is `z-50`; content animates in with `motion.sheetIn`.

### src/ui/Toast.tsx

`Toast({ children, actionLabel?, onAction? })` — fixed transient toast (`role="status"`, `z-40`) positioned `5.5rem` above the safe-area bottom so it clears the tab bar. Inverted colors in light mode (`bg-ink text-paper`), card surface in dark. Renders an action button (e.g. Undo/Dismiss) only when both `actionLabel` and `onAction` are given. Not self-dismissing — callers own the timer (e.g. `App` clears `lastError` after 6 s).

### src/ui/fields.tsx

Form primitives sharing a `FIELD` base (control radius, strong border, surface background, spruce focus border):

- `TextInput(props)` / `Select(props)` / `TextArea(props)` — thin wrappers over the native elements accepting all native attributes; inputs/selects get the `tap` minimum height, the textarea is full-width `text-base`.
- `Toggle({ checked, onChange, label })` — labelled iOS-style switch (`role="switch"`, `aria-checked`); `onChange` receives the new boolean.
- `FieldRow({ label, children })` — `min-h-11` label row with a trailing control.

### src/ui/ScreenHeader.tsx

`ScreenHeader({ title, subtitle?, trailing? })` — screen title row: serif `type_.title` `<h1>`, optional muted subtitle, optional trailing element (button etc.). Sits below the iOS status bar because `App` pads `main` with `env(safe-area-inset-top)`.

### src/ui/icons.tsx

Shared SVG icon set — every capture glyph is drawn once here so screens stay visually consistent. Each icon takes an optional `size` prop (px). `captureIcon(kind: CaptureKind)` is the single capture-modality → icon mapping (`audio` → `MicIcon`, `photo` → `CameraIcon`, `text` → `PencilIcon`), used by both the main capture CTA (`RecordPanel`) and the entry-card action row; `PlusIcon`, `PinIcon`, and `TrashIcon` cover add/location/delete affordances. The mapping is unit-tested in `icons.test.ts`.

### src/settings/SettingsScreen.tsx

Default-exports `SettingsScreen`; all state flows through `useAppStore`. Sections:

- **Google** (private `GoogleSection`): shows connection status from `driveConnection` (`connected` / `expired` / `disconnected`, mapped through `CONNECTION_LABEL`), refreshing it on mount. A private `SyncStatusLine` renders the local sync-state rollup (`summarizeSyncStatuses` over the sync rows + the persisted `lastSyncAt`) above the buttons: "Out of sync" in the danger tone when anything is pending, anything errored, or no clean cycle has ever completed, else "Up to date"; plus "N entries waiting" / "N failed" counts, the last error message, and "Last synced …" / "Never synced". Connected → "Sync now" (`drainSync`, disabled while `syncing`), "Disconnect", and the target-calendar picker (private `CalendarPicker`, backed by `src/gcal` — see [gcal.md](gcal.md)); otherwise a Connect/Reconnect primary button. A manual sync's `SyncResult` is summarized inline via `syncResultLabel` — e.g. "Synced 2 entries · pulled 1 entry", "Sync busy — will retry shortly", or "Sync failed: …".
- **Capture**: numeric max-clip-length field (clamped 10–120 s on change) and a "Keep audio locally" toggle, both writing `streamSettings` via `updateStreamSettings`.
- **Location**: `locationEnabled` toggle plus places management — lists saved places (name, radius, optional "near {address}" line, per-row `dangerGhost` Remove). "Add current location as place" calls `navigator.geolocation.getCurrentPosition` (8 s timeout, 60 s `maximumAge`, low accuracy) into `pendingPlace`; the inline form collects name and radius, and `savePendingPlace` best-effort `reverseGeocode`s an address (never blocks the save) before `addPlace` with a `crypto.randomUUID()` id.
- **Assistant**: `assistantEnabled` toggle; when on, shows the model label (`modelLabel(appSettings.assistantModel)` from `assistant/config`) and a note that chat runs against `llm.elimelt.com` via read-only tools.
- **Data**: storage usage from `navigator.storage.estimate()` (MB), and "Wipe local data" using an inline two-tap confirm (`wipeArmed` auto-disarms after 4 s; no `window.confirm`, which feels broken in standalone PWAs). The armed second tap calls `wipe()` then `loadSettings()`.

### src/index.css

Tailwind v4 entry (`@import "tailwindcss"`). The `@theme` block defines the whole palette as CSS variables (paper/card/well surfaces, line borders, ink text ramp, spruce accent, clay danger — each with a `-dark` twin), the serif/sans font stacks, and the five entrance animations plus their keyframes and easings. Also: Leaflet fixes (undo Preflight's `img { max-width: 100% }` inside maps; isolate `.leaflet-container` into its own stacking context with capped pane z-indexes so inline maps never paint over the `z-50` Sheet), a global `prefers-reduced-motion` kill switch, `overscroll-behavior: none` and no tap highlight on `html/body`, sans as the default body font (content opts into serif via tokens), and an `html` background matching `tone.bg` in both color schemes so nothing white shows behind iOS overscroll/home-indicator areas.

### src/layering.test.ts

Vitest architecture guard for the SPEC §10 layering rule: the stream-agnostic layers (`streams/`, `capture/`, `contract/`, `store/`, `places/`, `drive/`, `transcribe/`, `vision/`, `ui/`) must not statically import from the timelog-specific or app-level directories `gcal/`, `dayview/`, `settings/`, `assistant/`. It loads layer sources with `import.meta.glob(..., { query: '?raw' })` (so it type-checks without node types), extracts import specifiers with regexes, resolves relative paths to their top-level `src/` directory, and fails listing every violation; a companion test asserts each expected layer actually matched files so the globs cannot silently rot.

### src/vite-env.d.ts

Ambient declarations: references `vite/client` and `vite-plugin-pwa/client` types (enabling `import.meta.glob`, `virtual:pwa-register`, asset imports), and augments `Window` with optional `webkitAudioContext` for older iOS Safari.

### index.html

The single HTML page. Notable contents:

- **CSP meta tag** (SPEC §9.2): `script-src` allows only self + `accounts.google.com` (GIS); `connect-src` whitelists Google APIs/OAuth, `llm.elimelt.com` (assistant), `transcribe.elimelt.com` (transcription), OSM tile hosts and Nominatim; images allow OSM tiles + `data:`/`blob:`; styles/fonts allow Google Fonts; `object-src 'none'`, `base-uri 'self'`. No inline scripts anywhere.
- **iOS standalone meta**: `viewport-fit=cover`, `user-scalable=no`, `apple-mobile-web-app-capable`, status bar `black-translucent` (why `App` pads for the safe area), apple-touch-icon, light/dark `theme-color`s.
- **Fonts**: preconnects and loads Libertinus Serif from Google Fonts (runtime-cached by the SW).
- **GIS script**: `async defer` so it never blocks the offline-first capture shell.
- **Boot splash**: `#splash` — pure HTML/CSS (wordmark + pulsing dot, dark-scheme and reduced-motion aware) painted before the JS bundle loads; `App` fades it out (`.done`) once the store is hydrated, and `ErrorBoundary` removes it on a boot crash.

### vite.config.ts

Configured via `defineConfig` from `vitest/config` (Vite + Vitest in one file), `base: '/'`. Plugins:

- `@vitejs/plugin-react`, `@tailwindcss/vite`.
- `VitePWA` with `registerType: 'autoUpdate'`:
  - `workbox.globIgnores: ['**/ChatScreen-*.js']` keeps the lazy assistant chunk out of the precache; a `CacheFirst` runtime rule (`assistant-chunk`, 3 entries / 30 days) caches it for opted-in users instead.
  - Runtime caching: Google Fonts stylesheets `StaleWhileRevalidate`; font files `CacheFirst` (12 entries / 1 year); OSM tiles `CacheFirst` (`osm-tiles`, 1000 entries / 30 days, `purgeOnQuotaError: true` — offline maps and minimal load on OSM); Nominatim `CacheFirst` (200 entries / 90 days — its usage policy requires client-side caching; IndexedDB caching is the first line, this the second).
  - Web app manifest: name/short_name `Capture`, `standalone`, `portrait`, paper theme/background color, 192/512 icons with a maskable 512.
- `test`: node environment; `*.integration.test.ts` excluded unless `VITEST_INTEGRATION` is set.

### package.json

Private, `"type": "module"`, version 0.0.0. Scripts: `dev` (vite), `build` (`tsc -b && vite build` — type-check both projects, then bundle), `lint` (oxlint), `preview`, `test` (`vitest run`), `test:integration` (sets `VITEST_INTEGRATION=1` for the assistant transport live test), `test:watch`. Runtime dependencies: React 19 + `react-router-dom` 7, `zustand` (store), `idb` (IndexedDB), `leaflet`/`react-leaflet` (maps), `ai` + `@ai-sdk/*` and `react-markdown`/`remark-gfm` (opt-in assistant). Dev dependencies: Vite 8, `vite-plugin-pwa`, Tailwind 4, TypeScript ~6.0, Vitest 4, `fake-indexeddb`, oxlint, type packages. `overrides` pins `glob@^13` inside `workbox-build`; `allowScripts` allowlists the `esbuild`/`fsevents` install scripts.

### tsconfig.json

Solution-style root: no files of its own, references `tsconfig.app.json` and `tsconfig.node.json`. `tsc -b` (in `npm run build`) builds both.

### tsconfig.app.json

Browser project covering `src/`. ES2023 target/lib + DOM, `strict`, bundler module resolution, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `noEmit`, `jsx: react-jsx`, unused-locals/params errors. `types: ["vite/client"]` deliberately excludes node types — which is why `src/layering.test.ts` reads sources via `import.meta.glob` instead of `node:fs`.

### tsconfig.node.json

Node project covering only `vite.config.ts`: ES2023, `module: nodenext`, `types: ["node"]`, same strict/lint flags, `noEmit`.

### scripts/gen-icons.mjs

Dependency-free generator for placeholder PWA icons (`node scripts/gen-icons.mjs`). Hand-assembles PNGs — CRC32 table, chunk framing, truecolor IHDR, `zlib.deflateSync` IDAT — and draws a slate square with a sky-blue "t" glyph (horizontal bar + stem on a 16-unit grid). Writes `public/icons/icon-192.png` and `icon-512.png`, the files referenced by `index.html` and the PWA manifest in `vite.config.ts`.

### .github/workflows/deploy.yml

GitHub Pages deployment on pushes to `main` (plus `workflow_dispatch`), with `pages: write`/`id-token: write` permissions and a `pages` concurrency group (in-progress runs cancelled). The `build` job: checkout, Node 24 with npm cache, `npm ci`, `npm test`, `npm run build`, then `cp dist/index.html dist/404.html` so Pages serves the SPA for client-side routes (Pages returns `404.html` for unknown paths), and uploads `dist/` as the Pages artifact. The `deploy` job publishes it with `actions/deploy-pages` into the `github-pages` environment.

### .gitignore

Ignores logs, `node_modules`, build output (`dist`, `dist-ssr`), `*.local`, and editor/OS files (`.vscode/*` except `extensions.json`, `.idea`, `.DS_Store`, etc.).

## Key invariants & gotchas

- **Screens never hardcode palette/shape classes** (C15). All visual styling flows through `src/ui/tokens.ts` and the primitives; the raw color values live only in `src/index.css` `@theme` (and, duplicated by necessity, in `index.html`'s splash/theme-color and `vite.config.ts`'s manifest — keep all of these in sync when the palette changes).
- **Layering rule (SPEC §10), machine-enforced**: generic layers (`ui/`, `store/`, `capture/`, `contract/`, `streams/`, `drive/`, `places/`, `transcribe/`, `vision/`) must not import from `gcal/`, `dayview/`, `settings/`, or `assistant/`. `src/layering.test.ts` fails the build pipeline (tests run before deploy) on violations. Adding a new generic layer means adding it to the test's glob list and `LAYERS_EXPECTED_TODAY`.
- **The assistant chunk must stay lazy and out of the precache.** `App.tsx` `lazy()`-imports `ChatScreen`, and `vite.config.ts` excludes `ChatScreen-*.js` from the Workbox precache by filename pattern. Renaming that component/chunk breaks both the globIgnore and the runtime-caching URL pattern silently.
- **iOS-specific behaviors are load-bearing**: safe-area padding in `App` (status bar is `black-translucent`), `Sheet`'s `position: fixed` body scroll lock (iOS ignores `overflow: hidden`), `useKeyboardInset` via `visualViewport`, the 44 pt `tap` minimum, and the `html` background color painted for overscroll areas.
- **Boot splash lifecycle has two exits**: `App` fades and removes `#splash` when the store is `ready`; `ErrorBoundary.componentDidCatch` removes it on a boot crash. Any new early-exit path must also remove the splash or the UI stays hidden.
- **CSP is a meta tag in `index.html`** and must be updated whenever a new network endpoint is introduced (the comment above it enumerates the current ones). No inline scripts are allowed — the splash uses only CSS.
- **App tsconfig has no node types.** Tests under `src/` must avoid `node:*` imports (see `layering.test.ts`'s `import.meta.glob` approach); node-flavoured code belongs with `vite.config.ts` under `tsconfig.node.json`.
- **Sync has no backend scheduler and no automatic triggers**: sync cycles (pull then push) run only on manual "Sync now" in Settings — never on foreground or `online` events. Background enrichment (transcription/captioning) hooks the entries-changed effect in `App.tsx`; sync deliberately does not.
- **Z-index ladder**: Leaflet maps are capped at `z-0` (isolated), `Toast` is `z-40`, `Sheet` is `z-50`, splash is `z-100`. Keep new overlays within this ordering.
- **`Toast` does not auto-dismiss** — callers own dismissal timing (App uses 6 s for `lastError`).
