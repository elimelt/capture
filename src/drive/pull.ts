/**
 * Pull engine (SPEC §8.5): the read half of bidirectional sync. Discovers
 * event carriers — per-event records and batched log segments (§5.7) — the
 * local replica lacks (by id: record names carry seq_ts_id and segment
 * names carry range_ts_firstId, so discovery needs no file reads), downloads
 * each missing carrier plus every referenced attachment blob (eager: full
 * offline availability) — except audio when the stream's `keepAudioLocally`
 * setting is off (issue #53): the event still imports, only its audio blob
 * is left unfetched, so a pull can never re-inflate audio the setting says
 * to never keep — and imports them atomically. A segment imports as
 * a unit — all lines or none, deduped by event id against events already
 * held (§5.8) — and one malformed line fails the whole partition's import
 * rather than half-importing silently.
 *
 * Discovery runs off the Drive Changes API: one `changes.list` from a
 * persisted per-stream cursor (changes.ts) tells us which partitions gained
 * records since the last pull, so a no-op pull costs one request regardless
 * of how many date partitions the log has accumulated. Without a cursor
 * (first pull, wiped meta) — or when Drive rejects the cursor (410 expired,
 * or unusable after an account switch) — discovery falls back to the full
 * per-partition listing walk once, then mints and persists a fresh cursor.
 * The cursor is minted *before* the walk and persisted only *after* a fully
 * successful pull, so no window is ever skipped: at worst a change is
 * replayed, and replays are idempotent.
 *
 * Safe against every push/pull race the append-only contract allows:
 * - Records commit last on push (§5.2), so any record we see has its
 *   attachments already uploaded; a still-missing attachment is tolerated
 *   and picked up on the next pull.
 * - Our own pushes appear in the changes feed too, but their ids are already
 *   local, so they never mark a partition dirty — nothing we just uploaded
 *   is re-listed or re-downloaded.
 * - Identity is the event id; a seq collision from another device is fine
 *   (the fold orders by seq → loggedAt → id) and the import bumps the local
 *   seq counter past everything pulled so our next append doesn't pile on.
 * - Re-pulling is idempotent: known ids are skipped, blob writes overwrite
 *   with identical bytes.
 * - Foreign files in the tree (user drops, other tools) are ignored: only
 *   names matching the record or segment pattern inside a YYYY-MM-DD
 *   partition under this stream's log/ ever get read. Removed/trashed
 *   changes are ignored outright — the log is append-only, so deletions
 *   never un-import.
 */
import { parseEvent } from '../contract/serialize'
import { parseSegment } from '../contract/segments'
import { idOfRecordName, parseSegmentName } from '../contract/filenames'
import type { Attachment, LogEvent } from '../contract/types'
import { getBlob, importEvents, listEvents } from '../store/events'
import { getStreamSettings } from '../store/settings'
import type { SyncProgressEvent } from '../store/syncProgress'
import {
  DriveError,
  FOLDER_MIME,
  getFileMetadata,
  getStartPageToken,
  listChanges,
  listChildren,
  readFileBlob,
  readFileText,
  type DriveChange,
} from './client'
import { ensureAccountBound } from './account'
import { ensureTree } from './bootstrap'
import { getTree, saveTree, type DriveTree, type StreamTree } from './tree'
import { clearChangesToken, getChangesToken, saveChangesToken } from './changes'
import { TAG_STREAM } from './tags'

export type PullOutcome = 'idle' | 'pulled' | 'reconnect' | 'retry-later' | 'error'

export interface PullResult {
  outcome: PullOutcome
  /** Events imported into the local replica. */
  pulled: number
  /** Present when outcome is 'error'. */
  error?: string
}

/** "YYYY-MM-DD" — the only folder names the app creates under log/ (§5.1). */
const PARTITION_RE = /^\d{4}-\d{2}-\d{2}$/

/** One log/ date-partition folder on Drive. */
interface PartitionRef {
  id: string
  name: string
}

function attachmentsOf(event: LogEvent): Attachment[] {
  if (event.type === 'capture') return event.attachments
  if (event.type === 'amend') return event.attachments ?? []
  return []
}

/**
 * The discovery id a log filename carries (SPEC §5.8): a record's event id,
 * or a segment's first-member id — which stands in for every member, since
 * segments commit and import as a unit, so holding the first event locally
 * implies holding them all. Null for anything else (attachment, foreign
 * file, folder).
 */
function discoveryIdOf(name: string): string | null {
  return idOfRecordName(name) ?? parseSegmentName(name)?.firstId ?? null
}

