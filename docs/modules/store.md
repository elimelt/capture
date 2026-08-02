# `src/store` — Local persistence & app state

## Overview

`src/store` is the local persistence layer plus the single Zustand store the UI reads.
It has two halves:

- **IndexedDB repositories** (`db.ts`, `events.ts`, `places.ts`, `settings.ts`,
  plus the read-only `space.ts` accounting): the
  on-device replica of the append-only event log (SPEC §3.2), the upload-queue state,
  attachment blobs, places, the reverse-geocode cache, settings, and persisted assistant
  chats. All data is keyed by stream so adding a stream is configuration, not a schema
  change.
- **UI state** (`appStore.ts`): a Zustand store that caches the folded entry list and
  settings in memory, delegates every write to the repositories, and wires Drive
  auth state and the manual sync action (`src/drive`) into state the components render.

One small module sits outside both halves: `livetext.ts`, a transient in-memory
pub/sub store (nothing touches IndexedDB) that carries streaming transcript/caption
partials from the enrichment runners to the entry cards.

State flows one way: a UI action calls a store action → the action writes through a repo
(one IndexedDB transaction) → the action re-reads (`refresh`/`loadPlaces`/`loadSettings`)
and `set()`s the new snapshot → components re-render. The store never mutates cached
entries in place; the entry list is always recomputed by folding the local log
(`fold` from `src/contract`). Sync is manual-only and driven by the same store: appends
enqueue a `sync` row, and `drainSync` — whose sole caller is the "Sync now" button in
Settings — runs one pull-then-push cycle **per registered stream**
(`allSyncStreams()` from `src/streams/registry`, covering system streams like
`settings`/`assistant-chats` as well as capture streams): `src/drive/pull` imports
remote events first, then `src/drive/queue` drains pending rows.

Per SPEC §10's layering rule, `store/` is stream-agnostic: it imports only from
`src/contract`, `src/streams`, and `src/drive`, never from `gcal/`, `dayview/`, or
`assistant/` (assistant chat messages are stored opaquely as `unknown[]` for this
reason).

## File-by-file

### src/store/db.ts

Defines the IndexedDB schema (via the `idb` package) and owns the singleton connection.

Key exports:

- `getDb(): Promise<TimeboxDatabase>` — opens (once, memoized in a module-level promise)
  the `timebox` database at **version 5** and runs versioned upgrades.
- `resetDbCache(): void` — test hook; forgets the cached connection promise.
- `type TimeboxDatabase = IDBPDatabase<TimeboxDB>`.
- `type SyncStatus = 'queued' | 'uploaded' | 'error'` — user-facing rollup.
- `type SyncPhase = 'attachments-pending' | 'record-pending' | 'done'` — position in the
  atomic append protocol (SPEC §5.2: attachments first, event record last).
- `interface SyncStatusRow { id; stream; seq; status; phase; attempts; nextRetryAt?; error?; fileIds? }`
  — upload state for one event; `id` is the event's id (the identity and the row's key),
  `seq` is kept for drain order and display, `nextRetryAt` is ISO local time, absent =
  eligible now. `fileIds` maps contract filenames to pre-generated Drive file ids,
  persisted by the drainer before each first upload attempt so retries reuse the same
  id (SPEC §8.4); absent on rows written by older versions (no migration needed —
  the drainer falls back to find-before-upload for those).
- `interface Place { id; name; lat; lng; radiusM; address? }`.
- `interface GeocacheRow { key; address; cachedAt }` — reverse-geocode cache row keyed by
  a rounded `"lat,lng"` cell (SPEC §7).
- `interface StoredChatRow { id; createdAt; updatedAt; messages: unknown[] }` — persisted
  assistant conversation; message typing lives in `assistant/history.ts`.

Object stores (schema `TimeboxDB`):

| Store | Key | Value |
|---|---|---|
| `events` | event `id` (+ `by-stream` index) | `LogEvent` (from `src/contract/types`) |
| `blobs` | contract filename | `{ file, blob }` |
| `sync` | event `id` | `SyncStatusRow` |
| `places` | `id` | `Place` |
| `geocache` | rounded `"lat,lng"` | `GeocacheRow` |
| `meta` | string (out-of-line) | `unknown` — settings + per-stream seq counters |
| `chats` | `id` | `StoredChatRow` |

