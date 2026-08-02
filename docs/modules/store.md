# `src/store` — Local persistence & app state

## Overview

`src/store` is the local persistence layer plus the single Zustand store the UI reads.
It has two halves:

- **IndexedDB repositories** (`db.ts`, `events.ts`, `places.ts`, `settings.ts`,
  the `migrateSettingsV1.ts` upgrade step, plus the read-only `space.ts` accounting):
  the on-device replica of the append-only event log (SPEC §3.2), the upload-queue
  state, attachment blobs, places, the reverse-geocode cache, settings (event-sourced
  on the `settings` system stream), and persisted assistant chats. All data is keyed
  by stream so adding a stream is configuration, not a schema change.
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
  the `timebox` database at **version 10** and runs versioned upgrades. Handles the
  full `openDB` lifecycle — `blocked`/`blocking`/`terminated` plus open failures —
  see "Connection lifecycle" below.
- `resetDbCache(): void` — test hook; forgets the cached connection promise.
- `DB_BLOCKED_MESSAGE` — the boot-splash note shown while an upgrade is blocked by
  another tab.
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
- `interface StoredChatRow { id; createdAt; updatedAt; messages: unknown[] }` — a
  **legacy** persisted assistant conversation; live chats are event-sourced in the
  `assistant-chats` stream (see `migrateChatsV1.ts` and `assistant/chatSync.ts`), and
  the `chats` store is kept only as a rollback artifact.
- `interface OverlayEventRow { id; stream; seq }` — a calendar-overlay log event
  (`capture.calendar-overlay.v1`, SPEC §3.6/§5.6), stored opaquely beyond the key +
  index fields because the event shape belongs to `gcal/overlay` and `store/` must
  never import `gcal/`; `src/gcal/overlay/store.ts` is the store's only reader/writer
  and owns the strong typing.

Object stores (schema `TimeboxDB`):

| Store | Key | Value |
|---|---|---|
| `events` | event `id` (+ `by-stream` index) | `LogEvent` (from `src/contract/types`) |
| `blobs` | contract filename | `{ file, blob }` |
| `sync` | event `id` | `SyncStatusRow` |
| `places` | `id` | `Place` |
| `geocache` | rounded `"lat,lng"` | `GeocacheRow` |
| `meta` | string (out-of-line) | `unknown` — per-stream seq counters, sync stamps, migration markers, legacy settings |
| `chats` | `id` | `StoredChatRow` (legacy; migrated to the `assistant-chats` stream, kept for rollback) |
| `overlayEvents` | event `id` (+ `by-stream` index) | `OverlayEventRow` — the calendar-overlay log, **owned by `gcal/overlay`**; local-only until wired into sync |

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
of Drive and a pull rebuilds it; v8 adds `overlayEvents` (id-keyed, `by-stream` index —
SPEC §3.6/§5.6), self-contained, additive, and guarded by a `contains('overlayEvents')`
check so it composes with the parallel stream migrations landing in either order; v9
seeds legacy flat settings into `settings`-stream events via `migrateSettingsV1(tx)`;
v10 turns legacy `chats` rows into `assistant-chats` stream events via
`migrateChatsV1(tx)`. The v9 and v10 migrations are called on **every** upgrade
rather than under an `oldVersion` check, because parallel workstreams claimed their
own version numbers and landed in arbitrary order, so a device may already sit at a
higher version without a given migration having run; each call is state-guarded by a
meta marker (plus, for chats, a stream-state check) instead. Any branch adding a
migration must raise the version above the current max so `upgrade()` fires; each
state-guarded block then self-selects.

Connection lifecycle (version-agnostic; composes with any future version bump):

