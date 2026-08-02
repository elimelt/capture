# Subsystem: Data model & sync

**Modules:** `src/contract` + `src/streams` + `src/store` + `src/drive`
(SPEC §3, §5, §8). This document covers cross-module design and flows; for
file-level detail see the module docs:

- [contract-and-streams.md](../modules/contract-and-streams.md) — event types, wire
  format, filenames, fold, stream registry
- [store.md](../modules/store.md) — IndexedDB repositories and the Zustand app store
- [drive.md](../modules/drive.md) — GIS auth, Drive client, bootstrap, upload queue,
  pull engine

Together these four modules implement the core of the app: a **generic,
offline-first, append-only event log** that is captured locally, replicated to the
user's Google Drive, and consumed both by the app's own UI (via the fold) and by
external chat-assistant skills that read the same files from Drive.

## 1. The append-only event log

Every stream (a named capture profile from `src/streams/registry.ts`; v1 ships only
`timelog`) is backed by an immutable log of events with schema `capture.event.v1`
(`src/contract/types.ts`). This is the system's foundational invariant (SPEC §3.2):

- **Three event types.** `capture` creates an entry; `amend` patches one or more
  prior captures (timestamp, location, attachment add/remove); `revoke` hides them.
  Nothing is ever edited or deleted in place — "edit" and "delete" are *new events*
  referencing earlier ids. Removed attachments and cleared locations remain in the
  log forever; they are only hidden from the folded view.
- **The fold is the read model.** `fold(events)` (`src/contract/fold.ts`) sorts by
  `compareEvents` (`seq` → `loggedAt` → `id`), applies amends to their targets
  (amends after a revoke are silently ignored; unknown targets are skipped), drops
  revoked entries, and returns `Entry[]` ordered by effective `capturedAt`. The
  fold is deterministic and order-insensitive to arrival order, so the app, every
  device replica, and Drive-reading skills compute identical state from the same
  events.
