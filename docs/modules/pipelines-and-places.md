# Media pipelines & places: `src/transcribe`, `src/vision`, `src/enrich`, `src/places`

This document covers the two background media-understanding pipelines (audio
transcription and photo captioning), the shared drain engine they bind onto, and the
location helpers (place matching and reverse geocoding).

## Module overviews

### `src/enrich` — shared enrichment drain engine

The two pipelines below used to hand-duplicate an entire drain loop; the copies
diverged (issue #51: the vision runner was missing a re-plan guard the transcribe
runner had, which could produce duplicate captions). `src/enrich` now holds every
piece of drain machinery that must behave identically across pipelines, so that class
of divergence can't recur:

- `error.ts` — the failure taxonomy. `EnrichmentError` (mirroring `DriveError`,
  `src/drive/client.ts`) carries `retryable` and `hostDown` flags; `isRetryableStatus`
  classifies an HTTP status (408/429/5xx transient, other 4xx permanent);
  `classifyFailure` classifies any thrown error, defaulting unrecognized ones to
  "retryable, not host-down" (the runners' original blanket behavior) so the taxonomy
  only ever adds permanent/circuit-breaker handling on top of existing backoff.
- `runner.ts` — `createEnrichmentRunner<T>(config)`, the drain loop itself: backoff,
  skip-marker persistence (with a reason), the missing-blob defer, the per-drain
  circuit breaker, and the post-API re-plan guard. `config` parameterizes exactly the
  things that differ per pipeline: `plan`, `sourceOf` (the source attachment),
  `targetOf` (entry + stream for the amend), `callApi`, and `liveStore`.
- `config.ts` — the enrichment endpoints/models (`TRANSCRIBE_BASE_URL`,
  `TRANSCRIBE_MODEL`, `VISION_CHAT_URL`, `VISION_MODEL`), hoisted out of each
  pipeline's `api.ts` into one file (issue #62 — a fork/self-hoster now edits one file
  instead of two, paired with the matching CSP edit in `index.html`).

### `src/transcribe` — audio transcription pipeline

Turns captured audio attachments into machine transcripts after the fact, so capture
stays instant and offline-first. Split into four files following the **plan / runner /
api** pattern (plus a pure streaming core):

- `plan.ts` — pure function over the event log: which audio attachments still need a
  transcript.
- `api.ts` — HTTP client for the Whisper-compatible transcription service. Streams:
  partial transcripts are surfaced per segment while the request runs. Throws
  `EnrichmentError` (`src/enrich/error.ts`) for classified failures (HTTP status,
  truncated stream).
- `stream.ts` — pure streaming core: incremental SSE parsing and transcript assembly,
  no I/O.
- `runner.ts` — a thin binding of `src/enrich/runner.ts`'s `createEnrichmentRunner` onto
  this pipeline's plan/API/live-text store. All drain mechanics (reading pending work,
  calling the API, publishing partials to `src/store/livetext.ts`, appending the final
  result as an amend with a `derivedFrom` text attachment, failure classification, the
  circuit breaker, the pull-race guard) live in the shared engine.

The transcript is just another attachment in the append-only log, so it flows to Drive
through the ordinary upload queue (`src/drive/queue.ts`) with no pipeline-specific sync
code.

### `src/vision` — image analysis pipeline

