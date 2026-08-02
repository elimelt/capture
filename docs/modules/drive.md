# Module: `src/drive`

The Google Drive sync layer. It owns everything between the local IndexedDB stores
(`src/store/`) and the user's Drive: OAuth token acquisition and persistence, the
idempotent bootstrap of the `timebox/` folder tree, a cached map of Drive file ids, the
pull engine that replicates remote events into the local log, the upload-queue drainer
that pushes captured events to Drive, and the passive "Reconnect Google" UI pill.
There is no backend: auth uses the Google Identity Services (GIS) token flow
(short-lived ~1h access tokens, no refresh tokens), and all Drive calls are plain
`fetch` against the Drive v3 REST API with a Bearer token — no `gapi` client.

Data flow: `auth.ts` obtains a token (user gesture) → `token.ts` persists it →
`account.ts` verifies the token still belongs to the account the local caches are
bound to (discarding them on a switch) → `bootstrap.ts` ensures the Drive folder
tree exists, caching ids via `tree.ts` → `pull.ts` imports remote events the local
replica lacks (discovering them through the Changes API, resuming from the cursor
persisted by `changes.ts`), then `queue.ts` drains pending sync rows with
pre-generated file ids (`ids.ts`) — both through `client.ts` primitives, tagging
everything created via `tags.ts`. Both `pull.ts` and `queue.ts` take an optional
`onProgress` callback typed by `SyncProgressEvent` (`src/store/syncProgress`) so a
long cycle (many attachments/records/batched segments across streams) can report
live progress; the orchestration (when to
connect, when to sync; always pull-then-push) lives in `src/store/appStore.ts`, which
is the only consumer of `connect`/`disconnect`/`pullStream`/`drainStream`;
`src/App.tsx` renders `ReconnectPill`.

## File-by-file

### src/drive/token.ts

Access-token persistence and expiry logic — the pure, testable storage layer under
`auth.ts`. Tokens are mirrored to the IndexedDB `meta` store (key `drive:token`) so a
relaunch within the hour reuses them.

Key exports:

- `interface DriveToken { accessToken: string; expiresAt: number }` — `expiresAt` is epoch ms.
- `type DriveConnection = 'connected' | 'expired' | 'disconnected'` — state for the reconnect pill.
- `getStoredToken(): Promise<DriveToken | undefined>` / `saveToken(token)` / `clearToken()` — CRUD against the `meta` store.
- `tokenValid(token: DriveToken | undefined, now = Date.now()): token is DriveToken` — type-guard.
- `getValidAccessToken(now = Date.now()): Promise<string | undefined>` — stored token if unexpired.
- `connectionState(now = Date.now()): Promise<DriveConnection>` — `disconnected` if no token, `expired` if stale, else `connected`.

Invariants: a token is treated as expired **60 seconds early** (`SKEW_MS = 60_000`) so
an in-flight queue drain never hits a 401 mid-way. All validity checks accept an
injectable `now` for testing. Renewal is not this module's job — it requires a user
gesture and lives in `auth.ts`.

### src/drive/auth.ts

Wrapper around the GIS token flow (`google.accounts.oauth2`). The GIS script is loaded
from `index.html`; this module declares a minimal ambient type for the global (no
`@types` package) and polls up to 10s for it to appear (`waitForGis`).

Key exports:

- `DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'` — the only scope requested; the app can see and touch only files it created.
- `connect(prompt = ''): Promise<DriveToken>` — requests an access token. **Must be called from a user gesture.** Default `prompt: ''` lets GIS skip the account chooser when possible (quiet renewal from the reconnect pill); pass `'consent'` to force the chooser. On success the token is persisted via `saveToken` before the promise resolves; expiry is computed from `expires_in` (default 3600s). Rejects with `error_description`/`error` on GIS failure.
- `disconnect(accessToken?: string): Promise<void>` — best-effort `oauth2.revoke` at Google (2s GIS wait, failures swallowed), then always `clearToken()` locally.

Invariants: a single `TokenClient` is lazily created and reused across `connect` calls
(`client ??= …`); the per-call callback is swapped in before each `requestAccessToken`.
`GOOGLE_CLIENT_ID` comes from `src/config`. All other auth state lives in `token.ts`.

### src/drive/client.ts

Thin Drive API v3 layer over `fetch` + Bearer token — only the primitives the upload
engine needs. All writes stay under `timebox/`, which `drive.file` scope both permits
and confines the app to.

Key exports:

