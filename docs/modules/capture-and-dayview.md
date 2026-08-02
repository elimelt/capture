# Modules: `src/capture` and `src/dayview`

## Overview

### `src/capture`

The capture screen and its building blocks — Screen 1 of the app (SPEC §4.1). Voice is
the primary capture path: a large mic button starts/stops a `MediaRecorder` clip, with a
live level meter, elapsed timer, auto-stop at `streamSettings.maxClipSec`, and a discard
option. Camera and text entry are secondary paths one tap away. Every capture takes a
best-effort geolocation snapshot (`geo.ts`) that resolves concurrently with recording and
never throws. Captured entries appear in a same-day list of `EntryCard`s that support
playback, inline note/transcript editing, adding attachments (note/photo/audio),
changing the captured time, editing location on a map, a per-entry lifecycle badge,
undoable delete, and an Edit sheet (`EditEntrySheet`) that changes the capture date
and time and removes any attachment — every entry field is editable, always via new
`amend`/`revoke` events, never mutation.

The module writes exclusively through the zustand store (`src/store/appStore.ts`):
`capture` appends a capture event, `amend` patches entries (time, location, attachment
add/remove), and `revoke` deletes them. All writes land in the append-only local event
log (`src/store/events.ts`, folded per `src/contract`) and are drained to Google Drive
only from Settings' "Sync now" (manual-only, SPEC §8.4). Because of that, a fresh
entry's sync row sits at `queued` indefinitely; `lifecycle.ts` (#79) maps the entry's
real sync row plus its pending-enrichment state to one of three *display* lifecycles —
`'understanding'`, `'settled'`, `'failed'` — so "Queued" (infrastructure language) never
reaches the card. `LifecycleBadge` renders that mapping.

