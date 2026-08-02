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

Entries render as nodes on a **timeline rail** (the shared `TimelineRow` primitive from
`src/ui`): a fixed-width left gutter carries a vertical connecting line, a dot marking
the node, and the captured time; the entry's content sits in the right column,
horizontally aligned to the dot. Consecutive nodes render with no list gap so the rail
reads as one continuous line, and each card is a flush node (no heavy per-card border or
shadow) rather than a boxed card.

`EntryCard` renders its content **unconditionally** (#102, inverting #78's collapse):
the entry's full primary text (no line clamp) or its primary clip's waveform
fingerprint, then an attachment sub-timeline ordered by each attachment's append
timestamp. Audio waveforms and their transcripts share a row, photos and their
captions share a row, and notes/orphaned descriptions occupy their own rows. The
compact place card follows — the card's single location surface — then an
always-visible compact action row (add note / add photo / add audio / location /
edit / copy / delete — each icon carries an `aria-label`). Nothing attachment-shaped
is ever hidden and no chrome collapses; sheet-open state is view-local `useState`,
never persisted, never an event.

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
add-on (always an amend — see below), either an `EmptyState` or an `EntryList` holding
**only today's most recent entry** (SPEC §4.1's latest-entry card — the full day lives
on the Day screen, which is what keeps the two views distinct; the list gets
`newestFirst` so the card's attachment sub-timeline also reads newest-first, matching
the screen's direction), an optional `TextSheet`
(plain text capture, and a second instance for the accelerator's note add-on), and one
of three toasts (captured-with-Undo, deleted-with-Undo, discarded).

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
- **Today filter:** `todayEntries` holds entries where `!revoked`,
  `id !== del.pendingId` (hides the pending delete), and `localDateOf(capturedAt)`
  equals today; sorted newest-first. The header/prompt/day-summary derivations use the
  whole array, but the list renders only `todayEntries.slice(0, 1)` — the latest-entry
  card. Deleting it reveals the next-most-recent entry.
- **Install nudge (C14):** before the first-ever entry, non-standalone visitors see an
  "Add to Home Screen" hint in the empty state (checks `display-mode: standalone` media
  query and iOS `navigator.standalone`).
- **Automatic place naming (§3.4):** after every successful capture,
  `maybePromptPlace(event)` checks `needsPlacePrompt(location, locationEnabled)` (from
  `geo.ts`) — a location captured at a coordinate matching no saved place (no
  `placeLabel`) opens `NamePlaceSheet`. Since a capture-time snapshot never carries
  `address` (geocoding is lazy), `maybePromptPlace` also kicks off
  `reverseGeocode(location.lat, location.lng)` in the background and feeds the result
  into `pendingPlaceAddress` state as it resolves, so the sheet's "near …" hint can
  actually appear (#59 — it used to read a field that was always empty at this point in
  the flow, so it was dead code). A `pendingPlaceEntryIdRef` guards against a slow
  lookup painting a stale address onto a newer prompt if the user dismisses one and
  triggers another before it resolves. Saving calls `addPlace` (reusing
  `pendingPlaceAddress` before falling back to a fresh `reverseGeocode`, which is cached
  either way) and retro-labels the just-captured entry via
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
the component renders `null`, leaving the surrounding waveform playback target available
this feature; it never throws or blocks the card.

**Placement (req. 4/5):** `AttachmentTimeline.tsx` mounts one waveform row for every
audio attachment, ordered by attachment timestamp. The waveform is the playback target
and any transcript derived from that audio sits in the row's right column; no audio
attachment is promoted into the entry header.

### src/capture/EntryList.tsx

Entry cards expose an optional `onCopy(entry)` callback. Capture and Day use it
to copy a labeled plain-text representation from `src/context/plainText.ts`;
the card action is icon-only but has the accessible label "Copy entry".

**Purpose:** Maps `Entry[]` to `EntryCard`s and translates every card edit into a store
`amend` call — the single place where card callbacks become contract events.

**Export:** `EntryList({ entries, onDelete, firstOnRail, lastOnRail, newestFirst }:
EntryListProps)` where `onDelete: (entryId: string) => void` bubbles delete requests
up to the owning screen (B9), which hides the entry immediately and appends the revoke
only after the undo window. `firstOnRail`/`lastOnRail` (both default `true`) let a
parent that interleaves other rail nodes — `DayTimeline` weaving in
`PseudoEntryCard`s — trim the connecting line only at the true ends of the merged
rail, so a run of entries between calendar events keeps an unbroken line above and
below it. `newestFirst` (default `false`) flips each card's attachment sub-timeline to
newest-first; the Capture screen sets it because its list runs newest-first, while the
Day view stays oldest-first. `EntryList` renders as a fragment (no wrapper element) so
consecutive `TimelineRow` gutters abut and the rail reads continuously.

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
  no `derivedFrom`. `'spoken'`: text derived from audio (a transcript); it now shares
  the derived visual treatment (transcribed text must be visibly distinct from written
  text) but keeps its own class so the `SpokenMark` glyph and "Edit transcript" title
  still apply. `'derived'`: machine inference over the entry's content — photo captions
  today, any future derived text.
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

### src/capture/EntryCard.tsx

**Purpose:** One entry's card (#78, inverted by #102: **everything is always
visible** — content and actions alike), rendered as a node on the timeline rail
(`TimelineRow`): the captured time + rail dot in the gutter, then the content column
with an optional lifecycle badge, an attachment sub-timeline ordered by each
attachment's append timestamp, the place card (the card's single location surface),
and the always-visible action row, plus the sheets/inputs those actions open.

