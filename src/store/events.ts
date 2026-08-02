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
import { fold } from '../contract/fold'
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
  return db.getAllFromIndex('events', 'by-stream', stream)
}

/** The folded, user-visible view (SPEC §3.3). */
export async function listEntries(stream: string): Promise<Entry[]> {
  return fold(await listEvents(stream))
}

export async function getBlob(file: string): Promise<Blob | undefined> {
  const db = await getDb()
  return (await db.get('blobs', file))?.blob
}

/** Sync status by seq for one stream (M1: everything stays 'queued'). */
export async function getSyncStatuses(stream: string): Promise<Map<number, SyncStatusRow>> {
  const db = await getDb()
  const all = await db.getAll('sync')
  return new Map(all.filter((r) => r.stream === stream).map((r) => [r.seq, r]))
}

/**
 * Rows not yet uploaded for a stream, in [stream, seq] order — the order the
 * drainer must respect so the log commits monotonically (SPEC §5.2, §8.4).
 */
export async function listPendingSync(stream: string): Promise<SyncStatusRow[]> {
  const db = await getDb()
  const all = await db.getAll('sync')
  return all
    .filter((r) => r.stream === stream && r.status !== 'uploaded')
    .sort((a, b) => a.seq - b.seq)
}

export async function getEvent(stream: string, seq: number): Promise<LogEvent | undefined> {
  const db = await getDb()
  return db.get('events', [stream, seq])
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
    ['events', 'blobs', 'sync', 'places', 'geocache', 'meta', 'chats'],
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
  ])
  await tx.done
}
