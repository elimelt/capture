/**
 * IndexedDB layout (SPEC §10): the local working store + upload queue.
 * Everything is keyed by stream so additional streams are config, not schema.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { LogEvent } from '../contract/types'

export type SyncStatus = 'queued' | 'uploaded' | 'error'

/**
 * Upload progress per the atomic append protocol (SPEC §5.2): attachments
 * first, event record last — the record is the commit.
 */
export type SyncPhase = 'attachments-pending' | 'record-pending' | 'done'

export interface SyncStatusRow {
  stream: string
  seq: number
  /** User-facing rollup; `phase` tracks the protocol state underneath. */
  status: SyncStatus
  /** 'done' iff status is 'uploaded'. */
  phase: SyncPhase
  attempts: number
  /** ISO local time; absent = eligible for upload now. */
  nextRetryAt?: string
  error?: string
}

export interface Place {
  id: string
  name: string
  lat: number
  lng: number
  radiusM: number
}

interface TimeboxDB extends DBSchema {
  /** The local replica of the append-only log. Key: [stream, seq]. */
  events: {
    key: [string, number]
    value: LogEvent
    indexes: { 'by-stream': string }
  }
  /** Attachment blobs, keyed by contract filename. */
  blobs: {
    key: string
    value: { file: string; blob: Blob }
  }
  /** Upload state per event. Key: [stream, seq]. */
  sync: {
    key: [string, number]
    value: SyncStatusRow
  }
  places: {
    key: string
    value: Place
  }
  /** Small key-value bag: settings, per-stream counters. */
  meta: {
    key: string
    value: unknown
  }
}

export type TimeboxDatabase = IDBPDatabase<TimeboxDB>

let dbPromise: Promise<TimeboxDatabase> | undefined

export function getDb(): Promise<TimeboxDatabase> {
  dbPromise ??= openDB<TimeboxDB>('timebox', 2, {
    async upgrade(db, oldVersion, _newVersion, tx) {
      if (oldVersion < 1) {
        const events = db.createObjectStore('events', { keyPath: ['stream', 'seq'] })
        events.createIndex('by-stream', 'stream')
        db.createObjectStore('blobs', { keyPath: 'file' })
        db.createObjectStore('sync', { keyPath: ['stream', 'seq'] })
        db.createObjectStore('places', { keyPath: 'id' })
        db.createObjectStore('meta')
      }
      if (oldVersion < 2) {
        // v2: sync rows gain attempts/phase. Queued rows may or may not have
        // attachments; 'attachments-pending' is safe either way since
        // re-uploads are idempotent by filename (SPEC §5.2).
        let cursor = await tx.objectStore('sync').openCursor()
        while (cursor) {
          await cursor.update({
            ...cursor.value,
            attempts: 0,
            phase: cursor.value.status === 'uploaded' ? 'done' : 'attachments-pending',
          })
          cursor = await cursor.continue()
        }
      }
    },
  })
  return dbPromise
}

/** Test hook: forget the cached connection (e.g. after deleting the DB). */
export function resetDbCache(): void {
  dbPromise = undefined
}
