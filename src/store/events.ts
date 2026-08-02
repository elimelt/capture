/**
 * Event repository: the only writer of the local log. Appends are atomic —
 * seq allocation, event record, blobs, and sync status commit in one
 * IndexedDB transaction.
 */
import type {
  AmendEvent,
  AmendPatch,
  Attachment,
  AttachmentKind,
  CaptureEvent,
  Entry,
  GeoLocation,
  LogEvent,
  RevokeEvent,
} from '../contract/types'
import { EVENT_SCHEMA } from '../contract/types'
import { compareEvents, fold } from '../contract/fold'
import { attachmentFileName, eventBaseName } from '../contract/filenames'
import { newEventId } from '../contract/ids'
import { deviceTz, toLocalIso } from '../contract/time'
import { getDb, type SyncStatusRow } from './db'

export interface NewAttachment {
  kind: AttachmentKind
  blob: Blob
  mimeType: string
  durationSec?: number
  /** Sibling attachment file this was machine-derived from (contract/types). */
  derivedFrom?: string
}

interface AppendArgs {
  stream: string
  build: (base: {
    id: string
    seq: number
    loggedAt: string
    deviceTz: string
  }) => LogEvent
  attachments?: NewAttachment[]
}

const SEQ_KEY = (stream: string) => `nextSeq:${stream}`

async function append({ stream, build, attachments = [] }: AppendArgs): Promise<LogEvent> {
  const db = await getDb()
  const tx = db.transaction(['events', 'blobs', 'sync', 'meta'], 'readwrite')
  const nextSeq = ((await tx.objectStore('meta').get(SEQ_KEY(stream))) as number | undefined) ?? 1
  const base = {
    id: newEventId(),
    seq: nextSeq,
    loggedAt: toLocalIso(new Date()),
    deviceTz: deviceTz(),
  }
  const event = build(base)
  const baseName = eventBaseName(event)
  const kindCounts = new Map<AttachmentKind, number>()
  const attachmentMeta: Attachment[] = attachments.map((a) => {
    const index = kindCounts.get(a.kind) ?? 0
    kindCounts.set(a.kind, index + 1)
    return {
      kind: a.kind,
      file: attachmentFileName(baseName, a.kind, a.mimeType, index),
      mimeType: a.mimeType,
      ...(a.durationSec !== undefined ? { durationSec: a.durationSec } : {}),
      ...(a.derivedFrom !== undefined ? { derivedFrom: a.derivedFrom } : {}),
    }
  })
  if (event.type === 'capture') event.attachments = attachmentMeta
  else if (event.type === 'amend' && attachmentMeta.length > 0) event.attachments = attachmentMeta

  await tx.objectStore('meta').put(nextSeq + 1, SEQ_KEY(stream))
  await tx.objectStore('events').put(event)
  for (let i = 0; i < attachments.length; i++) {
    await tx.objectStore('blobs').put({ file: attachmentMeta[i].file, blob: attachments[i].blob })
  }
  await tx.objectStore('sync').put({
    id: event.id,
    stream,
    seq: event.seq,
    status: 'queued',
    attempts: 0,
    phase: attachments.length > 0 ? 'attachments-pending' : 'record-pending',
  })
  await tx.done
  return event
}

export async function appendCapture(input: {
  stream: string
  capturedAt: string
  location?: GeoLocation
  attachments: NewAttachment[]
}): Promise<CaptureEvent> {
  return (await append({
    stream: input.stream,
    attachments: input.attachments,
    build: (base) => ({
      schema: EVENT_SCHEMA,
      type: 'capture',
      stream: input.stream,
      capturedAt: input.capturedAt,
      ...(input.location ? { location: input.location } : {}),
      attachments: [],
      ...base,
    }),
  })) as CaptureEvent
}

export async function appendAmend(input: {
  stream: string
  targets: string[]
  patch?: AmendPatch
  attachments?: NewAttachment[]
}): Promise<AmendEvent> {
  return (await append({
    stream: input.stream,
    attachments: input.attachments,
    build: (base) => ({
      schema: EVENT_SCHEMA,
      type: 'amend',
      stream: input.stream,
      targets: input.targets,
      ...(input.patch ? { patch: input.patch } : {}),
      ...base,
    }),
  })) as AmendEvent
}

export async function appendRevoke(input: {
  stream: string
  targets: string[]
}): Promise<RevokeEvent> {
  return (await append({
    stream: input.stream,
    build: (base) => ({
      schema: EVENT_SCHEMA,
      type: 'revoke',
      stream: input.stream,
      targets: input.targets,
      ...base,
    }),
  })) as RevokeEvent
}

export async function listEvents(stream: string): Promise<LogEvent[]> {
  const db = await getDb()
  // The store is keyed by id, so the index yields id order; re-sort into log
  // order (seq → loggedAt → id, same total order the fold uses).
  return (await db.getAllFromIndex('events', 'by-stream', stream)).sort(compareEvents)
}

/** The folded, user-visible view (SPEC §3.3). */
export async function listEntries(stream: string): Promise<Entry[]> {
  return fold(await listEvents(stream))
}

