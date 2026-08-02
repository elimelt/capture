# Subsystem: Application shell & UI

How Timebox boots, navigates, styles itself, moves state, and behaves as an installed
PWA. This is the cross-cutting view; for file-level detail see the module docs:

- [App shell, UI design system, and tooling](../modules/app-shell-ui-and-tooling.md)
  (`index.html`, `src/main.tsx`, `src/App.tsx`, `src/ui`, `src/settings`, `vite.config.ts`)
- [Capture and Day view](../modules/capture-and-dayview.md) (`src/capture`, `src/dayview`)
- [gcal](../modules/gcal.md) (`src/gcal` — the read-only Google Calendar layer behind the Day view)
- [Assistant](../modules/assistant.md) (`src/assistant` — the lazy Chat screen)

## Boot sequence

Boot is a three-stage handoff designed so the first paint is real content, never a
flash of empty state:

1. **`index.html`** paints a pure-HTML/CSS splash (`#splash`, `z-100`) before any JS
   loads. The same file carries the security and platform posture: a strict CSP meta
   tag (no inline scripts; every network endpoint — Google APIs, `llm.elimelt.com`,
   `transcribe.elimelt.com`, OSM tiles, Nominatim — must be whitelisted here), iOS
   standalone meta tags (`viewport-fit=cover`, `black-translucent` status bar), and the
   Google Identity Services script (`async defer`, the only third-party runtime script).
2. **`src/main.tsx`** registers the auto-updating service worker
   (`virtual:pwa-register`), requests persistent storage
   (`navigator.storage.persist()` — Safari can evict IndexedDB after ~7 days of
   disuse), and renders `<App />` under `StrictMode → ErrorBoundary → BrowserRouter`.
3. **`src/App.tsx`** calls the store's `init()` (hydrate entries, places, settings,
   Drive connection state in parallel, then an opportunistic `drainSync()`). When the
   store reports `ready`, App fades and removes `#splash`.

The splash has exactly two exit paths: App on `ready`, and
`ErrorBoundary.componentDidCatch` on a boot crash. Any new early-exit path must also
remove the splash, or the UI stays hidden behind it. `init()` sets `ready` in a
`finally`, so even a failed boot lifts the splash and surfaces the error.

## Screen map & navigation

Four screens, one route table in `App.tsx`, one fixed bottom tab bar:

| Route | Screen | Notes |
| --- | --- | --- |
| `/` | Capture (`src/capture/CaptureScreen`) | Screen 1; voice-first capture + today's entries |
| `/day`, `/day/:date` | Day view (`src/dayview/DayScreen`) | Screen 2; per-day timeline + read-only calendar events, prev/next-day nav via the route param |
| `/chat` | Chat (`src/assistant/ChatScreen`) | Opt-in; `lazy()`-loaded; guarded — redirects to `/` unless `assistantEnabled` |
| `/settings` | Settings (`src/settings/SettingsScreen`) | Screen 3; Google (Drive + target-calendar picker), capture, location/places, assistant, data |

Unknown paths redirect to `/`. The Chat tab is filtered out of the tab bar unless the
assistant is enabled, and its chunk (AI SDK + markdown) is never downloaded by users
who never enable it. Navigation is flat — tabs only, no nested routers or stacks;
"drill-down" interactions (text entry, location editing, chat history) are modal
bottom sheets, not routes. Deployment supports deep links by copying `index.html` to
`404.html` on GitHub Pages.

Beyond routing, `App.tsx` owns the app-level lifecycle: it runs a Drive sync cycle
(pull remote events, then drain the upload queue) on `visibilitychange` (visible) and
`online` events — the "natural gestures" the
no-backend token model relies on — and runs background transcription/captioning
whenever `entries` change, calling `refresh()` when work completed so the effect
re-runs until nothing is pending. New long-running background work should hook these
same triggers rather than invent its own scheduler.

The Day view additionally overlays **read-only Google Calendar events**: its
`useDayEvents` hook resolves the stored Google token and the target calendar chosen
in Settings, fetches that day's events through `src/gcal`
([module doc](../modules/gcal.md)), and renders them as rows deep-linking into
Google Calendar. Missing token, missing calendar pick, or a failed fetch are quiet
one-line notes, never blocking error states — local entries carry the day on their
own, and the app never writes calendar events.

## Design system

All visual identity lives in `src/ui/` (SPEC C15). The rule: **screens never hardcode
palette or shape classes.** They import tokens and primitives from the `src/ui` barrel;
the raw color values exist only in `src/index.css` under Tailwind v4's `@theme` (plus,
by necessity, the splash colors in `index.html` and the manifest colors in
`vite.config.ts` — keep those in sync on palette changes). A visual redesign edits
`tokens.ts`, `index.css`, and the primitives — not the screens.

- **Tokens** (`src/ui/tokens.ts`): `tone` (surfaces, borders, text ramp, spruce
  accent, clay danger — each pairing light and `dark:` classes), `shape` (card /
  control / pill radii), `type_` (serif for content the user reads, sans for UI
  chrome), `motion` (entrance animations only; exits are instant via conditional
  rendering), `tap` (the 44 pt minimum tap target), and the `cx` class combiner.
