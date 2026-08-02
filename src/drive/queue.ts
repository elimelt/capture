/**
 * Upload queue drainer (SPEC §5.2, §5.7, §8.4). Drains a stream's pending
 * sync rows in seq order via the atomic append protocol: attachment blobs
 * first, the committing log file last. A run of two or more pending events
 * in the same date partition commits as ONE sealed NDJSON segment (§5.7);
 * a lone pending event keeps the per-event record path — either way, the
 * record/segment upload is the commit. Every upload is idempotent by
 * pre-generated file id: ids are minted client-side (files.generateIds,
 * batched in ids.ts) and persisted on the sync row before the upload starts
 * (a segment's single id on *every* member row, pinning the batch across
 * crashes), so a retry re-uploads with the same id and Drive's 409 answer
 * counts as success — no find-before-upload GETs. Rows written by older app
 * versions (no `fileIds`) that already attempted an upload keep the legacy
 * find-before-upload probe — and are never batched — so they never
 * duplicate. Failures classify: 401/403 stops and asks for reconnect;
 * 429/5xx stops with 'retry-later', keeping the batch's rows queued;
 * anything else marks the batch's rows errored and stops — *unless* the row
 * has failed this way `MAX_ATTEMPTS_BEFORE_PARKED` times running, in which
 * case it's treated as parked (issue #87) and the drain moves on to the
 * batches behind it instead of stopping (see MAX_ATTEMPTS_BEFORE_PARKED).
 *
 * There is no per-row backoff gate: sync is manual-only (the sole drain
 * trigger is "Sync now"), so every queued row is attempted on every drain —
 * the user is the rate limiter, and an explicit retry must never be silently
 * skipped. (An earlier version persisted `nextRetryAt` and skipped rows
 * inside the window while still reporting the drain clean, which left
 * entries "queued forever" from the user's point of view.)
 */
import { serializeEvent } from '../contract/serialize'
import { serializeSegment } from '../contract/segments'
import {
  eventRecordName,
  parseSegmentName,
  partitionOf,
  segmentFileName,
} from '../contract/filenames'
import { compareEvents } from '../contract/fold'
import type { Attachment, LogEvent } from '../contract/types'
import { getStreamSettings } from '../store/settings'
import type { SyncStatusRow } from '../store/db'
import {
  deleteBlob,
  getBlob,
  getEventById,
  listPendingSync,
  putSyncStatus,
} from '../store/events'
import { DriveError, FOLDER_MIME, createFolder, findFile, uploadFile } from './client'
import { ensureAccountBound } from './account'
import { allocateIds } from './ids'
import { tags } from './tags'
import { ensureTree } from './bootstrap'
import { getTree, saveTree, type DriveTree } from './tree'

export type DrainOutcome = 'idle' | 'drained' | 'reconnect' | 'retry-later' | 'error'

export interface DrainResult {
  outcome: DrainOutcome
  uploaded: number
  /** Present when outcome is 'error': the last row-level failure message. */
  error?: string
}

/** Ensure the date-partition folder for an event, caching its id in the tree. */
async function ensurePartition(
  token: string,
  tree: DriveTree,
  stream: string,
  date: string,
): Promise<string> {
  const st = tree.streams[stream]
  const cached = st.partitions[date]
  if (cached) return cached
  // Folders can't use pre-generated ids (files.generateIds is blob-files
  // only), so partitions keep find-before-create — once per day per device.
  const existing = await findFile(token, { name: date, parentId: st.logId, mimeType: FOLDER_MIME })
  const folderId = existing ?? (await createFolder(token, date, st.logId, tags('partition', stream)))
  st.partitions[date] = folderId
  await saveTree(tree)
  return folderId
}

/** Upload one attachment with its pre-assigned id (409 = already there = ok). */
async function uploadAttachment(
  token: string,
  parentId: string,
  stream: string,
  att: Attachment,
  fileId: string,
  legacyRetry: boolean,
): Promise<void> {
  if (legacyRetry && (await findFile(token, { name: att.file, parentId }))) return
  const blob = await getBlob(att.file)
  if (!blob) return // pruned or never stored; the record still commits the entry
  await uploadFile(token, {
    name: att.file,
    parentId,
    mimeType: att.mimeType,
    body: blob,
    fileId,
    appProperties: tags('attachment', stream),
  })
}

