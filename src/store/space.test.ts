import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { serializeEvent } from '../contract/serialize'
import type { CaptureEvent } from '../contract/types'
import { EVENT_SCHEMA } from '../contract/types'
import { getDb, resetDbCache, type StoredChatRow } from './db'
import { appendCapture, wipeAll } from './events'
import { estimateLocalSpace, formatBytes, measureAppSpace, summarizeAppSpace } from './space'

function deleteDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error ?? new Error('deleteDatabase failed'))
    req.onblocked = () => reject(new Error('deleteDatabase blocked'))
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('formatBytes', () => {
  it('renders sub-KB values in bytes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1)).toBe('1 B')
    expect(formatBytes(999)).toBe('999 B')
  })

  it('scales through decimal units with one decimal below 10', () => {
    expect(formatBytes(1000)).toBe('1 KB')
    expect(formatBytes(1500)).toBe('1.5 KB')
    expect(formatBytes(47_000)).toBe('47 KB')
    expect(formatBytes(15_000_000_000)).toBe('15 GB')
    expect(formatBytes(2_400_000_000_000)).toBe('2.4 TB')
  })

  it('never collapses small usage to "0.0 MB" (the old fixed-MB display did)', () => {
    // Bug: the previous Settings line always divided by 1 MiB, so anything
    // under ~52 KB rendered as "0.0 MB used".
    expect(formatBytes(51_200)).toBe('51 KB')
    expect(formatBytes(300)).toBe('300 B')
  })

  it('uses decimal MB, not MiB mislabeled as MB (the old math was binary)', () => {
    // Bug: the old display computed 3_500_000 / 1_048_576 = "3.3 MB"; the
    // decimal convention Drive and OSes report in says 3.5 MB.
    expect(formatBytes(3_500_000)).toBe('3.5 MB')
  })

  it('carries rounding into the next unit instead of showing "1000 KB"', () => {
    expect(formatBytes(999_500)).toBe('1 MB')
  })

  it('treats non-finite and negative input as empty', () => {
    expect(formatBytes(Number.NaN)).toBe('0 B')
    expect(formatBytes(-5)).toBe('0 B')
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 B')
  })
})

describe('estimateLocalSpace', () => {
  it('returns usage and quota when the API reports them', async () => {
    vi.stubGlobal('navigator', {
      storage: { estimate: async () => ({ usage: 1234, quota: 5_000_000 }) },
    })
    expect(await estimateLocalSpace()).toEqual({ usageBytes: 1234, quotaBytes: 5_000_000 })
  })

  it('omits fields the browser leaves undefined', async () => {
    vi.stubGlobal('navigator', { storage: { estimate: async () => ({ usage: 42 }) } })
    expect(await estimateLocalSpace()).toEqual({ usageBytes: 42 })
  })

  it('returns null when navigator.storage.estimate is unsupported', async () => {
    vi.stubGlobal('navigator', {})
    expect(await estimateLocalSpace()).toBeNull()
    vi.stubGlobal('navigator', { storage: {} })
    expect(await estimateLocalSpace()).toBeNull()
  })

  it('returns null when the estimate call rejects', async () => {
    vi.stubGlobal('navigator', {
      storage: {
        estimate: () => Promise.reject(new Error('nope')),
      },
    })
    expect(await estimateLocalSpace()).toBeNull()
  })
})

const captureEvent: CaptureEvent = {
  schema: EVENT_SCHEMA,
  type: 'capture',
  id: 'ev-1',
  seq: 1,
  stream: 'timelog',
  loggedAt: '2026-08-02T09:04:11-04:00',
  deviceTz: 'America/New_York',
  capturedAt: '2026-08-02T09:00:00-04:00',
  attachments: [],
}

describe('summarizeAppSpace', () => {
  it('returns zeros for an empty store', () => {
    expect(summarizeAppSpace([], [], [])).toEqual({
      eventCount: 0,
      eventBytes: 0,
      blobCount: 0,
      blobBytes: 0,
      chatCount: 0,
      chatBytes: 0,
      totalBytes: 0,
    })
  })

  it('counts events at their canonical serialized byte size', () => {
    const expected = new TextEncoder().encode(serializeEvent(captureEvent)).length
    const space = summarizeAppSpace([captureEvent], [], [])
    expect(space.eventCount).toBe(1)
    expect(space.eventBytes).toBe(expected)
    expect(space.totalBytes).toBe(expected)
  })

  it('sums blob sizes in bytes, not characters', () => {
    // 'héllo' is 5 characters but 6 UTF-8 bytes.
    const space = summarizeAppSpace([], [{ blob: new Blob(['héllo']) }, { blob: new Blob(['hi']) }], [])
    expect(space.blobCount).toBe(2)
    expect(space.blobBytes).toBe(8)
  })

  it('measures chats as serialized JSON bytes and totals all three parts', () => {
    const chat: StoredChatRow = {
      id: 'c1',
      createdAt: '2026-08-02T09:00:00-04:00',
      updatedAt: '2026-08-02T09:05:00-04:00',
      messages: [{ role: 'user', content: 'héllo' }],
    }
    const chatBytes = new TextEncoder().encode(JSON.stringify(chat)).length
    const space = summarizeAppSpace([captureEvent], [{ blob: new Blob(['abc']) }], [chat])
    expect(space.chatCount).toBe(1)
    expect(space.chatBytes).toBe(chatBytes)
    expect(space.totalBytes).toBe(space.eventBytes + 3 + chatBytes)
  })
})

describe('measureAppSpace', () => {
  beforeEach(async () => {
    ;(await getDb()).close()
    resetDbCache()
    await deleteDb('timebox')
  })

  it('measures what the repo actually persisted', async () => {
    const event = await appendCapture({
      stream: 'timelog',
      capturedAt: '2026-08-02T09:00:00-04:00',
      attachments: [
        { kind: 'audio', blob: new Blob(['audio-bytes']), mimeType: 'audio/mp4', durationSec: 2 },
      ],
    })
    const space = await measureAppSpace()
    expect(space.eventCount).toBe(1)
    expect(space.eventBytes).toBe(new TextEncoder().encode(serializeEvent(event)).length)
    expect(space.blobCount).toBe(1)
    expect(space.blobBytes).toBe(new Blob(['audio-bytes']).size)
    expect(space.chatCount).toBe(0)
    expect(space.totalBytes).toBe(space.eventBytes + space.blobBytes)
  })

  it('drops to zero after a wipe', async () => {
    await appendCapture({
      stream: 'timelog',
      capturedAt: '2026-08-02T09:00:00-04:00',
      attachments: [{ kind: 'audio', blob: new Blob(['hi']), mimeType: 'audio/mp4' }],
    })
    await wipeAll()
    expect((await measureAppSpace()).totalBytes).toBe(0)
  })
})