/**
 * Pull one stream's remote log into the local replica. Returns how many
 * events were imported. Classifies failures like the drainer: 401/403 →
 * reconnect, 429/5xx → retry-later, anything else → error. A mid-pull
 * failure loses nothing: everything imported so far is already committed,
 * the cursor is not advanced, and the next pull resumes from the (now
 * smaller) missing set.
 */
export async function pullStream(
  token: string,
  stream: string,
  onProgress: (event: SyncProgressEvent) => void = () => {},
): Promise<PullResult> {
  let pulled = 0
  try {
    // Account-bound caches (tree, cursor) are only readable once the token is
    // verified to belong to the account that minted them (account.ts).
    await ensureAccountBound(token)
    const tree = (await getTree()) ?? (await ensureTree(token, [stream]))
    const st = tree.streams[stream] ?? (await ensureTree(token, [stream])).streams[stream]
    const known = new Set((await listEvents(stream)).map((e) => e.id))
    // Read once per pull: honored the same way on the pull side as the push
    // side prunes after upload (queue.ts#pruneAudio) — a false setting means
    // audio is never kept locally, whether it got here by local capture or
    // by a pull re-inflating another device's history (issue #53).
    const { keepAudioLocally } = await getStreamSettings(stream)

    const cursor = await getChangesToken(stream)
    if (!cursor) {
      pulled = await pullEverything(token, stream, tree, st, known, keepAudioLocally, onProgress)
      return { outcome: pulled > 0 ? 'pulled' : 'idle', pulled }
    }

    let feed
    try {
      feed = await listChanges(token, cursor)
    } catch (err) {
      // 410 = the cursor expired; other non-auth, non-transient rejections
      // (a 4xx after switching accounts — cursors are account-bound) mean
      // the same thing: the cursor is unusable. Drop it and fall back to
      // one full listing walk, which re-mints a fresh cursor.
      if (err instanceof DriveError && !err.isAuth && !err.isRetryable) {
        await clearChangesToken(stream)
        pulled = await pullEverything(token, stream, tree, st, known, keepAudioLocally, onProgress)
        return { outcome: pulled > 0 ? 'pulled' : 'idle', pulled }
      }
      throw err
    }

    for (const partition of await dirtyPartitions(token, stream, tree, st, known, feed.changes)) {
      const n = await importPartition(token, stream, tree, st, partition, known, keepAudioLocally)
      pulled += n
      if (n > 0) onProgress({ kind: 'pull-progress', stream, delta: n })
    }
    // Advance the cursor only after everything imported: a mid-pull failure
    // replays the same change window next time (idempotent — ids we already
    // imported are known and skipped).
    await saveChangesToken(stream, feed.newStartPageToken)

    return { outcome: pulled > 0 ? 'pulled' : 'idle', pulled }
  } catch (err) {
    // Partitions already imported stay imported; only the count reflects that.
    if (err instanceof DriveError && err.isAuth) return { outcome: 'reconnect', pulled }
    if (err instanceof DriveError && err.isRetryable) return { outcome: 'retry-later', pulled }
    const message = err instanceof Error ? err.message : String(err)
    return { outcome: 'error', pulled, error: message }
  }
}

/**
 * Cold start (no usable cursor): the full per-partition listing walk, then
 * persist a fresh cursor. The cursor is minted *before* the walk so anything
 * that lands mid-walk is replayed by the next changes pull, and persisted
 * only *after* the walk succeeds so a failed walk cold-starts again.
 */
async function pullEverything(
  token: string,
  stream: string,
  tree: DriveTree,
  st: StreamTree,
  known: Set<string>,
  keepAudioLocally: boolean,
  onProgress: (event: SyncProgressEvent) => void,
): Promise<number> {
  const startToken = await getStartPageToken(token)
  let pulled = 0
  const partitions = (await listChildren(token, st.logId)).filter(
    (c) => c.mimeType === FOLDER_MIME && PARTITION_RE.test(c.name),
  )
  for (const partition of partitions) {
    const n = await importPartition(token, stream, tree, st, partition, known, keepAudioLocally)
    pulled += n
    if (n > 0) onProgress({ kind: 'pull-progress', stream, delta: n })
  }
  await saveChangesToken(stream, startToken)
  return pulled
}

/**
 * Which of this stream's partitions gained event carriers we lack, per the
 * changes feed. Only a record- or segment-named file whose discovery id
 * isn't local marks its parent partition dirty — so our own pushes (ids
 * already local), attachments (the carrier commits last), foreign files,
 * and removed/trashed entries all produce zero follow-up requests. A
 * carrier in a partition we haven't cached yet costs one files.get to
 * confirm its parent really is a YYYY-MM-DD folder under this stream's
 * log/ (and warms the cache for the push path).
 */
