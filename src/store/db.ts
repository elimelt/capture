/**
 * IndexedDB layout (SPEC §10): the local working store + upload queue.
 * Everything is keyed by stream so additional streams are config, not schema.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { LogEvent } from '../contract/types'

export type SyncStatus = 'queued' | 'uploaded' | 'error'

export interface SyncStatusRow {
  stream: string
  seq: number
  status: SyncStatus
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
  dbPromise ??= openDB<TimeboxDB>('timebox', 1, {
    upgrade(db) {
      const events = db.createObjectStore('events', { keyPath: ['stream', 'seq'] })
      events.createIndex('by-stream', 'stream')
      db.createObjectStore('blobs', { keyPath: 'file' })
      db.createObjectStore('sync', { keyPath: ['stream', 'seq'] })
      db.createObjectStore('places', { keyPath: 'id' })
      db.createObjectStore('meta')
    },
  })
  return dbPromise
}

/** Test hook: forget the cached connection (e.g. after deleting the DB). */
export function resetDbCache(): void {
  dbPromise = undefined
}
