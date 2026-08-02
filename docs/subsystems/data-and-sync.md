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
  of `loggedAt`; batched segments (SPEC §5.7) lead with their seq *range* instead
  (`<minSeq6>-<maxSeq6>_<timestamp>_<firstId>.ndjson`) and sort at their min-seq
  position. A name-sorted Drive listing *is* log order, `seqOfFilename` recovers
  `seq`, and `idOfRecordName`/`parseSegmentName` recover the discovery id from
  names alone — a skill needs no index, and the pull engine computes its missing
  set from a listing without reading any file it already holds.
- **Byte-stable wire format.** `serializeEvent` produces deterministic JSON (fixed
  key order, 2-space indent, trailing newline, optional fields omitted), so the
  bytes in Drive are reproducible and diff-friendly; `parseEvent` validates the
  envelope on the way back in.

The non-event contract files (`streams.json`, `config.json`, `checkpoint.json`,
`src/contract/files.ts`) round out the Drive contract. `config.json` and
`checkpoint.json` are **skill-owned**: the app writes them only as create-if-absent
stubs (see §5 on why) and never overwrites a skill's edits.

### 1.1 The calendar-overlay log (second, skill-free append-only log)

Alongside the capture streams there is one more append-only log: **calendar
overlays** (stream `calendar-overlay`, schema `capture.calendar-overlay.v1` — SPEC
§3.6/§5.6), the Day view's local annotations over read-only Google Calendar events.
It follows the same log discipline — three verbs (`overlay`/`amend`/`revoke`),
byte-stable serialization, a deterministic fold ordered by seq → loggedAt → id, seq
allocated from the same `meta` `nextSeq:<stream>` counter mechanism — but it is
**not part of the skill contract**: no skill ever reads it, it has no
config/checkpoint/results protocol, and its events never leave the app's own
rendering path (and never touch Google Calendar — SPEC §1.2). Because it is
calendar-domain state, everything about it lives in `src/gcal/overlay/` (see
[gcal.md](../modules/gcal.md)); `src/store` only hosts the opaque `overlayEvents`
object store it persists into. Note the contrast with the *system streams* of §2a:
those reuse the `capture.event.v1` envelope and the `events`/`sync` stores, so
registering them in `allSyncStreams()` was enough to sync them — the overlay log
has its own schema and its own object store, so it is **not** in `allSyncStreams()`
and nothing about it participates in the pull/push cycle described below. The log
is **local-only for now**: appends write no `sync` rows, and wiring it into the
multi-stream sync engine (overlay-aware upload/pull over `overlayEvents` and
`capture.calendar-overlay.v1` records) is deferred follow-up work.

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
    loop each batch (run of same-partition rows; 1 → record, ≥2 → segment)
        Q->>D: mint file ids (generateIds, batched) → persist on rows
        Q->>D: upload attachments (pre-generated id; 409 = ok)
        Q->>EV: phase = record-pending
        Q->>D: upload event .json / segment .ndjson — the commit
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
   ask. With a valid token it loops over **every registered stream**
   (`allSyncStreams()` — see §2a) and runs one **pull-then-push** cycle per
   stream: first `pullStream(token, stream)` (`src/drive/pull.ts`, §3) imports
   remote events, then `drainStream(token, stream)` (`src/drive/queue.ts`)
   processes pending rows **in seq order** so the Drive log commits
   monotonically.
4. **Drive tree + commit.** On first use (or a cache miss) the drainer runs
   `ensureTree` (`bootstrap.ts`): `timebox/` root, `streams.json`, and per stream a
   folder with `config.json`/`checkpoint.json` stubs, `log/`, and `results/` —
   every step finds-before-creates, with ids cached in `tree.ts` and everything
   tagged with app-private `appProperties` at creation. Then, per commit unit:
   Drive file ids are minted client-side (`files.generateIds`, batched in
   `ids.ts`) and persisted on the sync row before any upload; attachments upload
   first, the committing log file last, each carrying its pre-generated id (a
   409 means a prior attempt already landed — success). A run of ≥ 2 pending
   events in the same date partition commits as **one sealed NDJSON segment**
   (SPEC §5.7) whose single pre-generated id is persisted on every member row,
   pinning the batch across crashed drains; a lone event keeps the per-event
   record. **The record/segment is the commit** (SPEC §5.2, §5.7): an event
   exists in Drive iff a log file carrying it does. Orphan attachments from an
   interrupted upload reference nothing and are invisible to any fold.