`events` and `sync` are keyed by the event `id` — the identity (SPEC §3.3): two
devices appending offline can mint the same per-stream `seq`, so `seq` is only a
non-unique ordering hint and must not be part of a key. Sequenced access goes through
the `by-stream` index plus an explicit sort.

Migrations: v1 creates the core stores; v2 backfills `attempts: 0` and a `phase` on
existing `sync` rows (`'done'` if uploaded, else `'attachments-pending'` — safe because
re-uploads are idempotent by filename); v3 adds `chats` and migrates the legacy single
conversation from `meta['assistant:chat']` into a chat row; v4 adds `geocache`; v5
re-keys `events` and `sync` by `id` instead of `[stream, seq]` — by **dropping and
recreating** both stores rather than migrating rows, since the local log is a replica
of Drive and a pull rebuilds it.

### src/store/events.ts

The event repository — **the only writer of the local log**. A private `append()` runs
one `readwrite` transaction over `events`/`blobs`/`sync`/`meta` that: reads the
per-stream seq counter (`meta` key `nextSeq:<stream>`, defaulting to 1), builds the event
via a caller-supplied `build(base)` callback (base = `{ id, seq, loggedAt, deviceTz }`
using `newEventId`, `toLocalIso`, `deviceTz` from `src/contract`), names attachments with
`attachmentFileName(eventBaseName(event), kind, mimeType, index)` (index counted per
kind), then writes the incremented counter, the event, each blob, and a `sync` row —
atomically. The `sync` row starts as `status: 'queued'`, `attempts: 0`, and `phase`
`'attachments-pending'` if there are attachments, else `'record-pending'`.

Key exports:

- `interface NewAttachment { kind: AttachmentKind; blob: Blob; mimeType: string; durationSec?: number; derivedFrom?: string }`
  — attachment input before it is assigned a contract filename.
- `appendCapture(input: { stream; capturedAt; location?; attachments: NewAttachment[] }): Promise<CaptureEvent>`
- `appendAmend(input: { stream; targets: string[]; patch?: AmendPatch; attachments?: NewAttachment[] }): Promise<AmendEvent>`
- `appendRevoke(input: { stream; targets: string[] }): Promise<RevokeEvent>`
- `listEvents(stream): Promise<LogEvent[]>` — all events for a stream via the
  `by-stream` index, re-sorted into log order with `compareEvents` (seq → loggedAt →
  id, the same total order the fold uses) since the id-keyed index yields id order.
- `listEntries(stream): Promise<Entry[]>` — `fold(listEvents(...))`; the user-visible
  folded view (SPEC §3.3).
- `getBlob(file): Promise<Blob | undefined>` / `deleteBlob(file): Promise<void>` —
  the latter supports `keepAudioLocally=false` pruning after upload (SPEC §8.4).
- `getSyncStatuses(stream): Promise<Map<string, SyncStatusRow>>` — status by event id.
- `listPendingSync(stream): Promise<SyncStatusRow[]>` — rows with `status !== 'uploaded'`
  sorted by seq ascending (id as tiebreak); the order `src/drive/queue` must upload in
  so the Drive log commits monotonically (SPEC §5.2, §8.4).
- `interface SyncSummary { pending; errors; lastError? }` /
  `summarizeSyncStatuses(rows: Iterable<SyncStatusRow>): SyncSummary` — pure rollup for
  the Settings status line: `pending` counts rows with `status !== 'uploaded'` (errored
  rows included), `errors` counts `status === 'error'` rows, `lastError` is the
  highest-seq errored row's message (omitted when it has none).
- `getLastSyncAt(stream): Promise<string | undefined>` / `setLastSyncAt(stream, at)` —
  the moment the last full pull+push cycle completed cleanly, persisted per stream in
  the `meta` store (key `lastSyncAt:<stream>`); unset = never synced.
- `getEventById(id): Promise<LogEvent | undefined>` / `putSyncStatus(row)` — used
  by the drive queue to read the event being uploaded and record progress.
