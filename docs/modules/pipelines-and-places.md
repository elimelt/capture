# Media pipelines & places: `src/transcribe`, `src/vision`, `src/places`

This document covers the two background media-understanding pipelines (audio
transcription and photo captioning) and the location helpers (place matching and
reverse geocoding).

## Module overviews

### `src/transcribe` — audio transcription pipeline

Turns captured audio attachments into machine transcripts after the fact, so capture
stays instant and offline-first. Split into three files following the **plan / runner /
api** pattern:

- `plan.ts` — pure function over the event log: which audio attachments still need a
  transcript.
- `api.ts` — HTTP client for the Whisper-compatible transcription service.
- `runner.ts` — the drain loop: reads pending work from the plan, calls the API, and
  appends the result to the store as an amend event with a `derivedFrom` text
  attachment.

The transcript is just another attachment in the append-only log, so it flows to Drive
through the ordinary upload queue (`src/drive/queue.ts`) with no pipeline-specific sync
code.

### `src/vision` — image analysis pipeline

The photo twin of `src/transcribe`: captions photo attachments using a vision LLM. Same
plan / runner / api split, same amend-with-`derivedFrom` output shape, same skip/backoff
failure handling. The only structural additions are photo-specific: client-side
downscaling before upload (`api.ts`) and a filename-based discriminator to tell photo
captions apart from audio transcripts (`plan.ts`), since both are `kind: 'text'`
attachments with `derivedFrom` set.

### `src/places` — place matching & geocoding

Two independent, small utilities:

- `match.ts` — pure point-in-radius matching of a coordinate against the user's saved
  places (used at capture time to stamp a `placeLabel` on the location snapshot; see
  `src/capture/geo.ts`).
- `geocode.ts` — best-effort reverse geocoding via Nominatim, with an IndexedDB cache
  and a global 1 req/sec throttle (used when saving a place in Settings and by the
  location editor to produce a "near …" address).

## The plan / runner / api pattern

Both pipelines share the same architecture:

1. **Plan** (`plan.ts`): a pure function `(events: readonly LogEvent[]) => Pending…[]`
   with no I/O. It works over the **raw event history**, not just the folded view
   (`src/contract/fold.ts`): an attachment counts as processed if *any* text attachment
   was **ever** derived from it — even one the user later edited or removed. This
   guarantees user edits or deletions of a transcript/caption are never clobbered by
   re-processing. Revoked entries and removed attachments never appear as pending
   because the pending list itself is built from the folded entries.
2. **API** (`api.ts`): a single exported async function that talks to one external
   service, with a 60 s timeout, and throws descriptive `Error`s on non-OK HTTP or
   malformed responses. Returns trimmed text (possibly empty).
3. **Runner** (`runner.ts`): the impure drain. It loads events via
   `listEvents(streamId)` (`src/store/events.ts`), asks the plan what is pending, fetches
   each source blob with `getBlob(file)`, calls the API, and appends the result via
   `appendAmend` targeting the owning entry. Module-level state provides per-file
   exponential backoff and coalescing of concurrent drains.

Runner failure handling (identical in both pipelines):

- **Offline** (`!navigator.onLine`): drain returns `0` immediately.
- **Transient failure** (API throws): recorded in an in-memory `retryState` map —
  exponential backoff starting at 15 s (`BACKOFF_BASE_MS * 2 ** (attempts - 1)`), max 5
  attempts per session; state resets on app relaunch.
- **Permanent failure** (missing blob, empty result text): a skip marker is written to
  the IndexedDB `meta` store (`transcribe:skip:<file>` / `caption:skip:<file>`) so the
  file is never retried, across sessions.
- **Success**: one amend event per attachment, `retryState` entry cleared, counter
  incremented. The drain returns the number of amends appended; the caller
  (`src/App.tsx`) refreshes the store when the count is > 0, which re-runs the drain and
  finds nothing pending (a natural fixpoint).

Relations to other modules:

- **store** (`src/store/db.ts`, `src/store/events.ts`): `getDb()` for the `meta` (skip
  markers) and `geocache` object stores; `listEvents` / `getBlob` / `appendAmend` for
  the event log and blob store.
- **contract** (`src/contract/types.ts`, `fold.ts`, `filenames.ts`): `Attachment` (with
  the `derivedFrom` field marking machine-derived content), `LogEvent`, the fold, and
  the machine-generated filename scheme (`…_photo.jpg`, `…_note.txt`) that
  `vision/plan.ts` relies on.
- **drive** (`src/drive/queue.ts`): no direct dependency. Amend events appended by the
  runners are picked up by the normal upload queue.