- `class DriveError extends Error` — carries `status: number`; getters `isAuth` (401/403 → stop and reconnect) and `isRetryable` (429 or ≥500 → back off and retry). Thrown by every helper on a non-OK response, with the message extracted from the JSON error body when available.
- `FOLDER_MIME = 'application/vnd.google-apps.folder'`.
- `findFile(token, { name, parentId, mimeType? }): Promise<string | null>` — id of first match or `null`. Query values are escaped (`\` and `'`) and always filtered by `trashed = false`.
- `createFolder(token, name, parentId, appProperties?): Promise<string>`.
- `generateIds(token, count): Promise<string[]>` — mint Drive file ids client-side (`files.generateIds`, `space=drive`). Valid for blob files only, never folders.
- `uploadFile(token, { name, parentId, mimeType, body, fileId?, appProperties? }): Promise<string>` — multipart (`multipart/related`, hand-built boundary) for bodies ≤ 5 MB; resumable (init POST → PUT to the returned `location` session URL) above `RESUMABLE_THRESHOLD` (5 MiB). Throws `DriveError` if the resumable init returns no session URL. `fileId` (a pre-generated id) and `appProperties` ride the create metadata on both paths; **when `fileId` is set, a 409 response is returned as success** — the exact file already landed on a previous attempt.
- `readFileText(token, fileId): Promise<string>` — `alt=media` download (checkpoint/results read-back, event-record pull).
- `readFileBlob(token, fileId): Promise<Blob>` — `alt=media` download as a `Blob` (attachment pull).
- `interface DriveChild { id; name; mimeType: string }` — one child of a folder listing.
- `listChildren(token, parentId): Promise<DriveChild[]>` — every non-trashed child of a folder, following `nextPageToken` pagination (`pageSize` 1000). Used by the pull path to list dirty partitions (and, on cold start, `log/` itself); because filenames lead with the zero-padded seq and embed the id (§5.1), the names alone answer discovery without opening a file.
- `getFileMetadata(token, fileId): Promise<FileMetadata>` — one file's `id, name, mimeType, parents`; the pull path resolves a changed record's uncached parent partition with it.
- `getAboutUser(token): Promise<AboutUser>` — `about.get?fields=user(permissionId)`: the authorizing account's stable, email-change-proof id (`drive.file` scope suffices; one cheap metadata request). Used by `account.ts` to bind local caches to the account that minted them. Throws `DriveError` 500 if Drive returns no identity.
- `getStartPageToken(token): Promise<string>` — the changes cursor for "everything from now on".
- `listChanges(token, pageToken): Promise<ChangeList>` — drains the changes feed from a cursor, following `nextPageToken` pagination, returning `{ changes: DriveChange[], newStartPageToken }`. Pins `spaces=drive` and `restrictToMyDrive=true`; with `drive.file` scope the feed only ever contains app-created files. Throws `DriveError` 410 when the cursor expired (caller falls back to a full listing).
- `updateFileContent(token, fileId, mimeType, body): Promise<void>` — `PATCH …?uploadType=media`, overwriting content in place. Used only for the app-owned `config.json`; the immutable `log/` is never updated this way.

### src/drive/space.ts

Read-only Drive storage accounting for the Settings "Data" section (SPEC §4.3).
Deliberately self-contained — its own small `fetch` helper mirroring client.ts's
conventions, sharing only the `DriveError` classification — so it can evolve
independently of the upload/pull primitives.

- `interface DriveSpace { usageBytes; limitBytes?; appBytes: number }` —
  account-wide usage, the account quota (`limitBytes` absent on unlimited plans),
  and this app's own footprint.
- `fetchDriveSpace(token): Promise<DriveSpace>` — one on-demand check: the account
  quota from `about.get?fields=storageQuota` (`drive.file` is a sufficient scope;
  Drive returns int64s as strings) in parallel with a paginated `files.list`
  (`trashed = false`, `pageSize` 1000) summing `quotaBytesUsed` — under `drive.file`
  the listing only ever contains files the app created, so the sum is exactly the
  app's Drive usage. Failures throw `DriveError` (401/403 → reconnect messaging in
  Settings). Callers fetch on a user tap, never on a timer.

### src/drive/ids.ts

Pre-generated file-id allocator over `client.generateIds`. Ids are fetched in
batches (`BATCH_SIZE = 10`) into an in-memory pool and handed out one upload at a
time — one minting request per ten files instead of one find-before-upload GET per
file. Unused pooled ids are simply forgotten on reload (Drive never reserves
them); ids *assigned* to an upload are persisted on the sync row (see queue.ts)
before the upload starts, which is what makes retries idempotent.

Key exports:

