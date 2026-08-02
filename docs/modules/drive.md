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
`bootstrap.ts` ensures the Drive folder tree exists, caching ids via `tree.ts` →
`pull.ts` imports remote events the local replica lacks, then `queue.ts` drains
pending sync rows — both through `client.ts` primitives. The orchestration (when to
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
- `createFolder(token, name, parentId): Promise<string>`.
- `uploadFile(token, { name, parentId, mimeType, body: Blob | string }): Promise<string>` — multipart (`multipart/related`, hand-built boundary) for bodies ≤ 5 MB; resumable (init POST → PUT to the returned `location` session URL) above `RESUMABLE_THRESHOLD` (5 MiB). Throws `DriveError` if the resumable init returns no session URL.
- `readFileText(token, fileId): Promise<string>` — `alt=media` download (checkpoint/results read-back, event-record pull).
- `readFileBlob(token, fileId): Promise<Blob>` — `alt=media` download as a `Blob` (attachment pull).
- `interface DriveChild { id; name; mimeType: string }` — one child of a folder listing.
- `listChildren(token, parentId): Promise<DriveChild[]>` — every non-trashed child of a folder, following `nextPageToken` pagination (`pageSize` 1000). Used by the pull path to enumerate `log/` partitions and their files; because filenames lead with the zero-padded seq and embed the id (§5.1), the names alone answer discovery without opening a file.
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

### src/drive/tree.ts

Cache of Drive file ids in the IndexedDB `meta` store (key `drive:tree`). Because
`drive.file` only shows files the app created, ids are remembered at mint time to skip
repeated `findFile` lookups on every drain. The cache is **advisory**: bootstrap always
tolerates a miss by re-finding or re-creating, so a cleared cache or user-deleted
folder self-heals on the next bootstrap.

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

- `ensureTree(token: string, streams: string[]): Promise<DriveTree>` — ensures the whole tree, persists the id cache via `saveTree`, and returns the up-to-date `DriveTree`. Re-running merges with the cached tree: already-bootstrapped streams keep their `partitions` ids; newly requested streams are added.

Invariants and edge cases:

- Every step **finds before creating** (`ensureFolder`, `ensureFile`), so re-runs create nothing new.
- Mutable stubs (`config.json`, `checkpoint.json`) are written only when absent — never clobbering edits made by a processing skill. `ensureFile` deliberately returns nothing; these files are re-addressed by name at read time.
- `streams.json` is created if absent but **left as-is when present**: v1 only bootstraps `timelog`, so the set never shrinks and a rewrite path is deferred.
- The root folder is created under the special Drive parent id `'root'`.

### src/drive/queue.ts

The upload-queue drainer. Processes a stream's pending sync rows (from
`src/store/events`) in seq order via the atomic-append protocol: attachment blobs
first, the event-record `.json` last — **the record is the commit**.

Key exports:

- `type DrainOutcome = 'idle' | 'drained' | 'reconnect' | 'retry-later' | 'error'`.
- `interface DrainResult { outcome: DrainOutcome; uploaded: number; error?: string }` — `error` is set only for the `'error'` outcome.
- `drainStream(token: string, stream: string): Promise<DrainResult>` — drains one stream with a valid access token, bootstrapping the tree (`ensureTree`) on first use or when the stream is missing from the cache.

Invariants and edge cases:

- **Idempotent by filename**: every attachment and record upload is preceded by `findFile`; a retried row never duplicates files already in Drive.
- Rows whose `nextRetryAt` is in the future are skipped, leaving them queued.
- If the local event was erased out-of-band, the row is marked `uploaded`/`done` and dropped. If an attachment blob is missing (pruned or never stored), it is skipped and the record still commits the entry.
- Between attachments and the record, the row's `phase` is advanced to `'record-pending'`.
- Failure classification (via `DriveError`): auth (401/403) → row re-queued, drain stops, outcome `'reconnect'`; retryable (429/5xx) → row re-queued with `nextRetryAt` from exponential backoff `min(30s × 4^(attempts−1), 1h)` (30s, 2m, 8m, …), outcome `'retry-later'`; anything else → row marked `'error'`, drain stops, outcome `'error'`. In every failure path `attempts` is incremented and the message stored on the row.
- After a successful upload, local audio blobs are deleted unless the stream's `keepAudioLocally` setting is true (`pruneAudio`).
- Date-partition folders under `log/` are ensured lazily per event (`ensurePartition`) and their ids cached in the tree.

### src/drive/pull.ts

The pull engine (SPEC §8.5) — the read half of bidirectional sync. Lists the stream's
`log/` partitions on Drive, discovers event records the local replica lacks, downloads
them plus every referenced attachment blob (eager: full offline availability), and
imports them atomically via `src/store/events#importEvents`.

Key exports:

- `type PullOutcome = 'idle' | 'pulled' | 'reconnect' | 'retry-later' | 'error'`.
- `interface PullResult { outcome: PullOutcome; pulled: number; error?: string }` — `pulled` counts events imported; `error` is set only for the `'error'` outcome.
- `pullStream(token: string, stream: string): Promise<PullResult>` — pulls one stream's remote log into the local replica, bootstrapping the tree (`ensureTree`) when the cache lacks the stream.

Invariants and edge cases:

- **Discovery is by filename, per partition.** Only folders named `YYYY-MM-DD` under `log/` are scanned; within one, `idOfRecordName` (from `src/contract/filenames`) picks out record files and their ids, so the missing set (ids not in `listEvents`) is computed from listings alone — no file reads for events already held. Foreign files and folders are ignored.
- **Eager attachment download.** For each missing record, every referenced attachment blob not already local is fetched. One missing on Drive (pruned, or a §5.2 push race — the record commits last) is skipped and picked up on a later pull.
- **Atomic import per partition.** Events + blobs commit in one IndexedDB transaction; pulled events get sync status `uploaded` (the drainer never re-pushes them) and the per-stream seq counter jumps past every pulled seq.
- **Records claiming another stream** (a `stream` field not matching the folder they sit in) are skipped.
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
- `src/drive/client.test.ts` — with stubbed `fetch`, covers query building/escaping in `findFile`, folder creation, multipart-vs-resumable selection in `uploadFile`, `DriveError` status classification, `readFileText`/`readFileBlob`, and `listChildren` (non-trashed query, `nextPageToken` pagination).
- `src/drive/space.test.ts` — with stubbed `fetch`, covers `fetchDriveSpace`: quota parsing + app-byte summing (auth header, `about` fields, `files.list` query), `nextPageToken` pagination, `limitBytes` omitted on unlimited plans, and 401 → `DriveError`/`isAuth` classification.
- `src/drive/bootstrap.test.ts` — against an in-memory fake Drive, asserts `ensureTree` creates the full tree once, is idempotent on re-run, never re-uploads existing mutable stubs, and preserves cached partition ids.
- `src/drive/queue.test.ts` — against a fake Drive that can be told to fail, covers attachment-before-record ordering, idempotent re-drains, `reconnect` on 401, `retry-later` with `nextRetryAt` on 429, audio pruning when `keepAudioLocally` is false, and the idle case.
- `src/drive/pull.test.ts` — against an in-memory fake Drive tree plus fake IndexedDB, covers import + `uploaded` status (never re-pushed), eager attachment download, re-pull idempotency (no re-reads), the seq-counter bump past pulled seqs, ignoring foreign files/folders, tolerating a missing attachment, 401 → `reconnect` / 429 → `retry-later` classification, malformed-record errors, and merging with locally queued events across a seq collision.

## Key invariants & gotchas

- **No refresh tokens.** GIS hands out ~1h access tokens only; renewal requires a user gesture (`connect`), surfaced through the reconnect pill or Settings. A relaunch within the hour reuses the IndexedDB-mirrored token.
- **Expiry skew**: tokens are considered expired 60s early so a drain never starts with a token that dies mid-flight.
- **`drive.file` scope**: the app can only see files it created. This is why ids are cached in `tree.ts` and why bootstrap pre-creates `config.json`/`checkpoint.json` stubs — otherwise the app could never read back files a skill wrote.
- **The record is the commit**: attachments upload first; an entry exists in Drive only once its `.json` record lands. Combined with find-before-upload, retries are safe at any interruption point. The pull side leans on the same protocol: any record it sees has its attachments already uploaded (a still-missing one is a rare race, tolerated and retried).
- **Pull before push.** The local IndexedDB is a replica of the Drive log; `appStore.drainSync` always runs `pullStream` then `drainStream`, so local appends land after everything other devices committed. Identity is the event `id` — a seq collision across devices is expected and resolved by the fold's `seq → loggedAt → id` order (SPEC §3.3), never by the sync layer.
- **Never clobber**: bootstrap creates mutable stubs only when absent, and `streams.json` is not rewritten once present. Only `updateFileContent` (used for the app-owned `config.json`) overwrites anything; `log/` is append-only.
- **Backoff**: 30s → 2m → 8m → … capped at 1h; auth errors bypass backoff entirely and stop the drain.
- The tree cache is advisory and self-healing; `drainStream` and `pullStream` re-run `ensureTree` when the cache lacks the stream. Note `ensurePartition` tolerates a stale partition-id cache only insofar as bootstrap recreates folders — a cached partition id pointing at a user-deleted folder would surface as an upload error until the cache is cleared.
- Layering (`src/layering.test.ts`): `drive/` is a stream-agnostic layer and must not import from `gcal/`, `dayview/`, `settings/`, or `assistant/`. Its inbound consumers are `store/appStore.ts` (auth, token state, pull + drain) and `App.tsx` (renders the pill).