## File-by-file

### src/transcribe/plan.ts

Pure planning: which audio attachments still need a transcript.

Exports:

- `interface PendingTranscription { entryId: string; stream: string; audio: Attachment }`
- `isTranscript(a: Attachment): boolean` — true for a machine transcript: `kind ===
  'text'` **and** `derivedFrom !== undefined` (a user-typed note has no `derivedFrom`).
- `pendingTranscriptions(events: readonly LogEvent[]): PendingTranscription[]`

Behavior of `pendingTranscriptions`:

1. First pass over **all non-revoke events** builds `everDerived`, the set of source
   filenames any text attachment was ever derived from. This is deliberately
   history-aware: a transcript later removed or replaced (edits keep `derivedFrom`)
   still marks its audio as transcribed.
2. Second pass over `fold(events)` (current visible entries) collects every
   `kind === 'audio'` attachment whose `file` is not in `everDerived`.

Consequences: audio on revoked entries and audio removed via
`patch.removeAttachments` are never pending (dropped by the fold); audio whose
transcript was deleted by the user is never re-transcribed (history pass).

### src/transcribe/api.ts

Client for the transcription service (Speaches / OpenAI-compatible Whisper at
`https://transcribe.elimelt.com`).

Exports:

- `transcribeAudio(blob: Blob, mimeType: string): Promise<string>` — returns the
  transcript text, trimmed; may be empty for silent clips.

Behavior:

- POSTs a multipart form to `/v1/audio/transcriptions` with fields: `model`
  (`Systran/faster-whisper-base.en`), `response_format: 'json'`, `vad_filter: 'true'`
  (server-side trimming of leading/trailing silence — base.en hallucinates on it), and
  `file`.
- The blob is sent as-is (the server decodes iOS `audio/mp4` and `audio/webm` alike),
  but wrapped in a `File` whose name hints the container: `clip.m4a` for
  `audio/mp4*`, `clip.webm` for `audio/webm*`, otherwise `clip.audio` (private helper
  `fileName(mimeType)`).
- 60 s timeout via `AbortSignal.timeout`. Throws `transcription failed: HTTP <status>`
  on non-OK responses and `transcription failed: no text in response` when the JSON
  body has no string `text`.

### src/transcribe/runner.ts

Background transcription drain.

Exports:

- `drainTranscriptions(streamId: string): Promise<number>` — transcribes every eligible
  pending audio attachment; returns how many amend events were appended. Re-entrant
  calls coalesce onto the single in-flight drain promise (module-level `draining`).

Per-file drain logic (see the pattern section above for the shared failure model):

1. Return `0` immediately when offline.
2. For each `pendingTranscriptions(events)` item, skip files that are backing off
   (`eligible`) or have a `transcribe:skip:<file>` marker in the `meta` store.
3. Missing blob (audio was never kept locally — `keepAudioLocally` off) → mark skipped
   permanently, no API call. Empty transcript → mark skipped permanently.
4. After `transcribeAudio` resolves, re-plan against the current log (fresh
   `listEvents` → `pendingTranscriptions`) and drop the result if the audio no longer
   needs a transcript — a sync pull may have imported another device's transcript
   while the API call was in flight (at-most-once transcription globally).
5. Still pending → `appendAmend({ stream, targets: [entryId], attachments: [{ kind: 'text',
   blob, mimeType: 'text/plain', derivedFrom: audio.file }] })`.

Constants: `MAX_ATTEMPTS_PER_SESSION = 5`, `BACKOFF_BASE_MS = 15_000`.

Called from `src/App.tsx` in an effect that runs whenever the folded entries change,
alongside `drainCaptions`; the app refreshes the store when either returns > 0.

### src/transcribe/plan.test.ts

Covers `isTranscript` (derived text vs. user note vs. non-text) and every
`pendingTranscriptions` edge: same-capture transcripts, later amends, removed/edited
transcripts (history-awareness), revoked entries, removed audio, multiple audio
attachments, and that a plain user note does not count as a transcript.

### src/transcribe/api.test.ts

Stubs `fetch` and verifies the multipart form contract (model, `response_format`,
`vad_filter`, filename by mime type), text trimming, and the errors thrown on non-OK
HTTP and non-string `text` in the response body.

### src/transcribe/runner.test.ts