- `allocateIds(token, count): Promise<string[]>` — take `count` ids, refilling the pool in batches as needed (a single oversized request when `count > BATCH_SIZE`).
- `resetIdPool(): void` — forget pooled ids. Called on a Google-account switch (`account.ts` — pooled ids were minted with the old account's token) and by tests.

### src/drive/account.ts

Google-account identity binding for the account-bound local caches (issue #32).
The tree id cache (tree.ts), the per-stream changes cursors (changes.ts), and
pre-generated upload file ids (ids.ts pool + sync-row `fileIds`) are only
meaningful on the account that minted them; after an account switch they would
point at the *old* account's files — worst case a retried upload reusing an old
id gets Drive's 409 answer (globally-unique ids), which the client counts as
success while the new account's Drive received nothing. Local state is therefore
bound to the account's stable `user.permissionId` (`client.getAboutUser`),
persisted in the `meta` store under `drive:account`.

Key exports:

- `ensureAccountBound(token): Promise<boolean>` — verifies `token` belongs to the bound account (one `about.get` per token per session, memoized). On mismatch, discards all account-bound state exactly as if the device had never bootstrapped — `clearTree()`, `clearAllChangesTokens()`, `stripPendingFileIds()` (store/events), `resetIdPool()` — then stores the new identity; returns `true` iff a switch was detected so callers holding pre-read rows know to re-read. A first-ever grant (no stored identity, e.g. upgrading from a version predating the binding) binds without discarding. Gates every read of account-bound state: called by `bootstrap.ensureTree`, `pullStream`, and `drainStream`. Throws `DriveError` on `about.get` failure, which those callers already classify (401/403 → reconnect, 429/5xx → retry-later).
- `getStoredAccountId(): Promise<string | undefined>` / `saveAccountId(id)` — `meta`-store CRUD.
- `resetAccountMemo(): void` — test hook for the per-session memo.

Invariants: the binding deliberately survives `disconnect`/reconnect —
reconnecting the same account must keep its caches warm — and is only erased by
`wipeAll()` (which drops the caches with it). The discard is silent self-healing:
no error surfaces; the next sync just pays the normal re-bootstrap and
full-listing-walk cost.

### src/drive/tags.ts

The `appProperties` tagging scheme for everything the app creates on Drive. Tags
are set at creation time (free — part of the create request) and are app-private
under `drive.file`. They exist to make cold-start discovery a single `files.list`
query in the future; they are **advisory**: files created by older app versions
carry none, so no code path may require them for correctness (the pull path only
uses them as a fast-path stream filter).

Key exports:

- `TAG_KIND = 'captureKind'` / `TAG_STREAM = 'captureStream'` — the two keys ("capture" matches the app's current name and the `capture.event.v1` schema namespace; only the pre-existing on-Drive `timebox/` folder keeps the old name).
- `type TagKind` — `'root' | 'registry' | 'stream' | 'log' | 'results' | 'config' | 'checkpoint' | 'partition' | 'record' | 'segment' | 'attachment'`.
- `tags(kind, stream?): Record<string, string>` — builds one file's appProperties.

### src/drive/changes.ts

Changes-feed cursor persistence in the IndexedDB `meta` store, one key per stream
(`drive:changes:<stream>`) since each stream's pull consumes the account-wide feed
independently. Like the tree cache the cursor is advisory and self-healing: a
missing, expired (410), or otherwise unusable cursor just means one full listing
walk, after which a fresh cursor is minted and persisted. Cursors are
account-bound, so a Google-account switch clears them all up front (`account.ts`)
rather than waiting for Drive to reject them.

The persisted value is **format-versioned** (`{ format: 2, token }` — SPEC §5.8):
a cursor advanced by an engine that couldn't read some log-file grammar has
skipped those files' changes for good, so bumping `CURSOR_FORMAT` declares every
older cursor unusable. Format 2 = the engine reads batched log segments (§5.7); a
format-1 cursor (a bare token string, persisted by pre-segment app versions) reads
as absent, forcing one full walk that recovers any segments the old engine
ignored.

Key exports:

- `getChangesToken(stream)` / `saveChangesToken(stream, token)` / `clearChangesToken(stream)` — `meta`-store CRUD; `getChangesToken` returns `undefined` for a legacy or wrong-format value.
- `clearAllChangesTokens()` — drop every stream's cursor at once (the account-switch discard, `account.ts`).

### src/drive/tree.ts

Cache of Drive file ids in the IndexedDB `meta` store (key `drive:tree`). Because
`drive.file` only shows files the app created, ids are remembered at mint time to skip
repeated `findFile` lookups on every drain. The cache is **advisory**: bootstrap always
tolerates a miss by re-finding or re-creating, so a cleared cache or user-deleted
folder self-heals on the next bootstrap. It is also **account-bound**: `account.ts`
clears it (via `clearTree`) when a token from a different Google account shows up, so
stale wrong-account ids never reach `ensurePartition` or the pull path.

Key exports:

- `interface DriveTree { rootId: string; streams: Record<string, StreamTree> }`.
- `interface StreamTree { folderId; logId; resultsId: string; partitions: Record<string, string> }` — `partitions` maps `"YYYY-MM-DD"` to the date-folder id under `log/`.
- `getTree()` / `saveTree(tree)` / `clearTree()` — `meta`-store CRUD.
- `emptyStreamTree(folderId, logId, resultsId): StreamTree` — subtree with empty `partitions`.

### src/drive/bootstrap.ts

Idempotent creation of the Drive tree: `timebox/` root, the `streams.json` registry,
and per stream a folder containing `config.json` + `checkpoint.json` stubs, `log/`, and
`results/`. Stub contents come from `src/contract/files` serializers.

Key exports:

- `ensureTree(token: string, streams: string[]): Promise<DriveTree>` — ensures the whole tree, persists the id cache via `saveTree`, and returns the up-to-date `DriveTree`. Re-running merges with the cached tree: already-bootstrapped streams keep their `partitions` ids; newly requested streams are added. The merge is account-safe: `ensureAccountBound` (account.ts) runs first, so after a Google-account switch the stale cache is discarded before anything is merged and the whole tree is rebuilt fresh.

Invariants and edge cases:

- Every step **finds before creating** (`ensureFolder`, `ensureFile`), so re-runs create nothing new. Everything created is tagged with `appProperties` (tags.ts) at creation time.
- Mutable stubs (`config.json`, `checkpoint.json`) are written only when absent — never clobbering edits made by a processing skill. `ensureFile` deliberately returns nothing; these files are re-addressed by name at read time.
- `streams.json` is created if absent but **left as-is when present**: v1 only bootstraps `timelog`, so the set never shrinks and a rewrite path is deferred.
- The root folder is created under the special Drive parent id `'root'`.

### src/drive/queue.ts

The upload-queue drainer. Processes a stream's pending sync rows (from
`src/store/events`) in seq order via the atomic-append protocol: attachment blobs
first, the committing log file last. A run of **two or more** pending events in
the same date partition commits as one sealed NDJSON **segment** (SPEC §5.7); a
lone pending event keeps the per-event record path — either way, **the
record/segment is the commit**.

Key exports:

- `type DrainOutcome = 'idle' | 'drained' | 'reconnect' | 'retry-later' | 'error'`.
- `interface DrainResult { outcome: DrainOutcome; uploaded: number; error?: string }` — `uploaded` counts events (not files); `error` is set only for the `'error'` outcome.
- `drainStream(token: string, stream: string, onProgress?: (event: SyncProgressEvent) => void): Promise<DrainResult>` — drains one stream with a valid access token, bootstrapping the tree (`ensureTree`) on first use or when the stream is missing from the cache. When rows are pending it first verifies the account binding (`ensureAccountBound` — usually a memoized no-op since `pullStream` ran earlier in the cycle); a detected switch strips the rows' old-account `fileIds` (per-event and segment-assignment keys alike), so the pending set is re-read before draining. Stripped rows that had already attempted an upload are indistinguishable from legacy rows, so their retry takes the cautious per-event probe path (probes miss on the new account and fresh ids are minted) rather than re-forming a segment. `onProgress` (default a no-op — every existing caller/test is unaffected) is called once with `{ kind: 'upload-start', stream, itemsTotal }` (the pending count, only when there's anything to upload) and then once per committed batch with `{ kind: 'upload-progress', stream, delta }` (a lone record or a whole segment — never per file inside one); it feeds `src/store/syncProgress`'s reducer, which is the only thing that interprets these events.

Invariants and edge cases:

- **Idempotent by pre-generated id**: file ids are minted client-side (ids.ts) and persisted on the sync row (`fileIds`, keyed by contract filename) *before* the first upload attempt; a retried row re-uploads with the same id and Drive's 409 answer counts as success (client.ts), so nothing duplicates and no find-before-upload requests are made. Uploads carry `appProperties` tags (tags.ts) — segments the `'segment'` kind.
- **Batch planning** (`planBatches`): queued rows group into commit units — runs of consecutive same-partition rows (≥ 2 → a new segment, 1 → the per-event record path). Batches process in first-seq order, so the log still commits monotonically, and a burst spanning midnight splits at the partition boundary.
- **Segment crash-retry** (`uploadSegment`): one pre-generated id per segment, persisted on *every* member row under the segment filename before anything uploads — this assignment pins the batch's membership, name, and id. A crashed or failed drain regroups rows by their persisted assignment (never by recomputing), so every retry window resolves: no file yet → re-upload with exactly the assigned rows; file landed but rows unmarked → 409-as-success, marking finishes. Even a lone unmarked member re-commits through the segment path rather than minting a duplicate per-event record. A batch fails as a unit — every member row records the attempt and error.
- **Legacy rows keep the old probe and are never batched**: a row written by an older app version that already attempted an upload (no `fileIds`, and `attempts > 0` — or `phase === 'record-pending'` *for an event with attachments*, since a no-attachment row starts at that phase) may have files on Drive under names we hold no ids for — those rows keep the find-before-upload `findFile`, alone, so a retry never duplicates them. Without the attachments refinement, every fresh revoke/amend/no-attachment event would misread as legacy and never batch.
- **Every queued row is attempted on every drain — no backoff gate.** Sync is manual-only, so each drain is an explicit user ask and must never be silently skipped. (Older versions persisted a `nextRetryAt` backoff stamp and skipped rows inside the window while still reporting the drain clean, which left entries "queued forever"; legacy rows may still carry the field, and the drainer ignores it.)
- If the local event was erased out-of-band, the row is marked `uploaded`/`done` and dropped. If an attachment blob is missing (pruned or never stored), it is skipped and the record still commits the entry.
- Between attachments and the record/segment, the row's `phase` is advanced to `'record-pending'`.
- Failure classification (via `DriveError`): auth (401/403) → batch rows re-queued, drain stops, outcome `'reconnect'`; retryable (429/5xx) → batch rows re-queued, drain stops, outcome `'retry-later'` (the next "Sync now" retries them immediately, re-planning the batch from the persisted assignment); anything else → batch rows marked `'error'` and, below `MAX_ATTEMPTS_BEFORE_PARKED`, the drain stops (outcome `'error'`). In every failure path `attempts` is incremented and the message stored on the rows.
- **Poison-row parking (issue #87).** A batch that keeps failing the non-retryable-non-auth way (a malformed/oversized attachment, a stale cached partition id, any deterministic non-Drive-outage cause) used to stop the *whole* drain on every call, forever: `planBatches` always puts the lowest-seq pending row(s) first, so a permanently-failing row at the front starved every row queued behind it — worse after #90 removed the backoff gate that used to let such a row eventually fall out of rotation. Once a row's `attempts` reaches `MAX_ATTEMPTS_BEFORE_PARKED` (5) it is **parked**: the drain records the failure (still visibly `'failed'` — `error` is set, see `src/capture/lifecycle.ts`) and *continues* to the batches behind it instead of returning, and `planBatches` keeps a parked row solo (like a legacy row) so it can never drag a healthy neighbor into a doomed segment. A parked row is still attempted on every subsequent drain (no backoff gate, same as any other row) and keeps showing as failed; it just can no longer block anything else. The call's outcome is `'error'` if any batch was parked, even when later batches drained cleanly, so `lastSyncAt` is never stamped over an unresolved failure. **Residual limitation**: parking doesn't help a row whose *segment assignment* was already persisted (by a crashed prior drain) together with other members before it started failing — `planBatches` regroups by that pinned assignment unconditionally (crash-recovery correctness, above), so a poisoned shared segment still needs manual resolution (revoke the poison entry) rather than self-healing. Parking also deliberately never reorders what lands on Drive relative to what's parked: a parked row is not retried out of turn and never "catches up" past a higher-seq row that already landed — it simply keeps failing in place, preserving the seq-monotonic commit order external skills rely on (`docs/subsystems/data-and-sync.md` §2, §6.2 in `SPEC.md`) for anything that *does* land.
- After a successful upload, local audio blobs are deleted unless the stream's `keepAudioLocally` setting is true (`pruneAudio`); the row's stale `error` (if any, from an earlier failed attempt of the same row) is also cleared on success, so a since-recovered row never keeps reading as failed (`src/capture/lifecycle.ts#entryLifecycle`).
- Date-partition folders under `log/` are ensured lazily per batch (`ensurePartition`) and their ids cached in the tree. Folders keep find-before-create — pre-generated ids apply to blob files only.

### src/drive/pull.ts

The pull engine (SPEC §8.5) — the read half of bidirectional sync. Discovers event
carriers — per-event records **and batched segments** (SPEC §5.7) — the local
replica lacks via the Drive **Changes API** (one `changes.list` from the persisted
per-stream cursor — changes.ts — marks partitions dirty), lists only the dirty
partitions, downloads the missing carriers plus every referenced attachment blob
(eager: full offline availability), and imports them atomically via
`src/store/events#importEvents`. A no-op pull is a single request regardless of how
many date partitions the log has accumulated.

Key exports:

- `type PullOutcome = 'idle' | 'pulled' | 'reconnect' | 'retry-later' | 'error'`.
- `interface PullResult { outcome: PullOutcome; pulled: number; error?: string }` — `pulled` counts events imported; `error` is set only for the `'error'` outcome.
- `pullStream(token: string, stream: string, onProgress?: (event: SyncProgressEvent) => void): Promise<PullResult>` — pulls one stream's remote log into the local replica, bootstrapping the tree (`ensureTree`) when the cache lacks the stream. Verifies the account binding first (`ensureAccountBound`, account.ts), so a switched account cold-starts against a clean slate instead of reading the old account's tree/cursor. `onProgress` (default a no-op) is called with `{ kind: 'pull-progress', stream, delta }` once per imported partition — a page of events on the cold-start walk or a changes-feed dirty partition, never per event — whenever that page imported at least one event.

Invariants and edge cases:

- **Changes tell us where to look; filenames still answer what's new.** Only a carrier-named file (a record per `idOfRecordName`, or a segment per `parseSegmentName`) whose *discovery id* isn't local marks its parent partition dirty — our own pushes (ids already local), attachments, foreign files, and removed/trashed changes cost zero follow-up requests. A segment's discovery id is its first member's id, which stands for all members: segments commit and import as a unit, so holding the first event implies holding them all (SPEC §5.8). A carrier in an uncached partition costs one `getFileMetadata` to confirm the parent is a `YYYY-MM-DD` folder under this stream's `log/` (warming the push path's cache); `appProperties` tags, when present, short-circuit records of other streams for free. Deletions never un-import — the log is append-only.
- **Cursor lifecycle.** No usable cursor (first pull, wiped meta, the account-switch discard, or a format-1 cursor persisted by a pre-segment app version — changes.ts) → cold start: `getStartPageToken` *before* a full per-partition listing walk, cursor persisted only *after* the walk succeeds. Drive rejecting the cursor with any non-auth, non-retryable status (410 expired; any other unusable-cursor 4xx) → drop it, cold start again. The incremental cursor also advances only after a fully successful pull, so a mid-pull failure replays the same change window — no change is ever skipped, at worst replayed, and replays are idempotent.
- **Within a dirty partition, discovery is by filename** — same as the cold-start walk: record/segment names yield their discovery ids, so the missing set (ids not in `listEvents`) is computed from listings alone — no file reads for events already held. Foreign files and folders are ignored.
- **Segments import as a unit.** A missing segment downloads once, splits via `parseSegment`, and its lines dedupe by event id against everything already held (covering overlap between a segment and an already-imported single). One malformed line throws before the partition's import transaction — a bad segment imports none of its lines, never half (SPEC §5.8 #6).
- **Eager attachment download.** For each missing event, every referenced attachment blob not already local is fetched (segment members reference their attachments by their own per-event names). One missing on Drive (pruned, or a §5.2 push race — the carrier commits last) is skipped and picked up on a later pull.
- **Atomic import per partition.** Events + blobs commit in one IndexedDB transaction; pulled events get sync status `uploaded` (the drainer never re-pushes them) and the per-stream seq counter jumps past every pulled seq.
- **Events claiming another stream** (a `stream` field not matching the folder they sit in) are skipped.
- **Partition-id side benefit**: discovered partition folders are written into the `tree.ts` cache, warming the push path.
- Failure classification matches the drainer: 401/403 → `'reconnect'`, 429/5xx → `'retry-later'`, anything else (including a malformed record failing `parseEvent`) → `'error'` with the message. A mid-pull failure loses nothing — partitions already imported stay imported, and the next pull resumes from the smaller missing set.
- **Idempotent**: re-pulling skips known ids; blob re-writes overwrite with identical bytes.

### src/drive/ReconnectPill.tsx

Passive "Reconnect Google to sync" pill. Exports `ReconnectPill()`, a React component
that renders only when the app store's `driveConnection` is `'expired'` — connected and
disconnected states show nothing (first-time connection lives in Settings). Tapping
calls the store's `connectDrive` action (which wraps `auth.connect` — the user gesture
GIS requires); the button is disabled and reads "Reconnecting…" while `syncing` is true.
Never a blocking modal. Rendered by `src/App.tsx`.

