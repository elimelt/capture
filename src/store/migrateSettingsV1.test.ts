import { beforeEach, describe, expect, it } from 'vitest'
import type { CaptureEvent } from '../contract/types'
import { parseEvent, serializeEvent } from '../contract/serialize'
import { getDb, resetDbCache } from './db'
import { getBlob, listEvents, listPendingSync } from './events'
import { migrateSettingsV1, SETTINGS_MIGRATION_MARKER } from './migrateSettingsV1'
import {
  getSettings,
  getStreamSettings,
  parseSettingsPayload,
  SETTINGS_STREAM,
  type SettingsPayload,
} from './settings'

function deleteDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error ?? new Error('deleteDatabase failed'))
    req.onblocked = () => reject(new Error('deleteDatabase blocked'))
  })
}

beforeEach(async () => {
  ;(await getDb()).close()
  resetDbCache()
  await deleteDb('timebox')
})

/**
 * Build the pre-migration (v5) database with raw IndexedDB — the exact
 * schema getDb()'s v1–v5 blocks produce — seeded with legacy meta rows.
 */
function createLegacyV5Db(meta: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('timebox', 5)
    req.onupgradeneeded = () => {
      const db = req.result
      const events = db.createObjectStore('events', { keyPath: 'id' })
      events.createIndex('by-stream', 'stream')
      db.createObjectStore('blobs', { keyPath: 'file' })
      db.createObjectStore('sync', { keyPath: 'id' })
      db.createObjectStore('places', { keyPath: 'id' })
      db.createObjectStore('geocache', { keyPath: 'key' })
      db.createObjectStore('chats', { keyPath: 'id' })
      const metaStore = db.createObjectStore('meta')
      for (const [key, value] of Object.entries(meta)) metaStore.put(value, key)
    }
    req.onsuccess = () => {
      req.result.close()
      resolve()
    }
    req.onerror = () => reject(req.error ?? new Error('open failed'))
  })
}

async function migratedPayloads(): Promise<SettingsPayload[]> {
  const events = (await listEvents(SETTINGS_STREAM)) as CaptureEvent[]
  const out: SettingsPayload[] = []
  for (const e of events) {
    const blob = await getBlob(e.attachments[0].file)
    const p = parseSettingsPayload(await blob!.text())
    if (p) out.push(p)
  }
  return out
}

/** Re-run the migration against the open (already-migrated) database. */
async function rerunMigration(): Promise<void> {
  const db = await getDb()
  const tx = db.transaction(['events', 'blobs', 'sync', 'meta'], 'readwrite')
  await migrateSettingsV1(tx)
  await tx.done
}

const LEGACY_APP = {
  locationEnabled: false,
  enrichmentEnabled: false,
  assistantEnabled: false,
  assistantModel: 'gemma3:27b',
}
const LEGACY_TIMELOG = { maxClipSec: 60, keepAudioLocally: false }

describe('migrateSettingsV1 (db v9)', () => {
  it('seeds events only for keys differing from defaults', async () => {
    await createLegacyV5Db({
      'settings:app': LEGACY_APP,
      'settings:stream:timelog': LEGACY_TIMELOG,
    })
    await getDb() // v5 → v9 upgrade runs the migration

    const payloads = await migratedPayloads()
    // assistantEnabled and maxClipSec match defaults — no events for them.
    expect(new Map(payloads.map((p) => [p.key, p.op === 'set' ? p.value : undefined]))).toEqual(
      new Map<string, unknown>([
        ['app.locationEnabled', false],
        ['app.assistantModel', 'gemma3:27b'],
        ['stream.timelog.keepAudioLocally', false],
      ]),
    )

    // The event-sourced getters see the migrated values.
    expect(await getSettings()).toEqual(LEGACY_APP)
    expect(await getStreamSettings('timelog')).toEqual(LEGACY_TIMELOG)
  })

  it('migrated events are push-ready: queued sync rows, monotonic seq, bumped counter', async () => {
    await createLegacyV5Db({
      'settings:app': LEGACY_APP,
      'settings:stream:timelog': LEGACY_TIMELOG,
    })
    const db = await getDb()

    const events = await listEvents(SETTINGS_STREAM)
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3])
    expect(await db.get('meta', `nextSeq:${SETTINGS_STREAM}`)).toBe(4)

    const pending = await listPendingSync(SETTINGS_STREAM)
    expect(pending).toHaveLength(3)
    for (const row of pending) {
      expect(row.status).toBe('queued')
      expect(row.phase).toBe('attachments-pending')
    }
  })

  it('migrated events round-trip the wire format (parseEvent ∘ serializeEvent)', async () => {
    await createLegacyV5Db({ 'settings:app': LEGACY_APP })
    await getDb()
    const events = await listEvents(SETTINGS_STREAM)
    expect(events.length).toBeGreaterThan(0)
    for (const e of events) {
      expect(parseEvent(serializeEvent(e))).toEqual(e)
      expect(e.type).toBe('capture')
      expect((e as CaptureEvent).capturedAt).toBe(e.loggedAt)
    }
  })

  it('is idempotent: a second run adds no duplicate events', async () => {
    await createLegacyV5Db({
      'settings:app': LEGACY_APP,
      'settings:stream:timelog': LEGACY_TIMELOG,
    })
    await getDb()
    const first = await listEvents(SETTINGS_STREAM)
    expect(first).toHaveLength(3)

    await rerunMigration()
    expect(await listEvents(SETTINGS_STREAM)).toHaveLength(3)
  })

  it('is a no-op on a fresh install (no legacy keys) and marks itself applied', async () => {
    const db = await getDb()
    expect(await listEvents(SETTINGS_STREAM)).toHaveLength(0)
    expect(await db.get('meta', SETTINGS_MIGRATION_MARKER)).toBe(true)
  })

  it('runs off the state guard, not the version number: applies on a later upgrade if skipped', async () => {
    // A device that reached a later version via a parallel branch's migration (which knew
    // nothing of settings): legacy keys present, marker absent. The next
    // version bump must still apply this migration even though oldVersion is
    // already past this one — modelled here by invoking the state-guarded call the
    // way db.ts does on every upgrade.
    await createLegacyV5Db({ 'settings:app': LEGACY_APP })
    const db = await getDb()
    await db.delete('meta', SETTINGS_MIGRATION_MARKER)
    const settingsEvents = await listEvents(SETTINGS_STREAM)
    for (const e of settingsEvents) {
      await db.delete('events', e.id)
      await db.delete('sync', e.id)
    }

    await rerunMigration()
    expect(await listEvents(SETTINGS_STREAM)).toHaveLength(2) // locationEnabled + assistantModel
    expect(await db.get('meta', SETTINGS_MIGRATION_MARKER)).toBe(true)
  })

  it('keeps the legacy meta keys as a rollback artifact', async () => {
    await createLegacyV5Db({ 'settings:app': LEGACY_APP })
    const db = await getDb()
    expect(await db.get('meta', 'settings:app')).toEqual(LEGACY_APP)
  })

  it('ignores legacy fields with the wrong runtime type', async () => {
    await createLegacyV5Db({
      'settings:app': { locationEnabled: 'nope', assistantModel: 42 },
      'settings:stream:timelog': { maxClipSec: '90', keepAudioLocally: false },
    })
    await getDb()
    const payloads = await migratedPayloads()
    expect(payloads.map((p) => p.key)).toEqual(['stream.timelog.keepAudioLocally'])
  })
})