- `importEvents(stream, events, blobs): Promise<void>` — the pull-side writer
  (SPEC §8.5): commits events pulled from Drive plus their eagerly-fetched attachment
  blobs in **one transaction**. Pulled events get sync rows with `status: 'uploaded'`
  / `phase: 'done'` (already on Drive — the drainer never touches them), and the
  per-stream seq counter is bumped past every imported seq so the next local append
  extends the merged log instead of colliding. Idempotent: re-importing a known id
  overwrites it with itself.
- `wipeAll(): Promise<void>` — clears all seven object stores in one transaction
  (including `meta`, so seq counters restart at 1).

Invariants and edge cases: seq counters are per-stream and monotonic per device
(`importEvents` keeps them ahead of everything pulled); `capture` events
always carry an `attachments` array (possibly empty), while `amend` events only get one
when attachments were supplied; blobs are stored under the contract filename so uploads
and replay reference the same key; nothing here ever updates or deletes an event row.

### src/store/places.ts

Thin CRUD repo over the `places` object store; re-exports `type Place` from `db.ts`.

- `listPlaces(): Promise<Place[]>`
- `savePlace(place: Place): Promise<void>` — `put`, so saving an existing `id` overwrites.
- `deletePlace(id: string): Promise<void>` — no-op for unknown ids.

Point-in-radius matching lives in `src/places`, not here (SPEC §3.4: places are
local-only; labels travel to Drive only inside entry metadata).

### src/store/settings.ts

App-wide and per-stream settings stored as values in the `meta` store.

- `interface AppSettings { locationEnabled: boolean; assistantEnabled: boolean; assistantModel: string }`
  — assistant is opt-in and off by default (SPEC §10.1); defaults are
  `{ locationEnabled: true, assistantEnabled: false, assistantModel: 'gpt-oss:20b' }`.
- `interface StreamSettings { maxClipSec: number; keepAudioLocally: boolean }` —
  defaults `{ maxClipSec: 60, keepAudioLocally: true }`.
- `getSettings(): Promise<AppSettings>` / `saveSettings(settings): Promise<void>` —
  key `settings:app`.
- `getStreamSettings(stream): Promise<StreamSettings>` /
  `saveStreamSettings(stream, settings): Promise<void>` — key `settings:stream:<stream>`.

Both getters spread stored values over defaults (`{ ...DEFAULTS, ...stored }`), so a
partial or missing stored object yields complete settings — this is the forward-migration
path when new settings fields are added.

### src/store/space.ts

Local storage-space accounting for the Settings "Data" section (SPEC §4.3). Two
complementary measurements plus a formatter:

- `formatBytes(bytes): string` — adaptive decimal-unit formatting (1 KB = 1000 B,
  matching how Drive and desktop OSes report storage): one decimal below 10 so small
  values never collapse to "0.0 MB", whole numbers above, rounding carried into the
  next unit ("1 MB", never "1000 KB"); non-finite/negative input renders "0 B".
- `estimateLocalSpace(): Promise<LocalSpaceEstimate | null>` — origin-level
  `{ usageBytes?, quotaBytes? }` from `navigator.storage.estimate()`. Covers
  everything the origin stores (IndexedDB *including* overhead, service-worker caches
  like OSM tiles), but browsers pad it and it can't be broken down. `null` when the
  API is unavailable or the call rejects — never throws.
- `measureAppSpace(): Promise<AppSpace>` — the app's own IndexedDB data in one
  read-only transaction: log events at their canonical `serializeEvent` byte size
  (their exact size as Drive files), attachment blobs at `Blob.size`, and persisted
  assistant chats as JSON bytes, with counts and a `totalBytes` sum. The pure
  aggregation is exported separately as `summarizeAppSpace(events, blobs, chats)`.

(Drive-side accounting lives in `src/drive/space.ts` — see
[drive.md](drive.md).)

### src/store/livetext.ts

