# `src/store` — Local persistence & app state

## Overview

`src/store` is the local persistence layer plus the single Zustand store the UI reads.
It has two halves:

- **IndexedDB repositories** (`db.ts`, `events.ts`, `places.ts`, `settings.ts`): the
  on-device replica of the append-only event log (SPEC §3.2), the upload-queue state,
  attachment blobs, places, the reverse-geocode cache, settings, and persisted assistant
  chats. All data is keyed by stream so adding a stream is configuration, not a schema
  change.
- **UI state** (`appStore.ts`): a Zustand store that caches the folded entry list and
  settings in memory, delegates every write to the repositories, and wires Drive
  auth/sync triggers (`src/drive`) into state the components render.

State flows one way: a UI action calls a store action → the action writes through a repo
(one IndexedDB transaction) → the action re-reads (`refresh`/`loadPlaces`/`loadSettings`)
and `set()`s the new snapshot → components re-render. The store never mutates cached
entries in place; the entry list is always recomputed by folding the local log
(`fold` from `src/contract`). Sync is driven by the same store: appends enqueue a
`sync` row, and `drainSync` runs one pull-then-push cycle — `src/drive/pull` imports
remote events first, then `src/drive/queue` drains pending rows.

Per SPEC §10's layering rule, `store/` is stream-agnostic: it imports only from
`src/contract` and `src/drive`, never from `gcal/`, `dayview/`, or `assistant/`
(assistant chat messages are stored opaquely as `unknown[]` for this reason).

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
- `interface SyncStatusRow { id; stream; seq; status; phase; attempts; nextRetryAt?; error? }`
  — upload state for one event; `id` is the event's id (the identity and the row's key),
  `seq` is kept for drain order and display, `nextRetryAt` is ISO local time, absent =
  eligible now.
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

### src/store/appStore.ts

The single Zustand store (`useAppStore = create<AppState>()(...)`) the UI reads. State:
`ready` (boot splash gate), `currentStreamId` (initial `'timelog'`), `entries: Entry[]`,
`syncStatuses: Map<string, SyncStatusRow>` (keyed by event id), `places: Place[]`,
`appSettings`, `streamSettings`, `lastError: string | null` (toast channel),
`driveConnection: DriveConnection` (`src/drive/token`; drives the reconnect pill,
SPEC §8.2), and `syncing` (sync cycle in flight).

Also exports `interface SyncResult { outcome: DrainOutcome; uploaded; pulled: number;
error? }` — the combined result of one pull-then-push cycle, consumed by the Settings
"Sync now" label.

Actions:

- Loaders — `refresh(streamId?)` (re-lists entries + sync statuses, also switches
  `currentStreamId` when given), `loadPlaces()`, `loadSettings()`,
  `refreshConnection()`, and `init()` which runs all four in parallel, fires a
  no-gesture `drainSync()` (relaunch within the token hour, SPEC §8.2), and sets
  `ready: true` in a `finally` so even a failed boot lifts the splash.
- Log writes — `capture(input): Promise<CaptureEvent>`, `revoke(targets)`,
  `amend(input)`: delegate to `appendCapture`/`appendRevoke`/`appendAmend`, then
  `refresh()`. `capture` additionally fire-and-forgets `drainSync()` (eager upload,
  SPEC §2.3/§8.4).
- Drive — `connectDrive()` (user gesture → `connect()` from `src/drive/auth` →
  refresh connection → sync), `disconnectDrive()` (revokes the stored token),
  and `drainSync(): Promise<SyncResult>` — one full sync cycle (SPEC §8.4/§8.5):
  no-op (`'retry-later'`) if already `syncing`; without a valid token it only
  refreshes connection state (so the reconnect pill can appear) and returns
  `'reconnect'`; with one it runs **pull then push** — `pullStream(token,
  currentStreamId)` from `src/drive/pull` first (so local appends land after
  everything other devices committed; a pull `'reconnect'` flips the pill and skips
  the push), then `drainStream(token, currentStreamId)` from `src/drive/queue`.
  The two outcomes merge worst-of (`idle < drained < retry-later < reconnect <
  error`), `'error'` sets `lastError`, and entries are refreshed and `syncing`
  cleared in a `finally`.
- Places/settings/data — `addPlace`, `removePlace`, `updateSettings`,
  `updateStreamSettings`, `wipe()` (`wipeAll()` then reload), `clearError()`.

All write actions are wrapped in a local `guard(label, fn)` helper: on failure it sets
`lastError` to `"<label>: <message>"` **and re-throws** so awaiting callers still see the
error. `drainSync` is deliberately not guarded; it reports failures via `lastError`
without throwing, since it runs from fire-and-forget triggers.

### src/store/appStore.test.ts

Covers the store's write→refresh loop against real (fake-indexeddb) repos:
capture/amend/revoke updating folded entries, settings persistence, wipe, and the
`guard` behavior of setting `lastError` while rejecting.

### src/store/appStore.drive.test.ts

Mocks `src/drive/{auth,queue,pull,token}` to test only the store's Drive wiring:
`drainSync`'s no-token, pull-then-push success (combined `SyncResult`),
pull-reconnect (pill flipped, push skipped), pull-error-despite-push-success,
reconnect, and error branches, plus the connect→sync and disconnect flows.

### src/store/events.test.ts

Exercises the event repo end to end: per-stream monotonic seq allocation, contract
attachment naming and blob round-trips, queued sync rows with the correct initial phase,
fold behavior of amend/revoke, `wipeAll` (including seq-counter reset), and the
migration to v5 (id-keyed `events`/`sync` stores replacing `[stream, seq]`-keyed ones).

### src/store/events.sync.test.ts

Sync-specific edge case tests: `importEvents` marking pulled events as `uploaded` (never
re-pushed), seq counter bump correctness, idempotent re-import, blob keying by contract
filename, `listPendingSync` ordering by seq, exclusion of uploaded events from pending
queue, cross-device merge scenarios with seq collisions, and sequential multi-import
handling.

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
- **Pull before push.** `drainSync` always runs `pullStream` before `drainStream`;
  pulled events arrive `uploaded`/`done` so the drainer never re-pushes them.
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
