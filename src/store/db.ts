/**
 * IndexedDB layout (SPEC §10): the local working store + upload queue.
 * Everything is keyed by stream so additional streams are config, not schema.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { LogEvent } from '../contract/types'
import { migrateChatsV1 } from './migrateChatsV1'
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
  /**
   * Legacy (unused): older versions persisted a backoff stamp here and
   * skipped rows inside the window. Sync is manual-only, so a user's "Sync
   * now" must attempt every queued row — the drainer no longer writes or
   * consults this; rows from older versions may still carry it.
   */
  nextRetryAt?: string
  error?: string
  /**
   * Pre-generated Drive file ids (files.generateIds), keyed by contract
   * filename, persisted *before* each upload attempt so a retry re-uploads
   * with the same id — Drive answers 409 for an id that already landed, which
   * the client treats as success. A `.ndjson` key is a segment assignment
   * (SPEC §5.7): the same segment filename+id pair is persisted on every
   * member row, pinning the batch across crashed drains. Absent on rows
   * written by older versions; the drainer falls back to find-before-upload
   * for those (SPEC §8.4).
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
  /** Omitted for a cached "no address found" (negative) result. */
  address?: string
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
  /**
   * Cached per-clip waveform peaks (#86), keyed by the audio attachment's
   * contract filename — same keying discipline as `blobs`. Purely derived,
   * rebuildable data: never synced, never an event, cleared by `wipeAll`.
   */
  waveforms: {
    key: string
    value: { file: string; peaks: number[] }
  }
}

export type TimeboxDatabase = IDBPDatabase<TimeboxDB>

let dbPromise: Promise<TimeboxDatabase> | undefined

/** Boot-splash note shown while a version upgrade is blocked by another tab. */
export const DB_BLOCKED_MESSAGE = 'Close other Capture tabs or windows to finish updating'

/**
 * Surface a blocked upgrade on the boot splash (index.html). `blocked` fires
 * before React mounts — openDB is still pending, so `init()` never settles and
 * the splash is the only UI on screen — hence direct DOM, not store state.
 * No-ops once the splash is gone (post-boot) or without a DOM (tests).
 */
function noteUpgradeBlocked(): void {
  if (typeof document === 'undefined') return
  const note = document.getElementById('splash')?.querySelector('p')
  if (note) note.textContent = DB_BLOCKED_MESSAGE
}

/** Forget the memoized connection iff it is still the current one. */
function forget(promise: Promise<TimeboxDatabase>): void {
  if (dbPromise === promise) dbPromise = undefined
}

export function getDb(): Promise<TimeboxDatabase> {
  if (dbPromise) return dbPromise
  const promise: Promise<TimeboxDatabase> = openDB<TimeboxDB>('timebox', 11, {
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
      // Versions 6–7 were reserved while the sync-everything workstreams were
      // in flight; the migrations below are self-contained and additive so
      // they compose regardless of landing order.
      if (oldVersion < 8 && !db.objectStoreNames.contains('overlayEvents')) {
        // v8: the calendar-overlay append-only log (SPEC §3.6, §5.6), owned
        // by gcal/overlay and stored opaquely here. Keyed by event id with a
        // by-stream index, mirroring `events`; existing stores untouched.
        const overlay = db.createObjectStore('overlayEvents', { keyPath: 'id' })
        overlay.createIndex('by-stream', 'stream')
      }
      if (oldVersion < 11 && !db.objectStoreNames.contains('waveforms')) {
        // v11: cached per-clip waveform peaks (#86), keyed by attachment
        // filename like `blobs`. Purely derived/rebuildable — additive and
        // self-contained, mirroring the v8 pattern.
        db.createObjectStore('waveforms', { keyPath: 'file' })
      }
      // v9: settings become an event-sourced system stream; legacy meta
      // settings are seeded into `settings`-stream events. Deliberately NOT
      // `if (oldVersion < 9)`: parallel workstreams claim their own version
      // numbers and can land in any order, so a device may already sit at a
      // higher version without this migration having run. The call is
      // state-guarded instead — migrateSettingsV1 no-ops once its meta marker
      // exists (and on fresh installs, where there is nothing to migrate) —
      // so running it on every upgrade is idempotent. Any branch adding a
      // migration must raise the version above the current max so upgrade()
      // fires; each state-guarded block then self-selects.
      await migrateSettingsV1(tx)
      // v10: legacy `chats` rows become events in the 'assistant-chats'
      // stream. Same pattern as v9: runs on every version change and guards
      // itself by "has it been applied" (meta marker + stream-state check
      // inside migrateChatsV1) — never by oldVersion. Idempotent.
      await migrateChatsV1(tx)
    },
    blocked() {
      // Our upgrade is waiting on an old-version connection in another
      // tab/window (openDB stays pending, so boot sits on the splash).
      // Make the wait actionable instead of an infinite silent splash.
      noteUpgradeBlocked()
    },
    blocking() {
      // This connection is holding up a NEWER version elsewhere (a tab that
      // loaded a deploy with a higher DB version). Close so that tab can
      // upgrade, and forget the memo: the next getDb() here reopens — same
      // version if this code is current, or a fast VersionError (mapped to a
      // reload prompt below, surfaced via the store's lastError) if this tab
      // is stale — instead of wedging the other tab's boot forever.
      forget(promise)
      void promise.then(
        (db) => db.close(),
        () => undefined,
      )
    },
    terminated() {
      // The browser force-closed the connection behind our back; forget the
      // memo so the next getDb() reconnects instead of using a dead handle.
      forget(promise)
    },
  }).catch((err: unknown) => {
    // Never memoize a rejection: one transient open failure must not brick
    // every later getDb() in the session — forget so the next call retries.
    forget(promise)
    if (err instanceof Error && err.name === 'VersionError') {
      // Another tab already upgraded the DB past what this code opens: only
      // newer code can open it. Say so instead of leaking IndexedDB jargon.
      throw new Error('Capture was updated in another tab — reload this page to continue.')
    }
    throw err
  })
  dbPromise = promise
  return promise
}

/** Test hook: forget the cached connection (e.g. after deleting the DB). */
export function resetDbCache(): void {
  dbPromise = undefined
}