Transient in-memory "live text" stores for the streaming enrichment pipelines. While a
transcript or caption streams in, the runner (`src/transcribe/runner.ts` /
`src/vision/runner.ts`) publishes the partial text here keyed by the **source**
attachment filename; `src/capture/AttachmentBody.tsx` subscribes (via
`useSyncExternalStore`) and renders it growing on the entry card. Nothing is persisted —
the append-only log only ever stores the final text via the runner's single
`appendAmend`, and a failed stream's key is cleared by the runner.

- `interface LiveTextStore { subscribe(listener): () => void; snapshot():
  ReadonlyMap<string, string>; set(file, text); clear(file); sweep(keep:
  ReadonlySet<string>) }` — snapshots are immutable maps replaced on every change
  (stable reference otherwise), so React can consume them directly. `set` with an
  unchanged value, `clear` of an absent key, and a no-op `sweep` do not notify.
- `createLiveTextStore(): LiveTextStore` — the (pure, tested) factory.
- `liveTranscripts` / `liveCaptions` — the two app singletons, keyed by source audio /
  photo filename respectively. They live here (not in the pipelines) so the dependency
  graph stays one-way: pipelines and UI both import `store/`.

`sweep(keep)` exists for lifecycle, not correctness: runners call it with the
currently-pending source files at the start of each drain, dropping text left behind by
completed attempts (kept until then so the card never flashes empty between stream end
and the store refresh that reveals the persisted attachment).

### src/store/appStore.ts

The single Zustand store (`useAppStore = create<AppState>()(...)`) the UI reads. State:
`ready` (boot splash gate), `currentStreamId` (initial `'timelog'`), `entries: Entry[]`,
`syncStatuses: Map<string, SyncStatusRow>` (keyed by event id; current stream only),
`lastSyncAt: string | null` (when the current stream's last clean pull+push cycle
completed; null = never synced), `globalSyncSummary: GlobalSyncSummary` (aggregate
across all registered streams — see below), `places: Place[]`, `appSettings`,
`streamSettings`, `lastError: string | null` (toast channel), `driveConnection:
DriveConnection` (`src/drive/token`; drives the reconnect pill, SPEC §8.2), `syncing`
(sync cycle in flight), and the storage-space snapshot — `localSpace:
LocalSpaceEstimate | null` (null = unsupported or not yet loaded) and `appSpace:
AppSpace | null` (both from `space.ts`, set by `refreshSpace`).

Also exports:

- `interface StreamSyncResult { stream; outcome: DrainOutcome; uploaded; pulled:
  number; error? }` — one stream's slice of a sync cycle.
- `interface SyncResult { outcome: DrainOutcome; uploaded; pulled: number; error?;
  perStream: StreamSyncResult[] }` — the aggregate result of one cycle over every
  registered stream (worst-of outcome, summed counts), consumed by the Settings
  "Sync now" label.
- `interface GlobalSyncSummary { pending; errors: number; lastError?; lastSyncAt:
  string | null }` — pending/error counts summed over **all** registered streams'
  sync rows plus the **oldest** per-stream `lastSyncAt` (the conservative
  "everything synced as of" moment; `null` while any stream has never completed a
  clean cycle). Computed by a private `summarizeGlobalSync()` inside `refresh()`;
  rendered by Settings' `SyncStatusLine`.

Actions:

- Loaders — `refresh(streamId?)` (re-lists entries, sync statuses, and `lastSyncAt`
  for the current stream, recomputes the cross-stream `globalSyncSummary`, and
  switches `currentStreamId` when given), `loadPlaces()`, `loadSettings()`,
  `refreshConnection()`, `refreshSpace()` (re-measures `localSpace` + `appSpace`;
  local-only, called by the Settings Data section on entry and by `wipe`), and
  `init()` which runs the first four in parallel — a local-only
  status computation (entries, sync rows, `lastSyncAt`, stored-token expiry) that never
  syncs — and sets `ready: true` in a `finally` so even a failed boot lifts the splash.
- Log writes — `capture(input): Promise<CaptureEvent>`, `revoke(targets)`,
  `amend(input)`: delegate to `appendCapture`/`appendRevoke`/`appendAmend`, then
  `refresh()`. No eager upload: new events stay queued locally until a manual
  "Sync now".
