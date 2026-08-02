# Media pipelines & places: `src/transcribe`, `src/vision`, `src/places`

This document covers the two background media-understanding pipelines (audio
transcription and photo captioning) and the location helpers (place matching and
reverse geocoding).

## Module overviews

### `src/transcribe` — audio transcription pipeline

Turns captured audio attachments into machine transcripts after the fact, so capture
stays instant and offline-first. Split into four files following the **plan / runner /
api** pattern (plus a pure streaming core):

- `plan.ts` — pure function over the event log: which audio attachments still need a
  transcript.
- `api.ts` — HTTP client for the Whisper-compatible transcription service. Streams:
  partial transcripts are surfaced per segment while the request runs.
- `stream.ts` — pure streaming core: incremental SSE parsing and transcript assembly,
  no I/O.
- `runner.ts` — the drain loop: reads pending work from the plan, calls the API
  (publishing streamed partials to `src/store/livetext.ts` for the entry card), and
  appends the final result to the store as an amend event with a `derivedFrom` text
  attachment.

The transcript is just another attachment in the append-only log, so it flows to Drive
through the ordinary upload queue (`src/drive/queue.ts`) with no pipeline-specific sync
code.

### `src/vision` — image analysis pipeline

The photo twin of `src/transcribe`: captions photo attachments using a vision LLM. Same
plan / stream / runner / api split, same streamed-partials-then-final-amend flow, same
amend-with-`derivedFrom` output shape, same skip/backoff failure handling. The only
structural additions are photo-specific: client-side downscaling before upload
(`api.ts`), NDJSON rather than SSE as the stream format (`stream.ts`), and a
filename-based discriminator to tell photo captions apart from audio transcripts
(`plan.ts`), since both are `kind: 'text'` attachments with `derivedFrom` set.

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
   malformed responses. Returns trimmed text (possibly empty). Both APIs request a
   **streaming** response and take an optional `onPartial(text)` callback that receives
   the accumulated text as it arrives — display-only; the promise's resolved value is
   the only result, and it is identical to what the non-streaming endpoint would have
   returned. A stream cut off mid-way **rejects** (never resolves with truncated text),
   and if the server ignores `stream` the client falls back to parsing the whole body.
3. **Stream** (`stream.ts`): the pure streaming core the API builds on — incremental
   wire-format parsing (chunks may split anywhere) and partial/final text assembly,
   fully unit-tested with no I/O. Transcription parses SSE segments; captioning parses
   NDJSON deltas.
4. **Runner** (`runner.ts`): the impure drain. It loads events via
   `listEvents(streamId)` (`src/store/events.ts`), asks the plan what is pending, fetches
   each source blob with `getBlob(file)`, calls the API, and appends the result via
   `appendAmend` targeting the owning entry. Module-level state provides per-file
   exponential backoff and coalescing of concurrent drains. While an API call streams,
   the runner publishes each partial to the matching transient live-text store
   (`liveTranscripts` / `liveCaptions` in `src/store/livetext.ts`, keyed by source
   file), which `src/capture/AttachmentBody.tsx` renders on the entry card; the key is
   cleared on failure/drop and swept at the start of the next drain, and only the
   resolved final text is ever persisted.

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

- **store** (`src/store/db.ts`, `src/store/events.ts`, `src/store/livetext.ts`):
  `getDb()` for the `meta` (skip markers) and `geocache` object stores; `listEvents` /
  `getBlob` / `appendAmend` for the event log and blob store; `liveTranscripts` /
  `liveCaptions` for publishing streamed partial text to the entry card.
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
`ENDPOINTS.transcribe`, `https://transcribe.elimelt.com` — sourced from `src/config.ts`,
issue #69).

Exports:

- `transcribeAudio(blob: Blob, mimeType: string, onPartial?: (text: string) => void):
  Promise<string>` — returns the transcript text, trimmed; may be empty for silent
  clips. While the response streams, `onPartial` receives the transcript-so-far after
  each segment (display-only).

Behavior:

- POSTs a multipart form to `/v1/audio/transcriptions` with fields: `model`
  (`Systran/faster-whisper-base.en`), `response_format: 'text'`, `stream: 'true'`,
  `vad_filter: 'true'` (server-side trimming of leading/trailing silence — base.en
  hallucinates on it), and `file`.
- The blob is sent as-is (the server decodes iOS `audio/mp4` and `audio/webm` alike),
  but wrapped in a `File` whose name hints the container: `clip.m4a` for
  `audio/mp4*`, `clip.webm` for `audio/webm*`, otherwise `clip.audio` (private helper
  `fileName(mimeType)`).