function attachmentsOf(event: LogEvent): Attachment[] {
  if (event.type === 'capture') return event.attachments
  if (event.type === 'amend') return event.attachments ?? []
  return []
}

/**
 * Assign pre-generated Drive ids to every file of this event that lacks one,
 * persisting the row *before* any upload: if the upload lands but we crash
 * before recording success, the retry reuses the same id and gets a 409
 * (success) instead of creating a duplicate.
 */
async function assignFileIds(
  token: string,
  row: SyncStatusRow,
  names: string[],
): Promise<Record<string, string>> {
  const fileIds = { ...row.fileIds }
  const missing = names.filter((n) => !fileIds[n])
  if (missing.length > 0) {
    const minted = await allocateIds(token, missing.length)
    missing.forEach((name, i) => {
      fileIds[name] = minted[i]
    })
    row.fileIds = fileIds
    await putSyncStatus(row)
  }
  return fileIds
}

/**
 * A row from an older app version that already attempted an upload may have
 * files on Drive we hold no ids for; only those rows keep the legacy
 * find-before-upload probe (and stay on the per-event path) so a retry never
 * duplicates them. The signals: attempts were recorded, or the phase moved to
 * 'record-pending' — but the latter only implies an attempt when the event
 * *has* attachments, because a no-attachment row *starts* at
 * 'record-pending' (store/events append). Without that refinement every
 * revoke/amend/no-attachment event would read as legacy and never batch.
 * (Residual window: an old-version no-attachment row whose record landed in
 * the instant before a process crash re-uploads without a probe — at worst a
 * duplicate carrier, which readers dedupe by id per SPEC §5.8.)
 */
function isLegacyRetry(row: SyncStatusRow, event: LogEvent): boolean {
  if (row.fileIds) return false
  return (
    row.attempts > 0 || (row.phase === 'record-pending' && attachmentsOf(event).length > 0)
  )
}

/**
 * A row this permanently-erroring after this many attempts is "parked"
 * (issue #87): still attempted on every drain, still visibly 'failed', but
 * no longer allowed to gate the rows behind it. Chosen high enough that an
 * ordinary transient hiccup (a stale partition-id cache self-healing next
 * bootstrap, a one-off malformed-response body) still gets a few
 * immediate-stop drains — each an explicit "Sync now" the user can act on —
 * before the drainer gives up on blocking for it.
 */
const MAX_ATTEMPTS_BEFORE_PARKED = 5

/** True once a row has crossed the park threshold (see above). */
function isParked(row: SyncStatusRow): boolean {
  return row.status === 'error' && row.attempts >= MAX_ATTEMPTS_BEFORE_PARKED
}

/** Upload all of one event's parts then commit its record. Throws on failure. */
async function uploadEvent(
  token: string,
  tree: DriveTree,
  event: LogEvent,
  row: SyncStatusRow,
): Promise<void> {
  const parentId = await ensurePartition(token, tree, event.stream, partitionOf(event))

  const legacyRetry = isLegacyRetry(row, event)

  const atts = attachmentsOf(event)
  const recordName = eventRecordName(event)
  const fileIds = await assignFileIds(token, row, [...atts.map((a) => a.file), recordName])

  for (const att of atts) {
    await uploadAttachment(token, parentId, event.stream, att, fileIds[att.file], legacyRetry)
  }
  row.phase = 'record-pending'
  await putSyncStatus(row)

  if (legacyRetry && (await findFile(token, { name: recordName, parentId }))) return
  await uploadFile(token, {
    name: recordName,
    parentId,
    mimeType: 'application/json',
    body: serializeEvent(event),
    fileId: fileIds[recordName],
    appProperties: tags('record', event.stream),
  })
}

/** Drop local audio blobs once uploaded, if the stream opts out of keeping them. */
async function pruneAudio(stream: string, event: LogEvent): Promise<void> {
  const { keepAudioLocally } = await getStreamSettings(stream)
  if (keepAudioLocally) return
  for (const att of attachmentsOf(event)) {
    if (att.kind === 'audio') await deleteBlob(att.file)
  }
}

/** One drain work item: a pending sync row joined with its local event. */
interface PendingItem {
  row: SyncStatusRow
  event: LogEvent
}

/** One commit unit: a per-event record (1 fresh item) or a segment (§5.7). */
interface Batch {
  /** In seq order, like the pending list they came from. */
  items: PendingItem[]
  /** Segment filename persisted by a previous crashed drain, if any. */
  assigned: string | null
}