**Exports:** `EntryCard(props: EntryCardProps)` and `timeLabel(iso: string): string`
(locale time like "9:04 AM"). Props: `entry`, `maxClipSec`, `sync?: SyncStatusRow`,
rail position `first?`/`last?`, `newestFirst?` (flips the attachment sub-timeline —
see `AttachmentTimeline`), optional `onCopy?(entry)`, and callbacks `onDelete`,
`onSetTime(time)`, `onAddNote(text)`, `onAddPhoto(file)`, `onAddAudio(result)`,
`onEditText(oldFile, text, derivedFrom?)`, `onRemoveAttachment(file)`,
`onSetLocation(location | null)`, `onApplyEdit(patch)` —
unchanged by #102's density pass, so `EntryList`'s amend wiring needed no changes.
The card computes its own `EntryLifecycle` from `sync` + `hasPendingEnrichment(entry)`
(`lifecycle.ts`, #79) and renders it via `LifecycleBadge`.

**Key behaviors:**

- **Content and actions are always visible (#102, extended):** there is no
  content-hiding "collapsed" state, no `expanded` toggle, and no action-menu reveal —
  the action row renders unconditionally at the card's foot. `AttachmentTimeline`
  owns visible attachment ordering and media/text pairing.
- **Rail gutter + header:** the editable time lives in the `TimelineRow` `time` slot
  (the `RailTime` subcomponent — the same tap-to-edit button, in the gutter above the
  rail dot; the gutter stays fixed-width so every row's dot sits on one straight
  rail). The header renders only when the lifecycle badge has something to say
  (`lifecycleLabel(lifecycle) !== null`) — a settled entry has no header row at all.
  Location appears **only** in the `PlaceCard` row (never a second header chip), so
  a card shows its place exactly once. The time button has no underline decoration;
  it is still the tap target for the native picker (below), and the Edit sheet
  provides the second, labelled path to the same field. The time is metadata, not
  content (#85): quiet `type_.caption` (sans, tabular-nums), never serif.
- **Rail position:** `first`/`last` props (threaded down from `EntryList`, defaulting
  false) trim the connecting line at the true ends of the rail so a run of entries reads
  as one continuous line, and the flush node drops the old heavy per-card border/shadow.
- **Time editing (B8):** the time label is a button layered over an invisible
  `<input type="time">`; tapping calls `showPicker()` (fallback `focus()`) so iOS shows
  its native wheel picker. `onChange` fires `onSetTime` only for non-empty values.
- **Attachment sub-timeline:** `AttachmentTimeline.tsx` stably sorts visible attachments
  by `entry.attachmentLoggedAt[file]`, falling back to `entry.loggedAt` for older or
  synthetic entries — oldest-first by default, reversed when the card's `newestFirst`
  prop is set (the Capture screen's newest-first direction). Each row shows its append
  time. Audio puts its clickable waveform
  on the left and all transcripts derived from that audio on the right; photos put their
  thumbnail on the left and their caption on the right. Notes and orphaned descriptions
  remain standalone rows, so no audio clip has special precedence.
- **Place card:** the `PlaceCard` row (when `entry.location` is set) remains leaflet-free,
  with no network or map tiles in the feed (#81); tapping it sets `mapOpen`, which mounts
  the lazy `MiniMap` full-screen dialog. Leaflet's chunk loads only on that explicit tap.
- **Per-card recorder:** "Add audio" (in the action row) uses its own `useRecorder()`
  instance so entries can hold multiple clips; while recording, the action row is
  replaced by a compact timer bar with Discard/Done (`RecordingBar`).
  If that recorder errors, the row's audio icon becomes a "mic unavailable, tap to
  retry" button that just calls `rec.resetError`.
- **Lazy Leaflet:** `MiniMap` and `LocationSheet` are `lazy()` imports wrapped in
  `Suspense fallback={null}`, keeping the Leaflet JS+CSS chunk out of the initial
  bundle; `MiniMap` additionally only mounts while `mapOpen` is true (#81), so opening
  it is the one thing that loads the chunk, not showing the place card or opening the
  location editor.
- Hidden photo input (camera capture) and a `TextSheet` for "Add note" mirror the
  capture-screen patterns.
- **The action row (replaces the "+" reveal menu):** the `EntryActions` subcomponent —
  one always-visible row at the card's foot, compact `sm` ghost `IconButton`s
  (36×36 px) so every action fits on one line at mobile widths: "Add note",
  "Add photo", "Add audio" (or the mic-unavailable fallback), "Add location"/"Edit
  location" (`PlusIcon`/`PinIcon`), "Edit entry" (`SlidersIcon` — opens
  `EditEntrySheet`), "Copy entry" (`CopyIcon`, only when `onCopy` is provided), and
  "Delete entry" (`TrashIcon`, `danger` variant) pushed to the right edge
  (`ml-auto`) so the destructive action stands apart. Every action still carries the
  same glyph as the main CTA/edit affordances via `captureIcon` (`src/ui`), and
  every `IconButton` requires its `aria-label` at the type level, so an unlabelled
  action icon can't compile.

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

### src/capture/AttachmentTimeline.tsx

**Purpose:** Owns the entry's attachment sub-timeline. It stably orders visible
attachments by their originating event timestamp (`Entry.attachmentLoggedAt`, with
the entry timestamp as a fallback; `sortAttachmentsByLoggedAt` in
`attachmentOrder.ts`), shows that timestamp on each row, and pairs audio waveforms
with their transcripts and photos with their captions. Notes and orphaned
descriptions remain standalone rows. Each media row keeps its existing playback,
caption editing, photo viewer, and removal behavior. The sub-timeline uses spacing
and timestamps only; it does not add a second vertical rail inside the entry. An
optional `newestFirst` prop (threaded from `EntryList` → `EntryCard`; the Capture
screen sets it) reverses the row order — including ties — so the sub-timeline reads
in the same direction as the newest-first list around it; the Day view keeps the
default oldest-first.

### src/capture/AttachmentBody.tsx

**Purpose:** Provides the shared text classification, streaming, styling, and edit
helpers used by `AttachmentTimeline` (the timeline owns the visible row layout).
The older grouped `AttachmentBody` renderer remains available for compatibility,
but `EntryCard` now uses `AttachmentTimeline` so media/text pieces are ordered and
paired by timestamp.

**Export:** `AttachmentBody({ attachments, onEditText }: AttachmentBodyProps)`; also
exports `useLiveText` (the shared `useSyncExternalStore` wiring for a `LiveTextStore`),
`StreamingText`, `AUTHORSHIP_STYLE`, and `EDIT_TITLE` — all reused by `PhotoGrid.tsx` so
in-grid captions compose the exact same tokens/edit flow rather than re-deriving them.

**Classification helpers:** delegates per-attachment classification to the pure
`authorship()` (`authorship.ts`). `AttachmentTimeline` uses its exported text and
streaming helpers so transcripts, notes, captions, and live enrichment keep the
same authored-vs-generated treatment.

**Type scale (#80, revised):** authored notes render at
`type_.bodyStrong`/`tone.textPrimary` — the heaviest, darkest treatment, **full text, no
line clamp** (#102: "content is always visible") — the user's own typed words. All
machine text — spoken transcripts and captions alike — renders in
`type_.derived`/`tone.textDerived` (serif, italic, 14 px, never bolder than authored
text), so transcribed text is visibly distinct from written text and matches the
photo-caption treatment; a transcript additionally gets the quiet `SpokenMark` glyph
(small muted mic icon, `aria-hidden`) inline before the text, which is now what tells
a transcript apart from a caption. The composition table (`AUTHORSHIP_STYLE`) and the
`TextSheet` edit-title table (`EDIT_TITLE`) are both keyed by `Authorship`, so every
call site (including `PhotoGrid`) agrees with the classifier.

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

**Purpose:** Legacy standalone photo-row implementation retained for the photo
viewer behavior and related tests. `EntryCard` now renders photos through
`AttachmentTimeline`, which keeps each photo/caption row in timestamp order with
the rest of the entry's attachments.

**Export:** `PhotoGrid({ photoGroups, onEditText, onRemoveAttachment }: PhotoGridProps)`.
Renders `null` for an entry with no photos.

**Behavior:** the container is a `flex flex-col gap-2` stack of rows; each row is a
`flex items-start gap-3` — a fixed `h-20 w-20 shrink-0` thumbnail button on the left and
a `min-w-0 flex-1` caption column top-aligned beside it. Tapping a thumbnail opens the
existing full-screen `PhotoViewer` (with its own "Remove photo" action, wired to
`onRemoveAttachment`); a persisted caption renders in the right column
(`AttachmentBody`'s exported `AUTHORSHIP_STYLE.derived`/`EDIT_TITLE.derived` tokens, full
text with no clamp now that it has the row's width to wrap into) and is tappable to edit
inline via the shared `TextSheet`, exactly like `AttachmentBody`'s `NoteText`; a
still-**streaming** caption (subscribed via the exported `useLiveText(liveCaptions)`,
keyed by the *photo's* file — the caption runner's source key) renders with
`AttachmentBody`'s exported `StreamingText` in place of a persisted caption, and is not
tappable (nothing to edit until the amend lands).

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
- **Bottom actions:** an optional "Save photo" link (`downloadName` prop — a plain
  `<a download>` of the already-loaded object URL under the attachment's contract
  filename, so saving needs no new blob read or network) sits beside the optional
  "Remove photo" button in a safe-area-aware bottom row; both call sites
  (`AttachmentTimeline.PhotoRow`, `PhotoGrid`) pass `photo.file`. `onPointerDown`
  skips gesture handling for taps landing on buttons *or links* so the anchor's
  native download click fires.
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
- "Use current location" calls `locateCurrent(places)` (`geo.ts`) with a "Locating…"
  busy state. Unlike the passive capture-time path, this **always** asks the browser
  for a location regardless of the Settings `locationEnabled` toggle — an explicit tap
  is deliberate intent, not ambient stamping (#59) — and on failure sets a small danger
  caption (`tone.danger`) distinguishing "Geolocation is not available on this device."
  (`reason: 'unsupported'`) from "Could not get your location." (`reason: 'failed'`,
  covering denial/timeout/error) instead of silently leaving `pos` unchanged.
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

**`src/capture/mapAttribution.test.ts` (#56):** a source-text guard (raw-text scan via
`import.meta.glob(?raw)`, the `layering.test.ts` technique — there is no jsdom/
testing-library in this repo) asserting no `MapContainer` in `src/capture/` disables
`attributionControl` and every `<TileLayer>` carries an `attribution` prop, so OSM's
tile-usage attribution requirement can't silently regress across `MiniMap.tsx` and
`LocationSheet.tsx`.

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
Promise<GeoLocation | undefined>`; `locateCurrent(places: Place[]):
Promise<LocateResult>` where `LocateResult = { ok: true; location: GeoLocation } | {
ok: false; reason: 'unsupported' | 'failed' }`; `DEFAULT_PLACE_RADIUS_M` (50);
`needsPlacePrompt(location: GeoLocation | undefined, locationEnabled: boolean):
boolean` — true when a captured coordinate matched no saved place and should trigger
`NamePlaceSheet`. (String-backed radius drafts are validated by the numeric-draft
helpers in `src/ui/numberDraft.ts`.)

**Behavior:** both `snapshotLocation` and `locateCurrent` share a `getCurrentLocation`
helper that wraps `geolocation.getCurrentPosition` with `{ timeout: 8000, maximumAge:
60_000, enableHighAccuracy: false }`; on success it returns `{ lat, lng, accuracyM:
Math.round(accuracy) }` plus `placeLabel` when `matchPlace(places, lat, lng)` (from
`src/places/match`) finds a saved place containing the point, and resolves `undefined`
on any failure (error callback, synchronous throw, or no `navigator.geolocation`) — the
promise never rejects.

- `snapshotLocation(places, locationEnabled)` — the **passive capture-time** path
  (§7): resolves `undefined` immediately, without touching geolocation at all, when
  `locationEnabled` is off. Silent by design — capture stamps a coordinate on every
  entry without asking, so a denial or timeout should just mean no location, not an
  error surfaced mid-recording.
- `locateCurrent(places)` — the **explicit-request** path (#59): no `locationEnabled`
  parameter at all — an explicit "use current location" tap always asks the browser,
  since the toggle governs ambient stamping, not a deliberate gesture (the browser's
  own permission prompt still gates the actual read either way, so this isn't a
  privacy regression). Distinguishes `reason: 'unsupported'` (no geolocation API) from
  `reason: 'failed'` (everything else) so the caller (`LocationSheet`) can show
  different, specific feedback instead of a silent no-op.

### src/capture/geo.test.ts

Vitest unit tests for `snapshotLocation`: verifies it resolves `undefined` without
touching geolocation when disabled, when `navigator.geolocation` is absent, on
geolocation errors, and on synchronous throws; and that successes round `accuracyM` and
include `placeLabel` only when the coordinate falls inside a saved place's radius. For
`locateCurrent`: it calls geolocation even when disabled (no toggle to check), and
returns `{ ok: false, reason: 'unsupported' }` vs `{ ok: false, reason: 'failed' }` for
a missing API vs an error/throw. Also covers `needsPlacePrompt` (prompts only for
enabled, unlabelled locations).

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
  card→amend wiring unchanged); each pseudo-entry renders a `PseudoEntryCard`. The
  groups render in a single gapless `flex flex-col` so entries and calendar events share
  **one continuous timeline rail** across group boundaries. `DayTimeline` is the one
  place that knows the rail's true ends, so it passes `firstOnRail`/`lastOnRail` to each
  `EntryList` run and `first`/`last` to each `PseudoEntryCard` (`g === 0` / `g ===
  groups.length - 1`); every interior run/pseudo keeps its connecting line so the rail
  never breaks mid-day.
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
attachments, location, or playback — those belong to captures. Renders as a node on the
shared timeline rail (`TimelineRow`), so calendar events and real entries read as one
continuous line in the Day view.

**Exports:** `PseudoEntryCard({ entry, first, last, onEdit, onHide, onRemove })` and
`pseudoTimeLabel(entry)` ("9:00 AM – 10:30 AM", or "All day"). `first`/`last` (default
false) trim the rail line at its ends; `DayTimeline` sets them per group position.

**Key behaviors:**

- **Rail gutter:** the gutter's `time` slot shows a single start time (`pseudoRailTime`
  — `clock(startMs)`, or "All day"), since the narrow gutter can't fit a range; the full
  `pseudoTimeLabel` range stays inside the card header where there's room.
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
- **`derivedFrom` alone drives authored-vs-generated (#80, revised):** `authorship()`
  (`authorship.ts`) is the single place that interprets it for rendering — absent means
  authored (heaviest/darkest `type_.bodyStrong`/`tone.textPrimary`), present means
  machine text in the quiet `type_.derived`/`tone.textDerived` pairing, with
  present-and-not-a-caption (spoken) additionally carrying the `SpokenMark` glyph.
  Never add a heuristic on text content to this decision, and never introduce new
  stored state for it — every renderer composes the same tokens via
  `AUTHORSHIP_STYLE`.
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
- **Attachment timestamps are preserved:** each visible attachment keeps the
  `loggedAt` of the capture/amend event that added it via `Entry.attachmentLoggedAt`,
  and `AttachmentTimeline` uses those timestamps to order the entry's sub-timeline.
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
