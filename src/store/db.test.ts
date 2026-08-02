import 'fake-indexeddb/auto'
import { forceCloseDatabase } from 'fake-indexeddb'
import { unwrap } from 'idb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DB_BLOCKED_MESSAGE, getDb, resetDbCache } from './db'

function deleteDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error ?? new Error('deleteDatabase failed'))
    req.onblocked = () => reject(new Error('deleteDatabase blocked'))
  })
}

/** Raw-open `timebox` at `version` with a no-op upgrade; resolves connected. */
function rawOpen(version: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('timebox', version)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('open failed'))
  })
}

/**
 * Build the v1 database with raw IndexedDB — the exact schema getDb()'s v1
 * block produces — and keep the connection open (no versionchange handler),
 * exactly like a stale background tab holding the old version.
 */
function openLegacyV1Db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('timebox', 1)
    req.onupgradeneeded = () => {
      const db = req.result
      const events = db.createObjectStore('events', { keyPath: ['stream', 'seq'] })
      events.createIndex('by-stream', 'stream')
      db.createObjectStore('blobs', { keyPath: 'file' })
      db.createObjectStore('sync', { keyPath: ['stream', 'seq'] })
      db.createObjectStore('places', { keyPath: 'id' })
      db.createObjectStore('meta')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('open failed'))
  })
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

beforeEach(async () => {
  resetDbCache()
  await deleteDb('timebox')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getDb lifecycle', () => {
  it('memoizes the healthy connection', async () => {
    const promise = getDb()
    expect(getDb()).toBe(promise)
    const db = await promise
    expect(await getDb()).toBe(db)
    db.close()
  })

  it('does not memoize a rejected open: the next getDb() retries', async () => {
    // A DB already upgraded past what this code opens (e.g. by a newer tab)
    // makes openDB reject with VersionError — mapped to a reload prompt.
    ;(await rawOpen(9999)).close()
    await expect(getDb()).rejects.toThrow(/updated in another tab/)
    // The failure was not cached: once the obstacle is gone, getDb() works.
    await deleteDb('timebox')
    const db = await getDb()
    expect(Array.from(db.objectStoreNames)).toContain('events')
    db.close()
  })

  it('blocked: surfaces the boot-splash note, then proceeds once the old tab closes', async () => {
    const note = { textContent: 'Capture' }
    vi.stubGlobal('document', {
      getElementById: (id: string) => (id === 'splash' ? { querySelector: () => note } : null),
    })
    const staleTab = await openLegacyV1Db()
    const opening = getDb() // needs a v1 → current upgrade; staleTab blocks it
    await tick()
    expect(note.textContent).toBe(DB_BLOCKED_MESSAGE)
    staleTab.close() // user closes the other Capture tab
    const db = await opening
    expect(db.version).toBeGreaterThan(1)
    expect(Array.from(db.objectStoreNames)).toContain('overlayEvents')
    db.close()
  })

  it('blocking: closes the connection so a newer-version open elsewhere proceeds', async () => {
    const db = await getDb()
    // Another context (a tab running a newer deploy) asks for a newer version.
    const newer = db.version + 1
    const newerTab = await rawOpen(newer) // resolves only if blocking() released us
    expect(newerTab.version).toBe(newer)
    // Our handle really closed — any further use fails fast, not silently.
    expect(() => db.transaction('meta')).toThrow()
    newerTab.close()
    // And the memo was cleared: getDb() attempts a fresh open (which this
    // stale code rightly cannot complete against the newer-version DB —
    // reload prompt), not a replay of the resolved promise on a dead handle.
    await expect(getDb()).rejects.toThrow(/updated in another tab/)
  })

  it('terminated: forgets the dead handle so the next getDb() reconnects', async () => {
    const db = await getDb()
    // Abnormal closure (browser reclaiming resources, DevTools clearing data).
    forceCloseDatabase(unwrap(db) as unknown as typeof IDBDatabase)
    await tick()
    const reconnected = await getDb()
    expect(reconnected).not.toBe(db)
    await reconnected.put('meta', 1, 'db-test') // usable connection
    expect(await reconnected.get('meta', 'db-test')).toBe(1)
    reconnected.close()
  })
})