After a successful upload, local audio blobs are pruned unless the stream's
`keepAudioLocally` setting says otherwise.

## 2a. Multi-stream sync: capture streams + system streams

`drainSync` syncs **every registered stream on every cycle**, not just the one on
screen. The stream list is `allSyncStreams()` (`src/streams/registry.ts`):
`SYSTEM_STREAMS` (`'settings'`, `'assistant-chats'`) first, then every
`BUILTIN_STREAMS` id. System streams are append-only event logs with no capture
UI, no skill, and no `StreamDefinition` — they exist so app-level state syncs
through the same engine. `settings` is live: settings are event-sourced on it
(SPEC §3.7, `docs/modules/store.md`), so a save queues ordinary sync rows that
this loop pushes and a pull can change `getSettings()` output (which is why
`drainSync` re-runs `loadSettings()` after a cycle). `assistant-chats`' event
conventions land separately. This is an
intentional behavior change from the single-stream era: "Sync now" covers
everything, which is required for system streams (never `currentStreamId`) and a
strict improvement for any future second capture stream.

The loop is pure orchestration in `appStore.drainSync` — every engine primitive
it calls (`pullStream`, `drainStream`, and inside them `ensureTree`, the
per-stream changes cursor, id allocation) was already stream-parameterized, so
nothing in `src/drive/` changed. Rules:

- **Per stream: pull, then push**, exactly as before; each stream gets a
  `StreamSyncResult { stream, outcome, uploaded, pulled, error? }` in the
  returned `SyncResult.perStream`, and the aggregate `SyncResult` is the
  worst-of outcome with summed counts.
- **Failure isolation.** A `'reconnect'` (401/403) on any stream aborts the rest
  of the cycle immediately — the token is dead for every stream — and the
  skipped streams are marked `'reconnect'` in `perStream`. A `'retry-later'` or
  `'error'` on one stream does **not** block the others: each stream's Drive
  folders, sync rows, and `drive:changes:<stream>` cursor are
  independent.
- **Per-stream `lastSyncAt`.** Each stream's stamp is written only when *that
  stream's* pull+push completed cleanly (`idle`/`drained`), regardless of what
  happened to other streams in the same cycle.
- **Idle streams are cheap.** A stream with zero pending rows costs no
  upload-side Drive calls at all (`drainStream` returns before touching the
  tree), and its pull is the usual one `changes.list` request — so registering
  the empty system streams adds almost nothing to a cycle (regression-guarded in
  `src/drive/queue.test.ts`).

For the Settings status line, `refresh()` also computes an aggregate
`globalSyncSummary`: pending/error counts summed over all streams' sync rows,
plus `lastSyncAt` = the **oldest** per-stream stamp — the conservative
"everything is synced as of" figure — or `null` while any stream has never
completed a clean cycle.

## 2b. Live progress during a cycle

