/**
 * IndexedDB layout (SPEC §10): the local working store + upload queue.
 * Everything is keyed by stream so additional streams are config, not schema.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { LogEvent } from '../contract/types'
import { migrateSettingsV1 } from './migrateSettingsV1'

export type SyncStatus = 'queued' | 'uploaded' | 'error'

/**
 * Upload progress per the atomic append protocol (SPEC §5.2): attachments
 * first, event record last — the record is the commit.
 */
export type SyncPhase = 'attachments-pending' | 'record-pending' | 'done'

export interface SyncStatusRow {
  /** The event's id — the identity (SPEC §3.3) and this row's key. */
  id: string
  stream: string
  /** The event's seq: ordering hint only, kept for drain order + display. */
  seq: number
  /** User-facing rollup; `phase` tracks the protocol state underneath. */
  status: SyncStatus
  /** 'done' iff status is 'uploaded'. */
  phase: SyncPhase
  attempts: number
  /** ISO local time; absent = eligible for upload now. */
  nextRetryAt?: string
  error?: string
  /**
   * Pre-generated Drive file ids (files.generateIds), keyed by contract
   * filename, persisted *before* each upload attempt so a retry re-uploads
   * with the same id — Drive answers 409 for an id that already landed, which
   * the client treats as success. Absent on rows written by older versions;
   * the drainer falls back to find-before-upload for those (SPEC §8.4).
   */
  fileIds?: Record<string, string>
}

export interface Place {
  id: string
  name: string
  lat: number
  lng: number
  radiusM: number
  /** Reverse-geocoded address ("near …"); filled when the place is added. */
  address?: string
}

/** Cached reverse-geocode result, keyed by rounded "lat,lng" (SPEC §7). */
export interface GeocacheRow {
  /** Rounded "lat,lng" cell key. */
  key: string
  address: string
  /** ISO local time the lookup was cached. */
  cachedAt: string
}

/**
 * A calendar-overlay log event (schema `capture.calendar-overlay.v1`,
 * SPEC §3.6/§5.6). The event shape belongs to gcal/overlay (store/ must stay
 * app-agnostic and never import gcal/), so rows are stored opaquely here
 * beyond the key + index fields; gcal/overlay/types.ts owns the strong typing
 * and gcal/overlay/store.ts is the store's only reader/writer.
 */
export interface OverlayEventRow {
  /** The overlay event's id — the identity and this row's key. */
  id: string
  /** Always 'calendar-overlay' today; indexed like `events` for symmetry. */
  stream: string
  /** Per-stream ordering hint, allocated from the shared meta counter. */
  seq: number
}

/**
 * A persisted assistant conversation. Message shape belongs to assistant/
 * (store/ must stay app-agnostic), so messages are stored opaquely here;
 * assistant/history.ts owns the strong typing.
 */
export interface StoredChatRow {
  id: string
  /** ISO local time. */
  createdAt: string
  /** ISO local time; bumped on every save. */
  updatedAt: string
  messages: unknown[]
}

export interface TimeboxDB extends DBSchema {
  /**
   * The local replica of the append-only log. Keyed by event `id` (the
   * identity — SPEC §3.3 fold): two devices appending offline can mint the
   * same per-stream `seq`, so `seq` is only a non-unique ordering hint and
   * must not be part of the key. Sequenced access uses the by-stream index.
   */
  events: {
    key: string
    value: LogEvent
    indexes: { 'by-stream': string }
  }
  /** Attachment blobs, keyed by contract filename. */
  blobs: {
    key: string
    value: { file: string; blob: Blob }
  }
  /** Upload state per event, keyed by event `id` (same identity as events). */
  sync: {
    key: string
    value: SyncStatusRow
  }
  places: {
    key: string
    value: Place
  }
  /** Reverse-geocode cache: coordinates → address, so we hit Nominatim once. */
  geocache: {
    key: string
    value: GeocacheRow
  }
  /** Small key-value bag: settings, per-stream counters. */
  meta: {
    key: string
    value: unknown
  }
  /** Assistant conversations, one row per chat. */
  chats: {
    key: string
    value: StoredChatRow
  }
  /**
   * The calendar-overlay append-only log (owned by gcal/overlay; SPEC §3.6,
   * §5.6). Keyed by event `id` with a `by-stream` index, mirroring `events`.
   * Local-only until the multi-stream sync engine lands.
   */
  overlayEvents: {
    key: string
    value: OverlayEventRow
    indexes: { 'by-stream': string }
  }
}