- **Identity is the event id; seq is an ordering hint** (SPEC §3.2 #3, "Design C").
  `src/store/events.ts` allocates `seq` from the IndexedDB `meta` counter
  `nextSeq:<stream>` inside the same transaction that writes the event, so seqs are
  monotonic and gap-free *per device* — but two devices appending offline can mint
  the same seq, so nothing is keyed by `[stream, seq]`. Event ids are 6-char random
  base36 (`ids.ts`) and are the unique key of the `events`/`sync` stores; seq
  collisions are resolved deterministically by the `loggedAt` → `id` tiebreak.
- **Filenames are the ordering.** Log files are named
  `<seq6>_<timestamp>_<id>[suffix].ext` (`filenames.ts`), partitioned by local date
  of `loggedAt`. A name-sorted Drive listing *is* log order, `seqOfFilename`
  recovers `seq`, and `idOfRecordName` recovers the id from record names alone — a
  skill needs no index, and the pull engine computes its missing set from a
  listing without reading any file it already holds.
- **Byte-stable wire format.** `serializeEvent` produces deterministic JSON (fixed
  key order, 2-space indent, trailing newline, optional fields omitted), so the
  bytes in Drive are reproducible and diff-friendly; `parseEvent` validates the
  envelope on the way back in.

The non-event contract files (`streams.json`, `config.json`, `checkpoint.json`,
`src/contract/files.ts`) round out the Drive contract. `config.json` and
`checkpoint.json` are **skill-owned**: the app writes them only as create-if-absent
stubs (see §5 on why) and never overwrites a skill's edits.

## 2. Write path: UI action → IndexedDB → upload queue → Drive

A capture (or amend/revoke) flows through four stages, each owned by one module:

```mermaid
sequenceDiagram
    participant UI as UI (capture / edit)
    participant AS as appStore (src/store)
    participant EV as events.ts (IndexedDB)
    participant P as pull.ts (src/drive)
    participant Q as queue.ts (src/drive)
    participant D as Google Drive

    UI->>AS: capture(input)
    AS->>EV: appendCapture(...)
    Note over EV: one readwrite txn:<br/>seq counter + event +<br/>blobs + sync row (queued)
    EV-->>AS: CaptureEvent
    AS->>AS: refresh() — refold entries
    Note over AS: entry stays queued locally until<br/>the user taps "Sync now" (Settings)
    AS->>P: drainSync() — manual "Sync now"; pull first
    P->>D: changes.list from persisted cursor (or full walk on cold start)
    P->>D: list dirty partitions, diff by id
    P->>D: fetch missing records + attachments
    P->>EV: importEvents(...) — atomic per partition
    AS->>Q: then push
    Q->>EV: listPendingSync(stream) — seq order
    Q->>D: ensureTree / ensurePartition
    loop each pending row
        Q->>D: mint file ids (generateIds, batched) → persist on row
        Q->>D: upload attachments (pre-generated id; 409 = ok)
        Q->>EV: phase = record-pending
        Q->>D: upload event .json — the commit
        Q->>EV: status = uploaded, phase = done
    end
```

Stage by stage:

1. **UI → store.** The Zustand app store (`src/store/appStore.ts`) is the single
   entry point: `capture`/`amend`/`revoke` actions delegate to the event repo, then
   `refresh()` to refold. Capture never needs a token or network — offline capture
   is the design center (SPEC §2).
2. **Atomic local append.** `events.ts#append()` commits the seq-counter increment,
   the event row, every attachment blob (keyed by its contract filename), and a
   `sync` row in **one IndexedDB transaction**. No partial appends can exist. The
   sync row starts `queued` with `phase: 'attachments-pending'` (or
   `'record-pending'` when there are no attachments).
3. **Sync cycle.** `drainSync` runs only from the manual "Sync now" button in
   Settings — sync is user-initiated, so Drive is contacted only on an explicit
   ask. With a valid token it runs one **pull-then-push** cycle: first
   `pullStream(token, stream)` (`src/drive/pull.ts`, §3) imports remote events, then
   `drainStream(token, stream)` (`src/drive/queue.ts`) processes pending rows **in
   seq order** so the Drive log commits monotonically.
4. **Drive tree + commit.** On first use (or a cache miss) the drainer runs
   `ensureTree` (`bootstrap.ts`): `timebox/` root, `streams.json`, and per stream a
   folder with `config.json`/`checkpoint.json` stubs, `log/`, and `results/` —
   every step finds-before-creates, with ids cached in `tree.ts` and everything
   tagged with app-private `appProperties` at creation. Then, per event: Drive
   file ids are minted client-side (`files.generateIds`, batched in `ids.ts`) and
   persisted on the sync row before any upload; attachments upload first, the
   event record `.json` last, each carrying its pre-generated id (a 409 means a
   prior attempt already landed — success). **The record is the commit** (SPEC
   §5.2): an event exists in Drive iff its record does. Orphan attachments from
   an interrupted upload reference nothing and are invisible to any fold.

After a successful upload, local audio blobs are pruned unless the stream's
`keepAudioLocally` setting says otherwise.

## 3. Pull path: Drive → IndexedDB (bidirectional sync)

The local log is a **replica** of the Drive log, not just its source. Every sync
cycle starts with `pullStream(token, stream)` (`src/drive/pull.ts`), which
converges the replica with Drive before anything is pushed:

1. **Discover.** One `changes.list` request from the per-stream cursor persisted
   in `meta` (`src/drive/changes.ts`) marks the partitions that gained record
   files since the last pull — a no-op pull is a single request no matter how old
   the log. Only the dirty partitions are then listed; each child's filename is
   parsed with `idOfRecordName`, and names that parse to an id already held
   locally (including everything this device just pushed) are skipped without a
   read; attachments, foreign files, and removed/trashed changes are ignored.
   Without a cursor — or when Drive rejects one (410 expiry, account switch) —
   discovery falls back once to the full walk (every `log/` partition folder and
   its children), minting a fresh cursor before the walk and persisting it after
   the pull succeeds, so no change window is ever skipped, at worst replayed.
2. **Fetch.** Download each missing event record, `parseEvent`-validate it
   (malformed records are skipped, never fatal), and **eagerly** download every
   attachment the event references that isn't already stored (tolerating pruned or
   still-uploading attachments — the record is the commit, so a referenced-but-
   absent attachment is a transient race, not corruption).
