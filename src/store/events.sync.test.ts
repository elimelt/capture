/**
 * Sync-specific edge case tests for the event repository — validates
 * importEvents behavior, seq counter management, and queue ordering.
 */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { EVENT_SCHEMA } from '../contract/types'
import type { CaptureEvent } from '../contract/types'
import { getDb, resetDbCache } from './db'
import {
  appendCapture,
  getSyncStatuses,
  importEvents,
  listEntries,
  listEvents,
  listPendingSync,
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

function remoteCapture(seq: number, id: string, loggedAt = AT): CaptureEvent {
  return {
    schema: EVENT_SCHEMA,
    type: 'capture',
    id,
    seq,
    stream: 'timelog',
    loggedAt,
    deviceTz: 'America/New_York',
    capturedAt: loggedAt,
    attachments: [],
  }
}

beforeEach(async () => {
  ;(await getDb()).close()
  resetDbCache()
  await deleteDb('timebox')
})

describe('importEvents', () => {
  it('marks imported events as uploaded (never re-pushed)', async () => {
    const remote = remoteCapture(1, 'remote')
    await importEvents('timelog', [remote], new Map())

    const statuses = await getSyncStatuses('timelog')
    const row = statuses.get('remote')
    expect(row).toBeDefined()
    expect(row?.status).toBe('uploaded')
    expect(row?.phase).toBe('done')
  })

  it('bumps seq counter past all imported seqs', async () => {
    await importEvents('timelog', [remoteCapture(5, 'rem5'), remoteCapture(3, 'rem3')], new Map())

    // Next local append should be seq 6
    const local = await appendCapture({ stream: 'timelog', capturedAt: AT, attachments: [] })
    expect(local.seq).toBe(6)
  })

  it('is idempotent — re-importing overwrites with identical data', async () => {
    const remote = remoteCapture(1, 'remote')
    await importEvents('timelog', [remote], new Map())
    await importEvents('timelog', [remote], new Map())

    const events = await listEvents('timelog')
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual(remote)
  })

  it('imports blobs keyed by contract filename', async () => {
    const blobContent = new Blob(['audio data'])
    const blobs = new Map([['000001_x.m4a', blobContent]])
    await importEvents('timelog', [remoteCapture(1, 'remote')], blobs)

    const { getBlob } = await import('./events')
    const stored = await getBlob('000001_x.m4a')
    expect(stored).toBeDefined()
    expect(await stored!.text()).toBe('audio data')
  })

  it('handles empty import gracefully', async () => {
    await importEvents('timelog', [], new Map())
    expect(await listEvents('timelog')).toEqual([])
  })
})

describe('listPendingSync ordering', () => {
  it('returns pending rows sorted by seq ascending', async () => {
    // Create events out of order to test sorting
    await appendCapture({ stream: 'timelog', capturedAt: AT, attachments: [] })
    await appendCapture({ stream: 'timelog', capturedAt: AT, attachments: [] })
    await appendCapture({ stream: 'timelog', capturedAt: AT, attachments: [] })

    const pending = await listPendingSync('timelog')
    expect(pending.map((r) => r.seq)).toEqual([1, 2, 3])
  })

  it('excludes uploaded events', async () => {
    const local = await appendCapture({ stream: 'timelog', capturedAt: AT, attachments: [] })
    const remote = remoteCapture(2, 'remote')
    await importEvents('timelog', [remote], new Map())

    const pending = await listPendingSync('timelog')
    expect(pending.map((r) => r.id)).toEqual([local.id])
  })

  it('excludes events from other streams', async () => {
    await appendCapture({ stream: 'timelog', capturedAt: AT, attachments: [] })
    await appendCapture({ stream: 'meals', capturedAt: AT, attachments: [] })

    const timelogPending = await listPendingSync('timelog')
    const mealsPending = await listPendingSync('meals')

    expect(timelogPending).toHaveLength(1)
    expect(mealsPending).toHaveLength(1)
    expect(timelogPending[0].stream).toBe('timelog')
    expect(mealsPending[0].stream).toBe('meals')
  })
})

describe('cross-device merge scenarios', () => {
  it('merges local and remote events with colliding seqs', async () => {
    // Local device mints seq 1
    const local = await appendCapture({ stream: 'timelog', capturedAt: AT, attachments: [] })
    expect(local.seq).toBe(1)

    // Remote device also minted seq 1 (offline collision)
    const remote = remoteCapture(1, 'remote', '2026-08-02T08:00:00-04:00')
    await importEvents('timelog', [remote], new Map())

    // Both events exist; fold orders them deterministically
    const events = await listEvents('timelog')
    expect(events).toHaveLength(2)
    expect(events.map((e) => e.id).sort()).toEqual([local.id, 'remote'].sort())

    // Fold should order by loggedAt when seq ties
    const entries = await listEntries('timelog')
    expect(entries).toHaveLength(2)
    // Remote has earlier loggedAt, so it comes first
    expect(entries[0].id).toBe('remote')
  })

  it('local append after import continues past remote seqs', async () => {
    await importEvents('timelog', [remoteCapture(10, 'rem10')], new Map())
    const local = await appendCapture({ stream: 'timelog', capturedAt: AT, attachments: [] })
    expect(local.seq).toBe(11)
  })

  it('handles multiple sequential imports', async () => {
    await importEvents('timelog', [remoteCapture(1, 'r1')], new Map())
    await importEvents('timelog', [remoteCapture(3, 'r3')], new Map())
    await importEvents('timelog', [remoteCapture(2, 'r2')], new Map())

    const events = await listEvents('timelog')
    expect(events.map((e) => e.id)).toEqual(['r1', 'r2', 'r3'])

    const local = await appendCapture({ stream: 'timelog', capturedAt: AT, attachments: [] })
    expect(local.seq).toBe(4)
  })
})
