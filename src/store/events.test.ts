import 'fake-indexeddb/auto'
import { openDB } from 'idb'
import { beforeEach, describe, expect, it } from 'vitest'
import { eventBaseName } from '../contract/filenames'
import { getDb, resetDbCache } from './db'
import {
  appendAmend,
  appendCapture,
  appendRevoke,
  getBlob,
  getSyncStatuses,
  listEntries,
  listEvents,
  wipeAll,
} from './events'

function deleteDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error ?? new Error('deleteDatabase failed'))
    req.onblocked = () => reject(new Error('deleteDatabase blocked'))
  })
}

const AT = '2026-08-02T09:04:11-04:00'
const audioAttachment = () => ({
  kind: 'audio' as const,
  blob: new Blob(['hi'], { type: 'text/plain' }),
  mimeType: 'audio/mp4',
  durationSec: 3.2,
})

beforeEach(async () => {
  ;(await getDb()).close()
  resetDbCache()
  await deleteDb('timebox')
})

describe('appendCapture', () => {
  it('assigns seq 1,2,3… with independent counters per stream', async () => {
    const a = await appendCapture({ stream: 'timelog', capturedAt: AT, attachments: [] })
    const b = await appendCapture({ stream: 'timelog', capturedAt: AT, attachments: [] })
    const c = await appendCapture({ stream: 'timelog', capturedAt: AT, attachments: [] })
    const m = await appendCapture({ stream: 'meals', capturedAt: AT, attachments: [] })
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3])
    expect(m.seq).toBe(1)
    expect((await listEvents('timelog')).map((e) => e.seq)).toEqual([1, 2, 3])
    expect((await listEvents('meals')).map((e) => e.seq)).toEqual([1])
  })

  it('persists capture events retrievable via listEvents', async () => {
    const e = await appendCapture({
      stream: 'timelog',
      capturedAt: AT,
      location: { lat: 40.7, lng: -74, accuracyM: 10 },
      attachments: [],
    })
    const events = await listEvents('timelog')
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual(e)
  })

  it('names attachments per contract and stores retrievable blobs', async () => {
    const e = await appendCapture({ stream: 'timelog', capturedAt: AT, attachments: [audioAttachment()] })
    const file = e.attachments[0].file
    expect(file).toBe(`${eventBaseName(e)}.m4a`)
    expect(file).toMatch(/^000001_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}[+-]\d{4}_[0-9a-z]{6}\.m4a$/)
    const blob = await getBlob(file)
    expect(blob).toBeDefined()
    expect(await blob!.text()).toBe('hi')
  })

  it('queues sync status for each appended event', async () => {
    const e = await appendCapture({ stream: 'timelog', capturedAt: AT, attachments: [] })
    const statuses = await getSyncStatuses('timelog')
    expect(statuses.get(e.id)?.status).toBe('queued')
  })

  it('queues with attempts 0 and phase per attachment presence (SPEC §5.2)', async () => {
    const bare = await appendCapture({ stream: 'timelog', capturedAt: AT, attachments: [] })
    const withAudio = await appendCapture({
      stream: 'timelog',
      capturedAt: AT,
      attachments: [audioAttachment()],
    })
    const statuses = await getSyncStatuses('timelog')
    expect(statuses.get(bare.id)).toMatchObject({ attempts: 0, phase: 'record-pending' })
    expect(statuses.get(withAudio.id)).toMatchObject({ attempts: 0, phase: 'attachments-pending' })
  })
})

describe('db migration to v5 (events/sync re-keyed by id)', () => {
  it('drops [stream, seq]-keyed rows and re-keys both stores by id', async () => {
    // Seed a v1-shaped DB: events + sync keyed by [stream, seq] (Design C
    // makes that key unsound — two devices can mint the same seq offline).
    const v1 = await openDB('timebox', 1, {
      upgrade(db) {
        const events = db.createObjectStore('events', { keyPath: ['stream', 'seq'] })
        events.createIndex('by-stream', 'stream')
        db.createObjectStore('blobs', { keyPath: 'file' })
        db.createObjectStore('sync', { keyPath: ['stream', 'seq'] })
        db.createObjectStore('places', { keyPath: 'id' })
        db.createObjectStore('meta')
      },
    })
    await v1.put('sync', { stream: 'timelog', seq: 1, status: 'queued' })
    await v1.put('events', { stream: 'timelog', seq: 1, id: 'aaaaaa' })
    v1.close()
    resetDbCache()

    // Old rows are dropped (the local log is a replica; a pull rebuilds it)…
    expect(await listEvents('timelog')).toEqual([])
    expect((await getSyncStatuses('timelog')).size).toBe(0)

    // …and the re-keyed stores accept id-keyed appends.
    const e = await appendCapture({ stream: 'timelog', capturedAt: AT, attachments: [] })
    expect((await getSyncStatuses('timelog')).get(e.id)?.status).toBe('queued')
  })
})

describe('appendRevoke', () => {
  it('hides the entry from listEntries', async () => {
    const e = await appendCapture({ stream: 'timelog', capturedAt: AT, attachments: [] })
    expect(await listEntries('timelog')).toHaveLength(1)
    await appendRevoke({ stream: 'timelog', targets: [e.id] })
    expect(await listEntries('timelog')).toEqual([])
  })
})

describe('appendAmend', () => {
  it('patches capturedAt in the folded view', async () => {
    const e = await appendCapture({ stream: 'timelog', capturedAt: AT, attachments: [] })
    await appendAmend({
      stream: 'timelog',
      targets: [e.id],
      patch: { capturedAt: '2026-08-02T08:30:00-04:00' },
    })
    const entries = await listEntries('timelog')
    expect(entries).toHaveLength(1)
    expect(entries[0].capturedAt).toBe('2026-08-02T08:30:00-04:00')
    expect(entries[0].lastEventSeq).toBe(2)
  })
})

describe('wipeAll', () => {
  it('empties events, blobs, sync state, and resets seq counters', async () => {
    const e = await appendCapture({ stream: 'timelog', capturedAt: AT, attachments: [audioAttachment()] })
    const file = e.attachments[0].file
    await wipeAll()
    expect(await listEvents('timelog')).toEqual([])
    expect(await getBlob(file)).toBeUndefined()
    expect((await getSyncStatuses('timelog')).size).toBe(0)
    const fresh = await appendCapture({ stream: 'timelog', capturedAt: AT, attachments: [] })
    expect(fresh.seq).toBe(1)
  })
})