export type TimeboxDatabase = IDBPDatabase<TimeboxDB>

let dbPromise: Promise<TimeboxDatabase> | undefined

export function getDb(): Promise<TimeboxDatabase> {
  dbPromise ??= openDB<TimeboxDB>('timebox', 9, {
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
      if (oldVersion < 3) {
        // v3: assistant chats get their own store (one row per conversation).
        // The old single conversation lived under meta 'assistant:chat';
        // migrate it into a chats row so it becomes the most recent chat.
        db.createObjectStore('chats', { keyPath: 'id' })
        const meta = tx.objectStore('meta')
        const legacy = (await meta.get('assistant:chat')) as unknown[] | undefined
        if (Array.isArray(legacy) && legacy.length > 0) {
          const now = new Date().toISOString()
          await tx.objectStore('chats').put({
            id: crypto.randomUUID(),
            createdAt: now,
            updatedAt: now,
            messages: legacy,
          })
        }
        if (legacy !== undefined) await meta.delete('assistant:chat')
      }
      if (oldVersion < 4) {
        // v4: reverse-geocode cache so a coordinate cell is looked up once.
        db.createObjectStore('geocache', { keyPath: 'key' })
      }
      if (oldVersion < 5) {
        // v5: re-key events and sync rows by `id` (the fold identity) instead
        // of [stream, seq]. seq is only a non-unique ordering hint now, so it
        // cannot be part of a key: two devices appending offline may mint the
        // same (stream, seq) with different ids (SPEC §3.3, Design C).
        // The local log is a replica of Drive; a re-pull rebuilds it, so we
        // drop and recreate rather than migrate rows.
        if (db.objectStoreNames.contains('events')) db.deleteObjectStore('events')
        const events = db.createObjectStore('events', { keyPath: 'id' })
        events.createIndex('by-stream', 'stream')
        if (db.objectStoreNames.contains('sync')) db.deleteObjectStore('sync')
        db.createObjectStore('sync', { keyPath: 'id' })
      }
      // Version 7 is reserved for the in-flight chats stream migration,
      // which may land before or after v8/v9 — so this body is
      // self-contained and additive (guarded by a contains check) and
      // composes with them in either order.
      if (oldVersion < 8 && !db.objectStoreNames.contains('overlayEvents')) {
        // v8: the calendar-overlay append-only log (SPEC §3.6, §5.6), owned
        // by gcal/overlay and stored opaquely here. Keyed by event id with a
        // by-stream index, mirroring `events`; existing stores untouched.
        const overlay = db.createObjectStore('overlayEvents', { keyPath: 'id' })
        overlay.createIndex('by-stream', 'stream')
      }
      // v9: settings become an event-sourced system stream; legacy meta
      // settings are seeded into `settings`-stream events. Deliberately NOT
      // `if (oldVersion < 9)`: parallel workstreams claim their own version
      // numbers and can land in any order (v8 above shipped first; v7 is
      // still in flight), so a device may already sit at a higher version
      // without this migration having run. The call is state-guarded
      // instead — migrateSettingsV1 no-ops once its meta marker exists (and
      // on fresh installs, where there is nothing to migrate) — so running
      // it on every upgrade is idempotent. Any branch adding a migration
      // must raise the version above the current max so upgrade() fires;
      // each state-guarded block then self-selects.
      await migrateSettingsV1(tx)
    },
  })
  return dbPromise
}

/** Test hook: forget the cached connection (e.g. after deleting the DB). */
export function resetDbCache(): void {
  dbPromise = undefined
}