- Drive — `connectDrive()` (user gesture → `connect()` from `src/drive/auth` →
  refresh connection; does **not** sync), `disconnectDrive()` (revokes the stored
  token), and `drainSync(): Promise<SyncResult>` — one full sync cycle over
  **every registered stream** (SPEC §8.4/§8.5), manual-only: the sole caller is
  the "Sync now" button in Settings. No-op (`'retry-later'`) if already `syncing`;
  without a valid token it only refreshes connection state (so the reconnect pill
  can appear) and returns `'reconnect'`; with one it loops over
  `allSyncStreams()` and, per stream, runs **pull then push** —
  `pullStream(token, stream)` from `src/drive/pull` first (so local appends land
  after everything other devices committed), then `drainStream(token, stream)`
  from `src/drive/queue`. Failure isolation: any `'reconnect'` flips the pill and
  aborts the remaining streams (marked `'reconnect'` in `perStream` — the token
  is dead for all of them), while `'retry-later'`/`'error'` on one stream never
  blocks the rest. Each stream's outcomes merge worst-of (`idle < drained <
  retry-later < reconnect < error`) and the per-stream outcomes merge worst-of
  into the aggregate; an aggregate `'error'` sets `lastError`; a stream's own
  clean cycle (`idle`/`drained`) persists *its* `lastSyncAt` via
  `setLastSyncAt(stream, …)`. Afterwards state is refreshed (`refresh()` +
  `loadSettings()`, since pulled system-stream events can change settings) and
  `syncing` is cleared in a `finally`.
- Places/settings/data — `addPlace`, `removePlace`, `updateSettings`,
  `updateStreamSettings`, `wipe()` (`wipeAll()` then reload, including
  `refreshSpace()` so the Settings storage line never shows the pre-wipe number),
  `clearError()`.

All write actions are wrapped in a local `guard(label, fn)` helper: on failure it sets
`lastError` to `"<label>: <message>"` **and re-throws** so awaiting callers still see the
error. `drainSync` is deliberately not guarded; it reports failures via `lastError` and
in its returned `SyncResult` without throwing.

### src/store/appStore.test.ts

Covers the store's write→refresh loop against real (fake-indexeddb) repos:
capture/amend/revoke updating folded entries, settings persistence, wipe, the
`guard` behavior of setting `lastError` while rejecting, and space accounting
(`refreshSpace` snapshots, null-estimate degradation, and the wipe → re-measure
regression).

### src/store/space.test.ts

Covers `formatBytes` (unit scaling, the "0.0 MB" and MiB-mislabeled-as-MB
regressions, rounding carry, non-finite input), `estimateLocalSpace` graceful
degradation (missing API / rejection → `null`), the pure `summarizeAppSpace`
aggregation (canonical event bytes, blob bytes vs characters, chat JSON bytes),
and `measureAppSpace` end-to-end against fake-indexeddb (after `appendCapture`,
after `wipeAll`).

### src/store/appStore.drive.test.ts

Mocks `src/drive/{auth,queue,pull,token}` to test only the store's Drive wiring:
`drainSync`'s no-token and re-entrant branches, the multi-stream loop (every
registered stream pulled-then-pushed in registry order, counts summed, per-stream
results reported), failure isolation (a pull or drain `'reconnect'` aborts the
remaining streams — their mocks are never invoked — and marks them `'reconnect'`;
`'retry-later'`/`'error'` on one stream never short-circuits the rest),
worst-of aggregation, per-stream `lastSyncAt` stamping (only streams whose own
cycle was clean; idle streams stamped too; nothing stamped on an initial
reconnect), the `globalSyncSummary` rollup (summed pending/errors, oldest
`lastSyncAt`, `null` while any stream never synced), plus the connect (no
post-connect sync) and disconnect flows.

### src/store/events.test.ts

Exercises the event repo end to end: per-stream monotonic seq allocation, contract
attachment naming and blob round-trips, queued sync rows with the correct initial phase,
fold behavior of amend/revoke, `wipeAll` (including seq-counter and `lastSyncAt` reset),
the migration to v5 (id-keyed `events`/`sync` stores replacing `[stream, seq]`-keyed
ones), the `summarizeSyncStatuses` rollup (pending/error counts, highest-seq
`lastError`, omitted when the errored row has no message), and
`getLastSyncAt`/`setLastSyncAt` round-trips per stream.

### src/store/events.sync.test.ts

Sync-specific edge case tests: `importEvents` marking pulled events as `uploaded` (never
re-pushed), seq counter bump correctness, idempotent re-import, blob keying by contract
filename, `listPendingSync` ordering by seq, exclusion of uploaded events from pending
queue, cross-device merge scenarios with seq collisions, and sequential multi-import
handling.

### src/store/livetext.test.ts

Covers the `createLiveTextStore` factory: snapshot exposure, notification on
set/clear/sweep, snapshot reference replacement on change (and stability otherwise),
the silent no-ops (same value, absent key, sweep that keeps everything), sweep
filtering, and unsubscribe.

### src/store/places.test.ts

Verifies the places repo CRUD round-trip, `put` overwrite semantics on duplicate ids,
and delete (including unknown-id no-op).

### src/store/settings.test.ts

Verifies default fallbacks, round-trips, the partial-object merge over defaults, and
per-stream independence of stream settings.

## Key invariants & gotchas

- **Append-only, two writers.** `events.ts#append()` writes locally-minted events;
  `importEvents()` writes events pulled from Drive. Events are never edited or deleted
  locally — "edit"/"delete" are new `amend`/`revoke` events; visible state is always a
  fresh `fold()` over the whole per-stream log.
