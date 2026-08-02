# Modules: `src/contract` and `src/streams`

## Module overview

### `src/contract`

Implements the **Drive file contract** — the stream-agnostic `capture.event.v1` event
log (SPEC §3.3, §5). This is the shared language between the capture app and the
external chat-assistant skills that consume the log from Google Drive. It defines:

- the event/entry **types** (`types.ts`),
- the **canonical wire format** for event records (`serialize.ts`), for batched
  NDJSON log segments (`segments.ts` — SPEC §5.7), and for the non-event contract
  files `streams.json` / `config.json` / `checkpoint.json` (`files.ts`),
- the **log filename scheme** — per-event records, attachments, and segment
  ranges — and date partitioning (`filenames.ts`),
- the **fold** that turns the append-only event log into user-visible entries
  (`fold.ts`),
- small helpers for event **ids** (`ids.ts`) and local-offset ISO **timestamps**
  (`time.ts`).

The contract is deliberately domain-free: no timelog-specific fields exist here. The
log is append-only; edits and deletions are expressed as later `amend`/`revoke`
events, never as mutation of earlier files.

### `src/streams`

Defines **streams** (SPEC §3.1): named capture profiles that parameterize the rest of
the app (storage, upload queue, capture UI). v1 hardcodes a single built-in stream,
`timelog` (audio-first, 60-second max clip). Adding a stream is intended to be a
registry entry plus a skill prompt — no engine changes. The registry also names the
**system streams** (`settings`, `assistant-chats`) — event logs with no capture UI
and no `StreamDefinition` — and exposes `allSyncStreams()`, the full stream list one
sync cycle covers.

---

## File-by-file

### src/contract/types.ts

Type definitions for the serialized `capture.event.v1` contract, plus the derived
`Entry` view. No runtime logic except the schema constant.

Key exports:

- `EVENT_SCHEMA = 'capture.event.v1'` — schema tag on every event record.
- `GeoLocation` — `{ lat, lng, accuracyM, placeLabel?, address? }`; `address` is a
  lazily-filled, best-effort reverse geocode.
- `AttachmentKind = 'audio' | 'text' | 'photo'`.
- `Attachment` — `{ kind, file, mimeType, durationSec?, derivedFrom? }`. `file` is a
  filename within the entry's log partition (see `filenames.ts`); `derivedFrom` names
  a sibling attachment this one was machine-derived from (e.g. a transcript's source
  audio) — absent means user-created content.
- `CaptureEvent` — `type: 'capture'` plus `capturedAt` (domain time), optional
  `location`, and `attachments: Attachment[]` (required, may be empty).
- `AmendPatch` — `{ capturedAt?, location?, clearLocation?, removeAttachments? }`.
  `clearLocation` is an append-only location removal, distinct from an absent
  `location` (which means "no change"), and is ignored if `location` is also present.
  `removeAttachments` lists attachment files the fold hides (files stay in the log).
- `AmendEvent` — `type: 'amend'`, `targets: string[]` (capture ids), optional `patch`
  and optional additional `attachments`.
- `RevokeEvent` — `type: 'revoke'`, `targets: string[]`.
- `LogEvent = CaptureEvent | AmendEvent | RevokeEvent`.
- `Entry` — the folded, user-visible view of a capture after later amends/revokes:
  `{ id, seq, stream, loggedAt, capturedAt, deviceTz, location?, attachments,
  lastEventSeq, revoked }`. Never serialized; derived state only.

All events share the (non-exported) `EventBase` envelope: `schema`, `id` (short,
crypto-random — **the identity**), `seq` (per-stream sequence assigned at append; an
ordering *hint* only, not unique across devices — two devices appending offline can
mint the same seq, see SPEC §3.2 #3), `stream`, `loggedAt` (ISO-8601 with local
offset; the partition key), `deviceTz` (IANA zone).

Relations: everything else in the module is built on these types; `src/streams`
imports `AttachmentKind`.

### src/contract/ids.ts

Single export:

- `newEventId(): string` — 6-character base36 id from `crypto.getRandomValues`
  (each random byte reduced `b % 36`). "Unique enough per stream"; there is no
  collision check.

