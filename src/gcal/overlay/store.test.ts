import 'fake-indexeddb/auto'
import { openDB } from 'idb'
import { beforeEach, describe, expect, it } from 'vitest'
import { appendCapture, listEvents, wipeAll } from '../../store/events'
import { getDb, resetDbCache } from '../../store/db'
import {
  appendOverlayAmend,
  appendOverlayCreate,
  appendOverlayRevoke,
  listOverlayEvents,
  listOverlayStates,
} from './store'
import { OVERLAY_SCHEMA, OVERLAY_STREAM } from './types'
import type { CalendarEventRef, OverlayBaseSnapshot } from './types'

function deleteDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error ?? new Error('deleteDatabase failed'))
    req.onblocked = () => reject(new Error('deleteDatabase blocked'))
  })
}

const AT = '2026-08-02T09:04:11-04:00'
const TARGET: CalendarEventRef = { calendarId: 'primary@example.com', eventId: 'ev1' }
const SNAPSHOT: OverlayBaseSnapshot = {
  summary: 'Standup',
  startMs: 1_000,
  endMs: 2_000,
  allDay: false,
  updated: '2026-08-01T12:00:00.000Z',
}

beforeEach(async () => {
  ;(await getDb()).close()
  resetDbCache()
  await deleteDb('timebox')
})

describe('appendOverlayCreate', () => {
  it('mints a well-formed overlay event and assigns seq 1,2,3…', async () => {
    const a = await appendOverlayCreate({ target: TARGET, baseSnapshot: SNAPSHOT, patch: {} })
    const b = await appendOverlayCreate({
      target: { ...TARGET, eventId: 'ev2' },
      baseSnapshot: SNAPSHOT,
      patch: { title: 'Renamed' },
    })
    expect(a).toMatchObject({
      schema: OVERLAY_SCHEMA,
      type: 'overlay',
      stream: OVERLAY_STREAM,
      seq: 1,
      target: TARGET,
      baseSnapshot: SNAPSHOT,
      patch: {},
    })
    expect(a.id).toMatch(/^[0-9a-z]{6}$/)
    expect(b.seq).toBe(2)
    expect((await listOverlayEvents()).map((e) => e.seq)).toEqual([1, 2])
  })

  it('allocates its seq space independently of capture streams', async () => {
    await appendCapture({ stream: 'timelog', capturedAt: AT, attachments: [] })
    await appendCapture({ stream: 'timelog', capturedAt: AT, attachments: [] })
    const overlay = await appendOverlayCreate({ target: TARGET, baseSnapshot: SNAPSHOT, patch: {} })
    expect(overlay.seq).toBe(1)
    const capture = await appendCapture({ stream: 'timelog', capturedAt: AT, attachments: [] })
    expect(capture.seq).toBe(3)
  })

  it('keeps overlay events out of the capture events store and vice versa', async () => {
    await appendOverlayCreate({ target: TARGET, baseSnapshot: SNAPSHOT, patch: {} })
    expect(await listEvents(OVERLAY_STREAM)).toEqual([])
    await appendCapture({ stream: 'timelog', capturedAt: AT, attachments: [] })
    expect(await listOverlayEvents()).toHaveLength(1)
  })
})