async function dirtyPartitions(
  token: string,
  stream: string,
  tree: DriveTree,
  st: StreamTree,
  known: Set<string>,
  changes: DriveChange[],
): Promise<PartitionRef[]> {
  const nameById = new Map(Object.entries(st.partitions).map(([name, id]) => [id, name]))
  const dirty = new Map<string, PartitionRef>()
  let treeDirty = false

  for (const change of changes) {
    const file = change.file
    if (change.removed || !file || file.trashed) continue
    if (file.mimeType === FOLDER_MIME) {
      // A partition folder another device created: warm the id cache. Its
      // records (if any) arrive as their own changes, so no dirty mark here.
      if (
        PARTITION_RE.test(file.name) &&
        file.parents?.includes(st.logId) &&
        st.partitions[file.name] !== file.id
      ) {
        st.partitions[file.name] = file.id
        nameById.set(file.id, file.name)
        treeDirty = true
      }
      continue
    }

    const id = discoveryIdOf(file.name)
    if (id === null || known.has(id)) continue
    // Phase-1 tags identify the stream for free when present; files from
    // older app versions carry none and fall through to parent resolution.
    if (file.appProperties?.[TAG_STREAM] && file.appProperties[TAG_STREAM] !== stream) continue
    const parentId = file.parents?.[0]
    if (!parentId || dirty.has(parentId)) continue

    let name = nameById.get(parentId)
    if (!name) {
      const resolved = await resolvePartition(token, parentId, st)
      if (!resolved) continue // some other stream's partition, or not ours at all
      name = resolved
      st.partitions[name] = parentId
      nameById.set(parentId, name)
      treeDirty = true
    }
    dirty.set(parentId, { id: parentId, name })
  }

  if (treeDirty) await saveTree(tree)
  return [...dirty.values()]
}

/** The folder's partition name iff it is a YYYY-MM-DD folder under this stream's log/. */
async function resolvePartition(
  token: string,
  folderId: string,
  st: StreamTree,
): Promise<string | null> {
  let meta
  try {
    meta = await getFileMetadata(token, folderId)
  } catch (err) {
    // Gone or not visible to us → whatever changed there is not ours.
    if (err instanceof DriveError && err.status === 404) return null
    throw err
  }
  const ours =
    meta.mimeType === FOLDER_MIME && PARTITION_RE.test(meta.name) && meta.parents?.includes(st.logId)
  return ours ? meta.name : null
}

/**
 * List one partition and import every event the local replica lacks — from
 * per-event records and from batched segments (§5.7), deduped by event id —
 * plus each referenced attachment blob not already local. Events + blobs
 * commit in one transaction; a malformed record or segment line throws
 * before anything from this partition is imported. Returns how many events
 * were imported.
 *
 * `keepAudioLocally = false` skips downloading audio attachments entirely
 * (issue #53): without this, a pull would re-inflate audio the push side had
 * already pruned (or another device's audio the setting says never to keep),
 * silently defeating the setting the moment sync is bidirectional. The event
 * still imports — only its audio blob is left unfetched, exactly like the
 * post-upload-pruned case the drainer and `uploadAttachment` already
 * tolerate (`if (!blob) return`).
 */
async function importPartition(
  token: string,
  stream: string,
  tree: DriveTree,
  st: StreamTree,
  partition: PartitionRef,
  known: Set<string>,
  keepAudioLocally: boolean,
): Promise<number> {
  // Keep the push path's partition cache warm as a side benefit.
  if (st.partitions[partition.name] !== partition.id) {
    st.partitions[partition.name] = partition.id
    await saveTree(tree)
  }

  const children = await listChildren(token, partition.id)
  const byName = new Map(children.map((c) => [c.name, c]))
  const missing = children.filter((c) => {
    const id = discoveryIdOf(c.name)
    return id !== null && !known.has(id)
  })
  if (missing.length === 0) return 0

  const events: LogEvent[] = []
  const blobs = new Map<string, Blob>()
  for (const carrier of missing) {
    const text = await readFileText(token, carrier.id)
    const parsed = parseSegmentName(carrier.name) ? parseSegment(text) : [parseEvent(text)]
    for (const event of parsed) {
      // Dedupe by id: a segment may overlap events already imported from
      // another carrier (§5.8); records claiming another stream are skipped.
      if (event.stream !== stream || known.has(event.id)) continue
      for (const att of attachmentsOf(event)) {
        if (att.kind === 'audio' && !keepAudioLocally) continue
        const child = byName.get(att.file)
        // Missing on Drive (pruned or push race) or already local: skip.
        if (!child || (await getBlob(att.file))) continue
        blobs.set(att.file, await readFileBlob(token, child.id))
      }
      events.push(event)
      known.add(event.id)
    }
  }

  await importEvents(stream, events, blobs)
  return events.length
}