- **Primitives**: `Button`/`IconButton`, `Card`/`Section`/`EmptyState`, `Sheet` (modal
  bottom sheet with body scroll lock and keyboard-inset padding), `Toast` (transient,
  caller-owned dismissal — it never auto-dismisses itself), form fields (`TextInput`,
  `Select`, `TextArea`, `Toggle`, `FieldRow`), `ScreenHeader`, `ErrorBoundary`.
- **Z-index ladder** (keep new overlays within it): Leaflet maps capped at `z-0`
  (isolated stacking context in `index.css`, so inline maps never paint over sheets) →
  `Toast` `z-40` → `Sheet` `z-50` → boot splash `z-100`.

## State flow

There is exactly one store: the Zustand `useAppStore` (`src/store/appStore.ts`). It
caches the folded entry list, sync statuses, places, and settings in memory, and every
write delegates to the IndexedDB repositories. Data flows one way:

```
UI action → store action → repo write (IndexedDB txn) → re-read (refresh/load*) → set() → re-render
```

Screens never mutate entries in place — edits are `capture`/`amend`/`revoke` events
appended to the local log, and the entry list is always recomputed by folding it.
Capture and Day view funnel every card edit through the shared `EntryList`, which
translates callbacks into `amend` calls; Settings writes via
`updateSettings`/`updateStreamSettings`/place actions; the assistant only *reads*
(`useAppStore.getState()` getters injected into its tools).

Write actions are wrapped in a `guard(label, fn)` helper: on failure it sets
`lastError` to `"<label>: <message>"` and **re-throws** for awaiting callers. App
renders `lastError` as the single global error toast (auto-cleared after 6 s).
`drainSync` is deliberately unguarded — it runs from fire-and-forget triggers and
reports failures via `lastError` without throwing.

## PWA behavior

`vite-plugin-pwa` generates an auto-updating Workbox service worker (`vite.config.ts`):

- **Precache**: the whole build output *except* the lazy assistant chunk
  (`globIgnores: ['**/ChatScreen-*.js']`) — most users never enable the assistant, so
  its bundle stays out of every install. A `CacheFirst` runtime rule caches it for
  opted-in users instead. Renaming that component silently breaks both patterns.
- **Runtime caching**: Google Fonts stylesheets (`StaleWhileRevalidate`) and font
  files (`CacheFirst`, 1 year); OSM tiles (`CacheFirst`, 1000 entries / 30 days,
  `purgeOnQuotaError`) so maps work offline and OSM sees minimal traffic; Nominatim
  reverse-geocoding (`CacheFirst`, 90 days) as the second cache line behind the
  IndexedDB geocode cache, per Nominatim's usage policy.
- **Offline expectations**: capture, day view, and settings work fully offline —
  entries land in IndexedDB and the sync queue; the next foreground/online/manual
  trigger runs a full pull-then-push sync cycle. There is no backend and no push
  scheduler.
- **iOS specifics**: standalone display with a `black-translucent` status bar (content
  extends under it — App pads `main` with `env(safe-area-inset-top)`); persistent
  storage requested at boot because Drive is the only other copy of the log; iOS
  aggressively suspends backgrounded PWAs, so the capture screen commits any in-flight
  recording on `visibilitychange → hidden` rather than losing it; a pre-first-entry
  "Add to Home Screen" nudge appears for non-standalone visitors.

## Mobile/UX invariants

These behaviors are load-bearing on iOS; preserve them when adding UI:

- **Keyboard insets**: `useKeyboardInset()` (in `src/ui/Sheet.tsx`) measures software
  keyboard overlap via `visualViewport`; `Sheet` and fixed composers (chat) use it to
  lift content above the keyboard.
- **Body scroll lock**: while a `Sheet` is open, the page is frozen with
  `body { position: fixed; top: -scrollY }` and restored on unmount — iOS ignores
  `overflow: hidden` and scrolls the body through fixed overlays.
- **Pending-delete pattern** (`usePendingDelete`): delete hides the entry immediately
  (screens filter out `pendingId`) and shows a 5 s Undo toast; the `revoke` event is
  appended only when the window closes or the component unmounts, so undo needs no
  un-revoke mechanism in the append-only contract.
- **Tap targets**: everything interactive uses the `tap` token (44 pt minimum);
  `IconButton` requires an `aria-label`.
- **Safe areas & overscroll**: tab bar pads `env(safe-area-inset-bottom)`; toasts sit
  above the tab bar; the `html` background matches `tone.bg` in both color schemes so
  iOS overscroll never flashes white.
- **No `window.confirm`**: destructive actions use inline two-tap confirms (see
  Settings' wipe) — native dialogs feel broken in standalone PWAs.

A machine-enforced layering rule (`src/layering.test.ts`, SPEC §10) keeps the generic
layers (`ui/`, `capture/`, `store/`, …) from importing app-specific ones (`dayview/`,
`settings/`, `assistant/`, `gcal/`), so the design system and capture stack stay
reusable across future streams.