The photo twin of `src/transcribe`: captions photo attachments using a vision LLM. Same
plan / stream / runner / api split, both runners binding onto the same
`createEnrichmentRunner`, so they share identical failure handling by construction
rather than by hand-kept-in-sync copies. The only structural additions are
photo-specific: client-side downscaling before upload (`api.ts`), NDJSON rather than
SSE as the stream format (`stream.ts`), and a filename-based discriminator to tell
photo captions apart from audio transcripts (`plan.ts`), since both are `kind: 'text'`
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
   service, with a 60 s timeout, and throws `EnrichmentError` (`src/enrich/error.ts`)
   for classified HTTP/decode failures, or a descriptive `Error` for malformed
   responses (treated as retryable by the shared runner's default classification).
   Returns trimmed text (possibly empty). Both APIs request a **streaming** response
   and take an optional `onPartial(text)` callback that receives the accumulated text
   as it arrives — display-only; the promise's resolved value is the only result, and
   it is identical to what the non-streaming endpoint would have returned. A stream cut
   off mid-way **rejects** (never resolves with truncated text), and if the server
   ignores `stream` the client falls back to parsing the whole body.
3. **Stream** (`stream.ts`): the pure streaming core the API builds on — incremental
   wire-format parsing (chunks may split anywhere) and partial/final text assembly,
   fully unit-tested with no I/O. Transcription parses SSE segments; captioning parses
   NDJSON deltas.
4. **Runner** (`runner.ts`): a thin binding of `src/enrich/runner.ts`'s
   `createEnrichmentRunner` onto this pipeline's `plan`, `sourceOf` (the audio/photo
   attachment), `targetOf` (entry + stream), `callApi`, and `liveStore`
   (`liveTranscripts` / `liveCaptions` in `src/store/livetext.ts`, keyed by source
   file — rendered by `src/capture/AttachmentBody.tsx`). All drain mechanics live in
   the shared engine; see its own doc section below for the full failure-handling
   behavior (identical for both pipelines by construction, not by hand-kept-in-sync
   copies — issue #51).

Relations to other modules:

- **enrich** (`src/enrich/runner.ts`, `error.ts`, `config.ts`): the shared drain engine
  both runners bind onto, and the failure taxonomy + endpoint config both api.ts files
  use.
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

### src/enrich/error.ts

The failure taxonomy shared by both pipelines (issues #55/#60/#62).

Exports:

- `class EnrichmentError extends Error { retryable: boolean; hostDown: boolean }` — an
  error an `api.ts` client throws with a known classification, mirroring `DriveError`
  (`src/drive/client.ts`).
- `isRetryableStatus(status: number): boolean` — 408, 429, and every 5xx are
  transient (the same request may succeed later); every other 4xx is a permanent
  rejection of this exact request (bad codec, oversized body, malformed request) that
  fails identically on every retry.
- `classifyFailure(err: unknown): { retryable: boolean; hostDown: boolean }` — reads
  the flags straight off an `EnrichmentError`; classifies a `fetch()`-level network
  failure (`TypeError`) or an `AbortSignal.timeout()` firing (`DOMException` named
  `AbortError`/`TimeoutError`) as retryable **and** host-down; defaults any other
  thrown value to retryable-not-host-down — the runners' original blanket behavior, so
  this taxonomy only ever adds permanent/circuit-breaker handling, never removes
  existing backoff coverage.
- `describeFailure(err: unknown): string` — an error's message, or `String(err)` for a
  non-`Error` throw; used as the skip marker's persisted reason.

### src/enrich/config.ts

The enrichment endpoint/model configuration — the fork/self-host seam (issue #62).
Exports `TRANSCRIBE_BASE_URL`, `TRANSCRIBE_MODEL`, `VISION_CHAT_URL`, `VISION_MODEL` as
plain constants. A fork or self-hoster edits this one file (instead of two `api.ts`
files) to point at a different Whisper/Ollama-compatible host, and must pair the edit
with `index.html`'s CSP `connect-src` (AGENTS.md's "any new external network endpoint"
rule).

### src/enrich/runner.ts

The shared drain engine. Exports `createEnrichmentRunner<T>(config)`, returning an
`EnrichmentRunner` with `drain`, `shouldDrain`, `listSkipped`, and `retry`.

`EnrichmentRunnerConfig<T>`:

- `skipPrefix: string` — this pipeline's skip-marker key prefix (`'transcribe:skip:'`
  / `'caption:skip:'`).
- `plan: (events) => T[]` — the pipeline's pure plan function.
- `sourceOf: (item: T) => Attachment` — the source audio/photo attachment.
- `targetOf: (item: T) => { entryId: string; stream: string }` — the amend target.
- `callApi: (blob, item, onPartial) => Promise<string>` — calls the pipeline's `api.ts`
  function (closing over any pipeline-specific argument, e.g. transcribe's mime type).
- `liveStore: LiveTextStore` — `liveTranscripts` / `liveCaptions`.

Per-drain behavior (`drain(streamId)`, one drain over `streamId`; re-entrant calls
coalesce onto the in-flight promise via a closed-over `draining` variable, same as the
pre-extraction runners):

1. Offline (`!navigator.onLine`) → return `0` immediately, no IndexedDB touched.
2. Read `AppSettings.enrichmentEnabled`; return `0` if off (`shouldDrain`, the pure
   `online && enrichmentEnabled` gate, is exported for direct unit testing).
3. `plan(events)`, then sweep `liveStore` down to the currently-pending files.
4. Per-drain **circuit breaker** (issue #62): a `hostDown` flag local to this call. Once
   any item's failure classifies as `hostDown` (a stalled/unreachable host, not a
   same-request HTTP rejection), the loop `break`s — the rest of this drain's items
   share that host and would fail identically after their own 60 s timeout, so they're
   left untouched for a later drain instead. The failing item's own per-file backoff
   still applies.
5. Per item: skip if backing off (`eligible`) or already skip-marked
   (`skipRecord(file) !== undefined`, honoring both the current `{ reason, at }` shape
   and a legacy bare `true` marker as `{ reason: 'unknown', at: '' }`).
6. **Missing source blob → deferred, not skipped** (issue #55): a blob pruned locally
   after upload (`keepAudioLocally=false`, `src/drive/queue.ts`'s `pruneAudio`) is
   indistinguishable from one never downloaded, and the correct behavior for both is
   "retry once a blob is local" — not "never process this on this device". No network
   call is made while deferred, so this costs one IndexedDB read per drain, nothing
   else.
7. Calls `callApi`, publishing partials to `liveStore.set(file, partial)`.
8. Empty result (`''`) → clear live text, `markSkipped(file, 'empty-result')` — a valid,
   non-retryable outcome, not a failure.
9. **Post-API re-plan guard** (the fix for issue #51's divergence): re-run `plan`
   against a fresh `listEvents(streamId)` and drop the result (clearing live text,
   clearing backoff state) if the source no longer needs one — a sync pull may have
   imported another device's result while the API call was in flight (at-most-once
   enrichment globally). Previously only the transcribe runner had this; both now get
   it from the shared engine, so this exact class of bug (duplicate captions from a
   cross-device pull race) can't reappear in one pipeline without the other.
10. Otherwise `appendAmend({ stream, targets: [entryId], attachments: [{ kind: 'text',
    blob, mimeType: 'text/plain', derivedFrom: file }] })`; live text is left in place
    until the next drain's sweep.
11. On a thrown error: `classifyFailure(err)`. Not retryable → `markSkipped(file,
    describeFailure(err))` (a `{ reason, at }` record in the `meta` store under
    `<skipPrefix><file>`) — never retried again, across sessions. Retryable →
    `recordFailure(file)` (in-memory exponential backoff, 15 s base, max 5
    attempts/session, resets on relaunch — unchanged from before the extraction); if
    also `hostDown`, trips the circuit breaker for the rest of this drain.

Diagnostics (issue #55, surfaced by `src/settings/SettingsScreen.tsx`'s
`EnrichmentStatusLine` — see
[app-shell-ui-and-tooling.md](app-shell-ui-and-tooling.md)):

- `listSkipped(): Promise<{ file: string; reason: string; at: string }[]>` — every
  file this runner instance has permanently skipped, scanned from the `meta` store by
  key prefix.
- `retry(file: string): Promise<void>` — deletes the skip marker and clears in-memory
  backoff for `file`, so the very next `drain()` reattempts it.

### src/enrich/error.test.ts

Covers `isRetryableStatus` (408/429/5xx retryable, other 4xx permanent) and
`classifyFailure` (reads flags off an `EnrichmentError`; a `TypeError` and an
`AbortError`/`TimeoutError` `DOMException` both classify as retryable + host-down; an
unrecognized `Error`, string, or `undefined` defaults to retryable, not host-down) and
`describeFailure` (an `Error`'s message; `String(err)` otherwise).

### src/enrich/runner.test.ts

Exercises `createEnrichmentRunner` directly (using `transcribe/plan.ts`'s
`pendingTranscriptions` as a stand-in generic plan, with a stubbed `callApi` in place
of a real `api.ts` client) for the behavior that must be identical across pipelines and
is pinned once here rather than duplicated per pipeline: permanent `EnrichmentError` →
immediate skip with the error's message as the reason, never retried again; retryable
`EnrichmentError` and untyped `Error` → backoff, not skipped; a missing source blob →
deferred (no API call, no skip marker) and picked back up the moment a blob reappears,
with no backoff incurred; the circuit breaker (a host-down failure on the first of two
pending items stops the second from being attempted that drain; a merely-retryable
same-request rejection does not trip it); the post-API re-plan guard (an in-flight
result is dropped when a pull imports a remote one mid-drain); `listSkipped`/`retry`
(clearing a marker re-enables the next drain, and a legacy bare-`true` marker is
honored as an unknown-reason skip); and the empty-result-is-a-skip-not-a-failure case.
Each test gets a fresh module registry and IndexedDB, since `./runner` and `./error`
close over IndexedDB access and a module-instance identity (`instanceof
EnrichmentError`) respectively that must be freshly (re-)imported after
`vi.resetModules()`, not statically imported at file scope.

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
`TRANSCRIBE_BASE_URL`, `src/enrich/config.ts`).

Exports:

- `transcribeAudio(blob: Blob, mimeType: string, onPartial?: (text: string) => void):
  Promise<string>` — returns the transcript text, trimmed; may be empty for silent
  clips. While the response streams, `onPartial` receives the transcript-so-far after
  each segment (display-only).

Behavior:

- POSTs a multipart form to `/v1/audio/transcriptions` with fields: `model`
  (`TRANSCRIBE_MODEL`, `Systran/faster-whisper-base.en`), `response_format: 'text'`,
  `stream: 'true'`, `vad_filter: 'true'` (server-side trimming of leading/trailing
  silence — base.en hallucinates on it), and `file`.
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
  `EnrichmentError('transcription failed: HTTP <status>', { retryable:
  isRetryableStatus(status) })` on non-OK responses (issue #60 — a 4xx like 413/415 is
  a permanent rejection of this exact clip, not retried forever) and
  `EnrichmentError('transcription failed: truncated stream', { retryable: true })` when
  the body ends mid-event — a cut connection is a transient failure, never a silently
  truncated transcript.

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

Background transcription drain — a thin binding of `src/enrich/runner.ts`'s
`createEnrichmentRunner` onto this pipeline (see that section for the full
failure-handling behavior, which is now defined once and shared with `src/vision`).

```ts
const runner = createEnrichmentRunner<PendingTranscription>({
  skipPrefix: 'transcribe:skip:',
  plan: pendingTranscriptions,
  sourceOf: (item) => item.audio,
  targetOf: (item) => ({ entryId: item.entryId, stream: item.stream }),
  callApi: (blob, item, onPartial) => transcribeAudio(blob, item.audio.mimeType, onPartial),
  liveStore: liveTranscripts,
})
```

Exports (all bound directly from `runner`):

- `drainTranscriptions(streamId: string): Promise<number>` — transcribes every eligible
  pending audio attachment; returns how many amend events were appended. Re-entrant
  calls coalesce onto the single in-flight drain promise.
- `shouldDrain(online: boolean, enrichmentEnabled: boolean): boolean` — pure drain-gate
  predicate (`online && enrichmentEnabled`), unit-tested without any I/O.
- `listSkippedTranscriptions(): Promise<{ file, reason, at }[]>` — permanently
  skip-marked audio files, for Settings diagnostics (issue #55).
- `retryTranscription(file: string): Promise<void>` — clears an audio file's skip
  marker and in-session backoff so the next drain retries it.

Automatic transcription is fully opt-in (owner policy, issue #89):
`AppSettings.enrichmentEnabled` defaults to `false`, and no audio reaches
`transcribe.elimelt.com` until the user turns it on in Settings — enforced by the
shared runner's own gate (independent of the `src/App.tsx` call-site check), which is
also what makes the opt-in **backfill** work: `pendingTranscriptions` already scans the
full event history, so audio captured while enrichment was off is picked up by the
very next drain once the user turns it on, with no special-casing.

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
mid-event, the plain-text fallback when the server does not stream, and the
`EnrichmentError` thrown on non-OK HTTP.

### src/transcribe/stream.test.ts

Covers `feedSse` (single/multiple events per chunk, events split across chunks,
one-leading-space stripping that preserves the segment's own space, multi-line data
joins, bare `data` lines, ignored comments/fields, CRLF including a CR split across
chunks) and `assembleTranscript` (raw-concatenation + trim equal to the server's
non-streaming join, interior whitespace preserved verbatim, empty cases, and
partial-prefix/final agreement).

### src/transcribe/runner.test.ts

Exercises `drainTranscriptions` (this pipeline's binding onto the shared engine)
against fake IndexedDB with a mocked API: the amend shape (`targets`, `derivedFrom`,
stored blob content), idempotent second drains, a permanent skip marker with a
recorded reason for an empty transcript (plus `listSkippedTranscriptions()` returning
it, and honoring a legacy bare-`true` marker from an older app version), deferring
(not skipping) audio whose blob is missing and picking it up the moment a blob
reappears (issue #55), backoff after failures, the offline no-op, the two pull-race
cases (audio whose transcript arrived via a pulled amend is never sent to the API; an
in-flight result is dropped when a pull imports a remote transcript mid-drain), and
coalescing of overlapping drains onto one promise. A separate `shouldDrain` describe
block pins the pure gate predicate directly; a `drainTranscriptions — enrichment
opt-in gate` describe block pins the runner-level early-return itself: no API call
while `enrichmentEnabled` is off (the default), the backlog backfilling once it is
turned on (`pendingTranscriptions` needs no special-casing since it already scans full
history), and the gate holding even across repeated calls with no call-site check at
all. The streaming tests cover the live-text lifecycle: partials published to
`liveTranscripts` mid-flight, the final text lingering until the next drain's sweep,
clearing on mid-stream failure (with nothing persisted) and on the mid-drain pull race.
Resets the module registry per test because the runner (via `src/enrich/runner.ts`)
keeps module-level state. Failure classification, the circuit breaker, and the
missing-blob defer's mechanics are pinned once for both pipelines in
`src/enrich/runner.test.ts`; this file covers this pipeline's wiring onto them.

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

Client for photo captioning: `VISION_MODEL` (`gemma4:e4b`) on the LLM host via its
native (Ollama-style) `/api/chat` endpoint at `VISION_CHAT_URL` (`src/enrich/config.ts`,
`https://llm.elimelt.com/api/chat`) — the native API (not the OpenAI-compat `/v1`) is
used because only it honors `think: false`, which turns a ~20 s reasoning detour into
a ~2–3 s caption. CORS is origin-gated; no API key.

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
  `finally`. `createImageBitmap` throwing (a format this browser can't decode, e.g. a
  HEIC picked from the library on a non-Safari browser — the photo input accepts
  `image/*`) is wrapped as `EnrichmentError('caption failed: image decode (…)', {
  retryable: false })` — that photo will never decode on this device, on any retry
  (issue #55/#60). A missing 2d context or a failed JPEG encode are likewise thrown as
  non-retryable `EnrichmentError`s.
- POSTs JSON `{ model, think: false, stream: true, messages: [{ role: 'user', content:
  PROMPT, images: [base64] }] }` with a fixed captioning prompt; 60 s timeout (covers
  the whole stream). The endpoint answers with NDJSON content deltas, decoded through
  `stream.ts`; the client calls `onPartial(assembleCaption(deltas))` as deltas land and
  resolves once the terminal `done: true` line arrives. If the response is plain
  `application/json` (server ignored `stream`), it falls back to the old single-body
  parse.
- Throws `EnrichmentError('caption failed: HTTP <status>', { retryable:
  isRetryableStatus(status) })` on non-OK responses (issue #60), and untyped `Error`s
  for `caption failed: truncated stream` (body ends without the `done` line) and the
  `stream.ts` parse errors (`malformed stream chunk`, `no content in response`, a
  server-reported `error` field) on broken streams — these default to the shared
  runner's retryable classification, same as before: a cut connection is a transient
  failure, never a silently truncated caption.

Note: unlike `transcribe/api.ts`, `vision/api.ts` has no test file (its canvas/bitmap
path is browser-only, so the HTTP-status classification added for issue #60 is
exercised indirectly via `src/enrich/error.test.ts`'s coverage of
`isRetryableStatus`/`classifyFailure` plus code-level symmetry with
`transcribe/api.ts`, which does have a test); its pure streaming logic is tested via
`stream.test.ts`.

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

Background captioning drain — a thin binding of `src/enrich/runner.ts`'s
`createEnrichmentRunner` onto this pipeline, exactly like `transcribe/runner.ts`:

```ts
const runner = createEnrichmentRunner<PendingCaption>({
  skipPrefix: 'caption:skip:',
  plan: pendingCaptions,
  sourceOf: (item) => item.photo,
  targetOf: (item) => ({ entryId: item.entryId, stream: item.stream }),
  callApi: (blob, _item, onPartial) => captionPhoto(blob, onPartial),
  liveStore: liveCaptions,
})
```

Exports (all bound directly from `runner`):

- `drainCaptions(streamId: string): Promise<number>` — captions every eligible pending
  photo attachment; returns how many amend events were appended; re-entrant calls
  coalesce onto the in-flight drain.
- `shouldDrain(online: boolean, enrichmentEnabled: boolean): boolean` — same pure
  drain-gate predicate as the transcribe runner.
- `listSkippedCaptions(): Promise<{ file, reason, at }[]>` / `retryCaption(file:
  string): Promise<void>` — the same diagnostics/recovery pair as the transcribe
  runner, for photo files.

Differences from the transcribe runner's binding are limited to: skip-marker prefix
`caption:skip:<file>`, `pendingCaptions` as the plan, `captionPhoto(blob, onPartial)`
(no mime type argument) as the API, and `liveCaptions` as the live-text store. Because
both runners bind onto the same `createEnrichmentRunner`, every other behavior —
backoff, failure classification, the circuit breaker, the missing-blob defer, and
critically the **post-API re-plan guard** (drop an in-flight result if a pull imported
another device's one mid-flight) — is now defined exactly once and applies to both
identically. Before this extraction (issue #51), the vision runner was a hand-copied
duplicate of the transcribe runner that had already drifted: it was missing that
re-plan guard, which could produce duplicate captions on a photo synced from two
devices. Binding both runners onto one factory makes that class of divergence
structurally impossible to reintroduce.

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
blob, idempotent re-drains, a permanent skip marker with a recorded reason for an
empty caption, deferring (not skipping) photos whose blob is missing and picking them
up once a blob reappears (issue #55), failure backoff, offline no-op, drain
coalescing, and — added alongside this pipeline's binding onto the shared engine
(issue #51) — the same two pull-race cases the transcribe suite already had (a photo
whose caption arrived via a pulled amend is never sent to the API; an in-flight
caption is dropped when a pull imports a remote one mid-drain), plus a live-text
clear-on-pull-race test. Fresh module registry and IndexedDB per test. The streaming
tests cover the `liveCaptions` lifecycle: partials published mid-flight, final text
lingering until the next drain's sweep, and clearing on mid-stream failure with
nothing persisted. Mirrors the transcribe runner's gate coverage too: `shouldDrain`
pinned directly, plus a `drainCaptions — enrichment opt-in gate` block covering
no-API-call while off, backfill of photos captured while off once turned on, and the
runner-level gate holding with no call-site check at all.

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
  IndexedDB `geocache` store first (a hit within its TTL short-circuits, no network
  call); on a miss, joins an in-flight lookup for the same cell if one is already
  running, else fetches `…/reverse?format=jsonv2&zoom=18&addressdetails=1&lat=…&lon=…`
  and caches the result (positive or negative) with a `cachedAt` local-ISO timestamp.
  Returns `undefined` on any failure (offline, non-OK response, cache errors, or a
  response with no usable address).

Identification: browsers treat `Referer` and `User-Agent` as forbidden request headers,
so script cannot attach a custom app identity to the fetch (an earlier version tried a
`Referer: capture-pwa` header — a silent no-op, browsers strip and override it). The
module instead relies on the browser's own default referrer policy
(`strict-origin-when-cross-origin`), which already sends this app's origin as the
`Referer` on the cross-origin request — satisfying what Nominatim's usage policy means
by "a valid HTTP Referer identifying the application" for browser-based clients.

Nominatim's usage policy requires caching and ≤ 1 req/sec, so all network calls are
serialized behind a module-level promise chain (`throttle`) enforcing an 1100 ms minimum
interval app-wide; the chain swallows individual failures so it can never wedge. Cache
reads and writes are individually try/caught and non-fatal. Cache entries expire: a
found address (`GeocacheRow.address` set) is good for 90 days (matching the workbox
`osm-tiles`-adjacent cache TTL in `vite.config.ts`); a cell with no resolvable address
(`address` omitted — a negative result) is retried after 24 hours rather than cached
forever, since coverage can improve and the miss is cheap to recheck. Concurrent
`reverseGeocode` calls for the same cell (e.g. two captures at the same spot) share one
in-flight request via a `Map<cellKey, Promise>` instead of both missing the cache and
each entering the throttle chain independently.

Callers: `src/settings/SettingsScreen.tsx` (saving a place fills its `address`) and
`src/capture/LocationSheet.tsx`. Covered by `src/places/geocode.test.ts`: `shortAddress`
compression rules, cache hit/miss with TTL expiry (positive and negative), in-flight
dedupe, the never-throws contract (network error, non-OK response), and that no
`Referer` header is ever set.

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
- **Both runners re-plan after the API call** (`src/enrich/runner.ts`, shared) and drop
  the result if a pull imported another device's transcript/caption mid-flight
  (at-most-once enrichment globally). Previously only the transcribe runner had this
  check (issue #51) — a real cross-device duplicate-caption bug; binding both runners
  onto the shared engine makes the two pipelines structurally unable to diverge on this
  again.
- **Failure classification is a taxonomy, not a blanket "assume transient"**
  (`src/enrich/error.ts`, issues #55/#60). `EnrichmentError.retryable` decides
  backoff-vs-skip; unrecognized thrown values still default to retryable, so this only
  ever adds permanent-failure and circuit-breaker handling on top of the runners'
  original behavior. A permanent HTTP 4xx (bad codec, oversized body) or a local decode
  failure (`vision/api.ts`'s `toJpegBase64`) skip-marks immediately instead of
  re-uploading the full media up to 5×, every session, forever.
- **A per-drain circuit breaker stops a stalled host from wedging a whole drain**
  (issue #62). A `hostDown` failure (network error or `AbortSignal.timeout()` firing)
  ends the current drain's loop early; the rest of that drain's items are left pending
  for a later drain rather than each serially burning its own 60 s timeout.
- **A missing source blob is deferred, not skipped** (issue #55). Pruned-after-upload
  (`keepAudioLocally=false`, `src/drive/queue.ts`) and never-downloaded are
  indistinguishable, and both are retried for free the moment a blob is local again —
  previously the former silently and permanently lost the transcript.
- **Runners keep module-level state.** Retry backoff resets on app relaunch; the
  in-flight `draining` promise means concurrent calls share one result — and a call with
  a different `streamId` during an in-flight drain returns the existing drain's promise.
  Tests must `vi.resetModules()` to isolate this state — and since `src/enrich/runner.ts`
  and `src/enrich/error.ts` are where that state (and the `EnrichmentError` class
  identity `instanceof` checks rely on) actually lives, any test that constructs
  `EnrichmentError`s or calls `createEnrichmentRunner` directly must dynamically
  `import()` both *after* `vi.resetModules()` rather than importing them statically at
  file scope (see `src/enrich/runner.test.ts`).
- **Skip markers are permanent and local, and now carry a reason.** `transcribe:skip:*`
  / `caption:skip:*` keys in the `meta` store hold a `{ reason, at }` record (a legacy
  bare `true` from an older app version is still honored, surfaced as reason
  `'unknown'`) and are never cleared by the app on its own — only an explicit
  `retry(file)` call (from Settings' "Retry" button, issue #55) clears one. Empty
  results are treated as permanently unprocessable; missing blobs are not (see above).
- **Empty API results are valid.** `transcribeAudio`/`captionPhoto` return `''` rather
  than throwing; the runners convert that into a permanent skip (reason
  `'empty-result'`), not a retry.
- **Enrichment endpoints are one-file config, not scattered constants** (issue #62).
  `src/enrich/config.ts` is the only place `TRANSCRIBE_BASE_URL` / `TRANSCRIBE_MODEL` /
  `VISION_CHAT_URL` / `VISION_MODEL` are defined; a fork/self-hoster edits this file and
  `index.html`'s CSP, not either pipeline's `api.ts`.
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