Used to populate `LogEvent.id`; ids appear in filenames via `eventBaseName`.

### src/contract/time.ts

Local-time ISO-8601 helpers. All contract timestamps carry the local offset (never
bare UTC, except where a `Z` input is tolerated).

Key exports:

- `toLocalIso(date: Date): string` — formats in the device's local zone with offset,
  e.g. `"2026-08-02T09:04:11-04:00"`. Second precision (no milliseconds).
- `localDateOf(iso: string): string` — `"YYYY-MM-DD"` prefix of a local-offset ISO
  string (a pure `slice(0, 10)`; assumes the canonical shape).
- `localTimeOf(iso: string): string` — wall-clock `"HH:mm"` of the instant in the
  **device's current zone** (feeds the entry card's inline `<input type="time">`).
- `civilTimeOf(iso: string): string` — wall-clock `"HH:mm"` as **written in the
  string** (a pure `slice(11, 16)`, the counterpart of `localDateOf`). Paired with
  `localDateOf` it describes one consistent civil instant in the entry's own zone;
  the edit-sheet draft uses this pair so a cross-timezone entry never shows the
  string's date with the device zone's time.
- `addMinutesIso(iso: string, minutes: number): string` — shifts the instant and
  re-renders in the **original string's offset** (not the device zone). `Z`-suffixed
  or offset-less input renders back as `...Z`. Note: the offset is read at fixed
  index 19, so it assumes second-precision input.
- `withTimeOfDayIso(iso: string, time: string): string` — sets wall-clock `"HH:mm"`
  (seconds zeroed), keeping the date, but re-renders in the **device's current zone**
  via `toLocalIso` (unlike `addMinutesIso`).
- `zonedIso(date: string, time: string, tz: string): string` — renders a civil wall
  time (`"YYYY-MM-DD"` + `"HH:mm"`, seconds zeroed) in an **explicit IANA zone**,
  resolving that zone's offset at that moment via `Intl.DateTimeFormat` (DST-safe;
  wall times skipped/repeated by a transition resolve deterministically). The Edit
  sheet recomposes `capturedAt` with the entry's own `deviceTz`, so edits preserve
  the entry's zone instead of silently re-rendering into the device's.
- `deviceTz(): string` — IANA zone from `Intl.DateTimeFormat`.

Relations: `filenames.ts` uses `localDateOf` for partitions; event producers use
`toLocalIso`/`deviceTz` for `loggedAt`/`capturedAt`/`deviceTz`.

### src/contract/filenames.ts

The log filename scheme (SPEC §5.1, §5.7). Per-event names are
`<seq6>_<filenameSafeTimestamp>_<id>[suffix][.ext]`, e.g.
`000041_2026-08-02T09-04-11-0400_a1b2c3.json`; batched segments (SPEC §5.7) lead
with their seq *range* instead:
`000044-000046_2026-08-02T18-02-33-0400_f1a2b3.ndjson`. The scheme guarantees
that a name-sorted listing equals log order — ASCII `-` sorts before digits and
`_`, so a segment sits at its min-seq position — and that `seq` is recoverable
from the listing alone.

Key exports:

- `padSeq(seq: number): string` — left-pads to 6 digits.
- `tsForFilename(iso: string): string` — makes a local-offset ISO string
  filename-safe: `:` → `-`, and the trailing `±HH-MM` offset collapses to `±HHMM`
  (`"2026-08-02T09:04:11-04:00"` → `"2026-08-02T09-04-11-0400"`).
- `eventBaseName(e: Pick<LogEvent, 'seq' | 'loggedAt' | 'id'>): string` —
  `"<padSeq>_<ts>_<id>"`.
- `eventRecordName(e): string` — `eventBaseName(e) + '.json'` (the event record).
- `attachmentFileName(base, kind, mimeType, index = 0): string` — appends a per-kind
  suffix (`audio` → none, `text` → `_note`, `photo` → `_photo`), a dedupe number for
  `index > 0` (0-based index 1 renders as `2`, e.g. `_photo2`), and an extension
  mapped from the mime type (`audio/mp4`→`m4a`, `audio/webm`→`webm`,
  `audio/mpeg`→`mp3`, `text/plain`→`txt`, `image/jpeg`→`jpg`, `image/png`→`png`,
  `image/heic`→`heic`, `application/json`→`json` — for system-stream JSON payload
  attachments, which stay legible in Drive and, thanks to the `_note` suffix, never
  collide with event-record names; unknown → `bin`). Mime parameters after `;` are
  ignored.