3. **Import.** `importEvents()` (`src/store/events.ts`) writes events + blobs in
   one transaction per partition, marks their sync rows `uploaded`/`done` (they
   came *from* Drive — the drainer must never re-push them), and bumps
   `nextSeq:<stream>` past every pulled seq so future local appends sort after.

Pull failures are classified exactly like the drainer's (§5): 401/403 →
`'reconnect'`, 429/5xx → `'retry-later'`, else `'error'`. A mid-pull failure keeps
everything already imported — re-pulling is idempotent because discovery is
id-based. A wiped or brand-new device rebuilds its whole local state from one
pull.

## 4. Read path: fold → entries → UI

Reads never consult Drive. The UI's entry list is always a fresh fold over the
local log: `listEntries(stream)` = `fold(listEvents(stream))`, cached in the app
store as `entries: Entry[]` alongside `syncStatuses` (per-event-id upload state for
the status badges) and `lastSyncAt` (persisted per stream in the `meta` store via
`getLastSyncAt`/`setLastSyncAt`, stamped only after a clean pull+push cycle). Every
write action ends in `refresh()`, which recomputes all three — the store never
mutates cached entries in place. Settings renders a local-only rollup of these:
`summarizeSyncStatuses` (`src/store/events.ts`) counts pending/errored sync rows
and surfaces the latest error message, and the status line shows "Out of sync"
whenever anything is pending or errored or no clean cycle has ever completed, plus
"Last synced …" / "Never synced" — visibility in place of automatic background
sync. Skills perform the mirror-image read on the Drive side: list `log/`
partitions past their checkpoint, parse records, and run the same fold.

## 5. Auth lifecycle and failure model

**Token flow (SPEC §8.2).** There is no backend, so there are no refresh tokens.
`src/drive/auth.ts` wraps the GIS token client: `connect()` — which **must run from
a user gesture** — requests a ~1-hour access token with the combined `GOOGLE_SCOPES`
set from `src/config.ts` (`drive.file` + `calendar.readonly` in one consent), and
persists it via `token.ts` to the IndexedDB `meta` store, so a relaunch within the
hour reuses the stored token when the user next taps "Sync now" — no new gesture
needed.
The same stored token authorizes the read-only Calendar client in `src/gcal`
([module doc](../modules/gcal.md)), which also mirrors the user's target-calendar
pick into the stream's `config.json` on Drive via a skill-edit-preserving
read-modify-write. Tokens are treated as expired **60 seconds early** so a drain
never starts with a token that dies mid-flight.

**Expiry and reconnect.** When the token is missing or stale, `drainSync` does not
attempt renewal (it can't — no gesture); it just refreshes `driveConnection` so the
passive `ReconnectPill` renders. Tapping the pill calls `connectDrive()` — the
gesture GIS needs — but connecting never auto-syncs; the user then syncs via "Sync
now". Capture is never blocked by auth: entries queue locally regardless.

**Failure classification.** Every Drive call throws `DriveError` with a status, and
`drainStream` (and `pullStream`, identically) maps it to an outcome the store
consumes:

| Failure | Queue behavior | Outcome → store reaction |
|---|---|---|
| 401 / 403 (`isAuth`) | row re-queued, drain stops | `'reconnect'` → `driveConnection: 'expired'` (pill) |
| 429 / 5xx (`isRetryable`) | row re-queued with `nextRetryAt` backoff | `'retry-later'` (silent; retried on next drain) |
| anything else | row marked `'error'`, drain stops | `'error'` → `lastError` toast |

Backoff is exponential per row: `min(30s × 4^(attempts−1), 1h)` — 30s, 2m, 8m, …
capped at an hour; rows whose `nextRetryAt` is in the future are skipped, and auth
errors bypass backoff entirely. `drainSync` merges the pull and push outcomes
worst-of (`idle < drained < retry-later < reconnect < error`), and a pull
`'reconnect'` skips the push (the token is dead either way). A fully clean cycle
(`idle`/`drained`) stamps `lastSyncAt`; reconnect/retry-later/error outcomes leave
it untouched. Offline is not a special case: capture works fully offline, and the
cycle simply runs on the next manual "Sync now" that finds a valid token.

## 6. Idempotency and crash safety

The subsystem is safe to interrupt at any point, by construction:

- **Local appends are transactional.** One IndexedDB transaction covers counter,
  event, blobs, and sync row (`events.ts`), so a crash leaves either a complete
  append or nothing — never a half-written entry.
- **Uploads are idempotent by pre-generated id.** Attachment and record names are
  computed once, at append time, from `seq`/`loggedAt`/`id`; the same name keys
  the local blob and the Drive file. The drainer mints Drive file ids client-side
  and persists them on the sync row *before* the first attempt, so a retried row
  (after crash, network drop, or backoff) re-uploads with the same id and Drive's
  409 counts as success — never duplicating anything already in Drive, without
  any find-before-upload requests. (Rows from older app versions that already
  attempted an upload keep the legacy `findFile` probe.)
- **The record-last protocol substitutes for transactions in Drive.** Drive has
  none, so commit is defined as "the `.json` record exists" (SPEC §5.2). Any
  interruption between attachment and record uploads leaves only orphans, which
  consumers must (and the fold trivially does) ignore.
- **The sync row's `phase` tracks protocol position** (`attachments-pending` →
  `record-pending` → `done`), so a resumed drain knows where it was; combined with
  find-before-upload, resuming from the wrong phase is still harmless.
