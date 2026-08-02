/**
 * Upload queue drainer (SPEC §5.2, §8.4). Drains a stream's pending sync rows
 * in seq order, each via the atomic append protocol: attachment blobs first,
 * the event record `.json` last — the record is the commit. Every upload is
 * idempotent by filename (find-before-upload) so a retried row never
 * duplicates. Failures classify: 401/403 stops and asks for reconnect; 429/5xx
 * backs off with `nextRetryAt`; anything else marks the row errored and moves on.
 */
import { serializeEvent } from '../contract/serialize'
import { eventRecordName, partitionOf } from '../contract/filenames'
import type { Attachment, LogEvent } from '../contract/types'
import { toLocalIso } from '../contract/time'
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
import { ensureTree } from './bootstrap'
import { getTree, saveTree, type DriveTree } from './tree'

/** Retry backoff: 30s, 2m, 8m, … capped at 1h (attempts is 1-based here). */
function backoffMs(attempts: number): number {
  return Math.min(30_000 * 4 ** (attempts - 1), 60 * 60_000)
}

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
  const existing = await findFile(token, { name: date, parentId: st.logId, mimeType: FOLDER_MIME })
  const folderId = existing ?? (await createFolder(token, date, st.logId))
  st.partitions[date] = folderId
  await saveTree(tree)
  return folderId
}

/** Upload one attachment if not already present (idempotent by filename). */
async function uploadAttachment(
  token: string,
  parentId: string,
  att: Attachment,
): Promise<void> {
  const existing = await findFile(token, { name: att.file, parentId })
  if (existing) return
  const blob = await getBlob(att.file)
  if (!blob) return // pruned or never stored; the record still commits the entry
  await uploadFile(token, { name: att.file, parentId, mimeType: att.mimeType, body: blob })
}

function attachmentsOf(event: LogEvent): Attachment[] {
  if (event.type === 'capture') return event.attachments
  if (event.type === 'amend') return event.attachments ?? []
  return []
}

/** Upload all of one event's parts then commit its record. Throws on failure. */
async function uploadEvent(
  token: string,
  tree: DriveTree,
  event: LogEvent,
  row: SyncStatusRow,
): Promise<void> {
  const parentId = await ensurePartition(token, tree, event.stream, partitionOf(event))
  for (const att of attachmentsOf(event)) {
    await uploadAttachment(token, parentId, att)
  }
  row.phase = 'record-pending'
  await putSyncStatus(row)

  const name = eventRecordName(event)
  const existing = await findFile(token, { name, parentId })
  if (!existing) {
    await uploadFile(token, { name, parentId, mimeType: 'application/json', body: serializeEvent(event) })
  }
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
  const pending = await listPendingSync(stream)
  if (pending.length === 0) return { outcome: 'idle', uploaded: 0 }

  let tree = (await getTree()) ?? (await ensureTree(token, [stream]))
  if (!tree.streams[stream]) tree = await ensureTree(token, [stream])

  const now = Date.now()
  let uploaded = 0
  for (const row of pending) {
    if (row.nextRetryAt && Date.parse(row.nextRetryAt) > now) continue
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
        const nextRetryAt = toLocalIso(new Date(now + backoffMs(attempts)))
        await putSyncStatus({ ...row, status: 'queued', attempts, nextRetryAt, error: err.message })
        return { outcome: 'retry-later', uploaded }
      }
      const message = err instanceof Error ? err.message : String(err)
      await putSyncStatus({ ...row, status: 'error', attempts, error: message })
      return { outcome: 'error', uploaded, error: message }
    }
  }
  return { outcome: 'drained', uploaded }
}