- **Atomic append.** Seq counter increment, event record, attachment blobs, and the
  `sync` row commit in a single IndexedDB transaction — no partial appends exist.
  `importEvents` gives pulls the same guarantee (events + blobs + counter bump in one
  transaction).
- **Identity is the event id; seq is an ordering hint.** `events`/`sync` are keyed by
  `id` because two devices appending offline can mint the same per-stream seq
  (SPEC §3.3 Design C); ordering everywhere is seq → loggedAt → id via
  `compareEvents`.
- **Seq is per-stream and allocated locally** from `meta` key `nextSeq:<stream>`;
  `importEvents` bumps it past every pulled seq, and `wipeAll()` clears `meta`, so
  after a wipe seq restarts at 1 (fine only because the wipe also drops all local
  events — Drive state is separate, and the next pull re-bumps the counter).
- **Upload order matters.** `listPendingSync` returns rows sorted by seq; the drive
  drainer must keep that order so the Drive log commits monotonically, and the
  `phase` field mirrors the attachments-first/record-last commit protocol (SPEC §5.2).
- **Pull before push, per stream.** `drainSync` loops over `allSyncStreams()` and
  always runs `pullStream` before `drainStream` for each; pulled events arrive
  `uploaded`/`done` so the drainer never re-pushes them. A `'reconnect'` anywhere
  aborts the remaining streams; `'retry-later'`/`'error'` stays stream-local.
- **Sync is manual-only.** `drainSync`'s sole caller is the "Sync now" button in
  Settings — no foreground/online/capture triggers — and each stream's `lastSyncAt`
  is stamped only when that stream's own pull+push cycle completes cleanly
  (`idle`/`drained`).
- **Blobs are keyed by contract filename**, computed at append time — the same name is
  used locally and in Drive, which is what makes re-uploads idempotent.
- **`db.ts` caches the connection**; tests (and anything deleting the database) must
  call `resetDbCache()` or they will reuse a closed/stale handle.
- **Settings getters merge over defaults**, so adding a settings field never needs a DB
  migration — but saved objects are stored whole, so `saveSettings` expects a complete
  `AppSettings`.
- **`store/` stays stream- and app-agnostic**: chat messages are `unknown[]` here
  (typing owned by `assistant/history.ts`), and nothing imports from `gcal/`,
  `dayview/`, or `assistant/` (SPEC §10 layering rule).
- **`guard` re-throws.** Store write actions surface `lastError` *and* reject; callers
  that `await` them must be prepared for the rejection. `drainSync` never throws.
- **`livetext.ts` is display-only.** Live partial transcripts/captions never touch
  IndexedDB or the event log; the single write path is unaffected. Keys are source
  attachment filenames, and each pipeline sweeps only its own singleton.
