/**
 * Upload queue drainer (SPEC §5.2, §8.4). Drains a stream's pending sync rows
 * in seq order, each via the atomic append protocol: attachment blobs first,
 * the event record `.json` last — the record is the commit. Every upload is
 * idempotent by pre-generated file id: ids are minted client-side
 * (files.generateIds, batched in ids.ts) and persisted on the sync row before
 * the upload starts, so a retried row re-uploads with the same id and Drive's
 * 409 answer counts as success — no find-before-upload GETs. Rows written by
 * older app versions (no `fileIds`) that already attempted an upload keep the
 * legacy find-before-upload probe so they never duplicate. Failures classify:
 * 401/403 stops and asks for reconnect; 429/5xx stops with 'retry-later',
 * keeping the row queued; anything else marks the row errored and stops.
 *
 * There is no per-row backoff gate: sync is manual-only (the sole drain
 * trigger is "Sync now"), so every queued row is attempted on every drain —
 * the user is the rate limiter, and an explicit retry must never be silently
 * skipped. (An earlier version persisted `nextRetryAt` and skipped rows
 * inside the window while still reporting the drain clean, which left
 * entries "queued forever" from the user's point of view.)
 */
import { serializeEvent } from '../contract/serialize'
import { eventRecordName, partitionOf } from '../contract/filenames'
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

/** Upload all of one event's parts then commit its record. Throws on failure. */
async function uploadEvent(
  token: string,
  tree: DriveTree,
  event: LogEvent,
  row: SyncStatusRow,
): Promise<void> {
  const parentId = await ensurePartition(token, tree, event.stream, partitionOf(event))

  // A row from an older app version that already attempted an upload may have
  // files on Drive we hold no ids for; only those rows keep the legacy
  // find-before-upload probe so a retry never duplicates them.
  const legacyRetry = !row.fileIds && (row.attempts > 0 || row.phase === 'record-pending')

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

  let uploaded = 0
  for (const row of pending) {
    const event = await getEventById(row.id)
    if (!event) {
      // Log file erased out-of-band (§11): nothing to upload, drop the row.
      await putSyncStatus({ ...row, status: 'uploaded', phase: 'done' })
      continue
    }
    try {
      await uploadEvent(token, tree, event, row)
      await putSyncStatus({ ...row, status: 'uploaded', phase: 'done', attempts: row.attempts + 1 })
      await pruneAudio(stream, event)
      uploaded++
    } catch (err) {
      const attempts = row.attempts + 1
      if (err instanceof DriveError && err.isAuth) {
        await putSyncStatus({ ...row, status: 'queued', attempts, error: err.message })
        return { outcome: 'reconnect', uploaded }
      }
      if (err instanceof DriveError && err.isRetryable) {
        // Keep the row queued with no retry gate: the next manual "Sync now"
        // attempts it again immediately (sync has no automatic trigger that
        // a persisted backoff could defer to).
        await putSyncStatus({ ...row, status: 'queued', attempts, error: err.message })
        return { outcome: 'retry-later', uploaded }
      }
      const message = err instanceof Error ? err.message : String(err)
      await putSyncStatus({ ...row, status: 'error', attempts, error: message })
      return { outcome: 'error', uploaded, error: message }
    }
  }
  return { outcome: 'drained', uploaded }
}