export async function getBlob(file: string): Promise<Blob | undefined> {
  const db = await getDb()
  return (await db.get('blobs', file))?.blob
}

/** Sync status by event id for one stream (id is the identity — SPEC §3.3). */
export async function getSyncStatuses(stream: string): Promise<Map<string, SyncStatusRow>> {
  const db = await getDb()
  const all = await db.getAll('sync')
  return new Map(all.filter((r) => r.stream === stream).map((r) => [r.id, r]))
}

/**
 * Rows not yet uploaded for a stream, in seq order (id as tiebreak) — the
 * order the drainer must respect so the log commits monotonically (SPEC §5.2,
 * §8.4).
 *
 * Note: only locally-minted events appear here — pulled events are immediately
 * marked 'uploaded' by importEvents(). Since seq is monotonic per device, seq
 * collisions can only occur across devices, and those events never hit this
 * queue. The id tiebreak is defensive; in practice seq is unique here.
 */
export async function listPendingSync(stream: string): Promise<SyncStatusRow[]> {
  const db = await getDb()
  const all = await db.getAll('sync')
  return all
    .filter((r) => r.stream === stream && r.status !== 'uploaded')
    .sort((a, b) => a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** Local rollup of sync rows for the Settings status line. */
export interface SyncSummary {
  /** Rows not yet uploaded (status !== 'uploaded'), errored rows included. */
  pending: number
  /** Rows with status 'error'. */
  errors: number
  /** Error message of the latest (highest-seq) errored row, if any. */
  lastError?: string
}

/** Pure rollup of sync rows: pending/error counts + the latest error message. */
export function summarizeSyncStatuses(rows: Iterable<SyncStatusRow>): SyncSummary {
  let pending = 0
  let errors = 0
  let lastErrored: SyncStatusRow | undefined
  for (const row of rows) {
    if (row.status !== 'uploaded') pending++
    if (row.status === 'error') {
      errors++
      if (!lastErrored || row.seq > lastErrored.seq) lastErrored = row
    }
  }
  return { pending, errors, ...(lastErrored?.error ? { lastError: lastErrored.error } : {}) }
}

const LAST_SYNC_KEY = (stream: string) => `lastSyncAt:${stream}`

/** Moment the last full pull+push cycle completed cleanly; unset = never synced. */
export async function getLastSyncAt(stream: string): Promise<string | undefined> {
  const db = await getDb()
  return (await db.get('meta', LAST_SYNC_KEY(stream))) as string | undefined
}

export async function setLastSyncAt(stream: string, at: string): Promise<void> {
  const db = await getDb()
  await db.put('meta', at, LAST_SYNC_KEY(stream))
}

export async function getEventById(id: string): Promise<LogEvent | undefined> {
  const db = await getDb()
  return db.get('events', id)
}

/**
 * Import events pulled from Drive (plus their eagerly-fetched attachment
 * blobs) into the local replica in one transaction. Pulled events are already
 * on Drive, so their sync rows are 'uploaded' — the drainer will never touch
 * them. Also bumps the per-stream seq counter past every imported seq so the
 * next local append continues after the remote log rather than colliding.
 * Idempotent: an already-present id is simply overwritten with itself.
 */
export async function importEvents(
  stream: string,
  events: readonly LogEvent[],
  blobs: ReadonlyMap<string, Blob>,
): Promise<void> {
  if (events.length === 0 && blobs.size === 0) return
  const db = await getDb()
  const tx = db.transaction(['events', 'blobs', 'sync', 'meta'], 'readwrite')
  for (const event of events) {
    await tx.objectStore('events').put(event)
    await tx.objectStore('sync').put({
      id: event.id,
      stream,
      seq: event.seq,
      status: 'uploaded',
      phase: 'done',
      attempts: 0,
    })
  }
  for (const [file, blob] of blobs) {
    await tx.objectStore('blobs').put({ file, blob })
  }
  const meta = tx.objectStore('meta')
  const key = SEQ_KEY(stream)
  const current = ((await meta.get(key)) as number | undefined) ?? 1
  const maxSeq = events.reduce((m, e) => Math.max(m, e.seq), 0)
  if (maxSeq + 1 > current) await meta.put(maxSeq + 1, key)
  await tx.done
}

export async function putSyncStatus(row: SyncStatusRow): Promise<void> {
  const db = await getDb()
  await db.put('sync', row)
}

/** Drop a local attachment blob (keepAudioLocally=false pruning — §8.4). */
export async function deleteBlob(file: string): Promise<void> {
  const db = await getDb()
  await db.delete('blobs', file)
}

export async function wipeAll(): Promise<void> {
  const db = await getDb()
  const tx = db.transaction(
    ['events', 'blobs', 'sync', 'places', 'geocache', 'meta', 'chats', 'overlayEvents'],
    'readwrite',
  )
  await Promise.all([
    tx.objectStore('events').clear(),
    tx.objectStore('blobs').clear(),
    tx.objectStore('sync').clear(),
    tx.objectStore('places').clear(),
    tx.objectStore('geocache').clear(),
    tx.objectStore('meta').clear(),
    tx.objectStore('chats').clear(),
    tx.objectStore('overlayEvents').clear(),
  ])
  await tx.done
}