/** The segment filename a previous drain persisted on this row, if any. */
function segmentKeyOf(row: SyncStatusRow): string | null {
  for (const name of Object.keys(row.fileIds ?? {})) {
    if (parseSegmentName(name)) return name
  }
  return null
}

/**
 * Group queued items into commit units (SPEC §5.7, §8.4). Items a crashed
 * drain already assigned to a segment regroup under that exact segment
 * (membership, name, and id are pinned by the persisted assignment); the
 * rest form runs of consecutive same-partition items — a run of ≥ 2 becomes
 * a new segment, a run of 1 keeps the per-event record path, and legacy
 * rows always go alone (their files may already be on Drive under names we
 * hold no ids for). Batches return ordered by first seq, so the log still
 * commits in seq order.
 */
function planBatches(items: PendingItem[]): Batch[] {
  const assigned = new Map<string, Batch>()
  const fresh: Batch[] = []
  let run: Batch | null = null
  let runPartition = ''
  for (const item of items) {
    const key = segmentKeyOf(item.row)
    if (key) {
      const batch = assigned.get(key)
      if (batch) batch.items.push(item)
      else assigned.set(key, { items: [item], assigned: key })
      run = null
      continue
    }
    // A parked row (see isParked) is kept solo like a legacy row: grouping it
    // into a segment would fail the whole segment every drain (segments
    // commit as a unit) and re-poison an otherwise-healthy neighbor forever.
    // This doesn't help a row whose *segment assignment* was already
    // persisted before parking (segmentKeyOf above regroups by that pinned
    // assignment unconditionally) — that rarer case still needs manual
    // resolution (revoke the poison entry) and is called out in
    // docs/modules/drive.md.
    if (isLegacyRetry(item.row, item.event) || isParked(item.row)) {
      fresh.push({ items: [item], assigned: null })
      run = null
      continue
    }
    const partition = partitionOf(item.event)
    if (run && partition === runPartition) {
      run.items.push(item)
    } else {
      run = { items: [item], assigned: null }
      runPartition = partition
      fresh.push(run)
    }
  }
  return [...assigned.values(), ...fresh].sort((a, b) => a.items[0].row.seq - b.items[0].row.seq)
}

/**
 * Upload one batch as a sealed log segment (SPEC §5.7): every member's
 * attachments first, then the single NDJSON segment — the commit for all
 * members at once. One pre-generated id per segment, persisted on every
 * member row (keyed by the segment filename) before the first upload, so a
 * crashed drain re-uploads the same file and 409 counts as success.
 */
async function uploadSegment(
  token: string,
  tree: DriveTree,
  stream: string,
  batch: Batch,
): Promise<void> {
  const events = batch.items.map((i) => i.event).sort(compareEvents)
  const parentId = await ensurePartition(token, tree, stream, partitionOf(events[0]))
  const name = batch.assigned ?? segmentFileName(events)

  // The segment's one id: reuse a persisted assignment, else mint. Persist
  // it on every member row — with the member's own attachment ids — before
  // anything uploads, pinning the batch for crash-retry.
  let segmentId = batch.items.find((i) => i.row.fileIds?.[name])?.row.fileIds?.[name]
  segmentId ??= (await allocateIds(token, 1))[0]
  for (const { row, event } of batch.items) {
    const attachmentIds = await assignFileIds(
      token,
      row,
      attachmentsOf(event).map((a) => a.file),
    )
    if (attachmentIds[name] !== segmentId) {
      row.fileIds = { ...attachmentIds, [name]: segmentId }
      await putSyncStatus(row)
    }
  }

  for (const { row, event } of batch.items) {
    for (const att of attachmentsOf(event)) {
      await uploadAttachment(token, parentId, stream, att, row.fileIds![att.file], false)
    }
    if (row.phase !== 'record-pending') {
      row.phase = 'record-pending'
      await putSyncStatus(row)
    }
  }

  await uploadFile(token, {
    name,
    parentId,
    mimeType: 'application/x-ndjson',
    body: serializeSegment(events),
    fileId: segmentId,
    appProperties: tags('segment', stream),
  })
}

/**
 * Drain one stream's queue with a valid access token. Bootstraps the tree on
 * first use. Stops early (keeping rows queued) on auth or retryable errors so
 * the caller can surface the reconnect pill or schedule a later drain.
 */
