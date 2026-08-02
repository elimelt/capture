# Subsystem: AI & enrichment

How Timebox layers machine understanding on top of the append-only capture log without
ever compromising the offline-first capture path. Four features share this subsystem:

- **Audio transcription** (`src/transcribe`) — Whisper transcripts for captured audio.
- **Photo captioning** (`src/vision`) — vision-LLM captions for captured photos.
- **Place matching & reverse geocoding** (`src/places`) — coordinates → labels/addresses.
- **Chat assistant** (`src/assistant`) — an opt-in, client-side agent over the local log.

File-level detail lives in the module docs:
[Media pipelines & places](../modules/pipelines-and-places.md) and
[Assistant](../modules/assistant.md). This document covers the cross-module design.

## Design stance

Capture is instant, offline, and dumb: SPEC §1.2 declares "no transcription, parsing, or
AI in the app" *at capture time*, and heavyweight interpretation (calendar writing,
day summarization) belongs to the external processing skill that reads Drive. The
enrichment subsystem sits between those poles: lightweight, best-effort machine
understanding that runs **after** capture, **on-device-initiated**, and writes back into
the same event log as any user edit would. Every feature here degrades to a no-op — the
app is fully functional with all of it offline or failing.

## The plan / runner / api pipeline pattern

Both media pipelines (`src/transcribe`, `src/vision`) are the same three-part machine:

| Part | Nature | Job |
|---|---|---|
| `plan.ts` | pure, no I/O | `(events) => Pending…[]` — what still needs processing |
| `api.ts` | one async fn | call one external service; 60 s timeout; throw on bad HTTP |
| `runner.ts` | impure drain | plan → fetch blob → API → `appendAmend`; backoff & skips |

The split keeps the decision "what needs work" testable as a pure function over the
event log, isolates each external service behind a single function, and confines all
state (retry maps, in-flight coalescing, skip markers) to the runner.

### Why planning is history-aware

`derivedFrom` on an attachment is the **machine/user boundary**: a text attachment with
`derivedFrom` set is machine output (transcript or caption); without it, it is
user-typed. This one field drives the whole subsystem.

Planning deliberately reads the **raw event history**, not just the folded view. The
first pass builds an "ever derived" set: every source filename from which *any* text
attachment was *ever* derived — including derived text the user later edited or removed.
The second pass scans folded (currently visible) entries for source attachments not in
that set. Consequences:

- **Never reprocess after a user edit.** Editing a transcript keeps its `derivedFrom`
  link (SPEC §3.3), and deleting one leaves the derivation in history — either way the
  source audio is permanently "done". A user's correction or deletion is never
  clobbered by a regenerated machine transcript.
- Revoked entries and removed attachments are never pending (the fold drops them).

The two pipelines share one output shape — a text attachment with `derivedFrom` — so
`vision/plan.ts` adds a filename discriminator (`derivedFrom` matching `_photo…`) to
tell captions from transcripts. This leans on the machine-generated filename scheme in
`src/contract/filenames.ts`; changing that scheme would silently break caption detection.

## Outputs are ordinary events; sync is free

A runner's only write is `appendAmend` targeting the owning entry, adding the derived
text attachment. From that point the pipeline is out of the picture: the amend is an
ordinary event in the append-only log, folded into the entry like any user edit, and
picked up by the normal Drive upload queue (`src/drive/queue.ts`). There is zero
pipeline-specific sync code, and the external processing skill reading Drive sees
machine transcripts exactly as it sees user notes — modulo `derivedFrom`.

## Drain triggers, backoff, and skip markers

Runners are drained from a single `src/App.tsx` effect that fires **whenever the folded
entries change** (initial load, capture, foreground refresh, sync pull). Both drains run
in parallel; if either appended amends, the app refreshes the store, which re-runs the
effect — the second pass finds nothing pending, a natural fixpoint. Returning to the
foreground triggers a store refresh, so reopening the PWA indirectly re-drains the
pipelines too (Drive sync itself is manual-only — "Sync now" in Settings).

Failure handling is identical in both runners:

- **Offline** (`!navigator.onLine`): the drain returns 0 immediately; nothing is
  marked failed. Work simply waits for the next trigger.