- `partitionOf(e: Pick<LogEvent, 'loggedAt'>): string` — the date partition folder:
  local date of `loggedAt`.
- `seqOfFilename(name: string): number` — parses the leading seq via
  `split('_')[0]`; deliberately split-based (not slice) so seq can grow past 6
  digits without a padding change.
- `idOfRecordName(name: string): string | null` — parses the event id out of a
  record filename (`000041_…_a1b2c3.json` → `"a1b2c3"`), or `null` when the name is
  not an event record (attachment, segment, foreign file, folder). This is what
  lets the pull engine (`src/drive/pull.ts`) compute the missing set from a Drive
  listing alone.
- `segmentFileName(events): string` — names a batched segment (SPEC §5.7) from its
  member events: min/max seq (scanned, so gaps are fine) plus the *first* event's
  timestamp and crypto-random id for cross-device entropy. Callers pass the batch
  in log order.
- `parseSegmentName(name: string): SegmentName | null` — parses a segment name
  back into `{ minSeq, maxSeq, firstId }`, or `null` for any non-segment name.
  `firstId` is the segment's *discovery id* (SPEC §5.8): holding the first member
  locally implies holding them all, because segments commit and import as a unit.

Relations: consumes `types.ts` and `time.ts`; `Attachment.file` values, Drive
uploads, and pull-side discovery use these names.

### src/contract/serialize.ts

Canonical wire format for event records (SPEC §5.2) — the exact bytes uploaded to
Drive. Conventions: fixed key order (envelope `schema, type, id, seq, stream,
loggedAt, deviceTz`, then type-specific fields), 2-space indent, trailing newline,
optional fields omitted entirely (never `null`).

Key exports:

- `serializeEvent(event: LogEvent): string` — deterministic, byte-stable JSON.
  Nested ordering is also fixed: location `lat, lng, accuracyM, placeLabel?,
  address?`; attachment `kind, file, mimeType, durationSec?, derivedFrom?`; patch
  `capturedAt?, location?/clearLocation?, removeAttachments?`. If a patch has both
  `location` and `clearLocation`, only `location` is written — `clearLocation` is
  dropped from the wire.
- `serializeEventLine(event: LogEvent): string` — the same JSON document as
  `serializeEvent`, compacted to a single newline-terminated line: one NDJSON
  segment line (SPEC §5.7). Key order and optional-field omission are shared with
  `serializeEvent` by construction (one `orderedEvent` builder feeds both).
- `parseEvent(json: string): LogEvent` — parses and **structurally** validates;
  throws `Error('invalid event record: …')` on: invalid JSON, non-object, wrong
  `schema`, unknown `type`, non-string `id`/`stream`/`loggedAt`/`deviceTz`,
  non-number `seq`, capture without string `capturedAt` or array `attachments`,
  amend/revoke without array `targets`. Validation is shallow (attachment/patch
  internals are not checked) and the result is cast to `LogEvent`.

Relations: inverse pair with itself (`parseEvent(serializeEvent(e))` round-trips);
`segments.ts` builds on `serializeEventLine`/`parseEvent`; `files.ts` follows the
same wire conventions for non-event files.

### src/contract/segments.ts

The NDJSON body of a batched log segment (SPEC §5.7): one compact §5.2 record per
line, every line (including the last) newline-terminated, lines in log order.
Segments batch event *records* only — attachments stay individual files.

Key exports:

- `serializeSegment(events: readonly LogEvent[]): string` — the canonical segment
  bytes; sorts into log order (`compareEvents`) and concatenates
  `serializeEventLine` outputs. Throws on an empty batch.