- The server answers with SSE (one event per whisper segment); the client decodes the
  body through `stream.ts`, calls `onPartial(assembleTranscript(segments))` as segments
  land, and resolves with the assembled final text. If the response is not
  `text/event-stream` (server ignored `stream`), it falls back to the whole plain-text
  body, trimmed.
- 60 s timeout via `AbortSignal.timeout` (covers the whole stream). Throws
  `transcription failed: HTTP <status>` on non-OK responses and
  `transcription failed: truncated stream` when the body ends mid-event — a cut
  connection is a transient failure, never a silently truncated transcript.

### src/transcribe/stream.ts

Pure streaming core: incremental SSE parsing and transcript assembly, no I/O.

Exports:

- `feedSse(buffer: string, chunk: string): { buffer: string; data: string[] }` — feed
  one decoded chunk; returns the `data:` payloads of the events it completed plus the
  unconsumed tail to pass into the next call. Handles events split anywhere across
  chunks, multiple `data:` lines per event (joined with `\n`), CRLF (including a CR/LF
  split across chunks), and ignores comments and non-`data` fields. Exactly one leading
  space after `data:` is stripped, per the SSE spec — which is what preserves the raw
  segment text below.
- `assembleTranscript(segments: readonly string[]): string` — plain concatenation, then
  trim. Used for both the mid-stream partials and the final result, so they agree at
  every prefix.