- **Transient failure** (API throws): in-memory per-file exponential backoff, 15 s base,
  max 5 attempts per session; the map resets on app relaunch.
- **Permanent failure** (source blob missing locally, or the service returned empty
  text): a skip marker (`transcribe:skip:<file>` / `caption:skip:<file>`) is written to
  the IndexedDB `meta` store — never retried, across sessions. Empty results are valid
  API outcomes (silent clip, uncaptionable image), not errors.
- **Coalescing**: re-entrant drain calls share the single in-flight promise.

One cross-device guard is transcription-specific: after the API call resolves, the
transcribe runner **re-plans against the current log** and drops the result if that
audio no longer needs a transcript — a sync pull may have imported another device's
transcript while the call was in flight. This keeps transcription at-most-once
globally, not just per device.

## Place matching & reverse geocoding

Two independent, non-LLM enrichments in `src/places`:

- **Matching** (`match.ts`) is pure and synchronous: at capture time,
  `src/capture/geo.ts` snapshots the position and stamps `placeLabel` by
  point-in-radius matching against the user's saved places (nearest wins on overlap).
  This happens inline because it costs nothing and needs no network.
- **Reverse geocoding** (`geocode.ts`) is asynchronous and best-effort: Nominatim turns
  coordinates into a short "near …" address when the user saves a place in Settings or
  edits an entry's location. It **never throws** — any failure yields `undefined` and
  callers treat the address as optional. Per Nominatim policy, results are cached in
  the IndexedDB `geocache` store keyed by a ~11 m rounded coordinate cell, and all
  network calls serialize behind an app-wide ≥1.1 s throttle chain.

## The chat assistant

The assistant (`src/assistant`) is the interactive face of the subsystem: an opt-in
chat over the user's own log, gated by `AppSettings.assistantEnabled` and lazy-loaded
so non-users never download the bundle.

- **Client-side agent loop.** There is no backend: the AI SDK's `ToolLoopAgent` runs
  in-process in the browser (`DirectChatTransport`), streaming UI chunks from an
  OpenAI-compatible endpoint. Tool calls execute locally between model turns.
- **Tools over the local log, and they are read-only.** Verified in
  `src/assistant/tools.ts`: the three tools (`list_entries`, `search_entries`,
  `get_places`) only call injected getters over the zustand store plus `getBlob` for
  text attachments; there are no `appendAmend`/store writes anywhere in the module. The
  assistant answers questions; it never modifies the log. Rather than embedding the log
  in the prompt, the agent pulls just what a question needs, rendered as a plain-text
  digest (revoked entries always excluded, output capped with explicit truncation notes).
- **Prefix-cache-aware context.** The system prompt (`context.ts`) truncates "current
  time" to the hour so the prompt is byte-identical across turns within an hour,
  keeping the server's KV/prefix cache warm; wall-clock dates come from string-slicing
  `capturedAt`, never `Date` round-trips.
- **History persistence.** Conversations persist to the IndexedDB `chats` store on
  settled turns (not per-delta), surviving iOS killing the PWA; a history sheet lists,
  searches (pure in-memory filter), and deletes past conversations. Settings → wipe
  clears them with everything else. Nothing is stored server-side.

## External services & privacy posture

| Service | Endpoint / model | What leaves the device |
|---|---|---|
| Transcription | `transcribe.elimelt.com` `/v1/audio/transcriptions`, `Systran/faster-whisper-base.en` | the audio blob |
| Captioning | `llm.elimelt.com/api/chat` (native Ollama API), `gemma4:e4b`, `think: false` | a downscaled (≤1024 px, ~100 KB) JPEG |
| Assistant | `llm.elimelt.com/v1` (OpenAI-compatible), default `gpt-oss:20b` | chat messages + tool-result text digests (text, place labels, media counts — never raw audio/photos) |
| Geocoding | `nominatim.openstreetmap.org/reverse` | rounded coordinates |

None of these require an API key: the LLM/transcription hosts are CORS origin-gated,
and Nominatim is public (identified via a `Referer`). There is no Timebox server;
beyond these calls, data goes only to the user's own Google Drive (SPEC §9.3). The
assistant makes no request at all until the user sends a message; transcription and
captioning run automatically once entries exist, but only send the specific attachment
being processed. All results land back in local IndexedDB (log events, geocache, chats).