- `parseSegment(ndjson: string): LogEvent[]` — splits and `parseEvent`-validates
  every line, tolerating a missing final newline. **All-or-nothing** (SPEC §5.8
  #6): one malformed line throws (with its 1-based line number) so a caller can
  never silently import half a segment.

Relations: consumes `fold.ts` (`compareEvents`) and `serialize.ts`; the Drive
queue (`src/drive/queue.ts`) writes segments, the pull engine
(`src/drive/pull.ts`) reads them.

### src/contract/files.ts

Serializers for the non-event contract files (SPEC §5.1, §5.3, §5.4):
`streams.json`, `<stream>/config.json`, and the `checkpoint.json` stub. Same wire
conventions as `serialize.ts`. Important ownership rule (SPEC §5.5, §11):
`config.json` and `checkpoint.json` are mutable files **owned by the skill**; the
app writes them only as bootstrap *stubs* so `drive.file` scope can read them back,
and must never overwrite a skill's later edits — these serializers are for
create-when-absent only.

Key exports:

- Schema constants: `STREAMS_SCHEMA = 'capture.streams.v1'`,
  `STREAM_CONFIG_SCHEMA = 'capture.streamconfig.v1'`,
  `CHECKPOINT_SCHEMA = 'capture.checkpoint.v1'`.
- `StreamsRegistry` — `{ streams: string[] }`; the registry of streams the app has
  bootstrapped.
- `StreamConfig` — `{ stream, skillConfig?, userNotes? }`; `skillConfig` is a
  free-shape body owned by the stream's skill (opaque to the app), `userNotes` is
  free text the user edits for standing skill context.
- `Checkpoint` — `{ stream, consumedThroughSeq, updatedAt, consumer? }`; the
  consumer's cursor into the log. `consumer` is set by the skill on first run and
  omitted from the app stub.
- `serializeStreamsRegistry(reg)`, `serializeStreamConfig(cfg)`,
  `serializeCheckpoint(cp)` — each returns `string`; schema key first, optional
  fields omitted, 2-space indent, trailing newline.
- `checkpointStub(stream, updatedAt): Checkpoint` — `consumedThroughSeq: 0`, no
  `consumer`.
- `streamConfigStub(stream): StreamConfig` — empty `skillConfig: {}` and
  `userNotes: ''`.

### src/contract/fold.ts

The fold (SPEC §3.3): computes visible entries from the raw event log — capture
events with later amend patches applied and revoked captures dropped. Designed to be
computed identically by the app and by skill consumers. Identity is the event `id`;
`seq` is a non-unique ordering hint, so all ordering breaks ties by `loggedAt` then
`id`, keeping the fold deterministic across devices even when two devices
offline-minted the same seq (SPEC §3.2 #3, "Design C").

Key exports:

- `compareEvents(a, b: LogEvent): number` — **the** total log order: `seq` first,
  then `loggedAt`, then `id`. Also used by `src/store/events#listEvents` to re-sort
  the id-keyed store into log order.
- `FoldOptions` — `{ includeRevoked?: boolean }`; when set, revoked entries are kept
  and flagged instead of dropped.
- `fold(events: readonly LogEvent[], opts?: FoldOptions): Entry[]`.

Semantics (all verified by `fold.test.ts`):

- Events are processed in `compareEvents` order regardless of input array order (the
  input is copied and sorted; the fold is order-insensitive to arrival order).
- `capture` creates an entry (`revoked: false`, `lastEventSeq = seq`,
  attachments copied).
- `amend` applies to every id in `targets`; unknown targets and **already-revoked
  entries are skipped silently** (an amend after a revoke has no effect). Patch
  application: `capturedAt` overwrite; `location` overwrite, else `clearLocation`
  clears it (so `location` wins when both are present); `removeAttachments` filters
  by exact `file` name **before** the amend's own `attachments` are appended (an
  edit is one amend that removes the old file and adds its replacement). Each
  applied event bumps `lastEventSeq`.
- `revoke` flags every known target (`revoked: true`, bumps `lastEventSeq`);
  unknown targets are ignored.
- Result ordering: by effective `capturedAt` (post-amendment, string comparison of
  local-offset ISO), with `seq` then `id` as tiebreaks. Revoked entries are filtered
  out unless `opts.includeRevoked`.

### src/contract/filenames.test.ts

Covers the filename scheme: timestamp sanitization, seq padding and parse-back
(including seqs past 6 digits and secondary attachment names), attachment naming
per kind/mime/index, date partitioning, the invariant that lexicographic name
order equals seq order (including a segment sorting at its min-seq position among
records), `idOfRecordName` round-tripping generated record names while rejecting
attachments, segments, and foreign files, and the segment grammar:
`segmentFileName` goldens (range extremes with gaps allowed) and
`parseSegmentName` round-trip/rejection.

### src/contract/filenames.edge-cases.test.ts

Additional edge case coverage: filename sort order invariant under randomized input,
large seq numbers (7+ digits), parsing robustness for foreign files and folders,
timestamp sanitization for all timezone formats including Z suffix, and exhaustive
attachment extension mapping — including the `application/json` → `.json` mapping
and the guard that `_note.json` attachment names never parse as event records via
`idOfRecordName`.

### src/contract/files.test.ts

Covers the non-event file serializers: exact bytes for the streams registry, stub
shapes for config/checkpoint, envelope-first key order, omission of absent optional
fields, and trailing newline.

### src/contract/fold.test.ts

Covers fold semantics end-to-end with builder helpers: effective-time ordering and
seq tiebreaks, cross-device seq collisions broken by `loggedAt` then `id` (including
colliding-seq amends applying in `loggedAt` order — last writer wins), patch
application (capturedAt, location, clearLocation precedence), attachment add/remove
ordering within one amend, revoke behavior and `includeRevoked`, silent ignoring of
unknown/revoked targets, multi-target events, and insensitivity to event arrival
order.

### src/contract/fold.edge-cases.test.ts

Validates `compareEvents` total ordering properties (transitivity, antisymmetry),
fold determinism under adversarial conditions: multiple permutations of the same
event set, concurrent multi-device amends with seq collisions, and tiebreak
correctness when seq/loggedAt/id collide in various combinations. Also includes an
exhaustive-permutation invariant test (issue #70): a 5-event mixed
capture/amend/revoke log folds identically under all 120 (5!) arrival orderings —
enumerated with a small local `permutations()` helper rather than a property-testing
dependency, since N ≤ 5 needs none.

### src/contract/ids.test.ts

Checks that `newEventId` matches `/^[0-9a-z]{6}$/` and that 1000 consecutive ids
are distinct.

### src/contract/serialize.test.ts

Golden-file (byte-for-byte) serialization tests for capture/amend/revoke, including
transcript (`derivedFrom`) and note-edit (`removeAttachments` + replacement) amends;
round-trip tests through `parseEvent` including optional-field omission and the
`clearLocation`-vs-`location` wire rule; and validation-error tests for each failure
mode of `parseEvent`.

### src/contract/segments.test.ts

Covers the segment body format: a golden byte test for `serializeEventLine`, the
guarantee that a line carries the same JSON document as `serializeEvent`, log-order
concatenation with trailing newline, `parseSegment` round-trip (with and without
the final newline), the all-or-nothing failure on malformed or structurally
invalid lines (with line numbers), and empty-body rejection.

### src/contract/serialize.edge-cases.test.ts

Extended serialization tests: byte stability (deterministic output regardless of
object property insertion order), fixed key ordering verification, indentation and
trailing newline contract, exhaustive round-trip tests for all event types with
all optional fields, and comprehensive error handling validation.

### src/contract/time.test.ts

Covers the time helpers under a pinned `TZ=America/New_York`: EDT/EST formatting and
padding in `toLocalIso`, date extraction, minute arithmetic across midnight and with
`Z` input (offset preserved, instant preserved), wall-clock time setting, and
`deviceTz` returning a non-empty zone.

### src/streams/registry.ts

The stream registry (SPEC §3.1, §5.5): named capture profiles keyed by stream id.

Key exports:

- `StreamDefinition` — `{ id, displayName, primaryAttachmentKind: AttachmentKind,
  captureDefaults: { maxClipSec: number } }`.
- `TIMELOG_STREAM: StreamDefinition` — `id: 'timelog'`, `displayName: 'Timelog'`,
  `primaryAttachmentKind: 'audio'`, `maxClipSec: 60`.
- `BUILTIN_STREAMS: StreamDefinition[]` — currently `[TIMELOG_STREAM]`.
- `SYSTEM_STREAMS: readonly string[]` — `['settings', 'assistant-chats']`: stream
  ids the sync engine drains/pulls that are never the active capture stream and
  deliberately have no `StreamDefinition` (no capture UI, no
  `primaryAttachmentKind`, no skill). Their event-sourcing conventions live in
  app-level modules; the registry only lists the ids so the sync loop covers them,
  keeping this file a pure generic-layer data file (it imports nothing from
  `settings/` or `assistant/` — the layering test enforces this).
- `allSyncStreams(): string[]` — every stream one sync cycle covers:
  `SYSTEM_STREAMS` first, then the `BUILTIN_STREAMS` ids. Consumed by
  `src/store/appStore.ts#drainSync` (SPEC §8.4/§8.5).
- `getStream(id: string): StreamDefinition` — looks up in `BUILTIN_STREAMS`;
  **throws** `Error('Unknown stream: <id>')` for unknown ids (no undefined
  return) — including system-stream ids, which are not capture streams.

Relations: imports `AttachmentKind` from `src/contract/types`. Downstream systems
(storage, queue, capture UI) key off `StreamDefinition.id`; adding a stream here is
meant to require no engine changes.

### src/streams/registry.test.ts

Verifies `getStream` returns the timelog definition by id and throws for unknown
ids (system-stream ids included), that `BUILTIN_STREAMS` contains the timelog
stream, and that `allSyncStreams()` covers every system + builtin stream in a
stable, duplicate-free order (system streams first).

---

## Key invariants & gotchas

- **Append-only log.** Edits/deletes are later `amend`/`revoke` events; removed
  locations and attachments remain in the log — `clearLocation` and
  `removeAttachments` only hide them from the fold.
- **Byte-stable wire format.** Event records and contract files have fixed key
  order, 2-space indent, trailing newline; optional fields are omitted entirely,
  never `null`. `serializeEvent` output is tested byte-for-byte.
- **Filename ↔ log-order invariant.** Name-sorted listings equal seq order, and
  `seqOfFilename` recovers `seq` from any log filename (`idOfRecordName` recovers the
  id from record names). It parses by splitting on `_` (not slicing 6 chars) so seq
  can exceed 999999.
- **Identity is `id`; `seq` is a hint.** Seq is per-device and can collide across
  devices syncing the same Drive log; every ordering (event application, entry
  tiebreaks) goes through `compareEvents` (`seq → loggedAt → id`) so all replicas
  fold identically. Never key anything by `[stream, seq]`.
- **Local-offset timestamps everywhere.** All contract timestamps are ISO-8601 with
  the local offset; `partitionOf` and entry ordering rely on the canonical
  `YYYY-MM-DDTHH:mm:ss±HH:MM` shape (fixed-index string operations).
- **Amend precedence rules.** `patch.location` beats `clearLocation` (both in the
  fold and on the wire, where `clearLocation` is dropped); within one amend,
  removals apply before added attachments; amends after a revoke are ignored;
  unknown targets are ignored silently, not errors.
- **Stub-only writes for skill-owned files.** The app creates `config.json` and
  `checkpoint.json` only when absent; it must never overwrite them, since the skill
  mutates them after bootstrap.
- **Shallow parse validation.** `parseEvent` validates the envelope and
  type-required fields only; attachment and patch internals are trusted.
- **Time-helper bases differ — don't mix them.** `addMinutesIso` re-renders in the
  *input string's* offset; `withTimeOfDayIso`/`localTimeOf` use the *device's
  current* zone; `civilTimeOf`/`localDateOf` read the *string's own* civil fields;
  `zonedIso` renders in an *explicit* IANA zone. A date+time pair shown to the user
  must come from one basis (the edit sheet uses the string's civil fields and saves
  via `zonedIso(entry.deviceTz)`); mixing bases mislabels cross-timezone entries.
- **`getStream` throws** for unknown ids; callers must pass a registered stream id.
- **Event ids are random, not checked for uniqueness** (6-char base36); uniqueness
  is probabilistic "per stream".