`EntryCard` renders its content **unconditionally** (#102, inverting #78's collapse):
time, place-label context, the entry's full primary text (no line clamp) or its primary
clip's waveform fingerprint, every other note/transcript and extra audio clip
(`AttachmentBody`), every photo in a tight capture-order grid (`PhotoGrid`), and the
compact place card — nothing attachment-shaped is ever hidden. The only things that
collapse are chrome: a single "+" affordance expands into a compact icon-only action
menu (add note / add photo / add audio / location / edit / delete — each icon still
carries an `aria-label`), and up to two **related memories** (#83 v1) stay behind their
own small "Related" reveal, since scoring them is a full-log scan (`related.ts`/
`useRelated.ts` — shared place, lexical overlap, and a recency factor; no embeddings, no
LLM calls, gated by a minimum-score threshold so nothing shows unless it genuinely
relates). Both toggles are view-local `useState`, never persisted, never an event.

### `src/dayview`

Screen 2 (SPEC §4.2): one merged, time-sorted per-day timeline of local entries and
the target calendar's events, with previous/next-day navigation via the `/day/:date?`
route. Real entries reuse `EntryList` and `usePendingDelete` from `src/capture`, so
day-view entries get the exact same editing and undoable-delete behavior as the
capture screen. Calendar events render as **pseudo-entries** (SPEC §3.6): editable
copy-on-write annotations over the read-only calendar — nothing is stored until the
user edits or hides one. The fetch (`useDayEvents.ts`) and the overlay core
(`src/gcal/overlay`) are documented in [gcal.md](gcal.md); the view-model, cards,
edit sheet, and overlay store live here.

## File-by-file

### src/capture/CaptureScreen.tsx

**Purpose:** Screen 1 — the capture screen. Default export `CaptureScreen()` (no props).

**Composition:** renders `ScreenHeader`, `RecordPanel`, a hidden photo `<input
type="file" accept="image/*" capture="environment">` (the plain camera button, always a
new capture), a second dedicated hidden photo input for the gesture accelerator's photo
add-on (always an amend — see below), either an `EmptyState` or `EntryList` for today's
entries, an optional `TextSheet` (plain text capture, and a second instance for the
accelerator's note add-on), and one of three toasts (captured-with-Undo,
deleted-with-Undo, discarded).

**Key behaviors:**

- **Contextual idle prompt (#76):** computes `PromptContext` from local state
  each render — `now` (`new Date()`), `todayCount` (`todayEntries.length`),
  and `minutesSinceLastCapture` (gap since `todayEntries[0]`, the newest
  entry, or `undefined` on an empty day) — and calls the pure `capturePrompt`
  (`prompt.ts`) to get the idle-state prompt line passed to `RecordPanel`.
  `todayEntries.length` is also passed through as `todayCount` for the panel's
  compact day-summary line. No new store state; this is a plain per-render
  derivation from the same `entries` array the today filter already uses.
- **Record tap flow** (`handleRecordTap`): when idle, notes the tap time
  (`tapStartRef`), kicks off `snapshotLocation(...)` into `locationRef` (a
  `Promise<GeoLocation | undefined>` resolving concurrently with recording), and calls
  `recorder.start(maxClipSec, onAutoStop)`. When recording, `recorder.stop()` then
  commits. Commit (`commitRef.current`) awaits the location promise, calls
  `capture({ capturedAt: toLocalIso(tapStart), location, attachments: [audio] })` —
  `capturedAt` is the moment the user tapped record, not when the clip ended — and
  **returns the `CaptureEvent`** so `handleCommitThen` (below) can target it.
- **Gesture accelerator's commit-then-add-on (#77 req. 3, `handleCommitThen`):** called
  by `RecordPanel.onCommitThen(kind)` only while actually recording. Stops the recorder
  and, if `recorder.stop()` resolved a result (it can resolve `null` if a race — auto-stop,
  background-commit — already finalized the recorder first; that's a no-op, matching req.
  8), commits via the same `commitRef.current` as a plain tap-to-stop, then sets
  `addOnTarget = { entryId, kind }`. An effect clicks the dedicated add-on photo input the
  instant `kind === 'photo'`; `kind === 'text'` renders a second `TextSheet`. Both resolve
  via a plain `amend({ targets: [entryId], attachments: [...] })` — the exact
  `EntryList.onAddPhoto`/`onAddNote` wiring, never a second `capture` event.
- **Background commit (A6):** iOS suspends backgrounded PWAs aggressively, so a
  `visibilitychange` → `hidden` listener stops an in-flight recording and commits it
  instead of losing it. `recordingRef`/`commitRef` are refs so the listener always sees
  current state without re-subscribing.
- **Passive location context (A5):** an effect probes `snapshotLocation` on mount and
  whenever the app returns to the foreground, producing the label under the mic button
  (`at <place>` when a saved place matches, `location on` when only coordinates are
  available, nothing when location is disabled).
- **Text/photo capture:** `submitText(text)` and `submitPhoto(file)` each snapshot
  location at submit time and call `capture` with a single `text` / `photo` attachment.
  `submitPhoto` and the gesture accelerator's photo add-on both run the file through
  `photo.ts#downscalePhoto` first (issue #58) — every photo attachment this screen ever
  builds is the downscaled/re-encoded JPEG (or the original blob, on a decode failure),
  never the multi-megabyte camera original.
- **Toasts:** a single `ToastState` (`captured` with `entryId`, or `discarded`)
  auto-clears after 5s. "Undo" on the captured toast calls `revoke([entryId])`
  immediately. Delete requests (`handleDelete`) clear any capture toast first so only
  one toast shows, then delegate to `usePendingDelete.request`.
- **Today filter:** shows entries where `!revoked`, `id !== del.pendingId` (hides the
  pending delete), and `localDateOf(capturedAt)` equals today; sorted newest-first.
- **Install nudge (C14):** before the first-ever entry, non-standalone visitors see an
  "Add to Home Screen" hint in the empty state (checks `display-mode: standalone` media
  query and iOS `navigator.standalone`).
- **Automatic place naming (§3.4):** after every successful capture,
  `maybePromptPlace(event)` checks `needsPlacePrompt(location, locationEnabled)` (from
  `geo.ts`) — a location captured at a coordinate matching no saved place (no
  `placeLabel`) opens `NamePlaceSheet`. Saving calls `addPlace` (with a best-effort
  `reverseGeocode` "near …" address) and retro-labels the just-captured entry via
  `amend({ targets: [entryId], patch: { location } })`; skipping just closes the sheet —
  the entry is already saved.

### src/capture/photo.ts

**Purpose:** Photo downscaling at the capture boundary (issue #58) — a camera
original (3-8MB JPEG/HEIC) is downscaled and re-encoded once here, before it ever
reaches `capture`/`amend`, so every replica (local IndexedDB, every other device's
pull) stores and syncs the same right-sized blob. Chosen over the alternative fix
shape offered by the issue (a `keepPhotosLocally` setting + on-demand pull,
mirroring `keepAudioLocally`) because photo *originals* were never the useful
artifact here — every consumer (thumbnails, the full-screen viewer, the vision
captioner's own 1024px re-encode) already works from a downscaled copy — and
because deciding this once at capture time avoids retrofitting a multi-GB backlog
later, which the issue calls out as the harder path.

**Exports:**

- `MAX_PHOTO_EDGE_PX = 2048` — long edge of the stored photo.
- `scaledDimensions(width, height, maxEdge): { width; height }` — pure: target
  dimensions preserving aspect ratio, capped at `maxEdge` on the long side, never
  upscaling. The tested core (`photo.test.ts`).
- `interface DownscaledPhoto { blob: Blob; mimeType: string }`.
- `downscalePhoto(blob: Blob): Promise<DownscaledPhoto>` — decodes with
  `createImageBitmap(blob, { imageOrientation: 'from-image' })` (bakes in EXIF
  rotation so a portrait doesn't land sideways), draws to a canvas sized by
  `scaledDimensions`, and re-encodes to JPEG at quality 0.85. Falls back to the
  original blob untouched on any decode/encode failure (exotic formats, no canvas
  context) — a bigger original beats a lost photo. Not unit-tested directly:
  `createImageBitmap`/`canvas` are browser APIs unavailable under the project's
  node test environment, the same untested-precedent as `vision/api.ts`'s
  identical canvas path.

Called from every place a photo attachment is built: `CaptureScreen.submitPhoto`,
the gesture accelerator's photo add-on, and `EntryList.onAddPhoto`.

### src/capture/photo.test.ts

Vitest unit tests for `scaledDimensions` (the tested pure core; `downscalePhoto`
itself isn't unit-tested — see above): a source already under the cap is left
untouched, a source exactly at the cap is never upscaled, landscape/portrait/square
sources downscale by their long edge preserving aspect ratio, and extreme aspect
ratios never round a dimension down to zero.

### src/capture/holdGesture.ts

**Purpose:** Pure gesture state machine for the mic-button tap/hold/drag accelerator
(#77) — pointer/time events in, a new state and an optional command out; no DOM, no
timers, no `Date.now()` inside. `RecordPanel` owns the real `PointerEvent`s and a single
`setTimeout(HOLD_MS)`, feeding this module the timestamps and coordinates it already has,
which keeps every transition (including timing/threshold boundaries) testable without
jsdom (`holdGesture.test.ts`).

**Exports:**

- `type GesturePhase = 'idle' | 'pressed' | 'holding' | 'dragging'`; `type GestureTarget
  = 'photo' | 'text' | 'cancel'`; `interface GestureState { phase: GesturePhase; target?:
  GestureTarget; pressedAt?: number }` (`pressedAt` is internal bookkeeping for
  `tick`/`release`'s `HOLD_MS` check).
- `type GestureCommand = 'tap' | 'commit' | 'commitThen:photo' | 'commitThen:text' |
  'discard'`.
- `HOLD_MS` (400) and `DRAG_PX` (40) — the hold-engage and drag-resolve thresholds,
  exported so `RecordPanel` and tests share one source of truth.
- `press(state, t)`: pointerdown → `'pressed'`, recording `pressedAt`.
- `tick(state, t)`: the caller's `HOLD_MS` timer firing while still pressed with no
  cancelling move → `'holding'`; a no-op everywhere else (already holding/dragging,
  already cancelled back to idle, or already released).
- `move(state, dx, dy)`: cumulative offset from the press point (not deltas). Before the
  hold engages (`'pressed'`), any offset past `DRAG_PX` reads as scroll intent and resets
  straight to idle — the whole candidacy is abandoned, so neither a tap nor a hold ever
  fires for that pointer sequence and the page can scroll normally. Once holding, the
  target is recomputed live from the current offset: the larger axis wins, horizontal
  splits left → `'photo'` / right → `'text'`, vertical-up → `'cancel'` (the "slide up to
  cancel" convention); vertical-down is deliberately unassigned (no location zone in v1)
  and just keeps the hold engaged with no target.
- `release(state, t)`: resolves to a `{ state; command? }`, always returning `state` to
  idle — a fresh `press()` is required before another command can fire, which is the
  invariant that rules out two commit-class commands from one press. `'pressed'` with
  `t - pressedAt < HOLD_MS` → `'tap'`; held past `HOLD_MS` with no target → `'commit'`;
  `'dragging'` with a target → the matching `'commitThen:*'`/`'discard'`.
- `cancel(state)`: pointercancel/pointerleave — an unconditional reset to idle, no
  command; the caller (`RecordPanel`) decides whether that requires discarding an
  in-flight recording.

**Tested invariants (`holdGesture.test.ts`, no jsdom):** tap/hold/drag-per-zone
boundaries (including the `HOLD_MS`/`DRAG_PX` edges, inclusive at the threshold);
pre-hold drift past `DRAG_PX` cancels candidacy and yields no command at all on release
(not even `'tap'`); sub-threshold drift never breaks a tap; a drag can retarget live
before release; releasing twice without an intervening `press()` is inert; and a fuzz
sweep of random press/move/tick/release sequences asserting a commit-class command is
never emitted without a preceding, still-armed `press()`.

### src/capture/RecordPanel.tsx

**Purpose:** The capture control — a pure presentational component driven by a
`Recorder` (from `useRecorder`).

**Export:** `RecordPanel({ recorder, maxClipSec, onTap, onDiscard, onCamera, onText,
onCommitThen, prompt, todayCount }: RecordPanelProps)` — a pure presentational
component; `prompt` and `todayCount` are computed by `CaptureScreen` (`prompt` via
`capturePrompt`, `todayCount` from the same today-filtered `entries` array), never
inside this component. `onCommitThen(kind: 'photo' | 'text')` is the gesture
accelerator's drag-to-satellite outcome (#77): commit the in-flight recording, then open
the matching add-on for the just-created entry.

**Behavior by recorder state:**

- `error`: full-width fallback with a message keyed off `recorder.errorKind` —
  `'denied'` points to iOS Settings (no "Try again" button, since retrying a denied mic
  is futile), `'failed'` offers "Try again" (`recorder.resetError`). Both offer "Type an
  entry" (`onText`), so capture never dead-ends.
- `recording` **and the gesture is idle**: focused panel with `LevelMeter` (fed
  `recorder.getLevel`), an m:ss timer, an "Ns left" countdown once `maxClipSec -
  elapsedSec <= 10`, and Discard / Done buttons (`onDiscard` / `onTap`). Unchanged by
  #76 — this is what a plain tap-to-start still shows.
- idle, **or an active hold/drag regardless of `recorder.state`** (#76 hierarchy pass,
  extended by #77): the large mic button is the sole dominant affordance, top-centered;
  directly below it, the contextual `prompt` line (`type_.sub`/`tone.textSecondary` —
  chrome, not content) and, once `todayCount > 0` and no gesture is active, a compact "N
  moments today" line (`type_.caption`/`tone.textFaint`) reclaim the space a static
  layout used to leave empty. Camera and text render as smaller (44px, `tap`-sized),
  visually subordinate `SatelliteButton`s offset below the mic (`tone.surface`/
  `tone.textMuted`, a plain hairline border) — still plain, individually tappable
  `<button>`s with unchanged `aria-label`s and `onCamera`/`onText` wiring, unaffected by
  whether the gesture ever engages.

**Tap/hold/drag accelerator (#77):** the mic button drives `holdGesture.ts` via
`onPointerDown`/`onPointerMove`/`onPointerUp`/`onPointerCancel` plus a React
`onPointerLeave` on the *wrapper* div (not the button — pointer-capture boundary events
aren't retargeted, so binding it to the small button would fire mid-drag the instant the
finger physically crosses its bounds and kill the feature). `touch-action: none`
(`touch-none`) is scoped to the mic button alone, so page scroll outside the capture
panel is unaffected (req. 7). The mic/satellite layout stays mounted for the entire
press→hold→drag→release sequence — it never unmounts into the full recording panel
mid-gesture, which would drop pointer capture — and only switches to that panel once
released back to idle with `recorder.state === 'recording'` (a plain tap-start).
Wiring:

- Pointerdown arms a single `setTimeout(HOLD_MS)`; if it fires before release/cancel,
  `tick()` transitions to `'holding'` and `RecordPanel` calls `onTap()` — the same
  state-aware handler a plain tap uses, so a hold starts recording exactly the tap-start
  way (never a separate code path, never a double-start).
- Pointerup resolves `release()`'s command: `'tap'` always calls `onTap()`;
  `'commit'`/`'commitThen:photo'`/`'commitThen:text'`/`'discard'` call
  `onTap()`/`onCommitThen(kind)`/`onDiscard()` **only if `recorder.state === 'recording'`**
  — the no-op guard for #77 req. 8 (a pointerup racing the iOS background-commit handler
  or `maxClipSec` auto-stop, both of which already claimed the recorder, must do
  nothing, never double-commit).
- Pointercancel/the wrapper's pointerleave call `cancel()` and, only if the gesture had
  reached `'holding'`/`'dragging'` and `recorder.state === 'recording'`, `onDiscard()` —
  same effect as the plain Discard button (req. 5).
- The button keeps a plain `onClick` (`onMicClick`) for keyboard/AT activation, which
  never fires a pointer event; a `suppressClickRef` set on every pointerup/pointercancel
  and cleared on the next macrotask stops the browser's trailing synthetic click (after
  a real pointer tap) from calling `onTap()` a second time, without ever disabling the
  button's native keyboard affordance (req. 7 — every gesture outcome the mic button can
  produce stays reachable without ever touching the gesture).
- Visual affordance (req. 6, tokens only): the live drag target highlights its
  `SatelliteButton` (`tone.accentWash`/`tone.accent`, `motion.scaleIn`); while holding
  still (no target), the elapsed timer replaces the prompt line; targeting `'cancel'`
  swaps that line to "Release to cancel" in `tone.danger`.

Private helpers: `SatelliteButton`, `clock()`. The mic/camera/text-cursor glyphs come from
the shared `captureIcon` mapping in `src/ui` (icons.tsx), which entry cards reuse so
their action buttons match the main CTA.

### src/capture/prompt.ts

**Purpose:** Pure, deterministic contextual prompt for the idle `RecordPanel`
(#76) — no I/O, no `Date.now()`/`Math.random()` inside the module, tested
directly in `prompt.test.ts` (no jsdom).

**Exports:**

- `interface PromptContext { now: Date; todayCount: number;
  minutesSinceLastCapture?: number }` — callers assemble this once per
  render (`CaptureScreen`) so the same context always yields the same
  prompt.
- `capturePrompt(ctx: PromptContext): string` — bucket priority: a capture
  under 15 minutes ago wins ("Anything else?"); a gap of 180+ minutes since
  the last capture nudges "Capture what just happened"; absent either
  signal, an empty day (`todayCount === 0`) gets a time-of-day opener
  (morning/afternoon/evening/night, e.g. "What should you remember?" in the
  morning) distinct from the generic prompt a day already in progress gets.
  Every bucket returns a non-empty string and the function never throws.

### src/capture/prompt.test.ts

Vitest unit tests for `capturePrompt`: stability for a fixed context (`toBe`
across repeated calls), distinctness of the empty-morning / recent-capture /
long-gap buckets, exact behavior at the 15- and 180-minute boundaries, and a
fuzz sweep over all 24 hours × counts `0/1/50` × gaps
`undefined/0/600` asserting the result is always a non-empty string and the
function never throws.

### src/capture/LevelMeter.tsx

**Purpose:** Scrolling live input-level visualization (A1) proving the mic is hearing
the user.

**Export:** `LevelMeter({ getLevel }: { getLevel: () => number })`.

**Behavior:** renders a `<canvas>` (36 bars × 3px, DPR-scaled, `aria-hidden`) and drives
it from a `requestAnimationFrame` loop. Samples `getLevel()` (0..1 RMS, boosted 2.5× and
clamped) every ~50ms into a rolling history, so the strip covers roughly the last 2
seconds, drawn right-to-left with a 3px minimum bar height. The rAF loop is cancelled on
unmount.

### src/capture/waveformMath.ts

**Purpose:** The signature visual primitive's pure core (#86) — reduces decoded PCM
samples to normalized peak buckets and turns those into bar geometry, no DOM/I/O; tested
directly (`waveformMath.test.ts`, no jsdom). Named `waveformMath` rather than the issue's
suggested `waveform` to avoid colliding with `Waveform.tsx` on case-insensitive
filesystems — the same `PhotoViewer.tsx`/`photoViewerMath.ts` split this module follows.

**Exports:**

- `WAVEFORM_BUCKETS` (32) — bucket count for a clip's fingerprint, in the same N ≈ 28–36
  range as `LevelMeter`'s 36-bar language (the "live antecedent": capture shows the
  waveform being born via `LevelMeter`, the card keeps it via this module).
- `MIN_BAR_HEIGHT` (3px) — `drawSpec`'s minimum bar height, mirroring `LevelMeter`'s
  3px-minimum convention.
- `interface Bar { x; y; width; height }` — one drawable bar in a caller-given box.
- `peaks(samples: Float32Array | readonly number[], buckets: number): number[]` —
  deterministic, pure reduction to `buckets` peak values in `[0, 1]`. Each bucket holds
  the max absolute sample in its window (fractional bucket boundaries, so
  `samples.length < buckets` still yields exactly `buckets` values, each window widened
  to at least one sample); the result is normalized so the loudest bucket is exactly 1,
  except an all-silent (or empty) `samples` maps to all 0 rather than dividing by zero.
  Non-finite samples (NaN/Infinity) are treated as 0 rather than propagating.
- `drawSpec(peaksArr: readonly number[], width: number, height: number): Bar[]` — pure
  geometry turning normalized peaks into vertically-centered bars inside a `width`×
  `height` box. Every bar is at least `min(MIN_BAR_HEIGHT, height)` tall, so silence (or
  the neutral placeholder `Waveform.tsx` renders while decoding) still shows a hairline
  strip rather than vanishing; out-of-range/non-finite peak values are clamped so a
  decoder's stray NaN never produces a NaN rect; a degenerate box or empty `peaksArr`
  yields no bars.

### src/capture/Waveform.tsx

**Purpose:** The signature visual primitive (#86) — a small, static, per-clip amplitude
glyph that is the entry's visual identity wherever its audio appears, doubling as the
playback progress indicator. Composes `waveformMath.ts`'s pure functions with the async
decode/cache/render glue `photoViewerMath.ts`/`PhotoViewer.tsx` don't need.

**Export:** `Waveform({ file, progress?, height?, className? }: WaveformProps)` — `file`
is the audio attachment's contract filename (the `blobs`/`waveforms` cache key);
`progress` (0..1, default 0) is `useAudioPlayback.progress`; `height` (default 24px)
sizes the strip, which always fills its parent's width. Renders an `aria-hidden`
absolutely-stacked pair of inline SVGs — a quiet base fingerprint plus a full-strength
accent copy clipped to the played fraction (`clip-path: inset(...)`) — so the played
portion and the signature are one element (req. 4). The clip-path transition is covered
by `index.css`'s global `prefers-reduced-motion` rule (collapses `transition-duration`),
so no extra reduced-motion handling lives here.

**Decode & cache (lazy, defensive — req. 2/3):** on mount, checks the `waveforms`
IndexedDB cache (`getWaveform`/`putWaveform`, `src/store/events.ts`) first; a cache miss
loads the blob (`getBlob`), decodes it via `AudioContext.decodeAudioData`, reduces the
first channel through `peaks`, renders it, and writes it back to the cache — so a clip is
ever decoded at most once across the app's lifetime. Decode is never triggered before a
card's first render (capture itself never touches this module). While decoding, the
component shows a neutral placeholder (an all-zero `peaks` array fed through the same
`drawSpec` — silence's own hairline-minimum rendering, so no placeholder-specific drawing
code is needed) so a card never blocks on this. On any failure — missing blob, no
`AudioContext`, or a `decodeAudioData` rejection (iOS `audio/mp4` is expected to work;
this is a silent best-effort fallback matching `useRecorder`'s `LevelMeter` precedent) —
the component renders `null`, leaving exactly the plain play control that existed before
this feature; it never throws or blocks the card.

**Placement (req. 4/5):** `EntryCard.tsx` mounts it beside the header play control when
the card's primary-content slot is already showing `vm.primaryText` (a transcribed
clip), and as the collapsed primary-content slot itself for audio-only entries (no
`primaryText`) — tapping it expands the card, like `PrimaryTextPreview`. `AttachmentBody`'s
`AudioRow` mounts one per extra clip (index ≥ 1) so the fingerprint reads as identity
everywhere the entry's audio appears, not just the header.

### src/capture/EntryList.tsx

**Purpose:** Maps `Entry[]` to `EntryCard`s and translates every card edit into a store
`amend` call — the single place where card callbacks become contract events.

**Export:** `EntryList({ entries, onDelete }: EntryListProps)` where `onDelete:
(entryId: string) => void` bubbles delete requests up to the owning screen (B9), which
hides the entry immediately and appends the revoke only after the undo window.

**Amend wiring per card:**

- `onSetTime(time)` → `patch.capturedAt = withTimeOfDayIso(entry.capturedAt, time)`
  (keeps the entry's date, changes only time-of-day).
- `onAddNote` / `onAddPhoto` / `onAddAudio` → amend with a single new `text` / `photo` /
  `audio` attachment. `onAddPhoto` runs the file through `photo.ts#downscalePhoto`
  first, same as `CaptureScreen` (issue #58) — no photo attachment anywhere in the app
  skips downscaling.
- `onEditText(oldFile, text, derivedFrom?)` → one amend that both removes the old file
  (`patch.removeAttachments: [oldFile]`) and adds the replacement text; `derivedFrom` is
  carried over so an edited transcript/caption stays machine-derived and is never
  re-derived.
- `onRemoveAttachment(file)` → `patch.removeAttachments: [file]`.
- `onSetLocation(location | null)` → `patch.location` when set, `patch.clearLocation:
  true` when null (the fold treats an absent `location` as "no change", so clearing
  needs an explicit flag).
- `onApplyEdit(patch)` → the patch verbatim (already assembled by
  `editPlan.draftPatch` from the Edit sheet's draft: a recomposed `capturedAt` and/or
  `removeAttachments`), so one sheet Save is exactly one amend event.

It also reads `streamSettings.maxClipSec` and looks up each entry's sync row by
`entry.id` from `syncStatuses`, passing the whole `SyncStatusRow | undefined` down as
`EntryCard`'s `sync` prop — `EntryCard` (not `EntryList`) computes the display
lifecycle, since it also needs the entry's attachments to derive
`hasPendingEnrichment` (`lifecycle.ts`, #79).

### src/capture/lifecycle.ts

**Purpose:** Pure display-lifecycle mapping (#79) — no I/O, no React; tested directly
(`lifecycle.test.ts`). Retires "Queued" from entry-card copy without inventing new
stored state: it's a mapping over the existing `SyncStatusRow` (`src/store/db.ts`) and a
derived pending-enrichment flag. Errors never get quieter than before.

**Exports:**

- `type EntryLifecycle = 'understanding' | 'settled' | 'failed'`.
- `entryLifecycle(sync: SyncStatusRow | undefined, hasPendingEnrichment: boolean):
  EntryLifecycle` — maps to `'failed'` whenever the row isn't `'uploaded'` yet and
  either `status === 'error'` or `error` is set (invariant: no input combination maps
  a recorded failure to anything else). The `error`-is-set half matters because
  `src/drive/queue.ts`'s retryable (429/5xx) and auth (401/403) failure paths record
  `error` but leave `status: 'queued'` for the next automatic retry (no backoff gate);
  keying off `status === 'error'` alone left those rows reading identically to a
  never-attempted queued entry — a repeatedly-failing upload (e.g. an oversized audio
  attachment) showed no failure indication at all, which is what made the "queued
  forever" report invisible rather than actionable. `status !== 'uploaded'` guards the
  other direction: the drainer clears `error` on a successful upload, so a row that
  failed once and later landed never keeps reading as failed. Otherwise:
  `'understanding'` while `hasPendingEnrichment`, else `'settled'` (covers both
  `'queued'` with no recorded error — manual-sync-only, so this is the common case —
  and `'uploaded'`, and an absent row for a never-queued pulled entry).
- `lifecycleLabel(lifecycle): string | null` — `null` for `'settled'` (render nothing);
  `'Organizing…'` for `'understanding'` (the design review's suggested quiet, integrated
  copy — covers photo captioning as well as audio transcription, so it reads better than
  "Listening…"); `'Upload failed — will retry'` for `'failed'` (unchanged from the old
  SyncBadge's error copy).
- `hasPendingEnrichment(entry: Entry): boolean` — true iff the entry has an audio or
  photo attachment with no machine text derived from it yet, reusing
  `isTranscript`/`isCaption` (`src/transcribe/plan.ts`, `src/vision/plan.ts`) rather than
  re-deriving the discriminator. Evaluated over the entry's current (folded)
  attachments, not the raw event history those two plan functions walk — a deliberate
  trade-off so the card can compute this synchronously from an `Entry` alone; true for
  the whole time a transcript/caption is streaming in, since the derived text has no
  persisted attachment until the runner's amend lands, so this one boolean covers both
  "pending" and "streaming" without consulting the live-text stores
  (`src/store/livetext.ts`) directly.

Pure function of its inputs, so it composes independently of the (concurrent)
`enrichmentEnabled` setting: with enrichment disabled, `hasPendingEnrichment` is always
false and non-error entries read `'settled'`.

### src/capture/lifecycle.test.ts

Vitest unit tests for `entryLifecycle`/`lifecycleLabel`/`hasPendingEnrichment`:
exhaustive over the 3 (`status`: `queued`/`uploaded`/absent) × 2 (`hasPendingEnrichment`)
space plus the `error` cases, the "a recorded failure always wins" invariant (including
a still-`queued` row carrying an `error` from a retryable/auth failure — must read
`'failed'`, not settle quietly — and a since-`'uploaded'` row carrying a stale `error` —
must never read `'failed'`), `lifecycleLabel`'s per-lifecycle copy (including that
`'failed'` mentions retry and `'settled'` is `null`), and `hasPendingEnrichment` over
audio/photo/note/mixed attachment combinations.

### src/capture/authorship.ts

**Purpose:** Pure authored-vs-generated classification (#80) — no I/O, no React; tested
directly (`authorship.test.ts`, no jsdom). The visual axis the design review asked for
("the user should immediately know what they said vs what the app inferred") is driven
**solely** by the existing `derivedFrom` contract on attachments (SPEC §3.3): no new
stored state, no heuristics on text content.

**Exports:**

- `type Authorship = 'authored' | 'spoken' | 'derived'` — `'authored'`: user-typed text,
  no `derivedFrom`. `'spoken'`: text derived from audio (a transcript) — machine-derived
  but represents what the user *said*, so it is classed with authored text, not
  inference (decision recorded on #80/#89, so implementers don't relitigate). `'derived'`:
  machine inference over the entry's content — photo captions today, any future derived
  text.
- `authorship(a: Attachment): Authorship` — absent `derivedFrom` → `'authored'`;
  `derivedFrom` set and `isCaption(a)` (`src/vision/plan`) → `'derived'`; `derivedFrom`
  set and not a caption → `'spoken'`. Depends only on `derivedFrom`/`kind`, never on text
  content, so two attachments with identical bodies but different `derivedFrom` always
  classify differently, and an edited transcript/caption (which preserves `derivedFrom`,
  per `onEditText`) never changes class.

### src/capture/authorship.test.ts

Vitest unit tests for `authorship`: note → authored, transcript → spoken, caption →
derived; exhaustive over attachment shapes with/without `derivedFrom` across all three
`AttachmentKind`s; the pinned invariant that identical text bodies differing only in
`derivedFrom` classify differently; class stability across an edit that preserves
`derivedFrom`; and that an orphan caption (source photo removed) still classifies as
`derived` — classification never depends on sibling-attachment presence.

### src/capture/cardView.ts

**Purpose:** Pure view-model for the entry card (#78, revised by #102) — no I/O, no
React; tested directly (`cardView.test.ts`). Builds on `groupAttachments`; never
re-derives grouping semantics, only picks/orders among them. #102's core inversion:
the card no longer has a content-hiding collapsed state, so this module's job changed
from "what does the collapsed card show" to "what leads, and what does the photo grid
render" — every attachment surfaces somewhere in `EntryCard`, and `extraCount` (the old
"+N hidden" hint) is gone along with the content it used to count as hidden.

**Exports:**

- `CardViewModel` — `{ primaryText?: { file: string; authorship: Authorship };
  primaryAudio?: Attachment; collapsedShowsLocation: boolean; photoGroups: PhotoGroup[] }`.
  `primaryText.authorship` is always `'authored'` or `'spoken'` in practice (a photo
  caption is never chosen as primary text below) but typed as the full `Authorship`
  union so callers compose against the one classification (#80) rather than
  re-deriving it from a raw `derivedFrom` string. `primaryText`/`primaryAudio` are now
  purely *layout* signals (which text leads; whether the header's compact waveform or
  the full-width audio-only one applies) — they no longer gate visibility, since any
  additional transcripts/notes/clips render too, via `EntryCard`'s unconditional
  `AttachmentBody`.
- `cardViewModel(entry, groups): CardViewModel` — `primaryText` is the first transcript,
  else the first user note (undefined for an audio-only or photo-only entry), with its
  `authorship()` (`authorship.ts`) precomputed; `primaryAudio` is the first audio
  attachment (the one that plays from the card header); `collapsedShowsLocation` mirrors
  the header's place-label/address condition; `photoGroups` is a pass-through of
  `groups.photoGroups` (every photo, paired with its captions, in capture order) — the
  source for the card's always-visible thumbnail grid (`PhotoGrid`).

### src/capture/cardView.test.ts

Vitest unit tests for `cardViewModel`: all-empty model for an attachment-and-location-
free entry, transcript-over-note primacy (asserting `authorship: 'spoken'` and
`'authored'` respectively), audio-only entries (`primaryText` undefined, audio as
primary), `collapsedShowsLocation` for place label / address / bare-coordinate /
no-location cases, and (#102) that `photoGroups` exposes every photo for the
always-visible grid — including alongside a primary text/audio (nothing is hidden any
more), deterministic capture-order ordering across multiple photos regardless of
caption-attachment insertion order, a captionless photo pairing with an empty
`captions` array rather than being omitted, and an empty array for a photo-free entry.

### src/capture/EntryCard.tsx

**Purpose:** One entry's card (#78, inverted by #102: **content is always visible;
actions are what collapse**): header (editable time, place label, lifecycle badge,
duration, play button), then unconditionally every note/transcript, every extra audio
clip, every photo (tight grid), and the place card, then a footer holding a "Related"
reveal and the single "+" action menu, plus the sheets/inputs those actions open.

**Exports:** `EntryCard(props: EntryCardProps)` and `timeLabel(iso: string): string`
(locale time like "9:04 AM"). Props: `entry`, `maxClipSec`, `sync?: SyncStatusRow`, and
callbacks `onDelete`, `onSetTime(time)`, `onAddNote(text)`, `onAddPhoto(file)`,
`onAddAudio(result)`, `onEditText(oldFile, text, derivedFrom?)`,
`onRemoveAttachment(file)`, `onSetLocation(location | null)`, `onApplyEdit(patch)` —
unchanged by #102's density pass, so `EntryList`'s amend wiring needed no changes.
The card computes its own `EntryLifecycle` from `sync` + `hasPendingEnrichment(entry)`
(`lifecycle.ts`, #79) and renders it via `LifecycleBadge`.

**Key behaviors:**

- **Content is always visible (#102):** there is no more content-hiding "collapsed"
  state or `expanded` toggle. `menuOpen` (the "+" action menu) and `relatedOpen` (the
  one thing still allowed to stay behind a reveal) are separate, unrelated, view-local
  `useState`s — never persisted, never an event — so opening one never implies the
  other. The pure `cardViewModel(entry, groupAttachments(entry.attachments))` still
  decides header layout and the photo grid's contents, but no longer decides what's
  visible at all.
- **Header grouping:** one flex row — time + place label tightly grouped on the left,
  sync badge + clip duration + play button pushed to the far right. The time label has
  no underline decoration; it is still the tap target for the native picker (below), and
  the Edit sheet provides the second, labelled path to the same field. The place label
  renders only when `vm.collapsedShowsLocation` is true. Both are metadata, not content
  (#85): the time button and place label are explicitly `type_.sub` (sans, tabular-nums
  on the time) — the row no longer wraps in `type_.body`, which previously leaked serif
  onto the time via inheritance.
- **Time editing (B8):** the time label is a button layered over an invisible
  `<input type="time">`; tapping calls `showPicker()` (fallback `focus()`) so iOS shows
  its native wheel picker. `onChange` fires `onSetTime` only for non-empty values.
- **Primary clip playback (B10):** the *first* audio attachment plays from the header
  via `useAudioPlayback(audio?.file)` as an `accent`-variant `IconButton` (accent wash +
  border so it reads as interactive against the card); while playing, a progress fill
  widens behind the ▶/■ icon. Later clips render inside `AttachmentBody`, always. A
  `Waveform` strip (`waveformMath.ts`/`Waveform.tsx`, #86, fed the same
  `playback.progress`) renders beside this button whenever the content area below
  *isn't* also showing this clip's fingerprint — i.e. whenever the card has
  `vm.primaryText` (a transcribed clip; the content area shows text, not audio). The one
  case that skips it is an audio-only card (no `vm.primaryText`), where the fingerprint
  renders full-width in the content area instead — the two conditions are mutually
  exclusive and exhaustive, so the fingerprint is never drawn twice for the same clip,
  and never absent while the audio is visible (req. 5), independent of `menuOpen`.
- **Content, unconditional (#102):** an audio-only entry (no `vm.primaryText`) leads
  with its `Waveform` fingerprint (#86) full-width, fed `playback.progress`, wrapped in
  a button that toggles playback on tap (replacing the old "tap to expand" — there is no
  expand any more). Then `AttachmentBody` mounts unconditionally: every transcript and
  note (the "primary" one is simply first in its render order — transcripts before
  notes — with no separate clamped preview any more, so it and every other text render
  identically, full text, no line clamp, tap-to-edit), every streaming transcript, every
  extra audio clip, and any orphan caption. Then `PhotoGrid` mounts unconditionally with
  `vm.photoGroups` (every photo, tight grid, capture order — see `PhotoGrid.tsx`). Then
  the `PlaceCard` row (when `entry.location` is set) — leaflet-free, no network, no map
  tiles in the feed (#81); tapping it sets `mapOpen`, which mounts the lazy `MiniMap`
  full-screen dialog. Leaflet's chunk loads only on that explicit tap.
- **Per-card recorder:** "Add audio" (in the "+" menu) uses its own `useRecorder()`
  instance so entries can hold multiple clips; while recording, the footer (the
  "Related" reveal and "+" menu) is replaced by a compact timer bar with Discard/Done.
  If that recorder errors, the menu's audio icon becomes a "mic unavailable, tap to
  retry" button that just calls `rec.resetError`.
- **Lazy Leaflet:** `MiniMap` and `LocationSheet` are `lazy()` imports wrapped in
  `Suspense fallback={null}`, keeping the Leaflet JS+CSS chunk out of the initial
  bundle; `MiniMap` additionally only mounts while `mapOpen` is true (#81), so opening
  it is the one thing that loads the chunk, not showing the place card or opening the
  location editor.
- Hidden photo input (camera capture) and a `TextSheet` for "Add note" mirror the
  capture-screen patterns.
- **The "+" action menu (#102, replaces #78's expanded labelled-action column):** a
  full-bleed hairline divider separates the card's content from a footer row. The single
  "+" `IconButton` (aria-expanded, aria-label "Add or edit"/"Close actions") toggles
  `menuOpen`; its `PlusIcon` rotates 45° into an "×" rather than drawing a second glyph.
  When open, six icon-only `IconButton`s appear to its left (`flex-wrap`, so they wrap
  on narrow viewports): "Add note", "Add photo", "Add audio" (or the mic-unavailable
  fallback), "Add location"/"Edit location" (`PlusIcon`/`PinIcon`), "Edit entry"
  (`SlidersIcon` — opens `EditEntrySheet`), "Delete entry" (`TrashIcon`, `danger`
  variant) — every action still carries the same glyph as the main CTA/edit affordances
  via `captureIcon` (`src/ui`), and every `IconButton` requires its `aria-label` at the
  type level, so an unlabelled action icon can't compile. Selecting any action closes
  the menu (`setMenuOpen(false)`) before opening its sheet/input. Menu state is plain
  `useState` — never touches the store, never logged.
- **"Related" reveal, its own toggle (#83 v1):** a quiet text button
  (`type_.caption`/`tone.textFaint`, `ChevronDownIcon` rotating 180°) at the footer's
  left, independent of the "+" menu — #102 explicitly allows related memories to stay
  behind their own reveal, since scoring them is a full-log scan (#83 req. 5's cost
  bound). `useRelated(entry, allEntries, relatedOpen)` — `allEntries` is
  `useAppStore((s) => s.entries)`, the whole folded log, not the screen's filtered
  subset, since relatedness can span any date. Renders nothing (no heading, no section)
  when the hook returns zero rows — the minimum-score threshold in `relatedEntries`
  already decided nothing genuinely relates, so the reveal can be tapped open onto
  nothing without that being a bug. Otherwise a quiet `RelatedRows` block (private)
  below the footer: a "Related" overline, then up to `RELATED_MAX_RESULTS` rows of
  `relativeDayLabel · reasonLabel` (meta line, `type_.caption`/`tone.textFaint`) plus a
  one-line snippet (`type_.derived`/`tone.textDerived`, #80 — this is the app's
  inference that another memory relates, not the user's own words in this position, so
  it gets the same quiet treatment as a photo caption or generated prose). Tapping a row
  navigates to `/day/<date>` of the related entry via `useNavigate` (react-router-dom) —
  no import of `dayview/` itself, so the layering rule holds.

### src/capture/editPlan.ts

**Purpose:** Pure planning core for the Edit sheet — the draft→amend translation,
tested directly (`editPlan.test.ts`), no I/O.

**Exports:**

- `EntryEditDraft` — `{ date: "YYYY-MM-DD", time: "HH:mm", removeFiles: string[] }`,
  the editable envelope fields of an entry.
- `draftFromEntry(entry): EntryEditDraft` — current values (`localDateOf` /
  `civilTimeOf` of `capturedAt` — both pure slices of the string's own civil
  fields, so the pair is consistent in the entry's zone), nothing staged.
- `toggleRemoval(draft, file): EntryEditDraft` — stages/unstages one attachment file
  for removal; pure, non-mutating.
- `draftPatch(entry, draft): AmendPatch | null` — the single amend patch a saved
  draft implies, or `null` when nothing changed (callers append no event for a no-op
  edit). Date/time changes recompose `capturedAt` via
  `zonedIso(draft.date, draft.time, entry.deviceTz)` (seconds zeroed, DST-resolved
  offset) — the entry's own zone, so an edit made from another timezone moves
  exactly the wall time the sheet displayed and preserves the entry's offset;
  removals are deduped and filtered to files the entry currently shows.

### src/capture/EditEntrySheet.tsx

**Purpose:** Per-entry edit sheet — the one place every envelope field of an entry is
editable: capture date (native `<input type="date">`, capped at today), time of day,
and which attachments the entry keeps.

**Export:** `EditEntrySheet({ entry, onSave, onClose }: EditEntrySheetProps)` where
`onSave(patch: AmendPatch)` receives one combined patch (never called for a no-op).

**Behavior:** holds an `EntryEditDraft` in state; each attachment renders a row
(kind label, async one-line text preview or 36px photo thumbnail from `getBlob`,
duration for audio) with a Remove/Restore toggle — staged removals stay visible,
struck through, until Save. Save is disabled while `draftPatch` is `null`; on tap it
emits the patch and closes. Removals are append-only fold-time hides
(`patch.removeAttachments`); note/transcript *text* editing stays inline on the card
(`AttachmentBody`), and location keeps its own map sheet.

### src/capture/attachmentGroups.ts

**Purpose:** Pure grouping of an entry's attachments for card rendering — no I/O,
tested directly (`attachmentGroups.test.ts`).

**Exports:** `groupAttachments(attachments): AttachmentGroups` plus the `PhotoGroup`
and `AttachmentGroups` interfaces. Splits attachments into machine **captions**
(`isCaption` from `src/vision/plan`: text with `derivedFrom` pointing at a `_photo`
file), audio **transcripts** (text with `derivedFrom`, not a caption), user **notes**
(text without `derivedFrom`), and **audio** (all clips, in order — the first plays
from the card header). Each photo is paired with the captions derived from it
(`photoGroups: { photo, captions }[]`, so thumbnail + caption render as one row);
captions whose source photo is no longer on the entry come back as `orphanCaptions`.

### src/capture/attachmentGroups.test.ts

Vitest unit tests for `groupAttachments`: empty input, transcript/note/caption
classification, photo↔caption pairing (only its own captions, attachment order
preserved), captionless photos, orphan captions when the photo was removed, and audio
clip ordering.

### src/capture/related.ts

**Purpose:** Pure local relatedness scorer (#83) — ranks candidate entries against
a target entry using only signals computable from data already on the device: no
I/O, no `Date.now()`/`Math.random()`, no embeddings, no LLM calls. Unit-tested
directly (`related.test.ts`).

**Exports:**

- `tokenizeEntryText(texts: string[]): Set<string>` — case-folds, strips
  punctuation (`/[^a-z0-9]+/` splitter), and drops stopwords and tokens under
  3 characters.
- `relatedEntries(target, candidates, opts?): RelatedResult[]` where
  `RelatedResult = { entryId; score; reasons: ('place' | 'words')[];
  sharedTerms?: string[] }`. Always excludes the target itself and any
  `revoked` candidate; gates on `opts.minScore` (default `RELATED_MIN_SCORE`
  = 0.3) and caps at `opts.maxResults` (default `RELATED_MAX_RESULTS` = 2).
  Deterministic ordering: score descending, ties broken by smaller day-gap
  then by entry id.
- `RELATED_MIN_SCORE`, `RELATED_MAX_RESULTS` — the display-gating constants.
- `firstLine(text, maxLen = 80): string` and `relativeDayLabel(iso, today):
  string` (pure day-label formatter — "Today"/"Yesterday"/"N days/weeks/months
  ago"/"N years ago[ today]" for a same-civil-day anniversary; `today` is
  supplied by the caller, never computed internally) and `reasonLabel(reasons,
  { placeLabel?, sharedTerms? }): string` (e.g. "Also at Office", `You've
  mentioned "ci flow" before`, or both joined with " · ") — the human-readable
  glue the related rows render.

**Scoring model:** two independently-weighted signals combine, then a
recency factor damps the sum:

- **Place** (`PLACE_SCORE` = 0.6): both entries have the same non-empty
  `placeLabel`.
- **Words** (`WORDS_MAX` = 0.5, scaled by the overlap coefficient
  `|shared| / min(|A|, |B|)` of the two entries' tokenized text):
  `WORDS_MAX` is kept below `PLACE_SCORE` so an exact place match always
  outranks a lexical-only match, however strong the overlap (pinned
  invariant).
- **Recency damping:** a day-gap between the two entries' own `capturedAt`
  fields (never wall-clock "now" — the module takes no `now` argument and
  stays pure without one) feeds a gentle decay (`RECENCY_HALFLIFE_DAYS` =
  90, floor `RECENCY_FLOOR` = 0.6) so a six-month-old strong match still
  clears the threshold, per the design review's explicit "six months ago"
  ask, while a much older or weaker match fades further.

**Future seam (documented, not built):** an entity/topic enrichment runner
(#51/#62's plan/api/runner pattern) could append per-entry derived
`text/json` attachments (`derivedFrom` the source audio/photo) whose terms
feed `tokenizeEntryText`/`relatedEntries` unchanged — the scorer doesn't care
whether a token came from a transcript or a future derived-topic attachment.

### src/capture/related.test.ts

Vitest unit tests (27 cases, no jsdom): tokenizer case-folding/punctuation/
stopword/short-token behavior; shared-place scores above lexical-only;
disjoint entries score 0 and are excluded even with the gate open; the
target itself and revoked candidates are never returned; `RELATED_MAX_RESULTS`
is respected; determinism (reversed candidate order produces the same
ordered output); `reasons`/`sharedTerms` accurately reflect the scoring path;
an empty-string `placeLabel` on both sides is never treated as a place
match; the pinned 180-day-old-strong-match invariant clears
`RELATED_MIN_SCORE`; a far-away weak-by-distance match scores below an
otherwise-identical close match; plus `firstLine`, `relativeDayLabel`, and
`reasonLabel` formatting cases.

### src/capture/useRelated.ts

**Purpose:** Async glue between the pure scorer and the UI (#83) — loads
each candidate's text attachments from IndexedDB (`getBlob`), tokenizes
them, and calls `relatedEntries`. Kept out of `related.ts` on purpose so
that module stays I/O-free.

**Export:** `useRelated(target: Entry, candidates: readonly Entry[], enabled:
boolean): RelatedRow[]` where `RelatedRow` extends `RelatedResult` with
`entry: Entry` and `snippet: string` (the candidate's `cardViewModel`
primary-text first line, else "Voice note"/"Photo", else empty).

**Behavior:**

- **Cost bound (#83 req. 5):** `enabled` gates all work behind card
  expansion — an unexpanded card computes nothing, so relatedness never
  runs for a whole feed, matching the same full-scan cost class as
  `search_entries` (`src/assistant/tools.ts`), acceptable at personal-log
  scale.
- **Session memoization:** a module-scope `tokenCache` (entry id → token
  set) means re-expanding a card, or an entry that appears as both a target
  and a candidate elsewhere, never re-reads or re-tokenizes the same blobs
  in one session; the cache is not persisted.
- Filters `candidates` to non-target, non-revoked entries before scoring —
  belt-and-suspenders alongside `relatedEntries`'s own exclusion.
- A stale-guard (`stale` flag set in the effect cleanup) discards results
  from a superseded run, matching the pattern used throughout this module
  for async blob loads.

### src/capture/AttachmentBody.tsx

**Purpose:** Renders an entry's text content and extra audio clips (#78, revised by
#102), classified along the authored-vs-generated axis (#80). Always mounted by
`EntryCard` now — #102's "content is always visible" inversion removed the `expanded`
gate this component used to render behind. Photos (and their removal) moved to
`PhotoGrid.tsx` (#102: a tight thumbnail grid replaces the old one-thumbnail-per-row
layout), so this component owns only text/audio and has no attachment-removal
affordance of its own.

**Export:** `AttachmentBody({ attachments, onEditText }: AttachmentBodyProps)`; also
exports `useLiveText` (the shared `useSyncExternalStore` wiring for a `LiveTextStore`),
`StreamingText`, `AUTHORSHIP_STYLE`, and `EDIT_TITLE` — all reused by `PhotoGrid.tsx` so
in-grid captions compose the exact same tokens/edit flow rather than re-deriving them.

**Ordering/classification:** delegates grouping to the pure `groupAttachments`
(`attachmentGroups.ts`) and per-attachment classification to the pure `authorship()`
(`authorship.ts`). Render order: transcripts (the first one — transcript-over-note — is
what `cardViewModel` calls `primaryText`, but it renders identically to every other
transcript/note here; there is no separate clamped "primary" preview any more), then
any still-**streaming** transcripts, notes, extra audio rows (clips beyond the first,
which plays from the card header), then any orphan captions (photo since removed — the
one caption case still handled here, since it has no photo left to sit beside in
`PhotoGrid`). Returns `null` if every group is empty (streaming transcripts count — a
fresh audio-only entry shows its transcript growing).

**Type scale (#80):** authored notes and spoken transcripts both render at
`type_.bodyStrong`/`tone.textPrimary` — the heaviest, darkest treatment, **full text, no
line clamp** (#102: "content is always visible") — since both are the user's own words;
a transcript additionally gets the quiet `SpokenMark` glyph (small muted mic icon,
`aria-hidden`) inline before the text, noting it was transcribed rather than typed,
without ever reading lighter than a note. Orphan captions render in
`type_.derived`/`tone.textDerived` (serif, italic, 14 px) — never bolder than
authored/spoken text. The composition table (`AUTHORSHIP_STYLE`) and the `TextSheet`
edit-title table (`EDIT_TITLE`) are both keyed by `Authorship`, so every call site
(including `PhotoGrid`) agrees with the classifier.

**Key behaviors:**

- **Streaming transcripts.** The component subscribes (`useLiveText`, one
  `useSyncExternalStore` per store) to the transient `liveTranscripts` store
  (`src/store/livetext.ts`), where the transcription runner publishes partial text keyed
  by source file while a request streams. For each audio attachment with **no persisted
  transcript yet**, non-empty live text renders as a read-only `StreamingText` — same
  tokens, position, and `SpokenMark` as the final `NoteText`, plus a pulsing cursor tick,
  `aria-live="polite"`, and nothing to tap (there is no attachment to edit until the
  amend lands) — the same `'spoken'` authorship treatment as its eventual final form
  (#80 req. 6), so nothing re-styles when the amend lands. Once a persisted transcript
  exists it always wins over live text. Streaming *captions* are `PhotoGrid`'s concern
  (rendered beside their photo, keyed the same way against `liveCaptions`).
- `NoteText` loads its text asynchronously via `getBlob(file)` (renders nothing until
  loaded; guards against stale sets on unmount). Tapping opens the shared edit
  `TextSheet`, titled "Edit note" / "Edit transcript" per `EDIT_TITLE[
  authorship(attachment)]` (orphan captions title "Edit caption"); save calls
  `onEditText(file, text, derivedFrom)`.
- `AudioRow` is a playback row (via `useAudioPlayback`) with the same progress-fill
  toggle button, a `Waveform` fingerprint strip (#86, same `playback.progress`) beside
  it, plus "Recording · Ns" caption — the entry's signature reads consistently on every
  clip beyond the header's primary one.

### src/capture/PhotoGrid.tsx

**Purpose:** Tight thumbnail grid for an entry's photos (#102) — replaces the old
one-64px-thumbnail-per-row-with-caption-beside layout (formerly in `AttachmentBody`)
with a 3-across CSS grid, so photos read as content at a glance instead of hiding
behind expansion. Always mounted by `EntryCard`, fed `cardViewModel(...).photoGroups`
(every photo, capture order) — nothing photo-shaped is hidden any more.

**Export:** `PhotoGrid({ photoGroups, onEditText, onRemoveAttachment }: PhotoGridProps)`.
Renders `null` for an entry with no photos.

**Behavior:** each tile keeps the full previous feature set, just laid out more
tightly — `grid-cols-3 gap-1.5`, each cell an aspect-square thumbnail button. Tapping a
thumbnail opens the existing full-screen `PhotoViewer` (with its own "Remove photo"
action, wired to `onRemoveAttachment`); a persisted caption renders below its tile
(`AttachmentBody`'s exported `AUTHORSHIP_STYLE.derived`/`EDIT_TITLE.derived` tokens,
`line-clamp-2` — the one deliberate clamp left in the card, since an unclamped caption
could blow out a grid cell's compactness) and is tappable to edit inline via the shared
`TextSheet`, exactly like `AttachmentBody`'s `NoteText`; a still-**streaming** caption
(subscribed via the exported `useLiveText(liveCaptions)`, keyed by the *photo's* file —
the caption runner's source key) renders with `AttachmentBody`'s exported
`StreamingText` in place of a persisted caption, and is not tappable (nothing to edit
until the amend lands).

### src/capture/PhotoViewer.tsx

**Purpose:** Full-screen zoomable photo viewer (B7) opened from `PhotoGrid`'s tiles.

- Edge-to-edge on a black backdrop (`fixed inset-0`), image fit-contained; mounts via
  `OverlayPortal` on `layer.overlay` and locks body scroll with `useBodyScrollLock`.
  The entrance animation lives on a wrapper div, never on the `<img>` — the fill-`both`
  keyframes would pin the img's `transform` and fight the gesture transform.
- **Gestures** (hand-rolled pointer events, `touch-action: none`, no dependencies):
  pinch-to-zoom around the pinch midpoint, double-tap toggling fit ↔ 2.5× at the tap
  point, one-finger pan while zoomed (clamped to the image, never dismisses), and
  non-passive wheel/trackpad zoom anchored at the cursor. Releasing a two-finger pinch
  hands off to a pan when one finger stays down.
- **Dismissal:** safe-area-aware close button (top right, high-contrast on any image),
  backdrop tap at fit zoom, swipe-down at fit zoom (the image follows the finger and
  the backdrop fades; release past `shouldDismiss` closes, otherwise it springs back),
  and Escape.
- **Accessibility:** `role="dialog"`/`aria-modal`, alt text loaded from the caption
  attachment (`getBlob`), focus moves to the close button on open and returns on close,
  and Tab cycles within the dialog's controls.
- All geometry is delegated to `photoViewerMath.ts`; the component only wires pointer
  events (pointer positions are translated to container-center coordinates first).

### src/capture/photoViewerMath.ts

**Purpose:** Pure, DOM-free geometry for `PhotoViewer` (tested hard in
`photoViewerMath.test.ts`).

- Model: `scale` is relative to the fitted image (1 = fit, clamped to `[1, 4]`);
  `offsetX/offsetY` translate the image center from the container center in screen px,
  applied after scaling. Anchors (taps, pinch midpoints, cursors) use the same frame.
- The invariant every zoom preserves: content under the anchor stays under the anchor
  (`offset′ = A − (A − offset)·s′/s`), then `clampOffset` pins the image so an edge
  never crosses into the container (centered on any axis where it is smaller).
- Exports `fitContain` (upscales small images — full-screen viewer), `zoomAt`, `pan`,
  `pinch`, `doubleTapTarget` (any zoomed state returns to fit), `wheelZoom`
  (exponential in deltaY so steps compose), `shouldDismiss` (distance or flick
  velocity), `dismissBackdropOpacity`, and `midpoint`/`distance` helpers.

### src/capture/TextSheet.tsx

**Purpose:** Shared bottom-sheet text form (A3) used for text capture, "+ note", and
note/transcript/caption edits.

**Export:** `TextSheet({ title, placeholder, cta, initial?, onSave, onClose }:
TextSheetProps)`.

**Behavior:** auto-focused 3-row `TextArea` prefilled with `initial`; the primary button
is disabled while the trimmed text is empty and, on tap, calls `onSave(trimmed)` then
`onClose()`. Cancel just closes. Built on the shared `Sheet` from `src/ui`.

### src/capture/NamePlaceSheet.tsx

**Purpose:** Prompt shown after capturing at a location the user has never named (§3.4).
Naming it saves a Place (future captures auto-label) and retro-labels the just-captured
entry; skipping is always fine — capture never dead-ends.

**Export:** `NamePlaceSheet({ address?, onSave, onClose }: NamePlaceSheetProps)` where
`onSave: (name: string, radiusM: number) => void`.

**Behavior:** shows an optional "near …" hint under the title, an auto-focused name
field, and a string-backed radius field (so it can be momentarily empty while editing;
initialized to `DEFAULT_PLACE_RADIUS_M` = 50 m); the radius is validated and clamped
only on save via `commitNumericDraft` from `src/ui` (floor 10 m). "Save place" is
disabled until the trimmed name is non-empty and the radius draft is a valid number;
both buttons close the sheet.

### src/capture/LocationSheet.tsx

**Purpose:** Location editor sheet — treats location as an input like note/photo/audio.
Lazy chunk (pulls in Leaflet only when opened).

**Export:** `LocationSheet({ initial?, onSave, onClear, onClose }: LocationSheetProps)`
where `onSave: (location: GeoLocation) => void` and `onClear: () => void`.

**Key behaviors:**

- A react-leaflet `MapContainer` (OSM tiles) centered on `initial` or a San Francisco
  default; tap the map (`ClickToPlace` via `useMapEvents`) or drag the pin to set
  `pos`. The pin is a vector `L.divIcon` (clay dot) to avoid Leaflet's default marker
  PNGs, which break under bundlers without extra asset config.
- "Use current location" calls `snapshotLocation(places, locationEnabled)` with a
  "Locating…" busy state; a failed/disabled snapshot leaves `pos` unchanged.
- **Save** re-runs `matchPlace(places, lat, lng)` and awaits
  `reverseGeocode(lat, lng)` (from `src/places`), then emits `{ lat, lng, accuracyM:
  initial?.accuracyM ?? 0, placeLabel?, address? }` — i.e. a manually placed pin has
  `accuracyM: 0` and place/address are recomputed for the new coordinate. Save is
  disabled until a position exists.
- "Clear" (only when `initial` exists) calls `onClear()` then `onClose()`; upstream this
  becomes `patch.clearLocation: true`.

### src/capture/placeCardModel.ts

**Purpose:** Pure place-card label derivation (#81) — no I/O, no React; unit-tested
directly (`placeCardModel.test.ts`, no jsdom). The single source of truth for "what do
we call this location", shared by `PlaceCard.tsx` and `MiniMap.tsx`'s full-screen
dialog labelling so neither re-derives the placeLabel/address fallback independently.

**Exports:**

- `locationName(location): string | undefined` — `placeLabel` wins, else
  `"near <address>"`, else `undefined`. A single-line label for call sites (the map
  dialog's header and pin popup) with no separate title/subtitle slots.
- `interface PlaceCardModel { title: string; subtitle?: string }` and
  `placeCardModel(location): PlaceCardModel` — a place label leads as `title` with its
  address as a secondary `subtitle` (only set when *both* exist); an address alone
  becomes the `"near <address>"` title with no subtitle; a bare coordinate (no label,
  no address) falls back to the generic title `"Location captured"`. Never emits raw
  `lat`/`lng` in either field (pinned invariant, `placeCardModel.test.ts`).

### src/capture/PlaceCard.tsx

**Purpose:** Compact place card (#81) — represents an entry's location without loading
Leaflet, fetching map tiles, or making any network request. Replaces `MiniMap`'s old
always-mounted 96px map-tile preview, which no longer exists; the interactive map is
now one explicit tap away.

**Export:** `PlaceCard({ location, capturedAtLabel?, onExpand }: { location:
GeoLocation; capturedAtLabel?: string; onExpand: () => void })`. `capturedAtLabel` is
optional and unused by `EntryCard` (its header already shows the capture time) — kept
for other call sites (e.g. a future Settings places list) that don't already show one.

**Behavior:** a single tappable row — no new bordered surface, just a row inside the
entry's `Card` (#81 req 5) — with a `PinIcon`, the `placeCardModel` title in
`type_.bodyStrong`/`tone.textPrimary` (serif; an explicit exception to the #85 "sans is
chrome" default, per the issue), and, when present, the subtitle in
`type_.caption`/`tone.textMuted`. Tapping anywhere on the row calls `onExpand`.

### src/capture/MiniMap.tsx

**Purpose:** Full-screen interactive location map (#81) — the only Leaflet surface left
in the entry card. Lazy chunk (Leaflet JS + CSS) loaded only while the dialog is open,
i.e. only after an explicit tap on `PlaceCard`, never merely because a card is expanded
or in view.

**Export:** default `MiniMap({ location, onClose }: { location: GeoLocation; onClose:
() => void })`. Callers own the open/close boolean (`EntryCard`'s `mapOpen` state) and
mount this only while it's true; there is no compact/preview mode anymore.

**Key behaviors:**

- `Recenter` helper: react-leaflet's `MapContainer` reads `center`/`zoom` only on mount,
  so after a location amend the map would keep showing the old spot; `Recenter` calls
  `map.setView` imperatively whenever the coordinate changes.
- Full-screen dialog (zoom 16, interactive) with a header (`locationName` label + a
  "Done" button calling `onClose`) and a `Popup` label on the marker, plus, when
  `placeLabel` is set, a spruce accuracy `Circle` of radius `max(accuracyM, 40)` meters.

### src/capture/LifecycleBadge.tsx

**Purpose:** Per-entry display-lifecycle badge (#79; replaces the old SyncBadge).
Renders the pure `entryLifecycle` mapping (`lifecycle.ts`) instead of raw sync status,
so "Queued" cannot reach the card.

**Export:** `LifecycleBadge({ lifecycle }: { lifecycle: EntryLifecycle })`.

**Behavior:** renders nothing when `lifecycleLabel(lifecycle)` is `null` — the
`'settled'` case, covering both a still-`queued` (manual-sync-only, SPEC §8.4) and an
already-`uploaded` entry with nothing pending; a synced-or-merely-queued entry needs no
chrome. `'understanding'` renders quiet muted text with no dot ("Organizing…"), read as
ambient processing rather than infrastructure. `'failed'` renders a small danger dot +
label ("Upload failed — will retry") — unchanged from the old SyncBadge's error case,
so real failures never get quieter.

### src/capture/recorderEngine.ts

**Purpose:** Framework-free `getUserMedia` + `MediaRecorder` controller — every ref,
timer, and recorder/track event handler `useRecorder.ts` needs, kept out of React so it
can be unit-tested directly (stub `navigator.mediaDevices`/`MediaRecorder` with
`vi.stubGlobal`, the same pattern as `notify/badge.test.ts`) without a DOM or a hook
renderer. Negotiates the audio container at runtime — iOS Safari records `audio/mp4`,
not webm, so the mime type is picked from `['audio/mp4', 'audio/webm;codecs=opus',
'audio/webm']` via `MediaRecorder.isTypeSupported`, never hardcoded.

**Exports:**

- `createRecorderEngine(callbacks: RecorderEngineCallbacks): RecorderEngine`, where
  `RecorderEngineCallbacks = { onStateChange, onElapsed, onErrorKind }` and
  `RecorderEngine = { start(maxSec?, onAutoStop?), stop(), cancel(), resetError(),
  getLevel(), destroy() }` — `destroy` releases the mic/timers/`AudioContext` and is
  the engine's half of `useRecorder`'s unmount cleanup.
- `buildResult(chunks: Blob[], recorderMimeType: string, startedAtMs: number, nowMs:
  number): RecordingResult | null` — pure blob assembly (mime falls back to the first
  chunk's type then `audio/webm`; `durationSec` is wall-clock, rounded, minimum 1;
  empty blobs resolve `null`), shared by every stop path below so an out-of-band stop
  is delivered identically to a clean one.
- `interface RecordingResult { blob: Blob; mimeType: string; durationSec: number }`,
  types `RecorderState`, `RecorderErrorKind`.

**Lifecycle & edge cases:**

- `start` is a no-op if a recorder already exists. On `getUserMedia`/`MediaRecorder`
  failure it cleans up and reports `state: 'error'` with a kind — `'denied'` for
  `NotAllowedError`/`SecurityError` `DOMException`s (user must change iOS Settings),
  `'failed'` otherwise (worth retrying).
- A 250ms interval reports `elapsedSec` and auto-stops at `maxSec`, delivering the clip
  to `onAutoStop`. Because the timer, a user tap, and an out-of-band stop can all race
  to settle the recording, `finalize()` claims the recorder by nulling its internal ref
  first, making every other path a no-op (they resolve `null`/do nothing).
- **Out-of-band stop handling (#49):** `start()` also attaches `recorder.onstop`,
  `recorder.onerror`, and an `ended` listener on every stream track to one shared
  handler, so a stop the platform initiates itself — mic permission revoked, iOS taking
  the audio session (call, Siri), a device disconnect, or a genuine
  `MediaRecorderErrorEvent` — is observed even though no explicit `stop()` is waiting on
  it. The handler is guarded by recorder identity (a no-op once `finalize()` has already
  claimed the recorder), assembles whatever chunks were captured via `buildResult` and
  delivers them through `onAutoStop` exactly like a clean auto-stop (an interrupted clip
  is still the user's words), and only reports `state: 'error'`/`errorKind: 'failed'`
  when nothing was captured. Either way `cleanup()` runs, so the elapsed-timer interval
  is always cleared and the UI can never wedge on `'recording'` forever.
- `finalize()`'s already-`inactive` branch also settles (assembles the result, cleans
  up, reports `idle`) instead of silently no-oping, so a lost identity race can never
  leave stale refs/timers behind either.
- `cancel` detaches `onstop`/`onerror`, stops the recorder, and drops the chunks (A2 —
  discard).
- The level meter is best-effort: an `AudioContext` + `AnalyserNode` (fftSize 512) is
  set up in a nested try/catch; if unavailable, `getLevel()` returns 0 and recording
  continues. `getLevel()` computes RMS over byte time-domain data.
- `cleanup` stops all `MediaStream` tracks (releases the mic), clears the timer, and
  closes the `AudioContext`.

### src/capture/useRecorder.ts

**Purpose:** Thin React bridge over `recorderEngine.ts` — owns only `state`,
`elapsedSec`, and `errorKind` as React state, wired to one `createRecorderEngine`
instance held in a ref for the component's lifetime.

**Exports:**

- `useRecorder(): Recorder`
- `interface Recorder { state: 'idle' | 'recording' | 'error'; elapsedSec: number;
  start(maxSec = 60, onAutoStop?): Promise<void>; stop(): Promise<RecordingResult |
  null>; cancel(): void; resetError(): void; getLevel(): number; errorKind?: 'denied' |
  'failed' }`
- Re-exports `RecordingResult`, `RecorderState`, `RecorderErrorKind` from
  `recorderEngine.ts`.

**Lifecycle & edge cases:** see `recorderEngine.ts` above for `start`/`stop`/`cancel`/
out-of-band-stop behavior — this hook adds nothing but state plumbing. The engine is
created once (guarded by the ref already being set) and destroyed on unmount.

### src/capture/useAudioPlayback.ts

**Purpose:** Playback hook for one audio attachment stored in IndexedDB.

**Export:** `useAudioPlayback(file: string | undefined): AudioPlayback` where
`AudioPlayback = { playing: boolean; progress: number; toggle(): Promise<void> }`
(`progress` is 0..1 through the clip).

**Behavior & edge cases:** `toggle` stops if already playing; otherwise it loads the
blob via `getBlob(file)`, creates an object URL and an `Audio` element, plays, and
drives `progress` on a rAF loop (guarding against non-finite `duration`, which iOS can
report for fresh recordings). A `loadingRef` guards the `getBlob` await so a rapid
second tap can't start a second clip. `stop` (also bound to `onended`/`onerror`, play
rejection, and unmount) cancels the rAF loop, pauses, revokes the object URL, and resets
state. Playback always starts from the beginning — there is no pause/resume.

### src/capture/usePendingDelete.ts

**Purpose:** Undoable delete (B9). Delete hides the entry at once; the `revoke` event is
appended only when the 5s undo window closes (or the component unmounts), so undo needs
no un-revoke mechanism in the contract.

**Export:** `usePendingDelete(revoke: (ids: string[]) => Promise<void>): { pendingId:
string | null; request(id: string): void; undo(): void; toastOpen: boolean }`.

**Behavior & edge cases:** `request(id)` first commits any previous pending delete (only
one pending delete at a time), then records the new id, shows the toast, and arms a 5s
timer that hides the toast and commits. `undo()` clears the timer and pending id without
revoking. An unmount effect commits any still-pending delete so navigating away can't
resurrect a "deleted" entry. Screens filter `pendingId` out of their entry lists to
create the immediate-hide effect.

### src/capture/geo.ts

**Purpose:** Location snapshot at capture time (SPEC §7): concurrent, best-effort, never
throws.

**Exports:** `snapshotLocation(places: Place[], locationEnabled: boolean):
Promise<GeoLocation | undefined>`; `DEFAULT_PLACE_RADIUS_M` (50); `needsPlacePrompt(
location: GeoLocation | undefined, locationEnabled: boolean): boolean` — true when a
captured coordinate matched no saved place and should trigger `NamePlaceSheet`.
(String-backed radius drafts are validated by the numeric-draft helpers in
`src/ui/numberDraft.ts`.)

**Behavior:** resolves `undefined` immediately when location is disabled in settings or
`navigator.geolocation` is missing. Otherwise wraps
`geolocation.getCurrentPosition` with `{ timeout: 8000, maximumAge: 60_000,
enableHighAccuracy: false }`; on success returns `{ lat, lng, accuracyM:
Math.round(accuracy) }` plus `placeLabel` when `matchPlace(places, lat, lng)` (from
`src/places/match`) finds a saved place containing the point. Errors — both the error
callback and synchronous throws — resolve `undefined`; the promise never rejects, so
callers can `await` it unconditionally.

### src/capture/geo.test.ts

Vitest unit tests for `snapshotLocation`: verifies it resolves `undefined` without
touching geolocation when disabled, when `navigator.geolocation` is absent, on
geolocation errors, and on synchronous throws; and that successes round `accuracyM` and
include `placeLabel` only when the coordinate falls inside a saved place's radius. Also
covers `needsPlacePrompt` (prompts only for enabled, unlabelled locations).

### src/dayview/DayScreen.tsx

**Purpose:** Screen 2 — per-day timeline of local entries. Default export `DayScreen()`
(no props); reads the route param from `useParams<{ date?: string }>()`.

**Key behaviors:**

- **Date resolution:** uses `params.date` only if it matches `^\d{4}-\d{2}-\d{2}$`,
  otherwise falls back to today (`localDateOf(toLocalIso(new Date()))`). Invalid or
  missing dates therefore render Today rather than erroring.
- **Header:** title via `dayTitle` — "Today", "Yesterday", or a short locale date.
  Trailing controls navigate to `/day/<date±1>` via `shiftDate` (which anchors at
  `T12:00:00` to dodge DST edge cases); "Next day" is disabled when `date >= today`
  (no future days), and a "Today" shortcut appears when viewing a past day.
- **Entries:** filters to `!revoked`, not the pending delete, and
  `localDateOf(capturedAt) === date`; sorted **oldest-first** (chronological), unlike the
  capture screen's newest-first ordering. All card edits (date/time via the Edit sheet,
  notes, photos, audio, location, attachment removal) work identically here (the
  timeline renders entry runs through the shared `EntryList`). Moving an entry's date
  via the Edit sheet makes it leave the current day's list and appear on the target day.
- **Delete:** wires `usePendingDelete(revoke)` — `DayTimeline.onDeleteEntry` is
  `del.request`, with the same 5s Undo toast as the capture screen.
- **Timeline:** everything below the header is `<DayTimeline date entries
  onDeleteEntry emptyTitle>` — the merged local + calendar timeline (below). The
  screen passes only the day's filtered real entries; the calendar fetch, overlays,
  and empty state live inside the timeline.
- **Day-as-reward-loop artifact (#82):** between `ScreenHeader` and `DayTimeline`,
  `<DaySynthesisCard synthesis assistantEnabled>` renders the deterministic stat
  line plus, when `appSettings.assistantEnabled` is true, the opt-in daily prose
  affordance. `useDaySynthesis(date, dayEntries, title, appSettings.assistantEnabled,
  appSettings.assistantModel)` supplies both; see below.

### src/dayview/synthesis.ts

**Purpose:** Pure deterministic day synthesis (#82) — the always-on stat line, no
I/O, tested directly (`synthesis.test.ts`, no jsdom).

**Exports:**

- `interface DaySynthesis { moments: number; places: number; statLine: string }`.
- `daySynthesis(entries: readonly Entry[]): DaySynthesis` — `moments` is
  `entries.length`; `places` is the count of distinct `location.placeLabel`s
  (entries without a label, or with only a bare coordinate, don't count);
  `statLine` is `"N moments · M places"` with the places segment omitted when
  zero, and the empty string for an empty day (`DaySynthesisCard` renders nothing
  in that case). Singular/plural nouns per count.
- `interface EntryTextSignal { id: string; textLength: number }` and
  `synthesisInputHash(entries, texts: readonly EntryTextSignal[]): string` — an
  FNV-1a hash over each entry's id + folded text length (entries missing a
  `texts` row count as length 0), sorted by id before hashing so it is stable
  under reordering. Used as the derived-prose cache key (`synthesisCache.ts`):
  it changes when an entry is added, removed/revoked, or amended in a way that
  changes its folded text — never on envelope metadata (location, seq) alone.

### src/dayview/prosePrompt.ts

**Purpose:** Pure prompt assembly for the opt-in daily prose — no I/O, no SDK,
tested directly (`prosePrompt.test.ts`).

**Export:** `buildDaySummaryPrompt(dateLabel: string, digestText: string):
{ system: string; user: string }` — the two chat messages sent to the LLM.
Byte-stable for a fixed `(dateLabel, digestText)` pair (cache-key sanity: the
same digest always produces the same request). Takes only rendered digest text
(the same `formatDigest` output the assistant tools already send — transcripts,
notes, place labels, media counts) and never touches blob/binary fields.

### src/dayview/dayDigest.ts

**Purpose:** Builds the digest text the daily prose is generated from. Not pure
(reads text-attachment blobs via `getBlob`); untested directly (I/O), kept
deliberately tiny.

**Export:** `buildDayDigest(entries): Promise<{ items: DigestItem[]; text: string
}>` — `items` mirrors `entries` positionally (so callers can zip it with
`entries` for `synthesisInputHash`'s per-entry text lengths without a second
pass); `text` is `formatDigest` on the chronologically sorted items. Re-implements
`assistant/tools.ts`'s `toDigestItem` locally rather than importing it:
`tools.ts` imports the `ai` package (for `tool`/`jsonSchema`), and importing it
from `dayview/` would pull the AI SDK chunk into the Day screen's bundle — the
whole point of #82 requirement 7. `formatDigest`/`DigestItem` themselves live in
`assistant/context.ts`, which has no SDK dependency, so importing those is safe
and keeps the digest format identical to what the chat assistant sends.

### src/dayview/daySummaryClient.ts

**Purpose:** The opt-in prose's network call (#82) — a single direct `fetch` to
the OpenAI-compatible chat-completions endpoint, deliberately **not**
`assistant/transport.ts`'s `DirectChatTransport`/`ToolLoopAgent` (that pulls in
`ai` + `@ai-sdk/openai-compatible`, the same chunk `dayDigest.ts` avoids above;
it is already `ChatScreen`'s own lazy chunk, excluded from the SW precache in
`vite.config.ts`). No streaming, no tools, no history — one request, one
completion.

**Export:** `fetchDaySummary(prompt: DaySummaryPrompt, model: string):
Promise<string | undefined>` — posts to `` `${ASSISTANT_BASE_URL}/chat/completions` ``
(imported from `assistant/config.ts`, which has no SDK dependency either) with
`stream: false`; returns the trimmed completion text, or `undefined` on any
failure (offline, non-2xx, malformed body, empty completion) — never throws, so
a failed generation never blocks or replaces the deterministic stat line
already on screen.

### src/dayview/synthesisCache.ts

**Purpose:** The derived-data cache the daily prose lives in (#82 decision,
recorded in the issue: derived, rebuildable data must not enter the append-only
event log — SPEC §3.2 #5). Backed by the existing IndexedDB `meta` key-value
store (`store/db.ts`), one row per day.

**Exports:** `interface DaySynthesisCacheEntry { date; inputHash; prose;
generatedAt }`; `readDaySynthesisCache(date)` / `writeDaySynthesisCache(entry)` —
best-effort, never throw (same convention as `places/geocode.ts`'s cache).
Keyed `` `daySynthesis:<date>` ``. The deterministic stat line itself is not
cached — `daySynthesis` is cheap enough to recompute every render.

### src/dayview/useDaySynthesis.ts

**Purpose:** Wires the always-on stat line to the explicit-tap-only prose.

**Export:** `useDaySynthesis(date, entries, dateLabel, assistantEnabled, model):
UseDaySynthesisResult` — `{ stat: DaySynthesis; prose?: string; proseState:
'idle' | 'loading' | 'ready' | 'error'; canGenerate: boolean; generate: () =>
void }`.

**Key behaviors:**

- `stat` is computed synchronously from `entries` every render (`daySynthesis`)
  — no gate, no opt-in check, zero network.
- On mount and whenever the day's actual content changes (a stable
  `id:lastEventSeq` join, not `entries`' array identity, which DayScreen
  recreates every render), an effect reads the entry's digest, computes
  `synthesisInputHash`, and checks `synthesisCache.ts` for a matching row —
  **cache lookup only, never a network call.** A miss or stale hash (day's
  entries changed since the cached prose was generated) leaves `prose`
  undefined and `proseState: 'idle'`.
- `generate()` is the **only** path that calls the network
  (`daySummaryClient.fetchDaySummary`); nothing in this hook or `DayScreen`
  calls it automatically. On success it writes the new `{inputHash, prose}` row
  to the cache and sets `proseState: 'ready'`; on failure (including no
  completion text) it sets `proseState: 'error'` without touching `stat`.
- `canGenerate` additionally requires `assistantEnabled` — the hook enforces the
  AI opt-in gate itself as a second line of defense, even though `DaySynthesisCard`
  already hides the affordance entirely when the setting is off.

### src/dayview/DaySynthesisCard.tsx

**Purpose:** Presentational half of the artifact — renders `useDaySynthesis`'s
output between `ScreenHeader` and `DayTimeline`.

**Export:** `DaySynthesisCard({ synthesis, assistantEnabled })`.

**Behavior:** renders nothing (`null`) when `stat.statLine` is empty (an empty
day). Otherwise a `Card` with the stat line always shown; the "Generate
summary"/"Regenerate summary" button and any cached/fresh prose render only
when `assistantEnabled` is true — the affordance and the prose are both
invisible when the opt-in is off, not just disabled. Prose renders in the quiet
derived-content treatment (`type_.derived`/`tone.textDerived`, #80's authored-vs-
generated pairing for machine inference) and is plain read-only text with
no edit affordance; regenerating replaces it wholesale via a new tap. A failed
generation shows a quiet caption-level note without hiding the stat line.

### src/dayview/DayTimeline.tsx

**Purpose:** The merged Day timeline (SPEC §4.2, §3.6): one time-sorted interleave of
real entry cards and calendar pseudo-entry cards, replacing the old stacked
calendar-block + entry-list layout.

**Export:** `DayTimeline({ date, entries, onDeleteEntry, emptyTitle }:
DayTimelineProps)`.

**Key behaviors:**

- **Data:** owns `useDayEvents(date)` (the calendar fetch) and `useOverlays` (the
  folded overlay states; loaded once via the store's `loaded` flag).
  `buildPseudoEntries(calendarId, events, overlays, date)` runs **only when the fetch
  state is `'ready'`** — orphan detection against a loading/error/disconnected fetch
  would misclassify every overlay as orphaned (the core's contract). Non-ready states
  render the quiet one-line notes (connect/pick/reconnect/couldn't-load) and the
  timeline carries real entries alone.
- **Interleave:** `groupTimeline(buildTimeline(entries, pseudo))` — runs of
  consecutive real entries render through the shared `EntryList` (reusing its
  card→amend wiring unchanged); each pseudo-entry renders a `PseudoEntryCard`.
- **Edit:** tapping a pseudo-entry (or its Edit button) opens
  `EditPseudoEntrySheet`; the sheet's `onSave(patch)` goes through
  `useOverlays.saveOverlayPatch(entry, liveEvent, patch)` — one overlay event per
  save, copy-on-write (create with a frozen `baseSnapshot` of the live event when the
  entry is unmaterialized, amend otherwise). The sheet tracks the entry by id and
  re-derives it from the current merge each render.
- **Hide:** one tap appends `toggleHidden(entry)` via `saveOverlayPatch`, then shows
  an "Event hidden" toast whose Undo appends the exact inverse — a **revoke** when
  the hide itself materialized the overlay (back to zero stored state), else
  `hidden: false`. The toast auto-clears after 5s.
- **Remove (orphans):** `revokeOverlay(overlayId)` discards the overlay; the entry
  disappears (there is no live event to revert to).
- **Empty state:** when the merged timeline has no items at all, renders
  `EmptyState` with the screen-provided `emptyTitle`; a ready fetch with zero events
  and zero pseudo-entries also notes "No events on `<calendar>` this day."

### src/dayview/PseudoEntryCard.tsx

**Purpose:** One calendar pseudo-entry's card — the merged view of a live calendar
event plus its optional overlay (`mergePseudoEntry` output; the user's edits already
win per field). Deliberately calendar-flavored, **not** an `EntryCard`: no
attachments, location, or playback — those belong to captures.

**Exports:** `PseudoEntryCard({ entry, onEdit, onHide, onRemove })` and
`pseudoTimeLabel(entry)` ("9:00 AM – 10:30 AM", or "All day").

**Key behaviors:**

- The card content is a full-width button (calendar glyph, time range, title, note)
  that opens the edit sheet via `onEdit`; the action row has ghost Hide
  (`EyeOffIcon`) and Edit (`SlidersIcon`) buttons. Time range is metadata (`type_.caption`,
  sans, tabular-nums); title and note are content the user typed and both render serif
  (`type_.body` / `type_.bodySmall`, #85) — the note used to be sans (`type_.sub`), which
  misclassified a free-text annotation as chrome.
- **Badges (informational, never blocking):** "May be outdated" (danger wash) only
  when `dirty === 'conflict'` — the base moved under an edited field; auto-merged
  and clean states show no badge. "Deleted upstream" (muted, bordered) when
  `orphaned` — the event vanished from a successful fetch; orphans additionally get
  a dangerGhost **Remove** button wired to `onRemove` (revoke). The two are mutually
  exclusive (an orphan has no live base to conflict with).

### src/dayview/EditPseudoEntrySheet.tsx

**Purpose:** Edit sheet for one pseudo-entry — a separate component from capture's
`EditEntrySheet` (the field sets diverge: title/note/start/end here;
date/time/attachments there) but the same pattern: hold a draft, diff on Save, emit
ONE event.

**Export:** `EditPseudoEntrySheet({ entry, onSave, onClose })` where
`onSave(patch: OverlayPatch)` receives the minimal patch (never called for a no-op).

**Behavior:** freezes `draftFromPseudoEntry(entry)` as the original at open; fields
are Title (`TextInput`), Note (`TextArea`), Starts/Ends (`datetime-local` inputs).
Save is disabled while `overlayPatchFromDraft(original, draft)` is `undefined` — the
copy-on-write no-op guard: closing an unedited sheet never writes, so an untouched
calendar event never materializes an overlay. Emptied title/note become
`clearTitle`/`clearNote` (revert to the live event / drop the note) in the core.
Input values only enter the draft `onChange`, so untouched times never spuriously
diff (the original ISO carries seconds the input can't render). A footer caption
notes edits are app-local and links "Open in Google Calendar" (`htmlLink`) when the
live event provides one.

### src/dayview/timeline.ts

**Purpose:** Pure view-model for the merged timeline — no I/O, no React; tested
directly in `timeline.test.ts`.

**Exports:**

- `TimelineItem` — `{ kind: 'entry'; startMs; entry }` |
  `{ kind: 'pseudo'; startMs; pseudo }`.
- `buildTimeline(entries, pseudoEntries): TimelineItem[]` — ascending by effective
  start (real = `capturedAt`, pseudo = merged `startMs`, so a patched time re-files
  the block); ties break pseudo-first (a calendar block frames the entries captured
  at its start), then by id.
- `TimelineGroup` / `groupTimeline(items)` — collapses runs of consecutive real
  entries (one `EntryList` per run) between individual pseudo-entries.
- `baseSnapshotOf(ev: CalEvent): OverlayBaseSnapshot` — the frozen copy-on-write
  base for materialization (summary/startMs/endMs/allDay, `updated` omitted when the
  fetch lacks it).

### src/dayview/useOverlays.ts

**Purpose:** UI-facing zustand store for the overlay log, mirroring `useAppStore`'s
refresh-after-write pattern in miniature. Lives in `dayview/` because the log is
calendar-domain state and the generic `store/` layer must never import `gcal/`
(SPEC §10).

**Export:** `useOverlays` with state `{ overlays: OverlayState[]; loaded }` and
actions:

- `refresh()` — re-fold via `listOverlayStates()` (the read path after any append).
- `saveOverlayPatch(entry, liveEvent, patch): Promise<SavedOverlay>` — exactly one
  overlay event: `appendOverlayAmend` when the entry is materialized, else
  `appendOverlayCreate` with `baseSnapshotOf(liveEvent)` (a missing live event for an
  unmaterialized entry is a programming error and throws). Returns
  `{ overlayId, created }` so hide can offer an exact undo.
- `amendOverlay(overlayId, patch)` — direct amend (e.g. `hidden: false` from the
  undo toast, when the hidden entry is no longer rendered).
- `revokeOverlay(overlayId)` — discard (orphan Remove, hide-undo of a fresh COW).

Failures route through `useAppStore.lastError` (the app-level toast channel) and
re-throw, matching the appStore `guard` convention.

## Key invariants & gotchas

- **Append-only contract:** nothing in the UI mutates entries in place. Every edit is an
  `amend` event, deletes are `revoke` events, and "removal" of attachments/locations is
  a fold-time hide (`removeAttachments`, `clearLocation`) — the underlying files and
  history stay in the log and in Drive.
- **`clearLocation` vs. absent `location`:** an amend patch with no `location` means "no
  change"; clearing requires the explicit `clearLocation: true` flag
  (`EntryList.onSetLocation`).
- **`derivedFrom` must be preserved on edit:** edited transcripts/captions keep their
  `derivedFrom` link so the transcription/captioning runners never re-derive over a
  user's edit. `onEditText` performs remove-old + add-new in a *single* amend. This is
  also why an edited transcript/caption never changes visual class (#80): `authorship()`
  depends only on `derivedFrom`.
- **`derivedFrom` alone drives authored-vs-generated (#80):** `authorship()`
  (`authorship.ts`) is the single place that interprets it for rendering — absent means
  authored (heaviest/darkest), present-and-a-caption means derived (quiet
  `type_.derived`/`tone.textDerived`), present-and-not-a-caption means spoken (same
  heaviest/darkest weight as authored, plus a quiet `SpokenMark` glyph). Never add a
  heuristic on text content to this decision, and never introduce new stored state for
  it — every renderer (`AttachmentBody`, `EntryCard`'s collapsed preview and related-rows
  snippet, `DaySynthesisCard`'s prose) composes the same two tokens.
- **`capturedAt` semantics:** for voice entries it is the record-tap time, not the stop
  time; text/photo entries use submit time. Inline time edits change only the
  time-of-day, re-rendered in the device zone (`withTimeOfDayIso`); the Edit sheet
  edits date and time in the **entry's own zone** (`civilTimeOf` draft, `zonedIso`
  recomposition with `entry.deviceTz`), and both land in `patch.capturedAt`.
- **Recorder races are resolved by claiming:** `finalize()` nulls `recorderRef` before
  stopping, so a user tap racing the auto-stop timer (or the background-commit handler)
  yields exactly one committed clip. The same claim guards the out-of-band stop path
  (#49, `recorderEngine.ts`): a track `ended`/recorder `error`/spontaneous `stop` the
  platform fires on its own (mic revoked, iOS taking the audio session, a device
  disconnect) is a no-op once an explicit `stop()` has already claimed the recorder, and
  vice versa — exactly one of the two ever settles a given recording, and the losing
  side never leaves the UI reporting `'recording'` forever. The gesture accelerator
  (#77) rides the same invariant rather than re-solving it: every hold-class command in
  `RecordPanel` is gated on `recorder.state === 'recording'` at the moment of pointerup,
  so a release racing auto-stop/background-commit (which already flipped the recorder
  out of
  `'recording'`) is a no-op, never a second commit.
- **The gesture accelerator is additive, never load-bearing (#77):** `holdGesture.ts`'s
  commands only ever call the same handlers a plain button already calls (`onTap`,
  `onDiscard`, and an `onCommitThen` that resolves to the exact `EntryList.onAddPhoto`/
  `onAddNote` amend shape). Every outcome it can reach stays fully reachable without it —
  removing the gesture wiring entirely would leave tap-to-record, Discard, and the entry
  card's "+ photo"/"+ note" fully intact.
- **Never hardcode the audio container:** iOS Safari records `audio/mp4`; the mime type
  is negotiated per device in `useRecorder`.
- **Geolocation is fire-and-forget:** `snapshotLocation` never rejects and resolves
  `undefined` on any failure; recording/capture never waits on or fails because of
  location. The recording path starts the snapshot concurrently and awaits it only at
  commit.
- **Pending delete is screen-local:** `usePendingDelete` hides via `pendingId` filtering
  and appends the revoke on timeout *or unmount*; only one delete can be pending, and
  requesting a new one commits the previous immediately.
- **First audio attachment is special:** it plays from the card header and supplies the
  header duration; `AttachmentBody` renders only clips 2..n.
- **Card expansion is view state, never contract state (#78):** `EntryCard`'s `expanded`
  flag is local `useState`, never written to the event log and never read back from it —
  the append-only log carries user data, not UI state. Every card starts collapsed.
- **"Queued" must never reach the card (#79):** `lifecycle.ts` is the only place that
  decides entry-card copy from sync/enrichment state; a recorded sync failure (`status
  === 'error'`, or `error` set on a not-yet-uploaded row — see `entryLifecycle`) always
  maps to `'failed'` regardless of pending enrichment — real failures must never read
  quieter, including a still-`queued` row that already failed once and is only pending
  an automatic retry. Don't reintroduce a raw `SyncStatus` render in
  `EntryCard`/`EntryList`; route through `entryLifecycle`/`lifecycleLabel` instead. The
  Settings `SyncStatusLine` aggregate and the app-icon badge (`badgeCount` in
  `App.tsx`) are separate surfaces, unaffected by this mapping — they still report the
  real pending/failed counts.
- **The six-icon action row only exists expanded:** the collapsed card renders no
  add/edit/delete affordances at all, only the pure-view-model-driven overflow button;
  all edit flows (note/photo/audio/location/edit/delete) are reachable exactly as
  before, just one tap further behind expansion.
- **Leaflet is always lazy:** `MiniMap` and `LocationSheet` load as separate chunks;
  `MiniMap` must re-center imperatively (`Recenter`) because `MapContainer` ignores
  `center` prop changes after mount.
- **No map tiles in the feed (#81):** the collapsed and expanded card both represent a
  location via the leaflet-free `PlaceCard` row (`placeCardModel.ts` for the pure
  title/subtitle derivation); `MiniMap` renders only the full-screen interactive dialog,
  mounted only while `EntryCard`'s `mapOpen` is true. Don't reintroduce a compact/preview
  map mode — that chunk-loading cost is exactly what this issue removed.
- **Manually placed pins have `accuracyM: 0`** (or the prior value when editing), and
  `LocationSheet` recomputes `placeLabel`/`address` for the new coordinate on save.
- **Blob-backed rendering is async:** note text, photos, and audio all load from
  IndexedDB (`getBlob`) after mount; components render nothing until loaded and must
  revoke object URLs and guard stale async sets on unmount.
- **Pseudo-entries are copy-on-write (SPEC §3.6):** an unedited calendar event
  renders with **zero stored state** — the overlay log gains an event only when an
  edit sheet Save has a real diff or the user hides. `overlayPatchFromDraft`'s
  `undefined` return is the guard; never bypass it.
- **`buildPseudoEntries` only on `'ready'`:** a loading/error/disconnected fetch
  must render real entries alone — passing its (empty) event list would flag every
  overlay as a false orphan. `DayTimeline` is the single place this gate lives.
- **Don't edit `EntryCard` for calendar needs:** pseudo-entries have their own card;
  real entries flow through `EntryList` unchanged so capture-card behavior stays
  identical on both screens.
- **Day synthesis prose never leaves the event log path unaffected (#82):** the
  cached prose (`synthesisCache.ts`, IndexedDB `meta` key `daySynthesis:<date>`)
  is derived, rebuildable data, never a capture/amend/revoke event, never synced,
  and never read by `fold`. Losing it (wipe, cache miss) only means the next
  explicit "Generate summary" tap regenerates it; it never blocks or corrupts the
  entries it summarizes.
- **The daily prose only ever fires on an explicit tap:** `useDaySynthesis`'s
  mount/content-change effect *only* reads the cache — it never calls
  `fetchDaySummary`. Any change that makes the prose regenerate on screen open
  (rather than on `generate()`) violates the #82/#89 product decision and must
  be reverted.
- **The AI opt-in gates the daily prose affordance, not just the call:**
  `DaySynthesisCard` renders no "Generate summary" button, no prose, and no
  error note at all when `appSettings.assistantEnabled` is false — `useDaySynthesis`
  additionally refuses to generate in that state as a second guard. Only the
  deterministic stat line is visible with the opt-in off.
- **Never import `assistant/transport.ts` (or `assistant/tools.ts`) from
  `dayview/`:** both pull in the `ai`/`@ai-sdk/openai-compatible` packages
  (ChatScreen's own lazy chunk). The daily prose instead uses a direct `fetch`
  (`daySummaryClient.ts`) and a local digest builder (`dayDigest.ts`) that only
  import the SDK-free `assistant/config.ts`/`assistant/context.ts`, keeping the
  Day screen in the main bundle.
- **Relatedness is local-only and computed on demand, never proactive (#83):**
  `related.ts` uses only `placeLabel` exact match, tokenized-text overlap, and a
  day-gap recency factor — no embeddings, no LLM calls, no network. It runs only
  when `EntryCard` is expanded (`useRelated`'s `enabled` gate), never for a whole
  feed. There is no push/notification surface for it (`docs/modules/notify.md`
  has no backend for "right moment" resurfacing); v1 is card-only.
- **The related-rows threshold is a hard gate, not a UI nicety:** `relatedEntries`
  filters by `RELATED_MIN_SCORE` internally, so `useRelated` returning `[]` means
  "nothing genuinely relates" and `EntryCard` renders no section at all — false
  connections are worse than none (#83).
- **Recency damping compares two entries to each other, not to wall-clock now:**
  `related.ts` takes no `now` argument; the "age" it damps by is
  `|target.capturedAt − candidate.capturedAt|`, so the module stays pure without
  needing one. Only the UI-facing `relativeDayLabel` needs "today", and callers
  supply it (`localDateOf(toLocalIso(new Date()))`) rather than the function
  computing it internally.