Exercises `drainTranscriptions` against fake IndexedDB with a mocked API: the amend
shape (`targets`, `derivedFrom`, stored blob content), idempotent second drains,
permanent skip markers for empty transcripts and missing blobs, backoff after failures,
the offline no-op, the two pull-race cases (audio whose transcript arrived via a pulled
amend is never sent to the API; an in-flight result is dropped when a pull imports a
remote transcript mid-drain), and coalescing of overlapping drains onto one promise.
Resets the module registry per test because the runner keeps module-level state.

### src/vision/plan.ts

Pure planning for photo captioning; mirrors `transcribe/plan.ts`.

Exports:

- `interface PendingCaption { entryId: string; stream: string; photo: Attachment }`
- `isPhotoFile(file: string): boolean` — matches the `_photo` filename suffix
  (`/_photo\d*\./`, so `…_photo.jpg` and `…_photo2.jpg` both match). Reliable because
  attachment filenames are machine-generated by `src/contract/filenames.ts`.
- `isCaption(a: Attachment): boolean` — `kind === 'text'` **and** `derivedFrom` set
  **and** `isPhotoFile(a.derivedFrom)`. The extra filename check distinguishes photo
  captions from audio transcripts, which share the first two properties.
- `pendingCaptions(events: readonly LogEvent[]): PendingCaption[]`

`pendingCaptions` uses the same two-pass algorithm as `pendingTranscriptions`
(history-aware `everDerived` set, then a scan of folded entries for `kind === 'photo'`
attachments not in the set). Note the `everDerived` pass adds **any** derived text
source, so a text attachment derived from an audio file also lands in the set — harmless,
because audio filenames never collide with photo filenames.

### src/vision/api.ts

Client for photo captioning: `gemma4:e4b` on the LLM host via its native
(Ollama-style) `/api/chat` endpoint at `https://llm.elimelt.com/api/chat` — the native
API (not the OpenAI-compat `/v1`) is used because only it honors `think: false`, which
turns a ~20 s reasoning detour into a ~2–3 s caption. CORS is origin-gated; no API key.

Exports:

- `captionPhoto(blob: Blob): Promise<string>` — returns the caption text, trimmed; may
  be empty if the model produced none.

Behavior:

- Private `toJpegBase64(blob)` downscales the image (long edge ≤ 1024 px — gemma's
  vision tower sees ~896 px) and re-encodes to JPEG at quality 0.8 via
  `createImageBitmap` + canvas, so uploads stay ~100 KB instead of the multi-megabyte
  camera original. Returns the base64 payload of a data URL; closes the bitmap in a
  `finally`. Throws on a missing 2d context or a failed JPEG encode.
- POSTs JSON `{ model, think: false, stream: false, messages: [{ role: 'user', content:
  PROMPT, images: [base64] }] }` with a fixed captioning prompt; 60 s timeout. Throws
  `caption failed: HTTP <status>` on non-OK responses and `caption failed: no content in
  response` when `message.content` is not a string.

Note: unlike `transcribe/api.ts` and the other files here, `vision/api.ts` has no test
file (its canvas/bitmap path is browser-only).

### src/vision/runner.ts

Background captioning drain; structurally near-identical to `transcribe/runner.ts`.

Exports:

- `drainCaptions(streamId: string): Promise<number>` — captions every eligible pending
  photo attachment; returns how many amend events were appended; re-entrant calls
  coalesce onto the in-flight drain.

Differences from the transcribe runner are limited to: skip-marker prefix
`caption:skip:<file>`, `pendingCaptions` as the plan, and `captionPhoto(blob)` (no mime
type argument) as the API. Same constants (5 attempts/session, 15 s backoff base), same
offline check, same amend shape with `derivedFrom: photo.file`. Also invoked from the
`src/App.tsx` effect. One structural gap: the transcribe runner's post-API re-plan
(drop the result if a pull imported a transcript mid-flight) has no counterpart here
yet.

### src/vision/plan.test.ts

Covers `isCaption` (photo-derived text vs. audio transcript vs. note vs. photo) and the
`pendingCaptions` edges: same-capture captions, later amends, removed captions,
revoked entries, removed photos, two-photo entries, and that neither a user note nor an
audio transcript counts as captioning a photo.

### src/vision/runner.test.ts

Mirrors `transcribe/runner.test.ts` for `drainCaptions`: amend shape and stored caption
blob, idempotent re-drains, permanent skips for empty captions and missing blobs,
failure backoff, offline no-op, and drain coalescing — with fresh module registry and
IndexedDB per test.

### src/places/match.ts

Point-in-radius place matching (SPEC §3.4). Pure; no I/O.

Exports:

- `haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number`
  — great-circle distance in meters (Earth radius 6,371,000 m).