A manual cycle can push many attachments/records/batched segments across
several streams and pull remote changes, with nothing to show for it until it
finishes — an owner directive called this out directly ("syncing has GOT to
have a progress indicator"). `drainSync` keeps a live `syncProgress:
SyncProgress | null` (`appStore.ts`) up to date throughout, built by a pure
reducer, `reduceSyncProgress` (`src/store/syncProgress.ts`, module doc:
[store.md](../modules/store.md)), from a typed `SyncProgressEvent` stream:

- `drainSync` itself emits `cycle-start` once (with the stream count) and
  wraps each stream's pull-then-push pair in `stream-start`/`stream-done` — it
  already owns that loop, so `src/drive/pull`/`src/drive/queue` don't need to
  know their position across streams.
- `pullStream` emits `pull-progress` once per imported partition (the
  cold-start walk or a changes-feed dirty partition) — a page of events, never
  per event.
- `drainStream` emits `upload-start` once (the stream's pending count, so the
  UI can show a determinate bar) and `upload-progress` once per committed
  batch — a lone record or a whole sealed segment (SPEC §5.7), never per file
  inside one.

Both `pullStream` and `drainStream` take this `onProgress` callback as an
**optional** parameter defaulting to a no-op, so every pre-existing call site
and test is unaffected. `syncProgress` is cleared back to null when the cycle
ends (`drainSync`'s `finally`, alongside `syncing`) — it is live-only, never
persisted, and carries no error state of its own: a `'reconnect'`/
`'retry-later'`/`'error'` outcome still surfaces exactly as before (`lastError`,
the reconnect pill, `globalSyncSummary`), preserving the rule that failures
never get a quieter second channel. The Settings screen renders a live label
(`formatSyncProgress`) and a bar (`ProgressBar`, `src/ui` — determinate once
`itemsTotal` is known, an indeterminate sweep otherwise) while `syncing`; the
bottom nav shows the same bar, scaled down, on the Settings tab so progress on
a long sync stays visible from any screen — not just while Settings itself is
open (app-shell doc: [app-shell-ui-and-tooling.md](../modules/app-shell-ui-and-tooling.md)).

## 3. Pull path: Drive → IndexedDB (bidirectional sync)

The local log is a **replica** of the Drive log, not just its source. Every sync
cycle starts with `pullStream(token, stream)` (`src/drive/pull.ts`), which
converges the replica with Drive before anything is pushed:

1. **Discover.** One `changes.list` request from the per-stream cursor persisted
   in `meta` (`src/drive/changes.ts`) marks the partitions that gained event
   carriers — records or segments — since the last pull; a no-op pull is a single
   request no matter how old the log. Only the dirty partitions are then listed;
   each child's filename is parsed with `idOfRecordName`/`parseSegmentName`, and
   names whose discovery id is already held locally (including everything this
   device just pushed; a segment's first-member id stands for all its members —
   SPEC §5.8) are skipped without a read; attachments, foreign files, and
   removed/trashed changes are ignored. Without a usable cursor — first pull,
   wiped meta, the account-switch discard (§5), or a cursor persisted by a
   pre-segment engine (the value is format-versioned) — or when Drive rejects
   one (410 expiry), discovery falls back once to the full walk (every `log/`
   partition folder and its children), minting a fresh cursor before the walk
   and persisting it after the pull succeeds, so no change window is ever
   skipped, at worst replayed.
2. **Fetch.** Download each missing carrier — a record `parseEvent`-validated, a
   segment split and validated line by line (`parseSegment`; one malformed line
   fails the whole partition's import, so a segment never half-imports) — dedupe
   by event id, and **eagerly** download every attachment the events reference
   that isn't already stored (tolerating pruned or still-uploading attachments —
   the carrier is the commit, so a referenced-but-absent attachment is a
   transient race, not corruption).
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
write action ends in `refresh()`, which recomputes all of them — the store never
mutates cached entries in place. Settings renders a local-only rollup across every
registered stream: `refresh()` also computes `globalSyncSummary`
(`summarizeSyncStatuses` over all streams' sync rows + the oldest per-stream
`lastSyncAt`, §2a), and the status line shows "Out of sync" whenever anything is
pending or errored on any stream or any stream has never completed a clean cycle,
plus "Last synced …" / "Never synced" — visibility in place of automatic
background sync. Skills perform the mirror-image read on the Drive side: list `log/`
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
| 429 / 5xx (`isRetryable`) | row re-queued, drain stops | `'retry-later'` (retried on next drain) |
| anything else, row's `attempts` still below `MAX_ATTEMPTS_BEFORE_PARKED` | row marked `'error'`, drain stops | `'error'` → `lastError` toast |
| anything else, row's `attempts` at/above `MAX_ATTEMPTS_BEFORE_PARKED` | row marked `'error'` and **parked**, drain continues past it | `'error'` (unless a later batch also failed worse) → `lastError` toast |

There is deliberately no per-row retry backoff: sync runs only from the manual
"Sync now" button, so every drain is an explicit user ask and attempts every
queued row — the user is the rate limiter. (Older versions persisted a
`nextRetryAt` window and skipped rows inside it while reporting the drain
clean, which presented as entries stuck "queued" forever; the drainer now
ignores any legacy `nextRetryAt` still on a row.)

**Poison-row parking (issue #87).** Stopping the whole drain on the first
failure protects the seq-monotonic commit order (§6.2's checkpoint contract
relies on it — a `seq > N` cursor). But a row whose failure is *deterministic*
(a malformed/oversized attachment, a stale cached partition id — anything that
isn't a Drive-side outage) sorts first again on every subsequent drain, so
stopping on it forever starved every row queued behind it — this got worse
once the backoff gate above was removed, since a row like this used to
eventually fall out of rotation on its own. `src/drive/queue.ts` bounds this:
once a row's `attempts` reaches `MAX_ATTEMPTS_BEFORE_PARKED` (5) on the
non-retryable-non-auth path, the drain records the failure exactly as before
(still visibly `'failed'` on the entry card — `src/capture/lifecycle.ts`) but
*continues* to the rows behind it instead of returning, and never batches a
parked row into a segment with a healthy neighbor (which would otherwise fail
the whole segment every time). A parked row is still attempted on every future
drain — no backoff gate, same as any other row — it just can't block anything
else. It also never lands out of turn: a parked row doesn't get retried ahead
of where it sits, and nothing behind it is allowed to overtake it *before* it
first parks, so whatever *does* land keeps landing in seq order. The one gap
this doesn't close: a row already grouped into a persisted segment assignment
with other members (crash-recovery, above) before it started failing stays
grouped — that shared-segment case needs manual resolution (revoke the poison
entry) rather than self-healing. `drainSync` merges each stream's pull and push
outcomes worst-of (`idle < drained < retry-later < reconnect < error`), then the
per-stream outcomes worst-of into the aggregate; a `'reconnect'` anywhere skips
that stream's push and aborts the remaining streams (the token is dead either
way), while retry-later/error stay stream-local (§2a). A stream's fully clean
cycle (`idle`/`drained`) stamps *its* `lastSyncAt`; reconnect/retry-later/error
outcomes leave it untouched. Offline is not a special case: capture works fully
offline, and the cycle simply runs on the next manual "Sync now" that finds a
valid token.

**Account switching.** The GIS account chooser lets a user grant a *different*
Google account, and several pieces of local state are only meaningful on the
account that minted them: the `tree.ts` id cache, the per-stream changes cursors,
and pre-generated upload file ids (the in-memory pool and sync rows' `fileIds`).
`src/drive/account.ts` binds them all to the granting account's stable
`user.permissionId` (`about.get`, one request per token per session), persisted in
`meta` (`drive:account`). Both `pullStream` and `drainStream` (and `ensureTree`
itself) verify the binding before reading any of that state; on a mismatch the
whole set is silently discarded — exactly as if the device had never
bootstrapped — and the new identity stored, so the next cycle re-bootstraps the
tree and cold-starts the pull with a full listing walk. No error surfaces; the
only cost is that one-time re-bootstrap/walk. A first-ever grant (no stored
identity, including upgrades from versions predating the binding) binds without
discarding, and disconnect/reconnect with the *same* account keeps every cache
warm. The local event log itself is deliberately **not** discarded: it is the
app's data, not a per-account cache — still-pending events push to the newly
connected account, and its remote log pulls in and merges via the fold.

## 6. Idempotency and crash safety

The subsystem is safe to interrupt at any point, by construction:

- **Local appends are transactional.** One IndexedDB transaction covers counter,
  event, blobs, and sync row (`events.ts`), so a crash leaves either a complete
  append or nothing — never a half-written entry.
- **Uploads are idempotent by pre-generated id.** Attachment and record names are
  computed once, at append time, from `seq`/`loggedAt`/`id`; the same name keys
  the local blob and the Drive file. The drainer mints Drive file ids client-side
  and persists them on the sync row *before* the first attempt, so a retried row
  (after a crash, network drop, or failed drain) re-uploads with the same id and Drive's
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
  user-deleted folder is recreated on the next drain. The cache is also bound to
  the granting Google account (`account.ts`, §5): a token from a different account
  discards it before any cached id could be merged or reused. Skill-owned mutable
  files are stubbed only when absent, never clobbered — required because
  `drive.file` scope only lets the app see files it created, so the stub is what
  grants read-back.
- **Pulls are idempotent and atomic.** Discovery is by event id from filenames, so
  a re-pull skips everything already held; imports commit per partition in one
  transaction (events + blobs + counter bump), so an interrupted pull leaves only
  complete events, all of which the next pull skips. Segments import all-or-none
  and dedupe line-by-line, so overlap with already-held events is harmless. The
  changes cursor advances only after a fully successful pull and self-heals like
  the tree cache (missing, expired, or pre-segment-format cursors trigger one
  full walk + re-mint; account-foreign ones are cleared up front by the §5
  account-switch discard), so the Changes fast path can only replay work, never
  drop it.
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
- `store/` imports `contract` (fold, filenames, serial types), `drive`
  (auth/token/queue for the appStore wiring), and `streams`
  (`allSyncStreams()` for the multi-stream sync loop); it stores assistant chats
  as opaque `unknown[]` precisely to avoid importing `assistant/`.
- `drive/` imports `contract` (file serializers, filenames) and `store` (event
  repo — including `importEvents` for pulls — and meta store); its only inbound
  consumers are `store/appStore.ts` and `App.tsx` (the reconnect pill).

The payoff is that the generic capture client — everything in this document — is
separable by construction: a second stream, or a fork without the timelog UI,
touches none of these modules.