describe('append/list/fold round-trip', () => {
  it('folds appended create + amend + revoke into overlay states', async () => {
    const created = await appendOverlayCreate({
      target: TARGET,
      baseSnapshot: SNAPSHOT,
      patch: { title: 'Renamed' },
    })
    await appendOverlayAmend({ targets: [created.id], patch: { note: 'brought donuts' } })

    let states = await listOverlayStates()
    expect(states).toHaveLength(1)
    expect(states[0]).toMatchObject({
      id: created.id,
      target: TARGET,
      patch: { title: 'Renamed', note: 'brought donuts' },
      lastEventSeq: 2,
      revoked: false,
    })

    await appendOverlayRevoke({ targets: [created.id] })
    states = await listOverlayStates()
    expect(states).toEqual([])
    const kept = await listOverlayStates({ includeRevoked: true })
    expect(kept[0]).toMatchObject({ id: created.id, revoked: true, lastEventSeq: 3 })
  })

  it('lists events in log order with loggedAt/deviceTz stamped', async () => {
    const created = await appendOverlayCreate({ target: TARGET, baseSnapshot: SNAPSHOT, patch: {} })
    const amended = await appendOverlayAmend({ targets: [created.id] })
    const events = await listOverlayEvents()
    expect(events.map((e) => e.id)).toEqual([created.id, amended.id])
    for (const e of events) {
      expect(e.loggedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
      expect(e.deviceTz.length).toBeGreaterThan(0)
    }
    expect('patch' in amended).toBe(false) // no patch supplied → omitted, not null
  })
})

describe('db migration to v8 (overlayEvents added)', () => {
  it('upgrades a v5-shaped db, leaving existing stores intact and overlayEvents empty', async () => {
    // Close the connection the beforeEach opened, then seed a v5 database.
    ;(await getDb()).close()
    resetDbCache()
    await deleteDb('timebox')
    const v5 = await openDB('timebox', 5, {
      upgrade(db) {
        const events = db.createObjectStore('events', { keyPath: 'id' })
        events.createIndex('by-stream', 'stream')
        db.createObjectStore('blobs', { keyPath: 'file' })
        db.createObjectStore('sync', { keyPath: 'id' })
        db.createObjectStore('places', { keyPath: 'id' })
        db.createObjectStore('meta')
        db.createObjectStore('chats', { keyPath: 'id' })
        db.createObjectStore('geocache', { keyPath: 'key' })
      },
    })
    await v5.put('events', { id: 'aaaaaa', stream: 'timelog', seq: 1 })
    await v5.put('meta', 2, 'nextSeq:timelog')
    await v5.put('places', { id: 'p1', name: 'Home', lat: 0, lng: 0, radiusM: 50 })
    v5.close()
    resetDbCache()

    const db = await getDb()
    // ≥ 8 rather than a pin: later state-guarded migrations (settings v9,
    // chats, waveform cache v11) raise the version without affecting the
    // overlay store.
    expect(db.version).toBeGreaterThanOrEqual(8)
    expect([...db.objectStoreNames].sort()).toEqual([
      'blobs',
      'chats',
      'events',
      'geocache',
      'meta',
      'overlayEvents',
      'places',
      'sync',
      'waveforms',
    ])
    // Existing data untouched…
    expect(await db.get('events', 'aaaaaa')).toEqual({ id: 'aaaaaa', stream: 'timelog', seq: 1 })
    expect(await db.get('meta', 'nextSeq:timelog')).toBe(2)
    expect((await db.getAll('places')).length).toBe(1)
    // …and the new store starts empty, indexed by stream.
    expect(await db.count('overlayEvents')).toBe(0)
    await appendOverlayCreate({ target: TARGET, baseSnapshot: SNAPSHOT, patch: {} })
    expect(await db.getAllFromIndex('overlayEvents', 'by-stream', OVERLAY_STREAM)).toHaveLength(1)
  })

  it('creates overlayEvents on a fresh database too', async () => {
    const db = await getDb()
    expect(db.objectStoreNames.contains('overlayEvents')).toBe(true)
    expect(await db.count('overlayEvents')).toBe(0)
  })
})

describe('wipeAll', () => {
  it('clears overlay events and resets the overlay seq counter', async () => {
    const created = await appendOverlayCreate({
      target: TARGET,
      baseSnapshot: SNAPSHOT,
      patch: { title: 'X' },
    })
    await appendOverlayAmend({ targets: [created.id], patch: { hidden: true } })
    expect(await listOverlayEvents()).toHaveLength(2)

    await wipeAll()
    expect(await listOverlayEvents()).toEqual([])
    expect(await listOverlayStates()).toEqual([])
    const fresh = await appendOverlayCreate({ target: TARGET, baseSnapshot: SNAPSHOT, patch: {} })
    expect(fresh.seq).toBe(1)
  })
})
