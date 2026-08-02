import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Entry } from '../contract/types'
import { getDb, resetDbCache } from '../store/db'
import type { Place } from '../store/places'
import { LIST_ENTRIES_MAX, SEARCH_ENTRIES_MAX, createAssistantTools } from './tools'

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

function textEntry(capturedAt: string, file: string, extra: Partial<Entry> = {}): Entry {
  return entry(capturedAt, {
    attachments: [{ kind: 'text', file, mimeType: 'text/plain' }],
    ...extra,
  })
}

async function putBlob(file: string, text: string): Promise<void> {
  const db = await getDb()
  await db.put('blobs', { file, blob: new Blob([text], { type: 'text/plain' }) })
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

const OPTS = { toolCallId: 'test', messages: [], context: {} }

function makeTools(entries: Entry[], places: Place[] = []) {
  return createAssistantTools(
    () => entries,
    () => places,
  )
}

describe('list_entries', () => {
  it('keeps only entries whose local date falls in the inclusive range', async () => {
    const entries = [
      entry('2026-07-31T23:59:00-04:00'),
      entry('2026-08-01T00:00:00-04:00'),
      entry('2026-08-02T23:59:00-04:00'),
      entry('2026-08-03T00:00:00-04:00'),
    ]
    const tools = makeTools(entries)
    const text = (await tools.list_entries.execute({ from: '2026-08-01', to: '2026-08-02' }, OPTS)) as string
    expect(text).toContain('2026-08-01:')
    expect(text).toContain('2026-08-02:')
    expect(text).not.toContain('2026-07-31')
    expect(text).not.toContain('2026-08-03')
  })

  it('excludes revoked entries and reads text blobs', async () => {
    await putBlob('note.txt', 'walked the dog')
    const kept = textEntry('2026-08-02T07:45:00-04:00', 'note.txt', {
      location: { lat: 40.7, lng: -74, accuracyM: 10, placeLabel: 'Home' },
    })
    const revoked = entry('2026-08-02T09:00:00-04:00', { revoked: true })
    const tools = makeTools([kept, revoked])
    const text = (await tools.list_entries.execute({ from: '2026-08-02', to: '2026-08-02' }, OPTS)) as string
    expect(text).toContain('- 07:45 @ Home — walked the dog')
    expect(text).not.toContain('09:00')
  })

  it('reports the empty range', async () => {
    const tools = makeTools([entry('2026-08-02T10:00:00-04:00')])
    const text = (await tools.list_entries.execute({ from: '2026-01-01', to: '2026-01-31' }, OPTS)) as string
    expect(text).toBe('(no entries in this period)')
  })

  it('caps the output at the newest LIST_ENTRIES_MAX entries and says so', async () => {
    const entries = Array.from({ length: LIST_ENTRIES_MAX + 5 }, () =>
      entry('2026-08-01T10:00:00-04:00'),
    )
    const tools = makeTools(entries)
    const text = (await tools.list_entries.execute({ from: '2026-08-01', to: '2026-08-01' }, OPTS)) as string
    expect(text).toContain(
      `(truncated: showing the newest ${LIST_ENTRIES_MAX} of ${LIST_ENTRIES_MAX + 5} entries in range)`,
    )
  })
})

describe('get_places', () => {
  it('lists saved places with their radius', async () => {
    const places: Place[] = [
      { id: 'p1', name: 'Home', lat: 40.7, lng: -74, radiusM: 100 },
      { id: 'p2', name: 'Office', lat: 40.8, lng: -74.1, radiusM: 250 },
    ]
    const tools = makeTools([], places)
    const text = (await tools.get_places.execute({}, OPTS)) as string
    expect(text).toBe('- Home (radius 100 m)\n- Office (radius 250 m)')
  })

  it('reports when no places are saved', async () => {
    const tools = makeTools([])
    expect((await tools.get_places.execute({}, OPTS)) as string).toBe('(no saved places)')
  })
})

describe('search_entries', () => {
  it('matches case-insensitively across the whole log and skips revoked entries', async () => {
    await putBlob('a.txt', 'Walked the DOG in the park')
    await putBlob('b.txt', 'groceries')
    const match = textEntry('2025-01-15T08:00:00-05:00', 'a.txt')
    const miss = textEntry('2026-08-02T09:00:00-04:00', 'b.txt')
    const revoked = textEntry('2026-08-02T10:00:00-04:00', 'a.txt', { revoked: true })
    const tools = makeTools([match, miss, revoked])
    const text = (await tools.search_entries.execute({ query: 'dog' }, OPTS)) as string
    expect(text).toContain('2025-01-15:')
    expect(text).toContain('Walked the DOG in the park')
    expect(text).not.toContain('groceries')
    expect(text).not.toContain('10:00')
  })

  it('reports when nothing matches', async () => {
    const tools = makeTools([entry('2026-08-02T10:00:00-04:00')])
    const text = (await tools.search_entries.execute({ query: 'unicorn' }, OPTS)) as string
    expect(text).toBe('(no entries matching "unicorn")')
  })

  it('caps matches at SEARCH_ENTRIES_MAX and says so', async () => {
    await putBlob('note.txt', 'standup meeting')
    const entries = Array.from({ length: SEARCH_ENTRIES_MAX + 3 }, () =>
      textEntry('2026-08-01T10:00:00-04:00', 'note.txt'),
    )
    const tools = makeTools(entries)
    const text = (await tools.search_entries.execute({ query: 'STANDUP' }, OPTS)) as string
    expect(text).toContain(
      `(truncated: showing the first ${SEARCH_ENTRIES_MAX} of ${SEARCH_ENTRIES_MAX + 3} matches)`,
    )
  })
})