- **Bootstrap is idempotent and self-healing.** `ensureTree` finds-before-creates
  every folder and file; the `tree.ts` id cache is advisory, and a cleared cache or
  user-deleted folder is recreated on the next drain. Skill-owned mutable files are
  stubbed only when absent, never clobbered — required because `drive.file` scope
  only lets the app see files it created, so the stub is what grants read-back.
- **Pulls are idempotent and atomic.** Discovery is by event id from filenames, so
  a re-pull skips everything already held; imports commit per partition in one
  transaction (events + blobs + counter bump), so an interrupted pull leaves only
  complete events, all of which the next pull skips. The changes cursor advances
  only after a fully successful pull and self-heals like the tree cache (missing,
  expired, or account-foreign cursors trigger one full walk + re-mint), so the
  Changes fast path can only replay work, never drop it.
- **The fold tolerates disorder.** It sorts by `compareEvents` and silently ignores
  unknown or already-revoked targets, so partial replication (e.g. a skill reading
  Drive mid-drain, or a pull racing an in-flight upload) still folds to a
  consistent subset of the log.

What is *not* guaranteed: seq uniqueness across devices (seq is a per-device
counter; collisions are expected under offline multi-device use and resolved by
the `loggedAt` → `id` fold tiebreak), event-id collision checks (random ids,
probabilistic uniqueness), and `wipeAll()` resets local seq counters to 1 — safe
only because the wipe also drops the local log, while Drive state is separate and
the next pull rebuilds the replica and re-bumps the counter.

## 7. Layering rules

SPEC §10 declares `streams/`, `capture/`, `contract/`, `drive/`, `store/` (and
friends) **stream-agnostic**: they must not import from the timelog-specific or
app-level modules `gcal/`, `dayview/`, `settings/`, or `assistant/`. This is
enforced mechanically by `src/layering.test.ts`, which parses import specifiers
from every file in the generic layers and fails on any that resolve into a
forbidden directory.

Within this subsystem the dependency direction is strictly one-way:

```
      contract  ◄──  streams
        ▲  ▲
        │  └──────────────────────────┐
  store repos  ◄──  drive (queue/token/tree use the event repo + meta store)
        ▲                ▲
        └── appStore ────┘  (orchestration: connect, drain, connection state)
```

- `contract/` depends on nothing else in `src/` — it is the shared language with
  external skills and stays domain-free (no timelog fields in the event schema).
- `streams/` imports only `contract` types; adding a stream is a registry entry,
  not an engine change.
- `store/` imports `contract` (fold, filenames, serial types) and `drive`
  (auth/token/queue for the appStore wiring); it stores assistant chats as opaque
  `unknown[]` precisely to avoid importing `assistant/`.
- `drive/` imports `contract` (file serializers, filenames) and `store` (event
  repo — including `importEvents` for pulls — and meta store); its only inbound
  consumers are `store/appStore.ts` and `App.tsx` (the reconnect pill).

The payoff is that the generic capture client — everything in this document — is
separable by construction: a second stream, or a fork without the timelog UI,
touches none of these modules.