### Test files

- `src/drive/token.test.ts` — verifies token round-trip/clear against fake IndexedDB, the 60s expiry-skew behavior of `tokenValid`, and the `getValidAccessToken` / `connectionState` derivations.
- `src/drive/auth.test.ts` — with a stubbed GIS global, covers `connect` (token persistence, expiry from `expires_in`, single reused token client, `drive.file` scope, prompt override, error rejection) and `disconnect` (revoke + local clear, clear-only when no token passed).
- `src/drive/client.test.ts` — with stubbed `fetch`, covers query building/escaping in `findFile`, folder creation (with `appProperties`), multipart-vs-resumable selection in `uploadFile`, pre-generated-id metadata + 409-as-success (and 409 still thrown without a `fileId`), `generateIds`, `DriveError` status classification, `readFileText`/`readFileBlob`, `listChildren` (non-trashed query, `nextPageToken` pagination), `getFileMetadata`, `getStartPageToken`, and `listChanges` (params, pagination, 410).
- `src/drive/space.test.ts` — with stubbed `fetch`, covers `fetchDriveSpace`: quota parsing + app-byte summing (auth header, `about` fields, `files.list` query), `nextPageToken` pagination, `limitBytes` omitted on unlimited plans, and 401 → `DriveError`/`isAuth` classification.
- `src/drive/ids.test.ts` — with a mocked client, covers batch minting on first use, pool serving without requests, refill on exhaustion, oversized single requests, and id uniqueness.
- `src/drive/account.test.ts` — with mocked identity/id-minting endpoints plus fake IndexedDB, covers `ensureAccountBound`: first grant binds without discarding, same-account calls keep everything (memoized once per token), an account switch discards the tree, every changes cursor, and pending rows' `fileIds` (uploaded rows untouched) then re-binds, and the pooled pre-generated ids are dropped on switch.
- `src/drive/bootstrap.test.ts` — against an in-memory fake Drive, asserts `ensureTree` creates the full tree once, is idempotent on re-run, never re-uploads existing mutable stubs, tags everything it creates with `appProperties`, and preserves cached partition ids; for the account binding, that a switch discards cached partition ids (never merged into the fresh tree), a same-account reconnect keeps them at no extra bootstrap cost, and a first-ever grant binds a pre-existing cache without discarding.
- `src/drive/queue.test.ts` — against a fake Drive that can be told to fail, covers attachment-before-record ordering, idempotent re-drains via persisted pre-generated ids (no duplicates, no probes), the zero-findFile happy path, the legacy-row find-before-upload fallback, `appProperties` tagging, re-bootstrapping when the cached tree lacks the stream, `reconnect` on 401, `retry-later` on 429 with the row retried (and uploaded) by the immediately following drain, draining legacy rows that still carry a persisted `nextRetryAt` (the stuck-queue regression), audio pruning when `keepAudioLocally` is false, the idle case — including the multi-stream regression guard that an idle stream (e.g. a system stream with no events yet) costs zero Drive calls — and that a retried row never reuses old-account `fileIds` after an account switch (fresh ids are minted and everything lands for real). Segment coverage (SPEC §5.7): ≥ 2 pending events upload as one segment (exact bytes, NDJSON mime, `segment` tag, one shared id on every member row, three uploads for two audio events), whole-batch and mid-marking crash-retries resolve via 409 with nothing new on Drive (and never a duplicate per-event record), batching never crosses date partitions, legacy rows never batch, a batch 429 keeps every member queued (no backoff gate) and the immediately following drain re-batches under the pinned segment id, and an account switch strips segment assignments so the retried rows land for real under fresh ids (via the per-event probe path — never a stale-id segment 409). Poison-row parking (issue #87): a row that fails deterministically stops the drain immediately below `MAX_ATTEMPTS_BEFORE_PARKED` (unchanged prior behavior), but past that threshold the drain moves on to the healthy row queued behind it in the same call instead of starving it forever; a parked row is never batched into a segment with a healthy neighbor (which would otherwise fail the whole segment every drain); and a row that fails then later succeeds has its `error` cleared (no stale "failed" reading once uploaded). Progress coverage: the default no-op `onProgress` leaves every existing call site unaffected, an idle stream reports zero events, one `upload-start` (with the pending count) followed by one `upload-progress` per commit unit (never per file within it — a segment of 2 reports one `delta: 2`), a failed-and-stopped batch reports the `upload-start` but no `upload-progress` for it, and a *parked* batch likewise reports no `upload-progress` even though the drain continues past it (the later, healthy batches still report normally).
- `src/drive/pull.test.ts` — against an in-memory fake Drive tree (with a journaled changes feed) plus fake IndexedDB, covers cold-start import + `uploaded` status (never re-pushed), eager attachment download, re-pull idempotency, the O(1) no-op incremental pull, changes-feed discovery (cached and uncached partitions), ignoring removed/trashed/foreign/other-stream changes and our own pushes, the 410 cursor-expiry fallback + re-mint, the cursor not advancing on a mid-pull failure, the seq-counter bump past pulled seqs, tolerating a missing attachment, 401 → `reconnect` / 429 → `retry-later` classification, malformed-record errors, and merging with locally queued events across a seq collision. Segment coverage (SPEC §5.7/§5.8): importing a multi-event segment as a unit (with member attachments), mixed partitions (segment + record), line-level dedupe against an already-imported single, changes-feed discovery of segments, skipping segments whose first member is local, all-or-nothing failure on a malformed segment line, and the format-1 (bare string) cursor forcing one full walk that recovers segments a v1 engine skipped. Progress coverage: the default no-op `onProgress` leaves every existing call site unaffected, a cold-start walk reports one `pull-progress` per partition (not per event), a no-op incremental pull reports nothing, and a partition discovered through the changes feed reports its own `pull-progress`.

## Key invariants & gotchas

- **No refresh tokens.** GIS hands out ~1h access tokens only; renewal requires a user gesture (`connect`), surfaced through the reconnect pill or Settings. A relaunch within the hour reuses the IndexedDB-mirrored token.
- **Expiry skew**: tokens are considered expired 60s early so a drain never starts with a token that dies mid-flight.
- **`drive.file` scope**: the app can only see files it created. This is why ids are cached in `tree.ts` and why bootstrap pre-creates `config.json`/`checkpoint.json` stubs — otherwise the app could never read back files a skill wrote.
- **The record is the commit**: attachments upload first; an entry exists in Drive only once its `.json` record — or the `.ndjson` segment carrying it (SPEC §5.7) — lands. Combined with pre-generated ids persisted before each attempt (409 = already landed = success), retries are safe at any interruption point. The pull side leans on the same protocol: any carrier it sees has its attachments already uploaded (a still-missing one is a rare race, tolerated and retried), and an attachment change alone never triggers work — only the record/segment does.
- **The changes cursor is advisory, like the tree cache.** It lives per stream in `meta` (`drive:changes:<stream>`), format-versioned so a cursor advanced by an engine that couldn't read segments doesn't count (SPEC §5.8); missing/expired/foreign/wrong-format cursors self-heal via one full listing walk + re-mint. It advances only after a fully successful pull, so the Changes path can never silently drop events — only replay them, which is idempotent.
- **Everything account-bound is bound explicitly.** `account.ts` stores the granting account's `permissionId` (`drive:account` in `meta`) and verifies it once per token per session before any account-bound state is read; a switch silently discards the tree cache, all changes cursors, and pooled + sync-row pre-generated ids — per-event and segment-assignment keys alike (the dangerous one: Drive ids are globally unique, so reusing an old account's id can 409-as-"success" while uploading nothing). What is *not* discarded: the local event log itself (the app's data, not a per-account cache — pending events push to the newly connected account, and its remote log pulls and merges in), `lastSyncAt:<stream>` display stamps (restamped after the next clean cycle), and per-stream `nextSeq` counters (local ordering hints).
- **Pull before push.** The local IndexedDB is a replica of the Drive log; `appStore.drainSync` always runs `pullStream` then `drainStream` for each registered stream in turn (`allSyncStreams()` — see [store.md](store.md)), so local appends land after everything other devices committed. Identity is the event `id` — a seq collision across devices is expected and resolved by the fold's `seq → loggedAt → id` order (SPEC §3.3), never by the sync layer.
- **Never clobber**: bootstrap creates mutable stubs only when absent, and `streams.json` is not rewritten once present. Only `updateFileContent` (used for the app-owned `config.json`) overwrites anything; `log/` is append-only.
- **No retry backoff**: sync runs only from the manual "Sync now" button, so the user is the rate limiter — a failed row stays queued (or errored) and the very next drain retries it. There is no persisted per-row retry window on either the push or the pull side.
- **Progress reporting is opt-in and coarse.** `onProgress` on `pullStream`/`drainStream` defaults to a no-op, so it never changes behavior for a caller that doesn't pass one (every existing test). Boundaries are deliberately no finer than one imported partition (pull) or one committed batch — a lone record or a whole segment (push) — never per file or per line; `appStore.drainSync` owns the coarser per-stream boundaries (`stream-start`/`stream-done`) since it already runs that loop. The event shape (`SyncProgressEvent`) and everything that interprets it live in `src/store/syncProgress` — see [store.md](store.md).
- The tree cache is advisory and self-healing; `drainStream` and `pullStream` re-run `ensureTree` when the cache lacks the stream. Note `ensurePartition` tolerates a stale partition-id cache only insofar as bootstrap recreates folders — a cached partition id pointing at a user-deleted folder would surface as an upload error until the cache is cleared.
- Layering (`src/layering.test.ts`): `drive/` is a stream-agnostic layer and must not import from `gcal/`, `dayview/`, `settings/`, or `assistant/`. Its inbound consumers are `store/appStore.ts` (auth, token state, pull + drain) and `App.tsx` (renders the pill).