Why this reproduces the non-streaming result byte-for-byte: speaches' non-streaming
`json`/`text` response is `"".join(segment.text).strip()` over the raw whisper segment
texts, and its `response_format=text` SSE events carry each segment's **raw** text
(leading space included, since `data: ` + payload puts the payload's own space second).
Concatenate raw payloads, trim once — the same bytes the non-streaming path would have
stored.

### src/transcribe/runner.ts

Background transcription drain.

Exports:

- `drainTranscriptions(streamId: string): Promise<number>` — transcribes every eligible
  pending audio attachment; returns how many amend events were appended. Re-entrant
  calls coalesce onto the single in-flight drain promise (module-level `draining`).
- `shouldDrain(online: boolean, enrichmentEnabled: boolean): boolean` — pure drain-gate
  predicate (`online && enrichmentEnabled`), unit-tested without any I/O.

Automatic transcription is fully opt-in (owner policy, issue #89): `AppSettings.enrichmentEnabled`
defaults to `false`, and no audio reaches `transcribe.elimelt.com` until the user turns it
on in Settings. Per-file drain logic (see the pattern section above for the shared failure model):

1. Return `0` immediately when offline (checked synchronously, before any IndexedDB read).
2. Read `AppSettings.enrichmentEnabled` (`src/store/settings.ts`); return `0` if it is off.
   This is a second, independent gate from the one `src/App.tsx` applies at the call site
   (defense in depth — a future caller that forgets to check the setting still can't reach
   the network), and it is also what makes the opt-in **backfill** work: `pendingTranscriptions`
   already scans the full event history, so audio captured while enrichment was off is
   picked up by the very next drain once the user turns it on, with no special-casing.
3. Sweep `liveTranscripts` down to the currently-pending audio files (drops live text
   left by attempts that completed before this drain).
4. For each `pendingTranscriptions(events)` item, skip files that are backing off
   (`eligible`) or have a `transcribe:skip:<file>` marker in the `meta` store.
5. Missing blob (audio was never kept locally — `keepAudioLocally` off) → mark skipped
   permanently, no API call. Empty transcript → clear live text, mark skipped
   permanently.
6. While `transcribeAudio` streams, each partial is published to
   `liveTranscripts.set(audio.file, partial)` for the entry card; a mid-stream failure
   lands in the catch, which clears the live text and backs off as before — partial
   text is never persisted.
7. After `transcribeAudio` resolves, re-plan against the current log (fresh
   `listEvents` → `pendingTranscriptions`) and drop the result (clearing its live text)
   if the audio no longer needs a transcript — a sync pull may have imported another
   device's transcript while the API call was in flight (at-most-once transcription
   globally).
8. Still pending → `appendAmend({ stream, targets: [entryId], attachments: [{ kind: 'text',
   blob, mimeType: 'text/plain', derivedFrom: audio.file }] })`. The final live text is
   left in place until the next drain's sweep, so the card never flashes empty before
   the store refresh reveals the persisted attachment.

Constants: `MAX_ATTEMPTS_PER_SESSION = 5`, `BACKOFF_BASE_MS = 15_000`.

Called from `src/App.tsx` in an effect that runs whenever the folded entries change,
alongside `drainCaptions`, but only while `AppSettings.enrichmentEnabled` is on (the
effect's own gate — belt-and-suspenders with the runner-level one above); the app
refreshes the store when either drain returns > 0.

### src/transcribe/plan.test.ts

Covers `isTranscript` (derived text vs. user note vs. non-text) and every
`pendingTranscriptions` edge: same-capture transcripts, later amends, removed/edited
transcripts (history-awareness), revoked entries, removed audio, multiple audio
attachments, and that a plain user note does not count as a transcript.

### src/transcribe/api.test.ts

Stubs `fetch` with `ReadableStream`-bodied SSE responses and verifies the multipart
form contract (model, `response_format: text`, `stream: true`, `vad_filter`, filename
by mime type), segment concatenation matching the non-streaming join, the `onPartial`
sequence across chunk boundaries, the empty-stream (silent clip) result, rejection on a
mid-stream connection error (after partials were emitted) and on a stream that ends
mid-event, the plain-text fallback when the server does not stream, and the error
thrown on non-OK HTTP.

### src/transcribe/stream.test.ts

Covers `feedSse` (single/multiple events per chunk, events split across chunks,
one-leading-space stripping that preserves the segment's own space, multi-line data
joins, bare `data` lines, ignored comments/fields, CRLF including a CR split across
chunks) and `assembleTranscript` (raw-concatenation + trim equal to the server's
non-streaming join, interior whitespace preserved verbatim, empty cases, and
partial-prefix/final agreement).

### src/transcribe/runner.test.ts

Exercises `drainTranscriptions` against fake IndexedDB with a mocked API: the amend
shape (`targets`, `derivedFrom`, stored blob content), idempotent second drains,
permanent skip markers for empty transcripts and missing blobs, backoff after failures,
the offline no-op, the two pull-race cases (audio whose transcript arrived via a pulled
amend is never sent to the API; an in-flight result is dropped when a pull imports a
remote transcript mid-drain), and coalescing of overlapping drains onto one promise.
A separate `shouldDrain` describe block pins the pure gate predicate directly; a
`drainTranscriptions — enrichment opt-in gate` describe block pins the runner-level
early-return itself: no API call while `enrichmentEnabled` is off (the default), the
backlog backfilling once it is turned on (`pendingTranscriptions` needs no
special-casing since it already scans full history), and the gate holding even across
repeated calls with no call-site check at all. The streaming tests cover the live-text
lifecycle: partials published to
`liveTranscripts` mid-flight, the final text lingering until the next drain's sweep,
clearing on mid-stream failure (with nothing persisted) and on the mid-drain pull race.
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
(Ollama-style) `/api/chat` endpoint at `ENDPOINTS.vision` (`https://llm.elimelt.com/api/chat`
— sourced from `src/config.ts`, issue #69; `dayview/daySummaryClient.ts` reuses the same
endpoint for day-prose synthesis) — the native API (not the OpenAI-compat `/v1`) is used
because only it honors `think: false`, which turns a ~20 s reasoning detour into a ~2–3 s
caption. CORS is origin-gated; no API key.

Exports:

- `captionPhoto(blob: Blob, onPartial?: (text: string) => void): Promise<string>` —
  returns the caption text, trimmed; may be empty if the model produced none. While the
  response streams, `onPartial` receives the caption-so-far after each delta
  (display-only).

Behavior:

- Private `toJpegBase64(blob)` downscales the image (long edge ≤ 1024 px — gemma's
  vision tower sees ~896 px) and re-encodes to JPEG at quality 0.8 via
  `createImageBitmap` + canvas, so uploads stay ~100 KB instead of the multi-megabyte
  camera original. Returns the base64 payload of a data URL; closes the bitmap in a
  `finally`. Throws on a missing 2d context or a failed JPEG encode.
- POSTs JSON `{ model, think: false, stream: true, messages: [{ role: 'user', content:
  PROMPT, images: [base64] }] }` with a fixed captioning prompt; 60 s timeout (covers
  the whole stream). The endpoint answers with NDJSON content deltas, decoded through
  `stream.ts`; the client calls `onPartial(assembleCaption(deltas))` as deltas land and
  resolves once the terminal `done: true` line arrives. If the response is plain
  `application/json` (server ignored `stream`), it falls back to the old single-body
  parse.
- Throws `caption failed: HTTP <status>` on non-OK responses, `caption failed:
  truncated stream` when the body ends without the `done` line, and the `stream.ts`
  parse errors (`malformed stream chunk`, `no content in response`, a server-reported
  `error` field) on broken streams — a cut connection is a transient failure, never a
  silently truncated caption.

Note: unlike `transcribe/api.ts`, `vision/api.ts` has no test file (its canvas/bitmap
path is browser-only); its pure streaming logic is tested via `stream.test.ts`.

### src/vision/stream.ts

Pure streaming core: incremental NDJSON parsing and delta accumulation, no I/O.

Exports:

- `feedLines(buffer: string, chunk: string): { buffer: string; lines: string[] }` —
  split a decoded chunk into complete non-empty lines (CR-stripped), buffering a
  partial tail for the next call.
- `parseChatLine(line: string): { delta: string; done: boolean }` — parse one
  `/api/chat` NDJSON line. Throws on a server-reported `error` field, unparsable JSON,
  or a non-terminal chunk without string `message.content`; tolerates a stats-only
  `done: true` line.
- `assembleCaption(deltas: readonly string[]): string` — concatenation + trim,
  identical to trimming the non-streaming `message.content` (Ollama's stream deltas
  concatenate to exactly that string). Used for both partials and the final result.

### src/vision/runner.ts

Background captioning drain; structurally near-identical to `transcribe/runner.ts`.

Exports:

- `drainCaptions(streamId: string): Promise<number>` — captions every eligible pending
  photo attachment; returns how many amend events were appended; re-entrant calls
  coalesce onto the in-flight drain.
- `shouldDrain(online: boolean, enrichmentEnabled: boolean): boolean` — same pure
  drain-gate predicate as the transcribe runner.

Differences from the transcribe runner are limited to: skip-marker prefix
`caption:skip:<file>`, `pendingCaptions` as the plan, `captionPhoto(blob, onPartial)`
(no mime type argument) as the API, and `liveCaptions` as the live-text store (same
lifecycle: sweep to pending files at drain start, partials published mid-stream,
cleared on failure/empty, final text left for the next sweep). Same constants (5
attempts/session, 15 s backoff base), same offline check, same `enrichmentEnabled` gate
(reads `AppSettings` via `getSettings()`, independent of the `src/App.tsx` call-site
check), same amend shape with `derivedFrom: photo.file`. Also invoked from the
`src/App.tsx` effect. One structural gap: the transcribe runner's post-API re-plan
(drop the result if a pull imported a transcript mid-flight) has no counterpart here yet.

### src/vision/plan.test.ts

Covers `isCaption` (photo-derived text vs. audio transcript vs. note vs. photo) and the
`pendingCaptions` edges: same-capture captions, later amends, removed captions,
revoked entries, removed photos, two-photo entries, and that neither a user note nor an
audio transcript counts as captioning a photo.

### src/vision/stream.test.ts

Covers `feedLines` (lines split across chunks, several per chunk, blank-line skipping,
CRLF), `parseChatLine` (content deltas, terminal/stats-only `done` lines, thrown errors
for server `error` fields, unparsable JSON, and non-string content), and
`assembleCaption` (concatenation + trim, empty cases, partial-prefix/final agreement).

### src/vision/runner.test.ts

Mirrors `transcribe/runner.test.ts` for `drainCaptions`: amend shape and stored caption
blob, idempotent re-drains, permanent skips for empty captions and missing blobs,
failure backoff, offline no-op, and drain coalescing — with fresh module registry and
IndexedDB per test. The streaming tests cover the `liveCaptions` lifecycle: partials
published mid-flight, final text lingering until the next drain's sweep, and clearing
on mid-stream failure with nothing persisted. Mirrors the transcribe runner's gate
coverage too: `shouldDrain` pinned directly, plus a `drainCaptions — enrichment opt-in
gate` block covering no-API-call while off, backfill of photos captured while off once
turned on, and the runner-level gate holding with no call-site check at all.

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

- **Enrichment is fully opt-in, off by default (owner policy, issue #89).**
  `AppSettings.enrichmentEnabled` defaults to `false`; both runners early-return before
  any network call unless it is on, independent of the `src/App.tsx` call-site check
  (defense in depth). Turning the setting off never deletes existing transcripts or
  captions — they are ordinary amend attachments in the append-only log. Turning it on
  backfills the backlog on the very next drain with no special-casing, because
  `pendingTranscriptions`/`pendingCaptions` already scan the full event history.
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
- **Streaming is display-only.** Partial text flows through `onPartial` into the
  transient live-text stores and never into the log; the persisted final text is
  byte-identical to what the non-streaming endpoints would have returned, and a stream
  that fails or is truncated mid-way rejects (transient failure, normal backoff) rather
  than resolving with a prefix.
- **Pipelines are append-only writers.** They only ever `appendAmend`; the resulting
  events reach Drive through the ordinary upload queue. No Drive code in these modules.
- **`reverseGeocode` never throws and may return `undefined`**; callers must treat the
  address as optional. The 1 req/sec throttle is global to the app session — bulk
  lookups serialize and can be slow by design.
- **`matchPlace` picks by distance, not list order**, and only within `radiusM`;
  `haversineM` treats coordinates as spherical (no ellipsoid correction), which is fine
  at place-radius scales.
