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
changing the captured time, editing location on a map, per-entry Drive sync status,
undoable delete, and an Edit sheet (`EditEntrySheet`) that changes the capture date
and time and removes any attachment — every entry field is editable, always via new
`amend`/`revoke` events, never mutation.

The module writes exclusively through the zustand store (`src/store/appStore.ts`):
`capture` appends a capture event, `amend` patches entries (time, location, attachment
add/remove), and `revoke` deletes them. All writes land in the append-only local event
log (`src/store/events.ts`, folded per `src/contract`) and are eagerly drained to Google
Drive; `SyncBadge` reflects the per-event-id upload status from `src/store/db.ts`.

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
type="file" accept="image/*" capture="environment">`, either an `EmptyState` or
`EntryList` for today's entries, an optional `TextSheet`, and one of three toasts
(captured-with-Undo, deleted-with-Undo, discarded).

**Key behaviors:**

- **Record tap flow** (`handleRecordTap`): when idle, notes the tap time
  (`tapStartRef`), kicks off `snapshotLocation(...)` into `locationRef` (a
  `Promise<GeoLocation | undefined>` resolving concurrently with recording), and calls
  `recorder.start(maxClipSec, onAutoStop)`. When recording, `recorder.stop()` then
  commits. Commit (`commitRef.current`) awaits the location promise and calls
  `capture({ capturedAt: toLocalIso(tapStart), location, attachments: [audio] })` —
  `capturedAt` is the moment the user tapped record, not when the clip ended.
- **Background commit (A6):** iOS suspends backgrounded PWAs aggressively, so a
  `visibilitychange` → `hidden` listener stops an in-flight recording and commits it
  instead of losing it. `recordingRef`/`commitRef` are refs so the listener always sees
  current state without re-subscribing.
- **Passive location context (A5):** an effect probes `snapshotLocation` on mount and
  whenever the app returns to the foreground, producing the label under the mic button
  (`at <place>` when a saved place matches, `location on` when only coordinates are
  available, nothing when location is disabled).
- **Text/photo capture:** `submitText(text)` and `submitPhoto(file)` each snapshot
  location at submit time and call `capture` with a single `text` / `photo` attachment
  (photo mime falls back to `image/jpeg` when `file.type` is empty).
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

### src/capture/RecordPanel.tsx

**Purpose:** The capture control — a pure presentational component driven by a
`Recorder` (from `useRecorder`).

**Export:** `RecordPanel({ recorder, maxClipSec, onTap, onDiscard,
onCamera, onText }: RecordPanelProps)`.

**Behavior by recorder state:**

- `error`: full-width fallback with a message keyed off `recorder.errorKind` —
  `'denied'` points to iOS Settings (no "Try again" button, since retrying a denied mic
  is futile), `'failed'` offers "Try again" (`recorder.resetError`). Both offer "Type an
  entry" (`onText`), so capture never dead-ends.
- `recording`: focused panel with `LevelMeter` (fed `recorder.getLevel`), an m:ss timer,
  an "Ns left" countdown once `maxClipSec - elapsedSec <= 10`, and Discard / Done
  buttons (`onDiscard` / `onTap`).
- idle: the large mic button (`onTap`) flanked by camera and text-cursor `SatelliteButton`s
  (`onCamera` / `onText`). No visible labels — all three capture buttons are icon-only
  for visual consistency (aria-labels for accessibility).

Private helpers: `SatelliteButton`, `clock()`. The mic/camera/text-cursor glyphs come from
the shared `captureIcon` mapping in `src/ui` (icons.tsx), which entry cards reuse so
their action buttons match the main CTA.

### src/capture/LevelMeter.tsx

**Purpose:** Scrolling live input-level visualization (A1) proving the mic is hearing
the user.

**Export:** `LevelMeter({ getLevel }: { getLevel: () => number })`.

**Behavior:** renders a `<canvas>` (36 bars × 3px, DPR-scaled, `aria-hidden`) and drives
it from a `requestAnimationFrame` loop. Samples `getLevel()` (0..1 RMS, boosted 2.5× and
clamped) every ~50ms into a rolling history, so the strip covers roughly the last 2
seconds, drawn right-to-left with a 3px minimum bar height. The rAF loop is cancelled on
unmount.

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
  `audio` attachment.
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

It also reads `streamSettings.maxClipSec` and looks up each entry's sync status by
`entry.id` from `syncStatuses`.

### src/capture/EntryCard.tsx

**Purpose:** One entry's card: header (editable time, place label, sync badge, duration,
play button), attachment body, optional mini map, action row, and the sheets/inputs those
actions open.

**Exports:** `EntryCard(props: EntryCardProps)` and `timeLabel(iso: string): string`
(locale time like "9:04 AM"). Props: `entry`, `maxClipSec`, `syncStatus?`, and callbacks
`onDelete`, `onSetTime(time)`, `onAddNote(text)`, `onAddPhoto(file)`,
`onAddAudio(result)`, `onEditText(oldFile, text, derivedFrom?)`,
`onRemoveAttachment(file)`, `onSetLocation(location | null)`, `onApplyEdit(patch)`.

**Key behaviors:**

- **Header grouping:** one flex row — time + place label tightly grouped on the left,
  sync badge + clip duration + play button pushed to the far right. The time label has
  no underline decoration; it is still the tap target for the native picker (below),
  and the Edit sheet provides the second, labelled path to the same field.
- **Time editing (B8):** the time label is a button layered over an invisible
  `<input type="time">`; tapping calls `showPicker()` (fallback `focus()`) so iOS shows
  its native wheel picker. `onChange` fires `onSetTime` only for non-empty values.
- **Primary clip playback (B10):** the *first* audio attachment plays from the header
  via `useAudioPlayback(audio?.file)` as an `accent`-variant `IconButton` (accent wash +
  border so it reads as interactive against the card); while playing, a progress fill
  widens behind the ▶/■ icon. Later clips render inside `AttachmentBody`.
- **Per-card recorder:** "+ audio" uses its own `useRecorder()` instance so entries can
  hold multiple clips; while recording, the action row is replaced by a compact timer
  bar with Discard/Done. If that recorder errors, the "+ audio" button becomes a
  "mic unavailable" button that just calls `rec.resetError`.
- **Lazy Leaflet:** `MiniMap` and `LocationSheet` are `lazy()` imports wrapped in
  `Suspense fallback={null}`, keeping the Leaflet JS+CSS chunk out of the initial bundle
  and loading it only for cards that show or edit a location.
- **Header labels:** shows `location.placeLabel` or `near <address>` when present; shows
  `durationSec`s for the primary clip; `SyncBadge` reflects `syncStatus`.
- Hidden photo input (camera capture) and a `TextSheet` for "+ note" mirror the
  capture-screen patterns.
- **Action bar:** a full-bleed hairline divider separates the card's content from a
  footer of icon-only 44 px `IconButton`s (no text labels; names live in `aria-label`
  and `title`): add actions on the left — note/photo/audio render the same glyphs as
  the main CTA (text cursor/camera/mic via `captureIcon` from `src/ui`, so an entry's add
  actions share the capture control's visual language) plus location
  (`PinIcon`/`PlusIcon`) — and on the right, Edit (`SlidersIcon` — the text cursor already
  means *text* here) opening `EditEntrySheet` (Save → `onApplyEdit(patch)`), then
  Delete (`TrashIcon`, `danger` variant — muted clay) at the far edge. A recorder
  error swaps the audio button for a labelled "mic unavailable" reset button.

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

### src/capture/AttachmentBody.tsx

**Purpose:** Renders an entry's content beyond the primary clip (B7).

**Export:** `AttachmentBody({ attachments, onEditText, onRemoveAttachment }:
AttachmentBodyProps)`.

**Ordering/classification:** delegates to the pure `groupAttachments`
(`attachmentGroups.ts`). Render order: transcripts, then any still-**streaming**
transcripts, notes, extra audio rows (clips beyond the first, which plays from the
card header), then one horizontal row per photo — 64 px thumbnail left, its caption(s)
or still-streaming caption right — then any orphan captions (photo since removed).
Returns `null` if every group is empty (streaming transcripts count — a fresh
audio-only entry shows its transcript growing).

**Type scale:** transcripts and notes are the entry's main text and render at
`type_.bodyStrong` (transcripts in `textPrimary` — they are the spoken content —
notes in `textSecondary`); photo captions are descriptive metadata and render at
`type_.bodySmall` in `textMuted`, beside their thumbnail rather than as a competing
text block.

**Key behaviors:**

- **Streaming machine text.** The component subscribes (one `useSyncExternalStore`
  per store) to the transient live-text stores `liveTranscripts`/`liveCaptions`
  (`src/store/livetext.ts`), where the enrichment runners publish partial text keyed by
  source file while a transcription/caption request streams. For each audio/photo
  attachment with **no persisted derived text yet**, non-empty live text renders as a
  read-only `StreamingText` — same tokens and position as the final `NoteText`, plus a
  pulsing cursor tick, `aria-live="polite"`, and nothing to tap (there is no attachment
  to edit until the amend lands). Once a derived attachment exists it always wins over
  live text.
- `NoteText` loads its text asynchronously via `getBlob(file)` (renders nothing until
  loaded; guards against stale sets on unmount). Tapping opens the shared edit
  `TextSheet`, titled "Edit note" / "Edit caption" / "Edit transcript" based on
  `derivedFrom` and `isPhotoFile`; save calls `onEditText(file, text, derivedFrom)`.
- `AudioRow` is a playback row (via `useAudioPlayback`) with the same progress-fill
  toggle button plus "Recording · Ns" caption.
- `PhotoThumb` loads a blob object URL (revoked on unmount), shows a 64px thumbnail, and
  expands to a full-screen viewer (`role="dialog"`) on tap; the viewer's "Remove photo"
  button calls `onRemove` (→ `onRemoveAttachment`). Tapping the backdrop closes it.

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

### src/capture/MiniMap.tsx

**Purpose:** Embedded location preview inside an entry card, expanding to a full-screen
interactive map. Lazy chunk (Leaflet JS + CSS loaded only when a card has a location).

**Exports:** default `MiniMap({ location }: { location: GeoLocation })`; named
`LocationLabel({ location })` (caption text: `placeLabel` or `near <address>`, or null).

**Key behaviors:**

- Compact state: a `pointer-events-none`, 96px-tall non-interactive `MapContainer`
  (zoom 15, all controls/gestures disabled) with a clay `CircleMarker`, wrapped in a
  button that opens the full-screen dialog.
- `Recenter` helper: react-leaflet's `MapContainer` reads `center`/`zoom` only on mount,
  so after a location amend the map would keep showing the old spot; `Recenter` calls
  `map.setView` imperatively whenever the coordinate changes.
- Expanded state: full-screen dialog (zoom 16, interactive) with a `Popup` label and,
  when `placeLabel` is set, a spruce accuracy `Circle` of radius
  `max(accuracyM, 40)` meters.

### src/capture/SyncBadge.tsx

**Purpose:** Per-entry Drive upload status badge (SPEC §8.4), fed from the sync rows the
drive drainer advances.

**Export:** `SyncBadge({ status }: { status: SyncStatus | undefined })` where
`SyncStatus` is `'queued' | 'uploaded' | 'error'` from `src/store/db`.

**Behavior:** renders nothing when `status` is `undefined` (never queued) or
`'uploaded'` — a synced entry needs no chrome. Otherwise a small dot + label: "Queued"
(faint) or "Failed" (danger tone, title "Upload failed — will retry").

### src/capture/useRecorder.ts

**Purpose:** `getUserMedia` + `MediaRecorder` wrapper hook. Negotiates the audio
container at runtime — iOS Safari records `audio/mp4`, not webm, so the mime type is
picked from `['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']` via
`MediaRecorder.isTypeSupported`, never hardcoded.

**Exports:**

- `useRecorder(): Recorder`
- `interface Recorder { state: 'idle' | 'recording' | 'error'; elapsedSec: number;
  start(maxSec = 60, onAutoStop?): Promise<void>; stop(): Promise<RecordingResult |
  null>; cancel(): void; resetError(): void; getLevel(): number; errorKind?: 'denied' |
  'failed' }`
- `interface RecordingResult { blob: Blob; mimeType: string; durationSec: number }`
- Types `RecorderState`, `RecorderErrorKind`.

**Lifecycle & edge cases:**

- `start` is a no-op if a recorder already exists. On `getUserMedia`/`MediaRecorder`
  failure it cleans up and sets `state: 'error'` with `errorKind` — `'denied'` for
  `NotAllowedError`/`SecurityError` `DOMException`s (user must change iOS Settings),
  `'failed'` otherwise (worth retrying).
- A 250ms interval updates `elapsedSec` and auto-stops at `maxSec`, delivering the clip
  to `onAutoStop`. Because both the timer and a user tap can race to stop, `finalize()`
  claims the recorder by nulling `recorderRef` first, making concurrent
  stop/auto-stop calls no-ops (they resolve `null`).
- `stop`/`finalize` resolves after the `onstop` event with a blob assembled from
  `dataavailable` chunks; mime falls back to the first chunk's type then `audio/webm`;
  `durationSec` is wall-clock, rounded, minimum 1. Empty blobs resolve `null`.
- `cancel` detaches `onstop`, stops the recorder, and drops the chunks (A2 — discard).
- The level meter is best-effort: an `AudioContext` + `AnalyserNode` (fftSize 512) is
  set up in a nested try/catch; if unavailable, `getLevel()` returns 0 and recording
  continues. `getLevel()` computes RMS over byte time-domain data.
- `cleanup` stops all `MediaStream` tracks (releases the mic), clears the timer, and
  closes the `AudioContext`; it also runs on unmount.

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
  (`EyeOffIcon`) and Edit (`SlidersIcon`) buttons.
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
  user's edit. `onEditText` performs remove-old + add-new in a *single* amend.
- **`capturedAt` semantics:** for voice entries it is the record-tap time, not the stop
  time; text/photo entries use submit time. Inline time edits change only the
  time-of-day, re-rendered in the device zone (`withTimeOfDayIso`); the Edit sheet
  edits date and time in the **entry's own zone** (`civilTimeOf` draft, `zonedIso`
  recomposition with `entry.deviceTz`), and both land in `patch.capturedAt`.
- **Recorder races are resolved by claiming:** `finalize()` nulls `recorderRef` before
  stopping, so a user tap racing the auto-stop timer (or the background-commit handler)
  yields exactly one committed clip.
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
- **Leaflet is always lazy:** `MiniMap` and `LocationSheet` load as separate chunks;
  `MiniMap` must re-center imperatively (`Recenter`) because `MapContainer` ignores
  `center` prop changes after mount.
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