export async function drainStream(token: string, stream: string): Promise<DrainResult> {
  let pending = await listPendingSync(stream)
  if (pending.length === 0) return { outcome: 'idle', uploaded: 0 }

  // Account-bound caches (tree ids, sync-row fileIds) are only readable once
  // the token is verified to belong to the account that minted them
  // (account.ts). Usually a memoized no-op: pullStream ran first this cycle.
  // A detected switch stripped fileIds from the rows read above — re-read.
  if (await ensureAccountBound(token)) pending = await listPendingSync(stream)
  let tree = (await getTree()) ?? (await ensureTree(token, [stream]))
  if (!tree.streams[stream]) tree = await ensureTree(token, [stream])

  const items: PendingItem[] = []
  for (const row of pending) {
    const event = await getEventById(row.id)
    if (!event) {
      // Log file erased out-of-band (§11): nothing to upload, drop the row.
      await putSyncStatus({ ...row, status: 'uploaded', phase: 'done' })
      continue
    }
    items.push({ row, event })
  }

  let uploaded = 0
  let parkedError: string | undefined
  for (const batch of planBatches(items)) {
    try {
      if (batch.assigned === null && batch.items.length === 1) {
        await uploadEvent(token, tree, batch.items[0].event, batch.items[0].row)
      } else {
        await uploadSegment(token, tree, stream, batch)
      }
      for (const { row, event } of batch.items) {
        await putSyncStatus({
          ...row,
          status: 'uploaded',
          phase: 'done',
          attempts: row.attempts + 1,
          // Clear a stale failure recorded by an earlier attempt of this same
          // row — a landed upload must never keep reading as failed (see
          // src/capture/lifecycle.ts's entryLifecycle).
          error: undefined,
        })
        await pruneAudio(stream, event)
        uploaded++
      }
    } catch (err) {
      // A batch fails as a unit: every member row records the attempt.
      if (err instanceof DriveError && err.isAuth) {
        for (const { row } of batch.items) {
          await putSyncStatus({ ...row, status: 'queued', attempts: row.attempts + 1, error: err.message })
        }
        return { outcome: 'reconnect', uploaded }
      }
      if (err instanceof DriveError && err.isRetryable) {
        // Keep the rows queued with no retry gate: the next manual "Sync now"
        // attempts them again immediately (sync has no automatic trigger that
        // a persisted backoff could defer to), re-planning the batch — the
        // persisted segment assignment keeps that retry idempotent.
        for (const { row } of batch.items) {
          await putSyncStatus({ ...row, status: 'queued', attempts: row.attempts + 1, error: err.message })
        }
        return { outcome: 'retry-later', uploaded }
      }
      const message = err instanceof Error ? err.message : String(err)
      let attemptsAfter = 0
      for (const { row } of batch.items) {
        attemptsAfter = row.attempts + 1
        await putSyncStatus({ ...row, status: 'error', attempts: attemptsAfter, error: message })
      }
      // Issue #87 (poison-row starvation): a deterministic non-retryable
      // failure (bad payload, oversized/malformed attachment, a stale cached
      // partition id — anything that isn't auth or 429/5xx) used to stop the
      // whole drain here on every single call, forever — since the row stays
      // first-in-seq-order on every future drain, nothing queued behind it
      // ever got a chance. A few immediate stops are fine (most 'error' rows
      // are still worth surfacing fast, and stopping preserves strict seq
      // commit order — SPEC §5.2, §8.4 — for the common case). Once a row has
      // failed MAX_ATTEMPTS_BEFORE_PARKED times in a row, though, it has
      // proven itself permanent: treat it as *parked* — still attempted every
      // drain (no backoff gate, unchanged), still visibly 'failed' (its
      // `error` is set — src/capture/lifecycle.ts), but no longer allowed to
      // block the rows behind it. `planBatches` also keeps a parked row solo
      // (never grouped into a segment) so it can't drag a healthy neighbor
      // down with it every drain.
      if (attemptsAfter < MAX_ATTEMPTS_BEFORE_PARKED) {
        return { outcome: 'error', uploaded, error: message }
      }
      parkedError = message
    }
  }
  // A parked row never lands automatically — the stream can't report a clean
  // 'drained' cycle while one exists (lastSyncAt must not stamp over it), so
  // surface the same 'error' outcome the pre-parking stop would have, while
  // still reporting every batch that *did* land during this call.
  return parkedError ? { outcome: 'error', uploaded, error: parkedError } : { outcome: 'drained', uploaded }
}