- **`blocked`** — our upgrade is waiting on an old-version connection in another
  tab/window, so `openDB` stays pending and boot sits on the splash (`init()` in
  appStore.ts can't settle, `ready` never flips). Since this fires before React
  mounts, the handler writes `DB_BLOCKED_MESSAGE` directly into the boot splash's
  `<p>` (index.html) — "Close other Capture tabs or windows to finish updating" —
  instead of hanging silently; the open still proceeds the moment the old tab
  closes its connection. No-ops without a DOM (tests) or once the splash is gone.
- **`blocking`** — this connection is holding up a *newer* version elsewhere (a tab
  that loaded a newer deploy). We close the connection so the other tab can upgrade,
  and forget the memo: the next `getDb()` here reopens (same version if this code is
  current) or fails fast with the reload-prompt error below (if this tab is stale) —
  never wedging the other tab's boot.
- **`terminated`** — the browser force-closed the connection (resource reclaim,
  storage cleared); the memo is forgotten so the next `getDb()` reconnects rather
  than reusing a dead handle.
- **Open failure** — a rejected open is *never* memoized: the promise cache is
  cleared on rejection so the next `getDb()` retries instead of replaying a cached
  rejection for the rest of the session. A `VersionError` (the DB was already
  upgraded past what this code opens — only newer code can open it) is mapped to
  `"Capture was updated in another tab — reload this page to continue."`, which
  store actions surface via `lastError`.

Lifecycle behavior is covered by `db.test.ts` (fake-indexeddb supports
multi-connection blocking, and its `forceCloseDatabase` simulates abnormal
termination). Not simulatable there: a real browser's cross-process timing and the
splash DOM itself (tests stub `document`).

### src/store/migrateChatsV1.ts

One-shot, idempotent migration of legacy `chats` rows into the `assistant-chats`
system stream (SPEC §3.1, §10.1). For each legacy conversation (oldest `createdAt`
first, id as tiebreak) it hand-constructs, inside the caller's transaction, exactly
what `events.ts#append()` would write: one `capture` event with no attachments (its
id becomes the chat id) plus one `amend` per message carrying a
`capture.chatmessage.v1` JSON text attachment — with strictly increasing per-stream
`seq` across all synthesized events (message order is seq order; the synthesized
`loggedAt` is the row's `createdAt`/`updatedAt` converted to a local-offset contract
timestamp). Every event gets a `'queued'` sync row (`record-pending` for captures,
`attachments-pending` for amends), so the migrated history uploads through the normal
multi-stream drain. The per-stream `nextSeq` counter is written back once at the end.

Guard (why it is not an `oldVersion` check): it returns early if the
`migrated:chats:v1` meta marker is set, or — belt and suspenders — if the
`assistant-chats` stream already has events (then it just sets the marker). A fresh
install (no legacy rows) writes the marker and nothing else. The legacy `chats`
store and its rows are deliberately left in place as a rollback artifact.

Exports: `migrateChatsV1(tx)` (generic over `versionchange`/`readwrite` transactions
so tests and recovery paths can drive it), `CHATS_MIGRATION_MARKER`, and
`MIGRATED_CHATS_STREAM`/`MIGRATED_CHAT_MESSAGE_PAYLOAD_SCHEMA` — duplicates of the
constants owned by `assistant/chatSync.ts` (store/ must not import assistant/), with
the pairing pinned by a test in `assistant/chatSync.test.ts`.

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
- `stripPendingFileIds(): Promise<void>` — drops `fileIds` from every row with
  `status !== 'uploaded'` (uploaded rows untouched). Called by `src/drive/account.ts`
  on a Google-account switch: ids minted under the old account must not be reused
  (Drive ids are globally unique, so a retried create could 409 against the old
  account's file and be miscounted as success); stripped rows fall back to the
  drainer's legacy find-before-upload probe.
- `importEvents(stream, events, blobs): Promise<void>` — the pull-side writer
  (SPEC §8.5): commits events pulled from Drive plus their eagerly-fetched attachment
  blobs in **one transaction**. Pulled events get sync rows with `status: 'uploaded'`
  / `phase: 'done'` (already on Drive — the drainer never touches them), and the
  per-stream seq counter is bumped past every imported seq so the next local append
  extends the merged log instead of colliding. Idempotent: re-importing a known id
  overwrites it with itself.
- `wipeAll(): Promise<void>` — clears all eight object stores in one transaction
  (including `meta`, so seq counters restart at 1, and `overlayEvents` — the
  calendar-overlay log goes with everything else).

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

App-wide and per-stream settings, event-sourced on the `settings` system stream
(SPEC §3.7): every change is one `capture` event appended through the standard
`events.ts` pipeline — so it gets a queued sync row and blob, and syncs through the
ordinary drive queue/pull like any other stream — with a single
`text`/`application/json` attachment carrying a versioned `capture.settings.v1`
payload (`{ op: 'set' | 'unset', key, value? }`). Effective state is a per-key
**last-write-wins fold** in `compareEvents` order (seq → loggedAt → id — the same
total order as the entry fold), so settings converge across devices with no extra
tiebreak logic. The stream only ever uses `capture` events (never amend/revoke).

- `interface AppSettings { locationEnabled: boolean; assistantEnabled: boolean; assistantModel: string }`
  — assistant is opt-in and off by default (SPEC §10.1); defaults
  `APP_SETTINGS_DEFAULTS = { locationEnabled: true, assistantEnabled: false, assistantModel: 'gpt-oss:20b' }`.
- `interface StreamSettings { maxClipSec: number; keepAudioLocally: boolean }` —
  defaults `STREAM_SETTINGS_DEFAULTS = { maxClipSec: 60, keepAudioLocally: true }`.
- `getSettings()` / `saveSettings(next)` / `getStreamSettings(stream)` /
  `saveStreamSettings(stream, next)` — **signatures unchanged** from the legacy
  meta-backed version, so no call site changed. Getters always do a fresh
  `listEvents('settings')` + blob reads + fold (no materialized cache — the zustand
  store remains the in-memory cache via `loadSettings()`); saves **diff** against the
  current effective state and emit one event per *changed* key only, so a no-op save
  appends zero events.
- Keys are namespaced `app.<field>` and `stream.<id>.<field>`
  (`appSettingsKey`/`streamSettingsKey`; entry helpers
  `appSettingsEntries`/`streamSettingsEntries`).
- `SETTINGS_STREAM` (`'settings'`), `SETTINGS_PAYLOAD_SCHEMA`
  (`'capture.settings.v1'`), `type SettingsValue = string | number | boolean`,
  `type SettingsPayload = SettingsSetPayload | SettingsUnsetPayload`.
- `serializeSettingsPayload(p)` — canonical payload bytes (fixed key order
  schema/op/key/value, 2-space indent, trailing newline, `value` omitted for
  `unset`); a wire contract like `contract/serialize.ts`, golden-tested.
  `parseSettingsPayload(json)` returns `undefined` (never throws) on
  malformed/foreign content so one bad attachment can't poison the fold.
- `foldSettingsPayloads(events, payloadOf)` — the pure LWW reducer (capture events
  only, `compareEvents` order; entity-shaped `contract/fold.ts` is not used here).
- `diffSettings(next, effective)` — the pure diff primitive shared with the v9
  migration. It skips `LOCAL_ONLY_SETTINGS_KEYS` — an empty `ReadonlySet` today,
  the one-line extension point for a future setting that must never leave the
  device.

Missing keys fall back to compiled-in defaults, so adding a settings field still
needs no migration; folded values whose runtime type doesn't match the field's
default are ignored (`typeof` check), so junk in the stream can't corrupt typed
settings. `unset` payloads revert a key to its default.

### src/store/migrateSettingsV1.ts

The v9 migration (SPEC §3.7): legacy flat settings (`meta['settings:app']` and
`meta['settings:stream:<id>']` for every `BUILTIN_STREAMS` id) are seeded as
`settings`-stream events, hand-constructed inside the upgrade transaction the way
the v2/v3/v5 migrations write rows (`append()` can't run there): each payload gets
a full append — event record, payload blob, **queued** sync row, and the
`nextSeq:settings` counter written back once — so the next "Sync now" pushes the
seeds like any other local append.

- Only keys whose (type-valid) legacy value **differs from its default** migrate,
  sharply reducing cross-device LWW collisions when several devices migrate
  independently.
- **State-guarded, not version-guarded**: `migrateSettingsV1(tx)` is called from
  `db.ts` on every upgrade and no-ops once its meta marker
  (`SETTINGS_MIGRATION_MARKER = 'migrated:settings-stream-v1'`) exists. Parallel
  workstreams claim their own IndexedDB version numbers and can land in any order,
  so a device may already sit at a higher version without this migration having run —
  a bare `oldVersion` guard alone would silently skip it. Idempotent by construction; a
  fresh install (no legacy keys) just writes the marker.
- Legacy meta keys are deliberately **kept** as an inert rollback artifact
  (cleanup deferred to a later PR).

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

### src/store/migrateChatsV1.test.ts

Covers the legacy-chats migration against fake-indexeddb: seeding a pre-migration
(v5-shaped) database and asserting conversion to capture + ordered amends (strictly
increasing seq, message order preserved, envelope payloads intact, oldest chat
first), queued sync rows with the right phases and the advanced seq counter, legacy
rows left in place, wire-contract round-trips (`parseEvent(serializeEvent(…))`),
idempotency across two runs, the fresh-install no-op (marker set, no events), the
applied-state guard running correctly at an already-current DB version (parallel
branches claimed v8/v9, so `oldVersion` alone is not trusted), and the skip-and-mark
path when the stream already holds events.

### src/store/livetext.test.ts

Covers the `createLiveTextStore` factory: snapshot exposure, notification on
set/clear/sweep, snapshot reference replacement on change (and stability otherwise),
the silent no-ops (same value, absent key, sweep that keeps everything), sweep
filtering, and unsubscribe.

### src/store/places.test.ts

Verifies the places repo CRUD round-trip, `put` overwrite semantics on duplicate ids,
and delete (including unknown-id no-op).

### src/store/settings.test.ts

Verifies default fallbacks, round-trips, per-stream independence
(`stream.<id>.*` namespacing), the event-sourcing mechanics (no-op saves append
zero events; only changed keys emit events; appends go through the standard
pipeline — queued sync row + json attachment), `unset` reverting to defaults,
LWW convergence of `foldSettingsPayloads` (input-order independence; seq
collisions broken by loggedAt then id), cross-device merges via `importEvents`
(deterministic outcomes; identical merged event sets fold identically on both
replicas), and the `capture.settings.v1` payload contract (golden byte shapes
for set/unset, parse round-trip, malformed-payload rejection).

### src/store/migrateSettingsV1.test.ts

Runs the v9 migration against a raw-IndexedDB replica of the v5 schema seeded
with legacy settings: events created only for keys differing from defaults (and
the getters then reflect them), migrated events are push-ready (queued sync
rows, monotonic seq from 1, bumped `nextSeq:settings`) and round-trip
`parseEvent(serializeEvent(...))`, idempotency (a second run adds nothing),
fresh-install no-op (marker written, zero events), the state-guard semantics
(the migration still applies on a later upgrade when a parallel migration
claimed the version bump first), legacy meta keys kept as rollback artifacts,
and wrong-typed legacy fields ignored.

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
  call `resetDbCache()` or they will reuse a closed/stale handle. (Rejected opens,
  `blocking`, and `terminated` clear the cache themselves — see the db.ts
  connection-lifecycle notes.)
- **Settings are an event-sourced stream.** `settings.ts` never touches `meta`
  (the legacy `settings:*` keys remain only as migration input/rollback artifacts):
  reads re-fold the `settings` stream per call, writes append through `events.ts` —
  the single-write-path rule holds for settings too, and settings events pulled from
  another device change `getSettings()` output with no extra plumbing. Missing keys
  fall back to compiled-in defaults, so adding a settings field still needs no DB
  migration; `saveSettings`/`saveStreamSettings` still expect complete objects and
  diff internally.
- **`store/` stays stream- and app-agnostic**: chat messages are `unknown[]` here
  (typing owned by `assistant/history.ts`), calendar-overlay rows are the opaque
  `OverlayEventRow` (typing and all reads/writes owned by `gcal/overlay/store.ts`),
  and nothing imports from `gcal/`, `dayview/`, or `assistant/` (SPEC §10 layering
  rule).
- **`guard` re-throws.** Store write actions surface `lastError` *and* reject; callers
  that `await` them must be prepared for the rejection. `drainSync` never throws.
- **`livetext.ts` is display-only.** Live partial transcripts/captions never touch
  IndexedDB or the event log; the single write path is unaffected. Keys are source
  attachment filenames, and each pipeline sweeps only its own singleton.
