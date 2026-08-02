# App shell, UI design system, and tooling

This document covers the application shell (`src/App.tsx`, `src/main.tsx`, `src/config.ts`, `index.html`), the design-system primitives in `src/ui/`, the settings screen, and the build/test/deploy tooling (Vite + PWA, TypeScript configs, npm scripts, icon generation, GitHub Pages workflow).

## Overviews

### App shell

`index.html` boots a pure-HTML/CSS splash screen, loads the Google Identity Services script (the only third-party runtime script), and sets a strict Content-Security-Policy plus iOS standalone-PWA meta tags. `src/main.tsx` registers the service worker (with an in-session update check — see `src/swUpdate.ts` below), requests persistent storage, and renders `<App />` inside `StrictMode → ErrorBoundary → BrowserRouter`. `src/App.tsx` owns the route table (Capture `/`, Day `/day` and `/day/:date`, opt-in Chat `/chat` — its own route-scoped error boundary — Settings `/settings`; entry/day context copy is inline rather than a standalone route), the fixed bottom tab bar, and app-level lifecycle effects: hydrating the Zustand store, fading out the splash, refreshing local state when the app returns to the foreground (Drive sync is manual-only, via "Sync now" in Settings), running background transcription/captioning whenever entries change, showing a global error toast, and a "New version available" reload toast when a SW update is waiting. `src/config.ts` holds the build-time constants: the public Google OAuth client ID, the OAuth scopes, and the `ENDPOINTS` block — currently just the assistant host (issue #69; the transcription/vision endpoints live in `src/enrich/config.ts`, issue #62).

Primary tabs support deliberate horizontal touch swipes through
`src/navigation/swipe.ts`: left advances to the next visible tab and right
returns to the previous one. The gesture has minimum-distance and
horizontal-dominance thresholds, and ignores controls, dialogs, maps, and
horizontally scrollable content so ordinary taps and vertical scrolling remain
unchanged. Its geometry and tab-selection logic are covered by unit tests.

### `src/ui` design-system primitives

`src/ui/` is the single place visual identity lives (SPEC C15). `tokens.ts` exports class-string tokens (`tone`, `shape`, `type_`, `motion`, `layer`, `tap`) plus the `cx` class combiner; the raw palette and keyframes are defined in `src/index.css` under Tailwind v4's `@theme`. Components (`Button`, `IconButton`, `Card`, `TimelineRow`, `Section`, `EmptyState`, `Sheet`, `Toast`, form fields, `ScreenHeader`, `ErrorBoundary`, `RouteErrorBoundary`) compose the tokens; screens import everything from the `src/ui` barrel (`index.ts`) and never hardcode palette/shape classes. A future visual redesign edits `tokens.ts`/`index.css` and the primitives, not the screens.

### Settings screen

`src/settings/SettingsScreen.tsx` is Screen 3 (SPEC §4.3, M1 subset). It reads and writes app state exclusively through the `useAppStore` Zustand store: Google Drive connect/disconnect/sync, capture settings (max clip length, keep audio locally), location toggle and geofenced "places" management (with reverse geocoding), AI & privacy toggles (enrichment, assistant — both opt-in and off by default), storage usage display, and a two-tap local-data wipe.

### Build, tooling, and deploy

- **Vite** (`vite.config.ts`): React plugin, Tailwind v4 plugin, and `vite-plugin-pwa` with a `registerType: 'prompt'` Workbox service worker — a new SW installs and waits rather than force-reloading every open window (issue #61; see `src/swUpdate.ts`). The lazy assistant chunk is excluded from precache and runtime-cached instead (a `generateBundle` plugin asserts the build emits exactly one `ChatScreen-*.js` chunk, failing loudly on a silent rename — a build-time complement to the post-build `check:bundle-size` guard below, issue #71); Google Fonts, OSM map tiles, and Nominatim geocoding responses are runtime-cached for offline use and to minimise third-party traffic; `workbox.navigateFallbackDenylist` excludes `/agents` so the SW's SPA-shell fallback doesn't shadow that static guide page. The same file carries the Vitest config (node environment; `test.setupFiles: ['./src/testing/setup.ts']` installs `fake-indexeddb` for the whole run, issue #70; live-API integration tests opt-in via `VITEST_INTEGRATION`).
- **TypeScript**: a solution-style root `tsconfig.json` referencing `tsconfig.app.json` (browser code in `src/`, `vite/client` types only — no node types) and `tsconfig.node.json` (`vite.config.ts`, node types).
- **npm scripts** (`package.json`): `dev`, `build` (`tsc -b && vite build`), `lint` (oxlint), `preview`, `test` (`vitest run`), `test:integration`, `test:watch`, `check:bundle-size` (`node scripts/check-bundle-size.mjs`, issue #71 — run after `build`).
- **Icons**: `scripts/gen-icons.mjs` generates the PNG icons from scratch with zero dependencies; `public/icons/icon.svg` is the hand-written SVG favicon with the same database glyph.
- **Bundle-size guard**: `scripts/check-bundle-size.mjs` (issue #71, zero dependencies) reads `dist/assets/index-*.js` (the entry chunk index.html actually `<script type="module">`s) and fails if it exceeds a byte budget or contains `AI_APICallError` — a stable symbol from the `ai` package's error classes, present only if the AI SDK leaked into the eager bundle — and separately fails if `dist/assets/ChatScreen-*.js` (the assistant's lazy chunk) is missing entirely. Run in both `ci.yml` and `deploy.yml` right after `build`.
- **Deploy**: `.github/workflows/deploy.yml` tests, builds, checks the bundle size, and publishes `dist/` to GitHub Pages on pushes to `main`, copying `index.html` to `404.html` as the SPA fallback.
- **Scheduled integration check**: `.github/workflows/integration.yml` (issue #71) runs `npm run test:integration` — the only live-network test in the suite — weekly and on manual dispatch, separate from `ci`/`deploy` so a flaky/down external endpoint can never block a PR or a deploy; a broken assistant transport instead shows up as a red scheduled run.

## File-by-file

### src/App.tsx

Default-exports the root `App` component. Responsibilities:

- **Routing**: `Routes` for `/` (CaptureScreen), `/day` and `/day/:date` (DayScreen), `/chat` (a private `ChatRoute`, guarded by `assistantEnabled` — otherwise `Navigate` to `/`), `/settings` (SettingsScreen), and a catch-all redirect to `/`. Entry/day copy actions are inline in Capture and Day; there is no standalone Context screen.
- **`ChatRoute` (issue #66)**: wraps the lazy `ChatScreen` in its own `RouteErrorBoundary` (not the root one), so a rejected `import()` — e.g. offline after a deploy invalidated the runtime-cached chunk — degrades to an inline "Chat couldn't load" message with Retry, not a full-app crash. `Suspense` gets a real "Loading Chat…" fallback instead of `null`. An `attempt` counter, bumped by Retry, is threaded into both a `useMemo`-recreated `lazy()` call and the boundary's `key`: React.lazy caches a rejected import forever on its module-level reference, so only a fresh `lazy()` inside a freshly-mounted boundary actually retries the fetch. `ChatScreen` is still `lazy()`-loaded so users who never enable the assistant never download the AI SDK + markdown bundle.
- **Tab bar**: a fixed, translucent, backdrop-blurred bottom `nav` on `layer.nav`, built from the `TABS` array (`src/navTabs.ts`) — Capture, Today, and Settings `NavLink`s; the assistant has no tab (`/chat` is reached from an entry card's "Ask AI" action, and `visibleTabs` still filters any `assistant: true` tab when the assistant is disabled). Active tabs use `tone.accent` + `font-semibold`, inactive `tone.textMuted` + `font-medium`, plus a non-typographic cue: a small `shape.pill` bar (`tone.accentBg`) under the label, transparent when inactive so the layout never shifts. While a sync cycle is in flight (`syncing`), the Settings tab additionally renders a `ProgressBar` (`src/ui`, absolutely positioned along its top edge) fed by `syncProgressFraction(syncProgress)` (`src/store/syncProgress`) — determinate once the current stream's upload total is known, an indeterminate sweep otherwise — so a long manual sync (SPEC §8.4, [data-and-sync.md](../subsystems/data-and-sync.md) §2b) stays visible from any screen, not just Settings itself.
- **Splash teardown**: when the store reports `ready`, adds the `done` class to `#splash` (defined in `index.html`) and removes the element after a 400 ms fade.
- **Lifecycle effects**: on mount calls `init()`; on `visibilitychange` (visible) calls `refresh()` only — returning to the foreground re-reads local state. There is no `online` listener and no automatic `drainSync`: Drive sync is manual-only, via the "Sync now" button in Settings (SPEC §8.4).
- **Background media understanding (opt-in)**: whenever `entries` change *and* `appSettings.enrichmentEnabled` is on, runs `drainTranscriptions(currentStreamId)` and `drainCaptions(currentStreamId)` in parallel; if either produced results, calls `refresh()`, which re-runs the effect until nothing is pending. `enrichmentEnabled` defaults to `false` (owner policy, issue #89) and is also in the effect's dependency array, so turning it on immediately re-runs the effect and backfills any backlog. This call-site check is defense in depth only — both runners independently early-return when the setting is off (see [pipelines-and-places.md](pipelines-and-places.md)), so no audio/photo can reach `transcribe.elimelt.com`/`llm.elimelt.com` while it's disabled. If a drain completes while the document is hidden, posts a best-effort `showAppNotification` ("N transcripts ready · M captions ready", tag `enrichment-done`) — see [notify.md](notify.md).
- **App-icon badge**: whenever `syncStatuses` change, sets the Home Screen badge to the pending-sync count (`summarizeSyncStatuses` → `badgeCount` → `applyAppBadge`); clears it at zero. A no-op where the Badging API is missing, and rendered on iOS only once notification permission is granted.
- **Global error toast**: renders `Toast` with a Dismiss action when `useAppStore().lastError` is set, auto-clearing after 6 s.
- **Update-available toast (issue #61)**: subscribes to `swUpdate` (`src/swUpdate.ts`) via `useSyncExternalStore`; when a new SW is waiting, renders a persistent `Toast` ("New version available", Reload action calling `swUpdate.apply()`) stacked above the error toast (`bottomRem={lastError ? 8.5 : 5.5}`) when both are showing at once.
- **Layout**: `max-w-md` column, bottom padding computed as `calc(3.5rem + env(safe-area-inset-bottom) + 1rem)` — the nav's own content height (`min-h-14`) plus its safe-area inset plus a 1rem gutter, so the last card always clears the bar even where the home-indicator inset is large — `pt-[env(safe-area-inset-top)]` because the iOS status bar style is `black-translucent` (content extends underneath it). Renders `ReconnectPill` (Drive re-auth prompt) above the routes.

### src/navTabs.ts

Pure data behind the tab bar, pulled out of `App.tsx` so it can be pinned by a hermetic test without importing the whole app shell: `interface NavTab { to; label; assistant? }`, the `TABS` array (`Capture` `/`, `Today` `/day`, `Settings` `/settings` — no assistant tab; `/chat` is reached from an entry card's "Ask AI" action), and `visibleTabs(tabs, assistantEnabled)`, a pure filter dropping assistant-gated tabs when disabled (currently the identity over `TABS`). `navTabs.test.ts` pins the route paths and current labels.

### src/main.tsx

Entry point. Calls `registerSW()` from `virtual:pwa-register` with three behaviors (issue #61): `onNeedRefresh` publishes the pending update (and how to apply it) to `swUpdate`, so `App.tsx` can offer a "Reload" toast rather than the SW silently taking over; `onRegisteredSW` polls `registration.update()` every hour and again on every `visibilitychange → visible`, since an installed standalone PWA can stay warm for days with no navigation to otherwise trigger a registration re-check. Also calls `navigator.storage?.persist?.()` — Safari can evict script-writable storage after ~7 days of disuse and Drive backup is the only other copy, so persistence is requested up front (SPEC §2.3). Renders `App` under `StrictMode → ErrorBoundary → BrowserRouter` into `#root`, and imports `./index.css`.

### src/swUpdate.ts

`createSwUpdateStore()` — a tiny `useSyncExternalStore`-compatible pub/sub (subscribe/snapshot/publish/apply), the same shape as `src/store/livetext.ts`'s live-text stores. Exists as a plain module-level store, not part of the Zustand `appStore`, because `main.tsx` runs outside the React tree and needs to publish an update-available signal before any component (or the store) has mounted. `swUpdate` is the app's one instance; `main.tsx` publishes into it, `App.tsx` subscribes to render the reload toast. Pure and hermetically unit-tested (`swUpdate.test.ts`).

### src/config.ts

Build-time constants: `GOOGLE_CLIENT_ID` (a public OAuth browser-client identifier — safe to ship in the bundle per SPEC §9.2), the OAuth scopes — `DRIVE_SCOPE`, `CALENDAR_READONLY_SCOPE`, and the combined `GOOGLE_SCOPES` requested in one consent — and `ENDPOINTS` (issue #69): currently just `{ assistant }`, consumed by `assistant/config.ts`. The transcription and vision-captioning endpoints are a separate, already-established fork/self-host seam in `src/enrich/config.ts` (issue #62) rather than duplicated here, since that module also pairs each endpoint with its model constant and both pipelines' `api.ts` already read from it — see [pipelines-and-places.md](pipelines-and-places.md). `config.test.ts` pins every host from **both** modules against `index.html`'s CSP `connect-src`, so a host move that forgets the CSP fails the suite instead of shipping opaque `connect-src` violations. There is deliberately no `APP_ORIGIN`: GIS validates the calling origin against the OAuth client's configured Authorized JavaScript origins in Google Cloud Console, not against anything shipped in the bundle (a stale `APP_ORIGIN` constant used to contradict README/docs without affecting behavior — removed rather than "fixed", since nothing ever read it). The scopes live in this neutral module (not in `drive/` or `gcal/`) so generic layers can compose them without breaking the SPEC §10 layering rule. No secrets live here.

### src/ui/index.ts

Barrel for the design system. Re-exports the tokens (`cx`, `layer`, `motion`, `shape`, `tap`, `tone`, `type_`), every primitive: `Button`, `IconButton`, `Card`, `TimelineRow`, `EmptyState`, `Section`, `ErrorBoundary`, `RouteErrorBoundary`, `OverlayPortal`, `Sheet`, `useBodyScrollLock`, `useKeyboardInset`, `ProgressBar`, `Toast`, `FieldRow`, `Select`, `TextArea`, `TextInput`, `Toggle`, the numeric-draft helpers (`parseNumericDraft`, `canCommitNumericDraft`, `commitNumericDraft`), `ScreenHeader`, and the shared icon set (`MicIcon`, `CameraIcon`, `TextCursorIcon`, `PlusIcon`, `PinIcon`, `TrashIcon`, `ChevronDownIcon`, `captureIcon`, types `CaptureKind`/`IconProps`). Screens import from here — never from token/palette classes directly (C15).

### src/ui/tokens.ts

Design tokens as constant objects of Tailwind class strings ("Warm Editorial Slate": Libertinus serif for content the user reads, system sans for UI chrome; palette values live in `src/index.css` `@theme`):

- `tone` — surface/background (`bg`, `surface`, `sunken`), borders (`border`, `borderStrong`), text ramp (`textPrimary`…`textFaint`, plus `textDerived`), spruce accent (`accent`, `accentBg`, `accentBgActive`, `accentWash`), clay danger (`danger`, `dangerBg`, `dangerBgActive`, `dangerWash`), `pressWash` for pressed states, and `railDot` (the filled accent dot marking a node on the timeline rail — the connecting line itself reuses the hairline `border`). Every entry pairs light and `dark:` classes. `textDerived` (#80) is the same hue as `textMuted`, named separately for machine-inferred content such as photo captions.
- `shape` — `card` (14 px radius), `control` (`rounded-xl`), `pill` (`rounded-full`).
- `type_` — typography scale, pinned to a functional contract (#85): serif tokens (`title`, `heading`, `body`, `bodyStrong`, `bodySmall`, `derived`) are for content the user reads as theirs — entry text, day titles, meaningful summaries, machine inference; sans tokens (`sub`, `caption`, `overline`, `ui`) are for chrome — time, duration, state, controls, metadata. `title` (serif 26 px), `heading` (serif 17 px), `body` (serif 16 px), `bodyStrong` (serif 17 px medium, `leading-snug` — main entry text: the user's typed notes, rendered in full and never clamped (#102), a step above descriptive metadata; the snug leading keeps it reading as a fragment of speech, not a headline), `bodySmall` (serif 14 px — secondary descriptive content like pseudo-entry notes), `derived` (serif 14 px italic, #80 revised — machine-generated text: transcripts and photo captions; pairs with `tone.textDerived`; never bolder than `bodyStrong`, pinned by a dedicated `tokens.type.test.ts` case), `sub` (sans 13 px), `caption` (sans 12 px), `overline` (sans 11 px uppercase), `ui` (sans 15 px, "chrome, never serif"). Named `type_` because `type` is reserved-ish. `tokens.type.test.ts` pins the serif/sans partition by asserting every serif key's class string contains `font-serif` (never `font-sans`) and vice versa, over an exhaustive key list — a regression here would silently break the whole discipline.
- `motion` — entrance animations (`fadeIn`, `riseIn`, `scaleIn`, `sheetIn`, `toastIn`); exits are instant via conditional rendering. Plus one continuous exception, `indeterminate` (`ProgressBar`'s sweeping fill for a phase with no known total) — still governed by the same `prefers-reduced-motion` kill switch in `index.css`, which collapses it to a static bar instead of hiding it. Keyframes live in `index.css`.
- `tap` — `'min-h-11 min-w-11'`, the 44 pt Apple HIG minimum tap target.
- `cx(...parts)` — joins truthy class strings.

### src/ui/Button.tsx

- `Button({ variant?, size?, block?, ...rest })` — extends `ButtonHTMLAttributes<HTMLButtonElement>`. `ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'dangerGhost'` (default `secondary`); `ButtonSize = 'md' | 'sm'` (default `md`; `md` uses the `tap` minimum, `sm` is `min-h-9`). `block` stretches to full width. Variants map to token compositions (e.g. `primary` = accent background + white text).
- `IconButton({ 'aria-label', variant?, ...rest })` — 44×44 px pill icon button, `variant: IconButtonVariant = 'outline' | 'ghost' | 'accent' | 'danger'` (default `outline`). `accent` is an accent-washed fill + border for controls that must read as interactive against a card surface (e.g. an entry's play button); `danger` is muted clay for destructive icon actions (e.g. the entry card's delete). `aria-label` is a required prop so icon-only buttons stay accessible.

### src/ui/Card.tsx

- `Card({ className?, children })` — bordered surface with 14 px radius, uniform `p-4` (16 px) padding on all sides, medium shadow in light mode and elevated shadow in dark mode for clear separation from the background.
- `Section({ title, children })` — titled `<section>` card (`p-4`, serif `type_.heading` `<h2>`); used for settings/content groups.
- `EmptyState({ title, children? })` — centered italic-serif empty message with optional sub-content.

### src/ui/TimelineRow.tsx

- `TimelineRow({ time?, first?, last?, children, className? })` — one node on the shared Day/Capture timeline rail. A fixed-width (`w-14`) left gutter carries a full-height vertical connecting line (a hairline `tone.border` `border-l`, absolutely centred on the dot column), the optional `time` label (the entry's tap-to-edit time button, or a calendar event's start time), and a `tone.railDot` dot; the node's own content sits in the `min-w-0 flex-1` right column, horizontally aligned to the dot. Consecutive rows rendered with no list gap read as one continuous rail — the line spans each gutter's full height so a row's line meets its neighbours'; `first` trims the stub above the first dot and `last` the stub below the last dot so the rail starts and ends at a node rather than dangling. A `ui` primitive (not a screen) so both `EntryCard` (`src/capture`) and `PseudoEntryCard` (`src/dayview`) compose the identical gutter without either importing the other — the layering rule holds and the rail geometry lives in one place. Tokens-only.

### src/ui/ErrorBoundary.tsx

Class component (the only way to catch render errors). On error it renders a full-height fallback with the error message and a Reload `Button`; `componentDidCatch` removes the `#splash` element so a crash during boot cannot leave the HTML splash covering the fallback. Wraps the whole app in `main.tsx`.

### src/ui/RouteErrorBoundary.tsx

A route-scoped sibling of `ErrorBoundary` (issue #66), for routes whose only failure mode shouldn't take down the whole shell. `RouteErrorBoundary({ children, title, body, onRetry })` renders `children` normally, or on error a smaller inline fallback (title/body copy + a Retry `Button` calling `onRetry`) — no `#splash` handling, since it never wraps the boot path. Doesn't reset its own error state internally: callers that need a genuine retry (e.g. `ChatRoute` re-running a lazy `import()`) pair `onRetry` with a `key` change on this component, since React.lazy caches a rejected import forever on its module-level reference and only a full remount with a freshly-constructed `lazy()` actually re-fetches.

### src/ui/Sheet.tsx

- `useKeyboardInset(): number` — hook tracking how much of the iOS software keyboard overlaps the layout viewport, via `window.visualViewport` resize/scroll listeners (`innerHeight − vv.height − vv.offsetTop`, clamped ≥ 0). Exported for fixed composers too (C12).
- `useBodyScrollLock(): void` — freezes the page behind a fullscreen overlay while mounted with `body { position: fixed; top: -scrollY }` (iOS ignores `overflow: hidden` and scrolls the body through fixed overlays) and restores scroll on unmount. Used by `Sheet` and the capture `PhotoViewer`.
- `Sheet({ title, onClose, children })` — modal bottom sheet (`role="dialog"`, `aria-modal`). Backdrop tap closes; inner clicks `stopPropagation()`. While mounted it freezes the page via `useBodyScrollLock`. Bottom padding is `max(safe-area-inset-bottom, 1rem) + keyboardInset` so content lifts above the keyboard. The whole sheet mounts through `OverlayPortal` on `layer.overlay`, so the backdrop covers (and blocks taps on) the tab bar; content animates in with `motion.sheetIn`.
- `OverlayPortal({ children })` — `createPortal(children, document.body)` for anything on `layer.overlay` (sheets, scrims, fullscreen viewers). Required because entrance animations run with fill `both`, which keeps screen roots and cards permanent stacking contexts: an overlay rendered in place would paint beneath the later-in-DOM tab bar regardless of its z-index. React events still bubble through the component tree.

### src/ui/ProgressBar.tsx

`ProgressBar({ fraction, className? })` — thin horizontal bar, `h-1` track (`tone.sunken`) with an accent fill (`tone.accentBg`). `fraction` (`[0, 1]`, clamped) renders a determinate fill that transitions its width; `null` renders an indeterminate sweeping fill (`motion.indeterminate`) for a phase with no known total. Deliberately generic — no sync-domain knowledge; callers (Settings' `GoogleSection`, `App`'s nav) compute `fraction` via `syncProgressFraction` (`src/store/syncProgress`). `role="progressbar"` with `aria-valuemin`/`aria-valuemax`/`aria-valuenow` (the last omitted while indeterminate).

### src/ui/Toast.tsx

`Toast({ children, actionLabel?, onAction?, bottomRem? })` — fixed transient toast (`role="status"`, `layer.raised`) positioned `bottomRem` (default `5.5`) rem above the safe-area bottom so it clears the tab bar. Inverted colors in light mode (`bg-ink text-paper`), card surface in dark. The message renders as a button that toggles between `truncate` (one line, the default) and `whitespace-pre-wrap` (full text) on tap, so a long message — e.g. a sync error — is no longer permanently clipped for the whole time the toast is on screen (issue #67); `aria-expanded` reflects the state. Renders an action button (e.g. Undo/Dismiss/Reload) only when both `actionLabel` and `onAction` are given. Not self-dismissing — callers own the timer (e.g. `App` clears `lastError` after 6 s) or persistence (the update-available toast stays until the user acts). `bottomRem` lets a caller stack a second toast above another that might be showing at the same time (`App` bumps the update toast to `8.5` when `lastError` is also set).

### src/ui/fields.tsx

Form primitives sharing a `FIELD` base (control radius, strong border, surface background, spruce focus border):

- `TextInput(props)` / `Select(props)` / `TextArea(props)` — thin wrappers over the native elements accepting all native attributes; inputs/selects get the `tap` minimum height, the textarea is full-width `text-base`.
- `Toggle({ checked, onChange, label })` — labelled iOS-style switch (`role="switch"`, `aria-checked`); `onChange` receives the new boolean.
- `FieldRow({ label, children })` — `min-h-11` label row with a trailing control.

### src/ui/numberDraft.ts

Pure draft-state helpers for numeric picker fields (place radius, max clip length).
Numeric inputs keep their in-progress value as a string so empty and partial input stay
representable while typing — the field never snaps back to a number mid-edit; validation
and min/max clamping happen only at the commit boundary (Save tap or blur), never per
keystroke. Exports: `parseNumericDraft(draft): number | undefined` (finite number, or
`undefined` when empty/invalid), `canCommitNumericDraft(draft): boolean` (the can-save
predicate — out-of-range values are still committable, commit clamps rather than
rejects), and `commitNumericDraft(draft, min, max?): number | undefined` (round to a
whole number and clamp into `[min, max]`; `undefined` for empty/invalid drafts so
callers skip the commit or disable Save). Unit-tested in `numberDraft.test.ts` (empty
allowed as draft but not committable, partial input, out-of-range clamping, round-trip).

### src/ui/ScreenHeader.tsx

`ScreenHeader({ title, subtitle?, trailing? })` — screen title row: serif `type_.title` `<h1>`, optional muted subtitle, optional trailing element (button etc.). Sits below the iOS status bar because `App` pads `main` with `env(safe-area-inset-top)`.

### src/ui/icons.tsx

Shared SVG icon set — every capture glyph is drawn once here so screens stay visually consistent. Each icon takes an optional `size` prop (px). `captureIcon(kind: CaptureKind)` is the single capture-modality → icon mapping (`audio` → `MicIcon`, `photo` → `CameraIcon`, `text` → `TextCursorIcon`), used by both the main capture CTA (`RecordPanel`) and the entry-card action row; `PlusIcon`, `PinIcon`, `SlidersIcon`, and `TrashIcon` cover add/location/edit/delete affordances (sliders — not the text cursor, which means *text capture* — marks the entry Edit sheet); `SparkleIcon` marks the entry card's "Ask AI" action; `ChevronDownIcon` (#78) marks the entry card's overflow/expand affordance, rotated 180° by the caller rather than drawn twice. The mapping is unit-tested in `icons.test.ts`.

### src/settings/SettingsScreen.tsx

Default-exports `SettingsScreen`; all state flows through `useAppStore`. Sections:

- **Google** (private `GoogleSection`): shows connection status from `driveConnection` (`connected` / `expired` / `disconnected`, mapped through `CONNECTION_LABEL`), refreshing it on mount. A private `SyncStatusLine` renders the store's aggregate `globalSyncSummary` (pending/error counts summed over **every** registered stream's sync rows + the oldest per-stream `lastSyncAt`, computed by `refresh()` — see [store.md](store.md)) above the buttons: "Out of sync" in the danger tone when anything is pending, anything errored, or any stream has never completed a clean cycle, else "Up to date"; plus "N entries waiting" / "N failed" counts, the last error message, and "Last synced …" / "Never synced". Connected → "Sync now" (`drainSync` — one pull+push cycle per registered stream, system streams included, disabled while `syncing`), "Disconnect", and the target-calendar picker (private `CalendarPicker`, backed by `src/gcal` — see [gcal.md](gcal.md)); otherwise a Connect/Reconnect primary button. While `syncing`, a live progress line + `ProgressBar` render below the buttons — `formatSyncProgress`/`syncProgressFraction` (`src/store/syncProgress`) over the store's `syncProgress` snapshot, e.g. "Uploading 3 of 12 · Timelog" with a determinate bar, or "Checking Settings for changes (2 of 3)" with an indeterminate one — and disappear once the cycle ends (`syncProgress` clears to null alongside `syncing`). A manual sync's aggregate `SyncResult` is *also* summarized inline afterwards via `syncResultLabel` — e.g. "Synced 2 entries · pulled 1 entry", "Sync busy — will retry shortly", or "Sync failed: …" — a separate, already-existing mechanism that `syncProgress` does not replace or duplicate: `syncProgress` is live-progress-only and carries no error state (a failure still surfaces only through `lastError`/the reconnect pill/`globalSyncSummary`, never a second, quieter channel).
- **Capture**: numeric max-clip-length field and a "Keep audio locally" toggle, both writing `streamSettings` via `updateStreamSettings`. The clip field is string-draft-backed (`src/ui/numberDraft`): while typing, the raw string — including empty — is shown untouched; valid values commit (clamped 10–120 s) as they're typed, empty/invalid drafts commit nothing, and blur snaps the field back to the last saved value.
- **Location**: `locationEnabled` toggle plus places management — lists saved places (name, radius, optional "near {address}" line, per-row `dangerGhost` Remove). "Add current location as place" calls `navigator.geolocation.getCurrentPosition` (8 s timeout, 60 s `maximumAge`, low accuracy) into `pendingPlace`; the inline form collects name and a string-backed radius draft (empty while editing is fine; "Save place" is disabled until both the name and the radius draft are valid), and `savePendingPlace` clamps the radius via `commitNumericDraft` (floor 10 m) and best-effort `reverseGeocode`s an address (never blocks the save) before `addPlace` with a `crypto.randomUUID()` id.
- **AI & privacy**: every AI/LLM feature is off by default (owner policy, issue #89), stated up front. `enrichmentEnabled` toggle ("Auto-transcribe & caption") gates automatic audio transcription (→ `transcribe.elimelt.com`) and photo captioning (→ `llm.elimelt.com`); copy states exactly what leaves the device and to where, and that turning it off never deletes transcripts/captions already generated (they're ordinary amend attachments in the append-only log). Directly below, a private `EnrichmentStatusLine` (issue #55: previously-invisible stuck items) loads `listSkippedTranscriptions()` + `listSkippedCaptions()` (`src/transcribe/runner.ts`, `src/vision/runner.ts`) on mount and whenever `enrichmentEnabled` toggles, and — only while enrichment is on and the combined count is nonzero — renders "N items couldn't be processed automatically" with a "Retry" button; the button clears every skip marker (`retryTranscription`/`retryCaption` per file), runs both drains once immediately against `currentStreamId`, calls `refresh()`, and reloads the count, so the user sees the outcome without waiting for the next entries-changed drain trigger. `assistantEnabled` toggle ("Enable AI assistant"); when on, shows the model label (`modelLabel(appSettings.assistantModel)` from `assistant/config`) and a note that "Ask AI" (from any entry card) runs against `llm.elimelt.com` and reads the log via tools; when off, states that no request leaves the device until the user sends a message.
- **Notifications** (`NotificationsSection.tsx`, self-contained): renders the honest capability state from `src/notify/capability` — unsupported / "add to Home Screen" hint (iOS Safari tab) / an "Enable notifications" button (permission requested in the tap handler, as iOS requires) / blocked-in-system-settings / granted (lists what notifications are used for: the pending-sync icon badge and background transcription alerts, plus a note that Capture has no server so nothing can push remotely). On grant it immediately applies the current pending-sync badge. See [notify.md](notify.md).
- **Data** (private `StorageLines`): local + Drive storage usage, then "Wipe local data". Local numbers come from the store (`localSpace`/`appSpace`, refreshed via `refreshSpace()` on entry and by `wipe()` so the display never goes stale): the origin-level `storage.estimate()` line ("On this device: X used of Y", hidden when the API is unsupported) and an app-data breakdown (log / attachments / chats via `formatBytes`, from `src/store/space`). The Drive line renders only when connected and is fetched on demand — a "Check Drive storage" tap calls `fetchDriveSpace` (`src/drive/space`) and shows account usage/quota plus this app's footprint; failures show an inline retry note. Never polled: Settings entry stays network-free. "Wipe local data" uses an inline two-tap confirm (`wipeArmed` auto-disarms after 4 s; no `window.confirm`, which feels broken in standalone PWAs); its resting-state caption now states it "clears this device's log, caches, and Google connection" (issue #65 — see [store.md](store.md) for what `wipe()` actually does). The armed second tap calls `wipe()` then `loadSettings()`.
- **Diagnostics** (private `DiagnosticsSection`, issue #67): read-only, on-device surface for the last full sync-cycle attempt, sourced from the store's `lastSyncResult` (persisted across relaunches — see [store.md](store.md)) rather than the transient `syncNote`/error toast. Renders nothing-attempted-yet as a plain sentence with the connection state; otherwise a one-line summary (`lastSyncAttemptSummary` — outcome plus non-zero uploaded/pulled counts) and a timestamp, plus a `tone.danger` line per stream via `notableStreamLines` (`src/settings/diagnostics.ts`, pure and unit-tested) for any stream that errored or was skipped after an earlier `reconnect` — this is the concrete fix for pull errors, which never write a `sync` row and previously vanished the moment the 6 s toast cleared.

### src/index.css

Tailwind v4 entry (`@import "tailwindcss"`). The `@theme` block defines the whole palette as CSS variables (paper/card/well surfaces, line borders, ink text ramp, spruce accent, clay danger — each with a `-dark` twin), the serif/sans font stacks, and the five entrance animations plus their keyframes and easings. Also: Leaflet fixes (undo Preflight's `img { max-width: 100% }` inside maps; isolate `.leaflet-container` into its own stacking context with capped pane z-indexes so inline maps never paint over `layer.overlay` sheets), a global `prefers-reduced-motion` kill switch, `overscroll-behavior: none` and no tap highlight on `html/body`, sans as the default body font (content opts into serif via tokens), and an `html` background matching `tone.bg` in both color schemes so nothing white shows behind iOS overscroll/home-indicator areas.

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

- A private `assert-chatscreen-chunk` plugin (issue #66): a `generateBundle` hook that fails the build unless exactly one emitted asset matches `ChatScreen-*.js` — the filename pattern the two `ChatScreen`-related config entries below hardcode, so a rename that breaks them fails at build time instead of silently precaching (or losing runtime-caching for) the AI SDK bundle.
- `@vitejs/plugin-react`, `@tailwindcss/vite`.
- `VitePWA` with `registerType: 'prompt'` (issue #61 — a new SW installs and waits; `src/main.tsx` decides when to apply it via `swUpdate`, instead of the SW silently `skipWaiting`-ing and reloading every open window mid-capture):
  - `workbox.globIgnores: ['**/ChatScreen-*.js']` keeps the lazy assistant chunk out of the precache; a `CacheFirst` runtime rule (`assistant-chunk`, 3 entries / 30 days) caches it for opted-in users instead.
  - `workbox.navigateFallbackDenylist: [/^\/agents/]` (issue #68) excludes `/agents` from the default SPA-shell navigation fallback, so a SW-controlled client navigating there gets the precached static guide page instead of being shadowed into `index.html` and bounced to `/` by the router's catch-all.
  - Runtime caching: Google Fonts stylesheets `StaleWhileRevalidate`; font files `CacheFirst` (12 entries / 1 year); OSM tiles `CacheFirst` (`osm-tiles`, 1000 entries / 30 days, `purgeOnQuotaError: true` — offline maps and minimal load on OSM); Nominatim `CacheFirst` (200 entries / 90 days — its usage policy requires client-side caching; IndexedDB caching is the first line, this the second). All of it — plus every other Cache Storage bucket — is dropped by `wipe()`'s `wipeCaches()` (issue #65; see [store.md](store.md)), since it holds a reconstructible location history the IndexedDB wipe alone never touched.
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

Dependency-free generator for the PWA icons (`node scripts/gen-icons.mjs`). Hand-assembles PNGs — CRC32 table, chunk framing, truecolor IHDR, `zlib.deflateSync` IDAT — and draws a slate square with a sky-blue database-cylinder glyph (top ellipse + three body bands on a 16-unit grid, mirroring `public/icons/icon.svg`, the SVG favicon). Writes `public/icons/icon-192.png` and `icon-512.png`, the files referenced by `index.html` (which prefers the SVG favicon, PNG as fallback and apple-touch-icon) and the PWA manifest in `vite.config.ts`.

### scripts/check-bundle-size.mjs

Dependency-free post-build guard (`npm run check:bundle-size`, issue #71). Reads `dist/assets/` after `vite build`: finds the entry chunk (`index-*.js`, the one `index.html` actually `<script type="module">`s — confirmed against the built `index.html` when the check was written) and fails if its byte size exceeds `ENTRY_BUDGET_BYTES` (450 KB — generous headroom over the ~310 KB baseline, tight enough that folding in the AI SDK, which roughly doubles it, still trips it) or if its source contains `AI_APICallError` (one of the `ai` package's error-class names — a stable marker that survives minification, unlike matching on the `@ai-sdk`/`ai` package name strings, which minification erases). Separately fails if no `ChatScreen-*.js` chunk exists at all (the assistant would have stopped being lazy-loaded). This is the guard for the architectural promise in this doc and `docs/ARCHITECTURE.md`: opted-out users never download the AI SDK.

### .github/workflows/ci.yml

The `CI` workflow runs on every pull request and every push to `main` (its badge, alongside deploy's, sits at the top of `README.md`). One job: checkout, Node 24 with npm cache, `npm ci`, `npm test`, `npx tsc -b` (explicit type-check step for a clearer failure signal), `npm run lint`, `npm run build`, `npm run check:bundle-size` (issue #71).

### .github/workflows/deploy.yml

GitHub Pages deployment on pushes to `main` (plus `workflow_dispatch`), with `pages: write`/`id-token: write` permissions and a `pages` concurrency group (in-progress runs cancelled). The `build` job: checkout, Node 24 with npm cache, `npm ci`, `npm test`, `npm run build`, `npm run check:bundle-size` (issue #71 — guards the exact bundle about to be published), then `cp dist/index.html dist/404.html` so Pages serves the SPA for client-side routes (Pages returns `404.html` for unknown paths), and uploads `dist/` as the Pages artifact. The `deploy` job publishes it with `actions/deploy-pages` into the `github-pages` environment.

### .github/workflows/integration.yml

Scheduled/manual workflow (issue #71) for the one live-network test in the suite, `src/assistant/transport.integration.test.ts` — previously exercised only when a human remembered to run `npm run test:integration` locally while touching the assistant transport. Triggers: weekly cron (`0 13 * * 1`, Monday 13:00 UTC) and `workflow_dispatch`. One job: checkout, Node 24 with npm cache, `npm ci`, `npm run test:integration`. Deliberately its own workflow, not a step in `ci.yml`/`deploy.yml`: a flaky or temporarily-down `llm.elimelt.com` must never block a PR or a deploy, but a genuinely broken transport (the AI SDK deps move fast) now shows up as a red scheduled run instead of silently rotting.

### .gitignore

Ignores logs, `node_modules`, build output (`dist`, `dist-ssr`), `*.local`, and editor/OS files (`.vscode/*` except `extensions.json`, `.idea`, `.DS_Store`, etc.).

## Key invariants & gotchas

- **Screens never hardcode palette/shape classes** (C15). All visual styling flows through `src/ui/tokens.ts` and the primitives; the raw color values live only in `src/index.css` `@theme` (and, duplicated by necessity, in `index.html`'s splash/theme-color and `vite.config.ts`'s manifest — keep all of these in sync when the palette changes).
- **Layering rule (SPEC §10), machine-enforced**: generic layers (`ui/`, `store/`, `capture/`, `contract/`, `streams/`, `drive/`, `places/`, `transcribe/`, `vision/`) must not import from `gcal/`, `dayview/`, `settings/`, or `assistant/`. `src/layering.test.ts` fails the build pipeline (tests run before deploy) on violations. Adding a new generic layer means adding it to the test's glob list and `LAYERS_EXPECTED_TODAY`.
- **The assistant chunk must stay lazy and out of the precache.** `App.tsx`'s `ChatRoute` `lazy()`-imports `ChatScreen`, and `vite.config.ts` excludes `ChatScreen-*.js` from the Workbox precache by filename pattern. A rename that breaks the globIgnore or the runtime-caching URL pattern now fails the build (the `assert-chatscreen-chunk` plugin) instead of silently misbehaving; the runtime cache being cold or a chunk fetch failing offline is still handled at runtime by `ChatRoute`'s `RouteErrorBoundary` (issue #66).
- **iOS-specific behaviors are load-bearing**: safe-area padding in `App` (status bar is `black-translucent`), the `useBodyScrollLock` `position: fixed` body scroll lock (iOS ignores `overflow: hidden`), `useKeyboardInset` via `visualViewport`, the 44 pt `tap` minimum, and the `html` background color painted for overscroll areas.
- **Boot splash lifecycle has two exits**: `App` fades and removes `#splash` when the store is `ready`; `ErrorBoundary.componentDidCatch` removes it on a boot crash. Any new early-exit path must also remove the splash or the UI stays hidden.
- **CSP is a meta tag in `index.html`** and must be updated whenever a new network endpoint is introduced (the comment above it enumerates the current ones). No inline scripts are allowed — the splash uses only CSS.
- **App tsconfig has no node types.** Tests under `src/` must avoid `node:*` imports (see `layering.test.ts`'s `import.meta.glob` approach); node-flavoured code belongs with `vite.config.ts` under `tsconfig.node.json`.
- **Sync has no backend scheduler and no automatic triggers**: sync cycles (pull then push) run only on manual "Sync now" in Settings — never on foreground or `online` events. Background enrichment (transcription/captioning) hooks the entries-changed effect in `App.tsx`; sync deliberately does not.
- **Z-index ladder lives in `layer` (`src/ui/tokens.ts`)**: Leaflet maps capped at `z-0` (isolated) → `layer.nav` (tab bar, sticky headers, `z-30`) → `layer.raised` (toasts, chat composer, `z-40`) → `layer.overlay` (sheets, fullscreen viewers, `z-50`) → boot splash `z-100`. Never hardcode a `z-*` class, and mount anything on `layer.overlay` through `OverlayPortal` — entrance animations (fill `both`) keep screens/cards permanent stacking contexts, so an in-place overlay gets trapped beneath the tab bar (the pre-fix navbar-over-sheet bug). `src/ui/tokens.test.ts` pins the ordering.
- **`Toast` does not auto-dismiss** — callers own dismissal timing (App uses 6 s for `lastError`; the update-available toast is left up until the user taps Reload). Multiple simultaneous toasts must be given distinct `bottomRem` values or they overlap.
- **SW updates are prompt, not silent** (issue #61). `registerType: 'prompt'` plus `swUpdate` means a new SW never takes over an open window without the user tapping Reload — do not switch back to `autoUpdate` without also solving the in-flight-recording/unsent-message data-loss hazard it reintroduces.
