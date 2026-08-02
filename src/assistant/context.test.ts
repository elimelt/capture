import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Entry } from '../contract/types'
import { getDb, resetDbCache } from '../store/db'
import { getSettings } from '../store/settings'
import { ASSISTANT_MODELS, DEFAULT_ASSISTANT_MODEL } from './config'
import {
  DIGEST_MAX_ENTRIES,
  buildInstructions,
  formatDigest,
  recentEntries,
  type DigestItem,
} from './context'

const NOW = new Date('2026-08-02T12:00:00-04:00')

let seq = 0
function entry(capturedAt: string, extra: Partial<Entry> = {}): Entry {
  seq += 1
  return {
    id: `e${seq}`,
    seq,
    stream: 'timelog',
    loggedAt: capturedAt,
    capturedAt,
    deviceTz: 'America/New_York',
    attachments: [],
    lastEventSeq: seq,
    revoked: false,
    ...extra,
  }
}

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

describe('config', () => {
  it('default model is on the curated list and matches the settings default', async () => {
    expect(ASSISTANT_MODELS.some((m) => m.id === DEFAULT_ASSISTANT_MODEL)).toBe(true)
    expect((await getSettings()).assistantModel).toBe(DEFAULT_ASSISTANT_MODEL)
  })
})

describe('recentEntries', () => {
  it('drops entries older than the digest window and revoked entries', () => {
    const old = entry('2026-07-20T10:00:00-04:00')
    const revoked = entry('2026-08-01T10:00:00-04:00', { revoked: true })
    const kept = entry('2026-08-01T11:00:00-04:00')
    expect(recentEntries([old, revoked, kept], NOW)).toEqual([kept])
  })

  it('caps at the newest DIGEST_MAX_ENTRIES', () => {
    const entries = Array.from({ length: DIGEST_MAX_ENTRIES + 5 }, () =>
      entry('2026-08-01T10:00:00-04:00'),
    )
    const recent = recentEntries(entries, NOW)
    expect(recent).toHaveLength(DIGEST_MAX_ENTRIES)
    expect(recent[0]).toBe(entries[5])
  })
})

describe('formatDigest', () => {
  it('handles the empty log', () => {
    expect(formatDigest([])).toBe('(no entries in this period)')
  })

  it('groups by day and renders time, place, texts and media counts', () => {
    const items: DigestItem[] = [
      {
        capturedAt: '2026-08-01T09:30:00-04:00',
        place: 'Office',
        texts: ['standup', 'planning'],
        audioCount: 1,
        photoCount: 0,
      },
      { capturedAt: '2026-08-02T08:05:00-04:00', texts: [], audioCount: 0, photoCount: 2 },
    ]
    expect(formatDigest(items)).toBe(
      [
        '2026-08-01:',
        '- 09:30 @ Office — standup | planning [1 audio]',
        '',
        '2026-08-02:',
        '- 08:05 — [2 photos]',
      ].join('\n'),
    )
  })

  it('marks entries with no text and no media as empty', () => {
    const items: DigestItem[] = [
      { capturedAt: '2026-08-02T10:00:00-04:00', texts: [], audioCount: 0, photoCount: 0 },
    ]
    expect(formatDigest(items)).toContain('- 10:00 — (empty entry)')
  })
})

describe('buildInstructions', () => {
  it('reads text attachment blobs and embeds the digest', async () => {
    const db = await getDb()
    await db.put('blobs', {
      file: 'note.txt',
      blob: new Blob(['walked the dog'], { type: 'text/plain' }),
    })
    const e = entry('2026-08-02T07:45:00-04:00', {
      location: { lat: 40.7, lng: -74, accuracyM: 10, placeLabel: 'Home' },
      attachments: [
        { kind: 'text', file: 'note.txt', mimeType: 'text/plain' },
        { kind: 'audio', file: 'clip.m4a', mimeType: 'audio/mp4', durationSec: 12 },
      ],
    })
    const prompt = await buildInstructions([e], NOW)
    expect(prompt).toContain('- 07:45 @ Home — walked the dog [1 audio]')
    expect(prompt).toContain('Timebox')
  })

  it('skips missing blobs without failing', async () => {
    const e = entry('2026-08-02T07:45:00-04:00', {
      attachments: [{ kind: 'text', file: 'gone.txt', mimeType: 'text/plain' }],
    })
    const prompt = await buildInstructions([e], NOW)
    expect(prompt).toContain('- 07:45 — (empty entry)')
  })
})