- `matchPlace(places: readonly Place[], lat: number, lng: number): Place | undefined` —
  the **nearest** place whose `radiusM` contains the point, or `undefined`. When
  radii overlap, distance wins, not list order.

`Place` comes from `src/store/db.ts` (`{ id, name, lat, lng, radiusM, address? }`).
Used by `src/capture/geo.ts` (`snapshotLocation`) to stamp `placeLabel` on the
capture-time location snapshot, and by the location editor sheet.

### src/places/geocode.ts

Reverse geocoding (SPEC §7): coordinates → a short "near …" address via Nominatim
(`https://nominatim.openstreetmap.org/reverse`). Best-effort and **never throws**.

Exports:

- `geocacheKey(lat: number, lng: number): string` — rounded `"lat,lng"` cache-cell key,
  4 decimals (~11 m): fine enough to distinguish addresses, coarse enough that nearby
  captures share one cached lookup.
- `shortAddress(data: { address?: Record<string, string>; display_name?: string }):
  string | undefined` — compresses a Nominatim address object into
  `"<road>, <area>"` (road falls back through `pedestrian`/`footway`/`neighbourhood`;
  area through `city`/`town`/`village`/`suburb`/`county`), else the first two parts of
  `display_name`, else `undefined`.
- `reverseGeocode(lat: number, lng: number): Promise<string | undefined>` — checks the
  IndexedDB `geocache` store first; on a miss, fetches
  `…/reverse?format=jsonv2&zoom=18&addressdetails=1&lat=…&lon=…` (with a
  `Referer: capture-pwa` header to identify the app per Nominatim policy) and caches the
  result with a `cachedAt` local-ISO timestamp. Returns `undefined` on any failure
  (offline, non-OK response, cache errors).

Nominatim's usage policy requires caching and ≤ 1 req/sec, so all network calls are
serialized behind a module-level promise chain (`throttle`) enforcing an 1100 ms minimum
interval app-wide; the chain swallows individual failures so it can never wedge. Cache
reads and writes are individually try/caught and non-fatal.

Callers: `src/settings/SettingsScreen.tsx` (saving a place fills its `address`) and
`src/capture/LocationSheet.tsx`. There is no `geocode.test.ts`.

### src/places/match.test.ts

Covers `haversineM` (zero distance, ~111,195 m per degree of latitude, symmetry) and
`matchPlace` (inside/outside radius, nearest-of-overlapping wins, empty list).

## Key invariants & gotchas

- **`derivedFrom` is the machine/user boundary.** Text attachments with `derivedFrom`
  are machine output (transcript or caption); without it they are user-typed. Both
  pipelines and the UI (`src/capture/AttachmentBody.tsx`) rely on this.
- **Never re-process after user edits.** Planning is history-aware: once any text was
  ever derived from a source file, that file is permanently "done", even if the derived
  text was later edited or removed. Deleting a transcript/caption does **not** trigger
  regeneration.
- **Captions vs. transcripts are distinguished by filename**, not by attachment
  metadata: `isCaption` requires `derivedFrom` to match `/_photo\d*\./`. This depends on
  the `contract/filenames.ts` suffix scheme (`_photo`, `_note`); changing that scheme
  would silently break caption detection.
- **The transcribe runner re-plans after the API call** and drops the result if a pull
  imported another device's transcript mid-flight (at-most-once transcription
  globally); the vision runner has no such re-check yet.
- **Runners keep module-level state.** Retry backoff resets on app relaunch; the
  in-flight `draining` promise means concurrent calls share one result — and a call with
  a different `streamId` during an in-flight drain returns the existing drain's promise.
  Tests must `vi.resetModules()` to isolate this state.
- **Skip markers are permanent and local.** `transcribe:skip:*` / `caption:skip:*` keys
  in the `meta` store are never cleared by the app; empty results and missing blobs are
  treated as permanently unprocessable.
- **Empty API results are valid.** `transcribeAudio`/`captionPhoto` return `''` rather
  than throwing; the runners convert that into a permanent skip, not a retry.
- **Pipelines are append-only writers.** They only ever `appendAmend`; the resulting
  events reach Drive through the ordinary upload queue. No Drive code in these modules.
- **`reverseGeocode` never throws and may return `undefined`**; callers must treat the
  address as optional. The 1 req/sec throttle is global to the app session — bulk
  lookups serialize and can be slow by design.
- **`matchPlace` picks by distance, not list order**, and only within `radiusM`;
  `haversineM` treats coordinates as spherical (no ellipsoid correction), which is fine
  at place-radius scales.
